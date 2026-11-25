import { describe, expect, it } from 'vitest';
import { decideStage, isDeletionRequest, isReady, mergeFields } from '../server/readiness.js';
import { emptyFields, type LeadFields } from '../server/types.js';

const f = (partial: Partial<LeadFields>): LeadFields => ({ ...emptyFields(), ...partial });
const modelSays = (overrides: Partial<Parameters<typeof decideStage>[2]> = {}) => ({
  stage: 'qualifying' as const,
  score: 3,
  requestedHuman: false,
  requestedCall: false,
  handoffReason: null,
  ...overrides,
});

// 08_TEST_PLAN.md: "Ready rule: correct stage for 10 sample field sets."
const cases: [string, LeadFields, boolean][] = [
  ['nothing known', f({}), false],
  ['service only', f({ service_type: 'Websites' }), false],
  ['contact only', f({ phone: '0917 123 4567' }), false],
  ['contact + service, no details', f({ phone: '0917', service_type: 'Websites' }), false],
  ['contact + service + budget only', f({ email: 'a@b.ph', service_type: 'Websites', budget_range: '₱10k' }), false],
  ['contact + service + budget + timeline', f({ email: 'a@b.ph', service_type: 'Websites', budget_range: '₱10k', timeline: 'January' }), true],
  ['contact + service + timeline + requirements', f({ phone: '0917', service_type: 'Inventory', timeline: 'Q1', requirements: '2 branches' }), true],
  ['all three details', f({ phone: '0917', service_type: 'Payroll', budget_range: '₱40k', timeline: 'March', requirements: '15 staff' }), true],
  ['details but no contact', f({ service_type: 'Payroll', budget_range: '₱40k', timeline: 'March' }), false],
  ['blank strings do not count', f({ phone: '  ', service_type: 'Payroll', budget_range: '₱40k', timeline: 'March' }), false],
];

describe('ready rule', () => {
  it.each(cases)('%s', (_label, fields, expected) => {
    expect(isReady(fields)).toBe(expected);
    const { stage } = decideStage('qualifying', fields, modelSays());
    expect(stage).toBe(expected ? 'ready_for_consultation' : 'qualifying');
  });
});

describe('decideStage', () => {
  const ready = f({ phone: '0917', service_type: 'Websites', budget_range: '₱10k', timeline: 'Jan' });

  it('hands off when the prospect asks for a person, even on the first message', () => {
    expect(decideStage('browsing', f({}), modelSays({ requestedHuman: true, stage: 'browsing' })).stage).toBe('handoff');
  });

  it('hands off on a handoff reason (complaint, legal, existing project)', () => {
    expect(decideStage('qualifying', f({}), modelSays({ handoffReason: 'complaint' })).stage).toBe('handoff');
  });

  it('is ready whenever the prospect asks for a call', () => {
    expect(decideStage('browsing', f({}), modelSays({ requestedCall: true })).stage).toBe('ready_for_consultation');
  });

  it('never moves a stage backwards', () => {
    expect(decideStage('ready_for_consultation', f({}), modelSays({ stage: 'browsing' })).stage).toBe('ready_for_consultation');
    expect(decideStage('handoff', ready, modelSays()).stage).toBe('handoff');
  });

  it('keeps browsing until there is interest in a service', () => {
    expect(decideStage('browsing', f({}), modelSays({ stage: 'browsing' })).stage).toBe('browsing');
    expect(decideStage('browsing', f({ service_type: 'Websites' }), modelSays({ stage: 'browsing' })).stage).toBe('qualifying');
  });

  it('scores 4+ only when the ready rule is met', () => {
    expect(decideStage('qualifying', ready, modelSays({ score: 2 })).score).toBe(4);
    expect(decideStage('qualifying', ready, modelSays({ score: 5 })).score).toBe(5);
    expect(decideStage('qualifying', f({}), modelSays({ score: 5 })).score).toBe(3);
    expect(decideStage('qualifying', f({}), modelSays({ score: 0 })).score).toBe(1);
  });
});

describe('mergeFields', () => {
  it('keeps known values when the new value is null or blank', () => {
    const merged = mergeFields(f({ name: 'Maria', phone: '0917' }), f({ name: null, phone: ' ', email: 'm@x.ph' }));
    expect(merged).toMatchObject({ name: 'Maria', phone: '0917', email: 'm@x.ph' });
  });

  it('keeps decision_maker false (not treated as empty)', () => {
    expect(mergeFields(f({ decision_maker: true }), f({ decision_maker: false })).decision_maker).toBe(false);
  });
});

describe('isDeletionRequest', () => {
  it.each(['delete my data', 'Please DELETE MY DATA', 'pls remove my details', 'burahin ang aking data'])('matches "%s"', (m) => {
    expect(isDeletionRequest(m)).toBe(true);
  });
  it.each(['how do you delete old stock data?', 'magkano website?'])('ignores "%s"', (m) => {
    expect(isDeletionRequest(m)).toBe(false);
  });
});
