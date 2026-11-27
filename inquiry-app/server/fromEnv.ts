// Wires real dependencies from environment variables (06_API_SPEC.md).
// The names start with INQUIRY_ because this runs in the disenyodigitals.com Vercel project next to
// the PayMongo registration functions, whose SUPABASE_URL points at a different database.
// RESEND_API_KEY keeps its standard name: the Vercel Resend integration sets it.
// Missing settings fall back to dev versions, with a warning.
import { DEFAULT_MODEL, OpenAIAgent } from './agent.js';
import { createInquiryHandler } from './handler.js';
import { ConsoleNotifier, MultiNotifier, parseEmailList, ResendEmailNotifier, TelegramNotifier } from './notifier.js';
import { MemoryStore } from './stores/memoryStore.js';
import { SupabaseStore } from './stores/supabaseStore.js';
import type { LeadStore, Notifier } from './types.js';
import { parseAllowedOrigins } from './validate.js';

/** Sender for alert emails. disenyodigitals.com is verified in the team's Resend account. */
export const DEFAULT_ALERT_FROM = 'Disenyo AI Inquiries <alerts@disenyodigitals.com>';

export function handlerFromEnv(env: NodeJS.ProcessEnv = process.env): (request: Request) => Promise<Response> {
  const isProduction = env.VERCEL_ENV === 'production';

  let store: LeadStore;
  if (env.INQUIRY_SUPABASE_URL && env.INQUIRY_SUPABASE_ANON_KEY) {
    store = new SupabaseStore(env.INQUIRY_SUPABASE_URL, env.INQUIRY_SUPABASE_ANON_KEY);
  } else {
    console.warn('[inquiry] INQUIRY_SUPABASE_URL/INQUIRY_SUPABASE_ANON_KEY not set: using the in-memory store. Leads are NOT persisted.');
    store = new MemoryStore();
  }

  // Alerts go to every channel that is configured: email, Telegram, or both.
  const channels: Notifier[] = [];
  const emailTo = parseEmailList(env.INQUIRY_ALERT_EMAIL_TO);
  if (env.RESEND_API_KEY && emailTo.length) {
    channels.push(new ResendEmailNotifier(env.RESEND_API_KEY, env.INQUIRY_ALERT_EMAIL_FROM || DEFAULT_ALERT_FROM, emailTo));
  }
  if (env.INQUIRY_TELEGRAM_BOT_TOKEN && env.INQUIRY_TELEGRAM_CHAT_ID) {
    channels.push(new TelegramNotifier(env.INQUIRY_TELEGRAM_BOT_TOKEN, env.INQUIRY_TELEGRAM_CHAT_ID));
  }
  let notifier: Notifier;
  if (channels.length === 0) {
    console.warn('[inquiry] No alert channel set (RESEND_API_KEY + INQUIRY_ALERT_EMAIL_TO, or INQUIRY_TELEGRAM_*): alerts go to the server log.');
    notifier = new ConsoleNotifier();
  } else {
    notifier = channels.length === 1 ? channels[0]! : new MultiNotifier(channels);
  }

  if (!env.OPENAI_API_KEY) {
    console.warn('[inquiry] OPENAI_API_KEY not set: every chat will get the "please message us" fallback.');
  }

  if (isProduction && !env.INQUIRY_IP_HASH_SALT) {
    console.warn('[inquiry] INQUIRY_IP_HASH_SALT not set: IP hashes are unsalted.');
  }

  return createInquiryHandler({
    store,
    notifier,
    agent: new OpenAIAgent(undefined, undefined, env.INQUIRY_OPENAI_MODEL || DEFAULT_MODEL),
    config: {
      allowedOrigins: parseAllowedOrigins(env.INQUIRY_ALLOWED_ORIGINS),
      ipHashSalt: env.INQUIRY_IP_HASH_SALT ?? '',
      alertsReachTeam: channels.length > 0,
    },
  });
}
