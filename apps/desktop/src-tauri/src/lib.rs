// Native layer stays thin: window + (later) local storage and barcode-scanner
// device access. All business logic lives in the TS packages.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
