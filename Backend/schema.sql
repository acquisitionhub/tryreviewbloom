-- ─────────────────────────────────────────────
-- Review Bloom — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── CONTACTS ────────────────────────────────
create table contacts (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  phone         text,
  email         text,
  service_tag   text,
  status        text default 'pending'
                check (status in ('pending','contacted','reviewed','no-reply','cooldown')),
  last_job_date date,
  cooldown_until timestamptz,
  source        text default 'manual',   -- 'manual' | 'csv' | 'jobber' | 'zapier' etc.
  ghl_contact_id text,                   -- GHL contact ID for syncing
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─── REVIEW REQUESTS ─────────────────────────
create table review_requests (
  id            uuid primary key default uuid_generate_v4(),
  contact_id    uuid references contacts(id) on delete cascade,
  type          text not null
                check (type in ('initial','followup-1','followup-2')),
  channel       text default 'sms'
                check (channel in ('sms','email','both')),
  status        text default 'scheduled'
                check (status in ('scheduled','sent','delivered','failed')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  message_body  text,
  twilio_sid    text,
  created_at    timestamptz default now()
);

-- ─── REVIEWS ─────────────────────────────────
create table reviews (
  id            uuid primary key default uuid_generate_v4(),
  contact_id    uuid references contacts(id) on delete set null,
  reviewer_name text,
  rating        integer check (rating between 1 and 5),
  text          text,
  platform      text default 'google',
  google_review_id text unique,
  reply_text    text,
  replied_at    timestamptz,
  reply_posted  boolean default false,
  social_posted boolean default false,
  created_at    timestamptz default now()
);

-- ─── WORKFLOWS ───────────────────────────────
create table workflow_settings (
  id            uuid primary key default uuid_generate_v4(),
  name          text unique not null,
  active        boolean default true,
  initial_delay_hours  integer default 2,
  followup1_delay_hours integer default 48,
  followup2_delay_hours integer default 120,
  cooldown_days integer default 30,
  all_paused    boolean default false,
  updated_at    timestamptz default now()
);

-- Seed default workflow settings
insert into workflow_settings (name, active) values
  ('review_request', true),
  ('followup', true),
  ('reactivation', false),
  ('ai_reply', true),
  ('social_post', true);

-- ─── MESSAGING TEMPLATES ─────────────────────
create table message_templates (
  id            uuid primary key default uuid_generate_v4(),
  type          text not null
                check (type in ('initial','followup-1','followup-2')),
  channel       text not null check (channel in ('sms','email')),
  subject       text,           -- email only
  body          text not null,
  owner_name    text,
  business_name text,
  active        boolean default true,
  created_at    timestamptz default now()
);

-- Seed default templates
insert into message_templates (type, channel, body, owner_name, business_name) values
  ('initial', 'sms',
   'Hi {{first_name}}! 👋 It was great working with you. Could you spare 60 seconds to leave us a Google review? It helps us enormously: {{review_link}} — {{owner_name}}, {{business_name}}',
   'Alex Johnson', 'Review Bloom'),
  ('followup-1', 'sms',
   'Hi {{first_name}}, just a gentle reminder — we''d really appreciate a quick Google review if you have a moment 🙏 {{review_link}} — {{business_name}}',
   'Alex Johnson', 'Review Bloom'),
  ('followup-2', 'sms',
   'Hi {{first_name}}, last time we''ll ask — if you were happy with our service, a review means the world to us ⭐ {{review_link}} — {{business_name}}',
   'Alex Johnson', 'Review Bloom');

-- ─── SOCIAL POSTS ────────────────────────────
create table social_posts (
  id            uuid primary key default uuid_generate_v4(),
  review_id     uuid references reviews(id) on delete set null,
  platform      text check (platform in ('instagram','facebook')),
  location_name text,
  template_type text,
  image_url     text,
  caption       text,
  status        text default 'draft'
                check (status in ('draft','scheduled','posted','failed')),
  scheduled_at  timestamptz,
  posted_at     timestamptz,
  platform_post_id text,
  created_at    timestamptz default now()
);

-- ─── LOCATIONS ───────────────────────────────
create table locations (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  platform      text check (platform in ('instagram','facebook','both')),
  page_id       text,           -- Facebook Page ID or Instagram Account ID
  active        boolean default true,
  created_at    timestamptz default now()
);

-- ─── INTEGRATIONS ────────────────────────────
create table integrations (
  id            uuid primary key default uuid_generate_v4(),
  name          text unique not null,
  category      text,
  connected     boolean default false,
  webhook_url   text,
  access_token  text,           -- encrypted in practice — use Supabase Vault
  config        jsonb,
  connected_at  timestamptz,
  updated_at    timestamptz default now()
);

-- Seed integrations
insert into integrations (name, category) values
  ('Jobber', 'Field Service'),
  ('Housecall Pro', 'Field Service'),
  ('WorkIz', 'Field Service'),
  ('Zapier', 'Automation'),
  ('Google Business Profile', 'Reviews'),
  ('QuickBooks Online', 'Invoicing'),
  ('Square', 'Payments'),
  ('Stripe', 'Payments'),
  ('Facebook / Instagram', 'Social Media');

-- ─── ACTIVITY LOG ────────────────────────────
create table activity_log (
  id            uuid primary key default uuid_generate_v4(),
  type          text not null,  -- 'sms_sent' | 'review_received' | 'reply_posted' etc.
  contact_id    uuid references contacts(id) on delete set null,
  review_id     uuid references reviews(id) on delete set null,
  metadata      jsonb,
  created_at    timestamptz default now()
);

-- ─── INDEXES ─────────────────────────────────
create index on contacts (status);
create index on contacts (phone);
create index on contacts (ghl_contact_id);
create index on review_requests (contact_id);
create index on review_requests (status);
create index on review_requests (scheduled_at);
create index on reviews (rating);
create index on reviews (google_review_id);
create index on social_posts (status);
create index on activity_log (type);
create index on activity_log (created_at desc);

-- ─── ROW LEVEL SECURITY ──────────────────────
alter table contacts enable row level security;
alter table reviews enable row level security;
alter table review_requests enable row level security;
alter table social_posts enable row level security;
alter table activity_log enable row level security;

-- Allow service role full access (used by API routes)
create policy "service_role_all" on contacts for all using (true);
create policy "service_role_all" on reviews for all using (true);
create policy "service_role_all" on review_requests for all using (true);
create policy "service_role_all" on social_posts for all using (true);
create policy "service_role_all" on activity_log for all using (true);

-- ─── UPDATED_AT TRIGGER ──────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger set_contacts_updated_at
  before update on contacts
  for each row execute function set_updated_at();

create trigger set_workflow_updated_at
  before update on workflow_settings
  for each row execute function set_updated_at();
