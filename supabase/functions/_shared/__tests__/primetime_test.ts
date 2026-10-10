// Tests for picking the SNF / MNF games out of a week and reading their
// final scores — the "actual total" every manager's draft-order guess is
// measured against.
//
// Run: deno test --allow-read supabase/functions/_shared/__tests__/

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
  }
}

import { GAME_SETTLED_MS } from "../gameFetch.ts";
import { finalCombinedScore, findPrimetimeGames } from "../primetime.ts";
import type { Tank01Game } from "../tank01.ts";

const HOUR = 60 * 60 * 1000;

/** A game kicking off at the given UTC instant. */
function game(gameID: string, kickoffUtc: number, status = "Scheduled"): Tank01Game {
  return {
    gameID,
    gameTime_epoch: String(kickoffUtc / 1000),
    gameStatus: status,
    gameStatusCode: status === "Completed" ? "2" : status === "Scheduled" ? "0" : "1",
  };
}

// 2026 Week 6 shape, in UTC. ET is UTC-4 in October.
const TNF = game("20261008_A@B", Date.UTC(2026, 9, 9, 0, 15)); // Thu 8:15p ET
const EARLY = game("20261011_C@D", Date.UTC(2026, 9, 11, 17, 0)); // Sun 1:00p ET
const LATE = game("20261011_E@F", Date.UTC(2026, 9, 11, 20, 25)); // Sun 4:25p ET
const SNF = game("20261011_G@H", Date.UTC(2026, 9, 12, 0, 20)); // Sun 8:20p ET (Mon UTC!)
const MNF = game("20261012_I@J", Date.UTC(2026, 9, 13, 0, 15)); // Mon 8:15p ET (Tue UTC!)

Deno.test("finds SNF and MNF by Eastern time, not UTC date", () => {
  assertEquals(findPrimetimeGames([TNF, EARLY, LATE, SNF, MNF]), {
    snf: SNF.gameID,
    mnf: MNF.gameID,
  });
});

Deno.test("a 4:25p Sunday game is not Sunday night", () => {
  assertEquals(findPrimetimeGames([EARLY, LATE]).snf, null);
});

Deno.test("refuses to pick between two Monday games", () => {
  const MNF2 = game("20261012_K@L", Date.UTC(2026, 9, 12, 23, 0)); // Mon 7:00p ET
  assertEquals(findPrimetimeGames([SNF, MNF, MNF2]).mnf, null);
});

Deno.test("a week with no Monday game has no MNF", () => {
  assertEquals(findPrimetimeGames([EARLY, SNF]), { snf: SNF.gameID, mnf: null });
});

Deno.test("final box score: home + away", () => {
  const box = { gameStatusCode: "2", homePts: "27", awayPts: "24" };
  assertEquals(finalCombinedScore(SNF, box, new Date(Date.UTC(2026, 9, 12, 4))), 51);
});

Deno.test("an in-progress game has no final score yet", () => {
  const box = { gameStatusCode: "1", homePts: "14", awayPts: "10" };
  assertEquals(finalCombinedScore(SNF, box, new Date(Date.UTC(2026, 9, 12, 2))), null);
});

Deno.test("status stuck mid-game for hours still counts as final once settled", () => {
  const kickoff = Date.UTC(2026, 9, 12, 0, 20);
  const box = { gameStatus: "In Progress", gameStatusCode: "1", homePts: "30", awayPts: "3" };
  assertEquals(finalCombinedScore(SNF, box, new Date(kickoff + GAME_SETTLED_MS + HOUR)), 33);
});

Deno.test("blank points are unknown, not zero", () => {
  const box = { gameStatusCode: "2", homePts: "", awayPts: "17" };
  assertEquals(finalCombinedScore(SNF, box, new Date(Date.UTC(2026, 9, 12, 4))), null);
});

Deno.test("works against the real box score sample", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../../../../reference/tank01/getNFLBoxScore.sample.json", import.meta.url)),
  );
  const box = raw.body ?? raw;
  // Sample is WSH 40, CAR 7, Completed.
  assertEquals(finalCombinedScore(game(box.gameID, Date.UTC(2024, 9, 20, 17)), box, new Date()), 47);
});
