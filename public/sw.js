// Bump this whenever the generated shell changes so an older broken worker
// cannot keep serving stale hashed bundles during local or Pages deployment.
const CACHE = "neko-reader-shell-v25";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["./", "./manifest.webmanifest"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("neko-reader-shell-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      // Clone while the body is still untouched. Cloning inside the async
      // caches.open() callback races the browser consuming the response.
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      // Same rule for static assets: clone synchronously before returning the
      // original response to the page.
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
    }
    return response;
  })));
});
