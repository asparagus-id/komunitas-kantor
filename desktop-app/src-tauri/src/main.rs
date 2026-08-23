#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Pengingat Sholat - Kantor
// Tauri cuma jadi "jendela pembungkus" untuk file yang sudah ada di
// folder public/ (index.html, sw.js, manifest.json) -- logic app-nya
// TIDAK diubah sama sekali dari versi web/PWA-nya, supaya kalau nanti
// index.html diupdate lagi, cukup timpa file di public/ lalu build ulang.

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error saat menjalankan Pengingat Sholat");
}
