# Handoff: migrating ESPN sync → Tank01 API

Status as of this session: **decided, not started**. This doc is the
handoff for whoever (human or a new Claude session) picks this up next.

## Why we're moving off ESPN

`supabase/functions/_shared/espn.ts` hits ESPN's undocumented
`site.api.espn.com` endpoint. It's currently 403ing in production (see
`sync_log` — every source fails with `HTTP 403`). We added browser-like
headers once already (commit `a4ebfb3`) which fixed an earlier round of
403s, but it's failing again. Rather than keep guessing at header tweaks
against an unofficial, undocumented API, we're switching to a real paid
API: **Tank01 NFL** (via RapidAPI).

A diagnostic change is already live (commit `2042b63`, deployed to prod
via the `main` push on 2026-09-01) that alternates between browser
headers and no headers across retries and logs which variant was used
plus a response body snippet — so `sync_log` should now show useful
403 detail if you want to look at that data point before/instead of
migrating. But the plan is to migrate regardless.

## Decision made this session

- **Provider**: Tank01 NFL (RapidAPI), **Pro plan, $10/mo, 1,000
  calls/day**. Nate is signing up; the league will reimburse him.
  (Ruled out the free plan — it's **1,000 calls/*month***, not enough
  for any kind of polling cadence.)
- **Ruled out**: Sports-Reference — they don't sell a real API, only
  the human-facing Stathead search product, and their ToS prohibits
  scraping.
- **Considered, not chosen for live scores**: nflverse/nflreadr (free,
  open, great for players/schedule) — good fit for `sync-players` /
  `sync-schedule` data, but its stats pipeline isn't live (updates
  hours after games), which doesn't fit the current live-in-game
  polling design of `sync-scores`. Worth reconsidering if we decide
  live in-game score updates aren't actually needed (see open
  questions below) — could mean a hybrid: nflverse for rosters/schedule
  (saves Tank01 calls) + Tank01 only for `sync-scores`.

## Blocked on

**Real Tank01 API responses.** This sandbox can't reach `tank01.com` or
`rapidapi.com` (both blocked by the environment's egress proxy), and
web search couldn't turn up exact response JSON shapes (field names for
team id, player id, injury status, and — critically — the per-game TD
stat fields that would replace the box-score tallying in
`sync-scores/index.ts`). Nate is getting a RapidAPI key and will bring
back real example responses next session for at least:

- `getNFLTeams` — need team id / abbreviation fields (replaces
  `getTeamIndex()` in `_shared/espn.ts`)
- `getNFLTeamRoster` (or `getNFLPlayerList`, if it returns the whole
  league in one call — would save a lot of quota vs. one call/team) —
  need player id, name, position, team, injury status fields (replaces
  `getTeamRoster()`)
- `getNFLGamesForWeek` — need kickoff time, team ids per game (replaces
  `getScoreboard()`)
- `getNFLBoxScore` (or possibly `getNFLGamesForPlayer` — unclear which
  is the right one for per-player per-game TD counts) — need the exact
  field names for passing/rushing/receiving TDs per player (replaces
  the `boxscore.players[].statistics[]` parsing in
  `sync-scores/index.ts`'s `tallyGame()`)

**Do not build the new `_shared/tank01.ts` against guessed field names.**
The whole reason we're moving off ESPN is an unvalidated-assumption
problem (see the "Parsing approach" comment at the top of
`sync-scores/index.ts` — the ESPN box-score shape was never confirmed
against a live response either). Get real JSON first.

## RESOLVED — cadence + call budget (this session)

Nate's call: **keep live in-game polling, but only in game-day windows,
at 30-minute intervals** (rather than every 10 minutes, all week).

`supabase/migrations/0004_cron.sql` has been rewritten to match. Note
these two corrections made while implementing it:

- **Monday Night Football was missing** from the originally-stated
  Thu/Sat/Sun windows. MNF is a weekly regular-season fixture, so a
  Thu/Sat/Sun-only schedule would have silently dropped every
  Monday-night TD. It is now covered.
- **pg_cron runs in UTC**, and every NFL night game runs past midnight
  UTC — so night games land on the *next* UTC day. The windows account
  for this explicitly (TNF shows up as a Friday-UTC job, SNF as a
  Monday-UTC job, MNF as a Tuesday-UTC job). The header comment in
  `0004_cron.sql` has the full mapping; read it before editing those
  schedules.

The bigger budget find: **`sync-players` was the real problem, not
`sync-scores`.** It makes 1 team-index call + 1 call per team (32) per
run, so at its old `*/20` cadence it was ~2,376 calls/day on its own —
more than double the entire 1,000/day Pro allowance. Now every 6 hours
(~132/day). `sync-schedule` dropped to every 12h. `sync-scores` is now
76 runs/week, busiest UTC day 32 runs. `apply-locks` is DB-only (no
external API calls), so it stays at every 5 minutes for free.

These numbers still assume ESPN's one-call-per-game/per-team shape. If
Tank01 exposes a whole-league player list or a whole-week boxscore in
one call, there is a lot of headroom to tighten cadences back up.

## Still unresolved — remaining budget questions

Current cron (`supabase/migrations/0004_cron.sql`):
- `sync-players` every 20 min → ~2,160 calls/month
- `sync-schedule` every 30 min → ~1,440 calls/month
- `sync-scores` every 10 min, and **today it makes one ESPN call per
  in-progress game per run** (up to ~16 games) → could be 10,000+
  calls/month as-is

At 1,000 calls/**day** (Pro plan), the day-of-week distribution matters
more than the raw monthly number — Sundays will dominate. Rough budget
math needs to happen once we know:
1. Whether `getNFLBoxScore` (or equivalent) can return **all of that
   week's games in one call**, vs. one call per game like ESPN's
   `summary?event=` does today. This alone determines whether every-10-
   min score polling is affordable.
2. Whether `getNFLTeamRoster`/`getNFLPlayerList` can return the **whole
   league in one call** instead of one call per team (32 calls today).

Also still open from earlier in this conversation: **is live in-game
score updating actually a feature people use**, or is it fine for TD
tallies to finalize a few hours after each week's games end? If the
latter, `sync-scores` cadence can drop dramatically (e.g. run once a
few hours after the last Sunday/Monday game, not every 10 minutes),
which changes both the Tank01 call budget and reopens whether nflverse
is viable for scores too.

## Known re-keying cost

Tank01 almost certainly uses its own player/team IDs, different from
ESPN's athlete ids currently stored as `players.id` and referenced by
`roster_picks.player_id` and `player_stage_stats.player_id`. This is a
real migration (new IDs, need a mapping/backfill strategy for existing
`roster_picks` rows tied to old ESPN ids), not just a fetch-layer swap.
Plan for this explicitly once we see the real ID format Tank01 uses —
don't discover it mid-migration.

## Suggested next steps (in order)

1. Nate brings back real Tank01 API responses (or a working RapidAPI
   key) for the four endpoints listed above.
2. ~~Decide the live-vs-finalized-after-games question for `sync-scores`
   cadence.~~ **DONE** — live polling kept, 30-min game-day windows;
   `0004_cron.sql` rewritten. nflverse stays out of scope for now, but
   remains the fallback if Tank01's per-call shape turns out to be
   expensive.
3. Design the ID re-keying approach for `players` /`roster_picks` /
   `player_stage_stats` before writing migration SQL.
4. Write `supabase/functions/_shared/tank01.ts` (parallel structure to
   `_shared/espn.ts`: `fetchJson` helper + typed endpoint wrappers),
   validated against the real responses from step 1 — not guessed.
5. Rewire `sync-players`, `sync-schedule`, `sync-scores` to the new
   helpers; delete `_shared/espn.ts` and the box-score tallying
   comments that no longer apply.
6. Update `supabase/functions/README.md` (currently all ESPN-specific)
   and `supabase/migrations/0004_cron.sql` cadence/comments.
7. Add `RAPIDAPI_KEY` (or whatever Tank01's auth header needs) via
   `supabase secrets set`, update
   `supabase/functions/README.md`'s "Env vars / secrets required"
   section.
8. Re-test all three sync buttons on the commish page end-to-end
   (see `src/components/commish/SyncPanel.tsx`) and confirm `sync_log`
   shows real success rows before considering this done.
