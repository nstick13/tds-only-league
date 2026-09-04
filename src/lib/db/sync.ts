import { createClient } from "@/lib/supabase/server";
import type { SyncLog, SyncSource } from "@/lib/types";

/** Per-source sync status: the newest sync_log row for each source, keyed by source. Backs the Commish sync panel. */
export type SyncStatusMap = Partial<Record<SyncSource, SyncLog>>;

/**
 * The latest sync_log row per source (players/schedule/scores/locks).
 * Fetches recent rows ordered newest-first and keeps the first one seen
 * per source, so a single query covers all sources without N round trips.
 */
export async function getSyncStatus(): Promise<SyncStatusMap> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sync_log")
    .select("*")
    .order("ran_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`getSyncStatus: ${error.message}`);

  const result: SyncStatusMap = {};
  for (const row of (data ?? []) as SyncLog[]) {
    const source = row.source as SyncSource;
    if (!result[source]) result[source] = row;
  }
  return result;
}

/**
 * Cooldown on manual sync triggers: once anyone fires one from the Commish
 * page, that job is unavailable to everyone for an hour. The window is PER
 * JOB — a Players refresh doesn't block Scores. Enforced in the database
 * (claim_manual_sync, supabase/migrations/0008_per_source_sync_cooldown.sql);
 * this mirror exists only so the UI can render the remaining time.
 */
export const MANUAL_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

/** Cooldown state for one sync job, for rendering the Sync Data panel. */
export interface ManualSyncCooldown {
  /** ISO timestamp of the most recent manual trigger of this job. */
  lastTriggeredAt: string | null;
  /** Display name of whoever fired it, when we can resolve it. */
  lastTriggeredBy: string | null;
  /** ISO timestamp when this job unlocks again, or null when available now. */
  availableAt: string | null;
}

/** Per-source cooldown state, keyed by source. Absent = never triggered. */
export type ManualSyncCooldownMap = Partial<Record<SyncSource, ManualSyncCooldown>>;

/** Shape of the embedded profiles join below — one row, or null when triggered_by was cleared. */
type ManualSyncRunRow = {
  source: SyncSource;
  triggered_at: string;
  profiles: { display_name: string | null } | { display_name: string | null }[] | null;
};

/**
 * The newest manual_sync_runs row per source, turned into cooldown state.
 * One query covers every source: rows come back newest-first and the first
 * one seen per source wins, same approach as getSyncStatus above.
 *
 * Reads go through the normal authenticated client — manual_sync_runs is
 * select-visible to everyone, and only its writes are locked behind the
 * security-definer claim/release functions.
 */
export async function getManualSyncCooldowns(): Promise<ManualSyncCooldownMap> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("manual_sync_runs")
    .select("source, triggered_at, profiles:triggered_by (display_name)")
    .order("triggered_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(`getManualSyncCooldowns: ${error.message}`);

  const result: ManualSyncCooldownMap = {};
  for (const row of (data ?? []) as ManualSyncRunRow[]) {
    if (result[row.source]) continue;
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    const availableAtMs = new Date(row.triggered_at).getTime() + MANUAL_SYNC_COOLDOWN_MS;
    result[row.source] = {
      lastTriggeredAt: row.triggered_at,
      lastTriggeredBy: profile?.display_name ?? null,
      availableAt: availableAtMs > Date.now() ? new Date(availableAtMs).toISOString() : null,
    };
  }
  return result;
}

/** How fresh one source's data actually is, for the app-wide freshness line. */
export interface SourceFreshness {
  /** When this source last synced SUCCESSFULLY, or null if it never has. */
  lastSuccessAt: string | null;
  /** True when the most recent attempt failed — the last success may be older than it looks. */
  lastAttemptFailed: boolean;
}

/** Freshness per source, keyed by source. */
export type FreshnessMap = Partial<Record<SyncSource, SourceFreshness>>;

/**
 * Last SUCCESSFUL run per source, plus whether the newest attempt failed.
 *
 * Deliberately not getSyncStatus(): that returns the newest row whatever its
 * status, so a failed run would be reported as "updated just now" when the
 * data behind it is actually hours old. "Last updated" has to mean the last
 * time the data actually changed hands.
 */
export async function getSyncFreshness(): Promise<FreshnessMap> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sync_log")
    .select("source, status, ran_at")
    .order("ran_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(`getSyncFreshness: ${error.message}`);

  const result: FreshnessMap = {};
  for (const row of (data ?? []) as Pick<SyncLog, "source" | "status" | "ran_at">[]) {
    const existing = result[row.source];
    if (!existing) {
      result[row.source] = {
        lastSuccessAt: row.status === "success" ? row.ran_at : null,
        lastAttemptFailed: row.status === "error",
      };
      continue;
    }
    // Rows are newest-first, so the first success we meet is the latest one.
    if (existing.lastSuccessAt === null && row.status === "success") {
      existing.lastSuccessAt = row.ran_at;
    }
  }
  return result;
}
