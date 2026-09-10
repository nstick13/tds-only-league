// Service worker for TD's Only League.
//
// Exists for one reason: iOS will not deliver Web Push to a site without a
// registered service worker, and only then when the site has been added to
// the home screen. There is deliberately NO offline caching here — the league
// data is live and a stale cached scoreboard during a draft would be worse
// than a spinner.

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every old tab to close;
  // there is no cached state to migrate, so activation is always safe.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Payload is JSON written by src/lib/push/send.ts. Fall back to a generic
  // notification rather than dropping it: iOS revokes push permission from
  // apps that receive a push and show nothing.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "TD's Only League";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Collapses repeats of the same kind of alert (a re-sent "you're on the
    // clock") into one notification instead of stacking them.
    tag: payload.tag || "tds-only",
    renotify: Boolean(payload.tag),
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reuse an already-open tab when there is one — on a phone this is the
      // difference between jumping to the draft and opening a second copy.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
