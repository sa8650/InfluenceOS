-- InfluencerOS 003: multi-file proofs (managed by Vaultium), short contribution
-- codes (C12345), and the agent↔admin HelpDesk chat.
-- Run in the SAME InfluencerOS Supabase project after 001 and 002.

-- Short public code per contribution request (C + 5 digits)
alter table public.contributions add column if not exists code text;
update public.contributions
   set code = 'C' || lpad((floor(random()*90000)+10000)::int::text, 5, '0')
 where code is null;
create index if not exists contributions_code_idx on public.contributions(code);

-- Multiple proof files per contribution (stored in the Vaultium R2 bucket)
create table public.contribution_files (
  id uuid primary key default gen_random_uuid(),
  contribution_id uuid not null references public.contributions(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  file_name text not null,
  file_type text,
  file_size integer not null default 0,
  r2_key text not null,
  created_at timestamptz not null default now()
);
create index on public.contribution_files(contribution_id);
create index on public.contribution_files(created_at desc);

-- Move any legacy single-proof records into contribution_files
insert into public.contribution_files (contribution_id, partner_id, file_name, file_type, file_size, r2_key, created_at)
select id, partner_id, coalesce(proof_name,'proof'), proof_type, coalesce(proof_size,0), proof_url, created_at
  from public.contributions
 where proof_url is not null
   and not exists (select 1 from public.contribution_files f where f.contribution_id = public.contributions.id);

-- One continuous agent ↔ admin conversation per agent
create table public.helpdesk_messages (
  id bigint generated always as identity primary key,
  partner_id uuid not null references public.partners(id) on delete cascade,
  sender_type text not null check (sender_type in ('agent','admin')),
  sender_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  read_by_admin boolean not null default false,
  read_by_agent boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.helpdesk_messages(partner_id, created_at);
create index on public.helpdesk_messages(read_by_admin) where read_by_admin = false;
create index on public.helpdesk_messages(read_by_agent) where read_by_agent = false;

revoke all on public.contribution_files from anon, authenticated;
revoke all on public.helpdesk_messages from anon, authenticated;
alter table public.contribution_files enable row level security;
alter table public.helpdesk_messages enable row level security;
