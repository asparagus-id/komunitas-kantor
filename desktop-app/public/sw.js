/* ============================================================
   Service Worker — Pengingat Sholat (Kantor)
   Cache app-shell (halaman + manifest) supaya bisa dibuka offline
   dan lebih cepat, dengan pola yang SAMA seperti project hafalan:
   MODE PAKSA UPDATE — begitu ada versi baru terdeteksi, service worker
   baru langsung aktif dan halaman otomatis reload sendiri (lihat
   controllerchange di index.html), tanpa perlu klik apa pun.

   NAIKKAN APP_VERSION setiap kali index.html diubah, lalu
   deploy ulang -- itu satu-satunya cara pengguna dapat versi terbaru.
   Nilai ini SENGAJA dipisah dari CACHE_VERSION di bawah supaya nomor
   versi yang tampil di layar (lewat window.APP_VERSION di halaman)
   selalu sinkron dengan cache yang sedang dipakai.
   ============================================================ */
const APP_VERSION = "1.10.0";
const CACHE_NAME = "pengingat-sholat-" + APP_VERSION;

// Cache TERPISAH untuk aset pihak ketiga yang memang tidak pernah
// berubah (font Google) -- sengaja tidak ikut CACHE_VERSION di atas,
// supaya tidak ikut terhapus tiap kali app di-update.
const FONT_CACHE_NAME = "pengingat-sholat-fonts-v1";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// File same-origin yang wajib ada supaya app bisa dibuka offline.
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
];

// Host yang SENGAJA dilewatkan dari cache: API jadwal sholat (AlAdhan)
// -- harus selalu ambil data terbaru dari network, tidak boleh cache,
// supaya jadwal yang tampil tidak pernah basi.
const NEVER_CACHE_HOSTS = ["api.aladhan.com"];

/* ---------- INSTALL: simpan app-shell ke cache ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // ditambahkan satu per satu & diabaikan kalau gagal, supaya
      // instalasi tidak batal hanya karena 1 file hilang/belum ada.
      return Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.log("SW: gagal cache", url, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

/* ---------- MESSAGE: terima sinyal "SKIP_WAITING" dari halaman ---------- */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------- ACTIVATE: bersihkan cache versi lama ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("pengingat-sholat-") && key !== CACHE_NAME && key !== FONT_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/* ---------- FETCH ---------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // API jadwal sholat: SELALU lewat network apa adanya, jangan disentuh
  // sama sekali (biar tidak ada risiko basi/CORS aneh).
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Font Google: cache-first PERMANEN, karena isinya tidak pernah berubah.
  if (!isSameOrigin && FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(FONT_CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
        })
      )
    );
    return;
  }

  if (!isSameOrigin) return; // domain lain (mis. tempat file mp3 diambil) biarkan lewat apa adanya

  // App-shell same-origin: stale-while-revalidate (langsung kasih versi
  // cache kalau ada, sambil diam-diam ambil versi baru dari network buat
  // dipakai lain kali).
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached); // offline & tidak ada di cache -> gagal senyap
      return cached || networkFetch;
    })
  );
});
