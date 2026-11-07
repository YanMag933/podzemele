const CACHE = "dungeoneer-v12";
const ASSETS = [
  "./index.html",
  "./css/app.css?v=12",
  "./js/app.js?v=12",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/tesseract.min.js",
  "./vendor/worker.min.js",
  "./vendor/tesseract-core-simd-lstm.wasm.js",
  "./vendor/tesseract-core-simd-lstm.wasm",
  "./vendor/lang/rus.traineddata.gz",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
