/* Fractal dashboard service worker — enables background notifications for captcha alerts. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "captcha-focus", link: event.notification.data?.link || null });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "captcha-notify") {
    const title = data.title || "6b6t captcha";
    const body = data.body || "Solve the captcha, then rejoin.";
    const link = data.link || null;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag: "fractal-captcha",
        renotify: true,
        requireInteraction: true,
        data: { url: data.url || "/#detect", link },
        actions: link
          ? [
              { action: "open", title: "Open captcha" },
              { action: "dashboard", title: "Open dashboard" },
            ]
          : [{ action: "dashboard", title: "Open dashboard" }],
      }),
    );
    return;
  }
  if (data.type === "detection-notify") {
    const title = data.title || "Detection";
    const body = data.body || "";
    const tag = data.tag || "fractal-detection";
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        requireInteraction: false,
        data: { url: data.url || "/#detect" },
        actions: [{ action: "dashboard", title: "Open Detect" }],
      }),
    );
  }
});
