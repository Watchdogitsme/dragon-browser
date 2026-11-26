use crate::config::{APP_CLASS, SETUP_SCRIPT_PS1, SETUP_SCRIPT_SH};
use crate::paths::{strip_windows_verbatim_prefix, PortableLayout};
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

/// Unnecessary Mozilla background/telemetry/updater binaries stripped from portable runtime.
pub const BLOAT_BINARIES: &[&str] = &[
    "updater.exe",
    "maintenanceservice.exe",
    "maintenanceservice_installer.exe",
    "crashreporter.exe",
    "pingsender.exe",
    "default-browser-agent.exe",
    "crashhelper.exe",
    "private_browsing.exe",
    "firefox.exe.sig",
    "xul.dll.sig",
    "plugin-container.exe.sig",
    "mozwer.dll",
    "onnxruntime.dll",
    "mozinference.dll",
    "xpcshell.exe",
    "certutil.exe",
    "pk12util.exe",
];

/// Environment variables applied to the Gecko child process.
/// Security invariant: NEVER disable Firefox's content sandbox.
pub const GECKO_ENV_VARS: &[(&str, &str)] = &[
    ("MOZ_CRASHREPORTER_DISABLE", "1"),
    ("MOZ_LEGACY_PROFILES", "1"),
];

/// Environment variables explicitly removed so inherited env cannot weaken Gecko's sandbox.
pub const SANDBOX_GUARD_REMOVED_ENV_VARS: &[&str] = &[
    "MOZ_DISABLE_CONTENT_SANDBOX",
    "MOZ_DISABLE_GMP_SANDBOX",
    "MOZ_DISABLE_NPAPI_SANDBOX",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchOptions {
    pub private_window: bool,
    pub purge_caches: bool,
    pub urls: Vec<String>,
    pub extra_args: Vec<String>,
}

#[derive(Debug)]
pub enum RuntimeError {
    MissingBinary {
        expected_path: PathBuf,
        root_dir: PathBuf,
    },
    SpawnFailed {
        binary: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::MissingBinary {
                expected_path,
                root_dir,
            } => {
                let ps1 = root_dir.join(SETUP_SCRIPT_PS1);
                let sh = root_dir.join(SETUP_SCRIPT_SH);
                write!(
                    f,
                    "Dragon Browser runtime not found at:\n  {}\n\n\
                     To install the portable Firefox ESR runtime on Windows, run:\n  \
                     powershell -ExecutionPolicy Bypass -File \"{}\"\n\
                     (Or from the Dragon Browser folder: .\\{})\n\n\
                     On WSL/Linux (with 7z installed), you can also run:\n  \
                     bash \"{}\"",
                    expected_path.display(),
                    ps1.display(),
                    SETUP_SCRIPT_PS1,
                    sh.display()
                )
            }
            RuntimeError::SpawnFailed { binary, source } => {
                write!(
                    f,
                    "Failed to launch Gecko runtime at {}: {}",
                    binary.display(),
                    source
                )
            }
        }
    }
}

impl std::error::Error for RuntimeError {}

/// Locate the Gecko runtime binary inside `runtime_dir`.
/// Prefers `dragon.exe` (or `dragon` on non-Windows), falling back to `firefox.exe` (or `firefox`).
#[allow(dead_code)]
pub fn find_firefox_binary(runtime_dir: &Path) -> Option<PathBuf> {
    let dragon_win = runtime_dir.join("dragon.exe");
    if dragon_win.is_file() {
        return Some(dragon_win);
    }

    #[cfg(not(windows))]
    {
        let dragon_unix = runtime_dir.join("dragon");
        if dragon_unix.is_file() {
            return Some(dragon_unix);
        }
    }

    let win_bin = runtime_dir.join("firefox.exe");
    if win_bin.is_file() {
        return Some(win_bin);
    }

    #[cfg(not(windows))]
    {
        let unix_bin = runtime_dir.join("firefox");
        if unix_bin.is_file() {
            return Some(unix_bin);
        }
    }

    None
}

/// Validate that the portable Gecko runtime exists (`dragon.exe` preferred over `firefox.exe`)
/// and return the resolved executable path.
pub fn validate_runtime(layout: &PortableLayout) -> Result<PathBuf, RuntimeError> {
    let resolved = layout.resolve_runtime_executable();
    if resolved.is_file() {
        return Ok(resolved);
    }

    Err(RuntimeError::MissingBinary {
        expected_path: resolved,
        root_dir: layout.root.clone(),
    })
}

/// Return the list of bloat binaries currently present in `runtime_dir`.
pub fn list_present_bloat(runtime_dir: &Path) -> Vec<String> {
    BLOAT_BINARIES
        .iter()
        .filter(|name| runtime_dir.join(name).is_file())
        .map(|name| (*name).to_string())
        .collect()
}

/// Remove unnecessary Mozilla updater/telemetry/crashreporter binaries from `runtime_dir`.
/// Returns the names of files actually removed. Missing directories or files are ignored cleanly.
pub fn strip_runtime_bloat(runtime_dir: &Path) -> io::Result<Vec<String>> {
    if !runtime_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut removed = Vec::new();
    for &name in BLOAT_BINARIES {
        let candidate = runtime_dir.join(name);
        if candidate.is_file() {
            match fs::remove_file(&candidate) {
                Ok(()) => removed.push(name.to_string()),
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
    }
    Ok(removed)
}

/// Build the exact argument list passed to Gecko (`firefox.exe`).
pub fn build_gecko_args(profile_dir: &Path, options: &LaunchOptions) -> Vec<OsString> {
    let clean_profile = strip_windows_verbatim_prefix(profile_dir);
    let mut args = vec![
        OsString::from("--profile"),
        clean_profile.into_os_string(),
        OsString::from("--class"),
        OsString::from(APP_CLASS),
    ];

    if options.purge_caches {
        args.push(OsString::from("-purgecaches"));
    }

    for extra in &options.extra_args {
        args.push(OsString::from(extra));
    }

    if options.private_window {
        if options.urls.is_empty() {
            args.push(OsString::from("-private-window"));
        } else {
            for url in &options.urls {
                args.push(OsString::from("-private-window"));
                args.push(OsString::from(url));
            }
        }
    } else {
        for url in &options.urls {
            args.push(OsString::from(url));
        }
    }

    args
}

/// Construct the configured `Command` for launching Gecko with an isolated portable profile
/// and hardened environment variables (content sandbox strictly enabled).
pub fn build_gecko_command(
    firefox_bin: &Path,
    layout: &PortableLayout,
    options: &LaunchOptions,
) -> Command {
    let mut cmd = Command::new(firefox_bin);
    cmd.current_dir(&layout.runtime_dir);
    cmd.args(build_gecko_args(&layout.profile_dir, options));

    for &removed_key in SANDBOX_GUARD_REMOVED_ENV_VARS {
        cmd.env_remove(removed_key);
    }
    for &(key, val) in GECKO_ENV_VARS {
        cmd.env(key, val);
    }

    cmd
}

/// Spawn Gecko and hand off control immediately so the launcher stays zero-overhead.
pub fn launch_gecko(
    firefox_bin: &Path,
    layout: &PortableLayout,
    options: &LaunchOptions,
) -> Result<Child, RuntimeError> {
    let mut cmd = build_gecko_command(firefox_bin, layout, options);
    cmd.spawn().map_err(|source| RuntimeError::SpawnFailed {
        binary: firefox_bin.to_path_buf(),
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
            "dragon_runtime_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn strip_runtime_bloat_removes_only_bloat_binaries() {
        let dir = temp_test_dir("bloat");
        let runtime_dir = dir.join("runtime");
        fs::create_dir_all(&runtime_dir).unwrap();

        let firefox = runtime_dir.join("firefox.exe");
        let xul = runtime_dir.join("xul.dll");
        fs::write(&firefox, b"MZ-firefox").unwrap();
        fs::write(&xul, b"MZ-xul").unwrap();

        for &bloat in BLOAT_BINARIES {
            fs::write(runtime_dir.join(bloat), b"bloat").unwrap();
        }
        assert_eq!(list_present_bloat(&runtime_dir).len(), BLOAT_BINARIES.len());

        let removed = strip_runtime_bloat(&runtime_dir).expect("strip bloat");
        assert_eq!(removed.len(), BLOAT_BINARIES.len());
        assert!(list_present_bloat(&runtime_dir).is_empty());

        // Essential runtime files must remain untouched.
        assert!(firefox.is_file());
        assert!(xul.is_file());

        // Running again is an idempotent no-op.
        let removed_again = strip_runtime_bloat(&runtime_dir).expect("second strip");
        assert!(removed_again.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_runtime_bloat_handles_missing_directory() {
        let missing = std::env::temp_dir().join("dragon_definitely_missing_runtime_dir_999");
        let removed = strip_runtime_bloat(&missing).expect("missing dir ok");
        assert!(removed.is_empty());
    }

    #[test]
    fn validate_runtime_checks_binary_and_reports_setup_script() {
        let dir = temp_test_dir("validate");
        let layout = PortableLayout::from_root(&dir);

        let err = validate_runtime(&layout).expect_err("missing runtime should error");
        let msg = err.to_string();
        assert!(msg.contains("setup-runtime.ps1"));
        assert!(msg.contains("firefox.exe"));

        fs::create_dir_all(&layout.runtime_dir).unwrap();
        let firefox_bin = layout.runtime_dir.join("firefox");
        fs::write(&firefox_bin, b"#!/bin/sh\n").unwrap();
        let found = validate_runtime(&layout).expect("non-windows firefox binary");
        assert_eq!(found, firefox_bin);

        // `firefox.exe` takes precedence over `firefox` when present.
        let firefox_exe = layout.runtime_dir.join("firefox.exe");
        fs::write(&firefox_exe, b"MZ").unwrap();
        let found_exe = validate_runtime(&layout).expect("firefox.exe preferred");
        assert_eq!(found_exe, firefox_exe);

        // Compiled `dragon.exe` takes precedence over `firefox.exe`.
        let dragon_exe = layout.runtime_dir.join("dragon.exe");
        fs::write(&dragon_exe, b"MZ-dragon").unwrap();
        let found_dragon = validate_runtime(&layout).expect("dragon.exe preferred");
        assert_eq!(found_dragon, dragon_exe);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_gecko_args_normal_private_and_reset_ui() {
        let profile = Path::new(r"\\?\C:\VS\Dragon browser\profile");

        let normal = build_gecko_args(
            profile,
            &LaunchOptions {
                private_window: false,
                purge_caches: false,
                urls: vec!["https://example.com".to_string()],
                extra_args: vec![],
            },
        );
        assert_eq!(
            normal,
            vec![
                OsString::from("--profile"),
                OsString::from(r"C:\VS\Dragon browser\profile"),
                OsString::from("--class"),
                OsString::from("DragonBrowser"),
                OsString::from("https://example.com"),
            ]
        );

        let private_empty = build_gecko_args(
            profile,
            &LaunchOptions {
                private_window: true,
                purge_caches: true,
                urls: vec![],
                extra_args: vec![],
            },
        );
        assert_eq!(
            private_empty,
            vec![
                OsString::from("--profile"),
                OsString::from(r"C:\VS\Dragon browser\profile"),
                OsString::from("--class"),
                OsString::from("DragonBrowser"),
                OsString::from("-purgecaches"),
                OsString::from("-private-window"),
            ]
        );

        let private_urls = build_gecko_args(
            profile,
            &LaunchOptions {
                private_window: true,
                purge_caches: false,
                urls: vec![
                    "https://a.example".to_string(),
                    "https://b.example".to_string(),
                ],
                extra_args: vec![],
            },
        );
        assert_eq!(
            private_urls,
            vec![
                OsString::from("--profile"),
                OsString::from(r"C:\VS\Dragon browser\profile"),
                OsString::from("--class"),
                OsString::from("DragonBrowser"),
                OsString::from("-private-window"),
                OsString::from("https://a.example"),
                OsString::from("-private-window"),
                OsString::from("https://b.example"),
            ]
        );
    }

    #[test]
    fn gecko_env_vars_keep_content_sandbox_enabled() {
        assert!(GECKO_ENV_VARS.contains(&("MOZ_CRASHREPORTER_DISABLE", "1")));
        assert!(GECKO_ENV_VARS.contains(&("MOZ_LEGACY_PROFILES", "1")));
        assert!(!GECKO_ENV_VARS
            .iter()
            .any(|(k, _)| k.contains("DISABLE_CONTENT_SANDBOX")));
        assert!(SANDBOX_GUARD_REMOVED_ENV_VARS.contains(&"MOZ_DISABLE_CONTENT_SANDBOX"));
    }
}
