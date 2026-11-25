// The server, not the model, decides the stage and when to alert (03_AI_AGENT_RULES.md).
import type { AgentResult, LeadFields, Stage } from './types.js';

function has(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function hasContact(fields: LeadFields): boolean {
  return has(fields.phone) || has(fields.email);
}

/**
 * "Ready for consultation" rule (01_PRD.md): a contact method, a service type,
 * and at least two of budget, timeline and requirements.
 */
export function isReady(fields: LeadFields): boolean {
  if (!hasContact(fields) || !has(fields.service_type)) return false;
  const details = [fields.budget_range, fields.timeline, fields.requirements].filter(has).length;
  return details >= 2;
}

/** Merge new values over old ones. Null or blank never erases a known value (matches submit_inquiry). */
export function mergeFields(previous: LeadFields, next: LeadFields): LeadFields {
  const merged = { ...previous };
  for (const key of Object.keys(next) as (keyof LeadFields)[]) {
    const value = next[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    (merged as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
  }
  return merged;
}

const ORDER: Record<Stage, number> = {
  browsing: 0,
  qualifying: 1,
  ready_for_consultation: 2,
  handoff: 3,
};

export interface StageDecision {
  stage: Stage;
  score: number;
}

/**
 * Decide the new stage and score. Stages never move backwards: once a lead is ready
 * or handed off, it stays that way for the session.
 */
export function decideStage(
  previous: Stage,
  fields: LeadFields,
  result: Pick<AgentResult, 'stage' | 'score' | 'requestedHuman' | 'requestedCall' | 'handoffReason'>,
  deletionRequested = false,
): StageDecision {
  let candidate: Stage = result.stage === 'qualifying' || has(fields.service_type) ? 'qualifying' : 'browsing';

  if (isReady(fields) || result.requestedCall) candidate = 'ready_for_consultation';
  if (result.requestedHuman || has(result.handoffReason) || deletionRequested) candidate = 'handoff';

  const stage = ORDER[candidate] >= ORDER[previous] ? candidate : previous;

  // Scoring guide: 4 means the ready rule is met, 5 is a strong ready lead (model's call).
  const modelScore = clampScore(result.score);
  const score = isReady(fields) ? Math.max(4, modelScore) : Math.min(3, modelScore);

  return { stage, score };
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 1;
  return Math.min(5, Math.max(1, Math.round(score)));
}

/** A lead needs a team alert when it becomes ready or asks for a person. */
export function needsAlert(stage: Stage): boolean {
  return stage === 'ready_for_consultation' || stage === 'handoff';
}

const DELETION_PATTERNS = [
  /\bdelete\s+(all\s+)?(my|our)\s+(data|details|info(rmation)?)\b/i,
  /\bburahin\s+(ang\s+)?(aking|ko|my)\b/i,
  /\b(remove|erase)\s+(my|our)\s+(data|details|info(rmation)?)\b/i,
];

/** "Reply 'delete my data' anytime" (05_SECURITY.md). Matched in code so it never depends on the model. */
export function isDeletionRequest(message: string): boolean {
  return DELETION_PATTERNS.some((pattern) => pattern.test(message));
}
