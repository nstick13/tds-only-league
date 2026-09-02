/**
 * Shared TypeScript types mirroring the Supabase schema in
 * supabase/migrations/0001_core.sql. THE canonical types other feature
 * agents (draft, commissioner, standings) should import from here rather
 * than re-declaring shapes against `any` query results.
 *
 * Naming: SQL is snake_case; these interfaces keep the same field names
 * (camelCase would drift from `select *` results and Supabase's generated
 * row shapes) but use PascalCase type names per TS convention.
 */

/** Player position — mirrors players.position / roster_picks.slot_position check constraints. Re-exported from src/lib/roster.ts's single source of truth. */
export type { Position } from "./roster";

/** stages.status lifecycle: upcoming -> draft_open -> locked -> finalized. */
export type StageStatus = "upcoming" | "draft_open" | "locked" | "finalized";

/** Player availability status as synced from ESPN (free text, 'Active' is the default/happy path). */
export type PlayerStatus = "Active" | "Questionable" | "Doubtful" | "OUT" | "IR" | string;

/** sync_log.source values — the four ESPN sync jobs. */
export type SyncSource = "players" | "schedule" | "scores" | "locks";

/** sync_log.status. */
export type SyncStatus = "success" | "error";

/** profiles table — one row per authenticated user. */
export interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
  is_commissioner: boolean;
  is_player: boolean;
  /** 1..8 seat in the league, or null if this account is not a roster manager. */
  manager_slot: number | null;
  created_at: string;
}

/** stages table — one row per draftable stage (18 weeks + 4 postseason rounds). */
export interface Stage {
  id: number;
  name: string;
  /** Draft/display order, 1..22. Always sort/query by this, never hardcode a stage list. */
  ordinal: number;
  /**
   * Tank01 seasonType for this stage, or null when the stage has no confirmed
   * week addressing yet (the four postseason rows).
   */
  season_type: string | null;
  /** Tank01 week number for this stage, or null. See season_type. */
  week_num: number | null;
  status: StageStatus;
  first_kickoff_at: string | null;
  created_at: string;
}

/** players table — league-wide player pool synced from Tank01. */
export interface Player {
  /** ESPN athlete id — also Tank01's playerID, which is the same value. */
  id: string;
  name: string;
  position: import("./roster").Position;
  nfl_team: string | null;
  nfl_team_id: string | null;
  status: PlayerStatus;
  status_detail: string | null;
  on_bye: boolean;
  updated_at: string;
  last_synced_at: string | null;
}

/** draft_order table — overall snake-draft pick order for a stage. */
export interface DraftOrderRow {
  stage_id: number;
  /** 1..48. */
  pick_number: number;
  manager_id: string | null;
}

/** roster_picks table — the drafted roster; one row per player a manager holds in a stage. */
export interface RosterPick {
  id: string;
  stage_id: number;
  manager_id: string;
  player_id: string;
  slot_position: import("./roster").Position;
  pick_number: number | null;
  created_at: string;
}

/** player_stage_stats table — raw TD counts per player per stage. `points` is a DB-generated column (see src/lib/scoring.ts). */
export interface PlayerStageStats {
  stage_id: number;
  player_id: string;
  pass_td: number;
  rush_td: number;
  rec_td: number;
  /** Generated column: pass_td*0.5 + rush_td*1.0 + rec_td*1.0. Never write directly. */
  points: number;
  updated_at: string;
}

/** weekly_results table — computed per-manager stage totals/standings. */
export interface WeeklyResult {
  stage_id: number;
  manager_id: string;
  total_tds: number;
  total_points: number;
  qb_points: number;
  rb_points: number;
  wr_points: number;
  te_points: number;
  rank: number | null;
  finalized_at: string | null;
}

/** sync_log table — append-only log of ESPN sync job runs. Backs the "loud staleness" UI. */
export interface SyncLog {
  id: number;
  source: SyncSource;
  status: SyncStatus;
  message: string | null;
  player_count: number | null;
  ran_at: string;
}
