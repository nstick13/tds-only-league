"use client";

import { useCallback, useEffect, useState } from "react";
import { PixelButton } from "@/components/ui/PixelButton";
import { PixelPanel } from "@/components/ui/PixelPanel";
import {
  removeSubscription,
  saveSubscription,
  sendTestNotification,
} from "@/app/(app)/settings/pushActions";

/**
 * Turns Web Push on or off for this browser.
 *
 * iOS is the constraint that shapes this component. Safari on iPhone only
 * exposes PushManager when the site has been added to the home screen and
 * opened from that icon — in a normal Safari tab the API is simply absent, so
 * "not supported" and "not installed yet" look identical and have to be told
 * apart by display-mode. It also requires the permission prompt to come from
 * a real tap, which is why subscribing happens in the click handler and never
 * in an effect.
 */

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes. Returns the
 * ArrayBuffer rather than the view: applicationServerKey is typed as
 * BufferSource, and a Uint8Array over a possibly-shared buffer doesn't
 * satisfy it.
 */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own flag, which predates display-mode and is still what
    // actually reports true for a home-screen launch.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof window === "undefined") return false;
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

type State = "loading" | "unsupported" | "needs-install" | "off" | "on";

export function NotificationToggle({ vapidPublicKey }: { vapidPublicKey: string }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;

    const hasApi = "serviceWorker" in navigator && "PushManager" in window;
    if (!hasApi) {
      // On iOS the API only appears for a home-screen install, so an iPhone
      // without it is a prompt to install rather than a dead end.
      setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      setState(existing ? "on" : "off");
    } catch {
      setState("off");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(
          permission === "denied"
            ? "Notifications are blocked for this app. Turn them back on in iOS Settings → Notifications → TD's Only."
            : "Notification permission wasn't granted.",
        );
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        // Required by every browser: each push must result in a visible
        // notification. Silent background pushes are not allowed.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
      });

      const json = subscription.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };

      const result = await saveSubscription({
        endpoint: json.endpoint ?? "",
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        userAgent: navigator.userAgent,
      });

      if (!result.ok) {
        // Don't leave a live browser subscription pointing at a row we failed
        // to store — it would receive nothing and look enabled.
        await subscription.unsubscribe();
        setError(result.error ?? "Couldn't save the subscription.");
        return;
      }

      setState("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      const result = await sendTestNotification();
      if (result.ok) {
        // iOS will not show a notification while the app is in the
        // foreground, so say where to look rather than leaving people
        // staring at a screen that never changes.
        setTestNote("Sent. Lock your phone or swipe to the home screen to see it.");
      } else {
        setError(result.error ?? "Couldn't send the test.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await removeSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PixelPanel className="flex flex-col gap-3">
      <h2 className="font-pixel text-sm text-retro-yellow">Notifications</h2>

      <p className="font-mono text-base text-retro-offwhite/80">
        Get a push when a draft opens, when you&apos;re on the clock, and when a week
        is final.
      </p>

      {state === "loading" ? (
        <p className="font-mono text-base text-retro-offwhite/60">Checking…</p>
      ) : state === "needs-install" ? (
        <div className="font-mono text-base text-retro-offwhite/80 flex flex-col gap-1">
          <p className="text-retro-yellow">Add TD&apos;s Only to your home screen first.</p>
          <p>
            In Safari, tap Share → <strong>Add to Home Screen</strong>, then open the app
            from that icon and come back here. iPhone only allows notifications for
            apps launched from the home screen.
          </p>
        </div>
      ) : state === "unsupported" ? (
        <p className="font-mono text-base text-retro-offwhite/60">
          This browser doesn&apos;t support push notifications.
        </p>
      ) : state === "on" ? (
        <div className="flex flex-col gap-3">
          <span className="font-mono text-base text-retro-green">
            On for this device.
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <PixelButton type="button" onClick={sendTest} disabled={busy}>
              {busy ? "Working…" : "Send Test"}
            </PixelButton>
            <PixelButton type="button" variant="secondary" onClick={disable} disabled={busy}>
              Turn Off
            </PixelButton>
          </div>
          {testNote ? (
            <p className="font-mono text-base text-retro-offwhite/80">{testNote}</p>
          ) : null}
        </div>
      ) : (
        <PixelButton type="button" onClick={enable} disabled={busy}>
          {busy ? "Working…" : "Turn On Notifications"}
        </PixelButton>
      )}

      {error ? <p className="font-mono text-base text-retro-red">{error}</p> : null}
    </PixelPanel>
  );
}
