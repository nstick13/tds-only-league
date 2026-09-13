// Regression tests for the box-score fetch/skip policy.
//
// Two real outages, same root cause — Tank01 leaves gameStatus on
// "Scheduled" long after a game has actually kicked off:
//
//  1. The 2026 Week 1 opener stayed "Scheduled" for ~10 hours. Every poll
//     skipped it as "not yet kicked off" while still logging success, so by
//     the time the status flipped to Completed the global clean-run
//     watermark was already past kickoff + GAME_SETTLED_MS and the game was
//     skipped forever as "final-already-ingested". The opener scored zero.
//
//  2. The 2026 Week 1 Sunday slate was still "Scheduled" more than an hour
//     into the 1pm ET games. The fix for (1) only overrode the status after
//     kickoff + GAME_SETTLED_MS (6h), so live scoring stayed frozen at zero
//     all afternoon while each run logged success with 0 games fetched.
//
// Hence: kickoff time decides whether a game has started, never gameStatus.
//
// Run: deno test --allow-read supabase/functions/_shared/__tests__/

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
  }
}

import { GAME_SETTLED_MS, shouldFetch } from "../gameFetch.ts";
import type { Tank01Game } from "../tank01.ts";

/** Week 1 opener: kickoff 2026-09-10T00:20:00Z. */
const KICKOFF = Date.UTC(2026, 8, 10, 0, 20, 0);
const at = (ms: number) => new Date(KICKOFF + ms);
const HOUR = 60 * 60 * 1000;

function game(status: "Scheduled" | "In Progress" | "Completed"): Tank01Game {
  return {
    gameID: "20260909_SEA@SF",
    gameStatus: status,
    gameStatusCode: { Scheduled: "0", "In Progress": "1", Completed: "2" }[
      status
    ],
    gameTime_epoch: String(KICKOFF / 1000),
  } as Tank01Game;
}

Deno.test("a game that has not kicked off yet is never fetched", () => {
  const d = shouldFetch(game("Scheduled"), null, at(-2 * HOUR));
  assertEquals(d, { fetch: false, reason: "scheduled" });
});

Deno.test("a live game is always fetched", () => {
  const d = shouldFetch(game("In Progress"), at(-24 * HOUR), at(2 * HOUR));
  assertEquals(d, { fetch: true, reason: "live" });
});

Deno.test("a game still 'Scheduled' long after kickoff is fetched anyway", () => {
  // Outage 1: at 10:00Z (9h40m after kickoff) Tank01 still said Scheduled.
  const d = shouldFetch(game("Scheduled"), at(-24 * HOUR), at(9 * HOUR + 40 * 60 * 1000));
  assertEquals(d, { fetch: true, reason: "stale-scheduled" });
});

Deno.test("a game 'Scheduled' an hour into play is fetched — live scoring", () => {
  // Outage 2: the Sunday slate, ~1h into the 1pm ET games, still flagged
  // Scheduled. This returned {fetch:false,reason:"scheduled"} while the
  // override was gated on the 6h settle window, so nothing scored live.
  const d = shouldFetch(game("Scheduled"), at(-24 * HOUR), at(HOUR));
  assertEquals(d, { fetch: true, reason: "stale-scheduled" });
});

Deno.test("the scheduled/started boundary is kickoff itself, not the settle window", () => {
  const justBefore = shouldFetch(game("Scheduled"), null, at(-1));
  assertEquals(justBefore, { fetch: false, reason: "scheduled" });
  const atKickoff = shouldFetch(game("Scheduled"), null, at(0));
  assertEquals(atKickoff, { fetch: true, reason: "stale-scheduled" });
});

Deno.test("a final game is fetched once when no clean run has covered it", () => {
  const d = shouldFetch(game("Completed"), at(3 * HOUR), at(10 * HOUR));
  assertEquals(d, { fetch: true, reason: "final-unseen" });
});

Deno.test("a final game already covered by a clean run is skipped", () => {
  const d = shouldFetch(game("Completed"), at(8 * HOUR), at(10 * HOUR));
  assertEquals(d, { fetch: false, reason: "final-already-ingested" });
});

Deno.test("the opener cannot be lost again: every status past the settle window fetches", () => {
  // The watermark's induction only holds if a run past kickoff+settle fetches
  // the game under EVERY status it could be reported as. A clean run can then
  // only exist after the game was actually seen.
  const late = at(GAME_SETTLED_MS + HOUR);
  const noPriorCoverage = null;
  for (const status of ["Scheduled", "In Progress", "Completed"] as const) {
    const d = shouldFetch(game(status), noPriorCoverage, late);
    assertEquals(d.fetch, true, `status ${status} past settle window`);
  }
});

Deno.test("a whole slate mid-game is fetched even if every status is stuck", () => {
  // The shape of outage 2: 14 games underway, all still flagged Scheduled.
  // Every one of them must be fetched, or the standings sit at zero.
  const midGame = at(HOUR + 30 * 60 * 1000);
  for (const status of ["Scheduled", "In Progress"] as const) {
    const d = shouldFetch(game(status), at(-24 * HOUR), midGame);
    assertEquals(d.fetch, true, `status ${status} mid-game`);
  }
});

Deno.test("a game with no kickoff timestamp is not treated as stale", () => {
  const g = { ...game("Scheduled"), gameTime_epoch: undefined } as Tank01Game;
  assertEquals(shouldFetch(g, null, at(50 * HOUR)), {
    fetch: false,
    reason: "scheduled",
  });
});
