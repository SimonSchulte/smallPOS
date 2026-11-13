// Service Worker: hält die App-Hülle offline bereit. Die API wird nie zwischengespeichert.
// Beim Ändern von Dateien in public/ die Versionsnummer erhöhen.
const CACHE = "kasse-shell-v1";
const SHELL = [
  "/",
  "/css/app.css",
  "/js/app.js",
  "/js/core.js",
  "/js/kasse.js",
  "/js/admin.js",
  "/js/api.js",
  "/js/catalog.js",
  "/js/store.js",
  "/js/sync.js",
  "/js/util.js",
  "/manifest.json",
  "/icon.svg",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Stale-while-revalidate: sofort aus dem Zwischenspeicher, im Hintergrund aktualisieren.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === "navigate" ? "/" : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }),
  );
});
