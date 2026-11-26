use crate::archive::{write_stripped_stub, SfxArchive};
use crate::manifest::{InstallManifest, MANIFEST_FILENAME};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct InstallOptions {
    pub install_dir: PathBuf,
    pub portable: bool,
    pub create_desktop_shortcut: bool,
    pub create_start_menu_shortcut: bool,
    pub launch_after: bool,
    pub silent: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct InstallResult {
    pub install_dir: PathBuf,
    pub manifest: InstallManifest,
    pub was_upgrade: bool,
    pub wrote_uninstaller: bool,
    pub wrote_launcher_redirect: bool,
}

pub fn is_existing_install(install_dir: &Path) -> bool {
    install_dir.join("profile").is_dir()
        || install_dir.join(MANIFEST_FILENAME).is_file()
        || install_dir.join("dragon-browser.exe").is_file()
        || install_dir.join("runtime").join("dragon.exe").is_file()
}

/// Detect whether `install_dir` is a shared/system location (such as Program Files)
/// where per-user writes beside `dragon-browser.exe` would hit permission errors.
pub fn needs_user_profile_redirect(install_dir: &Path) -> bool {
    let norm = install_dir
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    norm.contains("\\program files\\")
        || norm.ends_with("\\program files")
        || norm.contains("\\program files (x86)\\")
        || norm.ends_with("\\program files (x86)")
}

fn swap_directory_atomic(staged_dir: &Path, dest_dir: &Path, backup_dir: &Path) -> Result<(), String> {
    if !staged_dir.is_dir() {
        return Err(format!(
            "Staged directory missing: {}",
            staged_dir.display()
        ));
    }
    let had_dest = dest_dir.exists();
    if had_dest {
        if backup_dir.exists() {
            fs::remove_dir_all(backup_dir)
                .map_err(|e| format!("Failed clearing backup {}: {e}", backup_dir.display()))?;
        }
        fs::rename(dest_dir, backup_dir).map_err(|e| {
            format!(
                "Failed backing up {} -> {}: {e}",
                dest_dir.display(),
                backup_dir.display()
            )
        })?;
    }

    if let Err(err) = fs::rename(staged_dir, dest_dir) {
        if had_dest && backup_dir.exists() {
            let _ = fs::rename(backup_dir, dest_dir);
        }
        return Err(format!(
            "Failed installing {} -> {}: {err}",
            staged_dir.display(),
            dest_dir.display()
        ));
    }

    if backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }
    Ok(())
}

fn swap_file_atomic(staged_file: &Path, dest_file: &Path) -> Result<(), String> {
    if !staged_file.is_file() {
        return Ok(());
    }
    let tmp_dest = dest_file.with_extension("tmp-install");
    fs::copy(staged_file, &tmp_dest)
        .map_err(|e| format!("Failed copying {}: {e}", dest_file.display()))?;
    if dest_file.exists() {
        let _ = fs::remove_file(dest_file);
    }
    fs::rename(&tmp_dest, dest_file)
        .map_err(|e| format!("Failed replacing {}: {e}", dest_file.display()))?;
    Ok(())
}

/// Perform a clean fresh install or in-place upgrade from `exe_path` into `opts.install_dir`.
///
/// Safety invariant: ONLY managed app components (`runtime/`, `resources/`, `dragon-browser.exe`,
/// `dragon.ico`, `dragon-manifest.json`, `uninstall.exe`) are updated. Any existing `profile/`
/// directory (bookmarks, cookies, logins, prefs, extensions) is 100% preserved, clearing only
/// Gecko's compiled `profile/startupCache/` bytecode cache so updated `omni.ja` loads cleanly.
pub fn perform_install<F>(
    exe_path: &Path,
    opts: &InstallOptions,
    mut on_progress: F,
) -> Result<InstallResult, String>
where
    F: FnMut(u8, &str),
{
    on_progress(2, "Verifying installer package checksum...");
    let mut archive = SfxArchive::open(exe_path)?;
    let manifest = archive.read_manifest()?;

    let install_dir = &opts.install_dir;
    fs::create_dir_all(install_dir)
        .map_err(|e| format!("Cannot create install directory {}: {e}", install_dir.display()))?;

    let was_upgrade = is_existing_install(install_dir);
    let pid = std::process::id();
    let staging_dir = install_dir.join(format!(".install-staging-{pid}"));
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Cannot create staging dir {}: {e}", staging_dir.display()))?;

    let extract_res = archive.extract_all_to(&staging_dir, |done, total, name| {
        let pct = 5 + ((done * 70) / total.max(1)) as u8;
        on_progress(pct, &format!("Extracting {name}..."));
    });
    if let Err(err) = extract_res {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    on_progress(78, "Installing Dragon Browser engine and resources...");
    let runtime_backup = install_dir.join(format!(".runtime-backup-{pid}"));
    let resources_backup = install_dir.join(format!(".resources-backup-{pid}"));

    if let Err(err) = swap_directory_atomic(
        &staging_dir.join("runtime"),
        &install_dir.join("runtime"),
        &runtime_backup,
    ) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    if let Err(err) = swap_directory_atomic(
        &staging_dir.join("resources"),
        &install_dir.join("resources"),
        &resources_backup,
    ) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    on_progress(88, "Installing Dragon Browser launcher...");
    for fname in ["dragon-browser.exe", "dragon.ico", MANIFEST_FILENAME] {
        if let Err(err) = swap_file_atomic(&staging_dir.join(fname), &install_dir.join(fname)) {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(err);
        }
    }

    // On upgrades, clear ONLY Gecko's compiled UI bytecode cache so updated omni.ja loads cleanly.
    let startup_cache = install_dir.join("profile").join("startupCache");
    if startup_cache.is_dir() {
        let _ = fs::remove_dir_all(&startup_cache);
    }

    let mut wrote_uninstaller = false;
    let mut wrote_launcher_redirect = false;
    if !opts.portable {
        on_progress(93, "Installing uninstaller...");
        let uninstaller_path = install_dir.join("uninstall.exe");
        let embedded_uninstaller = staging_dir.join("uninstall.exe");
        if embedded_uninstaller.is_file() {
            if let Err(err) = swap_file_atomic(&embedded_uninstaller, &uninstaller_path) {
                let _ = fs::remove_dir_all(&staging_dir);
                return Err(err);
            }
        } else if let Err(err) =
            write_stripped_stub(exe_path, archive.trailer.payload_offset, &uninstaller_path)
        {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(err);
        }
        wrote_uninstaller = true;

        let launcher_cfg_path = install_dir.join("dragon-launcher.json");
        if needs_user_profile_redirect(install_dir) && !launcher_cfg_path.exists() {
            let cfg_json = serde_json::json!({
                "strip_bloat_on_launch": true,
                "custom_profile_dir": r"%LOCALAPPDATA%\Dragon Browser\profile"
            });
            fs::write(
                &launcher_cfg_path,
                serde_json::to_string_pretty(&cfg_json).unwrap() + "\n",
            )
            .map_err(|e| format!("Failed writing dragon-launcher.json: {e}"))?;
            wrote_launcher_redirect = true;
        }
    }

    let _ = fs::remove_dir_all(&staging_dir);

    on_progress(100, "Dragon Browser installation complete.");
    Ok(InstallResult {
        install_dir: install_dir.to_path_buf(),
        manifest,
        was_upgrade,
        wrote_uninstaller,
        wrote_launcher_redirect,
    })
}

/// Remove Dragon Browser managed files from `install_dir`.
/// Preserves `profile/` unless `remove_profile` is explicitly true.
pub fn perform_uninstall(install_dir: &Path, remove_profile: bool) -> Result<(), String> {
    if !install_dir.is_dir() {
        return Ok(());
    }

    for dir_name in ["runtime", "resources"] {
        let target = install_dir.join(dir_name);
        if target.is_dir() {
            fs::remove_dir_all(&target)
                .map_err(|e| format!("Failed removing {}: {e}", target.display()))?;
        }
    }

    for file_name in [
        "dragon-browser.exe",
        "dragon.ico",
        MANIFEST_FILENAME,
        "dragon-launcher.json",
    ] {
        let target = install_dir.join(file_name);
        if target.is_file() {
            fs::remove_file(&target)
                .map_err(|e| format!("Failed removing {}: {e}", target.display()))?;
        }
    }

    if remove_profile {
        let profile = install_dir.join("profile");
        if profile.is_dir() {
            fs::remove_dir_all(&profile)
                .map_err(|e| format!("Failed removing {}: {e}", profile.display()))?;
        }
    }

    // Attempt removing install_dir if now empty
    let _ = fs::remove_dir(install_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{build_test_sfx, build_test_zip};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!(
            "dragon_install_test_{tag}_{}_{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_sfx_file(path: &Path, version: &str, runtime_dll_name: &str) {
        let manifest = serde_json::json!({
            "app_name": "Dragon Browser",
            "app_version": "1.0.0",
            "engine": "Dragon Gecko ESR",
            "engine_channel": "esr",
            "engine_version": version,
            "display_version": format!("{version}esr"),
            "file_count": 4,
            "uncompressed_bytes": 64
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let runtime_dll_path = format!("runtime/{runtime_dll_name}");
        let zip_bytes = build_test_zip(&[
            (MANIFEST_FILENAME, &manifest_bytes),
            ("dragon-browser.exe", b"MZ-LAUNCHER"),
            ("dragon.ico", b"ICO-BYTES"),
            ("resources/user.js", b"user_pref(\"dragon\", true);\n"),
            ("runtime/dragon.exe", version.as_bytes()),
            (&runtime_dll_path, b"DLL"),
        ]);
        let sfx = build_test_sfx(b"MZ-INSTALLER-STUB-BYTES", &zip_bytes);
        fs::write(path, sfx).unwrap();
    }

    #[test]
    fn fresh_install_upgrade_preserves_profile_and_uninstalls_cleanly() {
        let work = temp_dir("lifecycle");
        let sfx_v1 = work.join("setup-v1.exe");
        let sfx_v2 = work.join("setup-v2.exe");
        let install_dir = work.join("DragonBrowser");

        make_sfx_file(&sfx_v1, "153.7.0", "old-engine.dll");
        make_sfx_file(&sfx_v2, "153.8.0", "new-engine.dll");

        // 1. Fresh install
        let res1 = perform_install(
            &sfx_v1,
            &InstallOptions {
                install_dir: install_dir.clone(),
                portable: false,
                create_desktop_shortcut: false,
                create_start_menu_shortcut: false,
                launch_after: false,
                silent: true,
            },
            |_, _| {},
        )
        .expect("fresh install");
        assert!(!res1.was_upgrade);
        assert!(res1.wrote_uninstaller);
        assert_eq!(fs::read(install_dir.join("uninstall.exe")).unwrap(), b"MZ-INSTALLER-STUB-BYTES");
        assert!(install_dir.join("runtime").join("old-engine.dll").is_file());

        // Seed user profile data + startupCache
        let profile_dir = install_dir.join("profile");
        let startup_cache = profile_dir.join("startupCache");
        fs::create_dir_all(&startup_cache).unwrap();
        fs::write(profile_dir.join("places.sqlite"), b"USER-BOOKMARKS").unwrap();
        fs::write(profile_dir.join("prefs.js"), b"user_pref(\"keep\", true);").unwrap();
        fs::write(startup_cache.join("cache.bin"), b"stale-bytecode").unwrap();

        // 2. In-place upgrade
        let res2 = perform_install(
            &sfx_v2,
            &InstallOptions {
                install_dir: install_dir.clone(),
                portable: false,
                create_desktop_shortcut: false,
                create_start_menu_shortcut: false,
                launch_after: false,
                silent: true,
            },
            |_, _| {},
        )
        .expect("in-place upgrade");
        assert!(res2.was_upgrade);
        assert_eq!(res2.manifest.engine_version, "153.8.0");
        assert!(!install_dir.join("runtime").join("old-engine.dll").exists());
        assert!(install_dir.join("runtime").join("new-engine.dll").is_file());
        assert_eq!(fs::read(install_dir.join("runtime").join("dragon.exe")).unwrap(), b"153.8.0");
        // Profile data intact & startupCache cleared
        assert_eq!(fs::read(profile_dir.join("places.sqlite")).unwrap(), b"USER-BOOKMARKS");
        assert_eq!(fs::read(profile_dir.join("prefs.js")).unwrap(), b"user_pref(\"keep\", true);");
        assert!(!startup_cache.exists());

        // 3. Uninstall keeping profile
        perform_uninstall(&install_dir, false).expect("uninstall keeping profile");
        assert!(!install_dir.join("runtime").exists());
        assert!(!install_dir.join("dragon-browser.exe").exists());
        assert!(profile_dir.join("places.sqlite").is_file());

        // 4. Uninstall removing profile
        perform_uninstall(&install_dir, true).expect("uninstall removing profile");
        assert!(!profile_dir.exists());

        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn needs_user_profile_redirect_detects_program_files() {
        assert!(needs_user_profile_redirect(Path::new(r"C:\Program Files\Dragon Browser")));
        assert!(needs_user_profile_redirect(Path::new(r"C:\Program Files (x86)\Dragon Browser")));
        assert!(!needs_user_profile_redirect(Path::new(r"C:\Users\Alice\AppData\Local\Dragon Browser")));
    }

    #[test]
    fn embedded_signed_uninstaller_is_preserved_instead_of_slicing_stub() {
        let work = temp_dir("signed_uninst");
        let sfx_path = work.join("setup.exe");
        let install_dir = work.join("DragonBrowser");

        let manifest = serde_json::json!({
            "app_name": "Dragon Browser",
            "app_version": "1.0.0",
            "engine": "Dragon Gecko ESR",
            "engine_channel": "esr",
            "engine_version": "153.7.0",
            "display_version": "153.7.0esr",
            "file_count": 5,
            "uncompressed_bytes": 64
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let signed_uninst = b"MZ-SIGNED-UNINSTALLER-BINARY-PAYLOAD";
        let zip_bytes = build_test_zip(&[
            (MANIFEST_FILENAME, &manifest_bytes),
            ("dragon-browser.exe", b"MZ-SIGNED-LAUNCHER"),
            ("dragon.ico", b"ICO"),
            ("uninstall.exe", signed_uninst),
            ("resources/user.js", b"user_pref(\"dragon\", true);\n"),
            ("runtime/dragon.exe", b"MZ-MOZILLA-SIGNED"),
        ]);
        let sfx = build_test_sfx(b"MZ-OUTER-STUB-WITH-PAYLOAD", &zip_bytes);
        fs::write(&sfx_path, sfx).unwrap();

        let res = perform_install(
            &sfx_path,
            &InstallOptions {
                install_dir: install_dir.clone(),
                portable: false,
                create_desktop_shortcut: false,
                create_start_menu_shortcut: false,
                launch_after: false,
                silent: true,
            },
            |_, _| {},
        )
        .expect("install with embedded signed uninstaller");
        assert!(res.wrote_uninstaller);
        assert_eq!(fs::read(install_dir.join("uninstall.exe")).unwrap(), signed_uninst);

        let _ = fs::remove_dir_all(&work);
    }
}
