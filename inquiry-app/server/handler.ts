// POST /api/inquiry (06_API_SPEC.md). Built from injected parts so it can be tested
// without OpenAI, Supabase or Telegram.
import { createHash } from 'node:crypto';
import { BUSINESS_TYPES, linksForFlags, matchQuickIntent, mergeQuickReplies, quickAnswer, type ChatLink } from './actions.js';
import { AgentUnavailableError } from './agent.js';
import { decideStage, hasContact, isDeletionRequest, mergeFields, needsAlert } from './readiness.js';
import type { Agent, AlertKind, ChatMessage, LeadSession, LeadStore, LeadUpdate, Notifier, Source, Stage } from './types.js';
import { emptyFields } from './types.js';
import { isOriginAllowed, parseInquiryRequest } from './validate.js';

export const SESSION_MESSAGE_LIMIT = 20;
export const IP_HOURLY_LIMIT = 30;

export const CONTACT_EMAIL = 'info@destinevents.biz';

/** Shown once, before contact details are asked for (05_SECURITY.md, RA 10173). */
export const CONSENT_NOTICE =
  'Disenyo Digitals will use your name and contact details only to respond to this inquiry. We keep them for up to 12 months. Reply "delete my data" anytime.';

/** Shown only when the deletion alert really reached the team (email or Telegram). */
export const DELETION_REPLY =
  "Noted. We've emailed the Disenyo team to delete your details from this chat. If you'd like a confirmation, email info@destinevents.biz.";

/** Shown when no alert could be delivered: the chat must not claim it told anyone. */
export const DELETION_REPLY_EMAIL_US =
  'To have your details deleted, please email info@destinevents.biz and the team will take care of it.';

export interface HandlerConfig {
  allowedOrigins: string[];
  ipHashSalt: string;
  /**
   * False when no alert channel is set up (alerts only go to the server log). The chat then
   * never says it notified the team. Defaults to true.
   */
  alertsReachTeam?: boolean;
}

export interface HandlerDeps {
  store: LeadStore;
  agent: Agent;
  notifier: Notifier;
  config: HandlerConfig;
  now?: () => Date;
  log?: Pick<Console, 'error' | 'warn'>;
}

export interface InquiryResponse {
  reply: string;
  quickReplies: string[];
  stage: Stage;
  /** Buttons shown under the reply (demo videos, the Calendly booking page). Open in a new tab. */
  links?: ChatLink[];
  /** A second bubble after the reply (the booking invitation after demo videos). */
  followUp?: { reply: string; links: ChatLink[] };
  /** Present on the one reply that must show the privacy consent line. */
  consentNotice?: string;
  /** A "type of business" dropdown under the reply. The page adds "Others" (type it in). */
  businessPicker?: { prompt: string; options: string[] };
}

export const BUSINESS_PICKER_PROMPT = 'What type of business is this for?';

function json(status: number, body: unknown, origin: string | null): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function newSession(sessionId: string): LeadSession {
  return {
    sessionId,
    stage: 'browsing',
    score: null,
    summary: null,
    fields: emptyFields(),
    messages: [],
    consentAt: null,
    alertedAt: null,
  };
}

export function createInquiryHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const { store, agent, notifier, config } = deps;

  async function save(update: LeadUpdate): Promise<boolean> {
    try {
      await store.saveSession(update);
      return true;
    } catch (error) {
      log.error('[inquiry] failed to save lead', update.sessionId, error);
      return false;
    }
  }

  /** Returns true only if the alert was delivered. */
  async function alertOnce(kind: AlertKind, update: LeadUpdate, handoffReason: string | null): Promise<boolean> {
    try {
      await notifier.send({
        kind,
        stage: update.stage,
        score: update.score,
        summary: update.summary,
        fields: update.fields,
        handoffReason,
        source: update.source,
      });
    } catch (error) {
      // alerted_at stays empty, so the next message from this session retries the alert.
      log.error('[inquiry] alert failed', update.sessionId, error);
      return false;
    }
    if (kind === 'lead') await save({ ...update, alertedAt: now().toISOString() });
    return true;
  }

  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const originOk = isOriginAllowed(origin, config.allowedOrigins);
    const corsOrigin = originOk ? origin : null;

    if (request.method === 'OPTIONS') {
      if (!originOk) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin!,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, corsOrigin);
    if (!originOk) return json(403, { error: 'origin_not_allowed' }, null);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'invalid_body', message: 'Please type a shorter message.' }, corsOrigin);
    }
    const parsed = parseInquiryRequest(body);
    if (!parsed.ok) return json(400, { error: parsed.error, message: 'Please type a shorter message.' }, corsOrigin);
    const { sessionId, message, source } = parsed.value;

    const fallback = { error: 'unavailable', message: `Please message us at ${CONTACT_EMAIL}` };
    const ipHash = hashIp(clientIp(request), config.ipHashSalt);

    let session: LeadSession;
    try {
      session = (await store.getSession(sessionId)) ?? newSession(sessionId);
    } catch (error) {
      log.error('[inquiry] failed to load session', sessionId, error);
      return json(503, fallback, corsOrigin);
    }

    const userMessages = session.messages.filter((m) => m.role === 'user').length;
    if (userMessages >= SESSION_MESSAGE_LIMIT) {
      return json(429, { error: 'session_limit', message: `Please message us at ${CONTACT_EMAIL}` }, corsOrigin);
    }

    let ipAllowed: boolean;
    try {
      ipAllowed = await store.hitIpLimit(ipHash, IP_HOURLY_LIMIT);
    } catch (error) {
      log.error('[inquiry] rate-limit check failed', error);
      return json(503, fallback, corsOrigin);
    }
    if (!ipAllowed) {
      return json(429, { error: 'ip_limit', message: `Please message us at ${CONTACT_EMAIL}` }, corsOrigin);
    }

    const at = now().toISOString();
    const userMessage: ChatMessage = { role: 'user', content: message, at };
    const base = {
      sessionId,
      source: source as Source,
      ipHash,
      consentAt: session.consentAt,
      alertedAt: session.alertedAt,
    };

    // "Delete my data" is handled in code so it never depends on the model.
    if (isDeletionRequest(message)) {
      const update: LeadUpdate = {
        ...base,
        stage: 'handoff',
        score: session.score,
        summary: session.summary,
        fields: session.fields,
        messages: [...session.messages, userMessage],
      };
      // Only say the team was told if the alert really went out.
      const delivered = config.alertsReachTeam !== false && (await alertOnce('deletion_request', update, 'data deletion request'));
      const reply = delivered ? DELETION_REPLY : DELETION_REPLY_EMAIL_US;
      await save({ ...update, messages: [...update.messages, { role: 'assistant', content: reply, at }] });
      return json(200, { reply, quickReplies: [], stage: 'handoff' } satisfies InquiryResponse, corsOrigin);
    }

    // Brochure, demo, booking, "talk to a person" and business-type answers get fixed replies with
    // the right links, straight away and without an AI call. Nothing is sent to the team from the
    // chat: Calendly collects the visitor's details and emails the team for each booking.
    const intent = matchQuickIntent(message);
    if (intent) {
      const answer = quickAnswer(intent, message);
      const fields = answer.industry ? { ...session.fields, industry: answer.industry } : session.fields;
      const { stage, score } = decideStage(session.stage, fields, {
        stage: 'qualifying',
        score: session.score ?? 2,
        requestedHuman: answer.requestedHuman,
        requestedCall: answer.requestedCall,
        handoffReason: null,
      });
      const replies: ChatMessage[] = [{ role: 'assistant', content: answer.reply, at, links: answer.links }];
      if (answer.followUp) replies.push({ role: 'assistant', content: answer.followUp.reply, at, links: answer.followUp.links });
      await save({
        ...base,
        stage,
        score,
        summary: session.summary,
        fields,
        messages: [...session.messages, userMessage, ...replies],
      });
      const response: InquiryResponse = { reply: answer.reply, quickReplies: answer.quickReplies, stage, links: answer.links };
      if (answer.followUp) response.followUp = answer.followUp;
      return json(200, response, corsOrigin);
    }

    let result;
    try {
      result = await agent.respond({ history: session.messages, message });
    } catch (error) {
      const reason = error instanceof AgentUnavailableError ? error.message : error;
      log.error('[inquiry] assistant unavailable', sessionId, reason);
      // The message is still saved (06_API_SPEC.md), so the team can follow up.
      await save({
        ...base,
        stage: session.stage,
        score: session.score,
        summary: session.summary,
        fields: session.fields,
        messages: [...session.messages, userMessage],
      });
      return json(503, fallback, corsOrigin);
    }

    const fields = mergeFields(session.fields, result.fields);
    const { stage, score } = decideStage(session.stage, fields, result);

    const consentAlreadyShown = session.messages.some((m) => m.consentNotice);
    const showConsent = !consentAlreadyShown && (result.askingForContact || hasContact(fields));
    // Consent is recorded when contact details are given after the notice was shown.
    const consentAt = session.consentAt ?? (consentAlreadyShown && hasContact(fields) ? at : null);

    const links = linksForFlags(result);
    const assistantMessage: ChatMessage = { role: 'assistant', content: result.reply, at };
    if (links.length) assistantMessage.links = links;
    if (showConsent) assistantMessage.consentNotice = true;

    const update: LeadUpdate = {
      ...base,
      stage,
      score,
      summary: result.summary || session.summary,
      fields,
      messages: [...session.messages, userMessage, assistantMessage],
      consentAt,
    };

    await save(update);

    // Alert only when the team can act on it: the prospect left a phone or email in the chat.
    // Everyone else is sent to Calendly, which emails the team for each booking.
    if (needsAlert(stage) && !session.alertedAt && hasContact(fields)) {
      await alertOnce('lead', update, result.handoffReason ?? (result.requestedHuman ? 'asked for a person' : null));
    }

    const response: InquiryResponse = { reply: result.reply, quickReplies: mergeQuickReplies(result.quickReplies), stage };
    if (links.length) response.links = links;
    // Once they've asked about a service, the page offers a "type of business" dropdown instead of
    // the AI asking for their industry (the dropdown then shows the matching demo and booking).
    if (fields.service_type && !fields.industry && !result.requestedHuman) response.businessPicker = { prompt: BUSINESS_PICKER_PROMPT, options: [...BUSINESS_TYPES] };
    if (showConsent) response.consentNotice = CONSENT_NOTICE;
    return json(200, response, corsOrigin);
  };
}
