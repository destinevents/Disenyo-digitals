// Browser side of POST /api/inquiry. The page sends only the session id, the message and the source.

export type Stage = 'browsing' | 'qualifying' | 'ready_for_consultation' | 'handoff';
export type Source = 'heyzine' | 'link' | 'qr' | 'website';

export interface ReplyPayload {
  reply: string;
  quickReplies: string[];
  stage: Stage;
  consentNotice?: string;
}

export type SendResult = { ok: true; data: ReplyPayload } | { ok: false; message: string };

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
      consentNotice: typeof body.consentNotice === 'string' ? body.consentNotice : undefined,
    },
  };
}
