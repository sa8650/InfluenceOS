-- InfluencerOS 006: Agent team members (My Team page in the agent portal).
-- Run in the SAME InfluencerOS Supabase project after 001–005.
-- Note: team members get a 4-digit code but NO login yet (planned for later).

create table public.team_members (
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
create index on public.team_members(partner_id, created_at desc);

revoke all on public.team_members from anon, authenticated;
alter table public.team_members enable row level security;
