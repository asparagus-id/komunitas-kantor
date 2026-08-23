# Sistem Pengingat Sholat & Bot Komunitas

Satu repo untuk semua bagian sistem. Lihat `PANDUAN-INSTALASI.md` di root repo ini untuk langkah instalasi lengkap dari nol.

## Struktur folder

```
adzan/     -> Situs "Pengingat Adzan" (di-deploy ke Cloudflare Pages)
admin/     -> Panel admin bot komunitas (di-deploy ke Cloudflare Pages, terpisah dari adzan/)
worker/    -> Source code bot Telegram (di-deploy manual ke Cloudflare Worker, copy-paste)
data/      -> Dibuat OTOMATIS oleh bot saat pertama kali jalan (database JSON-nya) -- jangan diedit manual
```

## Cara update tiap bagian setelah repo ini berubah

- **adzan/** dan **admin/** — kalau sudah dihubungkan ke Cloudflare Pages lewat Git (lihat panduan), otomatis re-deploy sendiri tiap kali ada perubahan di-push ke repo ini. Tidak perlu langkah manual.
- **worker/worker-komunitas.js** — Cloudflare Worker TIDAK otomatis update dari sini (supaya tidak perlu install `wrangler`). Kalau file ini diubah, buka lagi Worker di Cloudflare Dashboard > Edit code > hapus isi lama > tempel isi baru > Save and deploy.
- **data/komunitas-data.json** — jangan diedit langsung dari GitHub; ini "database" yang dibaca/ditulis otomatis oleh bot & panel admin.
