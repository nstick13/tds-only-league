/**
 * Roster shape rules. Single source of truth for how many of each position
 * a manager may hold in a given stage — mirror these values in the
 * enforce_roster_limits() trigger (defined in 0002_functions.sql, last
 * changed by 0012_two_qb_roster.sql), but do not duplicate them anywhere
 * else in application code. Import from here instead.
 *
 * Changing a value here changes the draft too: generateDraftOrder derives
 * its round count from ROSTER_SIZE, so the snake grows or shrinks with the
 * roster automatically. The draft_order.pick_number CHECK constraint is the
 * one thing that does NOT follow — it needs a migration.
 */
export type Position = "QB" | "RB" | "WR" | "TE";

export const ROSTER_SHAPE: Record<Position, number> = {
  QB: 2,
  RB: 2,
  WR: 2,
  TE: 1,
};

export const ROSTER_SIZE = Object.values(ROSTER_SHAPE).reduce(
  (sum, n) => sum + n,
  0,
); // 7

export const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
