// Fetch-or-skip policy for sync-scores box score calls.
//
// Lives here rather than in sync-scores/index.ts so it can be unit tested:
// index.ts calls Deno.serve() at module load, so importing it from a test
// would stand up a server. See __tests__/gameFetch_test.ts.
import { isFinal, isScheduled, kickoffAt, type Tank01Game } from "./tank01.ts";

/**
 * Generous upper bound on how long after kickoff a game can still be
 * producing stats (regulation + overtime + stat settling). Also the point
 * past which a game still reported as "Scheduled" is treated as a stale
 * status rather than a future game. See shouldFetch().
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
 * - Stale-scheduled -> still flagged "Scheduled" long after it must have
 *                      ended, so the status is wrong, not the clock. Fetch.
 * - Final           -> stats are frozen, so fetch it exactly once: skip only
 *                      when a previous run that fetched EVERY game cleanly
 *                      happened well after this game must have ended. (A run
 *                      with any failed fetch logs status 'error' and so never
 *                      advances this watermark — deliberately conservative.)
 * - Anything else   -> in progress / delayed / unknown. Fetch.
 *
 * Why the stale-scheduled case exists
 * ------------------------------------------------------------------------
 * Tank01 does not flip gameStatus off "Scheduled" promptly — the 2026 Week 1
 * Thursday opener (kickoff 00:20Z) was still reported as "Scheduled" at
 * 10:00Z and only went "Completed" around 10:08Z, roughly ten hours after
 * kickoff. That lag silently broke the watermark: every run during the stale
 * window skipped the game as "not yet kicked off" while still logging
 * success, so by the time the status flipped, lastClean was already past
 * kickoff + GAME_SETTLED_MS and the game was written off as
 * "final-already-ingested" — even though no run had ever fetched it. The
 * whole opener scored zero and Week 1 standings stayed empty.
 *
 * Fetching a stale-scheduled game closes that hole at its source: once a
 * game is past kickoff + GAME_SETTLED_MS, EVERY status leads to a fetch
 * (scheduled and live directly, final via the watermark), so a run can only
 * be clean after it has actually seen the game. That restores the
 * watermark's induction — a clean run past that point really did ingest
 * every game it covers — and costs at most one extra call per stuck game.
 */
export function shouldFetch(
  game: Tank01Game,
  lastClean: Date | null,
  now: Date = new Date(),
): SkipDecision {
  const kickoff = kickoffAt(game);
  const mustHaveEnded = kickoff !== null &&
    now.getTime() > kickoff.getTime() + GAME_SETTLED_MS;

  if (isScheduled(game)) {
    return mustHaveEnded
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
