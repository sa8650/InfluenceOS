-- InfluenceOS — ConnectX central mail communication system
-- Run after 010_admin_users_and_dates.sql

create table if not exists public.connectx_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  from_name text not null default 'InfluenceOS',
  from_email text not null default 'no-reply@doxtox.com',
  reply_to text,
  global_daily_limit integer not null default 500 check (global_daily_limit >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.connectx_settings(id, enabled, from_name, from_email, global_daily_limit)
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

create index if not exists connectx_messages_created_idx on public.connectx_messages(created_at desc);
create index if not exists connectx_messages_recipient_idx on public.connectx_messages(recipient_type, recipient_id, created_at desc);
create index if not exists connectx_messages_status_idx on public.connectx_messages(status, created_at desc);

revoke all on public.connectx_settings, public.connectx_messages from anon, authenticated;
alter table public.connectx_settings enable row level security;
alter table public.connectx_messages enable row level security;
