import { describe, expect, it } from 'vitest';
import { CALENDLY_URL, DEMOS, linksForFlags, matchQuickIntent, mergeQuickReplies, quickAnswer } from '../server/actions.js';

describe('demo, booking and "talk to a person" requests', () => {
  it.each([
    ['Discuss a demo', 'demo'],
    ['Watch demo', 'demo'],
    ['Can I see your work?', 'demo'],
    ['Do you have a portfolio?', 'demo'],
    ['sample work please', 'demo'],
    ['Browse demos (Clinic / Staycation)', 'browse_demos'],
    ['Do you have a clinic demo?', 'browse_demos'],
    ['Talk to a person', 'person'],
    ['Can I speak with someone from your team?', 'person'],
    ['connect me with a real person', 'person'],
    ['Pwede ko po ba kayong makausap?', 'person'],
    ['Book a call', 'book_call'],
    ['Can we schedule a meeting?', 'book_call'],
  ])('%s → %s', (text, intent) => {
    expect(matchQuickIntent(text)).toBe(intent);
  });

  it.each(['Magkano website?', 'May payroll ba kayo?', 'tao po', 'I need an inventory system'])('leaves "%s" to the AI', (text) => {
    expect(matchQuickIntent(text)).toBeNull();
  });

  it('uses exactly the three demo videos and the Calendly page', () => {
    expect(DEMOS.all.url).toBe('https://drive.google.com/file/d/1U1AZf_98SaXkd-j5AnXHUfgH4zoxKnVZ/view?usp=sharing');
    expect(DEMOS.clinic.url).toBe('https://drive.google.com/file/d/1lp3oBCl7fDgissR1AHgYWpwhURvCQEWB/view?usp=sharing');
    expect(DEMOS.staycation.url).toBe('https://drive.google.com/file/d/17Mjn3ebqKTDW8dT1-fyOm6IOzL-iOgPM/view?usp=drive_link');
    expect(CALENDLY_URL).toBe('https://calendly.com/disenyodigitalsdemo');
  });

  it('every fixed reply ends with the Calendly booking link and never says an inquiry was sent', () => {
    for (const intent of ['demo', 'browse_demos', 'book_call', 'person'] as const) {
      const answer = quickAnswer(intent);
      const last = answer.followUp ?? answer;
      expect(last.links.at(-1)!.url).toBe(CALENDLY_URL);
      for (const part of [answer, answer.followUp].filter(Boolean)) {
        expect(part!.reply).not.toMatch(/sent to|has been sent|submitted|business name/i);
      }
    }
  });

  it('adds links from the AI flags, booking last', () => {
    expect(linksForFlags({ wantsDemo: false, requestedHuman: false, requestedCall: false })).toEqual([]);
    expect(linksForFlags({ wantsDemo: true, requestedHuman: false, requestedCall: false }).map((l) => l.url)).toEqual([DEMOS.all.url, CALENDLY_URL]);
    expect(linksForFlags({ wantsDemo: false, requestedHuman: true, requestedCall: false }).map((l) => l.url)).toEqual([CALENDLY_URL]);
  });

  it('keeps one model suggestion, drops contact-asking ones, and always offers booking and a person', () => {
    expect(mergeQuickReplies(['Ilang branches kayo?', 'Share business name'])).toEqual([
      'Ilang branches kayo?',
      'Watch demo',
      'Book a call',
      'Talk to a person',
    ]);
    expect(mergeQuickReplies(['Share business name'])).toEqual([
      'Watch demo',
      'Book a call',
      'Talk to a person',
      'Browse demos (Clinic / Staycation)',
    ]);
  });
});
