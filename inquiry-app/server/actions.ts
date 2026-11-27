// Demo videos, booking and "talk to a person": answered in code with fixed links, so the links are
// always right and these replies need no AI call. The chat itself doesn't send anything to the
// team: Calendly collects the visitor's name and email and emails the team for every booking.

/** A link the chat page shows as a button. Opens in a new tab. */
export interface ChatLink {
  label: string;
  url: string;
}

export const CALENDLY_URL = 'https://calendly.com/disenyodigitalsdemo';

export const DEMOS = {
  all: { label: 'All Services demo', url: 'https://drive.google.com/file/d/1U1AZf_98SaXkd-j5AnXHUfgH4zoxKnVZ/view?usp=sharing' },
  // Hosted on the website itself (demos/clinic-demo.mp4): the Google Drive link was not found.
  clinic: { label: 'Clinic system demo', url: 'https://disenyodigitals.com/demos/clinic-demo.mp4' },
  staycation: {
    label: 'Staycation / Cleaning system demo',
    url: 'https://drive.google.com/file/d/17Mjn3ebqKTDW8dT1-fyOm6IOzL-iOgPM/view?usp=drive_link',
  },
} as const satisfies Record<string, ChatLink>;

export const BOOK_CALL_LINK: ChatLink = { label: 'Book a free 30-minute call', url: CALENDLY_URL };

/** Quick-reply buttons. The page opens Calendly directly for "Book a call" and "Talk to a person". */
export const CHIP_WATCH_DEMO = 'Watch demo';
export const CHIP_BROWSE_DEMOS = 'Browse demos (Clinic / Staycation)';
export const CHIP_BOOK_CALL = 'Book a call';
export const CHIP_TALK_TO_PERSON = 'Talk to a person';
export const ACTION_CHIPS = [CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON];

export type QuickIntent = 'browse_demos' | 'demo' | 'book_call' | 'person';

/** One chat bubble: text, then its link buttons. */
export interface AnswerPart {
  reply: string;
  links: ChatLink[];
}

export interface QuickAnswer extends AnswerPart {
  /** A second bubble after the first one: the booking invitation after the demo videos. */
  followUp?: AnswerPart;
  quickReplies: string[];
  /** Used for the lead's stage, like the model's flags. */
  requestedHuman: boolean;
  requestedCall: boolean;
}

const BROWSE = [/\bbrowse (specific |more )?demos?\b/i, /\b(clinic|staycation|cleaning|resort)\b.{0,20}\bdemos?\b/i, /\bdemos?\b.{0,20}\b(clinic|staycation|cleaning|resort)\b/i];
const DEMO = [/\bdemos?\b/i, /\bsample (work|projects?)\b/i, /\bsamples?\b.{0,20}\b(gawa|work|projects?)\b/i, /\bportfolio\b/i, /\bsee (your|some of your|ur) (work|projects?)\b/i, /\bwatch (a |the )?(demo|video)\b/i];
const PERSON = [
  /\b(talk|speak|chat)\s+(to|with)\s+(a |an |the )?(real )?(person|human|someone|somebody|agent|staff|representative|team)\b/i,
  /\bconnect (me )?(with|to) (a |an |the )?(real )?(person|human|someone|agent|staff|team)\b/i,
  /\b(real|actual) (person|human)\b/i,
  /\b(call me|call back|callback)\b/i,
  /\bmakausap\b/i,
];
const BOOK = [/\bbook (a |an )?(free )?(call|meeting|consultation|appointment|demo call)\b/i, /\bschedule (a |an )?(call|meeting|consultation)\b/i, /\bset (up )?(a |an )?(call|meeting)\b/i];

/**
 * Recognises demo, booking and "talk to a person" requests (including the quick-reply buttons).
 * Most specific first: "browse demos" before "demo", "talk to a person" before "book".
 */
export function matchQuickIntent(message: string): QuickIntent | null {
  const text = message.trim();
  if (BROWSE.some((p) => p.test(text))) return 'browse_demos';
  if (PERSON.some((p) => p.test(text))) return 'person';
  if (BOOK.some((p) => p.test(text))) return 'book_call';
  if (DEMO.some((p) => p.test(text))) return 'demo';
  return null;
}

const BOOK_FOLLOW_UP: AnswerPart = {
  reply: 'Want to see how this would work for your business? Book a free 30-minute call with our team:',
  links: [BOOK_CALL_LINK],
};

export function quickAnswer(intent: QuickIntent): QuickAnswer {
  switch (intent) {
    case 'demo':
      return {
        reply: "Here's a short demo of what we build across all our services. You can also browse our clinic and staycation demos with the button below.",
        links: [DEMOS.all],
        followUp: BOOK_FOLLOW_UP,
        quickReplies: [CHIP_BROWSE_DEMOS, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
      };
    case 'browse_demos':
      return {
        reply: 'Here are our specific demos:',
        links: [DEMOS.clinic, DEMOS.staycation],
        followUp: BOOK_FOLLOW_UP,
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
      };
    case 'book_call':
      return {
        reply: 'Great! Pick a time that works for you and our team will meet you on a free 30-minute call:',
        links: [BOOK_CALL_LINK],
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS],
        requestedHuman: false,
        requestedCall: true,
      };
    case 'person':
      return {
        reply: 'Yes, of course! Our team can call you. Just pick a time that works for you here:',
        links: [BOOK_CALL_LINK],
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS],
        requestedHuman: true,
        requestedCall: false,
      };
  }
}

/** Links to add under an AI reply, from the model's flags. Booking always comes last. */
export function linksForFlags(flags: { wantsDemo: boolean; requestedHuman: boolean; requestedCall: boolean }): ChatLink[] {
  const links: ChatLink[] = [];
  if (flags.wantsDemo) links.push(DEMOS.all);
  if (flags.wantsDemo || flags.requestedHuman || flags.requestedCall) links.push(BOOK_CALL_LINK);
  return links;
}

// Model-suggested buttons that ask for details the chat no longer collects (Calendly does).
const CONTACT_CHIP = /\b(business name|name|contact|number|mobile|phone|email|e-mail|details)\b/i;

// Order used to fill the buttons after an AI reply: booking and a person stay one tap away.
const FILL_ORDER = [CHIP_WATCH_DEMO, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON, CHIP_BROWSE_DEMOS];

/**
 * Up to 4 buttons: one suggestion from the model (never one that asks for contact details),
 * then the action buttons, so "Watch demo", "Book a call" and "Talk to a person" are always there.
 */
export function mergeQuickReplies(modelReplies: string[]): string[] {
  const out: string[] = [];
  const suggestion = modelReplies.find((q) => !CONTACT_CHIP.test(q) && !matchQuickIntent(q));
  if (suggestion) out.push(suggestion);
  for (const chip of FILL_ORDER) {
    if (out.length >= 4) break;
    if (!out.includes(chip)) out.push(chip);
  }
  return out;
}
