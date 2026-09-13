// Supabase client for Edge Function sync jobs.
//
// Uses the SERVICE ROLE key (never the anon key) so these jobs bypass RLS —
// that's correct here: sync jobs write league-wide data (players, scores,
// stage locks) on behalf of the system, not on behalf of any one
// authenticated user. See docs/ARCHITECTURE.md ("Roles model" section) for
// why this is the sanctioned use of the service role key.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. " +
        "Set them with `supabase secrets set` (see supabase/functions/README.md).",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Re-exported so callers can keep importing it from db.ts alongside the client.
export { withRetry } from "./retry.ts";
export type { QueryResult } from "./retry.ts";

export type SyncStatus = "success" | "error";

/** Write one row to sync_log. Never throws — a logging failure should not mask the real error. */
export async function writeSyncLog(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  source: "players" | "schedule" | "scores" | "locks",
  status: SyncStatus,
  message: string,
  playerCount: number | null = null,
): Promise<void> {
  try {
    const { error } = await supabase.from("sync_log").insert({
      source,
      status,
      message,
      player_count: playerCount,
    });
    if (error) {
      console.error(`Failed to write sync_log row for ${source}:`, error);
    }
  } catch (err) {
    console.error(`Exception writing sync_log row for ${source}:`, err);
  }
}
