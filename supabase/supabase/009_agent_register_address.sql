-- InfluencerOS 009: Agent self-registration + address field.
-- Run in the SAME InfluencerOS Supabase project after 001–008.

alter table public.partners add column if not exists address text;

-- Allow Telegram as an agent type (matches team member types)
alter type public.partner_type add value if not exists 'telegram';
