/*
  Service Worker - Admin Bot Komunitas
  Strategi:
  - App shell (index.html, manifest, ikon) di-cache saat install -> bisa
    dibuka offline / dari homescreen tanpa loading kosong.
  - index.html dicoba dari network dulu (biar selalu dapat versi terbaru
    kalau online), fallback ke cache kalau offline.
  - Semua request ke Worker API (origin lain, mis. gus-asisten.workers.dev)
    TIDAK disentuh sama sekali -> selalu langsung ke network, karena data
    admin harus selalu real-time, bukan data basi dari cache.

  PENTING: naikkan CACHE_VERSION tiap kali index.html / ikon di-update,
  supaya klien lama otomatis ambil versi baru (pola sama seperti sw.js
  di aplikasi Habit).
*/
const CACHE_VERSION = "admkom-v13"; // naik dari v12 -- kartu Overview rekap puasa ikut tampilkan "Belum isi"
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-192.png",
  "./icons/icon-256.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Bukan origin sendiri (mis. panggilan ke Worker API, Google Fonts, Chart.js
  // CDN) -> biarkan lewat apa adanya, jangan diintersep/di-cache di sini.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // Navigasi / index.html: network-first, fallback ke cache kalau offline.
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Aset shell lain (ikon, manifest): cache-first, isi cache kalau belum ada.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      });
    })
  );
});
