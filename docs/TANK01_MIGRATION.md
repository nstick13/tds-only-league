# Handoff: migrating ESPN sync → Tank01 API

Status: **planned, not started.** The endpoint inventory, call budget, and
three of the five response shapes are settled from real captured JSON
(Injury List, Teams, Player List — 2026-09-02). Two shapes are still
missing (Daily Scoreboard, Box Score) and they are the two that gate the
scoring rewrite. This doc is the handoff for whoever — human or a new
Claude session — picks it up next.

**The headline finding from the captured JSON: Tank01's `playerID` IS the
ESPN athlete id.** Every player in the sample has `playerID === espnID`
(Jack Coco 4240499, Drue Tranquill 3129310, Jaxon Smith-Njigba 4430878,
Philip Rivers 5529, Raymond Jackson 999). The ID re-keying that this doc
previously called a data migration is **not needed at all** —
`players.id`, `roster_picks.player_id` and `player_stage_stats.player_id`
already hold Tank01 player ids. See "IDs: mostly a non-issue" below.

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
| `getNFLTeams` | team index **and every team's bye week** — replaces `getTeamIndex()` AND the bye derivation |
| Get NFL Team Roster | per-team roster (32 calls) — **fallback only** |
| `getNFLPlayerList` | whole-league player list — preferred for `sync-players`, but **paginated** (see below) |
| Get Player Information | single-player lookup; no longer needed for ID mapping |
| `getNFLInjuriesByDate` | **league-wide injuries in 1 call** — splits injury refresh off `sync-players` |
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

## What the captured responses settle

Three real responses are in hand (2026-09-02). Save them under
`reference/tank01-samples/` as parser fixtures.

### `getNFLInjuriesByDate` — one call, whole league

```
{ statusCode, body: { injList: [ { team, teamID, playerID, longName, pos, designation } ], injDate } }
```

~250 rows, all positions. **`designation` is abbreviated here: `Q`, `O`,
`IR`** — not the full words. Absence from the list means healthy. So
`normalizeStatus()` gets rewritten as a small map (`Q`→Questionable,
`O`→Out, `IR`→IR) plus "not in list → Active", and the job must clear
stale statuses on players who dropped off the list.

Careful: the **Player List** carries a *different* injury vocabulary in
its own `injury.designation` field — full words there ("Questionable",
"Out", "Injured Reserve"). Don't write one parser for both. Prefer the
injury endpoint; it's the fresher, cheaper source.

### `getNFLTeams` — one call, and it kills the bye-week derivation

Each of the 32 teams carries `byeWeeks` keyed by season year:

```
"byeWeeks": { "2025": ["7"], "2026": ["7"] }
```

Today `sync-schedule` infers byes by diffing the week's scoreboard
against the 32-team index. **Delete that.** One `getNFLTeams` call gives
every team's bye week for the whole season directly, so byes can be set
once a week (or once a season) instead of being re-derived from every
scoreboard pull. `topPerformers` is season-to-date leaders only — useless
for weekly scoring, ignore it. `teamStats` came back `{}` (preseason).

### `getNFLPlayerList` — the one with traps

Confirms `playerID === espnID`, but two things make this not a
one-call drop-in:

1. **It's paginated.** The response ends with a `nextToken`
   (`"eyJwbGF5ZXJJRCI6ICIyOTc5NTUzIn0="`) — base64 of the last
   `playerID`. Budget several calls per full pull, not one, and write the
   pagination loop with a hard page cap so a bad token can't spin.
2. **It's a historical database, not a roster.** Philip Rivers, DeSean
   Jackson, Ndamukong Suh and Mason Crosby are all in there, each with a
   `team` set. The filter that matters is `isFreeAgent === "False"`
   (string, not boolean). Filtering on `team` alone would put retired
   players into the draft pool.

`pos` values match ESPN's (`QB`/`RB`/`WR`/`TE`), so `KEEP_POSITIONS`
carries over unchanged.

## IDs: mostly a non-issue

`playerID === espnID` across every sampled player, so the planned
re-keying is off. `players.id` keeps its current values, `roster_picks`
and `player_stage_stats` are untouched, and no migration SQL is needed
for the player pool. Still worth adding a nullable `tank01_id` column
that we populate with the same value — it costs nothing now and means
the next provider swap isn't a schema change.

**One real mismatch remains: team ids.** `players.nfl_team_id` currently
holds ESPN team ids; Tank01 uses its own, assigned alphabetically by
abbreviation:

```
1 ARI   2 ATL   3 BAL   4 BUF   5 CAR   6 CHI   7 CIN   8 CLE
9 DAL  10 DEN  11 DET  12 GB   13 HOU  14 IND  15 JAX  16 KC
17 LV   18 LAC  19 LAR  20 MIA  21 MIN  22 NE   23 NO   24 NYG
25 NYJ  26 PIT  27 PHI  28 SF   29 SEA  30 TB   31 TEN  32 WSH
```

That's a 32-row remap, and `players.nfl_team` (the abbreviation) is
stable across both providers, so the migration is a single UPDATE joined
on abbreviation. Verify the map against a live `getNFLTeams` response
rather than trusting the table above — it was read off one sample.

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

| Job | Cadence | Calls/run | Calls/day |
| --- | --- | --- | --- |
| Player list (paginated) | 2×/day | ~6 | 12 |
| Injury list | every 30 min | 1 | 48 |
| Teams (byes) | 1×/day | 1 | 1 |
| Weekly schedule | every 3 hours | 1 | 8 |
| | | **Total** | **69** |

**Worst-case Sunday ≈ 762 calls. Other days ≈ 69.** That fits inside
1,000/day with ~240 headroom, at a *tighter* cadence than today's
10-minute one.

The player-list figure assumes ~6 pages; the sample page held several
hundred players and the league-wide file includes free agents and retired
players, so measure the real page count on the first full pull and revise
this row. It's cheap either way at 2×/day — but don't let it creep to
hourly without re-doing this math.

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

## Still blocked on

Two responses, and they're the two the scoring rewrite depends on. This
sandbox can't reach `rapidapi.com` or `tank01.com` (egress proxy blocks
both), so these have to be captured from the RapidAPI playground with the
Pro key and saved into `reference/tank01-samples/`:

- **Get Daily Scoreboard - Live** — the **game status field and its exact
  values** (scheduled vs in-progress vs final). The entire polling design
  hangs on being able to tell those apart. Capture this one *during* a
  live game window, or the status field will only ever show one value.
- **Get NFL Game Box Score - Live** — the per-player passing/rushing/
  receiving TD field names. This replaces `tallyGame()` and is the one
  place a wrong guess silently produces wrong scores instead of an error.
  Also settles the budget question below.

**Do not build the scoring path against guessed field names.** The reason
we're leaving ESPN is an unvalidated-assumption problem — the ESPN
box-score shape in `sync-scores/index.ts` was never confirmed against a
live response either (see the "Parsing approach" comment there). The
player/injury/team jobs *can* be built now against the captured JSON;
`sync-scores` cannot.

One naming note for whoever captures them: the real endpoint names differ
from the RapidAPI UI labels (`getNFLInjuriesByDate`, not "NFL Injury
List"). Record the exact path and query params alongside each sample.

## Also worth settling

**Is live in-game scoring actually a feature people use?** If TD tallies
finalizing a few hours after each week's games is acceptable, `sync-scores`
drops from ~693 Sunday calls to about a dozen, and nflverse re-enters as a
free option. Nate should make this call — it changes the design
materially. The budget above assumes yes, live matters.

## Step order

The player/injury/schedule half is unblocked and can start now. The
scoring half waits on two captures.

**Now — no further input needed:**

1. **Save the three captured responses** into
   `reference/tank01-samples/` as parser fixtures.
2. **Write `supabase/functions/_shared/tank01.ts`** — same shape as
   `_shared/espn.ts` (`fetchJson` + timeout/retry/concurrency helpers +
   typed endpoint wrappers), plus the RapidAPI auth headers
   (`x-rapidapi-key`, `x-rapidapi-host`), the paginated player-list loop
   with a page cap, and the call-budget counter. Validate against the
   fixtures.
3. **Migration SQL**: add nullable `players.tank01_id` (same value as
   `id`), and remap `players.nfl_team_id` from ESPN team ids to Tank01's
   via the abbreviation join. No `roster_picks` / `player_stage_stats`
   changes.
4. **Rewire the non-scoring jobs:**
   - `sync-players` → `getNFLPlayerList`, paginated, filtering
     `isFreeAgent === "False"` and QB/RB/WR/TE. Drop the 32-call loop.
   - **New `sync-injuries`** → `getNFLInjuriesByDate` (1 call), with the
     `Q`/`O`/`IR` map and stale-status clearing.
   - `sync-schedule` → weekly schedule for `first_kickoff_at`; byes now
     come from `getNFLTeams.byeWeeks[season]`, not from diffing the
     scoreboard.
5. **Set the RapidAPI secret**: `supabase secrets set RAPIDAPI_KEY=…`, and
   update the "Env vars / secrets required" section of
   `supabase/functions/README.md` (currently all ESPN-specific).

**After the two captures land:**

6. **Rewire `sync-scores`** → Daily Scoreboard gate + box score only for
   in-progress/newly-final games containing rostered players.
7. **Update `0004_cron.sql`** to the cadences in the budget table, and add
   the new `sync-injuries` job.
8. **Delete `_shared/espn.ts`** and the stale ESPN parsing comments.
9. **End-to-end test** all sync buttons on the commish page (see
   `src/components/commish/SyncPanel.tsx`) and confirm `sync_log` shows
   real success rows — plus one manual cross-check of a real game's TD
   tallies against a known box score — before calling this done.

The live-scoring question above still governs step 6's cadence, and the
Daily Scoreboard capture has to happen during an actual game window.
