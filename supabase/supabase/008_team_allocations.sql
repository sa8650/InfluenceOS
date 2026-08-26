-- InfluencerOS 008: Agent team allocations (agent assigns own projects to team members).
-- Run in the SAME InfluencerOS Supabase project after 001–007.

create table public.team_allocations (
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
create index on public.team_allocations(partner_id, created_at desc);
create index on public.team_allocations(team_member_id);

revoke all on public.team_allocations from anon, authenticated;
alter table public.team_allocations enable row level security;
