use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use dirs::{data_dir, home_dir};
use serde::Deserialize;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::models::{ManagedRuntimePaths, RuntimeResolution, RuntimeSource, RuntimeStatus, RuntimeUpdatePlan};
use crate::versioning::{compare_versions, is_stable, latest_stable_version};

#[derive(Debug, Deserialize)]
struct PyPiResponse {
    info: PyPiInfo,
    releases: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct PyPiInfo {
    version: String,
}

pub struct RuntimeManager {
    app_folder_name: &'static str,
    home_directory: PathBuf,
    application_support_directory: PathBuf,
}

impl RuntimeManager {
    pub fn new() -> Self {
        let home_directory = home_dir().unwrap_or_else(|| PathBuf::from("/Users/Shared"));
        let application_support_directory = data_dir()
            .unwrap_or_else(|| home_directory.join("Library/Application Support"));

        Self {
            app_folder_name: "MarkItDownConverter",
            home_directory,
            application_support_directory,
        }
    }

    pub async fn scan_status(&self, fetch_latest: bool) -> Result<RuntimeStatus> {
        let resolution = self.resolve_runtime().await?;
        let mut latest_version = None;
        let mut last_checked_at = None;
        let mut last_error = None;

        if fetch_latest {
            match self.latest_stable_version().await {
                Ok(version) => {
                    latest_version = version;
                    last_checked_at = Some(iso_timestamp());
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                }
            }
        }

        let has_update_available = matches!(
            (&resolution, &latest_version),
            (Some(runtime), Some(latest)) if compare_versions(&runtime.installed_version, latest).is_lt()
        );

        Ok(RuntimeStatus {
            is_ready: resolution.is_some(),
            runtime_source: resolution
                .as_ref()
                .map(|runtime| runtime.source)
                .unwrap_or(RuntimeSource::Unavailable),
            executable_path: resolution.as_ref().map(|runtime| runtime.executable_path.clone()),
            supports_in_app_update: resolution
                .as_ref()
                .map(|runtime| runtime.supports_in_app_update)
                .unwrap_or(true),
            installed_version: resolution.as_ref().map(|runtime| runtime.installed_version.clone()),
            latest_version,
            last_checked_at,
            last_error,
            has_update_available,
        })
    }

    pub async fn install_runtime_if_needed(&self) -> Result<RuntimeStatus> {
        if self.resolve_runtime().await?.is_none() {
            self.ensure_managed_markitdown_installed().await?;
        }

        self.scan_status(false).await
    }

    pub async fn update_runtime(&self) -> Result<RuntimeStatus> {
        if let Some(runtime) = self.resolve_runtime().await? {
            if let Some(update_plan) = runtime.update_plan {
                let result = run_command(
                    Path::new(&update_plan.executable_path),
                    &update_plan.arguments,
                    &update_plan.environment,
                )
                .await?;

                if !result.success {
                    return Err(anyhow!(
                        "{} 执行失败：{}",
                        update_plan.command_description,
                        result.best_error_output()
                    ));
                }
            } else {
                return Err(anyhow!("当前运行时来源不支持应用内直接更新。"));
            }
        } else {
            self.ensure_managed_markitdown_installed().await?;
        }

        self.scan_status(true).await
    }

    pub async fn ensure_markitdown_executable(&self) -> Result<PathBuf> {
        if let Some(runtime) = self.resolve_runtime().await? {
            return Ok(PathBuf::from(runtime.executable_path));
        }

        self.ensure_managed_markitdown_installed().await?;

        self.resolve_runtime()
            .await?
            .map(|runtime| PathBuf::from(runtime.executable_path))
            .ok_or_else(|| anyhow!("未能定位可用的 markitdown 可执行文件。"))
    }

    pub fn managed_runtime_root(&self) -> PathBuf {
        self.application_support_directory.join(self.app_folder_name).join("runtime")
    }

    async fn resolve_runtime(&self) -> Result<Option<RuntimeResolution>> {
        if let Some(runtime) = self.detect_codex_shared_runtime().await? {
            return Ok(Some(runtime));
        }

        if let Some(runtime) = self.detect_system_runtime().await? {
            return Ok(Some(runtime));
        }

        if let Some(runtime) = self.detect_managed_runtime().await? {
            return Ok(Some(runtime));
        }

        Ok(None)
    }

    async fn latest_stable_version(&self) -> Result<Option<String>> {
        let response = reqwest::Client::new()
            .get("https://pypi.org/pypi/markitdown/json")
            .send()
            .await?
            .error_for_status()?
            .json::<PyPiResponse>()
            .await?;

        let mut versions: Vec<String> = response.releases.keys().cloned().collect();
        if is_stable(&response.info.version) {
            versions.push(response.info.version);
        }

        Ok(latest_stable_version(versions))
    }

    async fn detect_codex_shared_runtime(&self) -> Result<Option<RuntimeResolution>> {
        let executable_path = self
            .home_directory
            .join(".local/share/uv/tools/markitdown-mcp/bin/markitdown");

        let Some(installed_version) = executable_version(&executable_path).await? else {
            return Ok(None);
        };

        let shared_uv = self.home_directory.join(".local/bin/uv");
        let supports_in_app_update = is_executable(&shared_uv);

        Ok(Some(RuntimeResolution {
            source: RuntimeSource::CodexShared,
            executable_path: executable_path.to_string_lossy().into_owned(),
            installed_version,
            supports_in_app_update,
            update_plan: supports_in_app_update.then(|| RuntimeUpdatePlan {
                executable_path: shared_uv.to_string_lossy().into_owned(),
                arguments: vec!["tool".into(), "upgrade".into(), "markitdown-mcp".into()],
                environment: Vec::new(),
                command_description: "uv tool upgrade markitdown-mcp".into(),
            }),
        }))
    }

    async fn detect_system_runtime(&self) -> Result<Option<RuntimeResolution>> {
        for candidate in system_markitdown_candidates(&self.home_directory) {
            let Some(installed_version) = executable_version(&candidate).await? else {
                continue;
            };

            return Ok(Some(RuntimeResolution {
                source: RuntimeSource::SystemExisting,
                executable_path: candidate.to_string_lossy().into_owned(),
                installed_version,
                supports_in_app_update: false,
                update_plan: None,
            }));
        }

        Ok(None)
    }

    async fn detect_managed_runtime(&self) -> Result<Option<RuntimeResolution>> {
        let paths = self.managed_paths();
        let Some(installed_version) = executable_version(&paths.markitdown_binary_path).await? else {
            return Ok(None);
        };

        let uv_binary = self.ensure_uv_binary_for_managed_runtime().await?;
        Ok(Some(RuntimeResolution {
            source: RuntimeSource::AppManaged,
            executable_path: paths.markitdown_binary_path.to_string_lossy().into_owned(),
            installed_version,
            supports_in_app_update: true,
            update_plan: Some(RuntimeUpdatePlan {
                executable_path: uv_binary.to_string_lossy().into_owned(),
                arguments: vec!["tool".into(), "upgrade".into(), "markitdown".into()],
                environment: managed_uv_environment(&paths),
                command_description: "uv tool upgrade markitdown".into(),
            }),
        }))
    }

    async fn ensure_managed_markitdown_installed(&self) -> Result<()> {
        let uv_binary = self.ensure_uv_binary_for_managed_runtime().await?;
        let paths = self.managed_paths();

        create_managed_directories(&paths).await?;

        let result = run_command(
            &uv_binary,
            &[
                "tool".into(),
                "install".into(),
                "--force".into(),
                "--python-preference".into(),
                "only-managed".into(),
                "markitdown[all]".into(),
            ],
            &managed_uv_environment(&paths),
        )
        .await?;

        if !result.success {
            return Err(anyhow!(
                "uv tool install markitdown[all] 执行失败：{}",
                result.best_error_output()
            ));
        }

        Ok(())
    }

    async fn ensure_uv_binary_for_managed_runtime(&self) -> Result<PathBuf> {
        let paths = self.managed_paths();
        if is_executable(&paths.uv_binary_path) {
            return Ok(paths.uv_binary_path);
        }

        let shared_uv = self.home_directory.join(".local/bin/uv");
        if is_executable(&shared_uv) {
            return Ok(shared_uv);
        }

        if let Some(path_uv) = system_uv_binary(&self.home_directory) {
            return Ok(path_uv);
        }

        create_managed_directories(&paths).await?;
        self.install_uv_into_managed_runtime(&paths).await?;
        Ok(paths.uv_binary_path)
    }

    async fn install_uv_into_managed_runtime(&self, paths: &ManagedRuntimePaths) -> Result<()> {
        let installer_script = reqwest::Client::new()
            .get("https://astral.sh/uv/install.sh")
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
            .context("无法下载 uv 安装脚本")?;

        let installer_path = paths.runtime_root.join("uv-installer.sh");
        let mut file = fs::File::create(&installer_path).await?;
        file.write_all(installer_script.as_bytes()).await?;
        file.flush().await?;

        let result = run_command(
            Path::new("/bin/sh"),
            &[installer_path.to_string_lossy().into_owned()],
            &[
                ("UV_UNMANAGED_INSTALL".into(), paths.runtime_bin_dir.to_string_lossy().into_owned()),
                ("UV_NO_MODIFY_PATH".into(), "1".into()),
            ],
        )
        .await?;

        let _ = fs::remove_file(&installer_path).await;

        if !result.success {
            return Err(anyhow!(
                "安装 uv 失败：{}",
                result.best_error_output()
            ));
        }

        if !is_executable(&paths.uv_binary_path) {
            return Err(anyhow!("uv 安装完成后仍未找到可执行文件。"));
        }

        Ok(())
    }

    fn managed_paths(&self) -> ManagedRuntimePaths {
        let runtime_root = self.managed_runtime_root();
        let runtime_bin_dir = runtime_root.join("bin");
        let tool_dir = runtime_root.join("tools");
        let tool_bin_dir = runtime_root.join("tool-bin");
        let python_dir = runtime_root.join("python");
        let cache_dir = runtime_root.join("cache");

        ManagedRuntimePaths {
            runtime_root: runtime_root.clone(),
            runtime_bin_dir: runtime_bin_dir.clone(),
            uv_binary_path: runtime_bin_dir.join("uv"),
            tool_dir: tool_dir.clone(),
            tool_bin_dir: tool_bin_dir.clone(),
            python_dir: python_dir.clone(),
            cache_dir: cache_dir.clone(),
            markitdown_binary_path: tool_bin_dir.join("markitdown"),
        }
    }
}

struct CommandResult {
    success: bool,
    stdout: String,
    stderr: String,
}

impl CommandResult {
    fn best_error_output(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_string();
        }

        let stdout = self.stdout.trim();
        if !stdout.is_empty() {
            return stdout.to_string();
        }

        "未知错误".into()
    }
}

async fn run_command(
    executable_path: &Path,
    arguments: &[String],
    environment: &[(String, String)],
) -> Result<CommandResult> {
    let mut command = Command::new(executable_path);
    command.args(arguments);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.envs(environment.iter().cloned());

    let output = command
        .output()
        .await
        .with_context(|| format!("无法执行命令：{}", executable_path.display()))?;

    Ok(CommandResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

async fn executable_version(executable_path: &Path) -> Result<Option<String>> {
    if !is_executable(executable_path) {
        return Ok(None);
    }

    let result = run_command(executable_path, &["--version".into()], &[]).await?;
    if !result.success {
        return Ok(None);
    }

    let version = result.stdout.trim().to_string();
    if version.is_empty() {
        Ok(None)
    } else {
        Ok(Some(version))
    }
}

fn system_markitdown_candidates(home_directory: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let candidate_paths = [
        which::which("markitdown").ok(),
        Some(home_directory.join(".local/bin/markitdown")),
        Some(home_directory.join("bin/markitdown")),
        Some(PathBuf::from("/opt/homebrew/bin/markitdown")),
        Some(PathBuf::from("/usr/local/bin/markitdown")),
        Some(PathBuf::from("/usr/bin/markitdown")),
    ];

    for candidate in candidate_paths.into_iter().flatten() {
        if seen.insert(candidate.clone()) {
            candidates.push(candidate);
        }
    }

    candidates
}

fn system_uv_binary(home_directory: &Path) -> Option<PathBuf> {
    let candidates = [
        which::which("uv").ok(),
        Some(home_directory.join(".local/bin/uv")),
        Some(PathBuf::from("/opt/homebrew/bin/uv")),
        Some(PathBuf::from("/usr/local/bin/uv")),
    ];

    candidates.into_iter().flatten().find(|candidate| is_executable(candidate))
}

fn create_managed_directories(paths: &ManagedRuntimePaths) -> impl std::future::Future<Output = Result<()>> + '_ {
    async move {
        for directory in [
            &paths.runtime_root,
            &paths.runtime_bin_dir,
            &paths.tool_dir,
            &paths.tool_bin_dir,
            &paths.python_dir,
            &paths.cache_dir,
        ] {
            fs::create_dir_all(directory).await?;
        }

        Ok(())
    }
}

fn managed_uv_environment(paths: &ManagedRuntimePaths) -> Vec<(String, String)> {
    vec![
        ("UV_TOOL_DIR".into(), paths.tool_dir.to_string_lossy().into_owned()),
        (
            "UV_TOOL_BIN_DIR".into(),
            paths.tool_bin_dir.to_string_lossy().into_owned(),
        ),
        (
            "UV_PYTHON_INSTALL_DIR".into(),
            paths.python_dir.to_string_lossy().into_owned(),
        ),
        ("UV_CACHE_DIR".into(), paths.cache_dir.to_string_lossy().into_owned()),
    ]
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    now.to_string()
}
