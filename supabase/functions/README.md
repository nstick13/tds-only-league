# Tank01 sync Edge Functions

Four Deno Edge Functions that keep `players`, `player_stage_stats`, and `stages`
in sync with ESPN's unofficial site API, plus shared helpers in `_shared/`. See
`docs/ARCHITECTURE.md` for the table shapes and the "loud staleness" convention
(`sync_log`) these all write to.

## Functions

### `sync-players`

Fetches the 32-team index (`/teams?limit=32`), then every team's roster
(`/teams/{id}/roster`), batched at concurrency 5 with a short pause between
batches. Upserts QB/RB/WR/TE athletes into `players` — id, name, position,
nfl_team/nfl_team_id, and injury status/status_detail parsed from the athlete's
`injuries[]` array on that same roster response (default `Active` when absent).
Because injuries live on the roster endpoint, this one job covers **both** the
initial roster pull and the ongoing injury-status refresh — there's no separate
injury-only job.

Refuses to upsert (logs a `sync_log` error instead) if: more than half the 32
team-roster fetches fail, or the total parsed player count is below a
plausibility floor (200 — see the `MIN_PLAUSIBLE_PLAYER_COUNT` constant in
`sync-players/index.ts`). This is the fix for the legacy prototype's silent
fallback to a stale hardcoded player list on a thin fetch.

### `sync-schedule`

For the current/target stage (see "Current stage selection" below), fetches
`/scoreboard?week=&seasontype=` for that stage and:

- writes the earliest event kickoff across the week to `stages.first_kickoff_at`
- computes which of the 32 NFL teams have no game that week and sets
  `players.on_bye = true` for their players, `false` for everyone else

Aborts (logs error) if the scoreboard has zero events for that week, rather than
writing a null/misleading kickoff time or clearing every bye flag.

### `sync-scores`

For the current/target stage, lists that week's event ids from the scoreboard,
fetches every game's `summary?event={id}` at concurrency 4, and tallies
`pass_td` / `rush_td` / `rec_td` per ESPN athlete id — **this is the fix for the
legacy bug** where scores were read from the scoreboard's `leaders` array (only
each game's top few performers per stat), which silently missed touchdowns
scored by anyone else. See the long comment at the top of `sync-scores/index.ts`
for the full parsing writeup; summary:

> **Parsing approach.** We read `boxscore.players[].statistics[]` — the full
> per-athlete box score (passing/rushing/receiving categories, each with a
> `labels` array naming its columns and an `athletes[]` array with a parallel
> `stats[]` array of values) — rather than text-parsing `scoringPlays`. We find
> the `"TD"` column index in each of the passing/rushing/receiving categories
> and read that athlete's count directly. Every athlete who recorded any stat in
> a category has a row, not just leaders, so this structurally fixes the
> missed-TD bug. It also sidesteps the "does a passing TD's scoring-play text
> credit both the QB and the receiver" ambiguity: the QB's passing-TD count and
> the receiver's receiving-TD count are already separate, correctly-attributed
> numbers in the box score — no play-text parsing/regex needed. `scoringPlays`
> itself is left unparsed. **This was not validated against a live ESPN response
> in this environment** (outbound fetches to espn.com are blocked in this
> sandbox) — the shape is taken from the commonly-observed/documented `summary`
> endpoint structure used by several open-source ESPN API wrappers. **Before
> relying on this in production, fetch one real `summary?event={id}` for a
> completed game and confirm `boxscore.players[].statistics[].labels` actually
> contains `"TD"` for the passing/rushing/receiving categories, and that the
> per-athlete `stats` array lines up positionally** — see "Manual verification"
> below.

Only upserts athletes that already exist in `players` (skips unknown ids —
`sync-players` is the source of truth for the player pool; the response reports
how many were skipped). If any individual game summary fetch fails, the run
still upserts whatever it got from the games that succeeded, but logs a
`sync_log` **error** row naming how many games failed — never silently reports
success on partial data.

### `apply-locks`

Reads `stages` where `status = 'draft_open'` and `first_kickoff_at` is set and
has passed, and flips them to `'locked'`. This automates the "rosters lock at
first kickoff" rule server-side, independent of anyone having the app open.
Idempotent — safe to run as often as you like.

## Current-stage selection (`sync-schedule`, `sync-scores`)

Both accept an optional JSON body `{ "stage_id": <number> }`:

- **If `stage_id` is given**, that exact stage is used (no status filtering —
  lets a commissioner manually re-run a past/future week).
- **Otherwise**, the target is the lowest-`ordinal` stage whose status is
  `draft_open` or `locked` (the stage currently "in progress").
- **If none of those exist** (before Week 1 opens, or right after a stage
  finalizes before the next one opens), falls back to the lowest-`ordinal` stage
  with status `upcoming`.
- If neither query returns a row (e.g. the whole season is finalized), the
  function throws and logs a `sync_log` error rather than guessing.

See `_shared/stage.ts` for the implementation.

## Env vars / secrets required

Every function needs, at minimum:

- `RAPIDAPI_KEY` — the Tank01 NFL (RapidAPI) key. Without it every sync job
  fails fast with an explicit error rather than silently syncing nothing.
- `TANK01_SEASON` — _optional_. Overrides the season year the sync jobs ask for.
  Normally derived from the clock by `currentSeason()` in `_shared/stage.ts`,
  which correctly treats January playoffs as belonging to the previous year's
  season. Set this only when backfilling a past season.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — used to bypass RLS for these system-level sync
  writes (see `docs/ARCHITECTURE.md`, "Roles model"). **Never** the anon key.

Set them with:

```sh
supabase secrets set RAPIDAPI_KEY=<rapidapi-key>
supabase secrets set SUPABASE_URL=https://<PROJECT_REF>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are also auto-injected by the
Supabase platform into every deployed Edge Function's environment, so explicit
`secrets set` calls for these two are usually redundant in production — but set
them for local `supabase functions serve` testing.)

## Deploying

```sh
supabase functions deploy sync-players
supabase functions deploy sync-schedule
supabase functions deploy sync-scores
supabase functions deploy apply-locks
```

These are cron-invoked system jobs, not user-facing endpoints, so deploy with
JWT verification disabled (otherwise every cron POST needs a valid Supabase auth
JWT, not just the service role key as bearer):

```sh
supabase functions deploy sync-players --no-verify-jwt
supabase functions deploy sync-schedule --no-verify-jwt
supabase functions deploy sync-scores --no-verify-jwt
supabase functions deploy apply-locks --no-verify-jwt
```

If you'd rather keep JWT verification on, pass the service role key as the
`Authorization: Bearer` header when invoking (which the `0004_cron.sql` jobs
already do) — Supabase accepts the service role key as a valid JWT for this
purpose either way, so `--no-verify-jwt` is a convenience, not a requirement.

## Invoking manually (testing)

```sh
# Any function, no body needed except sync-schedule/sync-scores which take
# an optional stage_id override:
curl -i -X POST \
  "https://<PROJECT_REF>.supabase.co/functions/v1/sync-players" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json"

curl -i -X POST \
  "https://<PROJECT_REF>.supabase.co/functions/v1/sync-scores" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"stage_id": 3}'
```

Locally: `supabase functions serve sync-players --env-file .env.local` then
`curl -i -X POST http://localhost:54321/functions/v1/sync-players -H "Authorization: Bearer <local-anon-or-service-key>"`.

Every invocation writes a row to `sync_log` (success or error) — check it after
a manual run:

```sql
select * from sync_log order by ran_at desc limit 10;
```

## How the Tank01 parsing is verified

The ESPN version of this code was written against field names nobody had ever
seen in a live response, which is what eventually broke it. That is not repeated
here.

Real captured responses for all five endpoints live in `reference/tank01/`,
trimmed but structurally untouched. The parser tests in
`_shared/__tests__/tank01_test.ts` load those files directly rather than
hand-written fixtures, so they assert against payloads the API actually returned
— including that a defensive return TD and a kick-return TD both contribute
zero, since this league scores passing, rushing and receiving touchdowns only.

Run them with:

```sh
deno test --allow-read --allow-env supabase/functions/_shared/__tests__/
```

Typechecking the functions themselves needs an import map if your network blocks
`esm.sh`; otherwise `deno check supabase/functions/<fn>/index.ts`.

### Known gap: postseason stages are not addressed yet

We never captured a playoff-week response, so the Tank01 `seasonType` value and
week numbering for Wild Card / Divisional / Conference / Super Bowl are
unconfirmed. Those four `stages` rows therefore ship with `season_type` and
`week_num` set to NULL, and `sync-schedule` / `sync-scores` return HTTP 422 and
log a `sync_log` error for them rather than fetching a guessed week.

`supabase/migrations/0005_tank01_stage_addressing.sql` contains the exact curl
to confirm the real values and the four `UPDATE` statements to finish the job.

## Scheduling

Two options — pick one:

1. **`supabase/migrations/0004_cron.sql`** — `pg_cron` + `pg_net` jobs that POST
   to each function on an interval (sync-players every 20 min, sync-schedule
   every 30 min, sync-scores every 10 min, apply-locks every 5 min). Requires
   filling in `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>` placeholders before
   running — see the comment block at the top of that file for exactly what to
   fill in and why not to commit the filled-in version.
2. **Supabase Dashboard → Edge Functions → select a function → Cron tab** — set
   an interval directly in the UI, no SQL/secrets-in-SQL-editor needed. Simpler
   if `pg_cron`/`pg_net` are unavailable or fiddly on your plan.

Either way, `apply-locks` running independently of `sync-schedule` means rosters
lock even if the schedule sync is briefly stale, as long as `first_kickoff_at`
was written by a previous `sync-schedule` run.
