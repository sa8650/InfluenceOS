-- InfluenceOS — ConnectX default sender name update
-- Run after 011_connectx.sql for existing installations.

alter table public.connectx_settings alter column from_name set default 'InfluenceOS';
update public.connectx_settings
set from_name = 'InfluenceOS', updated_at = now()
where id = 1 and (from_name is null or from_name = 'DoxTox ConnectX');
