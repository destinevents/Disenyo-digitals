// Brochure, demo videos, booking, "talk to a person" and the business-type picker: answered in
// code with fixed links, so the links are always right and these replies need no AI call. The chat
// itself doesn't send anything to the team: Calendly collects the visitor's name and email and
// emails the team for every booking, and "Talk to a person" shows the team's phone, Viber,
// WhatsApp and Messenger.

/** A link the chat page shows as a button. Web links open in a new tab; tel/viber links dial. */
export interface ChatLink {
  label: string;
  url: string;
}

export const CALENDLY_URL = 'https://calendly.com/disenyodigitalsdemo';

export const BROCHURE: ChatLink = { label: 'Open the service brochure', url: 'https://heyzine.com/flip-book/a6a6b9c519.html#page/4' };

export const DEMOS = {
  all: { label: 'All Services demo', url: 'https://drive.google.com/file/d/1U1AZf_98SaXkd-j5AnXHUfgH4zoxKnVZ/view?usp=sharing' },
  // The inventory and café demos are the same video (a café inventory system).
  inventory: { label: 'Inventory system demo', url: 'https://disenyodigitals.com/demos/cafe-inventory-demo.mp4' },
  cafe: { label: 'Café system demo', url: 'https://disenyodigitals.com/demos/cafe-inventory-demo.mp4' },
  payroll: { label: 'Payroll system demo', url: 'https://disenyodigitals.com/demos/payroll-demo.mp4' },
  clinic: { label: 'Clinic system demo', url: 'https://disenyodigitals.com/demos/clinic-demo.mp4' },
  staycation: {
    label: 'Staycation / Cleaning system demo',
    url: 'https://drive.google.com/file/d/17Mjn3ebqKTDW8dT1-fyOm6IOzL-iOgPM/view?usp=drive_link',
  },
} as const satisfies Record<string, ChatLink>;

export const BOOK_CALL_LINK: ChatLink = { label: 'Book a free 30-minute call', url: CALENDLY_URL };
const OTHERS_LINK: ChatLink = { label: 'Others: book a call with our team', url: CALENDLY_URL };

/** "Talk to a person": dial or message the team directly. */
export const CONTACT_LINKS: ChatLink[] = [
  { label: 'Call or text: 0906 571 3298', url: 'tel:+639065713298' },
  { label: 'Viber: 0906 571 3298', url: 'viber://chat?number=%2B639065713298' },
  { label: 'WhatsApp: +61 422 770 601', url: 'https://wa.me/61422770601' },
  { label: 'Messenger: disenyodigitals', url: 'https://m.me/disenyodigitals' },
];

/** Quick-reply buttons. The page opens Calendly directly for "Book a call". */
export const CHIP_BROCHURE = 'Browse service brochure';
export const CHIP_WATCH_DEMO = 'Watch demo';
export const CHIP_BROWSE_DEMOS = 'Specific business demo';
export const CHIP_BOOK_CALL = 'Book a call';
export const CHIP_TALK_TO_PERSON = 'Talk to a person';
export const ACTION_CHIPS = [CHIP_BROCHURE, CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON];

/**
 * Options of the "type of business" dropdown. The page sends the choice as
 * `${BUSINESS_PREFIX}${option}`; "Others" lets the visitor type their own.
 */
export const BUSINESS_PREFIX = 'My business: ';
export const BUSINESS_TYPES = [
  'Retail / Shop',
  'Café / Restaurant',
  'Clinic / Healthcare',
  'Resort / Staycation',
  'Office / Company',
  'School / Training',
] as const;

export type QuickIntent = 'brochure' | 'browse_demos' | 'demo' | 'book_call' | 'person' | 'business';

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
  /** The business type picked in the dropdown (or typed under "Others"). */
  industry?: string;
}

const BUSINESS = /^\s*my business:\s*(.+)$/i;
const BROCHURE_RE = [/\bbrochure\b/i, /\bcompany profile\b/i, /\bmagazine\b/i, /\bcatalog(ue)?\b/i, /\bflip ?book\b/i];
const SPECIFIC = /\b(clinic|staycation|cleaning|resort|inventory|caf[eé]|restaurant|payroll)\b/i;
const BROWSE = [
  /\bspecific (business )?demos?\b/i,
  /\bbrowse (specific |more )?demos?\b/i,
  new RegExp(`${SPECIFIC.source}.{0,20}\\bdemos?\\b`, 'i'),
  new RegExp(`\\bdemos?\\b.{0,20}${SPECIFIC.source}`, 'i'),
];
const DEMO = [/\bdemos?\b/i, /\bsample (work|projects?)\b/i, /\bsamples?\b.{0,20}\b(gawa|work|projects?)\b/i, /\bportfolio\b/i, /\bsee (your|some of your|ur) (work|projects?)\b/i, /\bwatch (a |the )?(demo|video)\b/i];
const PERSON = [
  /\b(talk|speak|chat)\s+(to|with)\s+(a |an |the )?(real )?(person|human|someone|somebody|agent|staff|representative|team)\b/i,
  /\bconnect (me )?(with|to) (a |an |the )?(real )?(person|human|someone|agent|staff|team)\b/i,
  /\b(real|actual) (person|human)\b/i,
  /\b(call me|call back|callback)\b/i,
  /\bmakausap\b/i,
  /\b(your|ur) (phone|mobile|contact|viber|whatsapp|messenger)( number| no\.?)?\b/i,
];
const BOOK = [/\bbook (a |an )?(free )?(call|meeting|consultation|appointment|demo call)\b/i, /\bschedule (a |an )?(call|meeting|consultation)\b/i, /\bset (up )?(a |an )?(call|meeting)\b/i];

/**
 * Recognises brochure, demo, booking and "talk to a person" requests, the quick-reply buttons and
 * the business-type dropdown. Most specific first: "browse demos" before "demo", "talk to a person"
 * before "book".
 */
export function matchQuickIntent(message: string): QuickIntent | null {
  const text = message.trim();
  if (BUSINESS.test(text)) return 'business';
  if (BROCHURE_RE.some((p) => p.test(text))) return 'brochure';
  if (BROWSE.some((p) => p.test(text))) return 'browse_demos';
  if (PERSON.some((p) => p.test(text))) return 'person';
  if (BOOK.some((p) => p.test(text))) return 'book_call';
  if (DEMO.some((p) => p.test(text))) return 'demo';
  return null;
}

/** The demo closest to a business type, from the dropdown or typed under "Others". */
export function demoForBusiness(business: string): ChatLink {
  const b = business.toLowerCase();
  if (/caf[eé]|coffee|restaurant|food|resto|bakery|kitchen|bar\b/.test(b)) return DEMOS.cafe;
  if (/clinic|health|medical|dental|hospital|pharma|vet/.test(b)) return DEMOS.clinic;
  if (/resort|staycation|hotel|airbnb|rental|cleaning|stay|inn\b/.test(b)) return DEMOS.staycation;
  if (/retail|shop|store|grocery|warehouse|distribut|supplier|inventory|sari/.test(b)) return DEMOS.inventory;
  if (/office|company|corporate|payroll|hr\b|agency|bpo|firm/.test(b)) return DEMOS.payroll;
  return DEMOS.all;
}

const BOOK_FOLLOW_UP: AnswerPart = {
  reply: 'Want to see how this would work for your business? Book a free 30-minute call with our team:',
  links: [BOOK_CALL_LINK],
};

export function quickAnswer(intent: QuickIntent, message = ''): QuickAnswer {
  switch (intent) {
    case 'brochure':
      return {
        reply: 'Here is our service brochure. Flip through it to see all our services and starting rates:',
        links: [BROCHURE],
        followUp: BOOK_FOLLOW_UP,
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
      };
    case 'demo':
      return {
        reply: "Here's a short demo of what we build across all our services. You can also see a demo for a specific business with the button below.",
        links: [DEMOS.all],
        followUp: BOOK_FOLLOW_UP,
        quickReplies: [CHIP_BROWSE_DEMOS, CHIP_BOOK_CALL, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
      };
    case 'browse_demos':
      return {
        reply: 'Pick the demo that fits your business. For any other business, book a call and we will show you what we can build:',
        links: [DEMOS.inventory, DEMOS.cafe, DEMOS.payroll, DEMOS.clinic, DEMOS.staycation, OTHERS_LINK],
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BROCHURE, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
      };
    case 'book_call':
      return {
        reply: 'Great! Pick a time that works for you and our team will meet you on a free 30-minute call:',
        links: [BOOK_CALL_LINK],
        quickReplies: [CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: true,
      };
    case 'person':
      return {
        reply: 'Yes, of course! You can reach our team directly by mobile, Viber, WhatsApp or Messenger:',
        links: CONTACT_LINKS,
        quickReplies: [CHIP_BOOK_CALL, CHIP_WATCH_DEMO, CHIP_BROWSE_DEMOS],
        requestedHuman: true,
        requestedCall: false,
      };
    case 'business': {
      const industry = (BUSINESS.exec(message.trim())?.[1] ?? '').trim().slice(0, 80);
      const demo = demoForBusiness(industry);
      return {
        reply:
          demo === DEMOS.all
            ? "Thanks! Here's a short demo of what we build across all our services:"
            : "Thanks! Here's the demo closest to your business:",
        links: [demo],
        followUp: { reply: 'Want us to show you how it would work for yours? Book a free demo call with our team:', links: [BOOK_CALL_LINK] },
        quickReplies: [CHIP_BOOK_CALL, CHIP_BROWSE_DEMOS, CHIP_TALK_TO_PERSON],
        requestedHuman: false,
        requestedCall: false,
        industry: industry || undefined,
      };
    }
  }
}

/** Links to add under an AI reply, from the model's flags. Booking always comes last. */
export function linksForFlags(flags: { wantsDemo: boolean; requestedHuman: boolean; requestedCall: boolean }): ChatLink[] {
  const links: ChatLink[] = [];
  if (flags.wantsDemo) links.push(DEMOS.all);
  if (flags.requestedHuman) links.push(...CONTACT_LINKS);
  if (flags.wantsDemo || flags.requestedCall) links.push(BOOK_CALL_LINK);
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
