import { createClient } from "@/lib/supabase/server";
import type { SyncLog, SyncSource } from "@/lib/types";

/** Per-source sync status: the newest sync_log row for each source, keyed by source. Backs the "loud staleness" UI (see StalenessBanner). */
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
 * League-wide cooldown on manual sync triggers: once anyone fires one from
 * the Commish page, nobody can fire another until an hour has passed. The
 * window is enforced in the database (claim_manual_sync in
 * supabase/migrations/0007_manual_sync_cooldown.sql) — this mirror exists
 * only so the UI can render the remaining time.
 */
export const MANUAL_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

/** Current state of that cooldown, for rendering the Sync Data panel. */
export interface ManualSyncCooldown {
  /** ISO timestamp of the most recent manual trigger, or null if there has never been one. */
  lastTriggeredAt: string | null;
  /** Which job that trigger ran. */
  lastSource: SyncSource | null;
  /** Display name of whoever fired it, when we can resolve it. */
  lastTriggeredBy: string | null;
  /** ISO timestamp when manual triggers unlock again, or null when they're available now. */
  availableAt: string | null;
}

/** Shape of the embedded profiles join below — one row, or null when triggered_by was cleared. */
type ManualSyncRunRow = {
  source: SyncSource;
  triggered_at: string;
  profiles: { display_name: string | null } | { display_name: string | null }[] | null;
};

/**
 * The newest manual_sync_runs row, turned into cooldown state. Reads (not
 * writes) go through the normal authenticated client — manual_sync_runs is
 * select-visible to everyone, and only its writes are locked behind the
 * security-definer claim/release functions.
 */
export async function getManualSyncCooldown(): Promise<ManualSyncCooldown> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("manual_sync_runs")
    .select("source, triggered_at, profiles:triggered_by (display_name)")
    .order("triggered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getManualSyncCooldown: ${error.message}`);

  const row = data as ManualSyncRunRow | null;
  if (!row) {
    return {
      lastTriggeredAt: null,
      lastSource: null,
      lastTriggeredBy: null,
      availableAt: null,
    };
  }

  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  const availableAtMs = new Date(row.triggered_at).getTime() + MANUAL_SYNC_COOLDOWN_MS;

  return {
    lastTriggeredAt: row.triggered_at,
    lastSource: row.source,
    lastTriggeredBy: profile?.display_name ?? null,
    availableAt: availableAtMs > Date.now() ? new Date(availableAtMs).toISOString() : null,
  };
}
