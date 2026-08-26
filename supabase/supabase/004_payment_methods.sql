-- InfluencerOS 004: Agent withdrawal / payment methods (profile section).
-- Run in the SAME InfluencerOS Supabase project after 001–003.

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  method text not null check (method in ('bkash','nagad','crypto_usdt')),
  account_number text,
  account_type text check (account_type in ('agent','personal')),
  wallet_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (partner_id, method, account_number, wallet_address)
);
create index on public.payment_methods(partner_id);

revoke all on public.payment_methods from anon, authenticated;
alter table public.payment_methods enable row level security;
