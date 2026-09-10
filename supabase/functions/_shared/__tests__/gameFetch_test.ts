// Regression tests for the box-score fetch/skip policy.
//
// The case that matters here is the 2026 Week 1 opener: Tank01 left the game
// on gameStatus "Scheduled" for ~10 hours after kickoff, which made every
// poll skip it as "not yet kicked off" while still logging success. By the
// time the status flipped to Completed, the global clean-run watermark was
// already past kickoff + GAME_SETTLED_MS, so the game was skipped forever as
// "final-already-ingested" and the whole opener scored zero.
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
  // The exact failure: at 10:00Z (9h40m after kickoff) Tank01 still said
  // Scheduled. Before the fix this returned {fetch:false,reason:"scheduled"}.
  const d = shouldFetch(game("Scheduled"), at(-24 * HOUR), at(9 * HOUR + 40 * 60 * 1000));
  assertEquals(d, { fetch: true, reason: "stale-scheduled" });
});

Deno.test("stale-scheduled only kicks in after the settle window", () => {
  const justBefore = shouldFetch(game("Scheduled"), null, at(GAME_SETTLED_MS - 1));
  assertEquals(justBefore, { fetch: false, reason: "scheduled" });
  const justAfter = shouldFetch(game("Scheduled"), null, at(GAME_SETTLED_MS + 1));
  assertEquals(justAfter, { fetch: true, reason: "stale-scheduled" });
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

Deno.test("a game with no kickoff timestamp is not treated as stale", () => {
  const g = { ...game("Scheduled"), gameTime_epoch: undefined } as Tank01Game;
  assertEquals(shouldFetch(g, null, at(50 * HOUR)), {
    fetch: false,
    reason: "scheduled",
  });
});
