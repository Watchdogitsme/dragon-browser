#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod archive;
mod install;
mod manifest;
#[cfg(windows)]
mod win32_integration;
#[cfg(windows)]
mod win32_ui;

use archive::SfxArchive;
use install::{perform_install, perform_uninstall, InstallOptions};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Debug, Default)]
struct InstallerCli {
    silent: bool,
    install_dir: Option<PathBuf>,
    portable: bool,
    no_shortcuts: bool,
    no_launch: bool,
    uninstall: bool,
    remove_profile: bool,
    info: bool,
    verify: bool,
    help: bool,
}

fn parse_cli(args: impl IntoIterator<Item = String>) -> Result<InstallerCli, String> {
    let mut cli = InstallerCli::default();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg.eq_ignore_ascii_case("/S") || arg == "--silent" {
            cli.silent = true;
        } else if let Some(val) = arg.strip_prefix("/D=").or_else(|| arg.strip_prefix("/d=")) {
            cli.install_dir = Some(PathBuf::from(val));
        } else if arg == "--dir" {
            let val = iter
                .next()
                .ok_or_else(|| "--dir requires a path argument".to_string())?;
            cli.install_dir = Some(PathBuf::from(val));
        } else if arg == "--portable" {
            cli.portable = true;
        } else if arg == "--no-shortcuts" {
            cli.no_shortcuts = true;
        } else if arg == "--no-launch" {
            cli.no_launch = true;
        } else if arg == "--uninstall" {
            cli.uninstall = true;
        } else if arg == "--remove-profile" {
            cli.remove_profile = true;
        } else if arg == "--info" {
            cli.info = true;
        } else if arg == "--verify" {
            cli.verify = true;
        } else if arg == "--help" || arg == "-h" || arg == "/?" {
            cli.help = true;
        } else {
            return Err(format!("Unknown installer option: {arg}"));
        }
    }
    Ok(cli)
}

fn help_text() -> &'static str {
    concat!(
        "Dragon Browser Installer\n\n",
        "USAGE:\n",
        "    DragonBrowser-Setup-<version>-win64.exe [OPTIONS]\n\n",
        "OPTIONS:\n",
        "    /S, --silent          Run unattended installation/upgrade\n",
        "    /D=<path>, --dir <p>  Target installation directory\n",
        "        --portable        Extract portable layout only (no shortcuts/registry/uninstaller)\n",
        "        --no-shortcuts    Skip Desktop and Start Menu shortcuts\n",
        "        --no-launch       Do not launch Dragon Browser after silent install\n",
        "        --uninstall       Uninstall Dragon Browser from current/target folder\n",
        "        --remove-profile  Also delete profile/ during uninstall\n",
        "        --info            Print embedded installer manifest JSON\n",
        "        --verify          Verify installer payload CRC32 & manifest integrity\n",
        "    -h, --help            Show this help message\n"
    )
}

fn main() -> ExitCode {
    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(err) => {
            eprintln!("Failed to resolve current executable path: {err}");
            return ExitCode::FAILURE;
        }
    };

    let mut cli = match parse_cli(std::env::args().skip(1)) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };

    if exe_path
        .file_stem()
        .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("uninstall"))
    {
        cli.uninstall = true;
    }

    if cli.help {
        print!("{}", help_text());
        return ExitCode::SUCCESS;
    }

    if cli.info || cli.verify {
        match SfxArchive::open(&exe_path).and_then(|mut a| a.read_manifest()) {
            Ok(manifest) => {
                if cli.info {
                    println!("{}", serde_json::to_string_pretty(&manifest).unwrap());
                } else {
                    println!("[OK] Verified {}", manifest.summary_line());
                }
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                eprintln!("[FAIL] {err}");
                return ExitCode::FAILURE;
            }
        }
    }

    if cli.uninstall {
        let install_dir = cli.install_dir.clone().unwrap_or_else(|| {
            exe_path
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        });

        #[cfg(windows)]
        {
            if !cli.silent {
                let code = win32_ui::run_uninstall_gui(&exe_path, &install_dir);
                return if code == 0 {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                };
            }
            if let Err(err) = win32_integration::check_not_running(&install_dir) {
                eprintln!("{err}");
                return ExitCode::FAILURE;
            }
            win32_integration::remove_shortcuts();
            win32_integration::unregister_uninstall_entry();
            if let Err(err) = perform_uninstall(&install_dir, cli.remove_profile) {
                eprintln!("Uninstall failed: {err}");
                return ExitCode::FAILURE;
            }
            win32_integration::schedule_self_delete(&exe_path);
            return ExitCode::SUCCESS;
        }

        #[cfg(not(windows))]
        {
            if let Err(err) = perform_uninstall(&install_dir, cli.remove_profile) {
                eprintln!("Uninstall failed: {err}");
                return ExitCode::FAILURE;
            }
            return ExitCode::SUCCESS;
        }
    }

    #[cfg(windows)]
    if !cli.silent {
        let code = win32_ui::run_install_gui(&exe_path, cli.install_dir);
        return if code == 0 {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }

    #[cfg(windows)]
    let default_dir = win32_integration::default_install_dir();
    #[cfg(not(windows))]
    let default_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("DragonBrowser");

    let install_dir = cli.install_dir.unwrap_or(default_dir);

    #[cfg(windows)]
    if let Err(err) = win32_integration::check_not_running(&install_dir) {
        eprintln!("{err}");
        return ExitCode::FAILURE;
    }

    let opts = InstallOptions {
        install_dir: install_dir.clone(),
        portable: cli.portable,
        create_desktop_shortcut: !cli.portable && !cli.no_shortcuts,
        create_start_menu_shortcut: !cli.portable && !cli.no_shortcuts,
        launch_after: false,
        silent: cli.silent,
    };

    match perform_install(&exe_path, &opts, |_, _| {}) {
        Ok(res) => {
            #[cfg(windows)]
            if !opts.portable {
                let target_exe = res.install_dir.join("dragon-browser.exe");
                let icon = res.install_dir.join("dragon.ico");
                if opts.create_desktop_shortcut {
                    if let Some(lnk) = win32_integration::desktop_shortcut_path() {
                        let _ = win32_integration::create_shortcut(
                            &lnk,
                            &target_exe,
                            &res.install_dir,
                            &icon,
                            "Dragon Browser",
                        );
                    }
                }
                if opts.create_start_menu_shortcut {
                    if let Some(lnk) = win32_integration::start_menu_shortcut_path() {
                        let _ = win32_integration::create_shortcut(
                            &lnk,
                            &target_exe,
                            &res.install_dir,
                            &icon,
                            "Dragon Browser",
                        );
                    }
                }
                let _ = win32_integration::register_uninstall_entry(&res.install_dir, &res.manifest);
            }
            println!(
                "[OK] {} {} into {}",
                if res.was_upgrade { "Upgraded" } else { "Installed" },
                res.manifest.summary_line(),
                res.install_dir.display()
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("[FAIL] {err}");
            ExitCode::FAILURE
        }
    }
}
