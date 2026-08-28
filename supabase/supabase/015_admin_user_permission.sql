-- ══════════════════════════════════════════════════════════════════════════
-- 015 · ADMIN USER PERMISSIONS (run once in Supabase → SQL Editor)
--
-- Adds a per-board-user permission matrix. The primary administrator (owner)
-- always keeps full access and is NOT stored here — permissions only apply to
-- board users created in User Control.
--
-- Modules & actions (as shown in the Add/Edit user permission box):
--   agents:       show, add, edit, delete
--   projects:     show, add, edit, delete
--   contribute:   show, edit   (edit = accept / reject contribution requests)
--   allocations:  show, add, edit, delete
--   payments:     show, add, edit, delete (edit = withdraw accept / reject)
--   performance:  show
--   vaultium:     show, delete, download, view (view = file View button)
--   connectx:     show, compose, settings, history
--   users:        show, add, edit, delete
--
-- "show" off  → the navigation button and page are hidden for that user.
-- Missing keys count as DENIED, so existing board users get no access until
-- the owner grants it in User Control → Edit user.
-- ══════════════════════════════════════════════════════════════════════════

alter table public.admin_users
  add column if not exists permissions jsonb not null default '{}'::jsonb;

comment on column public.admin_users.permissions is
  'Per-module action permissions for board users, e.g. {"agents":{"show":true,"add":true}}. Owner is never restricted.';
