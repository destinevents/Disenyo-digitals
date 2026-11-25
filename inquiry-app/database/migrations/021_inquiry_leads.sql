-- 021_inquiry_leads.sql — Disenyo AI Inquiry Assistant (Phase 1)
-- For Gab to review and run in the HQ Supabase SQL Editor. Safe to re-run.
--
-- Adds:
--   * inquiry_leads           one row per chat session; admin-only read (same rule as clients)
--   * inquiry_rate_limits     per-IP hourly counter; no direct access
--   * submit_inquiry()        public write path: insert/update its own session's row only
--   * get_inquiry_session()   public read of ONE session's chat state, by its random uuid
--   * check_inquiry_rate_limit()  public per-IP hourly counter
--
-- Changes from the draft in 07_DATABASE.md:
--   * decision_maker column (it is a qualification field in 01_PRD.md)
--   * get_inquiry_session(): the inquiry server needs the earlier messages and stage, but the
--     anon key has no table access. It returns only chat state, never ip_hash/client_id/meeting_id.
--   * check_inquiry_rate_limit(): the 30 messages per IP per hour limit needs shared state,
--     because serverless instances don't share memory.
--   * submit_inquiry() rejects oversized message arrays.
--
-- Nothing in clients, meetings or any other HQ table changes.

create table if not exists inquiry_leads (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid unique not null,
  brand             text not null default 'Disenyo Digitals',
  source            text default 'heyzine',           -- heyzine | link | qr | website
  stage             text not null default 'browsing', -- browsing | qualifying | ready_for_consultation | handoff | converted | closed
  score             int  check (score between 1 and 5),
  name              text,
  business_name     text,
  industry          text,
  email             text,
  phone             text,
  preferred_channel text,
  location          text,
  service_type      text,
  requirements      text,
  budget_range      text,
  timeline          text,
  decision_maker    boolean,
  summary           text,
  messages          jsonb not null default '[]',
  consent_at        timestamptz,
  alerted_at        timestamptz,
  ip_hash           text,
  client_id         bigint references clients(id)  on delete set null,
  meeting_id        bigint references meetings(id) on delete set null,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

alter table inquiry_leads add column if not exists decision_maker boolean;

create index if not exists inquiry_leads_stage_created
  on inquiry_leads (stage, created_at desc);

alter table inquiry_leads enable row level security;

drop policy if exists "admin_only" on inquiry_leads;
create policy "admin_only" on inquiry_leads for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

do $$
begin
  alter publication supabase_realtime add table inquiry_leads;
exception when duplicate_object then null;
end $$;

-- Per-IP hourly counter. RLS on with no policies: only the security-definer function below can touch it.
create table if not exists inquiry_rate_limits (
  ip_hash      text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (ip_hash, window_start)
);

alter table inquiry_rate_limits enable row level security;

-- ---------------------------------------------------------------------------
-- Public write path
-- ---------------------------------------------------------------------------
create or replace function public.submit_inquiry(
  p_session  uuid,
  p_fields   jsonb,   -- extracted lead fields, score, stage, summary, source, consent_at, alerted_at, ip_hash
  p_messages jsonb    -- full message array for this session
) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_messages is not null and (
       jsonb_typeof(p_messages) <> 'array'
       or jsonb_array_length(p_messages) > 60
       or octet_length(p_messages::text) > 200000) then
    raise exception 'messages too large';
  end if;

  insert into inquiry_leads (session_id, messages)
  values (p_session, coalesce(p_messages, '[]'))
  on conflict (session_id) do nothing;

  update inquiry_leads set
    name              = coalesce(p_fields->>'name', name),
    business_name     = coalesce(p_fields->>'business_name', business_name),
    industry          = coalesce(p_fields->>'industry', industry),
    email             = coalesce(p_fields->>'email', email),
    phone             = coalesce(p_fields->>'phone', phone),
    preferred_channel = coalesce(p_fields->>'preferred_channel', preferred_channel),
    location          = coalesce(p_fields->>'location', location),
    service_type      = coalesce(p_fields->>'service_type', service_type),
    requirements      = coalesce(p_fields->>'requirements', requirements),
    budget_range      = coalesce(p_fields->>'budget_range', budget_range),
    timeline          = coalesce(p_fields->>'timeline', timeline),
    decision_maker    = coalesce((p_fields->>'decision_maker')::boolean, decision_maker),
    summary           = coalesce(p_fields->>'summary', summary),
    score             = coalesce((p_fields->>'score')::int, score),
    stage             = coalesce(p_fields->>'stage', stage),
    source            = coalesce(p_fields->>'source', source),
    consent_at        = coalesce(consent_at, (p_fields->>'consent_at')::timestamptz),
    alerted_at        = coalesce(alerted_at, (p_fields->>'alerted_at')::timestamptz),
    ip_hash           = coalesce(p_fields->>'ip_hash', ip_hash),
    messages          = coalesce(p_messages, messages),
    updated_at        = now()
  where session_id = p_session
    and stage not in ('converted', 'closed')            -- the public can't touch converted leads
    and coalesce(p_fields->>'stage', 'browsing')
        in ('browsing','qualifying','ready_for_consultation','handoff');
  -- client_id and meeting_id are never written here: only HQ sets them.
end;
$$;

revoke all on function public.submit_inquiry(uuid, jsonb, jsonb) from public;
grant execute on function public.submit_inquiry(uuid, jsonb, jsonb) to anon;

-- ---------------------------------------------------------------------------
-- Public read of one session's chat state (needs the session's random uuid)
-- ---------------------------------------------------------------------------
create or replace function public.get_inquiry_session(p_session uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'stage', stage,
    'score', score,
    'summary', summary,
    'name', name,
    'business_name', business_name,
    'industry', industry,
    'email', email,
    'phone', phone,
    'preferred_channel', preferred_channel,
    'location', location,
    'service_type', service_type,
    'requirements', requirements,
    'budget_range', budget_range,
    'timeline', timeline,
    'decision_maker', decision_maker,
    'messages', messages,
    'consent_at', consent_at,
    'alerted_at', alerted_at
  )
  from inquiry_leads
  where session_id = p_session;
$$;

revoke all on function public.get_inquiry_session(uuid) from public;
grant execute on function public.get_inquiry_session(uuid) to anon;

-- ---------------------------------------------------------------------------
-- Per-IP hourly rate limit. Returns true if this message is allowed.
-- ---------------------------------------------------------------------------
create or replace function public.check_inquiry_rate_limit(p_ip_hash text, p_limit int)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_hits int;
begin
  if p_ip_hash is null or length(p_ip_hash) > 128 then
    return false;
  end if;

  delete from inquiry_rate_limits where window_start < now() - interval '2 hours';

  insert into inquiry_rate_limits (ip_hash, window_start, hits)
  values (p_ip_hash, date_trunc('hour', now()), 1)
  on conflict (ip_hash, window_start) do update set hits = inquiry_rate_limits.hits + 1
  returning hits into v_hits;

  return v_hits <= least(coalesce(p_limit, 30), 30);
end;
$$;

revoke all on function public.check_inquiry_rate_limit(text, int) from public;
grant execute on function public.check_inquiry_rate_limit(text, int) to anon;
