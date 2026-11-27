// Chat page. All message text is rendered with textContent, never as HTML (05_SECURITY.md).
// Links (brochure, demo videos, Calendly, phone/Viber/WhatsApp/Messenger) are built as <a>
// elements from an allow-list in api.ts.
import { CALENDLY_URL, isDialLink, safeLinks, sendMessage, type ChatLink, type Source } from './api';

const SESSION_KEY = 'disenyo-inquiry:session';
const TRANSCRIPT_KEY = 'disenyo-inquiry:transcript';
const SOURCES: Source[] = ['heyzine', 'link', 'qr', 'website'];

const OPENING =
  "Hi! I'm Disenyo's AI assistant. I can tell you about our AI systems, websites and digital solutions, and help you get a quote. Browse our brochure, watch a demo, or tell me what you're looking to build.";
const OPENING_CHIPS = ['Browse service brochure', 'Watch demo', 'Specific business demo', 'Talk to a person'];
// These buttons open the Calendly booking page in a new tab (and still show the reply in the chat).
const CALENDLY_CHIPS = ['Book a call'];
// Must match BUSINESS_PREFIX in server/actions.ts.
const BUSINESS_PREFIX = 'My business: ';
const OTHERS = 'Others (type it in)';
const DEFAULT_PLACEHOLDER = 'Type your question…';

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; links?: ChatLink[] }
  | { kind: 'notice'; text: string; tone: 'consent' | 'error' };

const log = document.getElementById('log') as HTMLElement;
const chips = document.getElementById('chips') as HTMLElement;
const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendButton = document.getElementById('send') as HTMLButtonElement;
const picker = document.getElementById('picker') as HTMLElement;
const personButton = document.getElementById('person') as HTMLButtonElement;

// sessionStorage can throw (private mode, blocked storage, some iframes). The chat still works without it.
function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function getSessionId(): string {
  const existing = readStorage(SESSION_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeStorage(SESSION_KEY, id);
  return id;
}

function getSource(): Source {
  const param = new URLSearchParams(location.search).get('source');
  if (param && (SOURCES as string[]).includes(param)) return param as Source;
  const framed = window.self !== window.top;
  return framed ? 'heyzine' : 'link';
}

const sessionId = getSessionId();
const source = getSource();
let transcript: Entry[] = [];
let busy = false;
// True after "Others" in the business dropdown: the next typed message is their type of business.
let typingBusiness = false;

function render(entry: Entry): void {
  const el = document.createElement('div');
  if (entry.kind === 'notice') {
    el.className = `notice ${entry.tone}`;
  } else {
    el.className = `msg ${entry.kind}`;
  }
  el.textContent = entry.text;
  log.appendChild(el);
  if (entry.kind === 'assistant' && entry.links?.length) log.appendChild(renderLinks(entry.links));
}

function renderLinks(links: ChatLink[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'links';
  for (const link of links) {
    const a = document.createElement('a');
    a.href = link.url;
    a.textContent = link.label;
    if (isDialLink(link.url)) {
      // Phone and Viber links open the dialler or the app, not a page.
      a.className = 'link-button dial';
    } else {
      a.className = link.url.startsWith(CALENDLY_URL) ? 'link-button primary' : 'link-button';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    wrap.appendChild(a);
  }
  return wrap;
}

function add(entry: Entry, persist = true): void {
  render(entry);
  if (persist) {
    transcript.push(entry);
    writeStorage(TRANSCRIPT_KEY, JSON.stringify(transcript));
  }
  scrollToEnd();
}

function scrollToEnd(): void {
  log.scrollTop = log.scrollHeight;
}

function setChips(options: string[]): void {
  chips.replaceChildren();
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = option;
    button.addEventListener('click', () => {
      // Open Calendly straight away, from the click itself so it isn't blocked as a pop-up.
      if (CALENDLY_CHIPS.includes(option)) window.open(CALENDLY_URL, '_blank', 'noopener');
      void submit(option);
    });
    chips.appendChild(button);
  }
  // The buttons change the height of the conversation area: keep the newest message in view.
  scrollToEnd();
}

/** The "type of business" dropdown. Picking one sends it; "Others" lets them type their own. */
function setPicker(config?: { prompt: string; options: string[] }): void {
  picker.replaceChildren();
  if (!config) return;
  const label = document.createElement('label');
  label.htmlFor = 'business';
  label.textContent = config.prompt;
  const select = document.createElement('select');
  select.id = 'business';
  const placeholder = new Option('Choose one…', '', true, true);
  placeholder.disabled = true;
  select.add(placeholder);
  for (const option of [...config.options, OTHERS]) select.add(new Option(option, option));
  select.addEventListener('change', () => {
    if (select.value === OTHERS) {
      typingBusiness = true;
      input.placeholder = 'Type your type of business…';
      input.focus();
      return;
    }
    if (select.value) void submit(BUSINESS_PREFIX + select.value);
  });
  picker.append(label, select);
  scrollToEnd();
}

function showTyping(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'typing';
  el.setAttribute('aria-label', 'Assistant is typing');
  el.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  log.appendChild(el);
  scrollToEnd();
  return el;
}

function setBusy(value: boolean): void {
  busy = value;
  sendButton.disabled = value;
  personButton.disabled = value;
  for (const chip of chips.querySelectorAll('button')) chip.disabled = value;
  for (const select of picker.querySelectorAll('select')) select.disabled = value;
}

function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

async function submit(text: string): Promise<void> {
  let message = text.trim();
  if (!message || busy) return;
  // Typed after "Others" in the business dropdown (unless they used a button instead).
  if (typingBusiness && text === input.value) message = BUSINESS_PREFIX + message;
  typingBusiness = false;
  input.placeholder = DEFAULT_PLACEHOLDER;

  setBusy(true);
  setChips([]);
  setPicker();
  add({ kind: 'user', text: message });
  input.value = '';
  autoGrow();

  const typing = showTyping();
  const result = await sendMessage(sessionId, message, source);
  typing.remove();

  if (result.ok) {
    const { reply, quickReplies, links, followUp, consentNotice, businessPicker } = result.data;
    add({ kind: 'assistant', text: reply, links });
    if (followUp) add({ kind: 'assistant', text: followUp.reply, links: followUp.links });
    if (consentNotice) add({ kind: 'notice', text: consentNotice, tone: 'consent' });
    setPicker(businessPicker);
    setChips(quickReplies);
  } else {
    add({ kind: 'notice', text: result.message, tone: 'error' }, false);
  }

  setBusy(false);
  input.focus({ preventScroll: true });
}

function restore(): boolean {
  const raw = readStorage(TRANSCRIPT_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    // Drop the old "Your inquiry has been sent" notice from chats saved before it was removed,
    // and re-check any saved links against the allow-list.
    const saved = (parsed as Entry[])
      .filter((e) => !(e.kind === 'notice' && (e.tone as string) === 'saved'))
      .map((e) => (e.kind === 'assistant' && e.links ? { ...e, links: safeLinks(e.links) } : e));
    transcript = saved;
    writeStorage(TRANSCRIPT_KEY, JSON.stringify(transcript));
    for (const entry of saved) render(entry);
    scrollToEnd();
    return true;
  } catch {
    return false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit(input.value);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit(input.value);
  }
});

input.addEventListener('input', autoGrow);

// Header "Talk to a person": shows the team's mobile, Viber, WhatsApp and Messenger in the chat.
personButton.addEventListener('click', () => void submit('Talk to a person'));

// Inside the "Inquire with AI" panel on disenyodigitals.com, Escape closes the panel.
// Key presses inside this frame never reach the website, so tell it. The message carries no data.
if (window.self !== window.top) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.parent.postMessage({ type: 'disenyo-inquire:close' }, '*');
  });
}

if (!restore()) {
  add({ kind: 'assistant', text: OPENING });
  setChips(OPENING_CHIPS);
}
