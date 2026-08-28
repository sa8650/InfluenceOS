-- ══════════════════════════════════════════════════════════════════════════
-- 016 · NOTIFICATIONS (run once in Supabase → SQL Editor)
--
-- One inbox table for both sides:
--   • Admins  (user_type='admin')  → new contributions, withdrawal requests,
--                                     new agent registrations
--   • Agents  (user_type='partner') → allocation assigned/updated/removed,
--                                     contribution accepted/rejected,
--                                     payment added/paid/deleted,
--                                     withdrawal accepted/rejected
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.notifications(
  id uuid primary key default gen_random_uuid(),
  user_type text not null check (user_type in ('admin','partner')),
  partner_id uuid references public.partners(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_inbox_idx
  on public.notifications(user_type, partner_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications(user_type, read, created_at desc);

-- Only the service role (the Cloudflare API) may touch notifications.
alter table public.notifications enable row level security;

-- Housekeeping: drop notifications older than 90 days (run manually when wanted).
-- delete from public.notifications where created_at < now() - interval '90 days';
