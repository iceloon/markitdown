use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use anyhow::{anyhow, Result};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use tokio::process::Command;
use uuid::Uuid;

use crate::models::{
    ConversionItem, ConversionItemState, ConversionJob, ConversionRunResult, PlannedConversion,
    ProgressTracker,
};
use crate::planner::plan;
use crate::runtime::RuntimeManager;

pub async fn run_conversion(
    app: &AppHandle,
    progress_event: &str,
    runtime_manager: &RuntimeManager,
    controller: &crate::ConversionController,
    job: ConversionJob,
) -> Result<ConversionRunResult> {
    runtime_manager.install_runtime_if_needed().await?;
    let executable_path = runtime_manager.ensure_markitdown_executable().await?;

    let planned_conversions = plan(&job)?;
    let mut tracker = ProgressTracker::new(planned_conversions.len());
    let mut items = Vec::new();
    let started_at = Instant::now();

    app.emit(progress_event, tracker.snapshot())?;

    for planned in planned_conversions {
        if controller.is_cancelled() {
            break;
        }

        tracker.begin(file_name(&planned.source_url));
        app.emit(progress_event, tracker.snapshot())?;

        if let Some(skip_reason) = planned.skip_reason.clone() {
            items.push(ConversionItem {
                source_url: planned.source_url.clone(),
                output_url: planned.output_url.clone(),
                state: ConversionItemState::Skipped,
                error_message: Some(skip_reason),
            });
            tracker.record(ConversionItemState::Skipped);
            app.emit(progress_event, tracker.snapshot())?;
            continue;
        }

        match convert_file(&executable_path, controller, &planned).await {
            Ok(()) => {
                items.push(ConversionItem {
                    source_url: planned.source_url.clone(),
                    output_url: planned.output_url.clone(),
                    state: ConversionItemState::Converted,
                    error_message: None,
                });
                tracker.record(ConversionItemState::Converted);
            }
            Err(error) => {
                if controller.is_cancelled() {
                    break;
                }

                items.push(ConversionItem {
                    source_url: planned.source_url.clone(),
                    output_url: planned.output_url.clone(),
                    state: ConversionItemState::Failed,
                    error_message: Some(error.to_string()),
                });
                tracker.record(ConversionItemState::Failed);
            }
        }

        app.emit(progress_event, tracker.snapshot())?;
    }

    let summary = tracker.summary(started_at.elapsed().as_secs_f64());
    Ok(ConversionRunResult {
        summary,
        items,
        cancelled: controller.is_cancelled(),
    })
}

async fn convert_file(
    executable_path: &Path,
    controller: &crate::ConversionController,
    planned: &PlannedConversion,
) -> Result<()> {
    let output_path = PathBuf::from(&planned.output_url);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let temporary_output = temporary_output_path(&output_path);
    if temporary_output.exists() {
        let _ = fs::remove_file(&temporary_output).await;
    }

    let mut command = Command::new(executable_path);
    command
        .arg(&planned.source_url)
        .arg("-o")
        .arg(&temporary_output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = command.spawn()?;
    controller.set_current_pid(child.id());
    let output = child.wait_with_output().await?;
    controller.set_current_pid(None);

    if controller.is_cancelled() {
        cleanup_temp_output(&temporary_output).await;
        return Ok(());
    }

    if !output.status.success() {
        cleanup_temp_output(&temporary_output).await;
        return Err(anyhow!(best_error_output(&output.stderr, &output.stdout)));
    }

    if !temporary_output.exists() {
        return Err(anyhow!(
            "转换未生成输出文件：{}",
            temporary_output.display()
        ));
    }

    if output_path.exists() {
        let _ = fs::remove_file(&output_path).await;
    }
    fs::rename(&temporary_output, &output_path).await?;

    Ok(())
}

async fn cleanup_temp_output(path: &Path) {
    let _ = fs::remove_file(path).await;
}

fn temporary_output_path(output_path: &Path) -> PathBuf {
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{}.tmp.md", Uuid::new_v4()))
}

fn best_error_output(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    "未知错误".into()
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|file_name| file_name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}
