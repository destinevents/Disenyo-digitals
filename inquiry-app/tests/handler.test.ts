import { describe, expect, it, vi } from 'vitest';
import { AgentUnavailableError } from '../server/agent.js';
import {
  CONSENT_NOTICE,
  createInquiryHandler,
  DELETION_REPLY,
  DELETION_REPLY_EMAIL_US,
  IP_HOURLY_LIMIT,
  SESSION_MESSAGE_LIMIT,
} from '../server/handler.js';
import { MemoryStore } from '../server/stores/memoryStore.js';
import { emptyFields, type Agent, type AgentResult, type Alert, type LeadFields, type Notifier } from '../server/types.js';

const ORIGIN = 'https://inquire.disenyodigitals.com';
const SESSION = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

function result(overrides: Partial<AgentResult> = {}, fields: Partial<LeadFields> = {}): AgentResult {
  return {
    reply: 'Our websites start at ₱10,000.',
    quickReplies: ['Talk to a person'],
    fields: { ...emptyFields(), ...fields },
    score: 2,
    summary: 'Interested in a website.',
    stage: 'qualifying',
    requestedHuman: false,
    requestedCall: false,
    wantsDemo: false,
    handoffReason: null,
    askingForContact: false,
    ...overrides,
  };
}

function setup(replies: (AgentResult | Error)[] = [result()]) {
  const store = new MemoryStore();
  const alerts: Alert[] = [];
  const notifier: Notifier = { send: vi.fn(async (a: Alert) => void alerts.push(a)) };
  const queue = [...replies];
  const agent: Agent = {
    respond: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const log = { error: vi.fn(), warn: vi.fn() };
  const handle = createInquiryHandler({
    store,
    agent,
    notifier,
    log,
    config: { allowedOrigins: [ORIGIN], ipHashSalt: 'test' },
  });
  return { store, alerts, notifier, agent, handle, log };
}

function post(body: unknown, { origin = ORIGIN, ip = '203.0.113.5' }: { origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-forwarded-for': ip };
  if (origin) headers.origin = origin;
  return new Request('https://inquire.disenyodigitals.com/api/inquiry', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const msg = (message: string, sessionId = SESSION) => ({ sessionId, message, source: 'heyzine' });

describe('POST /api/inquiry: validation', () => {
  it('returns the reply, quick replies and stage', async () => {
    const { handle } = setup();
    const res = await handle(post(msg('Magkano ang website?')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: 'Our websites start at ₱10,000.',
      quickReplies: ['Watch demo', 'Book a call', 'Talk to a person', 'Browse demos (Clinic / Staycation)'],
      stage: 'qualifying',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it.each([
    ['empty message', msg('   ')],
    ['message over 2,000 characters', msg('a'.repeat(2001))],
    ['bad session id', msg('hi', 'not-a-uuid')],
    ['missing message', { sessionId: SESSION }],
  ])('400 on %s', async (_label, body) => {
    const { handle, agent } = setup();
    const res = await handle(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Please type a shorter message.');
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it('400 on invalid JSON', async () => {
    const { handle } = setup();
    expect((await handle(post('{nope'))).status).toBe(400);
  });

  it('accepts exactly 2,000 characters', async () => {
    const { handle } = setup();
    expect((await handle(post(msg('a'.repeat(2000))))).status).toBe(200);
  });

  it('403 for an origin not on the allow list, and for no origin', async () => {
    const { handle, agent } = setup();
    expect((await handle(post(msg('hi'), { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handle(post(msg('hi'), { origin: null }))).status).toBe(403);
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const { handle } = setup();
    const ok = await handle(new Request('https://x/api/inquiry', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(ok.status).toBe(204);
    const bad = await handle(new Request('https://x/api/inquiry', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(bad.status).toBe(403);
  });

  it('defaults an unknown source to "link"', async () => {
    const { handle, store } = setup();
    await handle(post({ sessionId: SESSION, message: 'hi', source: 'spam' }));
    expect(store.leads.get(SESSION)?.source).toBe('link');
  });
});

describe('POST /api/inquiry: rate limits', () => {
  it(`429 after ${SESSION_MESSAGE_LIMIT} messages in one session`, async () => {
    const { handle } = setup();
    for (let i = 0; i < SESSION_MESSAGE_LIMIT; i++) {
      expect((await handle(post(msg(`q${i}`), { ip: `198.51.100.${i}` }))).status).toBe(200);
    }
    const res = await handle(post(msg('one more'), { ip: '198.51.100.250' }));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain('info@destinevents.biz');
  });

  it(`429 after ${IP_HOURLY_LIMIT} messages per IP per hour`, async () => {
    const { handle } = setup();
    for (let i = 0; i < IP_HOURLY_LIMIT; i++) {
      const session = crypto.randomUUID();
      expect((await handle(post(msg('hi', session)))).status).toBe(200);
    }
    expect((await handle(post(msg('hi', crypto.randomUUID())))).status).toBe(429);
    // A different IP is unaffected.
    expect((await handle(post(msg('hi', crypto.randomUUID()), { ip: '192.0.2.9' }))).status).toBe(200);
  });
});

describe('POST /api/inquiry: saving and alerts', () => {
  const readyFields = { name: 'Maria Santos', phone: '0917 123 4567', service_type: 'Inventory Management', budget_range: '₱30–50k', timeline: 'January' };

  it('saves a browsing lead with no contact details and sends no alert', async () => {
    const { handle, store, alerts } = setup([result({ stage: 'browsing', score: 1 })]);
    await handle(post(msg('Just browsing')));
    const lead = store.leads.get(SESSION)!;
    expect(lead.stage).toBe('browsing');
    expect(lead.messages).toHaveLength(2);
    expect(alerts).toHaveLength(0);
  });

  it('alerts once when a lead becomes ready, never twice', async () => {
    const { handle, store, alerts } = setup([result({ score: 4 }, readyFields)]);
    const first = await handle(post(msg('0917 123 4567 po')));
    expect((await first.json()).stage).toBe('ready_for_consultation');
    await handle(post(msg('Salamat!')));
    await handle(post(msg('Talk to a person')));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'lead', score: 4, stage: 'ready_for_consultation' });
    expect(store.leads.get(SESSION)!.alertedAt).not.toBeNull();
  });

  it('retries the alert on the next message if Telegram failed', async () => {
    const { handle, notifier, store, log } = setup([result({ score: 4 }, readyFields)]);
    vi.mocked(notifier.send).mockRejectedValueOnce(new Error('telegram down'));
    await handle(post(msg('ready')));
    expect(store.leads.get(SESSION)!.alertedAt).toBeNull();
    expect(log.error).toHaveBeenCalled();
    await handle(post(msg('still there?')));
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect(store.leads.get(SESSION)!.alertedAt).not.toBeNull();
  });

  it('answers "talk to a person" with the Calendly link, without the AI and without an alert', async () => {
    const { handle, agent, alerts, store } = setup();
    const body = await (await handle(post(msg('Can I talk to a person?')))).json();
    expect(body.reply).toMatch(/Our team can call you/);
    expect(body.links).toEqual([{ label: 'Book a free 30-minute call', url: 'https://calendly.com/disenyodigitalsdemo' }]);
    expect(body.stage).toBe('handoff');
    expect(body.reply).not.toMatch(/business name|contact|sent to/i);
    expect(agent.respond).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
    // The exchange is still saved, links included, so the team can see it.
    expect(store.leads.get(SESSION)!.messages[1]!.links?.[0]!.url).toBe('https://calendly.com/disenyodigitalsdemo');
  });

  it('answers a demo request with the All Services demo, then booking', async () => {
    const { handle, agent } = setup();
    const body = await (await handle(post(msg('Discuss a demo')))).json();
    expect(body.links.map((l: { label: string }) => l.label)).toEqual(['All Services demo']);
    expect(body.followUp.reply).toContain('Book a free 30-minute call with our team:');
    expect(body.followUp.links[0].url).toBe('https://calendly.com/disenyodigitalsdemo');
    expect(body.quickReplies).toContain('Browse demos (Clinic / Staycation)');
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it('answers "Browse demos" with the clinic and staycation demos', async () => {
    const { handle } = setup();
    const body = await (await handle(post(msg('Browse demos (Clinic / Staycation)')))).json();
    expect(body.links.map((l: { label: string }) => l.label)).toEqual(['Clinic system demo', 'Staycation / Cleaning system demo']);
    expect(body.followUp.links[0].label).toBe('Book a free 30-minute call');
  });

  it('adds the Calendly link when the AI sees a request for a person, and alerts only once contact is given', async () => {
    const { handle, alerts } = setup([
      result({ requestedHuman: true }),
      result({}, { name: 'Maria', phone: '0917 123 4567', service_type: 'Inventory Management' }),
    ]);
    const first = await (await handle(post(msg('Pwede po ba may tumawag sa akin?')))).json();
    expect(first.links).toEqual([{ label: 'Book a free 30-minute call', url: 'https://calendly.com/disenyodigitalsdemo' }]);
    expect(alerts).toHaveLength(0); // no phone or email yet: nothing the team could act on

    await handle(post(msg('Maria, 0917 123 4567')));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'lead', stage: 'handoff' });
    expect(alerts[0]!.fields.phone).toBe('0917 123 4567');
  });

  it('never offers buttons that ask for contact details', async () => {
    const { handle } = setup([result({ quickReplies: ['Share business name', 'Give my number'] })]);
    const body = await (await handle(post(msg('I need an inventory system')))).json();
    expect(body.quickReplies).toEqual(['Watch demo', 'Book a call', 'Talk to a person', 'Browse demos (Clinic / Staycation)']);
  });

  it('sends no contact follow-up when the first alert already had contact details', async () => {
    const { handle, alerts } = setup([result({ score: 4 }, readyFields), result({}, { email: 'maria@bakery.ph' })]);
    await handle(post(msg('0917 123 4567 po')));
    await handle(post(msg('email din: maria@bakery.ph')));
    expect(alerts).toHaveLength(1);
  });

  it('keeps fields from earlier messages when the model returns nulls later', async () => {
    const { handle, store } = setup([result({}, { name: 'Maria', business_name: 'Santos Bakery' }), result()]);
    await handle(post(msg('I am Maria from Santos Bakery')));
    await handle(post(msg('What about inventory?')));
    expect(store.leads.get(SESSION)!.fields).toMatchObject({ name: 'Maria', business_name: 'Santos Bakery' });
  });

  it('sends history from earlier messages to the agent', async () => {
    const { handle, agent } = setup();
    await handle(post(msg('first')));
    await handle(post(msg('second')));
    const call = vi.mocked(agent.respond).mock.calls[1]![0];
    expect(call.message).toBe('second');
    expect(call.history.map((m) => m.content)).toEqual(['first', 'Our websites start at ₱10,000.']);
  });

  it('503 when the assistant is unavailable, and the message is still saved', async () => {
    const { handle, store } = setup([new AgentUnavailableError('overloaded')]);
    const res = await handle(post(msg('Magkano po ang inventory system?')));
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe('Please message us at info@destinevents.biz');
    expect(store.leads.get(SESSION)!.messages.map((m) => m.content)).toEqual(['Magkano po ang inventory system?']);
  });

  it('still replies if saving fails, and logs the error', async () => {
    const { handle, store, log } = setup();
    vi.spyOn(store, 'saveSession').mockRejectedValue(new Error('db down'));
    const res = await handle(post(msg('hi')));
    expect(res.status).toBe(200);
    expect(log.error).toHaveBeenCalled();
  });

  it('503 if the session cannot be loaded', async () => {
    const { handle, store } = setup();
    vi.spyOn(store, 'getSession').mockRejectedValue(new Error('db down'));
    expect((await handle(post(msg('hi')))).status).toBe(503);
  });
});

describe('POST /api/inquiry: privacy', () => {
  it('shows the consent line once, when contact details are first asked for', async () => {
    const { handle } = setup([result({ askingForContact: true })]);
    const first = await (await handle(post(msg('I need a website')))).json();
    expect(first.consentNotice).toBe(CONSENT_NOTICE);
    const second = await (await handle(post(msg('ok')))).json();
    expect(second.consentNotice).toBeUndefined();
  });

  it('records consent_at when contact details follow the consent line', async () => {
    const { handle, store } = setup([result({ askingForContact: true }), result({}, { phone: '0917 123 4567' })]);
    await handle(post(msg('I need a website')));
    expect(store.leads.get(SESSION)!.consentAt).toBeNull();
    await handle(post(msg('0917 123 4567')));
    expect(store.leads.get(SESSION)!.consentAt).not.toBeNull();
  });

  it('shows the consent line if contact details are volunteered before it was shown', async () => {
    const { handle } = setup([result({}, { email: 'maria@bakery.ph' })]);
    const body = await (await handle(post(msg('email me at maria@bakery.ph')))).json();
    expect(body.consentNotice).toBe(CONSENT_NOTICE);
  });

  it('handles "delete my data" without calling the model, and alerts the team', async () => {
    const { handle, agent, alerts } = setup();
    const res = await (await handle(post(msg('delete my data')))).json();
    expect(res.stage).toBe('handoff');
    expect(agent.respond).not.toHaveBeenCalled();
    expect(alerts).toEqual([expect.objectContaining({ kind: 'deletion_request' })]);
    expect(res.reply).toBe(DELETION_REPLY);
  });

  it('never claims the team was told when the deletion alert fails', async () => {
    const { handle, notifier, store } = setup();
    vi.mocked(notifier.send).mockRejectedValueOnce(new Error('email down'));
    const res = await (await handle(post(msg('delete my data')))).json();
    expect(res.reply).toBe(DELETION_REPLY_EMAIL_US);
    expect(res.reply).not.toMatch(/we've|emailed the|asked the/i);
    expect(store.leads.get(SESSION)!.messages.at(-1)!.content).toBe(DELETION_REPLY_EMAIL_US);
  });

  it('never claims the team was told when no alert channel is set up', async () => {
    const store = new MemoryStore();
    const notifier: Notifier = { send: vi.fn(async () => {}) };
    const handle = createInquiryHandler({
      store,
      notifier,
      agent: { respond: vi.fn() },
      log: { error: vi.fn(), warn: vi.fn() },
      config: { allowedOrigins: [ORIGIN], ipHashSalt: 'test', alertsReachTeam: false },
    });
    const res = await (await handle(post(msg('delete my data')))).json();
    expect(res.reply).toBe(DELETION_REPLY_EMAIL_US);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('stores a hashed IP, never the raw IP', async () => {
    const { handle, store } = setup();
    await handle(post(msg('hi'), { ip: '203.0.113.77' }));
    const stored = JSON.stringify(store.leads.get(SESSION));
    expect(stored).not.toContain('203.0.113.77');
    expect(store.leads.get(SESSION)!.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
