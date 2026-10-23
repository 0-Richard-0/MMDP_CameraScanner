// Offline cache for Photo → Part Match. Bump CACHE on every release.
// Strategy: app files (html/css/js) are network-first so updates land on next open;
// big vendor assets are cache-first because they never change within a version.
const CACHE = "ppm-v1.6.1";
const APP_FILES = ["./", "index.html", "app.css", "app.js", "matcher.js", "manifest.webmanifest", "partlist.json"];
const PRECACHE = [
  ...APP_FILES,
  "icons/icon-192.png", "icons/icon-512.png",
  "vendor/xlsx.full.min.js", "vendor/ocr.bundle.js",
  "vendor/ort-wasm-simd-threaded.js", "vendor/ort-wasm-simd-threaded.wasm",
  "vendor/models/ch_PP-OCRv4_det_infer.onnx", "vendor/models/ch_PP-OCRv4_rec_infer.onnx", "vendor/models/ppocr_keys_v1.txt",
];

self.addEventListener("install", (e) => {
  // Add files one by one so an optional file (e.g. partlist.json in local dev) cannot block installation.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function isAppFile(url) {
  const name = url.pathname.replace(/^.*\//, "");
  return name === "" || APP_FILES.includes(name);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (isAppFile(url)) {
    // Revalidate with the server (bypass the browser HTTP cache) so a new release never mixes old/new files.
    e.respondWith(
      fetch(e.request, { cache: "no-cache" }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request)),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })),
  );
});
