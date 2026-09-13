// apply-locks
//
// Automates "rosters lock at first kickoff" server-side, independent of
// anyone having the app open. Finds every stage with status='draft_open'
// whose first_kickoff_at is set and has passed, and flips it to 'locked'.
// Idempotent: running it repeatedly with nothing newly due is a no-op
// (still logs a success row with locked=0).
//
// Invoke: POST (no body needed).
import { getServiceClient, withRetry, writeSyncLog } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const supabase = getServiceClient();

  try {
    const nowIso = new Date().toISOString();

    // Retried: this read fails with a bare "Gateway Timeout" often enough to
    // be worth riding out (33 of 54 runs on 2026-09-13). Note that the LOCK
    // itself no longer depends on this job succeeding — the roster_picks RLS
    // policies check the clock directly as of
    // 0014_lock_rosters_by_clock.sql — so a run that fails anyway now leaves
    // a stale-looking screen rather than an editable roster.
    const due = await withRetry<{ id: number; name: string }[]>(
      "stages select",
      () =>
        supabase
          .from("stages")
          .select("id, name, first_kickoff_at")
          .eq("status", "draft_open")
          .not("first_kickoff_at", "is", null)
          .lte("first_kickoff_at", nowIso),
    );

    if (!due || due.length === 0) {
      await writeSyncLog(
        supabase,
        "locks",
        "success",
        "No draft_open stages past their first_kickoff_at — nothing to lock.",
        null,
      );
      return jsonResponse({ ok: true, lockedCount: 0, lockedStages: [] });
    }

    const ids = due.map((s: { id: number }) => s.id);
    // Safe to retry: the .eq("status","draft_open") re-check makes the update
    // idempotent, so a replay after a timeout cannot re-lock or clobber a
    // stage someone else moved on in the meantime.
    await withRetry(
      "stages lock update",
      () =>
        supabase
          .from("stages")
          .update({ status: "locked" })
          .in("id", ids)
          .eq("status", "draft_open"),
    );

    const names = due.map((s: { name: string }) => s.name).join(", ");
    const msg = `Locked ${due.length} stage(s): ${names}`;
    await writeSyncLog(supabase, "locks", "success", msg, null);

    return jsonResponse({
      ok: true,
      lockedCount: due.length,
      lockedStages: due.map((s: { id: number; name: string }) => ({
        id: s.id,
        name: s.name,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncLog(supabase, "locks", "error", msg, null);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
