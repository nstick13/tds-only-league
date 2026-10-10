/**
 * Draft order generation — pure logic, no I/O. Produces the overall
 * snake-draft pick order for a stage: one round per roster slot, so
 * 8 managers x ROSTER_SIZE rounds (currently 7 -> 56 picks).
 * Commissioner server actions (src/app/(app)/commish/actions.ts) call
 * this and persist the result to the draft_order table.
 */

import { ROSTER_SIZE } from "@/lib/roster";

/** Minimal shape of a previous stage's standings row needed to seed a redraft. */
export interface StandingsSeed {
  manager_id: string;
  /** 1 = best (first place) ... N = worst (last place). */
  rank: number;
}

/**
 * Fisher-Yates shuffle. Returns a new array; does not mutate the input.
 * Used only for the Week 1 / first-stage random round-1 order.
 */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Derives the round-1 (base) pick order from the previous stage's
 * standings: LAST place picks first (rank 8 -> pick 1, ... rank 1 ->
 * pick 8) — the "loser's draft" reward for a bad week. Sorts descending
 * by rank, so ties in rank fall back to stable input order.
 *
 * No longer the normal rule (see seedRoundOneFromGuesses). Kept as the
 * fallback for a week in which nobody entered a guess — e.g. the week the
 * guess rule was switched on mid-season.
 */
export function seedRoundOneFromStandings(
  previousStandings: StandingsSeed[],
): string[] {
  return [...previousStandings]
    .sort((a, b) => b.rank - a.rank)
    .map((s) => s.manager_id);
}

/** One manager's inputs to the guess-based round-1 order. */
export interface GuessSeed {
  manager_id: string;
  /** Their guess at the combined SNF + MNF score, or null if they never entered one. */
  guess: number | null;
  /** That week's position points — the tiebreakers, in this order. */
  te_points: number;
  wr_points: number;
  rb_points: number;
  qb_points: number;
}

/**
 * Derives the round-1 (base) pick order from the week's SNF + MNF guesses:
 * closest to `actualTotal` picks first, over and under counting the same.
 *
 * Ties on distance go to most TE points, then WR, RB, QB, then a coin flip.
 * Total points and total TDs are deliberately not consulted — a manager who
 * scored less overall still wins the tie if they had more TE points.
 *
 * A manager with no guess (only possible when the commissioner drafted for
 * them) sorts behind everyone who did guess, ordered among themselves by the
 * same position tiebreakers.
 *
 * `random` is injectable so tests can pin the coin flip.
 */
export function seedRoundOneFromGuesses(
  seeds: GuessSeed[],
  actualTotal: number,
  random: () => number = Math.random,
): string[] {
  // One flip per manager up front, so the comparator stays consistent.
  const coin = new Map(seeds.map((s) => [s.manager_id, random()]));
  const distance = (s: GuessSeed) =>
    s.guess === null ? Infinity : Math.abs(s.guess - actualTotal);

  return [...seeds]
    .sort((a, b) => {
      const da = distance(a);
      const db = distance(b);
      if (da !== db) return da - db;
      return (
        b.te_points - a.te_points ||
        b.wr_points - a.wr_points ||
        b.rb_points - a.rb_points ||
        b.qb_points - a.qb_points ||
        coin.get(a.manager_id)! - coin.get(b.manager_id)!
      );
    })
    .map((s) => s.manager_id);
}

/**
 * Generates the full overall snake draft order for a stage.
 *
 * - `roundOneOrder === null` (Week 1 / the very first draftable stage): the
 *   round-1 base order is a RANDOM shuffle of `managerIds`.
 * - Otherwise `roundOneOrder` is the round-1 order as-is — normally from
 *   seedRoundOneFromGuesses, or a commissioner's hand-set order.
 * - Snake: round 1 = base order, round 2 = reversed, round 3 = base, ...
 *   alternating for ROSTER_SIZE rounds — one round per roster slot, since
 *   every manager fills their whole roster in the draft. So whoever picks
 *   8th overall (last of round 1) also picks 9th overall (first of round 2)
 *   back-to-back, exactly as the "snake" name implies.
 *
 * Deterministic given inputs, except for the Week 1 random shuffle branch.
 */
export function generateDraftOrder(
  managerIds: string[],
  roundOneOrder: string[] | null,
): string[] {
  const baseOrder = roundOneOrder === null ? shuffle(managerIds) : roundOneOrder;

  const managersPerRound = baseOrder.length;
  // One round per roster slot. Derived, not a literal, so a roster-shape
  // change (e.g. the move to two QBs) grows the draft without a second edit
  // here — the two numbers can never drift apart.
  const rounds = ROSTER_SIZE;

  const picks: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const roundOrder = round % 2 === 0 ? baseOrder : [...baseOrder].reverse();
    for (let i = 0; i < managersPerRound; i++) {
      picks.push(roundOrder[i]);
    }
  }
  return picks;
}
