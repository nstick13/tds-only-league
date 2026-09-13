// Retry policy for supabase-js queries in the sync Edge Functions.
//
// Deliberately kept free of any Deno or network imports so the unit tests in
// __tests__/ can import the modules that use it without pulling in a Supabase
// client over the wire.

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
