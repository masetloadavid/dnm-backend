const CACHE_NAME = "booking-crm-v36";

const APP_FILES = [
  "/",
  "/login.html",
  "/business-dashboard.html",
  "/business-leads.html",
  "/business-affiliates.html",
  "/business-analytics.html",
  "/manifest.json",
  "/divine-sleep-logo.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
