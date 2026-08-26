-- InfluencerOS 005: Agent withdrawal requests.
-- Run in the SAME InfluencerOS Supabase project after 001–004.

create type public.withdrawal_status as enum ('pending','accepted','rejected');

create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  method text not null check (method in ('bkash','nagad','crypto_usdt')),
  account_type text,
  account_number text,
  wallet_address text,
  amount numeric(14,2) not null check (amount > 0),
  provider_number text,
  trx text,
  status public.withdrawal_status not null default 'pending',
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.withdrawals(partner_id, created_at desc);
create index on public.withdrawals(status);

revoke all on public.withdrawals from anon, authenticated;
alter table public.withdrawals enable row level security;
