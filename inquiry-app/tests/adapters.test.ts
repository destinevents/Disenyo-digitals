import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import {
  AgentUnavailableError,
  AI_ATTEMPT_TIMEOUT_MS,
  AI_DEADLINE_MS,
  AI_MAX_RETRIES,
  buildSystemPrompt,
  ClaudeAgent,
  loadPromptFiles,
  MODEL,
  toMessageParams,
} from '../server/agent.js';
import { ALERT_TIMEOUT_MS, formatAlert, TelegramNotifier } from '../server/notifier.js';
import { STORE_TIMEOUT_MS, SupabaseStore } from '../server/stores/supabaseStore.js';
import { emptyFields, type Alert } from '../server/types.js';
import { isOriginAllowed, parseAllowedOrigins } from '../server/validate.js';
import { errorMessage } from '../src/api.js';

const alert: Alert = {
  kind: 'lead',
  stage: 'ready_for_consultation',
  score: 4,
  summary: '2 branches, stock-outs on flour.',
  source: 'heyzine',
  handoffReason: null,
  fields: {
    ...emptyFields(),
    name: 'Maria Santos',
    business_name: 'Santos Bakery',
    location: 'Baguio',
    phone: '0917 123 4567',
    preferred_channel: 'Viber, afternoons',
    service_type: 'Inventory Management',
    budget_range: '₱30–50k',
    timeline: 'January',
  },
};

describe('Telegram alert', () => {
  it('matches the format in 06_API_SPEC.md', () => {
    expect(formatAlert(alert)).toBe(
      [
        'New lead (score 4/5) – Inventory Management',
        'Maria Santos · Santos Bakery (Baguio)',
        '0917 123 4567 · prefers Viber, afternoons',
        'Budget ₱30–50k · start January',
        'Summary: 2 branches, stock-outs on flour.',
        'Source: heyzine',
      ].join('\n'),
    );
  });

  it('labels a contact follow-up so the team can match it to the earlier alert', () => {
    const text = formatAlert({ ...alert, kind: 'contact_update', stage: 'handoff' });
    expect(text.split('\n')[0]).toBe('Contact details for the earlier alert – Inventory Management');
    expect(text).toContain('0917 123 4567');
  });

  it('posts plain text to the configured chat and throws on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await new TelegramNotifier('TOKEN', '-100123', fetchImpl as unknown as typeof fetch).send(alert);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('-100123');
    expect(body.parse_mode).toBeUndefined();

    const failing = vi.fn(async () => new Response('no', { status: 401 }));
    const err = await new TelegramNotifier('TOKEN', '1', failing as unknown as typeof fetch).send(alert).catch((e) => e);
    expect(String(err)).not.toContain('TOKEN');
  });
});

describe('Supabase store', () => {
  it('calls submit_inquiry with non-null fields only', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const store = new SupabaseStore('https://abc.supabase.co/', 'anon', fetchImpl as unknown as typeof fetch);
    await store.saveSession({
      sessionId: 's',
      source: 'qr',
      stage: 'qualifying',
      score: 3,
      summary: null,
      fields: { ...emptyFields(), name: 'Maria' },
      messages: [],
      consentAt: null,
      alertedAt: null,
      ipHash: 'h',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abc.supabase.co/rest/v1/rpc/submit_inquiry');
    expect(JSON.parse(init.body as string)).toEqual({
      p_session: 's',
      p_fields: { stage: 'qualifying', score: 3, source: 'qr', ip_hash: 'h', name: 'Maria' },
      p_messages: [],
    });
  });

  it('maps get_inquiry_session to a LeadSession, and null to null', async () => {
    const row = { stage: 'handoff', score: 4, name: 'Maria', decision_maker: true, messages: [{ role: 'user', content: 'hi', at: 'x' }], alerted_at: '2026-01-01T00:00:00Z' };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 200 }));
    const store = new SupabaseStore('https://abc.supabase.co', 'anon', fetchImpl as unknown as typeof fetch);
    const session = await store.getSession('s');
    expect(session).toMatchObject({ stage: 'handoff', score: 4, alertedAt: '2026-01-01T00:00:00Z', consentAt: null });
    expect(session!.fields).toMatchObject({ name: 'Maria', decision_maker: true, phone: null });
    expect(await store.getSession('s2')).toBeNull();
  });

  it('throws on an HTTP error so the handler can fall back', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const store = new SupabaseStore('https://abc.supabase.co', 'anon', fetchImpl as unknown as typeof fetch);
    await expect(store.hitIpLimit('h', 30)).rejects.toThrow(/check_inquiry_rate_limit failed: 500/);
  });
});

describe('Claude agent', () => {
  const prompt = { rules: 'RULES', knowledge: 'KB' };

  it('builds the system prompt from the rules and the knowledge base', () => {
    const system = buildSystemPrompt('RULES', 'KB');
    expect(system.startsWith('RULES')).toBe(true);
    expect(system).toContain('<knowledge_base>\n\nKB\n\n</knowledge_base>');
  });

  it('loads the real prompt files from the repo', () => {
    const { rules, knowledge } = loadPromptFiles();
    expect(rules).toContain('Disenyo');
    expect(knowledge).toContain('from ₱10,000');
  });

  it('joins consecutive turns from the same role', () => {
    const params = toMessageParams([
      { role: 'user', content: 'a', at: '' },
      { role: 'user', content: 'b', at: '' },
      { role: 'assistant', content: 'c', at: '' },
    ]);
    expect(params).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });

  it('sends the fixed model, token limit and cached system prompt', async () => {
    const parse = vi.fn(async () => ({
      stop_reason: 'end_turn',
      parsed_output: {
        reply: ' Hi! ',
        quick_replies: ['Website', '', 'x'.repeat(60), 'Talk to a person', 'Fourth'],
        asking_for_contact: false,
        requested_human: false,
        requested_call: false,
        handoff_reason: '',
        stage: 'browsing',
        score: 1,
        summary: 'Browsing.',
        fields: emptyFields(),
      },
    }));
    const client = { messages: { parse } } as unknown as Anthropic;
    const out = await new ClaudeAgent(client, prompt).respond({ history: [], message: 'hello' });

    const params = (parse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.model).toBe(MODEL);
    expect(MODEL).toBe('claude-haiku-5-5');
    expect(params.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect((params.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });

    expect(out.reply).toBe('Hi!');
    expect(out.quickReplies).toEqual(['Website', 'Talk to a person', 'Fourth']);
    expect(out.handoffReason).toBeNull();
  });

  it('turns refusals, truncation and API errors into AgentUnavailableError', async () => {
    const make = (impl: () => Promise<unknown>) =>
      new ClaudeAgent({ messages: { parse: vi.fn(impl) } } as unknown as Anthropic, prompt);

    await expect(make(async () => ({ stop_reason: 'refusal', stop_details: null, parsed_output: null })).respond({ history: [], message: 'x' })).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(make(async () => ({ stop_reason: 'max_tokens', parsed_output: null })).respond({ history: [], message: 'x' })).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(
      make(async () => {
        throw new Anthropic.APIConnectionError({ message: 'down' });
      }).respond({ history: [], message: 'x' }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it('gives up at the deadline when Claude never answers, and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const parse = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => {}); // never settles, like a retry stuck on retry-after
      });
      const pending = new ClaudeAgent({ messages: { parse } } as unknown as Anthropic, prompt).respond({ history: [], message: 'x' });
      const outcome = expect(pending).rejects.toThrow(/did not answer within/);

      await vi.advanceTimersByTimeAsync(AI_DEADLINE_MS);
      await outcome;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('function time budget', () => {
  it('a worst-case request finishes inside the website vercel.json maxDuration', () => {
    const vercel = JSON.parse(readFileSync('../vercel.json', 'utf8')) as {
      functions: Record<string, { maxDuration: number }>;
    };
    const limitMs = vercel.functions['api/inquiry.ts']!.maxDuration * 1000;

    // Load session + rate limit, Claude, save, one alert, save alerted_at (server/handler.ts).
    const worstCaseMs = STORE_TIMEOUT_MS * 2 + AI_DEADLINE_MS + STORE_TIMEOUT_MS + ALERT_TIMEOUT_MS + STORE_TIMEOUT_MS;
    expect(worstCaseMs + 5_000).toBeLessThanOrEqual(limitMs); // 5 s for cold start and JSON work

    // The deadline leaves room for one full retry.
    expect(AI_ATTEMPT_TIMEOUT_MS * (AI_MAX_RETRIES + 1)).toBeLessThanOrEqual(AI_DEADLINE_MS);
  });
});

describe('origins', () => {
  it('parses ALLOWED_ORIGINS and matches exactly', () => {
    const allowed = parseAllowedOrigins(' https://inquire.disenyodigitals.com/ , https://heyzine.com ');
    expect(allowed).toEqual(['https://inquire.disenyodigitals.com', 'https://heyzine.com']);
    expect(isOriginAllowed('https://heyzine.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://heyzine.com.evil.example', allowed)).toBe(false);
  });

  it('allows only localhost when nothing is configured', () => {
    expect(isOriginAllowed('http://localhost:5173', [])).toBe(true);
    expect(isOriginAllowed('https://anything.example', [])).toBe(false);
  });
});

describe('chat page error messages', () => {
  it('maps status codes to the messages in 06_API_SPEC.md', () => {
    expect(errorMessage(400, 'x')).toBe('Please type a shorter message.');
    expect(errorMessage(429, 'x')).toContain('info@destinevents.biz');
    expect(errorMessage(503, undefined)).toContain('info@destinevents.biz');
  });
});
