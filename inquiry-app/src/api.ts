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
}

/** Calendly booking page. "Book a call" and "Talk to a person" open it directly. */
export const CALENDLY_URL = 'https://calendly.com/disenyodigitalsdemo';

// Links are only ever shown for these sites (demo videos, booking), whatever the server sends.
const LINK_HOSTS = ['drive.google.com', 'calendly.com'];

/** Keeps only https links to the allowed sites, with a short plain-text label. */
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
    if (parsed.protocol !== 'https:' || !LINK_HOSTS.includes(parsed.hostname)) continue;
    out.push({ label: label.slice(0, 60), url: parsed.href });
  }
  return out.slice(0, 4);
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
    },
  };
}
