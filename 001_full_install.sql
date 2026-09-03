-- ══════════════════════════════════════════════════════════════════════════
-- InfluenceOS — COMPLETE DATABASE INSTALL (replaces the old 001–024 files)
-- Run this ONE file in a FRESH Supabase project → SQL Editor → New query.
-- It creates the entire final schema: tables, RLS, realtime broadcast
-- triggers, and seed rows. Every statement is idempotent, so running it
-- again (or on an already-migrated project) is harmless.
-- ══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── ENUM TYPES ───────────────────────────
do $$ begin create type public.partner_type as enum ('youtuber','facebook','tiktoker','instagram','telegram','marketing_agent','agency'); exception when duplicate_object then null; end $$;
do $$ begin create type public.partner_status as enum ('disagree','agree','not_response','waiting'); exception when duplicate_object then null; end $$;
do $$ begin create type public.project_status as enum ('active','inactive'); exception when duplicate_object then null; end $$;
do $$ begin create type public.allocation_status as enum ('on_target','active','behind','inactive'); exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_status as enum ('scheduled','paid','pending'); exception when duplicate_object then null; end $$;
do $$ begin create type public.contribution_status as enum ('pending','accepted','rejected'); exception when duplicate_object then null; end $$;
do $$ begin create type public.withdrawal_status as enum ('pending','accepted','rejected'); exception when duplicate_object then null; end $$;
do $$ begin create type public.admin_user_status as enum ('pending','active','inactive'); exception when duplicate_object then null; end $$;

-- ─────────────────────────── CORE TABLES ───────────────────────────
-- Primary administrator (owner) account.
create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  phone text,
  address text,
  created_at timestamptz not null default now()
);

-- Agents / influencers.
create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  partner_code text not null unique check (partner_code ~ '^[0-9]{4}$'),
  name text not null,
  email text not null unique check (email = lower(email)),
  phone text,
  type public.partner_type not null default 'marketing_agent',
  accounts jsonb not null default '[]'::jsonb,
  password_hash text not null,
  login_access boolean not null default true,
  status public.partner_status not null default 'waiting',
  address text,
  followers integer not null default 0,
  channel_secret text not null default md5(random()::text || clock_timestamp()::text),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  details text,
  budget numeric(14,2) not null default 0 check (budget >= 0),
  start_date date,
  deadline date,
  note text,
  status public.project_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.allocations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  category text not null default 'users',
  assigned_target integer not null default 0 check (assigned_target >= 0),
  acquired_users integer not null default 0 check (acquired_users >= 0),
  commission numeric(14,2) not null default 0 check (commission >= 0),
  start_date date,
  deadline date,
  note text,
  status public.allocation_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, partner_id, category)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  payment_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'bank',
  transaction_id text,
  status public.payment_status not null default 'pending',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────── CONTRIBUTE / VAULTIUM / HELPDESK ───────────────────
create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  allocation_id uuid references public.allocations(id) on delete set null,
  code text,                                   -- short public code (C + 5 digits)
  acquired integer not null check (acquired > 0),
  note text,
  proof_url text,                              -- legacy single proof (pre-Vaultium)
  proof_name text,
  proof_type text,
  proof_size integer,
  status public.contribution_status not null default 'pending',
  reviewed_at timestamptz,
  review_note text,
  reviewed_by uuid references public.admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Admin-only audit trail of partner profile edits (made by the partner).
create table if not exists public.partner_logs (
  id bigint generated always as identity primary key,
  partner_id uuid not null references public.partners(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

-- Multiple proof files per contribution (stored in the Vaultium R2 bucket).
create table if not exists public.contribution_files (
  id uuid primary key default gen_random_uuid(),
  contribution_id uuid not null references public.contributions(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  file_name text not null,
  file_type text,
  file_size integer not null default 0,
  r2_key text not null,
  created_at timestamptz not null default now()
);

-- One continuous agent ↔ admin conversation per agent.
create table if not exists public.helpdesk_messages (
  id bigint generated always as identity primary key,
  partner_id uuid not null references public.partners(id) on delete cascade,
  sender_type text not null check (sender_type in ('agent','admin')),
  sender_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  read_by_admin boolean not null default false,
  read_by_agent boolean not null default false,
  created_at timestamptz not null default now()
);

-- ─────────────────── WITHDRAWALS / TEAMS ───────────────────
create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  method text not null check (method in ('bkash','nagad','crypto_usdt')),
  account_number text,
  account_type text check (account_type in ('agent','personal')),
  wallet_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (partner_id, method, account_number, wallet_address)
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  method text not null check (method in ('bkash','nagad','crypto_usdt')),
  account_type text,
  account_number text,
  wallet_address text,
  amount numeric(14,2) not null check (amount > 0),
  provider_number text,
  trx text,
  status public.withdrawal_status not null default 'pending',
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Agent team members (My Team page; 4-digit code, login optional).
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  code text not null unique check (code ~ '^[0-9]{4}$'),
  name text not null,
  email text not null unique check (email = lower(email)),
  phone text,
  type text not null check (type in ('youtuber','facebook','tiktoker','instagram','telegram','marketing_agent','agency')),
  accounts jsonb not null default '[]'::jsonb,
  password_hash text,
  login_access boolean not null default true,
  status text not null default 'active' check (status in ('active','inactive')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Agent team allocations (agent assigns own projects to team members).
create table if not exists public.team_allocations (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  category text not null default 'users',
  assigned_target integer not null default 0 check (assigned_target >= 0),
  acquired_users integer not null default 0 check (acquired_users >= 0),
  note text,
  status text not null default 'active' check (status in ('on_target','active','behind','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_member_id, project_id, category)
);

-- ─────────────────── ADMIN BOARD USERS ───────────────────
-- Board users request access; the owner approves via status='active'.
create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email = lower(email)),
  phone text,
  address text,
  password_hash text not null,
  status public.admin_user_status not null default 'pending',
  permissions jsonb not null default '{}'::jsonb,  -- per-module matrix; owner is never restricted
  channel_secret text not null default md5(random()::text || clock_timestamp()::text),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.admin_users.permissions is
  'Per-module action permissions for board users, e.g. {"agents":{"show":true,"add":true}}. Owner is never restricted.';

-- HelpDesk conversations between primary admin and board users.
create table if not exists public.admin_user_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.admin_users(id) on delete cascade,
  sender_type text not null check (sender_type in ('owner','user')),
  sender_id uuid,
  body text not null,
  read_by_owner boolean not null default false,
  read_by_user boolean not null default false,
  created_at timestamptz not null default now()
);

-- ─────────────────── CONNECTX (central mail) ───────────────────
create table if not exists public.connectx_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  from_name text not null default 'InfluenceOS',
  from_email text not null default 'no-reply@doxtox.com',
  reply_to text,
  global_daily_limit integer not null default 500 check (global_daily_limit >= 0),
  allocation_template_html text,
  payments_template_html text,
  withdraw_template_html text,
  contribute_template_html text,
  performance_template_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.connectx_settings (id, enabled, from_name, from_email, global_daily_limit)
values (1, true, 'InfluenceOS', 'no-reply@doxtox.com', 500)
on conflict (id) do nothing;

create table if not exists public.connectx_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid,
  sender_kind text not null default 'admin' check (sender_kind in ('owner','user','admin')),
  recipient_type text not null check (recipient_type in ('agent','user','manual')),
  recipient_id uuid,
  recipient_name text,
  from_email text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  subject text not null,
  custom_body text,
  body_html text,
  provider text not null default 'brevo_api',
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────── NOTIFICATIONS ───────────────────
-- One inbox table for both sides (admins + agents).
--   admin_user_id: null = all admins · '<id>' = that board user · 'owner:<id>' = owner
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_type text not null check (user_type in ('admin','partner')),
  partner_id uuid references public.partners(id) on delete cascade,
  admin_user_id text,
  kind text not null,
  title text not null,
  body text,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ─────────────────── TASK MANAGER ───────────────────
-- Author/poster ids are TEXT because admin ids are UUIDs.
create table if not exists public.tasks (
  id bigint generated always as identity primary key,
  code text not null unique,
  title text not null,
  status text not null default 'active',        -- active | progress | inactive | completed
  priority text not null default 'medium',      -- low | medium | high
  progress int not null default 0 check (progress between 0 and 100),
  visibility text not null default 'private',   -- private | public | shared
  shared_with jsonb not null default '[]'::jsonb,
  details text,
  created_by_kind text not null,                -- 'owner' | 'user'
  created_by_id text not null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_progress (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks(id) on delete cascade,
  user_kind text not null,
  user_id text not null,
  user_name text not null,
  note text not null,
  add_progress int not null default 0,
  approved boolean not null default false,
  approved_at timestamptz,
  approved_by_name text,
  rejected boolean not null default false,
  rejected_at timestamptz,
  reject_feedback text,
  created_at timestamptz not null default now()
);

-- ─────────────────── INDEXES ───────────────────
create index if not exists allocations_project_idx on public.allocations(project_id);
create index if not exists allocations_partner_idx on public.allocations(partner_id);
create index if not exists allocations_category_idx on public.allocations(category);
create index if not exists payments_partner_idx on public.payments(partner_id);
create index if not exists payments_project_idx on public.payments(project_id);
create index if not exists contributions_partner_created_idx on public.contributions(partner_id, created_at desc);
create index if not exists contributions_project_idx on public.contributions(project_id);
create index if not exists contributions_status_idx on public.contributions(status);
create index if not exists contributions_code_idx on public.contributions(code);
create index if not exists partner_logs_partner_created_idx on public.partner_logs(partner_id, created_at desc);
create index if not exists contribution_files_contrib_idx on public.contribution_files(contribution_id);
create index if not exists contribution_files_created_idx on public.contribution_files(created_at desc);
create index if not exists helpdesk_messages_partner_created_idx on public.helpdesk_messages(partner_id, created_at);
create index if not exists helpdesk_messages_admin_unread_idx on public.helpdesk_messages(read_by_admin) where read_by_admin = false;
create index if not exists helpdesk_messages_agent_unread_idx on public.helpdesk_messages(read_by_agent) where read_by_agent = false;
create index if not exists payment_methods_partner_idx on public.payment_methods(partner_id);
create index if not exists withdrawals_partner_created_idx on public.withdrawals(partner_id, created_at desc);
create index if not exists withdrawals_status_idx on public.withdrawals(status);
create index if not exists team_members_partner_created_idx on public.team_members(partner_id, created_at desc);
create index if not exists team_allocations_partner_created_idx on public.team_allocations(partner_id, created_at desc);
create index if not exists team_allocations_member_idx on public.team_allocations(team_member_id);
create index if not exists admin_users_status_idx on public.admin_users(status);
create index if not exists admin_user_messages_user_created_idx on public.admin_user_messages(user_id, created_at desc);
create index if not exists admin_user_messages_owner_unread_idx on public.admin_user_messages(read_by_owner, sender_type, created_at desc);
create index if not exists admin_user_messages_user_unread_idx on public.admin_user_messages(user_id, read_by_user, sender_type, created_at desc);
create index if not exists connectx_messages_created_idx on public.connectx_messages(created_at desc);
create index if not exists connectx_messages_recipient_idx on public.connectx_messages(recipient_type, recipient_id, created_at desc);
create index if not exists connectx_messages_status_idx on public.connectx_messages(status, created_at desc);
create index if not exists notifications_inbox_idx on public.notifications(user_type, partner_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications(user_type, read, created_at desc);
create index if not exists task_progress_task_idx on public.task_progress(task_id);

-- ─────────────────── DATA BACKFILLS (no-ops on a fresh database) ───────────────────
-- Short public code per contribution request.
update public.contributions
   set code = 'C' || lpad((floor(random()*90000)+10000)::int::text, 5, '0')
 where code is null;
-- Move any legacy single-proof records into contribution_files.
insert into public.contribution_files (contribution_id, partner_id, file_name, file_type, file_size, r2_key, created_at)
select id, partner_id, coalesce(proof_name,'proof'), proof_type, coalesce(proof_size,0), proof_url, created_at
  from public.contributions
 where proof_url is not null
   and not exists (select 1 from public.contribution_files f where f.contribution_id = public.contributions.id);
-- Channel secrets for pre-existing rows (defaults cover new ones).
update public.partners set channel_secret = md5(random()::text || clock_timestamp()::text) where channel_secret is null;
update public.admin_users set channel_secret = md5(random()::text || clock_timestamp()::text) where channel_secret is null;
-- Legacy allocation unique constraint → per-category (harmless if already applied).
alter table public.allocations drop constraint if exists allocations_project_id_partner_id_key;
alter table public.allocations drop constraint if exists allocations_project_partner_key;
do $$ begin
  alter table public.allocations add constraint allocations_project_partner_category_key unique (project_id, partner_id, category);
exception when duplicate_object then null; end $$;
-- Older installs: task author/poster ids were bigint — make them text (no-op if already text).
alter table public.tasks alter column created_by_id type text using created_by_id::text;
alter table public.task_progress alter column user_id type text using user_id::text;
-- Older installs: rejection/targeting columns (no-op if present).
alter table public.task_progress add column if not exists rejected boolean not null default false;
alter table public.task_progress add column if not exists rejected_at timestamptz;
alter table public.task_progress add column if not exists reject_feedback text;
alter table public.notifications add column if not exists admin_user_id text;
-- Default ConnectX attachment templates (kept only when not customised).
update public.connectx_settings set
  allocation_template_html = coalesce(allocation_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Allocation Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Start Date:</b> {{Start}}</p><p><b>Deadline:</b> {{Deadline}}</p><p><b>Target:</b> {{Target}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Commission:</b> {{Commission}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  payments_template_html = coalesce(payments_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Payment Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Amount:</b> {{Amount}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  withdraw_template_html = coalesce(withdraw_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Withdrawal Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Withdrawal Method:</b> {{Method}}</p><p><b>Destination Account:</b> {{Destination}}</p><p><b>Amount Withdrawn:</b> {{Amount}}</p><p><b>Current Status:</b> {{Status}}</p><p><b>Transaction:</b> {{trx}}</p></div>'),
  contribute_template_html = coalesce(contribute_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Contribution Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  performance_template_html = coalesce(performance_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Performance Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Rank:</b> {{Rank}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Assigned:</b> {{Assigned}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Achievement:</b> {{Achievement}}</p></div>'),
  updated_at = now()
where id = 1;
update public.connectx_settings set from_name = 'InfluenceOS', updated_at = now()
where id = 1 and (from_name is null or from_name = 'DoxTox ConnectX');

-- ─────────────────── RLS + REVOKES (service role is the only client) ───────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter table public.admins enable row level security;
alter table public.partners enable row level security;
alter table public.projects enable row level security;
alter table public.allocations enable row level security;
alter table public.payments enable row level security;
alter table public.contributions enable row level security;
alter table public.partner_logs enable row level security;
alter table public.contribution_files enable row level security;
alter table public.helpdesk_messages enable row level security;
alter table public.payment_methods enable row level security;
alter table public.withdrawals enable row level security;
alter table public.team_members enable row level security;
alter table public.team_allocations enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_user_messages enable row level security;
alter table public.connectx_settings enable row level security;
alter table public.connectx_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.tasks enable row level security;
alter table public.task_progress enable row level security;

-- ─────────────────── REALTIME BROADCAST (helpdesk + notifications) ───────────────────
create table if not exists public.helpdesk_channels (
  scope text primary key,
  secret text not null
);
insert into public.helpdesk_channels (scope, secret)
values ('admin', md5(random()::text || clock_timestamp()::text))
on conflict (scope) do nothing;

-- Realtime Authorization: the anon key may RECEIVE broadcasts on ios:* topics only
-- (topic names embed unguessable per-account secrets).
drop policy if exists "ios helpdesk broadcasts receivable" on realtime.messages;
create policy "ios helpdesk broadcasts receivable"
  on realtime.messages for select
  to anon, authenticated
  using (topic like 'ios:%');

-- Trigger: agent ↔ admin helpdesk messages → that agent's channel + the admin channel.
create or replace function public.hd_broadcast_agent()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$ declare p_sec text; a_sec text; begin
  select channel_secret into p_sec from public.partners where id = new.partner_id;
  select secret into a_sec from public.helpdesk_channels where scope = 'admin';
  if p_sec is not null then
    perform realtime.send(jsonb_build_object('kind','agent','thread_id',new.partner_id::text,'sender',new.sender_type),
      'msg','ios:agent:' || new.partner_id::text || ':' || p_sec, false);
  end if;
  if a_sec is not null then
    perform realtime.send(jsonb_build_object('kind','agent','thread_id',new.partner_id::text,'sender',new.sender_type),
      'msg','ios:admin:' || a_sec, false);
  end if;
  return new;
end; $$;
drop trigger if exists hd_agent_broadcast on public.helpdesk_messages;
create trigger hd_agent_broadcast after insert on public.helpdesk_messages
  for each row execute function public.hd_broadcast_agent();

-- Trigger: admin ↔ board-user messages → that user's channel + the admin channel.
create or replace function public.hd_broadcast_user()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$ declare u_sec text; a_sec text; begin
  select channel_secret into u_sec from public.admin_users where id = new.user_id;
  select secret into a_sec from public.helpdesk_channels where scope = 'admin';
  if u_sec is not null then
    perform realtime.send(jsonb_build_object('kind','user','thread_id',new.user_id::text,'sender',new.sender_type),
      'msg','ios:user:' || new.user_id::text || ':' || u_sec, false);
  end if;
  if a_sec is not null then
    perform realtime.send(jsonb_build_object('kind','user','thread_id',new.user_id::text,'sender',new.sender_type),
      'msg','ios:admin:' || a_sec, false);
  end if;
  return new;
end; $$;
drop trigger if exists hd_user_broadcast on public.admin_user_messages;
create trigger hd_user_broadcast after insert on public.admin_user_messages
  for each row execute function public.hd_broadcast_user();

-- Self-test helper: the API calls this RPC when you click the ● pill.
create or replace function public.hd_rt_probe(chan text)
returns void
language plpgsql
security definer
set search_path = public, realtime
as $$ begin
  perform realtime.send(jsonb_build_object('kind','test','thread_id','0'), 'msg', chan, false);
end; $$;

-- Trigger: every notification INSERT broadcasts to the right channel(s).
-- Hardened: text-only id comparisons (UUID-safe) and any internal failure is
-- swallowed so a notification INSERT can never fail.
create or replace function public.notif_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$ declare p_sec text; a_sec text; u record; begin
  begin
    if new.user_type = 'partner' then
      select channel_secret into p_sec from public.partners where id::text = new.partner_id::text;
      if p_sec is not null then
        perform realtime.send(jsonb_build_object('kind','notif'), 'msg',
          'ios:agent:' || new.partner_id::text || ':' || p_sec, false);
      end if;
    else
      select secret into a_sec from public.helpdesk_channels where scope = 'admin';
      if (new.admin_user_id is null or new.admin_user_id like 'owner:%') and a_sec is not null then
        perform realtime.send(jsonb_build_object('kind','notif'), 'msg', 'ios:admin:' || a_sec, false);
      end if;
      if new.admin_user_id is null then
        for u in select id::text as uid, channel_secret from public.admin_users loop
          if u.channel_secret is not null then
            perform realtime.send(jsonb_build_object('kind','notif'), 'msg',
              'ios:user:' || u.uid || ':' || u.channel_secret, false);
          end if;
        end loop;
      elsif new.admin_user_id not like 'owner:%' then
        select channel_secret into p_sec from public.admin_users where id::text = new.admin_user_id;
        if p_sec is not null then
          perform realtime.send(jsonb_build_object('kind','notif'), 'msg',
            'ios:user:' || new.admin_user_id || ':' || p_sec, false);
        end if;
      end if;
    end if;
  exception when others then
    null; -- broadcasting must never block the insert
  end;
  return new;
end; $$;
drop trigger if exists notif_broadcast on public.notifications;
create trigger notif_broadcast after insert on public.notifications
  for each row execute function public.notif_broadcast();

-- Legacy cleanup: the 018 wake-up table is obsolete (broadcast replaced it).
drop policy if exists "helpdesk wakeups publicly readable" on public.helpdesk_wakeups;
do $$ begin
  alter publication supabase_realtime drop table public.helpdesk_wakeups;
exception when undefined_object then null; when undefined_table then null; end $$;
drop table if exists public.helpdesk_wakeups;
