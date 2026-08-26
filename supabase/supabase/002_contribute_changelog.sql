-- InfluencerOS 002: Contribute requests (partner contribution workflow) + partner edit logs.
-- Run in the SAME InfluencerOS Supabase project after 001_influenceros_schema.sql.

create type public.contribution_status as enum ('pending','accepted','rejected');

create table public.contributions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  allocation_id uuid references public.allocations(id) on delete set null,
  acquired integer not null check (acquired > 0),
  note text,
  proof_url text,
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
create index on public.contributions(partner_id, created_at desc);
create index on public.contributions(project_id);
create index on public.contributions(status);

-- Admin-only audit trail of partner profile edits (made by the partner).
create table public.partner_logs (
  id bigint generated always as identity primary key,
  partner_id uuid not null references public.partners(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index on public.partner_logs(partner_id, created_at desc);


revoke all on public.contributions from anon, authenticated;
revoke all on public.partner_logs from anon, authenticated;
alter table public.contributions enable row level security;
alter table public.partner_logs enable row level security;
