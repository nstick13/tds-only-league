/**
 * Pure draft-eligibility helpers shared between the draft server action
 * (src/app/(app)/draft/actions.ts) and the draft client components. No
 * Supabase calls here — just pure functions over already-fetched rows —
 * so the exact same logic can be re-checked client-side (for instant UI
 * feedback) and server-side (for the authoritative re-validation before
 * insert).
 *
 * Status handling: players.status is free text synced from ESPN
 * (src/lib/types.ts PlayerStatus). We bucket it into:
 *   - "blocked" (hard-out): OUT, IR, PUP — drafting is disabled entirely.
 *   - "warning": Questionable, Doubtful — drafting is allowed, but the UI
 *     must show a visible warning badge.
 *   - anything else (including "Active") — no warning.
 * A player who is on_bye is always blocked, regardless of status.
 */
import type { Player, DraftOrderRow, RosterPick } from "@/lib/types";
import { ROSTER_SHAPE, ROSTER_SIZE, type Position } from "@/lib/roster";

const BLOCKED_STATUSES = new Set(["OUT", "IR", "PUP"]);
const WARNING_STATUSES = new Set(["QUESTIONABLE", "DOUBTFUL"]);

export function isBlockedStatus(status: string): boolean {
  return BLOCKED_STATUSES.has(status.toUpperCase());
}

export function isWarningStatus(status: string): boolean {
  return WARNING_STATUSES.has(status.toUpperCase());
}

/** True if nothing about the player's own status/bye disqualifies them (does not check roster caps or whether they're already taken). */
export function isPlayerDraftable(player: Pick<Player, "on_bye" | "status">): boolean {
  if (player.on_bye) return false;
  if (isBlockedStatus(player.status)) return false;
  return true;
}

export function reasonPlayerBlocked(
  player: Pick<Player, "on_bye" | "status">,
): string | null {
  if (player.on_bye) return "Player is on a bye this week";
  if (isBlockedStatus(player.status)) return `Player is ${player.status}`;
  return null;
}

/** How many of a manager's picks in this stage currently fill a given slot. */
export function countSlot(
  picks: Pick<RosterPick, "manager_id" | "slot_position">[],
  managerId: string,
  position: Position,
): number {
  return picks.filter(
    (p) => p.manager_id === managerId && p.slot_position === position,
  ).length;
}

export function isSlotFull(
  picks: Pick<RosterPick, "manager_id" | "slot_position">[],
  managerId: string,
  position: Position,
): boolean {
  return countSlot(picks, managerId, position) >= ROSTER_SHAPE[position];
}

export function isRosterFull(
  picks: Pick<RosterPick, "manager_id">[],
  managerId: string,
): boolean {
  return picks.filter((p) => p.manager_id === managerId).length >= ROSTER_SIZE;
}

export interface CurrentPick {
  /** Overall pick number, 1-based. Null once the draft is complete (every draft_order row used, or draft_order is empty). */
  pickNumber: number | null;
  /** The manager on the clock for pickNumber, or null if unassigned/draft complete. */
  managerId: string | null;
}

/**
 * The current overall pick = (number of roster_picks already made in this
 * stage) + 1, looked up in draft_order. This is recomputed from live data
 * rather than stored, so it's always consistent with roster_picks.
 */
export function computeCurrentPick(
  draftOrder: Pick<DraftOrderRow, "pick_number" | "manager_id">[],
  picksMadeCount: number,
): CurrentPick {
  const pickNumber = picksMadeCount + 1;
  const row = draftOrder.find((r) => r.pick_number === pickNumber);
  if (!row) return { pickNumber: null, managerId: null };
  return { pickNumber, managerId: row.manager_id };
}
