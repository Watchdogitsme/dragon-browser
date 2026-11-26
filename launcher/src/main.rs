#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod paths;
mod runtime;
mod sync;

use config::{
    help_text, parse_args, CheckStatus, DoctorCheck, DoctorReport, LauncherConfig, APP_NAME,
    APP_VERSION, SETUP_SCRIPT_PS1,
};
use paths::{default_user_profile_dir, PortableLayout};
use runtime::{
    launch_gecko, list_present_bloat, strip_runtime_bloat, validate_runtime, LaunchOptions,
};
use std::fs;
use std::process::ExitCode;
use sync::{sync_portable_files, validate_policies_template};

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dwProcessId: u32) -> i32;
        fn GetConsoleWindow() -> *mut core::ffi::c_void;
    }

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hWnd: *mut core::ffi::c_void,
            lpText: *const u16,
            lpCaption: *const u16,
            uType: u32,
        ) -> i32;
    }

    pub fn ensure_console_attached() -> bool {
        unsafe {
            if !GetConsoleWindow().is_null() {
                return true;
            }
            AttachConsole(ATTACH_PARENT_PROCESS) != 0
        }
    }

    pub fn surface_error(title: &str, message: &str) {
        let has_console = ensure_console_attached();
        eprintln!("{message}");
        if !has_console {
            let wide_title: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
            let wide_msg: Vec<u16> = OsStr::new(message).encode_wide().chain(Some(0)).collect();
            unsafe {
                MessageBoxW(
                    ptr::null_mut(),
                    wide_msg.as_ptr(),
                    wide_title.as_ptr(),
                    MB_OK | MB_ICONERROR,
                );
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn ensure_console_attached() -> bool {
        true
    }

    pub fn surface_error(_title: &str, message: &str) {
        eprintln!("{message}");
    }
}

fn main() -> ExitCode {
    let cli = match parse_args(std::env::args().skip(1)) {
        Ok(opts) => opts,
        Err(err) => {
            platform::surface_error(APP_NAME, &err);
            return ExitCode::from(2);
        }
    };

    if cli.help {
        platform::ensure_console_attached();
        print!("{}", help_text());
        return ExitCode::SUCCESS;
    }

    if cli.version {
        platform::ensure_console_attached();
        if let Ok(base) = PortableLayout::from_current_exe() {
            let stamp_path = base.runtime_engine_stamp();
            if let Ok(raw) = fs::read_to_string(&stamp_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let engine = val["engine"].as_str().unwrap_or("Dragon Gecko");
                    let ver = val["display_version"]
                        .as_str()
                        .or_else(|| val["version"].as_str())
                        .unwrap_or("unknown");
                    println!("{APP_NAME} {APP_VERSION} ({engine} {ver})");
                    return ExitCode::SUCCESS;
                }
            }
        }
        println!("{APP_NAME} {APP_VERSION}");
        return ExitCode::SUCCESS;
    }

    let base_layout = match PortableLayout::from_current_exe() {
        Ok(layout) => layout,
        Err(err) => {
            platform::surface_error(
                APP_NAME,
                &format!("Failed to resolve Dragon Browser directory: {err}"),
            );
            return ExitCode::FAILURE;
        }
    };

    let cfg = LauncherConfig::load_optional(&base_layout.root);
    let mut layout = base_layout.with_overrides(
        cfg.custom_runtime_dir.as_deref(),
        cfg.custom_profile_dir.as_deref(),
    );

    if cli.doctor {
        platform::ensure_console_attached();
        let report = run_doctor(&layout);
        if cli.doctor_json {
            match serde_json::to_string_pretty(&report) {
                Ok(json) => println!("{json}"),
                Err(err) => {
                    eprintln!("Failed to serialize doctor report: {err}");
                    return ExitCode::FAILURE;
                }
            }
        } else {
            print!("{}", format_doctor_report(&report));
        }
        return if report.ok {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }

    // 1. Validate Gecko runtime binary exists before mutating runtime/.
    let firefox_bin = match validate_runtime(&layout) {
        Ok(bin) => bin,
        Err(err) => {
            platform::surface_error(APP_NAME, &err.to_string());
            return ExitCode::FAILURE;
        }
    };

    // 2. Strip Mozilla bloat executables if present (non-fatal if directory is read-only).
    if cfg.strip_bloat_on_launch {
        let _ = strip_runtime_bloat(&layout.runtime_dir);
    }

    // 2b. If profile/ beside the executable is not writable (e.g., Program Files),
    //     fall back to %LOCALAPPDATA%\Dragon Browser\profile when no explicit override was set.
    if cfg.custom_profile_dir.is_none() {
        if let Err(err) = fs::create_dir_all(&layout.profile_dir) {
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                if let Some(fallback_profile) = default_user_profile_dir() {
                    layout = layout.with_profile_dir(fallback_profile);
                }
            }
        }
    }

    // 3. Idempotently sync managed configs/UI from resources/ (or force on --reset-ui).
    if let Err(err) = sync_portable_files(&layout, cli.reset_ui) {
        platform::surface_error(
            APP_NAME,
            &format!("Failed to synchronize Dragon Browser resources:\n  {err}"),
        );
        return ExitCode::FAILURE;
    }

    // 4. Spawn isolated Gecko process.
    let launch_opts = LaunchOptions {
        private_window: cli.private_window,
        purge_caches: cli.reset_ui,
        urls: cli.urls,
        extra_args: cfg.extra_gecko_args,
    };

    if let Err(err) = launch_gecko(&firefox_bin, &layout, &launch_opts) {
        platform::surface_error(APP_NAME, &err.to_string());
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

/// Inspect portable runtime, engine stamp, resources, Dragon Core XPI, AutoConfig, and policies validity.
pub fn run_doctor(layout: &PortableLayout) -> DoctorReport {
    let mut checks = Vec::new();

    // 1. Runtime binary check + Engine Mode check (dragon.exe + dragon-engine.json vs firefox.exe fallback)
    let resolved_bin = layout.resolve_runtime_executable();
    let dragon_exe = layout.runtime_dragon_exe();
    let stamp_path = layout.runtime_engine_stamp();
    let has_dragon_exe = dragon_exe.is_file();
    let has_stamp = stamp_path.is_file();

    if resolved_bin.is_file() {
        let bloat = list_present_bloat(&layout.runtime_dir);
        if bloat.is_empty() {
            checks.push(DoctorCheck {
                name: "runtime".to_string(),
                status: CheckStatus::Ok,
                detail: format!("Found {} (bloat stripped)", resolved_bin.display()),
            });
        } else {
            checks.push(DoctorCheck {
                name: "runtime".to_string(),
                status: CheckStatus::Warn,
                detail: format!(
                    "Found {}, but {} bloat binary(ies) present (will be stripped on launch): {}",
                    resolved_bin.display(),
                    bloat.len(),
                    bloat.join(", ")
                ),
            });
        }

        if has_dragon_exe || has_stamp {
            let parsed_stamp = if has_stamp {
                fs::read_to_string(&stamp_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            } else {
                None
            };

            let stamp_detail = if has_stamp {
                match parsed_stamp.as_ref() {
                    Some(val) => {
                        let engine = val["engine"].as_str().unwrap_or("Dragon Gecko ESR");
                        let version = val["version"].as_str().unwrap_or("unknown");
                        format!(" [{engine} {version}, stamp: {}]", stamp_path.display())
                    }
                    None => format!(" [stamp: {}]", stamp_path.display()),
                }
            } else {
                String::new()
            };

            checks.push(DoctorCheck {
                name: "engine_mode".to_string(),
                status: CheckStatus::Ok,
                detail: format!(
                    "Engine Mode: Compiled Dragon Gecko Engine (dragon.exe){stamp_detail}"
                ),
            });

            if let Some(val) = parsed_stamp {
                let is_native = val["native_core"].as_bool() == Some(true);
                checks.push(DoctorCheck {
                    name: "native_core".to_string(),
                    status: if is_native {
                        CheckStatus::Ok
                    } else {
                        CheckStatus::Warn
                    },
                    detail: if is_native {
                        "Native Dragon Core enabled (chrome://dragon + resource://dragon in omni.ja)".to_string()
                    } else {
                        "dragon-engine.json missing native_core=true; re-run scripts/build.sh".to_string()
                    },
                });
            }
        } else {
            checks.push(DoctorCheck {
                name: "engine_mode".to_string(),
                status: CheckStatus::Ok,
                detail: "Engine Mode: Portable Gecko Fallback Mode (firefox.exe)".to_string(),
            });
        }
    } else {
        checks.push(DoctorCheck {
            name: "runtime".to_string(),
            status: CheckStatus::Fail,
            detail: format!(
                "Missing {} — run {} to download the portable Firefox ESR runtime",
                layout.runtime_dir.join("firefox.exe").display(),
                SETUP_SCRIPT_PS1
            ),
        });
        checks.push(DoctorCheck {
            name: "engine_mode".to_string(),
            status: CheckStatus::Fail,
            detail: "Engine Mode: No Gecko runtime executable found (missing dragon.exe / firefox.exe)"
                .to_string(),
        });
    }

    // 2. Resources check
    let missing_resources: Vec<&str> = layout
        .required_resources()
        .into_iter()
        .filter(|(_, p)| !p.is_file())
        .map(|(label, _)| label)
        .collect();

    if missing_resources.is_empty() {
        checks.push(DoctorCheck {
            name: "resources".to_string(),
            status: CheckStatus::Ok,
            detail: format!(
                "All 7 resource templates present in {}",
                layout.resources_dir.display()
            ),
        });
    } else {
        checks.push(DoctorCheck {
            name: "resources".to_string(),
            status: CheckStatus::Fail,
            detail: format!("Missing resource files: {}", missing_resources.join(", ")),
        });
    }

    // 3. AutoConfig dragon.cfg first-line comment validation
    if layout.resource_dragon_cfg.is_file() {
        match fs::read_to_string(&layout.resource_dragon_cfg) {
            Ok(content) => {
                let first_line = content.lines().next().unwrap_or("");
                if first_line.starts_with("//") {
                    checks.push(DoctorCheck {
                        name: "autoconfig_template".to_string(),
                        status: CheckStatus::Ok,
                        detail: "resources/autoconfig/dragon.cfg starts with required // comment"
                            .to_string(),
                    });
                } else {
                    checks.push(DoctorCheck {
                        name: "autoconfig_template".to_string(),
                        status: CheckStatus::Fail,
                        detail: "resources/autoconfig/dragon.cfg line 1 MUST begin with //"
                            .to_string(),
                    });
                }
            }
            Err(err) => checks.push(DoctorCheck {
                name: "autoconfig_template".to_string(),
                status: CheckStatus::Fail,
                detail: format!("Could not read dragon.cfg: {err}"),
            }),
        }
    }

    // 4. Policies template validation check
    if layout.resource_policies_template.is_file() {
        match fs::read_to_string(&layout.resource_policies_template) {
            Ok(tpl) => match validate_policies_template(&tpl) {
                Ok(_) => checks.push(DoctorCheck {
                    name: "policies_template".to_string(),
                    status: CheckStatus::Ok,
                    detail: "policies.template.json is valid JSON".to_string(),
                }),
                Err(err) => checks.push(DoctorCheck {
                    name: "policies_template".to_string(),
                    status: CheckStatus::Fail,
                    detail: err,
                }),
            },
            Err(err) => checks.push(DoctorCheck {
                name: "policies_template".to_string(),
                status: CheckStatus::Fail,
                detail: format!("Could not read policies.template.json: {err}"),
            }),
        }
    }

    // 5. Runtime deployed policies.json check
    if layout.runtime_policies_json.is_file() {
        match fs::read_to_string(&layout.runtime_policies_json) {
            Ok(raw) => match validate_policies_template(&raw) {
                Ok(_) => checks.push(DoctorCheck {
                    name: "runtime_policies".to_string(),
                    status: CheckStatus::Ok,
                    detail: "runtime/distribution/policies.json is valid JSON".to_string(),
                }),
                Err(err) => checks.push(DoctorCheck {
                    name: "runtime_policies".to_string(),
                    status: CheckStatus::Fail,
                    detail: format!("runtime/distribution/policies.json is invalid: {err}"),
                }),
            },
            Err(err) => checks.push(DoctorCheck {
                name: "runtime_policies".to_string(),
                status: CheckStatus::Fail,
                detail: format!("Failed to read runtime/distribution/policies.json: {err}"),
            }),
        }
    } else {
        checks.push(DoctorCheck {
            name: "runtime_policies".to_string(),
            status: CheckStatus::Warn,
            detail: "runtime/distribution/policies.json not yet synced (will be created on first launch)"
                .to_string(),
        });
    }

    // 7. Profile & AutoConfig sync state check
    let synced_files = [
        &layout.runtime_autoconfig_js,
        &layout.runtime_dragon_cfg,
        &layout.profile_user_js,
        &layout.profile_user_chrome_css,
        &layout.profile_user_content_css,
        &layout.profile_dragon_chrome_js,
    ];
    let present_synced = synced_files.iter().filter(|p| p.is_file()).count();
    if present_synced == synced_files.len() {
        checks.push(DoctorCheck {
            name: "synced_ui".to_string(),
            status: CheckStatus::Ok,
            detail: "All AutoConfig and portable profile UI files are synced".to_string(),
        });
    } else {
        checks.push(DoctorCheck {
            name: "synced_ui".to_string(),
            status: CheckStatus::Warn,
            detail: format!(
                "{present_synced}/{} AutoConfig/profile UI files synced (will sync automatically on launch)",
                synced_files.len()
            ),
        });
    }

    let ok = !checks.iter().any(|c| c.status == CheckStatus::Fail);

    DoctorReport {
        ok,
        root: layout.root.display().to_string(),
        checks,
    }
}

pub fn format_doctor_report(report: &DoctorReport) -> String {
    let mut out = String::new();
    out.push_str(&format!("{APP_NAME} {APP_VERSION} — Doctor Report\n"));
    out.push_str(&format!("Root: {}\n", report.root));

    if let Some(engine_check) = report.checks.iter().find(|c| c.name == "engine_mode") {
        let badge = match engine_check.status {
            CheckStatus::Ok => "[OK]",
            CheckStatus::Warn => "[WARN]",
            CheckStatus::Fail => "[FAIL]",
        };
        out.push_str(&format!("{badge} {}\n", engine_check.detail));
    }
    out.push('\n');

    for check in &report.checks {
        let badge = match check.status {
            CheckStatus::Ok => "[OK]  ",
            CheckStatus::Warn => "[WARN]",
            CheckStatus::Fail => "[FAIL]",
        };
        out.push_str(&format!("{badge} {:<20} {}\n", check.name, check.detail));
    }

    out.push('\n');
    if report.ok {
        out.push_str("Status: HEALTHY\n");
    } else {
        out.push_str("Status: ISSUES FOUND (see [FAIL] items above)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "dragon_main_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn seed_valid_bundle(layout: &PortableLayout) {
        fs::create_dir_all(&layout.runtime_dir).unwrap();
        fs::create_dir_all(layout.resources_dir.join("autoconfig")).unwrap();
        fs::create_dir_all(layout.resources_dir.join("chrome")).unwrap();

        fs::write(layout.runtime_dir.join("firefox.exe"), b"MZ-gecko").unwrap();
        fs::write(
            &layout.resource_policies_template,
            r#"{"policies":{"ExtensionSettings":{"*":{"installation_mode":"allowed"}}}}"#,
        )
        .unwrap();
        fs::write(&layout.resource_user_js, "user_pref(\"test\", true);\n").unwrap();
        fs::write(
            &layout.resource_autoconfig_js,
            "pref(\"general.config.filename\", \"dragon.cfg\");\n",
        )
        .unwrap();
        fs::write(&layout.resource_dragon_cfg, "// Dragon Browser AutoConfig\n").unwrap();
        fs::write(&layout.resource_dragon_chrome_js, "// chrome\n").unwrap();
        fs::write(&layout.resource_user_chrome_css, "/* chrome */\n").unwrap();
        fs::write(&layout.resource_user_content_css, "/* content */\n").unwrap();
    }

    #[test]
    fn doctor_reports_healthy_after_sync_and_unhealthy_when_missing_runtime() {
        let empty_root = temp_test_dir("doctor_empty");
        let empty_layout = PortableLayout::from_root(&empty_root);
        let empty_report = run_doctor(&empty_layout);
        assert!(!empty_report.ok);
        let formatted_fail = format_doctor_report(&empty_report);
        assert!(formatted_fail.contains("[FAIL]"));
        assert!(formatted_fail.contains("setup-runtime.ps1"));

        let good_root = temp_test_dir("doctor_good");
        let good_layout = PortableLayout::from_root(&good_root);
        seed_valid_bundle(&good_layout);

        // Before first launch: healthy (runtime/resources/template all OK; synced files WARN).
        let pre_sync = run_doctor(&good_layout);
        assert!(pre_sync.ok);

        // After sync: every check is strictly Ok.
        sync_portable_files(&good_layout, false).expect("sync");
        let post_sync = run_doctor(&good_layout);
        assert!(post_sync.ok);
        assert!(post_sync
            .checks
            .iter()
            .all(|c| c.status == CheckStatus::Ok));
        let formatted_ok = format_doctor_report(&post_sync);
        assert!(formatted_ok.contains("Status: HEALTHY"));
        assert!(formatted_ok.contains("Portable Gecko Fallback Mode (firefox.exe)"));

        // When compiled dragon.exe + dragon-engine.json (native_core=true) are present, reports Compiled Dragon Gecko Engine + Native Core.
        fs::write(&good_layout.runtime_dragon_exe(), b"MZ-dragon").unwrap();
        fs::write(
            &good_layout.runtime_engine_stamp(),
            r#"{"engine":"Dragon Gecko ESR","version":"153.7.0","compiled_omni":true,"native_core":true,"binary":"dragon.exe"}"#,
        )
        .unwrap();
        let compiled_report = run_doctor(&good_layout);
        assert!(compiled_report.ok);
        assert!(compiled_report
            .checks
            .iter()
            .any(|c| c.name == "native_core" && c.status == CheckStatus::Ok));
        let formatted_compiled = format_doctor_report(&compiled_report);
        assert!(
            formatted_compiled.contains("[OK] Engine Mode: Compiled Dragon Gecko Engine (dragon.exe)"),
            "Expected compiled engine mode banner in:\n{formatted_compiled}"
        );
        assert!(
            formatted_compiled.contains("Native Dragon Core enabled"),
            "Expected native core banner in:\n{formatted_compiled}"
        );

        let _ = fs::remove_dir_all(&empty_root);
        let _ = fs::remove_dir_all(&good_root);
    }
}
