// Bump this whenever the generated shell changes so an older broken worker
// cannot keep serving stale hashed bundles during local or Pages deployment.
const CACHE = "neko-reader-shell-v27";
const APP_SHELL = new URL("./", self.registration.scope).toString();
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([APP_SHELL, new URL("manifest.webmanifest", APP_SHELL).toString()])).then(() => self.skipWaiting()));
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
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
      // Clone while the body is still untouched. Cloning inside the async
      // caches.open() callback races the browser consuming the response.
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(APP_SHELL, copy)).catch(() => undefined);
      return response;
    }).catch(() => caches.match(APP_SHELL)));
    return;
  }
  // Non-navigation requests are deliberately not cached here. In particular,
  // same-origin EPUB/PDF/CBZ responses must never grow Cache Storage.
});
