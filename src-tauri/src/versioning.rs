use std::cmp::Ordering;

pub fn is_stable(version: &str) -> bool {
    let lowered = version.to_lowercase();
    let unstable_markers = ["alpha", "beta", "rc", "dev"];

    if unstable_markers.iter().any(|marker| lowered.contains(marker)) {
        return false;
    }

    if lowered.contains('a') || lowered.contains('b') {
        let bytes = lowered.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            let is_marker = *byte == b'a' || *byte == b'b';
            if !is_marker || index == 0 || !bytes[index - 1].is_ascii_digit() {
                continue;
            }

            if bytes.get(index + 1).is_some_and(|next| next.is_ascii_digit()) {
                return false;
            }
        }
    }

    true
}

pub fn compare_versions(lhs: &str, rhs: &str) -> Ordering {
    let lhs_parts = split_version(lhs);
    let rhs_parts = split_version(rhs);
    let max_len = lhs_parts.len().max(rhs_parts.len());

    for index in 0..max_len {
        let lhs_part = lhs_parts.get(index).copied().unwrap_or(0);
        let rhs_part = rhs_parts.get(index).copied().unwrap_or(0);
        match lhs_part.cmp(&rhs_part) {
            Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    Ordering::Equal
}

pub fn latest_stable_version<I>(versions: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    versions
        .into_iter()
        .filter(|version| is_stable(version))
        .max_by(|lhs, rhs| compare_versions(lhs, rhs))
}

fn split_version(version: &str) -> Vec<u64> {
    let mut parts = Vec::new();
    let mut current = String::new();

    for character in version.chars() {
        if character.is_ascii_digit() {
            current.push(character);
            continue;
        }

        if !current.is_empty() {
            parts.push(current.parse::<u64>().unwrap_or_default());
            current.clear();
        }
    }

    if !current.is_empty() {
        parts.push(current.parse::<u64>().unwrap_or_default());
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::{compare_versions, is_stable, latest_stable_version};
    use std::cmp::Ordering;

    #[test]
    fn detects_stable_versions() {
        assert!(is_stable("0.1.5"));
        assert!(!is_stable("0.1.5rc1"));
        assert!(!is_stable("0.1.5b1"));
    }

    #[test]
    fn compares_numeric_versions() {
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn picks_latest_stable_release() {
        let versions = vec![
            "0.1.4".to_string(),
            "0.1.6rc1".to_string(),
            "0.1.5".to_string(),
        ];

        assert_eq!(latest_stable_version(versions), Some("0.1.5".to_string()));
    }
}
