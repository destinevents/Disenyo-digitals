// Team alerts (06_API_SPEC.md). Telegram in production, the server log in development.
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

export class ConsoleNotifier implements Notifier {
  async send(alert: Alert): Promise<void> {
    console.info(`[alert]\n${formatAlert(alert)}`);
  }
}
