import { describe, expect, it } from 'vitest';
import {
  BROCHURE,
  CALENDLY_URL,
  CONTACT_LINKS,
  DEMOS,
  demoForBusiness,
  linksForFlags,
  matchQuickIntent,
  mergeQuickReplies,
  quickAnswer,
} from '../server/actions.js';

describe('brochure, demo, booking and "talk to a person" requests', () => {
  it.each([
    ['Browse service brochure', 'brochure'],
    ['May brochure po kayo?', 'brochure'],
    ['Discuss a demo', 'demo'],
    ['Watch demo', 'demo'],
    ['Can I see your work?', 'demo'],
    ['Do you have a portfolio?', 'demo'],
    ['sample work please', 'demo'],
    ['Specific business demo', 'browse_demos'],
    ['Do you have a clinic demo?', 'browse_demos'],
    ['payroll demo please', 'browse_demos'],
    ['My business: Café / Restaurant', 'business'],
    ['Talk to a person', 'person'],
    ['What is your viber number?', 'person'],
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

  it('uses the brochure, the demo videos, the Calendly page and the team contacts', () => {
    expect(BROCHURE.url).toBe('https://heyzine.com/flip-book/a6a6b9c519.html#page/4');
    expect(DEMOS.all.url).toBe('https://drive.google.com/file/d/1U1AZf_98SaXkd-j5AnXHUfgH4zoxKnVZ/view?usp=sharing');
    expect(DEMOS.inventory.url).toBe('https://disenyodigitals.com/demos/cafe-inventory-demo.mp4');
    expect(DEMOS.cafe.url).toBe('https://disenyodigitals.com/demos/cafe-inventory-demo.mp4');
    expect(DEMOS.payroll.url).toBe('https://disenyodigitals.com/demos/payroll-demo.mp4');
    expect(DEMOS.clinic.url).toBe('https://disenyodigitals.com/demos/clinic-demo.mp4');
    expect(DEMOS.staycation.url).toBe('https://drive.google.com/file/d/17Mjn3ebqKTDW8dT1-fyOm6IOzL-iOgPM/view?usp=drive_link');
    expect(CALENDLY_URL).toBe('https://calendly.com/disenyodigitalsdemo');
    expect(CONTACT_LINKS.map((l) => l.url)).toEqual([
      'tel:+639065713298',
      'viber://chat?number=%2B639065713298',
      'https://wa.me/61422770601',
      'https://m.me/disenyodigitals',
    ]);
  });

  it('every fixed reply except "talk to a person" ends with the Calendly link, and none says an inquiry was sent', () => {
    for (const intent of ['brochure', 'demo', 'browse_demos', 'book_call', 'business'] as const) {
      const answer = quickAnswer(intent, 'My business: Retail / Shop');
      const last = answer.followUp ?? answer;
      expect(last.links.at(-1)!.url).toBe(CALENDLY_URL);
      for (const part of [answer, answer.followUp].filter(Boolean)) {
        expect(part!.reply).not.toMatch(/sent to|has been sent|submitted|business name/i);
      }
    }
    expect(quickAnswer('person').links).toEqual(CONTACT_LINKS);
  });

  it('"Specific business demo" lists each business demo, then Others → Calendly', () => {
    expect(quickAnswer('browse_demos').links.map((l) => l.label)).toEqual([
      'Inventory system demo',
      'Café system demo',
      'Payroll system demo',
      'Clinic system demo',
      'Staycation / Cleaning system demo',
      'Others: book a call with our team',
    ]);
  });

  it('matches a business type to its demo, falling back to All Services', () => {
    expect(demoForBusiness('Café / Restaurant')).toBe(DEMOS.cafe);
    expect(demoForBusiness('Retail / Shop')).toBe(DEMOS.inventory);
    expect(demoForBusiness('Office / Company')).toBe(DEMOS.payroll);
    expect(demoForBusiness('Clinic / Healthcare')).toBe(DEMOS.clinic);
    expect(demoForBusiness('Resort / Staycation')).toBe(DEMOS.staycation);
    expect(demoForBusiness('construction')).toBe(DEMOS.all);
    const answer = quickAnswer('business', 'My business: dental clinic');
    expect(answer.industry).toBe('dental clinic');
    expect(answer.links).toEqual([DEMOS.clinic]);
  });

  it('adds links from the AI flags, booking last', () => {
    expect(linksForFlags({ wantsDemo: false, requestedHuman: false, requestedCall: false })).toEqual([]);
    expect(linksForFlags({ wantsDemo: true, requestedHuman: false, requestedCall: false }).map((l) => l.url)).toEqual([DEMOS.all.url, CALENDLY_URL]);
    expect(linksForFlags({ wantsDemo: false, requestedHuman: true, requestedCall: false })).toEqual(CONTACT_LINKS);
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
      'Specific business demo',
    ]);
  });
});
