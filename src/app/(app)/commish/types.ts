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

export interface ManagerAdminUpdate {
  profileId: string;
  is_player?: boolean;
  is_commissioner?: boolean;
  /** 1..8, or null to clear the seat. Omit to leave unchanged. */
  manager_slot?: number | null;
}

/**
 * Sync jobs the Commish page can hand-trigger — one per deployed Edge
 * Function in supabase/functions/. Same values as SyncSource (a job that
 * writes a sync_log row is a job you can trigger), kept as its own name so
 * the button list and the sync_log status list stay separately readable.
 */
export type SyncSourceTrigger = "players" | "schedule" | "scores" | "locks";
