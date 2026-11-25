// Input validation and origin checks for POST /api/inquiry (05_SECURITY.md, 06_API_SPEC.md).
import { SOURCES, type Source } from './types.js';

export const MAX_MESSAGE_CHARS = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InquiryRequest {
  sessionId: string;
  message: string;
  source: Source;
}

export type ValidationResult = { ok: true; value: InquiryRequest } | { ok: false; error: string };

export function parseInquiryRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid_body' };
  const { sessionId, message, source } = body as Record<string, unknown>;

  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return { ok: false, error: 'invalid_session' };
  if (typeof message !== 'string') return { ok: false, error: 'invalid_message' };

  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'invalid_message' };

  const parsedSource: Source =
    typeof source === 'string' && (SOURCES as readonly string[]).includes(source) ? (source as Source) : 'link';

  return { ok: true, value: { sessionId: sessionId.toLowerCase(), message: trimmed, source: parsedSource } };
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Requests without an Origin header (curl, server-to-server) are refused: browsers always
 * send Origin on a cross-site or same-site POST with a JSON body.
 * With no ALLOWED_ORIGINS configured, only localhost is allowed.
 */
export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  if (allowed.length === 0) return LOCAL_ORIGIN.test(origin);
  return allowed.includes(origin.replace(/\/$/, ''));
}
