-- InfluenceOS — HelpDesk conversations between primary admin and board users
-- Run after 013_connectx_attachment_templates.sql

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

create index if not exists admin_user_messages_user_created_idx on public.admin_user_messages(user_id, created_at desc);
create index if not exists admin_user_messages_owner_unread_idx on public.admin_user_messages(read_by_owner, sender_type, created_at desc);
create index if not exists admin_user_messages_user_unread_idx on public.admin_user_messages(user_id, read_by_user, sender_type, created_at desc);

revoke all on public.admin_user_messages from anon, authenticated;
alter table public.admin_user_messages enable row level security;
