// Shared "current stage" resolution used by sync-schedule and sync-scores.
//
// Selection rule (see supabase/functions/README.md for the long version):
//   1. If the caller's POST body includes `stage_id`, use that stage as-is
//      (no status filtering — an explicit request always wins, e.g. a
//      commissioner manually re-running a past week).
//   2. Otherwise, prefer the lowest-`ordinal` stage whose status is
//      'draft_open' or 'locked' (i.e. the stage currently "in progress").
//   3. If none of those exist (e.g. before Week 1 opens, or right after
//      Week 18/postseason finalizes and nothing new has opened yet), fall
//      back to the lowest-`ordinal` stage with status 'upcoming'.
//   4. If neither query returns a row, there is genuinely no sensible
//      target stage (e.g. the whole season is finalized) — throw, and the
//      caller logs a sync_log error rather than guessing.
import { withRetry } from "./retry.ts";

export interface StageRow {
  id: number;
  name: string;
  ordinal: number;
  /**
   * Tank01 getNFLGamesForWeek?seasonType= value, or null when this stage has
   * no confirmed addressing yet (the four postseason rows — see
   * supabase/migrations/0006_tank01_stage_addressing.sql).
   */
  season_type: string | null;
  /** Tank01 getNFLGamesForWeek?week= value, or null. See season_type. */
  week_num: number | null;
  status: string;
  first_kickoff_at: string | null;
}

/**
 * Every sync job starts here, so a transient failure on these reads takes the
 * whole run with it — a "stage lookup failed: Gateway Timeout" during live
 * games costs a full 30-minute scoring interval. All three are read-only and
 * idempotent, so they retry (see withRetry in db.ts for the honest limits of
 * that).
 */
// deno-lint-ignore no-explicit-any
export async function resolveStage(
  supabase: any,
  requestedStageId?: number | string | null,
): Promise<StageRow> {
  if (requestedStageId !== undefined && requestedStageId !== null) {
    const data = await withRetry<StageRow>(
      "stage lookup",
      () =>
        supabase
          .from("stages")
          .select("*")
          .eq("id", requestedStageId)
          .maybeSingle(),
    );
    if (!data) throw new Error(`no stage found with id=${requestedStageId}`);
    return data;
  }

  const inProgress = await withRetry<StageRow[]>(
    "stage lookup",
    () =>
      supabase
        .from("stages")
        .select("*")
        .in("status", ["draft_open", "locked"])
        .order("ordinal", { ascending: true })
        .limit(1),
  );
  if (inProgress && inProgress.length > 0) return inProgress[0];

  const upcoming = await withRetry<StageRow[]>(
    "stage lookup",
    () =>
      supabase
        .from("stages")
        .select("*")
        .eq("status", "upcoming")
        .order("ordinal", { ascending: true })
        .limit(1),
  );
  if (upcoming && upcoming.length > 0) return upcoming[0];

  throw new Error(
    "no target stage found: no draft_open/locked stage and no upcoming stage remain",
  );
}

/**
 * A stage is addressable when we know which Tank01 week it maps to.
 *
 * The four postseason stages ship unaddressed on purpose: we never captured a
 * real playoff response, so their seasonType/week numbering is unconfirmed.
 * Sync jobs must check this and skip rather than send week=null to the API,
 * which would come back as an empty result and look like "no games this week"
 * instead of "this stage was never configured".
 */
export function isAddressable(
  stage: StageRow,
): stage is StageRow & { season_type: string; week_num: number } {
  return stage.season_type !== null && stage.week_num !== null;
}

/** Message used by every job that skips an unaddressed stage, so sync_log reads consistently. */
export function unaddressedStageMessage(stage: StageRow): string {
  return (
    `Stage "${stage.name}" (ordinal ${stage.ordinal}) has no Tank01 week ` +
    `addressing yet, so there is nothing to fetch. Confirm the playoff ` +
    `seasonType/week values against a real response and set season_type / ` +
    `week_num — see supabase/migrations/0006_tank01_stage_addressing.sql.`
  );
}

/**
 * The NFL season year to ask Tank01 for.
 *
 * ESPN's scoreboard implied the current season; Tank01 requires it explicitly.
 * A season is named for the calendar year it STARTS in, so January's playoffs
 * still belong to the previous year's season — getting this wrong would fetch
 * the wrong games every January. Override with the TANK01_SEASON env var when
 * backfilling a past season.
 */
export function currentSeason(now: Date = new Date()): number {
  const override = Deno.env.get("TANK01_SEASON");
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 2000) return n;
  }
  // Months are 0-based: 0-5 = Jan-Jun still belongs to last year's season.
  return now.getUTCMonth() <= 5
    ? now.getUTCFullYear() - 1
    : now.getUTCFullYear();
}
