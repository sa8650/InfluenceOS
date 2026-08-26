-- InfluencerOS 007: Allocation categories (views/sales/users/shares/reach/profit/...)
-- Run in the SAME InfluencerOS Supabase project after 001–006.

alter table public.allocations add column if not exists category text not null default 'users';

-- An agent can have multiple allocations on the same project, but only one per category.
alter table public.allocations drop constraint if exists allocations_project_id_partner_id_key;
alter table public.allocations drop constraint if exists allocations_project_partner_key;
alter table public.allocations
  add constraint allocations_project_partner_category_key unique (project_id, partner_id, category);

create index if not exists allocations_category_idx on public.allocations(category);
