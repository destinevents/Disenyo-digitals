// Browser side of POST /api/inquiry. The page sends only the session id, the message and the source.

export type Stage = 'browsing' | 'qualifying' | 'ready_for_consultation' | 'handoff';
export type Source = 'heyzine' | 'link' | 'qr' | 'website';

export interface ChatLink {
  label: string;
  url: string;
}

export interface ReplyPayload {
  reply: string;
  quickReplies: string[];
  stage: Stage;
  links: ChatLink[];
  /** A second bubble (the booking invitation after demo videos). */
  followUp?: { reply: string; links: ChatLink[] };
  consentNotice?: string;
  /** A "type of business" dropdown under the reply. */
  businessPicker?: { prompt: string; options: string[] };
}

/** Calendly booking page. "Book a call" opens it directly. */
export const CALENDLY_URL = 'https://calendly.com/disenyodigitalsdemo';

// Links are only ever shown for these sites (brochure, demo videos, booking, WhatsApp, Messenger),
// whatever the server sends. Phone and Viber links are allowed for "Talk to a person".
const LINK_HOSTS = ['drive.google.com', 'calendly.com', 'disenyodigitals.com', 'www.disenyodigitals.com', 'heyzine.com', 'wa.me', 'm.me'];

/** True for links that dial (phone, Viber) rather than open a web page. */
export function isDialLink(url: string): boolean {
  return url.startsWith('tel:') || url.startsWith('viber:');
}

function allowed(parsed: URL): boolean {
  if (parsed.protocol === 'https:') return LINK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol === 'tel:') return /^\+?[0-9]{7,15}$/.test(parsed.pathname);
  if (parsed.protocol === 'viber:') return parsed.hostname === 'chat';
  return false;
}

function parsePicker(raw: unknown): { prompt: string; options: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { prompt, options } = raw as Record<string, unknown>;
  if (typeof prompt !== 'string' || !Array.isArray(options)) return undefined;
  const list = options.filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, 40)).slice(0, 10);
  return list.length ? { prompt: prompt.slice(0, 80), options: list } : undefined;
}

/** Keeps only links to the allowed sites (and phone/Viber links), with a short plain-text label. */
export function safeLinks(raw: unknown): ChatLink[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== 'string' || typeof url !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!allowed(parsed)) continue;
    out.push({ label: label.slice(0, 60), url: parsed.href });
  }
  return out.slice(0, 6);
}

export type SendResult = { ok: true; data: ReplyPayload } | { ok: false; message: string };

function parseFollowUp(raw: unknown): { reply: string; links: ChatLink[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { reply, links } = raw as Record<string, unknown>;
  return typeof reply === 'string' && reply ? { reply, links: safeLinks(links) } : undefined;
}

export const FALLBACK = 'Sorry, the assistant is unavailable right now. Please message us at info@destinevents.biz';

export function errorMessage(status: number, serverMessage: unknown): string {
  if (status === 400) return 'Please type a shorter message.';
  if (status === 429) return 'You have reached the chat limit. Please message us at info@destinevents.biz';
  return typeof serverMessage === 'string' && serverMessage ? `Sorry, something went wrong. ${serverMessage}` : FALLBACK;
}

export async function sendMessage(
  sessionId: string,
  message: string,
  source: Source,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, source }),
    });
  } catch {
    return { ok: false, message: FALLBACK };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error page (e.g. a platform timeout). Fall through to the fallback.
  }

  if (!response.ok || typeof body.reply !== 'string') {
    return { ok: false, message: errorMessage(response.status, body.message) };
  }

  return {
    ok: true,
    data: {
      reply: body.reply,
      quickReplies: Array.isArray(body.quickReplies) ? body.quickReplies.filter((q): q is string => typeof q === 'string') : [],
      stage: (body.stage as Stage) ?? 'browsing',
      links: safeLinks(body.links),
      followUp: parseFollowUp(body.followUp),
      consentNotice: typeof body.consentNotice === 'string' ? body.consentNotice : undefined,
      businessPicker: parsePicker(body.businessPicker),
    },
  };
}
