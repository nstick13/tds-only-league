// Fetch-or-skip policy for sync-scores box score calls.
//
// Lives here rather than in sync-scores/index.ts so it can be unit tested:
// index.ts calls Deno.serve() at module load, so importing it from a test
// would stand up a server. See __tests__/gameFetch_test.ts.
import { isFinal, isScheduled, kickoffAt, type Tank01Game } from "./tank01.ts";

/**
 * Generous upper bound on how long after kickoff a game can still be
 * producing stats (regulation + overtime + stat settling). Used ONLY to age
 * out the final-game watermark below — never to decide whether a game has
 * started. See shouldFetch().
 */
export const GAME_SETTLED_MS = 6 * 60 * 60 * 1000;

export interface SkipDecision {
  fetch: boolean;
  reason:
    | "scheduled"
    | "stale-scheduled"
    | "final-already-ingested"
    | "live"
    | "final-unseen";
}

/**
 * Decide whether this game's box score can still tell us something new.
 *
 * - Not kicked off  -> no stats exist yet. Never fetch.
 * - Stale-scheduled -> the clock says it has kicked off but Tank01 still
 *                      reports "Scheduled", so the STATUS is wrong, not the
 *                      clock. Fetch.
 * - Final           -> stats are frozen, so fetch it exactly once: skip only
 *                      when a previous run that fetched EVERY game cleanly
 *                      happened well after this game must have ended. (A run
 *                      with any failed fetch logs status 'error' and so never
 *                      advances this watermark — deliberately conservative.)
 * - Anything else   -> in progress / delayed / unknown. Fetch.
 *
 * KICKOFF TIME IS AUTHORITATIVE, NOT gameStatus
 * ------------------------------------------------------------------------
 * Tank01 does not flip gameStatus off "Scheduled" promptly — the 2026 Week 1
 * opener (kickoff 00:20Z) was still "Scheduled" at 10:00Z, ~10 hours late,
 * and the Week 1 Sunday 1pm ET slate was still "Scheduled" over an hour into
 * the games. gameTime_epoch, by contrast, has always been correct. So the
 * only trustworthy answer to "have stats started existing?" is the clock.
 *
 * This previously gated the override on kickoff + GAME_SETTLED_MS (6h),
 * which fixed the lost-opener case but left live scoring broken for the
 * entire duration of every game: through all of Sunday afternoon every game
 * Tank01 still called "Scheduled" was skipped as "not yet kicked off", each
 * run logging success with zero games fetched. Nothing reached the standings
 * until six hours after kickoff. Comparing against kickoff itself keeps the
 * lost-opener fix (any status past kickoff leads to a fetch, so the
 * watermark's induction still holds) and restores live updates.
 *
 * Quota: this costs no more than Tank01 reporting statuses promptly would —
 * a started game is fetched on each run either way. Games that have NOT
 * kicked off are still never fetched, which is where the savings were.
 */
export function shouldFetch(
  game: Tank01Game,
  lastClean: Date | null,
  now: Date = new Date(),
): SkipDecision {
  const kickoff = kickoffAt(game);
  // No kickoff timestamp at all: Tank01 hasn't scheduled it, so there is no
  // clock to trust and nothing to fetch.
  const hasStarted = kickoff !== null && now.getTime() >= kickoff.getTime();

  if (isScheduled(game)) {
    return hasStarted
      ? { fetch: true, reason: "stale-scheduled" }
      : { fetch: false, reason: "scheduled" };
  }
  if (!isFinal(game)) return { fetch: true, reason: "live" };

  if (
    lastClean && kickoff &&
    lastClean.getTime() > kickoff.getTime() + GAME_SETTLED_MS
  ) {
    return { fetch: false, reason: "final-already-ingested" };
  }
  return { fetch: true, reason: "final-unseen" };
}
