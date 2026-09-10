"use server";

import { createClient } from "@/lib/supabase/server";
import { sendToManagers } from "@/lib/push/send";

/**
 * Saves / removes the browser's Web Push subscription for the signed-in
 * manager. Writes go through the user's own client so RLS enforces that a
 * manager can only touch their own rows — the service-role client is used
 * only for sending (src/lib/push/send.ts).
 */

export interface SaveSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export async function saveSubscription(
  input: SaveSubscriptionInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  if (!input.endpoint || !input.p256dh || !input.auth) {
    return { ok: false, error: "Incomplete push subscription from the browser." };
  }

  // onConflict endpoint: a browser that re-subscribes (permission re-granted,
  // keys rotated) must update its row, not add a second one that would
  // deliver every notification twice.
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        manager_id: user.id,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent ?? null,
        last_failure_at: null,
      },
      { onConflict: "endpoint" },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function removeSubscription(
  endpoint: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("manager_id", user.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Sends a test notification to the signed-in manager's own devices.
 *
 * This is the only way to prove the delivery path end to end: the VAPID
 * private key is stored write-only, so a push can only ever be signed by the
 * deployed app, never from a laptop. Each manager can therefore verify their
 * own phone without waiting for a real draft event — and without anyone being
 * able to send test pushes to anybody else's device.
 */
export async function sendTestNotification(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { sent, failed } = await sendToManagers([user.id], {
    title: "Notifications are working",
    body: "This is what a TD's Only alert looks like. You're all set.",
    url: "/",
    tag: "test",
  });

  if (sent === 0) {
    return {
      ok: false,
      error: failed > 0
        ? "The push service rejected it. Try turning notifications off and on again."
        : "No subscription found for this device. Turn notifications on first.",
    };
  }
  return { ok: true };
}
