#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// CCTV Backup Agent -- SENGAJA minim: tidak ada command/logic Rust
// khusus. Semua logic (polling CCTV, klaim server, kirim notifikasi)
// ada di index.html (JS), jalan lewat window.__TAURI__.http (bypass
// masalah mixed-content & CORS, sama pola dgn app Pengingat Sholat
// utama). Rust di sini cuma bootstrap window + autostart.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .run(tauri::generate_context!())
        .expect("error while running CCTV Backup Agent");
}
