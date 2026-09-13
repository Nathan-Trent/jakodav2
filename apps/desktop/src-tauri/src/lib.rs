// Native layer stays thin: window, the auto-updater and process relaunch.
// All business logic lives in the TS packages.
//
// Updater: installed copies check the GitHub Releases `latest.json` on
// launch and periodically (see src/lib/updater.ts). Downloads are verified
// against the public key in tauri.conf.json; the private half lives only
// in GitHub Actions secrets and is never on a developer machine.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
