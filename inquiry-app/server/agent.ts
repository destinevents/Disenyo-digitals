// One OpenAI call per prospect message. The reply and the extracted lead fields come back
// together as structured output, so they can't disagree with each other.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Agent, AgentInput, AgentResult, ChatMessage } from './types.js';

/**
 * OpenAI's model for cost-sensitive, high-volume work (US$0.10 / $0.50 per 1M input / output tokens,
 * checked Nov 2026). INQUIRY_OPENAI_MODEL overrides it without a code change.
 */
export const DEFAULT_MODEL = 'gpt-6-luna';

// 05_SECURITY.md suggests 400. The structured output (reply + fields + summary) needs more room,
// and 800 output tokens still costs well under ₱0.05.
export const MAX_TOKENS = 800;

// Time budget for one AI answer. Each attempt may take AI_ATTEMPT_TIMEOUT_MS, with one retry,
// but the whole call (retry waits included) is cut off at AI_DEADLINE_MS. The rest of the
// function's maxDuration (vercel.json) is left for the Supabase calls and the Telegram alert,
// so a slow answer still ends in a saved message and a 503, not a killed function.
export const AI_ATTEMPT_TIMEOUT_MS = 12_000;
export const AI_MAX_RETRIES = 1;
export const AI_DEADLINE_MS = 25_000;

const text = z.string().nullable();

export const AgentOutputSchema = z.object({
  reply: z.string(),
  quick_replies: z.array(z.string()),
  asking_for_contact: z.boolean(),
  requested_human: z.boolean(),
  requested_call: z.boolean(),
  handoff_reason: text,
  stage: z.enum(['browsing', 'qualifying']),
  score: z.number().int(),
  summary: z.string(),
  fields: z.object({
    name: text,
    business_name: text,
    industry: text,
    email: text,
    phone: text,
    preferred_channel: text,
    location: text,
    service_type: text,
    requirements: text,
    budget_range: text,
    timeline: text,
    decision_maker: z.boolean().nullable(),
  }),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export function toAgentResult(output: AgentOutput): AgentResult {
  return {
    reply: output.reply.trim(),
    quickReplies: output.quick_replies
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && q.length <= 40)
      .slice(0, 3),
    fields: output.fields,
    score: output.score,
    summary: output.summary.trim(),
    stage: output.stage,
    requestedHuman: output.requested_human,
    requestedCall: output.requested_call,
    handoffReason: output.handoff_reason?.trim() || null,
    askingForContact: output.asking_for_contact,
  };
}

/** Thrown when the AI can't produce a usable reply. The handler answers 503 and keeps the message. */
export class AgentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentUnavailableError';
  }
}

export function loadPromptFiles(cwd = process.cwd()): { rules: string; knowledge: string } {
  // On Vercel the function runs from the repo root; in dev and tests, from inquiry-app/.
  const root = existsSync(path.join(cwd, 'inquiry-app', 'prompts')) ? path.join(cwd, 'inquiry-app') : cwd;
  return {
    rules: readFileSync(path.join(root, 'prompts', 'system.md'), 'utf8'),
    knowledge: readFileSync(path.join(root, 'knowledge', 'disenyo.md'), 'utf8'),
  };
}

export function buildSystemPrompt(rules: string, knowledge: string): string {
  return [
    rules.trim(),
    '## Knowledge base',
    'Anything marked [TEAM TO FILL] or [TEAM TO CONFIRM] is not confirmed yet: treat it as unknown and offer a consultation instead.',
    '<knowledge_base>',
    knowledge.trim(),
    '</knowledge_base>',
  ].join('\n\n');
}

/**
 * Convert stored chat history to API messages. Consecutive turns from the same role are joined
 * (this happens when an earlier message got no reply because the assistant was unavailable).
 */
export function toMessageParams(history: ChatMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  // The conversation must start with the prospect.
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

/** True when the model declined to answer (a refusal item instead of output text). */
function hasRefusal(response: { output?: unknown[] }): boolean {
  return (response.output ?? []).some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      Array.isArray((item as { content?: unknown }).content) &&
      ((item as { content: { type?: string }[] }).content).some((c) => c?.type === 'refusal'),
  );
}

export class OpenAIAgent implements Agent {
  private readonly systemPrompt: string;
  private client: OpenAI | undefined;

  constructor(
    // Created on first use: the SDK throws when OPENAI_API_KEY is missing, and that should
    // become the normal 503 fallback for one message, not a crashed function.
    client?: OpenAI,
    prompt: { rules: string; knowledge: string } = loadPromptFiles(),
    private readonly model: string = DEFAULT_MODEL,
  ) {
    this.client = client;
    this.systemPrompt = buildSystemPrompt(prompt.rules, prompt.knowledge);
  }

  private getClient(): OpenAI {
    this.client ??= new OpenAI({ timeout: AI_ATTEMPT_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES });
    return this.client;
  }

  async respond({ history, message }: AgentInput): Promise<AgentResult> {
    const input = toMessageParams([...history, { role: 'user', content: message, at: '' }]);

    // A hard deadline over the SDK's own timeout and retries: a retry can wait on a
    // retry-after header, which the per-attempt timeout doesn't cover.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AgentUnavailableError(`OpenAI did not answer within ${AI_DEADLINE_MS} ms`));
        controller.abort();
      }, AI_DEADLINE_MS);
    });

    let response;
    try {
      const call = this.getClient().responses.parse(
        {
          model: this.model,
          // Rules + knowledge base: identical on every request, so OpenAI caches them automatically.
          instructions: this.systemPrompt,
          input,
          text: { format: zodTextFormat(AgentOutputSchema, 'inquiry_reply') },
          // Short, rule-following chat replies: reasoning adds latency and cost without helping.
          reasoning: { effort: 'none' },
          max_output_tokens: MAX_TOKENS,
          // Prospects' messages stay in our own database only, not stored at OpenAI for 30 days.
          store: false,
          prompt_cache_key: 'disenyo-inquiry',
        },
        { signal: controller.signal },
      );
      response = await Promise.race([call, deadline]);
    } catch (error) {
      if (error instanceof AgentUnavailableError) throw error;
      if (error instanceof OpenAI.APIError) {
        throw new AgentUnavailableError(`OpenAI API error ${error.status ?? 'connection'}`, { cause: error });
      }
      // Missing credentials, a schema mismatch in the output, or another client-side failure.
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentUnavailableError(`OpenAI call failed: ${detail.slice(0, 200)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (hasRefusal(response)) throw new AgentUnavailableError('OpenAI refused to answer');
    if (response.status !== 'completed' || !response.output_parsed) {
      const reason = response.incomplete_details?.reason ?? response.status;
      throw new AgentUnavailableError(`No structured output (${reason})`);
    }

    return toAgentResult(response.output_parsed);
  }
}
