-- InfluencerOS — Partner & Influencer Management Platform (DoxTox)
-- Run ALL statements in this file inside a NEW, DEDICATED Supabase project
-- (do NOT reuse the EMS database project).

create type public.partner_type as enum ('youtuber','facebook','tiktoker','instagram','marketing_agent','agency');
create type public.partner_status as enum ('disagree','agree','not_response','waiting');
create type public.project_status as enum ('active','inactive');
create type public.allocation_status as enum ('on_target','active','behind','inactive');
create type public.payment_status as enum ('scheduled','paid','pending');

create table public.admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table public.partners (
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
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  details text,
  budget numeric(14,2) not null default 0 check (budget >= 0),
  note text,
  status public.project_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  assigned_target integer not null default 0 check (assigned_target >= 0),
  acquired_users integer not null default 0 check (acquired_users >= 0),
  commission numeric(14,2) not null default 0 check (commission >= 0),
  note text,
  status public.allocation_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, partner_id)
);

create table public.payments (
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

create index on public.allocations(project_id);
create index on public.allocations(partner_id);
create index on public.payments(partner_id);
create index on public.payments(project_id);

-- The service-role API is the only database client.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter table public.admins enable row level security;
alter table public.partners enable row level security;
alter table public.projects enable row level security;
alter table public.allocations enable row level security;
alter table public.payments enable row level security;
