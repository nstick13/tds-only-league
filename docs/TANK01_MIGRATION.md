# Handoff: migrating ESPN sync → Tank01 API

Status: **planned, not started.** The endpoint inventory and call budget
below are settled; what's still missing is real response JSON (see
"Still blocked on"). This doc is the handoff for whoever — human or a new
Claude session — picks it up next.

## Why we're moving off ESPN

`supabase/functions/_shared/espn.ts` hits ESPN's undocumented
`site.api.espn.com` endpoint. It's currently 403ing in production (see
`sync_log` — every source fails with `HTTP 403`). We added browser-like
headers once already (commit `a4ebfb3`) which fixed an earlier round of
403s, but it's failing again. Rather than keep guessing at header tweaks
against an unofficial, undocumented API, we're switching to a real paid
API: **Tank01 NFL** (via RapidAPI).

A diagnostic change is live (commit `2042b63`) that alternates between
browser headers and no headers across retries and logs which variant was
used plus a response body snippet. Useful signal if anyone wants it, but
the plan is to migrate regardless.

## Provider decision

- **Tank01 NFL (RapidAPI), Pro plan, $10/mo, 1,000 calls/day.** Nate is
  subscribing; the league reimburses him. (The free plan is 1,000
  calls/*month* — not enough for any polling cadence.)
- **Ruled out**: Sports-Reference — no real API, only the human-facing
  Stathead product, and their ToS prohibits scraping.
- **Considered for the non-live data**: nflverse/nflreadr (free, open).
  Its stats pipeline updates hours after games, so it can't back live
  scoring — but see "Budget" below; with Tank01's league-wide endpoints
  the quota is comfortable enough that a hybrid isn't needed. Keep
  nflverse in the back pocket if the budget ever gets tight.

## Endpoints Tank01 actually offers

Confirmed from the RapidAPI endpoint list (2026-09-01):

| Endpoint | Use for us |
| --- | --- |
| Get NFL Teams | team id/abbr index — replaces `getTeamIndex()` |
| Get NFL Team Roster | per-team roster (32 calls) — **fallback only** |
| Get Player List | **whole-league player list, likely 1 call** — preferred for `sync-players` |
| Get Player Information | single-player lookup; useful for ID cross-reference |
| NFL Injury List | **league-wide injuries in 1 call** — splits injury refresh off `sync-players` |
| Get Weekly NFL Schedule | that week's games — replaces `getScoreboard()` for `sync-schedule` |
| Get NFL Team Schedule | per-team schedule; not needed if weekly works |
| Get Daily Scoreboard - Live | which games are live/final right now — the **cheap poll** that gates box-score calls |
| Get NFL Game Box Score - Live | **per-player TD stats per game** — replaces `getGameSummary()` in `sync-scores` |
| Get General Game Information | game metadata; probably not needed |
| Get Inactive Players by Game Week | optional lineup-validity nicety |
| Get NFL Depth Charts | not needed for TD-only |
| Get Fantasy Point Projections | not needed — we score actuals, not projections |
| Get ADP | not needed — we snake-draft weekly, ADP is irrelevant |
| DFS Salaries | not needed |
| Get NFL Betting Odds | not needed |
| Top News and Headlines | not needed |
| Get Changelog | not needed |

Only **six** of these matter: Teams, Player List, Injury List, Weekly
Schedule, Daily Scoreboard, Box Score.

## Scoping: how much data do we actually need?

The league is much smaller than "all of the NFL," and the budget math
turns on that:

- 8 managers × 6 roster slots (QB1/RB2/WR2/TE1, see `src/lib/roster.ts`)
  = **48 rostered players per stage**, and `roster_picks`'
  `unique(stage_id, player_id)` makes them 48 *distinct* players.
- Those 48 sit on at most 32 NFL teams → at most **16 games** in a week.

Two consequences:

1. **Player-team scoping saves less than it looks.** 48 players spread
   across ~20–28 distinct teams, so on a full Sunday most games contain
   somebody. Worth filtering (it genuinely helps in the thin late/SNF
   windows), but it is not the main lever.
2. **Game-state scoping is the main lever.** Today `sync-scores` fetches
   *every* game in the week on *every* run, including games that finished
   three days ago. Polling only games that are actually in progress —
   and fetching a finished game exactly once more, then never again — is
   what makes the quota comfortable.

So the rule for the new `sync-scores` is:

> One cheap Daily Scoreboard call per run to learn game states. Then a
> box-score call only for games that are (a) in progress or newly final,
> **and** (b) contain at least one player on someone's roster this stage.

## Call budget at 1,000/day

Assumes worst-case Sunday: ~9 early games, ~4 late, 1 SNF, live window
~1:00pm–11:30pm ET, polling every 5 minutes.

**Scores (Sunday):**

| Window | Hours | Live games | Polls (12/hr) | Calls |
| --- | --- | --- | --- | --- |
| Scoreboard poll | 10.5 | — | 126 | 126 |
| Early (1:00–4:15) | 3.25 | ~9 | 39 | ~351 |
| Late (4:05–7:45) | 3.7 | ~4 | 44 | ~178 |
| SNF (8:20–11:30) | 3.2 | 1 | 38 | ~38 |
| | | | **Total** | **~693** |

**Everything else (every day):**

| Job | Cadence | Calls/day |
| --- | --- | --- |
| Player list | 2×/day | 2 |
| Injury list | every 30 min | 48 |
| Weekly schedule | every 3 hours | 8 |
| | **Total** | **58** |

**Worst-case Sunday ≈ 751 calls. Other days ≈ 58.** That fits inside
1,000/day with ~250 headroom, at a *tighter* cadence than today's
10-minute one.

Compare to today's cron, which would be catastrophic on this plan:
`sync-players` alone is 32 calls × 72 runs/day = **2,304 calls/day**.
Fixing that (league-wide Player List instead of per-team rosters, plus a
sane cadence) is most of the win.

The 693 number depends on box score being one call per game. If a real
response shows Daily Scoreboard can return per-player TDs directly (some
Tank01 endpoints take a `topPerformers`-style flag), scores collapse to
~126 calls/day and we could poll every minute. **Verify this before
building** — it's the single biggest budget question left.

### Guardrail

Add a `api_call_log` table (or a counter row) and have `_shared/tank01.ts`
increment it per request, refusing to start a run that would cross a
configured daily ceiling (say 900). Getting 429'd at 3pm on a Sunday with
no idea why is exactly the failure mode this migration is supposed to end.
Log the running count to `sync_log` so the staleness UI can surface it.

## The ID re-keying problem

Tank01 uses its own `playerID`, different from the ESPN athlete ids
currently stored as `players.id` and referenced by `roster_picks.player_id`
and `player_stage_stats.player_id`. Both reference it with real FKs, and
`roster_picks` may already hold drafted rows — so this is a data
migration, not just a fetch-layer swap.

**The thing to check first:** Tank01's player endpoints are widely
reported to include cross-reference ids (`espnID`, `sleeperBotID`,
`fantasyProsPlayerID`, …) alongside their own `playerID`. If `espnID` is
present in the Player List response, the re-key is mechanical:

1. Pull the full Tank01 player list once, build `espnID → playerID`.
2. Add `players.tank01_id`, backfill via that map.
3. Repoint the FKs to the new id (or keep `players.id` as the stable
   internal key and just store `tank01_id` alongside — **preferred**,
   since it avoids touching `roster_picks` at all and leaves room for a
   future provider swap).

Option 3 is the recommendation: stop treating a vendor's id as our
primary key. Make `players.id` internal, carry `espn_id` and `tank01_id`
as nullable lookup columns, and match on those in the sync jobs.

If `espnID` is *not* in the response, fall back to fuzzy
(name, position, team) matching — with a hard requirement that any
unmatched player already referenced by `roster_picks` fails the migration
loudly rather than silently orphaning someone's drafted roster.

## Still blocked on

**Real Tank01 response JSON.** This sandbox can't reach `rapidapi.com` or
`tank01.com` (egress proxy blocks both), so field names cannot be
confirmed from here. Before writing `_shared/tank01.ts`, capture one real
response for each of:

- **Get Player List** — does it return the whole league in one call? does
  it include `espnID`? what are the position/team field names?
- **NFL Injury List** — player id field, injury status vocabulary (so
  `normalizeStatus()` can be rewritten against real values, not ESPN's).
- **Get Weekly NFL Schedule** — game id, kickoff timestamp format, the
  two team ids per game (drives `first_kickoff_at` and bye detection).
- **Get Daily Scoreboard - Live** — the **game status field and its exact
  values** (in-progress vs final). The whole polling design hangs on this.
- **Get NFL Game Box Score - Live** — the per-player passing/rushing/
  receiving TD field names. This replaces `tallyGame()` and is the one
  place a wrong guess silently produces wrong scores instead of an error.

**Do not build against guessed field names.** The reason we're leaving
ESPN is an unvalidated-assumption problem — the ESPN box-score shape in
`sync-scores/index.ts` was never confirmed against a live response either
(see the "Parsing approach" comment there). Get real JSON first.

Easiest capture: hit each endpoint once in the RapidAPI playground with
the Pro key and save the response bodies into `reference/tank01-samples/`.
That directory then doubles as fixtures for parser tests.

## Also worth settling

**Is live in-game scoring actually a feature people use?** If TD tallies
finalizing a few hours after each week's games is acceptable, `sync-scores`
drops from ~693 Sunday calls to about a dozen, and nflverse re-enters as a
free option. Nate should make this call — it changes the design
materially. The budget above assumes yes, live matters.

## Step order

1. **Capture real responses** for the five endpoints above into
   `reference/tank01-samples/`. Everything else is blocked on this.
2. **Answer the live-scoring question** — determines cadence and whether
   the polling design is even needed.
3. **Decide the ID strategy** from what the Player List response actually
   contains (recommendation: internal `players.id` + `espn_id`/`tank01_id`
   lookup columns; migration SQL written before any function is rewired).
4. **Write `supabase/functions/_shared/tank01.ts`** — same shape as
   `_shared/espn.ts` (`fetchJson` + timeout/retry/concurrency helpers +
   typed endpoint wrappers), plus the RapidAPI auth headers
   (`x-rapidapi-key`, `x-rapidapi-host`) and the call-budget counter.
   Validate against the saved fixtures.
5. **Rewire the jobs:**
   - `sync-players` → Get Player List (1 call), drop the 32-call loop.
   - **New `sync-injuries`** → NFL Injury List (1 call), split out so
     injury freshness doesn't require re-pulling the whole player pool.
   - `sync-schedule` → Get Weekly NFL Schedule.
   - `sync-scores` → Daily Scoreboard gate + box score only for
     in-progress/newly-final games containing rostered players.
6. **Update `0004_cron.sql`** to the cadences in the budget table, and add
   the new `sync-injuries` job.
7. **Set the RapidAPI secret**: `supabase secrets set RAPIDAPI_KEY=…`, and
   update the "Env vars / secrets required" section of
   `supabase/functions/README.md` (currently all ESPN-specific).
8. **Delete `_shared/espn.ts`** and the stale ESPN parsing comments.
9. **End-to-end test** all sync buttons on the commish page (see
   `src/components/commish/SyncPanel.tsx`) and confirm `sync_log` shows
   real success rows — plus one manual cross-check of a real game's TD
   tallies against a known box score — before calling this done.

Steps 4–9 are a straight shot once steps 1–3 are answered. Step 1 is the
only thing that needs Nate.
