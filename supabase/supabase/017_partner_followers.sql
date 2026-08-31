-- 017: follower counts on agents (portfolio allocation KPI + profile display)
alter table public.partners
  add column if not exists followers integer not null default 0;

-- Backfill existing rows explicitly (default covers new ones).
update public.partners set followers = 0 where followers is null;
