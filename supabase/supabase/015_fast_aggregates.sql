-- ══════════════════════════════════════════════════════════════════════════
-- 015 · FAST AGGREGATES (optional but recommended)
--
-- The dashboard now refreshes silently in the background every ~15s. These two
-- functions move the heavy KPI / financial aggregation INTO Postgres so one
-- background poll costs ONE small roundtrip instead of pulling four whole
-- tables and aggregating them in the Cloudflare Worker on every request.
--
-- The API tries these RPCs first and silently falls back to the legacy code
-- if they are not installed — so running this migration is safe but optional.
--
-- Run once in Supabase → SQL Editor.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1) Admin dashboard overview: all KPIs + project summary + upcoming payouts ──
create or replace function public.ios_overview()
returns json
language sql
security definer
set search_path = public
as $$
select json_build_object(
  'kpis', (
    select json_build_object(
      'totalPartners',       (select count(*) from partners),
      'activeProjects',      (select count(*) from projects where status = 'active'),
      'assignedTarget',      (select coalesce(sum(assigned_target), 0) from allocations),
      'acquiredUsers',       (select coalesce(sum(acquired_users), 0) from allocations),
      'totalIncome',         round((select coalesce(sum(commission), 0) from allocations)::numeric, 2),
      'totalPaid',           round((select coalesce(sum(amount), 0) from withdrawals where status = 'accepted')::numeric, 2),
      'remainingBalance',    round((
                                (select coalesce(sum(commission), 0) from allocations)
                              - (select coalesce(sum(amount), 0) from withdrawals where status = 'accepted')
                              - (select coalesce(sum(amount), 0) from withdrawals where status = 'pending')
                              )::numeric, 2),
      'overallPerformance',  case when (select coalesce(sum(assigned_target), 0) from allocations) > 0
                                  then round(
                                    (select coalesce(sum(acquired_users), 0) from allocations)::numeric
                                    / (select coalesce(sum(assigned_target), 0) from allocations) * 100)
                                  else 0 end
    )
  ),
  'projects', (
    select coalesce(json_agg(t), '[]'::json) from (
      select p.id, p.name, p.status,
             coalesce(sum(a.assigned_target), 0)  as target,
             coalesce(sum(a.acquired_users), 0)   as acquired,
             count(distinct a.partner_id)         as partners
      from projects p
      left join allocations a on a.project_id = p.id
      group by p.id, p.name, p.status, p.created_at
      order by p.created_at desc
    ) t
  ),
  'upcoming', (
    select coalesce(json_agg(t), '[]'::json) from (
      select pay.partner_id, pay.project_id, pay.payment_date, pay.amount, pay.status,
             (select name from partners where id = pay.partner_id) as partner_name,
             (select name from projects where id = pay.project_id) as project_name
      from payments pay
      where pay.status <> 'paid'
      order by pay.payment_date desc
      limit 6
    ) t
  )
);
$$;

-- ── 2) Agent directory with auto-computed financials (one roundtrip) ──
create or replace function public.ios_partner_directory()
returns json
language sql
security definer
set search_path = public
as $$
select coalesce(json_agg(t), '[]'::json) from (
  select
    p.id, p.partner_code, p.name, p.email, p.phone, p.address, p.type,
    p.accounts, p.login_access, p.status, p.note, p.created_at,
    (select count(*) from allocations a where a.partner_id = p.id) as projects,
    coalesce((
      select json_agg(distinct pr.name)
      from allocations a join projects pr on pr.id = a.project_id
      where a.partner_id = p.id
    ), '[]'::json) as project_names,
    coalesce((select sum(a.acquired_users) from allocations a where a.partner_id = p.id), 0) as acquired_users,
    round(coalesce((select sum(a.commission) from allocations a where a.partner_id = p.id), 0)::numeric, 2) as income,
    round(coalesce((select sum(w.amount) from withdrawals w where w.partner_id = p.id and w.status = 'accepted'), 0)::numeric, 2) as paid,
    round((
        coalesce((select sum(a.commission) from allocations a where a.partner_id = p.id), 0)
      - coalesce((select sum(w.amount) from withdrawals w where w.partner_id = p.id and w.status = 'accepted'), 0)
      - coalesce((select sum(w.amount) from withdrawals w where w.partner_id = p.id and w.status = 'pending'), 0)
    )::numeric, 2) as balance
  from partners p
  order by p.created_at desc
) t;
$$;

-- Keep them callable only by the service role the API uses.
revoke all on function public.ios_overview() from public, anon, authenticated;
revoke all on function public.ios_partner_directory() from public, anon, authenticated;
grant execute on function public.ios_overview() to service_role;
grant execute on function public.ios_partner_directory() to service_role;
