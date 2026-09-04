# Architecture

This document is for feature agents building on top of the foundation.
Read it before adding tables, routes, or conventions of your own.

## Data model

All tables live in the `public` schema, defined in
`supabase/migrations/0001_core.sql` (tables + seed data),
`supabase/migrations/0002_functions.sql` (triggers/helper functions), and
`supabase/migrations/0003_rls.sql` (Row Level Security policies).

| Table | Purpose |
| --- | --- |
| `profiles` | One row per authenticated user (mirrors `auth.users`). Carries `is_commissioner`, `is_player`, and `manager_slot` (1–8) — the whole roles model lives here. Auto-created by the `handle_new_user()` trigger on signup. |
| `stages` | Every draftable stage: Weeks 1–18 + 4 postseason rounds (22 rows, seeded once). `ordinal` is draft/display order; `status` (`upcoming` → `draft_open` → `locked` → `finalized`) gates roster-write RLS and drives what the UI shows. **Client code must read the stage list from this table — never hardcode stages.** |
| `players` | League-wide player pool synced from ESPN (`id` = ESPN athlete id, kept as `text`). Refreshed by an Edge Function sync job (not yet built). |
| `draft_order` | Overall snake-draft pick order for a stage (48 picks = 8 managers × 6 rounds). Order-generation logic is a later agent's job — this table just stores `(stage_id, pick_number) -> manager_id`. |
| `roster_picks` | The drafted roster: one row per player a manager holds in a stage. `unique(stage_id, player_id)` enforces the exclusive league-wide player pool per stage. The `enforce_roster_limits()` trigger enforces the QB1/RB2/WR2/TE1/6-total roster shape per manager per stage. |
| `player_stage_stats` | Raw TD counts per player per stage (synced from ESPN box scores). `points` is a generated column computed from the scoring rule — never write it directly. |
| `weekly_results` | Computed per-manager stage totals/standings, written by a later agent's scoring job (aggregates `roster_picks` × `player_stage_stats`). Not computed live on every read. |
| `sync_log` | Append-only log of sync job runs (`source`, `status`, `message`, `player_count`, `ran_at`). Backs the app-wide data-freshness line (`DataFreshness`) — query the latest SUCCESSFUL row per `source` and show "last updated X ago" instead of silently trusting data age. Stated plainly, not as an alarm: the old red flashing banner was replaced because a warning on every page becomes wallpaper. |

## Roles model

- **Commissioner** (`profiles.is_commissioner`): can write `stages`,
  `players`, `draft_order`, `player_stage_stats`, `weekly_results`,
  `sync_log`, and can insert/update/delete *any* `roster_picks` row
  regardless of stage status (post-lock manual corrections). New accounts
  default to `is_commissioner = false`; flipping it to `true` is a manual
  action (Supabase Studio Table Editor, or a future admin UI) — there is no
  self-service "become commissioner" flow.
- **Player / manager** (`profiles.is_player` + `profiles.manager_slot`):
  can insert/delete only their *own* `roster_picks` rows, and only while
  the relevant stage's `status = 'draft_open'`.
- **Auto-first-8-slots rule**: the `handle_new_user()` trigger
  (`supabase/migrations/0002_functions.sql`) automatically assigns the
  lowest free `manager_slot` (1–8) and sets `is_player = true` to each of
  the first 8 signups system-wide (excluding accounts a commissioner has
  since promoted — the trigger only looks at how many slots are currently
  taken, not signup order after manual edits). The 9th+ signup gets a
  `profiles` row but no slot; a commissioner assigns a slot manually if a
  seat later opens up (e.g. via Supabase Studio or a future admin UI).
- Both flags are independent — an account can be a commissioner and a
  player, one but not the other, or neither.
- `SUPABASE_SERVICE_ROLE_KEY` (server-only) bypasses RLS entirely. Edge
  Function sync jobs use it and do not need a commissioner-flagged user.

## Conventions later agents must follow

- **All persistent state flows through Supabase.** No `localStorage` (or
  any other client-only store) as a source of truth for league data —
  it's fine for pure UI state (e.g. an open modal), never for anything
  that must be shared across the 8 managers or survive a refresh.
- **File layout**: App Router pages/routes under `src/app/`; shared React
  UI in `src/components/` (`src/components/ui/` = generic retro primitives,
  feature components get their own subfolder e.g. `src/components/draft/`);
  non-component logic in `src/lib/` (`src/lib/supabase/` = Supabase
  clients, `src/lib/scoring.ts` / `src/lib/roster.ts` = shared constants).
  Follow this shape rather than inventing a new one.
- **Naming**: SQL identifiers are `snake_case`; TypeScript is
  `camelCase`/`PascalCase` per normal conventions. Migration files are
  numbered and self-contained (`NNNN_description.sql`) so a whole file can
  be pasted into the Supabase Studio SQL editor and run top-to-bottom —
  keep that property when adding new migrations (guard `create table`
  with `if not exists`, `create trigger` with a preceding `drop trigger if
  exists`, etc., the way `0001`–`0003` do).
- **Scoring/roster constants**: centralized in `src/lib/scoring.ts`
  (`computePoints`, pass/rush/rec point values) and `src/lib/roster.ts`
  (`ROSTER_SHAPE`, `ROSTER_SIZE`, `POSITIONS`). Import from there instead
  of re-declaring `0.5` / `1.0` / position caps elsewhere. The DB mirrors
  these in `player_stage_stats.points` (generated column) and the
  `enforce_roster_limits()` trigger — if the scoring/roster rules ever
  change, update all three places together.
- **Stage list is DB-driven.** Query `stages` ordered by `ordinal`; do not
  hardcode a stage list in the client (see the `stages` row in the table
  above).
- **Realtime channels**: not yet wired up (no feature agent has built the
  live draft board yet). When you do, name channels
  `draft:{stage_id}` for per-stage draft-pick broadcast (mirrors the old
  prototype's single WebSocket broadcast, but scoped per stage instead of
  global) so multiple stages' draft rooms don't cross-talk. Broadcast
  `roster_picks` inserts/deletes on that channel via Supabase Realtime's
  Postgres Changes or Broadcast API — pick one approach and document it
  when you build it.
- **ESPN sync jobs live in `supabase/functions/`** (Deno Edge Functions,
  deployed via the Supabase CLI). This foundation only created a
  `.gitkeep` placeholder there — no sync job exists yet. A sync function
  should call the ESPN endpoints referenced in
  `reference/legacy-prototype/index.html`
  (`site.api.espn.com/apis/site/v2/sports/football/nfl/...` — scoreboard,
  teams, team rosters), upsert into `players` / `player_stage_stats`, and
  write a row to `sync_log` on every run (success or error) so the UI can
  show staleness.
- **RLS is the authorization boundary**, not client-side checks. Every
  table has RLS enabled (`supabase/migrations/0003_rls.sql`); write new
  policies rather than relying on hiding UI. Use the `public.is_commissioner(uid)`
  security-definer helper in new policies rather than re-deriving the
  commissioner check inline.
- **Design system**: use `src/components/ui/` primitives
  (`PixelButton`, `PixelPanel`, `Badge`, `ScoreDisplay`) and the Tailwind
  tokens in `tailwind.config.ts` (`retro.*` colors, `font-pixel` /
  `font-mono`, `shadow-pixel`, zero border radius) rather than introducing
  new ad-hoc styling. Add new primitives to that folder if a pattern
  repeats across features.
