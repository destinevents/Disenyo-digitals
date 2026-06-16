-- ══════════════════════════════════════════════════
-- AYA x Destine Events — Supabase Schema
-- Run this once in the Supabase SQL Editor
-- ══════════════════════════════════════════════════

-- EVENTS
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  type          text not null,           -- 'Founder Session', 'RE:BLOOM', 'Founder Dinner', etc.
  description   text,
  date          date not null,
  time_start    time not null,
  time_end      time,
  venue         text default 'Location TBA',
  status        text default 'draft',    -- 'draft', 'on_sale', 'upcoming', 'past', 'cancelled'
  cover_emoji   text default '✦',
  cover_gradient text default 'linear-gradient(135deg,#1D2219,#3A4436)',
  created_at    timestamptz default now()
);

-- TICKET TYPES (per event)
create table if not exists ticket_types (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid references events(id) on delete cascade,
  name          text not null,
  tier          text not null,           -- 'Regular', 'Guest', 'VIP', etc.
  price         numeric(10,2) default 0,
  capacity      int not null default 20,
  description   text,
  status        text default 'on_sale',  -- 'on_sale', 'sold_out', 'hidden'
  sort_order    int default 0,
  created_at    timestamptz default now()
);

-- REGISTRATIONS
create table if not exists registrations (
  id              uuid primary key default gen_random_uuid(),
  reg_code        text unique not null default 'AYA-' || upper(substring(gen_random_uuid()::text, 1, 8)),
  event_id        uuid references events(id) on delete set null,
  ticket_type_id  uuid references ticket_types(id) on delete set null,
  full_name       text not null,
  email           text not null,
  mobile          text,
  business        text,
  industry        text,
  social_link     text,
  archetype       text,                  -- 'Founder', 'Creative', 'Community Builder', 'Enabler'
  special_notes   text,
  newsletter_opt  boolean default true,
  networking_opt  boolean default true,
  payment_status  text default 'pending', -- 'pending', 'confirmed', 'cancelled', 'refunded'
  payment_method  text,                  -- 'paymongo', 'gcash', 'maya', 'bank', 'free'
  payment_ref     text,
  amount_paid     numeric(10,2),
  qr_sent         boolean default false,
  checked_in      boolean default false,
  registered_at   timestamptz default now()
);

-- ══════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════

alter table events       enable row level security;
alter table ticket_types enable row level security;
alter table registrations enable row level security;

-- Public can read published events and ticket types
create policy "Public read events" on events
  for select using (status != 'draft');

create policy "Public read ticket types" on ticket_types
  for select using (true);

-- Anyone can insert a registration (public form)
create policy "Public insert registrations" on registrations
  for insert with check (true);

-- Service role has full access (admin dashboard)
create policy "Service role full access events" on events
  for all using (auth.role() = 'service_role');

create policy "Service role full access tickets" on ticket_types
  for all using (auth.role() = 'service_role');

create policy "Service role full access registrations" on registrations
  for all using (auth.role() = 'service_role');

-- ══════════════════════════════════════════════════
-- SEED DATA
-- ══════════════════════════════════════════════════

insert into events (slug, title, type, description, date, time_start, time_end, venue, status, cover_emoji, cover_gradient) values
(
  'builders-circle-june-2026',
  'AYA Builder''s Circle — June Session',
  'Founder Session',
  'A facilitated circle for Baguio''s entrepreneurs, creators & ecosystem builders. Expect structured rounds, real conversation, and zero corporate awkwardness.',
  '2026-06-28',
  '15:00',
  '17:00',
  'Location TBA',
  'on_sale',
  '💡',
  'linear-gradient(135deg,#1D2A3A,#2D5A8E)'
),
(
  'rebloom-2026',
  'RE:BLOOM 2026',
  'RE:BLOOM',
  'A sustainable floral retail transformation initiative for Baguio MSMEs — Refuse, Rethink, Reduce.',
  '2026-07-12',
  '09:00',
  null,
  'Baguio Convention Center',
  'on_sale',
  '🌸',
  'linear-gradient(135deg,#3A2228,#8B5A5A)'
);

-- Ticket types for Builder's Circle
insert into ticket_types (event_id, name, tier, price, capacity, description, status, sort_order)
select id, 'Builder''s Circle Pass', 'Regular', 500.00, 17, 'Single session pass — application-based', 'on_sale', 1
from events where slug = 'builders-circle-june-2026';

insert into ticket_types (event_id, name, tier, price, capacity, description, status, sort_order)
select id, 'Community Guest', 'Guest', 300.00, 5, 'For AYA community members with prior approval', 'on_sale', 2
from events where slug = 'builders-circle-june-2026';

-- Ticket types for RE:BLOOM
insert into ticket_types (event_id, name, tier, price, capacity, description, status, sort_order)
select id, 'General Admission', 'Regular', 0.00, 80, 'Free entry — open to all', 'on_sale', 1
from events where slug = 'rebloom-2026';

-- Sample registrations
insert into registrations (event_id, ticket_type_id, full_name, email, mobile, business, industry, archetype, payment_status, payment_method, amount_paid, qr_sent)
select
  e.id,
  t.id,
  r.full_name,
  r.email,
  r.mobile,
  r.business,
  r.industry,
  r.archetype,
  r.payment_status,
  r.payment_method,
  r.amount_paid,
  r.qr_sent
from (values
  ('builders-circle-june-2026', 'Builder''s Circle Pass', 'Maria Santos',   'maria@example.com',  '+63 917 123 4567', 'Startup PH',     'Tech & Digital',       'Founder',          'confirmed', 'gcash',    500.00, true),
  ('builders-circle-june-2026', 'Community Guest',        'Carlo Reyes',    'carlo@studio.ph',    '+63 918 234 5678', 'Studio Carlo',   'Events & Hospitality', 'Creative',         'pending',   'paymongo', 300.00, false),
  ('builders-circle-june-2026', 'Builder''s Circle Pass', 'Benj Orcine',    'benj@craft.ph',      '+63 920 456 7890', 'Craft Baguio',   'Tech & Digital',       'Enabler',          'pending',   'maya',     500.00, false),
  ('builders-circle-june-2026', 'Builder''s Circle Pass', 'Rico Delos Santos','rico@ventures.ph', '+63 922 678 9012', 'Ventures PH',   'Tech & Digital',       'Founder',          'confirmed', 'paymongo', 500.00, true),
  ('rebloom-2026',               'General Admission',      'Ana Villanueva', 'ana@baguio.co',      '+63 919 345 6789', 'Baguio Co.',     'Events & Hospitality', 'Community Builder','confirmed', 'free',       0.00, true),
  ('rebloom-2026',               'General Admission',      'Liza Mañibo',    'liza@pine.design',   '+63 921 567 8901', 'Pine Design',    'Events & Hospitality', 'Creative',         'confirmed', 'free',       0.00, true)
) as r(event_slug, ticket_name, full_name, email, mobile, business, industry, archetype, payment_status, payment_method, amount_paid, qr_sent)
join events       e on e.slug  = r.event_slug
join ticket_types t on t.event_id = e.id and t.name = r.ticket_name;
