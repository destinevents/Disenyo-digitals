// POST /api/inquiry (06_API_SPEC.md). Built from injected parts so it can be tested
// without OpenAI, Supabase or Telegram.
import { createHash } from 'node:crypto';
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

export const DELETION_REPLY =
  "Noted. We've asked the Disenyo team to delete your details from this inquiry. A team member will confirm once it's done. You can also email info@destinevents.biz.";

export interface HandlerConfig {
  allowedOrigins: string[];
  ipHashSalt: string;
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
  /** Present on the one reply that must show the privacy consent line. */
  consentNotice?: string;
}

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

  async function alertOnce(kind: AlertKind, update: LeadUpdate, handoffReason: string | null): Promise<void> {
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
      return;
    }
    if (kind === 'lead') await save({ ...update, alertedAt: now().toISOString() });
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
      const messages = [...session.messages, userMessage, { role: 'assistant' as const, content: DELETION_REPLY, at }];
      const update: LeadUpdate = {
        ...base,
        stage: 'handoff',
        score: session.score,
        summary: session.summary,
        fields: session.fields,
        messages,
      };
      await save(update);
      await alertOnce('deletion_request', update, 'data deletion request');
      return json(200, { reply: DELETION_REPLY, quickReplies: [], stage: 'handoff' } satisfies InquiryResponse, corsOrigin);
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

    const assistantMessage: ChatMessage = { role: 'assistant', content: result.reply, at };
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

    if (needsAlert(stage) && !session.alertedAt) {
      await alertOnce('lead', update, result.handoffReason ?? (result.requestedHuman ? 'asked for a person' : null));
    } else if (session.alertedAt && !hasContact(session.fields) && hasContact(fields)) {
      // The alert went out before we had a phone or email (e.g. "talk to a person" first).
      // Send the contact details once, as soon as they arrive. Fields are never erased,
      // so this can only happen once per lead.
      await alertOnce('contact_update', update, null);
    }

    const response: InquiryResponse = { reply: result.reply, quickReplies: result.quickReplies, stage };
    if (showConsent) response.consentNotice = CONSENT_NOTICE;
    return json(200, response, corsOrigin);
  };
}
