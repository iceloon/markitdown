use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};

use crate::models::{ConversionJob, PlannedConversion, SourceKind};

pub fn plan(job: &ConversionJob) -> Result<Vec<PlannedConversion>> {
    let source_url = PathBuf::from(&job.source_url);
    let destination_root = PathBuf::from(&job.destination_root);

    match job.source_kind {
        SourceKind::File => {
            if !source_url.is_file() {
                anyhow::bail!("无效的源文件：{}", source_url.display());
            }

            Ok(vec![plan_file(&source_url, &destination_root)])
        }
        SourceKind::Directory => plan_directory(&source_url, &destination_root),
    }
}

fn plan_file(source_url: &Path, destination_root: &Path) -> PlannedConversion {
    let source_root = source_url.parent().unwrap_or_else(|| Path::new("/"));
    let output_url = destination_url(source_url, source_root, destination_root);
    let skip_reason = if standardized(source_url) == standardized(&output_url) {
        Some("输出文件与源文件相同，已跳过。".to_string())
    } else {
        None
    };

    PlannedConversion {
        source_url: source_url.to_string_lossy().into_owned(),
        output_url: output_url.to_string_lossy().into_owned(),
        skip_reason,
    }
}

fn plan_directory(source_root: &Path, destination_root: &Path) -> Result<Vec<PlannedConversion>> {
    if !source_root.is_dir() {
        anyhow::bail!("无效的源目录：{}", source_root.display());
    }

    let normalized_source = standardized(source_root);
    let normalized_destination = standardized(destination_root);
    let mut planned = Vec::new();

    walk_directory(
        source_root,
        source_root,
        destination_root,
        &normalized_source,
        &normalized_destination,
        &mut planned,
    )?;

    planned.sort_by(|lhs, rhs| lhs.source_url.cmp(&rhs.source_url));
    Ok(planned)
}

fn walk_directory(
    current_dir: &Path,
    source_root: &Path,
    destination_root: &Path,
    normalized_source: &Path,
    normalized_destination: &Path,
    planned: &mut Vec<PlannedConversion>,
) -> Result<()> {
    for entry in fs::read_dir(current_dir)
        .with_context(|| format!("无法扫描目录：{}", current_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();

        if file_name.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            let normalized_candidate = standardized(&path);
            let is_destination_branch = normalized_destination != normalized_source
                && (normalized_candidate == normalized_destination
                    || normalized_candidate.starts_with(normalized_destination));

            if is_destination_branch {
                continue;
            }

            walk_directory(
                &path,
                source_root,
                destination_root,
                normalized_source,
                normalized_destination,
                planned,
            )?;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let output_url = destination_url(&path, source_root, destination_root);
        let skip_reason = if standardized(&path) == standardized(&output_url) {
            Some("输出文件与源文件相同，已跳过。".to_string())
        } else {
            None
        };

        planned.push(PlannedConversion {
            source_url: path.to_string_lossy().into_owned(),
            output_url: output_url.to_string_lossy().into_owned(),
            skip_reason,
        });
    }

    Ok(())
}

fn destination_url(source_url: &Path, source_root: &Path, destination_root: &Path) -> PathBuf {
    let relative_path = source_url
        .strip_prefix(source_root)
        .unwrap_or(source_url)
        .to_path_buf();
    let mut output_url = destination_root.join(relative_path);
    output_url.set_extension("md");
    output_url
}

fn standardized(path: &Path) -> PathBuf {
    if path.exists() {
        fs::canonicalize(path).unwrap_or_else(|_| normalize_path(path))
    } else {
        normalize_path(path)
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }

    normalized
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use crate::models::{ConversionJob, SourceKind};

    use super::plan;

    #[test]
    fn plans_single_file_output() {
        let root = make_temp_dir();
        let source = root.join("demo.docx");
        let destination = root.join("output");
        fs::write(&source, "demo").unwrap();

        let job = ConversionJob {
            source_url: source.to_string_lossy().into_owned(),
            source_kind: SourceKind::File,
            destination_root: destination.to_string_lossy().into_owned(),
        };

        let planned = plan(&job).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].output_url, destination.join("demo.md").to_string_lossy());
    }

    #[test]
    fn filters_hidden_entries() {
        let root = make_temp_dir();
        let source = root.join("source");
        let destination = root.join("output");
        fs::create_dir_all(source.join(".hidden")).unwrap();
        fs::write(source.join("visible.docx"), "demo").unwrap();
        fs::write(source.join(".hidden").join("secret.pdf"), "demo").unwrap();

        let job = ConversionJob {
            source_url: source.to_string_lossy().into_owned(),
            source_kind: SourceKind::Directory,
            destination_root: destination.to_string_lossy().into_owned(),
        };

        let planned = plan(&job).unwrap();
        assert_eq!(planned.len(), 1);
        assert!(planned[0].source_url.ends_with("visible.docx"));
    }

    fn make_temp_dir() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("markitdown-tauri-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }
}
