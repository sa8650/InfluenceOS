-- InfluenceOS — admin board users + project/allocation dates

-- Admin owner profile fields
alter table public.admins add column if not exists phone text;
alter table public.admins add column if not exists address text;

-- Project-level dates. These are for admin planning only and are not displayed in the agent project card.
alter table public.projects add column if not exists start_date date;
alter table public.projects add column if not exists deadline date;

-- Allocation-level dates. These are visible to agents wherever their allocated project is shown.
alter table public.allocations add column if not exists start_date date;
alter table public.allocations add column if not exists deadline date;

-- Admin board users. Users can request access; administrators approve by setting status='active'.
do $$ begin
  create type public.admin_user_status as enum ('pending','active','inactive');
exception when duplicate_object then null;
end $$;

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email = lower(email)),
  phone text,
  address text,
  password_hash text not null,
  status public.admin_user_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_users_status_idx on public.admin_users(status);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;
