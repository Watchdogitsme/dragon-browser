use crate::paths::PortableLayout;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Summary of an idempotent (or forced `--reset-ui`) resource sync pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub written: Vec<PathBuf>,
    pub unchanged: Vec<PathBuf>,
    pub cleared_startup_cache: bool,
}

#[derive(Debug)]
pub enum SyncError {
    MissingResource(PathBuf),
    InvalidPoliciesJson {
        path: PathBuf,
        reason: String,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::MissingResource(path) => {
                write!(f, "Required resource template not found: {}", path.display())
            }
            SyncError::InvalidPoliciesJson { path, reason } => write!(
                f,
                "Policies template {} is invalid: {}",
                path.display(),
                reason
            ),
            SyncError::Io { path, source } => {
                write!(f, "I/O error for {}: {}", path.display(), source)
            }
        }
    }
}

impl std::error::Error for SyncError {}

/// Validate `policies.template.json` as strict JSON containing a top-level `"policies"` object
/// and return the validated template string.
pub fn validate_policies_template(template: &str) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(template).map_err(|err| format!("Invalid JSON: {err}"))?;
    if !parsed.get("policies").is_some_and(|v| v.is_object()) {
        return Err("Policies JSON must contain a top-level \"policies\" object".to_string());
    }
    Ok(template.to_string())
}

/// Write `desired` bytes to `dest` only when content differs, or always when `force` is true.
/// Returns `Ok(true)` if the file was written, `Ok(false)` if unchanged.
pub fn sync_bytes_idempotent(dest: &Path, desired: &[u8], force: bool) -> Result<bool, SyncError> {
    if !force && dest.is_file() {
        if let Ok(existing) = fs::read(dest) {
            if existing == desired {
                return Ok(false);
            }
        }
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|source| SyncError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    fs::write(dest, desired).map_err(|source| SyncError::Io {
        path: dest.to_path_buf(),
        source,
    })?;
    Ok(true)
}

/// Idempotently synchronize all Dragon Browser managed files from `resources/` into
/// `runtime/` and `profile/`.
///
/// Safety invariant: ONLY the 7 managed template destinations are ever written.
/// User profile data (`places.sqlite`, `prefs.js`, `cookies.sqlite`, `logins.json`,
/// bookmarks, history, sessions, etc.) is NEVER deleted or overwritten.
/// When `force == true` (`--reset-ui`), all 7 managed files are forcibly rewritten and
/// Firefox's compiled XUL/JS bytecode cache (`profile/startupCache/`) is cleared if present.
pub fn sync_portable_files(
    layout: &PortableLayout,
    force: bool,
) -> Result<SyncReport, SyncError> {
    let mut report = SyncReport::default();

    // Ensure isolated profile directories exist before syncing.
    fs::create_dir_all(&layout.profile_chrome_dir).map_err(|source| SyncError::Io {
        path: layout.profile_chrome_dir.clone(),
        source,
    })?;

    // 1. Validate & sync policies.template.json -> runtime/distribution/policies.json
    let policies_template = read_required_resource_utf8(&layout.resource_policies_template)?;
    let validated_policies =
        validate_policies_template(&policies_template).map_err(|reason| {
            SyncError::InvalidPoliciesJson {
                path: layout.resource_policies_template.clone(),
                reason,
            }
        })?;

    record_sync(
        &mut report,
        &layout.runtime_policies_json,
        sync_bytes_idempotent(
            &layout.runtime_policies_json,
            validated_policies.as_bytes(),
            force,
        )?,
    );

    // 2..7. Direct byte-for-byte managed template syncs.
    let direct_mappings: [(&Path, &Path); 6] = [
        (&layout.resource_autoconfig_js, &layout.runtime_autoconfig_js),
        (&layout.resource_dragon_cfg, &layout.runtime_dragon_cfg),
        (&layout.resource_user_js, &layout.profile_user_js),
        (&layout.resource_user_chrome_css, &layout.profile_user_chrome_css),
        (
            &layout.resource_user_content_css,
            &layout.profile_user_content_css,
        ),
        (
            &layout.resource_dragon_chrome_js,
            &layout.profile_dragon_chrome_js,
        ),
    ];

    for (src, dest) in direct_mappings {
        let bytes = read_required_resource_bytes(src)?;
        let written = sync_bytes_idempotent(dest, &bytes, force)?;
        record_sync(&mut report, dest, written);
    }

    // On `--reset-ui`, clear ONLY Firefox's compiled UI bytecode cache (never user data).
    if force {
        let startup_cache = layout.profile_dir.join("startupCache");
        if startup_cache.is_dir() && fs::remove_dir_all(&startup_cache).is_ok() {
            report.cleared_startup_cache = true;
        }
    }

    Ok(report)
}

fn record_sync(report: &mut SyncReport, dest: &Path, written: bool) {
    if written {
        report.written.push(dest.to_path_buf());
    } else {
        report.unchanged.push(dest.to_path_buf());
    }
}

fn read_required_resource_bytes(path: &Path) -> Result<Vec<u8>, SyncError> {
    if !path.is_file() {
        return Err(SyncError::MissingResource(path.to_path_buf()));
    }
    fs::read(path).map_err(|source| SyncError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn read_required_resource_utf8(path: &Path) -> Result<String, SyncError> {
    if !path.is_file() {
        return Err(SyncError::MissingResource(path.to_path_buf()));
    }
    fs::read_to_string(path).map_err(|source| SyncError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dragon_sync_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn populate_mock_resources(layout: &PortableLayout) {
        fs::create_dir_all(layout.resources_dir.join("autoconfig")).unwrap();
        fs::create_dir_all(layout.resources_dir.join("chrome")).unwrap();
        fs::create_dir_all(&layout.runtime_dir).unwrap();

        let policies_tpl = r#"{
  "policies": {
    "ExtensionSettings": {
      "*": {
        "installation_mode": "allowed"
      }
    }
  }
}"#;
        fs::write(&layout.resource_policies_template, policies_tpl).unwrap();
        fs::write(
            &layout.resource_user_js,
            "user_pref(\"toolkit.legacyUserProfileCustomizations.stylesheets\", true);\n",
        )
        .unwrap();
        fs::write(
            &layout.resource_autoconfig_js,
            "pref(\"general.config.filename\", \"dragon.cfg\");\n",
        )
        .unwrap();
        fs::write(
            &layout.resource_dragon_cfg,
            "// Dragon Browser AutoConfig\nlockPref(\"xpinstall.signatures.required\", false);\n",
        )
        .unwrap();
        fs::write(
            &layout.resource_dragon_chrome_js,
            "// dragon-chrome.uc.js\n",
        )
        .unwrap();
        fs::write(
            &layout.resource_user_chrome_css,
            ":root[dragon-home-mode=\"true\"] {}\n",
        )
        .unwrap();
        fs::write(
            &layout.resource_user_content_css,
            "@-moz-document url(about:blank) { body { background: #0e1015; } }\n",
        )
        .unwrap();
    }

    #[test]
    fn validate_policies_template_accepts_valid_and_rejects_bad_json() {
        let tpl = r#"{"policies":{"ExtensionSettings":{"*":{"installation_mode":"allowed"}}}}"#;
        let validated = validate_policies_template(tpl).expect("valid policies json");
        let parsed: serde_json::Value = serde_json::from_str(&validated).expect("parse json");
        assert_eq!(
            parsed["policies"]["ExtensionSettings"]["*"]["installation_mode"],
            "allowed"
        );
        assert!(!validated.contains("dragon-core@dragonbrowser.local"));

        assert!(validate_policies_template(r#"{"not_policies":{}}"#).is_err());
        assert!(validate_policies_template(r#"{"policies": invalid"#).is_err());
    }

    #[test]
    fn idempotent_sync_and_reset_ui_preserve_user_profile_data() {
        let root = temp_test_dir("idempotent");
        let layout = PortableLayout::from_root(&root);
        populate_mock_resources(&layout);

        // Seed existing user profile data that must NEVER be overwritten or deleted.
        fs::create_dir_all(&layout.profile_dir).unwrap();
        let places = layout.profile_dir.join("places.sqlite");
        let prefs = layout.profile_dir.join("prefs.js");
        let cookies = layout.profile_dir.join("cookies.sqlite");
        let startup_cache_file = layout.profile_dir.join("startupCache").join("cache.bin");
        fs::create_dir_all(startup_cache_file.parent().unwrap()).unwrap();
        fs::write(&places, b"SQLite format 3\0user-bookmarks").unwrap();
        fs::write(&prefs, b"user_pref(\"user.custom\", 42);\n").unwrap();
        fs::write(&cookies, b"SQLite format 3\0user-cookies").unwrap();
        fs::write(&startup_cache_file, b"cached-bytecode").unwrap();

        // Pass 1: fresh sync writes all 7 managed files.
        let pass1 = sync_portable_files(&layout, false).expect("first sync");
        assert_eq!(pass1.written.len(), 7);
        assert!(pass1.unchanged.is_empty());
        assert!(!pass1.cleared_startup_cache);

        // Verify generated policies.json has valid JSON and no legacy dragon-core XPI entry.
        let policies_str = fs::read_to_string(&layout.runtime_policies_json).unwrap();
        let policies_json: serde_json::Value = serde_json::from_str(&policies_str).unwrap();
        assert_eq!(
            policies_json["policies"]["ExtensionSettings"]["*"]["installation_mode"],
            "allowed"
        );
        assert!(policies_json["policies"]["ExtensionSettings"]
            .get("dragon-core@dragonbrowser.local")
            .is_none());

        // Pass 2: immediate re-sync with force=false writes 0 files (fully idempotent).
        let pass2 = sync_portable_files(&layout, false).expect("second sync");
        assert!(pass2.written.is_empty());
        assert_eq!(pass2.unchanged.len(), 7);

        // Drift test: modify userChrome.css -> next normal sync heals ONLY userChrome.css.
        fs::write(&layout.profile_user_chrome_css, "/* drifted */").unwrap();
        let pass3 = sync_portable_files(&layout, false).expect("drift sync");
        assert_eq!(pass3.written, vec![layout.profile_user_chrome_css.clone()]);
        assert_eq!(pass3.unchanged.len(), 6);
        assert_eq!(
            fs::read_to_string(&layout.profile_user_chrome_css).unwrap(),
            ":root[dragon-home-mode=\"true\"] {}\n"
        );

        // Pass 4: `--reset-ui` (`force=true`) forces rewrite of all 7 files + clears startupCache.
        let pass4 = sync_portable_files(&layout, true).expect("reset-ui sync");
        assert_eq!(pass4.written.len(), 7);
        assert!(pass4.unchanged.is_empty());
        assert!(pass4.cleared_startup_cache);
        assert!(!startup_cache_file.exists());

        // Verify user profile data remained 100% intact across all passes!
        assert_eq!(fs::read(&places).unwrap(), b"SQLite format 3\0user-bookmarks");
        assert_eq!(fs::read(&prefs).unwrap(), b"user_pref(\"user.custom\", 42);\n");
        assert_eq!(fs::read(&cookies).unwrap(), b"SQLite format 3\0user-cookies");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_errors_cleanly_when_resource_template_missing() {
        let root = temp_test_dir("missing_res");
        let layout = PortableLayout::from_root(&root);
        let err = sync_portable_files(&layout, false).expect_err("should fail without resources");
        assert!(matches!(err, SyncError::MissingResource(_)));
        let _ = fs::remove_dir_all(&root);
    }
}
