use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const APP_NAME: &str = "Dragon Browser";
pub const APP_CLASS: &str = "DragonBrowser";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SETUP_SCRIPT_PS1: &str = "setup-runtime.ps1";
pub const SETUP_SCRIPT_SH: &str = "setup-runtime.sh";
pub const LAUNCHER_CONFIG_FILE: &str = "dragon-launcher.json";

fn default_true() -> bool {
    true
}

/// Optional portable launcher overrides stored in `<root>/dragon-launcher.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherConfig {
    #[serde(default = "default_true")]
    pub strip_bloat_on_launch: bool,
    #[serde(default)]
    pub extra_gecko_args: Vec<String>,
    #[serde(default)]
    pub custom_runtime_dir: Option<String>,
    #[serde(default)]
    pub custom_profile_dir: Option<String>,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            strip_bloat_on_launch: true,
            extra_gecko_args: Vec::new(),
            custom_runtime_dir: None,
            custom_profile_dir: None,
        }
    }
}

impl LauncherConfig {
    /// Load `<root>/dragon-launcher.json` if present and valid; otherwise return defaults.
    pub fn load_optional(root: &Path) -> Self {
        let path = root.join(LAUNCHER_CONFIG_FILE);
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }
}

/// Parsed command-line options for `dragon-browser.exe`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliOptions {
    pub private_window: bool,
    pub reset_ui: bool,
    pub doctor: bool,
    pub doctor_json: bool,
    pub help: bool,
    pub version: bool,
    pub urls: Vec<String>,
}

/// Parse CLI arguments (excluding `argv[0]`).
pub fn parse_args<I, S>(args: I) -> Result<CliOptions, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut opts = CliOptions::default();
    let mut iter = args.into_iter();
    let mut positional_only = false;

    while let Some(raw) = iter.next() {
        let arg = raw.as_ref();
        if positional_only {
            opts.urls.push(arg.to_string());
            continue;
        }

        match arg {
            "--" => positional_only = true,
            "--private" | "-p" => opts.private_window = true,
            "--reset-ui" => opts.reset_ui = true,
            "--doctor" => opts.doctor = true,
            "--json" => opts.doctor_json = true,
            "--help" | "-h" | "/?" => opts.help = true,
            "--version" | "-V" => opts.version = true,
            "--url" | "-url" => {
                let Some(next) = iter.next() else {
                    return Err(format!("Option '{arg}' requires a URL argument."));
                };
                opts.urls.push(next.as_ref().to_string());
            }
            other if other.starts_with('-') => {
                return Err(format!(
                    "Unknown option: {other}. Run with --help for usage."
                ));
            }
            url => opts.urls.push(url.to_string()),
        }
    }

    Ok(opts)
}

pub fn help_text() -> &'static str {
    concat!(
        "Dragon Browser — Fast, minimal, portable Gecko launcher\n\n",
        "USAGE:\n",
        "    dragon-browser.exe [OPTIONS] [URL ...]\n\n",
        "OPTIONS:\n",
        "    -p, --private       Launch in a Private Browsing window\n",
        "        --reset-ui      Force-restore stock UI CSS/JS, AutoConfig, user.js, and policies.json\n",
        "        --doctor        Check portable runtime, resources, and native policies validity\n",
        "        --json          Output --doctor diagnostics as JSON\n",
        "    -h, --help          Show this help message\n",
        "    -V, --version       Show launcher version\n\n",
        "PORTABLE LAYOUT (relative to dragon-browser.exe):\n",
        "    runtime/            Compiled Dragon Gecko Engine (dragon.exe + native omni.ja)\n",
        "    profile/            Isolated portable user profile (preserved across updates)\n",
        "    resources/          Source templates synced into runtime/ and profile/\n"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorReport {
    pub ok: bool,
    pub root: String,
    pub checks: Vec<DoctorCheck>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dragon_config_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn parse_empty_args() {
        let opts = parse_args::<[&str; 0], &str>([]).expect("empty args");
        assert_eq!(opts, CliOptions::default());
    }

    #[test]
    fn parse_private_short_and_long_with_urls() {
        let opts = parse_args(["-p", "https://example.com", "https://rust-lang.org"])
            .expect("valid short private args");
        assert!(opts.private_window);
        assert_eq!(
            opts.urls,
            vec!["https://example.com", "https://rust-lang.org"]
        );

        let opts_long = parse_args(["--private", "--reset-ui", "https://mozilla.org"])
            .expect("valid long flags");
        assert!(opts_long.private_window);
        assert!(opts_long.reset_ui);
        assert_eq!(opts_long.urls, vec!["https://mozilla.org"]);
    }

    #[test]
    fn parse_doctor_help_and_version_flags() {
        let doctor = parse_args(["--doctor", "--json"]).expect("doctor args");
        assert!(doctor.doctor);
        assert!(doctor.doctor_json);

        let help = parse_args(["--help"]).expect("help args");
        assert!(help.help);

        let short_help = parse_args(["-h"]).expect("short help");
        assert!(short_help.help);

        let version = parse_args(["--version"]).expect("version");
        assert!(version.version);
    }

    #[test]
    fn parse_url_flag_and_double_dash_separator() {
        let opts = parse_args(["--url", "https://dragon.local", "--", "-literal-target"])
            .expect("url and separator");
        assert_eq!(opts.urls, vec!["https://dragon.local", "-literal-target"]);
    }

    #[test]
    fn parse_rejects_unknown_flag_and_missing_url_value() {
        let err = parse_args(["--nonexistent"]).expect_err("unknown flag should fail");
        assert!(err.contains("--nonexistent"));

        let missing = parse_args(["--url"]).expect_err("missing url value should fail");
        assert!(missing.contains("--url"));
    }

    #[test]
    fn launcher_config_defaults_and_optional_file() {
        let dir = temp_test_dir("cfg");
        let default_cfg = LauncherConfig::load_optional(&dir);
        assert!(default_cfg.strip_bloat_on_launch);
        assert!(default_cfg.extra_gecko_args.is_empty());

        fs::write(
            dir.join(LAUNCHER_CONFIG_FILE),
            r#"{"strip_bloat_on_launch": false, "extra_gecko_args": ["--new-instance"]}"#,
        )
        .expect("write config");
        let loaded = LauncherConfig::load_optional(&dir);
        assert!(!loaded.strip_bloat_on_launch);
        assert_eq!(loaded.extra_gecko_args, vec!["--new-instance"]);

        // Malformed JSON degrades gracefully to defaults.
        fs::write(dir.join(LAUNCHER_CONFIG_FILE), "{invalid json").expect("write malformed");
        let fallback = LauncherConfig::load_optional(&dir);
        assert!(fallback.strip_bloat_on_launch);

        let _ = fs::remove_dir_all(&dir);
    }
}
