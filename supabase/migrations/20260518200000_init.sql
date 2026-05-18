-- 20260518200000_init.sql
-- Initial schema for Converflow.
--
-- Tables:
--   users               Mirror of Clerk users with app profile fields.
--   daily_prompts       Catalog of rotating daily prompts.
--   sessions            One row per voice session.
--   subscriptions       Billing state per user (Stripe / Apple IAP / Google Play).
--   voice_usage_logs    Granular usage for cost monitoring + caps.
--   push_tokens         Expo push tokens per device.
--   streaks             Denormalized streak state for the home screen.
--   push_deliveries     Push notification delivery trail (audit + retry).
--
-- Auth model:
--   - All mutations go through the backend with the service_role key (which
--     bypasses RLS). The mobile client uses the anon key + a Clerk JWT.
--   - Clerk is configured as a Third-Party Auth provider in Supabase, so
--     `auth.jwt() ->> 'sub'` returns the Clerk user_id directly.
--   - RLS policies below grant reads only to the row owner.

-- ----- Extensions -----
create extension if not exists "pgcrypto";

-- ----- Helper functions -----

-- Returns the Clerk user_id from the current JWT (NULL if no JWT or service_role).
create or replace function public.clerk_user_id() returns text
language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

-- Generic updated_at trigger function.
create or replace function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- users
-- ============================================================
create table public.users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text unique not null,
  email text not null,
  role text not null default 'tech' check (role in ('tech')),  -- v1: only tech vertical
  level text check (level in ('beginner','intermediate','advanced','unknown')) default 'unknown',
  goal text check (goal in ('job','interviews','confidence','other')),
  daily_session_time time,
  timezone text not null default 'Europe/Madrid',
  locale text not null default 'es-ES',
  region text check (region in ('EU','NON_EU')),
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_clerk_user_id_idx on public.users (clerk_user_id);
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- ============================================================
-- daily_prompts
-- ============================================================
create table public.daily_prompts (
  id uuid primary key default gen_random_uuid(),
  format text not null check (format in ('news','journal','challenge','tech_scenario')),
  role text not null default 'tech',
  level text check (level in ('beginner','intermediate','advanced','any')) default 'any',
  prompt_text text not null,
  system_instructions text,
  context jsonb,
  active_from date,
  active_to date,
  created_at timestamptz not null default now()
);
create index daily_prompts_format_role_idx on public.daily_prompts (format, role, active_from);

-- ============================================================
-- sessions
-- ============================================================
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  prompt_id uuid references public.daily_prompts(id) on delete set null,
  prompt_format text check (prompt_format in ('news','journal','challenge','tech_scenario')),
  transcript jsonb not null default '[]'::jsonb,
  feedback jsonb,
  model_used text,
  estimated_cost_cents numeric(10,4) check (estimated_cost_cents is null or estimated_cost_cents >= 0),
  status text not null check (status in ('active','completed','aborted','error')) default 'active',
  error_reason text,
  created_at timestamptz not null default now()
);
create index sessions_user_started_idx on public.sessions (user_id, started_at desc);
create index sessions_user_status_idx on public.sessions (user_id, status);

-- ============================================================
-- subscriptions
-- ============================================================
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('stripe','apple_iap','google_play')),
  provider_subscription_id text not null,
  status text not null check (status in ('trialing','active','past_due','cancelled','expired')),
  tier text not null check (tier in ('free','premium')),
  billing_cycle text check (billing_cycle in ('monthly','annual')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
-- At most one active/trialing subscription per user.
create unique index subscriptions_one_active_per_user
  on public.subscriptions (user_id) where status in ('trialing','active');
create index subscriptions_user_idx on public.subscriptions (user_id);
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ============================================================
-- voice_usage_logs
-- ============================================================
create table public.voice_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  occurred_at timestamptz not null default now(),
  minutes_used numeric(8,4) not null check (minutes_used >= 0),
  model text not null,
  input_audio_tokens integer,
  output_audio_tokens integer,
  input_text_tokens integer,
  output_text_tokens integer,
  cost_cents numeric(10,4) not null check (cost_cents >= 0)
);
create index voice_usage_user_occurred_idx on public.voice_usage_logs (user_id, occurred_at desc);

-- ============================================================
-- push_tokens
-- ============================================================
create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  expo_push_token text not null,
  device_id text,
  platform text check (platform in ('ios','android')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (user_id, expo_push_token)
);
create index push_tokens_active_idx on public.push_tokens (user_id) where revoked_at is null;

-- ============================================================
-- streaks
-- ============================================================
create table public.streaks (
  user_id uuid primary key references public.users(id) on delete cascade,
  current_streak integer not null default 0 check (current_streak >= 0),
  longest_streak integer not null default 0 check (longest_streak >= 0),
  last_session_date date,
  total_minutes integer not null default 0 check (total_minutes >= 0),
  updated_at timestamptz not null default now()
);
create trigger streaks_set_updated_at before update on public.streaks
  for each row execute function public.set_updated_at();

-- ============================================================
-- push_deliveries
-- ============================================================
create table public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  push_token_id uuid references public.push_tokens(id) on delete set null,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  expo_ticket_id text,
  status text not null check (status in ('queued','sent','delivered','failed','dropped')) default 'queued',
  error text,
  created_at timestamptz not null default now()
);
create index push_deliveries_user_scheduled_idx on public.push_deliveries (user_id, scheduled_for desc);

-- ============================================================
-- Row-Level Security
-- ============================================================
alter table public.users               enable row level security;
alter table public.sessions            enable row level security;
alter table public.daily_prompts       enable row level security;
alter table public.subscriptions       enable row level security;
alter table public.voice_usage_logs    enable row level security;
alter table public.push_tokens         enable row level security;
alter table public.streaks             enable row level security;
alter table public.push_deliveries     enable row level security;

-- users: self read + update
create policy users_select_self on public.users
  for select to authenticated
  using (clerk_user_id = public.clerk_user_id());

create policy users_update_self on public.users
  for update to authenticated
  using (clerk_user_id = public.clerk_user_id());

-- sessions: self read
create policy sessions_select_self on public.sessions
  for select to authenticated
  using (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

-- subscriptions: self read
create policy subscriptions_select_self on public.subscriptions
  for select to authenticated
  using (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

-- voice_usage_logs: self read
create policy voice_usage_select_self on public.voice_usage_logs
  for select to authenticated
  using (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

-- streaks: self read
create policy streaks_select_self on public.streaks
  for select to authenticated
  using (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

-- push_tokens: self read + insert
create policy push_tokens_select_self on public.push_tokens
  for select to authenticated
  using (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

create policy push_tokens_insert_self on public.push_tokens
  for insert to authenticated
  with check (
    user_id in (select id from public.users where clerk_user_id = public.clerk_user_id())
  );

-- daily_prompts: public read (no PII)
create policy daily_prompts_public_read on public.daily_prompts
  for select to anon, authenticated
  using (true);

-- push_deliveries: backend-only (no policies for authenticated;
--   service_role bypasses RLS, which is what writes to this table).

-- ============================================================
-- Done.
-- ============================================================
