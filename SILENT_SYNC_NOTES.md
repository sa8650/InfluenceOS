# InfluenceOS — Silent Background Sync (no more loading / blanking / freezing)

## What was wrong before

| Symptom you saw | Root cause in the old code |
|---|---|
| Screen turns into a spinner every few seconds | A 10-second timer re-ran the whole view, and several places (`pHelpdesk`, the helpdesk conversation pane) **unconditionally wiped `main.innerHTML` with a loader** — even during background refreshes |
| Data appears → few seconds later everything is empty + loading again | ① A second 12-second timer rebuilt the whole HelpDesk pane (even while you were typing). ② On **any** transient API error the `catch()` replaced the **entire dashboard with an error div** |
| Clicking any navigation shows a spinner and a blank screen | Every navigation re-fetched everything with a cache-buster (`?_fresh=Date.now()`) — the browser cache was disabled, so nothing could be painted instantly |
| UI feels heavy / freezes | The full page (all tables, all cards) was re-rendered via `innerHTML` every 10 seconds, even when nothing changed |
| Slow responses from the API | Every request pulled **whole tables** (`select=*`) from Supabase and computed KPIs in JavaScript — for every client, every 10 seconds |

## What it does now (the new architecture)

### Frontend — a silent *stale-while-revalidate* data layer (`assets/app.js`)

1. **Instant paint** — every screen reads from a local cache first. Navigation is
   immediate: the previous data is shown at once and refreshed silently behind it.
   The spinner only ever appears on the very **first** load of a view.
2. **Silent background refresh** — each visible data key revalidates in the
   background every ~15 s (HelpDesk: 12 s). Requests are **staggered one at a
   time** and de-duplicated (10 tabs = 1 request), so the screen never freezes.
3. **Repaint only on real change** — fresh data is compared with the current data.
   If nothing changed, the DOM is **not touched at all** (literally zero flicker,
   scroll jump or focus loss). If a value changed, only the values visibly change:
   scroll position, focused input and text-caret are preserved automatically.
4. **Never disturbed while interacting** — updates are held while you are typing in
   the view or while a modal is open, and applied the moment you finish.
5. **Errors never blank the screen** — if a background refresh fails, the last good
   data stays on screen and a small “Reconnecting…” chip appears bottom-right until
   the connection recovers. Only a first-load failure shows a message — with a
   **Retry** button.
6. **HelpDesk is now truly live** — new messages appear in the log while you type;
   your draft text can never be wiped by a refresh anymore.
7. **ConnectX never auto-refreshes** — your email draft can no longer disappear
   mid-writing.
8. Bonus fix: search/filter inputs no longer lose focus after every keystroke.

### Backend — smarter pulling, same data (`functions/api/ios/[[path]].js`)

1. **Edge SWR cache** (in the Cloudflare Pages Function, per user + path):
   - fresh answers are cached **10 s**;
   - after that the cached answer is still returned **instantly** while the cache
     refreshes in the background (up to 2 min staleness max);
   - every **mutation purges** the acting user’s cache, and the frontend always
     sends an `x-fresh: 1` header right after you change something — so **you see
     your own changes immediately**, everyone else gets them on their next silent
     cycle.
2. **One-roundtrip aggregates** — the `overview` (dashboard KPIs) and `partners`
   (agent financials) endpoints now try to compute everything **inside Postgres**
   with a single RPC call instead of downloading four whole tables and aggregating
   them in the worker. If the RPC is not installed, the old logic still runs —
   nothing can break.
3. **Agent stats are filtered in SQL** (`partner_id=in.(…)`) instead of pulling the
   full allocations/payments tables for one agent.
4. Dashboard list payloads are capped to the newest rows (allocations ≤ 300,
   payments ≤ 500) so the payload can never grow without bound.

### Optional (but recommended): one SQL migration

Run `supabase/supabase/015_fast_aggregates.sql` once in the **Supabase SQL editor**.
It creates `ios_overview()` and `ios_partner_directory()` — the two Postgres
functions the backend uses for the fast path above. Without it everything still
works (automatic fallback); with it, each background poll costs one tiny query
instead of four full-table scans.

## Deploy

1. Commit & push — Cloudflare Pages builds and deploys as usual (no new
   environment variables, no config changes needed).
2. (Optional, recommended) run `015_fast_aggregates.sql` in Supabase.

## Tuning knobs (if you ever want to)

| What | Where | Default |
|---|---|---|
| Background refresh cadence | `REFRESH_MS` in `assets/app.js` | 15 000 ms |
| HelpDesk refresh cadence | `KEY_INTERVAL` in `assets/app.js` | 12 000 ms |
| Edge cache fresh window | `EDGE_FRESH_MS` in `functions/api/ios/[[path]].js` | 10 000 ms |
| Max stale-while-revalidate age | `EDGE_STALE_MS` in `functions/api/ios/[[path]].js` | 120 000 ms |
