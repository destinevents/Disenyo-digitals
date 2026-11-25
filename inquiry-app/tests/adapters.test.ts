import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import {
  AgentUnavailableError,
  AI_ATTEMPT_TIMEOUT_MS,
  AI_DEADLINE_MS,
  AI_MAX_RETRIES,
  buildSystemPrompt,
  loadPromptFiles,
  DEFAULT_MODEL,
  OpenAIAgent,
  toMessageParams,
} from '../server/agent.js';
import {
  ALERT_TIMEOUT_MS,
  alertSubject,
  formatAlert,
  MultiNotifier,
  parseEmailList,
  ResendEmailNotifier,
  TelegramNotifier,
} from '../server/notifier.js';
import { handlerFromEnv } from '../server/fromEnv.js';
import type { Notifier } from '../server/types.js';
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

describe('Email alert (Resend)', () => {
  it('posts a plain-text email with a clear subject and the prospect as Reply-To', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    const notifier = new ResendEmailNotifier('re_test', 'Disenyo <alerts@disenyodigitals.com>', ['info@destinevents.biz'], fetchImpl as unknown as typeof fetch);
    await notifier.send({ ...alert, fields: { ...alert.fields, email: 'maria@bakery.ph' } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: 'Disenyo <alerts@disenyodigitals.com>',
      to: ['info@destinevents.biz'],
      subject: 'New lead (score 4/5) – Inventory Management – Maria Santos',
      reply_to: 'maria@bakery.ph',
    });
    expect(body.text).toContain('0917 123 4567');
    expect(body.html).toBeUndefined();
  });

  it('leaves out Reply-To when the prospect gave no valid email, and throws on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 422 }));
    const notifier = new ResendEmailNotifier('k', 'a@b.co', ['x@y.co'], fetchImpl as unknown as typeof fetch);
    await expect(notifier.send({ ...alert, fields: { ...alert.fields, email: 'not an email' } })).rejects.toThrow(/Resend send failed: 422/);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.reply_to).toBeUndefined();
  });

  it('keeps the subject on one line', () => {
    expect(alertSubject({ ...alert, fields: { ...alert.fields, name: 'Maria\nBcc: x@y.co' } })).not.toMatch(/[\r\n]/);
  });

  it('parses the recipient list', () => {
    expect(parseEmailList(' info@destinevents.biz, jenn@disenyodigitals.com ,nope')).toEqual(['info@destinevents.biz', 'jenn@disenyodigitals.com']);
    expect(parseEmailList(undefined)).toEqual([]);
  });
});

describe('alert channels', () => {
  const ok: Notifier = { send: vi.fn(async () => {}) };
  const bad: Notifier = { send: vi.fn(async () => { throw new Error('down'); }) };

  it('counts as sent when at least one channel works', async () => {
    const log = { error: vi.fn() };
    await expect(new MultiNotifier([bad, ok], log).send(alert)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('throws when every channel fails, so the handler retries', async () => {
    await expect(new MultiNotifier([bad, bad], { error: vi.fn() }).send(alert)).rejects.toThrow(/All alert channels failed/);
  });

  it('builds the handler with email only, Telegram only, or neither', () => {
    const base = { OPENAI_API_KEY: 'x' };
    expect(() => handlerFromEnv({ ...base, RESEND_API_KEY: 're', INQUIRY_ALERT_EMAIL_TO: 'a@b.co' })).not.toThrow();
    expect(() => handlerFromEnv({ ...base, INQUIRY_TELEGRAM_BOT_TOKEN: 't', INQUIRY_TELEGRAM_CHAT_ID: '1' })).not.toThrow();
    expect(() => handlerFromEnv(base)).not.toThrow();
  });
});

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

describe('OpenAI agent', () => {
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

  const parsed = {
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
  };
  const agentWith = (impl: (...args: unknown[]) => Promise<unknown>, model?: string) =>
    new OpenAIAgent({ responses: { parse: vi.fn(impl) } } as unknown as OpenAI, prompt, model);

  it('sends the model, instructions, token limit, no reasoning and no storage', async () => {
    const parse = vi.fn(async () => ({ status: 'completed', output: [], output_parsed: parsed }));
    const agent = new OpenAIAgent({ responses: { parse } } as unknown as OpenAI, prompt);
    const out = await agent.respond({ history: [], message: 'hello' });

    const params = (parse.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(DEFAULT_MODEL).toBe('gpt-6-luna');
    expect(params).toMatchObject({
      model: DEFAULT_MODEL,
      input: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'none' },
      store: false,
    });
    expect(params.instructions).toContain('<knowledge_base>');
    expect((params.text as { format: { type: string } }).format.type).toBe('json_schema');

    expect(out.reply).toBe('Hi!');
    expect(out.quickReplies).toEqual(['Website', 'Talk to a person', 'Fourth']);
    expect(out.handoffReason).toBeNull();
  });

  it('uses the model it is given (INQUIRY_OPENAI_MODEL)', async () => {
    const impl = vi.fn(async () => ({ status: 'completed', output: [], output_parsed: parsed }));
    await agentWith(impl, 'gpt-6.1-terra').respond({ history: [], message: 'x' });
    expect((impl.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe('gpt-6.1-terra');
  });

  it('turns refusals, truncation and API errors into AgentUnavailableError', async () => {
    const refusal = { status: 'completed', output_parsed: null, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] };
    const truncated = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], output_parsed: null };
    await expect(agentWith(async () => refusal).respond({ history: [], message: 'x' })).rejects.toThrow(/refused/);
    await expect(agentWith(async () => truncated).respond({ history: [], message: 'x' })).rejects.toThrow(/max_output_tokens/);
    await expect(
      agentWith(async () => {
        throw new OpenAI.APIConnectionError({ message: 'down' });
      }).respond({ history: [], message: 'x' }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it('answers with the fallback, not a crash, when OPENAI_API_KEY is missing', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(new OpenAIAgent(undefined, prompt).respond({ history: [], message: 'x' })).rejects.toBeInstanceOf(AgentUnavailableError);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('gives up at the deadline when OpenAI never answers, and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const parse = vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => {}); // never settles, like a retry stuck on retry-after
      });
      const pending = new OpenAIAgent({ responses: { parse } } as unknown as OpenAI, prompt).respond({ history: [], message: 'x' });
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

    // Load session + rate limit, OpenAI, save, one alert, save alerted_at (server/handler.ts).
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
