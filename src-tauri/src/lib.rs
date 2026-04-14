mod conversion;
mod models;
mod planner;
mod runtime;
mod versioning;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use models::{
    ConversionJob, ConversionRunResult, RuntimeStatus, SourceSelectionMode,
};
use rfd::FileDialog;
use tauri::{AppHandle, Emitter, State};

use crate::conversion::run_conversion;
use crate::runtime::RuntimeManager;

const PROGRESS_EVENT: &str = "conversion-progress";

#[derive(Default)]
struct ConversionController {
    running: AtomicBool,
    cancelled: AtomicBool,
    current_pid: Mutex<Option<u32>>,
}

impl ConversionController {
    fn begin(&self) -> Result<(), String> {
        let already_running = self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err();

        if already_running {
            return Err("当前已有转换任务正在执行。".into());
        }

        self.cancelled.store(false, Ordering::SeqCst);
        self.set_current_pid(None);
        Ok(())
    }

    fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.cancelled.store(false, Ordering::SeqCst);
        self.set_current_pid(None);
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn set_current_pid(&self, pid: Option<u32>) {
        if let Ok(mut current_pid) = self.current_pid.lock() {
            *current_pid = pid;
        }
    }

    fn current_pid(&self) -> Option<u32> {
        self.current_pid.lock().ok().and_then(|guard| *guard)
    }
}

struct AppState {
    runtime_manager: RuntimeManager,
    conversion_controller: ConversionController,
}

#[tauri::command]
async fn pick_source(kind: Option<String>) -> Result<Option<String>, String> {
    let mode = SourceSelectionMode::from_string(kind.as_deref());
    let selection = match mode {
        SourceSelectionMode::File => FileDialog::new().pick_file(),
        SourceSelectionMode::Directory => FileDialog::new().pick_folder(),
    };

    Ok(selection.map(path_buf_to_string))
}

#[tauri::command]
async fn pick_destination() -> Result<Option<String>, String> {
    Ok(FileDialog::new().pick_folder().map(path_buf_to_string))
}

#[tauri::command]
async fn scan_runtime_status(
    fetch_latest: Option<bool>,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    state
        .runtime_manager
        .scan_status(fetch_latest.unwrap_or(false))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn install_runtime_if_needed(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    state
        .runtime_manager
        .install_runtime_if_needed()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_runtime_update(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    state
        .runtime_manager
        .scan_status(true)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn update_runtime(state: State<'_, AppState>) -> Result<RuntimeStatus, String> {
    state
        .runtime_manager
        .update_runtime()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_conversion(
    job: ConversionJob,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConversionRunResult, String> {
    state.conversion_controller.begin()?;

    let result = run_conversion(
        &app,
        PROGRESS_EVENT,
        &state.runtime_manager,
        &state.conversion_controller,
        job,
    )
    .await;

    state.conversion_controller.finish();
    result.map_err(|error| error.to_string())
}

#[tauri::command]
async fn cancel_conversion(state: State<'_, AppState>) -> Result<(), String> {
    state.conversion_controller.cancel();

    if let Some(pid) = state.conversion_controller.current_pid() {
        let status = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .map_err(|error| format!("无法终止当前转换进程：{error}"))?;

        if !status.success() {
            return Err("转换任务取消请求已发出，但子进程未正常结束。".into());
        }
    }

    Ok(())
}

#[tauri::command]
async fn open_destination_in_finder(path: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg(Path::new(&path))
        .status()
        .map_err(|error| format!("无法在 Finder 中打开目录：{error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Finder 打开目标目录失败。".into())
    }
}

fn path_buf_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            runtime_manager: RuntimeManager::new(),
            conversion_controller: ConversionController::default(),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = app_handle.emit(PROGRESS_EVENT, serde_json::json!({}));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_source,
            pick_destination,
            scan_runtime_status,
            install_runtime_if_needed,
            check_runtime_update,
            update_runtime,
            start_conversion,
            cancel_conversion,
            open_destination_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
