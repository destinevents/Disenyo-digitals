// LeadStore backed by the HQ Supabase project, through the three functions in
// database/021_inquiry_leads.sql. Uses the public anon key: it can call these functions
// and nothing else (no table access).
import { emptyFields, LEAD_FIELD_KEYS, type ChatMessage, type LeadFields, type LeadSession, type LeadStore, type LeadUpdate, type Stage } from '../types.js';

type FetchLike = typeof fetch;

/** Per-call limit for Supabase RPCs. Counted in the function time budget (tests/adapters.test.ts). */
export const STORE_TIMEOUT_MS = 5000;

export class SupabaseStore implements LeadStore {
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly anonKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supabase ${fn} failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async getSession(sessionId: string): Promise<LeadSession | null> {
    const row = (await this.rpc('get_inquiry_session', { p_session: sessionId })) as Record<string, unknown> | null;
    if (!row) return null;

    const fields = emptyFields();
    for (const key of LEAD_FIELD_KEYS) {
      const value = row[key];
      if (key === 'decision_maker') {
        fields.decision_maker = typeof value === 'boolean' ? value : null;
      } else {
        (fields as unknown as Record<string, string | null>)[key] = typeof value === 'string' ? value : null;
      }
    }

    return {
      sessionId,
      stage: (row.stage as Stage) ?? 'browsing',
      score: typeof row.score === 'number' ? row.score : null,
      summary: typeof row.summary === 'string' ? row.summary : null,
      fields,
      messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
      consentAt: typeof row.consent_at === 'string' ? row.consent_at : null,
      alertedAt: typeof row.alerted_at === 'string' ? row.alerted_at : null,
    };
  }

  async saveSession(update: LeadUpdate): Promise<void> {
    const fields: Record<string, unknown> = {
      stage: update.stage,
      score: update.score,
      summary: update.summary,
      source: update.source,
      consent_at: update.consentAt,
      alerted_at: update.alertedAt,
      ip_hash: update.ipHash,
    };
    for (const key of LEAD_FIELD_KEYS) fields[key] = update.fields[key as keyof LeadFields];

    // Drop nulls so the JSON stays small; submit_inquiry treats a missing key as "keep".
    for (const key of Object.keys(fields)) if (fields[key] === null || fields[key] === undefined) delete fields[key];

    await this.rpc('submit_inquiry', {
      p_session: update.sessionId,
      p_fields: fields,
      p_messages: update.messages,
    });
  }

  async hitIpLimit(ipHash: string, limitPerHour: number): Promise<boolean> {
    const allowed = await this.rpc('check_inquiry_rate_limit', { p_ip_hash: ipHash, p_limit: limitPerHour });
    return allowed === true;
  }
}
