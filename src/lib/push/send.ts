import "server-only";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import { serviceRoleEnv } from "@/lib/supabase/env";

/**
 * Web Push sending. Server-only: the VAPID private key must never reach a
 * browser bundle, hence the "server-only" import guard.
 *
 * The league sends two kinds of notification — a draft is open / you are on
 * the clock, and a week has been finalized. Most originate from server
 * actions; the hourly "still your pick" reminder comes from a pg_cron call to
 * /api/cron/draft-reminders (see src/lib/push/reminders.ts).
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should land. Relative to the app origin. */
  url?: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag?: string;
}

let configured = false;

/**
 * Returns true when VAPID keys are present. Sending is deliberately optional:
 * if the keys are not set the app must still draft and finalize normally, so
 * every send path degrades to a no-op rather than throwing.
 */
function configure(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return false;

  if (!configured) {
    // The subject must be a mailto: or https: URL identifying the sender —
    // push services reject a JWT without one.
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT?.trim() || "mailto:commish@tds-only-league.app",
      publicKey,
      privateKey,
    );
    configured = true;
  }
  return true;
}

/** Service-role client: the sender must read every manager's subscriptions, which RLS hides from normal users. */
function adminClient() {
  const { url, serviceKey } = serviceRoleEnv();
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Sends a notification to every device belonging to the given managers.
 *
 * Never throws: a failed notification must not roll back the draft pick or
 * finalize that triggered it. Callers get a count back and can ignore it.
 */
export async function sendToManagers(
  managerIds: string[],
  payload: PushPayload,
  /** Skip some devices — the reminder job uses this to stay quiet overnight in each device's zone. */
  includeDevice?: (device: { timeZone: string | null }) => boolean,
): Promise<{ sent: number; failed: number }> {
  if (managerIds.length === 0) return { sent: 0, failed: 0 };
  if (!configure()) return { sent: 0, failed: 0 };

  let supabase;
  try {
    supabase = adminClient();
  } catch {
    // serviceRoleEnv() throws when the key is unset — same no-op contract.
    return { sent: 0, failed: 0 };
  }

  const query = (columns: string) =>
    supabase.from("push_subscriptions").select(columns).in("manager_id", managerIds);
  let { data, error } = await query("id, endpoint, p256dh, auth, time_zone");
  if (error) {
    // time_zone arrives with 0016_draft_reminders.sql. If the app deploys
    // before that migration runs, every push must not go dark with it.
    ({ data, error } = await query("id, endpoint, p256dh, auth"));
  }

  if (error || !data) return { sent: 0, failed: 0 };
  const rows = data as unknown as Record<string, unknown>[];
  const devices = includeDevice
    ? rows.filter((row) => includeDevice({ timeZone: (row.time_zone as string | null) ?? null }))
    : rows;
  if (devices.length === 0) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  const goneIds: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    devices.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint as string,
            keys: { p256dh: row.p256dh as string, auth: row.auth as string },
          },
          body,
        );
        sent++;
      } catch (err) {
        failed++;
        // 404/410 mean the browser threw the subscription away (app deleted,
        // permission revoked, home-screen icon removed). Those rows are dead
        // forever, so drop them instead of retrying every week.
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) goneIds.push(row.id as string);
        else console.error("push send failed", status, String(err));
      }
    }),
  );

  if (goneIds.length > 0) {
    await supabase.from("push_subscriptions").delete().in("id", goneIds);
  }

  return { sent, failed };
}

/** Every manager with a profile — used for league-wide announcements like a finalized week. */
export async function allManagerIds(): Promise<string[]> {
  try {
    const supabase = adminClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_player", true);
    if (error || !data) return [];
    return data.map((r) => r.id as string);
  } catch {
    return [];
  }
}
