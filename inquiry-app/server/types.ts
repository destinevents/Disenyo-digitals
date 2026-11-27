// Shared types for the inquiry server. Field names match the inquiry_leads columns (07_DATABASE.md).

export const SOURCES = ['heyzine', 'link', 'qr', 'website'] as const;
export type Source = (typeof SOURCES)[number];

export type Stage = 'browsing' | 'qualifying' | 'ready_for_consultation' | 'handoff';

/** Lead fields the assistant extracts from the conversation. All optional (01_PRD.md). */
export interface LeadFields {
  name: string | null;
  business_name: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  preferred_channel: string | null;
  location: string | null;
  service_type: string | null;
  requirements: string | null;
  budget_range: string | null;
  timeline: string | null;
  decision_maker: boolean | null;
}

export const LEAD_FIELD_KEYS = [
  'name',
  'business_name',
  'industry',
  'email',
  'phone',
  'preferred_channel',
  'location',
  'service_type',
  'requirements',
  'budget_range',
  'timeline',
  'decision_maker',
] as const satisfies readonly (keyof LeadFields)[];

export function emptyFields(): LeadFields {
  return {
    name: null,
    business_name: null,
    industry: null,
    email: null,
    phone: null,
    preferred_channel: null,
    location: null,
    service_type: null,
    requirements: null,
    budget_range: null,
    timeline: null,
    decision_maker: null,
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string; // ISO timestamp
  /** True on the assistant message that showed the privacy consent line. */
  consentNotice?: boolean;
  /** Buttons shown under this assistant message (demo videos, Calendly). */
  links?: { label: string; url: string }[];
}

/** What the server knows about one chat session (one inquiry_leads row). */
export interface LeadSession {
  sessionId: string;
  stage: Stage;
  score: number | null;
  summary: string | null;
  fields: LeadFields;
  messages: ChatMessage[];
  consentAt: string | null;
  alertedAt: string | null;
}

/** Everything written for a session on each message. Null fields never overwrite stored values. */
export interface LeadUpdate {
  sessionId: string;
  source: Source;
  stage: Stage;
  score: number | null;
  summary: string | null;
  fields: LeadFields;
  messages: ChatMessage[];
  consentAt: string | null;
  alertedAt: string | null;
  ipHash: string | null;
}

/** What the model returns for each prospect message (see server/agent.ts). */
export interface AgentResult {
  reply: string;
  quickReplies: string[];
  fields: LeadFields;
  score: number;
  summary: string;
  /** The model only distinguishes browsing from qualifying. The server decides ready/handoff. */
  stage: 'browsing' | 'qualifying';
  requestedHuman: boolean;
  requestedCall: boolean;
  /** True when the prospect wants to see a demo or sample work. The page then shows the demo video. */
  wantsDemo: boolean;
  /** Set when the rules say to hand off: upset, complaint, existing project, legal/contract/payment. */
  handoffReason: string | null;
  /** True when this reply asks for the prospect's name or contact details. */
  askingForContact: boolean;
}

export interface AgentInput {
  history: ChatMessage[];
  message: string;
}

export interface Agent {
  respond(input: AgentInput): Promise<AgentResult>;
}

export interface LeadStore {
  getSession(sessionId: string): Promise<LeadSession | null>;
  saveSession(update: LeadUpdate): Promise<void>;
  /** Counts one message for this IP and returns false if it is over the hourly limit. */
  hitIpLimit(ipHash: string, limitPerHour: number): Promise<boolean>;
}

/**
 * lead: the lead just became ready or asked for a person (once per lead).
 * contact_update: contact details arrived after that alert went out without them (once).
 * deletion_request: the prospect typed "delete my data".
 */
export type AlertKind = 'lead' | 'contact_update' | 'deletion_request';

export interface Alert {
  kind: AlertKind;
  stage: Stage;
  score: number | null;
  summary: string | null;
  fields: LeadFields;
  handoffReason: string | null;
  source: Source;
}

export interface Notifier {
  send(alert: Alert): Promise<void>;
}
