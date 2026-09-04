/**
 * Shared types for the commissioner tools route. Kept separate from
 * actions.ts because a "use server" file may only export async functions
 * — plain types/interfaces have to live elsewhere to be importable from
 * both actions.ts and the client components in this route.
 */
import type { Position } from "@/lib/roster";

/** Uniform return shape for every commish server action. */
export type ActionResult<T = undefined> =
  | { success: true; message: string; data: T }
  | { success: false; message: string };

export interface ManualRosterEditInput {
  stageId: number;
  managerId: string;
  /** Player to remove (e.g. the injured player), if any. */
  removePlayerId?: string;
  /** Player to add in their place, if any. Requires slotPosition. */
  addPlayerId?: string;
  /** Roster slot for addPlayerId. Required when addPlayerId is set. */
  slotPosition?: Position;
}

/** Input for swapping one already-drafted player for another. */
export interface ReplaceRosterPickInput {
  stageId: number;
  /** The drafted player being replaced. Their manager, slot and pick_number carry over. */
  outPlayerId: string;
  /** Their replacement. Must be undrafted in this stage and play the slot's position. */
  inPlayerId: string;
}

export interface ManagerAdminUpdate {
  profileId: string;
  is_player?: boolean;
  is_commissioner?: boolean;
  /** 1..8, or null to clear the seat. Omit to leave unchanged. */
  manager_slot?: number | null;
}

/**
 * Sync jobs the Commish page can hand-trigger. A SUBSET of SyncSource:
 * schedule and locks run on their own cron and there is no useful reason to
 * force them by hand (schedule barely changes; apply-locks runs every five
 * minutes and is DB-only), so they are status-only in the panel.
 */
export type SyncSourceTrigger = "players" | "scores";
