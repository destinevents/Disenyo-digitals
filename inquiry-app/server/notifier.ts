// Team alerts (06_API_SPEC.md): email (Resend) and/or Telegram in production, the server log in development.
import type { Alert, Notifier } from './types.js';

type FetchLike = typeof fetch;

/** Limit for one Telegram call. Counted in the function time budget (tests/adapters.test.ts). */
export const ALERT_TIMEOUT_MS = 5000;

function line(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return kept.length ? kept.join(' · ') : null;
}

/** Plain-text alert. No parse_mode is used, so prospect text can't inject formatting or links. */
export function formatAlert(alert: Alert): string {
  const f = alert.fields;

  if (alert.kind === 'deletion_request') {
    return [
      'Data deletion request (RA 10173)',
      line(f.name, f.business_name),
      line(f.phone, f.email),
      'The prospect asked us to delete their data. Remove their row from inquiry_leads and confirm with them.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const heading =
    alert.kind === 'contact_update'
      ? 'Contact details for the earlier alert'
      : alert.stage === 'handoff'
      ? `Prospect wants a person${alert.handoffReason ? ` (${alert.handoffReason})` : ''}`
      : `New lead (score ${alert.score ?? '?'}/5)`;

  const who = line(f.name, f.business_name ? `${f.business_name}${f.location ? ` (${f.location})` : ''}` : f.location);
  const contact = line(f.phone, f.email, f.preferred_channel ? `prefers ${f.preferred_channel}` : null);
  const plan = line(f.budget_range ? `Budget ${f.budget_range}` : null, f.timeline ? `start ${f.timeline}` : null);

  return [
    `${heading}${f.service_type ? ` – ${f.service_type}` : ''}`,
    who,
    contact ?? 'No contact details yet: reply in the chat log or wait for the prospect',
    plan,
    f.requirements ? `Needs: ${f.requirements}` : null,
    alert.summary ? `Summary: ${alert.summary}` : null,
    `Source: ${alert.source}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(alert: Alert): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatAlert(alert).slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Never log the URL: it contains the bot token.
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }
}

const EMAIL_LIKE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** One-line email subject: the alert's first line plus who it is about. */
export function alertSubject(alert: Alert): string {
  const first = formatAlert(alert).split('\n')[0] ?? 'Inquiry alert';
  const who = alert.fields.name ?? alert.fields.business_name;
  const subject = alert.kind === 'deletion_request' || !who ? first : `${first} – ${who}`;
  // Model-extracted text: keep it to one short line.
  return subject.replace(/[\r\n\t]+/g, ' ').slice(0, 180);
}

/**
 * Email alerts through Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Plain text only, so prospect text can't inject HTML or links. When the prospect gave an
 * email address, it becomes the Reply-To, so the team can answer straight from the alert.
 */
export class ResendEmailNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly to: string[],
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(alert: Alert): Promise<void> {
    const replyTo = alert.fields.email?.trim();
    const body: Record<string, unknown> = {
      from: this.from,
      to: this.to,
      subject: alertSubject(alert),
      text: `${formatAlert(alert)}\n\n--\nSent by the "Inquire with AI" assistant on disenyodigitals.com.\nThe full conversation is in inquiry_leads in the HQ Supabase project.`,
    };
    if (replyTo && EMAIL_LIKE.test(replyTo)) body.reply_to = replyTo;

    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend send failed: ${response.status} ${detail.slice(0, 200)}`);
    }
  }
}

/**
 * Sends each alert to every configured channel at once (email, Telegram).
 * Counts as sent if at least one channel worked; throws only if all failed,
 * so the handler retries on the next message.
 */
export class MultiNotifier implements Notifier {
  constructor(
    private readonly channels: Notifier[],
    private readonly log: Pick<Console, 'error'> = console,
  ) {}

  async send(alert: Alert): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((c) => c.send(alert)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const f of failed) this.log.error('[inquiry] alert channel failed', f.reason);
    if (failed.length === results.length) throw new Error('All alert channels failed');
  }
}

/** Splits a comma-separated list of addresses. */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => EMAIL_LIKE.test(s));
}

export class ConsoleNotifier implements Notifier {
  async send(alert: Alert): Promise<void> {
    console.info(`[alert]\n${formatAlert(alert)}`);
  }
}
