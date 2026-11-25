// In-memory LeadStore for local development and tests.
// Mirrors submit_inquiry's rules: null never overwrites, consent_at and alerted_at are set once.
// On Vercel each instance has its own memory, so this store is NOT for production.
import { mergeFields } from '../readiness.js';
import type { LeadSession, LeadStore, LeadUpdate, Source } from '../types.js';

interface StoredLead extends LeadSession {
  source: Source;
  ipHash: string | null;
  updatedAt: string;
}

export class MemoryStore implements LeadStore {
  readonly leads = new Map<string, StoredLead>();
  private readonly ipHits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  async getSession(sessionId: string): Promise<LeadSession | null> {
    const lead = this.leads.get(sessionId);
    if (!lead) return null;
    const { source: _source, ipHash: _ipHash, updatedAt: _updatedAt, ...session } = lead;
    return structuredClone(session);
  }

  async saveSession(update: LeadUpdate): Promise<void> {
    const existing = this.leads.get(update.sessionId);
    const timestamp = new Date(this.now()).toISOString();

    if (!existing) {
      this.leads.set(update.sessionId, {
        sessionId: update.sessionId,
        source: update.source,
        stage: update.stage,
        score: update.score,
        summary: update.summary,
        fields: structuredClone(update.fields),
        messages: structuredClone(update.messages),
        consentAt: update.consentAt,
        alertedAt: update.alertedAt,
        ipHash: update.ipHash,
        updatedAt: timestamp,
      });
      return;
    }

    existing.stage = update.stage;
    existing.score = update.score ?? existing.score;
    existing.summary = update.summary ?? existing.summary;
    existing.fields = mergeFields(existing.fields, update.fields);
    existing.messages = structuredClone(update.messages);
    existing.consentAt = existing.consentAt ?? update.consentAt;
    existing.alertedAt = existing.alertedAt ?? update.alertedAt;
    existing.ipHash = update.ipHash ?? existing.ipHash;
    existing.updatedAt = timestamp;
  }

  async hitIpLimit(ipHash: string, limitPerHour: number): Promise<boolean> {
    const cutoff = this.now() - 60 * 60 * 1000;
    const hits = (this.ipHits.get(ipHash) ?? []).filter((t) => t > cutoff);
    if (hits.length >= limitPerHour) {
      this.ipHits.set(ipHash, hits);
      return false;
    }
    hits.push(this.now());
    this.ipHits.set(ipHash, hits);
    return true;
  }
}
