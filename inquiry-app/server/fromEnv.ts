// Wires real dependencies from environment variables (06_API_SPEC.md).
// The names start with INQUIRY_ because this runs in the disenyodigitals.com Vercel project,
// which already has SUPABASE_URL etc. for the AYA registrations (a different database).
// Missing Supabase or Telegram settings fall back to dev versions, with a warning.
import { ClaudeAgent } from './agent.js';
import { createInquiryHandler } from './handler.js';
import { ConsoleNotifier, TelegramNotifier } from './notifier.js';
import { MemoryStore } from './stores/memoryStore.js';
import { SupabaseStore } from './stores/supabaseStore.js';
import type { LeadStore, Notifier } from './types.js';
import { parseAllowedOrigins } from './validate.js';

export function handlerFromEnv(env: NodeJS.ProcessEnv = process.env): (request: Request) => Promise<Response> {
  const isProduction = env.VERCEL_ENV === 'production';

  let store: LeadStore;
  if (env.INQUIRY_SUPABASE_URL && env.INQUIRY_SUPABASE_ANON_KEY) {
    store = new SupabaseStore(env.INQUIRY_SUPABASE_URL, env.INQUIRY_SUPABASE_ANON_KEY);
  } else {
    console.warn('[inquiry] INQUIRY_SUPABASE_URL/INQUIRY_SUPABASE_ANON_KEY not set: using the in-memory store. Leads are NOT persisted.');
    store = new MemoryStore();
  }

  let notifier: Notifier;
  if (env.INQUIRY_TELEGRAM_BOT_TOKEN && env.INQUIRY_TELEGRAM_CHAT_ID) {
    notifier = new TelegramNotifier(env.INQUIRY_TELEGRAM_BOT_TOKEN, env.INQUIRY_TELEGRAM_CHAT_ID);
  } else {
    console.warn('[inquiry] INQUIRY_TELEGRAM_BOT_TOKEN/INQUIRY_TELEGRAM_CHAT_ID not set: alerts go to the server log.');
    notifier = new ConsoleNotifier();
  }

  if (isProduction && !env.INQUIRY_IP_HASH_SALT) {
    console.warn('[inquiry] INQUIRY_IP_HASH_SALT not set: IP hashes are unsalted.');
  }

  return createInquiryHandler({
    store,
    notifier,
    agent: new ClaudeAgent(),
    config: {
      allowedOrigins: parseAllowedOrigins(env.INQUIRY_ALLOWED_ORIGINS),
      ipHashSalt: env.INQUIRY_IP_HASH_SALT ?? '',
    },
  });
}
