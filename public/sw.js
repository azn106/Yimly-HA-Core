const CACHE_NAME = "yimly-home-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// Install Event
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clientsClaim();
});

// Fetch Event with Network-First fallback to Cache
self.addEventListener("fetch", (e) => {
  // Avoid caching non-GET requests or APIs
  if (e.request.method !== "GET" || e.request.url.includes("/api/")) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Clone and put in cache if valid response
        if (res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, resClone);
          });
        }
        return res;
      })
      .catch(() => {
        return caches.match(e.request);
      })
  );
});
