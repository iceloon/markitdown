use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSource {
    Unavailable,
    CodexShared,
    SystemExisting,
    AppManaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversionItemState {
    Pending,
    Converting,
    Converted,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSelectionMode {
    File,
    Directory,
}

impl SourceSelectionMode {
    pub fn from_string(value: Option<&str>) -> Self {
        match value {
            Some("directory") => Self::Directory,
            _ => Self::File,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionJob {
    pub source_url: String,
    pub source_kind: SourceKind,
    pub destination_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedConversion {
    pub source_url: String,
    pub output_url: String,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionItem {
    pub source_url: String,
    pub output_url: String,
    pub state: ConversionItemState,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionProgress {
    pub total_count: usize,
    pub processed_count: usize,
    pub converted_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub fraction_completed: f64,
    pub current_file: Option<String>,
}

impl ConversionProgress {
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionSummary {
    pub converted: usize,
    pub skipped: usize,
    pub failed: usize,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionRunResult {
    pub summary: ConversionSummary,
    pub items: Vec<ConversionItem>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub is_ready: bool,
    pub runtime_source: RuntimeSource,
    pub executable_path: Option<String>,
    pub supports_in_app_update: bool,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub has_update_available: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeResolution {
    pub source: RuntimeSource,
    pub executable_path: String,
    pub installed_version: String,
    pub supports_in_app_update: bool,
    pub update_plan: Option<RuntimeUpdatePlan>,
}

#[derive(Debug, Clone)]
pub struct RuntimeUpdatePlan {
    pub executable_path: String,
    pub arguments: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub command_description: String,
}

#[derive(Debug, Clone)]
pub struct ManagedRuntimePaths {
    pub runtime_root: std::path::PathBuf,
    pub runtime_bin_dir: std::path::PathBuf,
    pub uv_binary_path: std::path::PathBuf,
    pub tool_dir: std::path::PathBuf,
    pub tool_bin_dir: std::path::PathBuf,
    pub python_dir: std::path::PathBuf,
    pub cache_dir: std::path::PathBuf,
    pub markitdown_binary_path: std::path::PathBuf,
}

#[derive(Debug, Default, Clone)]
pub struct ProgressTracker {
    total_count: usize,
    processed_count: usize,
    converted_count: usize,
    skipped_count: usize,
    failed_count: usize,
    current_file: Option<String>,
}

impl ProgressTracker {
    pub fn new(total_count: usize) -> Self {
        Self {
            total_count,
            ..Self::default()
        }
    }

    pub fn begin(&mut self, file_name: String) {
        self.current_file = Some(file_name);
    }

    pub fn record(&mut self, state: ConversionItemState) {
        self.processed_count += 1;
        match state {
            ConversionItemState::Converted => self.converted_count += 1,
            ConversionItemState::Skipped => self.skipped_count += 1,
            ConversionItemState::Failed => self.failed_count += 1,
            ConversionItemState::Pending | ConversionItemState::Converting => {}
        }
        self.current_file = None;
    }

    pub fn snapshot(&self) -> ConversionProgress {
        let fraction_completed = if self.total_count == 0 {
            0.0
        } else {
            self.processed_count as f64 / self.total_count as f64
        };

        ConversionProgress {
            total_count: self.total_count,
            processed_count: self.processed_count,
            converted_count: self.converted_count,
            skipped_count: self.skipped_count,
            failed_count: self.failed_count,
            fraction_completed,
            current_file: self.current_file.clone(),
        }
    }

    pub fn summary(&self, duration_seconds: f64) -> ConversionSummary {
        ConversionSummary {
            converted: self.converted_count,
            skipped: self.skipped_count,
            failed: self.failed_count,
            duration_seconds,
        }
    }
}
