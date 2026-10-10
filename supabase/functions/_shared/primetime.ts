// Sunday Night / Monday Night game detection for the draft-order guess.
//
// Each week every manager guesses the combined final score of that week's
// SNF and MNF games; closest guess picks first in the next draft (see
// src/lib/draftOrder.ts seedRoundOneFromGuesses). sync-scores already
// fetches every game's box score, which carries homePts/awayPts, so it
// records those two games' scores as it goes — nobody types them in.
//
// Lives in _shared (not sync-scores/index.ts) so it can be unit tested; see
// __tests__/primetime_test.ts.
import { GAME_SETTLED_MS } from "./gameFetch.ts";
import { isFinal, kickoffAt, type Tank01Game, toInt } from "./tank01.ts";

/** Earliest Eastern-time kickoff hour that counts as Sunday NIGHT (SNF is 8:20p; 4:25p is not). */
const SNF_EARLIEST_ET_HOUR = 19;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

function easternWeekdayAndHour(d: Date): { weekday: string; hour: number } {
  const parts = ET_PARTS.formatToParts(d);
  return {
    weekday: parts.find((p) => p.type === "weekday")?.value ?? "",
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? NaN),
  };
}

export interface PrimetimeGames {
  /** gameID of the Sunday night game, or null if the week has none / it's ambiguous. */
  snf: string | null;
  /** gameID of the Monday night game, or null if the week has none / it's ambiguous. */
  mnf: string | null;
}

/**
 * Picks the SNF and MNF games out of a week's schedule by kickoff time in
 * Eastern time: SNF is the one Sunday game kicking off at 7pm ET or later,
 * MNF is the one Monday game.
 *
 * Returns null for a slot when there isn't exactly one candidate. Zero
 * happens in odd weeks (Week 18, the postseason); two would be a Monday
 * doubleheader, which the league has dropped. Guessing which of two games
 * counts would silently set a draft order on the wrong score, so we don't —
 * finalize then refuses and says the score never synced.
 */
export function findPrimetimeGames(games: Tank01Game[]): PrimetimeGames {
  const snf: string[] = [];
  const mnf: string[] = [];
  for (const game of games) {
    const kickoff = kickoffAt(game);
    if (!kickoff) continue;
    const { weekday, hour } = easternWeekdayAndHour(kickoff);
    if (weekday === "Sun" && hour >= SNF_EARLIEST_ET_HOUR) snf.push(game.gameID);
    if (weekday === "Mon") mnf.push(game.gameID);
  }
  return {
    snf: snf.length === 1 ? snf[0] : null,
    mnf: mnf.length === 1 ? mnf[0] : null,
  };
}

/**
 * The game's combined final score (both teams), or null if it may not be
 * over yet.
 *
 * "Over" is the box score OR the schedule saying final, OR kickoff being
 * more than GAME_SETTLED_MS ago. The clock fallback matters: Tank01 has left
 * statuses stale for ~10 hours (see gameFetch.ts), and once a game is
 * finally marked Completed, sync-scores may skip it as already ingested —
 * so a status-only check could miss the one fetch that would have recorded
 * the score.
 */
export function finalCombinedScore(
  game: Tank01Game,
  box: { gameStatus?: string; gameStatusCode?: string; homePts?: string; awayPts?: string },
  now: Date,
): number | null {
  const kickoff = kickoffAt(game);
  const settledByClock = kickoff !== null &&
    now.getTime() >= kickoff.getTime() + GAME_SETTLED_MS;
  if (!isFinal(box) && !isFinal(game) && !settledByClock) return null;
  // A blank score is "unknown", not zero — toInt would read it as 0.
  if (!box.homePts?.trim() || !box.awayPts?.trim()) return null;
  return toInt(box.homePts) + toInt(box.awayPts);
}
