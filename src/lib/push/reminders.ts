import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serviceRoleEnv } from "@/lib/supabase/env";
import { computeCurrentPick } from "@/components/draft/draftLogic";
import type { DraftOrderRow } from "@/lib/types";
import { sendToManagers } from "./send";

/**
 * "Still your pick" reminders. The on-the-clock push fires once, from the
 * pick that put you there; if you miss it the draft sits on you with nothing
 * else nudging you. This repeats it hourly until you pick.
 *
 * Driven by pg_cron (0016_draft_reminders.sql) calling
 * /api/cron/draft-reminders every 15 minutes — Vercel's own cron can't run
 * that often on every plan, and the league already schedules its jobs in
 * pg_cron. A 15-minute tick against a 1-hour interval means a reminder lands
 * between 60 and 75 minutes after the last one.
 *
 * draft_clock_reminders keeps one row per (stage, pick): when that pick's
 * clock started and when its manager was last pinged. The row is also the
 * lock — a reminder is sent only by the run that moves last_reminded_at
 * forward, so overlapping or retried cron calls can't double-send.
 */

export const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
/** Absorbs cron jitter so a reminder due at :00 isn't pushed to the :15 tick after it. */
const INTERVAL_SLACK_MS = 2 * 60 * 1000;

/** No reminders from 10 PM until 8 AM in the device's own time zone. */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;
/** Devices that never reported a zone — subscribed before zones were recorded. */
export const FALLBACK_TIME_ZONE = "America/New_York";

/** The hour (0–23) it is right now in `timeZone`; an unknown zone falls back to the league default. */
export function localHour(now: Date, timeZone: string | null): number {
  const format = (zone: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(now),
    );
  try {
    return format(timeZone || FALLBACK_TIME_ZONE);
  } catch {
    return format(FALLBACK_TIME_ZONE);
  }
}

export function isQuietHour(now: Date, timeZone: string | null): boolean {
  const hour = localHour(now, timeZone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

export function isReminderDue(lastRemindedAt: Date, now: Date): boolean {
  return now.getTime() - lastRemindedAt.getTime() >= REMINDER_INTERVAL_MS - INTERVAL_SLACK_MS;
}

/** "45m", "3h", "1h 20m" — how long the pick has been waiting. */
export function formatWaiting(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function adminClient() {
  const { url, serviceKey } = serviceRoleEnv();
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Notes that a pick's clock just started, so the first reminder is counted
 * from the on-the-clock push rather than from whenever the cron first looks.
 * Never throws — like every push path, it must not fail the pick that called it.
 */
export async function recordClockStart(
  stageId: number,
  pickNumber: number,
  managerId: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await adminClient().from("draft_clock_reminders").upsert(
      {
        stage_id: stageId,
        pick_number: pickNumber,
        manager_id: managerId,
        clock_started_at: now,
        last_reminded_at: now,
      },
      { onConflict: "stage_id,pick_number" },
    );
  } catch {
    // Without the row the cron job starts the clock itself, from the
    // previous pick's timestamp — slightly less precise, never wrong.
  }
}

export interface ReminderRunResult {
  stage: string;
  pickNumber: number | null;
  outcome: "draft_complete" | "not_due" | "quiet_hours" | "no_devices" | "claimed_elsewhere" | "sent";
}

/** One pass over every open draft. Safe to call as often as you like. */
export async function sendDueDraftReminders(now: Date = new Date()): Promise<ReminderRunResult[]> {
  const supabase = adminClient();

  const { data: stages, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, first_kickoff_at")
    .eq("status", "draft_open");
  if (stagesError) throw new Error(`stages select failed: ${stagesError.message}`);

  const results: ReminderRunResult[] = [];

  for (const stage of stages ?? []) {
    // Past kickoff nobody can pick (0014), so there is nothing to nag about
    // even if apply-locks hasn't flipped the status yet.
    if (stage.first_kickoff_at && new Date(stage.first_kickoff_at) <= now) continue;

    const [orderRes, picksRes] = await Promise.all([
      supabase
        .from("draft_order")
        .select("*")
        .eq("stage_id", stage.id)
        .order("pick_number", { ascending: true }),
      supabase
        .from("roster_picks")
        .select("created_at")
        .eq("stage_id", stage.id)
        .order("created_at", { ascending: false }),
    ]);
    if (orderRes.error) throw new Error(`draft_order select failed: ${orderRes.error.message}`);
    if (picksRes.error) throw new Error(`roster_picks select failed: ${picksRes.error.message}`);

    const picks = picksRes.data ?? [];
    const { pickNumber, managerId } = computeCurrentPick(
      orderRes.data as DraftOrderRow[],
      picks.length,
    );
    if (pickNumber === null || managerId === null) {
      results.push({ stage: stage.name, pickNumber, outcome: "draft_complete" });
      continue;
    }

    const { data: existing, error: rowError } = await supabase
      .from("draft_clock_reminders")
      .select("manager_id, clock_started_at, last_reminded_at")
      .eq("stage_id", stage.id)
      .eq("pick_number", pickNumber)
      .maybeSingle();
    if (rowError) throw new Error(`draft_clock_reminders select failed: ${rowError.message}`);

    let row = existing;
    if (!row || row.manager_id !== managerId) {
      // No record of this clock starting (a pick was undone, or the
      // on-the-clock push failed to write one), or the order was re-seeded
      // under it. The clock started at the last pick, or now if there is none.
      const started = (picks[0]?.created_at as string | undefined) ?? now.toISOString();
      row = { manager_id: managerId, clock_started_at: started, last_reminded_at: started };
      const { error: upsertError } = await supabase
        .from("draft_clock_reminders")
        .upsert({ stage_id: stage.id, pick_number: pickNumber, ...row }, { onConflict: "stage_id,pick_number" });
      if (upsertError) throw new Error(`draft_clock_reminders upsert failed: ${upsertError.message}`);
    }

    if (!isReminderDue(new Date(row.last_reminded_at), now)) {
      results.push({ stage: stage.name, pickNumber, outcome: "not_due" });
      continue;
    }

    const { data: devices } = await supabase
      .from("push_subscriptions")
      .select("time_zone")
      .eq("manager_id", managerId);
    if (!devices || devices.length === 0) {
      results.push({ stage: stage.name, pickNumber, outcome: "no_devices" });
      continue;
    }
    const awake = (d: { timeZone: string | null }) => !isQuietHour(now, d.timeZone);
    if (!devices.some((d) => awake({ timeZone: d.time_zone as string | null }))) {
      // Left due, so the first tick after 8 AM sends it.
      results.push({ stage: stage.name, pickNumber, outcome: "quiet_hours" });
      continue;
    }

    // Claim the reminder: only the run whose update matches the value it read
    // gets to send.
    const { data: claimed } = await supabase
      .from("draft_clock_reminders")
      .update({ last_reminded_at: now.toISOString() })
      .eq("stage_id", stage.id)
      .eq("pick_number", pickNumber)
      .eq("last_reminded_at", row.last_reminded_at)
      .select("stage_id");
    if (!claimed || claimed.length === 0) {
      results.push({ stage: stage.name, pickNumber, outcome: "claimed_elsewhere" });
      continue;
    }

    const waiting = formatWaiting(now.getTime() - new Date(row.clock_started_at).getTime());
    await sendToManagers(
      [managerId],
      {
        title: "Still your pick",
        body: `${stage.name} — pick #${pickNumber} has been waiting ${waiting}.`,
        url: "/draft",
        // Same tag as the on-the-clock push: replaces it on the lock screen,
        // and the service worker's renotify makes the phone buzz again.
        tag: "on-the-clock",
      },
      awake,
    );
    results.push({ stage: stage.name, pickNumber, outcome: "sent" });
  }

  return results;
}
