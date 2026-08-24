#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Pengingat Sholat - Kantor
//
// PERILAKU (sesuai revisi terakhir):
//   - Begitu app dibuka (termasuk saat auto-start pas PC nyala), yang
//     tampil adalah jendela BIASA/PENUH ("main") -- SAMA seperti versi
//     sebelum ada mode widget. TIDAK otomatis mengecil sendiri.
//   - Widget kecil ("widget") HANYA muncul kalau diaktifkan MANUAL lewat
//     tombol "Tambah Widget" di dalam app, atau lewat menu system tray.
//   - Klik tombol minimize (_) di jendela utama -> app SEMBUNYI dari
//     taskbar bawah, cuma ada di system tray (pojok kanan bawah, dekat
//     jam) -- bukan minimize biasa yang masih nongol di taskbar.
//   - Klik tombol X (close) -> app JUGA cuma sembunyi ke tray (tidak
//     benar-benar keluar), supaya reminder tetap jalan di background.
//     Untuk keluar sungguhan, klik kanan ikon tray > Keluar.
//
// Auto-start: begitu app pertama kali dijalankan, otomatis didaftarkan
// supaya jalan sendiri tiap kali Windows nyala (lewat tauri-plugin-autostart,
// aman dipanggil berkali-kali / idempotent).

use tauri::{
    AppHandle, CustomMenuItem, Icon, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;

// Ikon tray DITANAM LANGSUNG ke dalam program (bukan dibaca dari file
// eksternal saat runtime) -- ini supaya tidak gagal senyap kalau path
// resource-nya bermasalah setelah proses install/bundling (ikon dari
// systemTray.iconPath di tauri.conf.json TETAP dipakai utk bundling/
// installer, tapi ikon yg dipasang ke tray SAAT APP JALAN pakai ini).
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");

fn build_tray_menu() -> SystemTrayMenu {
    SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("buka_penuh".to_string(), "Buka Tampilan Penuh"))
        .add_item(CustomMenuItem::new("tampilkan_widget".to_string(), "Tampilkan Widget"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("keluar".to_string(), "Keluar"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn show_widget_window(app: &AppHandle) {
    if let Some(widget) = app.get_window("widget") {
        let _ = widget.show();
        let _ = widget.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None, // tanpa argumen tambahan saat auto-start
        ))
        .setup(|app| {
            // Aktifkan auto-start begitu app pertama kali jalan (aman dipanggil
            // berkali-kali -- kalau sudah aktif, tidak ada efek/error apa pun).
            let autostart = app.autolaunch();
            let _ = autostart.enable();
            Ok(())
        })
        .system_tray(
            SystemTray::new()
                .with_icon(Icon::Raw(TRAY_ICON_BYTES.to_vec()))
                .with_menu(build_tray_menu()),
        )
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                // klik kiri ikon tray -> buka tampilan penuh (paling intuitif)
                show_main_window(app);
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "buka_penuh" => show_main_window(app),
                "tampilkan_widget" => show_widget_window(app),
                "keluar" => app.exit(0),
                _ => {}
            },
            _ => {}
        })
        .on_window_event(|event| {
            // klik tombol X di jendela "main" -> jangan ditutup total, cukup
            // sembunyikan ke tray (app tetap jalan di background, reminder
            // tetap terus dipantau). Widget TIDAK otomatis muncul di sini --
            // itu murni pilihan manual pengguna.
            if event.window().label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                    api.prevent_close();
                    let _ = event.window().hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error saat menjalankan Pengingat Sholat");
}
