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

/**
 * Failures that are worth trying again: the request never got a real answer,
 * as opposed to the database answering "no". A constraint violation or a
 * permission error is a fact about the data and will say the same thing on
 * every attempt — retrying those just burns time and hides the cause.
 */
const TRANSIENT = /gateway ?timeout|timed? ?out|temporar|50[234]|fetch failed|connection|socket|network|ECONNRESET|EAI_AGAIN/i;

/** The {data, error} envelope every supabase-js query resolves to. */
export interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/**
 * Run a supabase-js query, retrying only transient failures.
 *
 * `run` must BUILD the query as well as await it — a PostgrestBuilder is a
 * one-shot thenable, so reusing one would replay the first result instead of
 * making a second request.
 *
 * SCOPE, honestly stated: this covers brief blips, not outages. The
 * Gateway Timeouts that motivated it arrive in clusters lasting 15+ minutes
 * (see 0014_lock_rosters_by_clock.sql), which no amount of in-process
 * retrying will ride out. Anything whose CORRECTNESS depends on succeeding
 * within a deadline must be enforced where the deadline lives — in the
 * database — not by retrying harder out here.
 */
export async function withRetry<T>(
  label: string,
  run: () => PromiseLike<QueryResult<T>>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T | null> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  let lastMessage = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await run();
    if (!error) return data;

    lastMessage = error.message;
    if (!TRANSIENT.test(lastMessage) || attempt === attempts) break;
    console.warn(
      `${label}: attempt ${attempt}/${attempts} failed (${lastMessage}); retrying`,
    );
    await new Promise((r) => setTimeout(r, baseDelayMs * 3 ** (attempt - 1)));
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastMessage}`);
}

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
