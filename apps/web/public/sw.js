self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let payload = { title: "Planbraid update", body: "Project work changed", url: "/" };
  try { payload = { ...payload, ...event.data.json() }; } catch { if (event.data) payload.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/planbraid-mark.png",
    badge: "/planbraid-mark.png",
    tag: payload.tag || "planbraid-update",
    data: { url: payload.url || "/" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) { if ("focus" in client) { client.navigate(url); return client.focus(); } }
    return self.clients.openWindow(url);
  }));
});
