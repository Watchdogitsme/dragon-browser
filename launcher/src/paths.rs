use std::io;
use std::path::{Path, PathBuf};

/// Canonical portable directory layout relative to `dragon-browser.exe`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableLayout {
    pub root: PathBuf,
    pub runtime_dir: PathBuf,
    pub runtime_distribution_dir: PathBuf,
    pub runtime_policies_json: PathBuf,
    pub runtime_autoconfig_pref_dir: PathBuf,
    pub runtime_autoconfig_js: PathBuf,
    pub runtime_dragon_cfg: PathBuf,
    pub profile_dir: PathBuf,
    pub profile_user_js: PathBuf,
    pub profile_chrome_dir: PathBuf,
    pub profile_user_chrome_css: PathBuf,
    pub profile_user_content_css: PathBuf,
    pub profile_dragon_chrome_js: PathBuf,
    pub resources_dir: PathBuf,
    pub resource_policies_template: PathBuf,
    pub resource_user_js: PathBuf,
    pub resource_autoconfig_js: PathBuf,
    pub resource_dragon_cfg: PathBuf,
    pub resource_dragon_chrome_js: PathBuf,
    pub resource_user_chrome_css: PathBuf,
    pub resource_user_content_css: PathBuf,
}

impl PortableLayout {
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = strip_windows_verbatim_prefix(&root.into());
        Self::build(root.clone(), root.join("runtime"), root.join("profile"))
    }

    pub fn with_overrides(
        self,
        custom_runtime_dir: Option<&str>,
        custom_profile_dir: Option<&str>,
    ) -> Self {
        let runtime_dir = match custom_runtime_dir {
            Some(dir) if !dir.trim().is_empty() => resolve_override(&self.root, dir),
            _ => self.runtime_dir,
        };
        let profile_dir = match custom_profile_dir {
            Some(dir) if !dir.trim().is_empty() => resolve_override(&self.root, dir),
            _ => self.profile_dir,
        };
        Self::build(self.root, runtime_dir, profile_dir)
    }

    pub fn with_profile_dir(self, profile_dir: PathBuf) -> Self {
        let clean = strip_windows_verbatim_prefix(&profile_dir);
        Self::build(self.root, self.runtime_dir, clean)
    }

    fn build(root: PathBuf, runtime_dir: PathBuf, profile_dir: PathBuf) -> Self {
        let runtime_distribution_dir = runtime_dir.join("distribution");
        let runtime_policies_json = runtime_distribution_dir.join("policies.json");
        let runtime_autoconfig_pref_dir = runtime_dir.join("defaults").join("pref");
        let runtime_autoconfig_js = runtime_autoconfig_pref_dir.join("autoconfig.js");
        let runtime_dragon_cfg = runtime_dir.join("dragon.cfg");

        let profile_user_js = profile_dir.join("user.js");
        let profile_chrome_dir = profile_dir.join("chrome");
        let profile_user_chrome_css = profile_chrome_dir.join("userChrome.css");
        let profile_user_content_css = profile_chrome_dir.join("userContent.css");
        let profile_dragon_chrome_js = profile_chrome_dir.join("dragon-chrome.uc.js");

        let resources_dir = root.join("resources");
        let resource_policies_template = resources_dir.join("policies.template.json");
        let resource_user_js = resources_dir.join("user.js");
        let resource_autoconfig_js = resources_dir.join("autoconfig").join("autoconfig.js");
        let resource_dragon_cfg = resources_dir.join("autoconfig").join("dragon.cfg");
        let resource_dragon_chrome_js = resources_dir.join("autoconfig").join("dragon-chrome.uc.js");
        let resource_user_chrome_css = resources_dir.join("chrome").join("userChrome.css");
        let resource_user_content_css = resources_dir.join("chrome").join("userContent.css");

        Self {
            root,
            runtime_dir,
            runtime_distribution_dir,
            runtime_policies_json,
            runtime_autoconfig_pref_dir,
            runtime_autoconfig_js,
            runtime_dragon_cfg,
            profile_dir,
            profile_user_js,
            profile_chrome_dir,
            profile_user_chrome_css,
            profile_user_content_css,
            profile_dragon_chrome_js,
            resources_dir,
            resource_policies_template,
            resource_user_js,
            resource_autoconfig_js,
            resource_dragon_cfg,
            resource_dragon_chrome_js,
            resource_user_chrome_css,
            resource_user_content_css,
        }
    }

    /// Resolve the portable root from `DRAGON_BROWSER_ROOT` (if set) or the executable directory.
    pub fn from_current_exe() -> io::Result<Self> {
        if let Ok(env_root) = std::env::var("DRAGON_BROWSER_ROOT") {
            let trimmed = env_root.trim();
            if !trimmed.is_empty() {
                let candidate = PathBuf::from(trimmed);
                let resolved = candidate.canonicalize().unwrap_or(candidate);
                return Ok(Self::from_root(resolved));
            }
        }

        let exe_path = std::env::current_exe()?;
        let exe_dir = exe_path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Could not determine parent directory of dragon-browser executable",
            )
        })?;
        let canonical = exe_dir
            .canonicalize()
            .unwrap_or_else(|_| exe_dir.to_path_buf());
        Ok(Self::from_root(canonical))
    }

    /// Return the path to the compiled Dragon Gecko executable (`runtime/dragon.exe`,
    /// or `runtime/dragon` on Unix when present alongside `runtime/dragon.exe` fallback).
    pub fn runtime_dragon_exe(&self) -> PathBuf {
        let win_exe = self.runtime_dir.join("dragon.exe");
        if win_exe.is_file() {
            return win_exe;
        }
        #[cfg(not(windows))]
        {
            let unix_bin = self.runtime_dir.join("dragon");
            if unix_bin.is_file() {
                return unix_bin;
            }
        }
        win_exe
    }

    /// Return the path to the compiled Dragon engine metadata stamp (`runtime/dragon-engine.json`).
    pub fn runtime_engine_stamp(&self) -> PathBuf {
        self.runtime_dir.join("dragon-engine.json")
    }

    /// Resolve the active Gecko runtime executable inside `runtime/`.
    /// Prefers the compiled Dragon Gecko engine (`runtime/dragon.exe` or `runtime/dragon`)
    /// when present on disk, falling back to `runtime/firefox.exe` (or `runtime/firefox`).
    pub fn resolve_runtime_executable(&self) -> PathBuf {
        let dragon_win = self.runtime_dir.join("dragon.exe");
        if dragon_win.is_file() {
            return dragon_win;
        }

        #[cfg(not(windows))]
        {
            let dragon_unix = self.runtime_dir.join("dragon");
            if dragon_unix.is_file() {
                return dragon_unix;
            }
        }

        let firefox_win = self.runtime_dir.join("firefox.exe");
        if firefox_win.is_file() {
            return firefox_win;
        }

        #[cfg(not(windows))]
        {
            let firefox_unix = self.runtime_dir.join("firefox");
            if firefox_unix.is_file() {
                return firefox_unix;
            }
        }

        firefox_win
    }

    /// All required source files inside `resources/`.
    pub fn required_resources(&self) -> [(&'static str, &Path); 7] {
        [
            ("policies.template.json", &self.resource_policies_template),
            ("user.js", &self.resource_user_js),
            ("autoconfig/autoconfig.js", &self.resource_autoconfig_js),
            ("autoconfig/dragon.cfg", &self.resource_dragon_cfg),
            ("autoconfig/dragon-chrome.uc.js", &self.resource_dragon_chrome_js),
            ("chrome/userChrome.css", &self.resource_user_chrome_css),
            ("chrome/userContent.css", &self.resource_user_content_css),
        ]
    }
}

/// Expand common Windows profile directory environment variables (`%LOCALAPPDATA%`,
/// `%APPDATA%`, `%USERPROFILE%`) inside override paths.
pub fn expand_windows_env_vars(raw: &str) -> String {
    let mut out = raw.to_string();
    for var_name in ["LOCALAPPDATA", "APPDATA", "USERPROFILE"] {
        if let Ok(val) = std::env::var(var_name) {
            if !val.trim().is_empty() {
                let token = format!("%{var_name}%");
                // Case-insensitive replacement
                loop {
                    let lower = out.to_ascii_lowercase();
                    let needle = token.to_ascii_lowercase();
                    let Some(idx) = lower.find(&needle) else {
                        break;
                    };
                    out.replace_range(idx..idx + needle.len(), &val);
                }
            }
        }
    }
    out
}

/// Default per-user fallback profile directory (`%LOCALAPPDATA%\Dragon Browser\profile`)
/// used when the installation directory itself is read-only.
pub fn default_user_profile_dir() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let trimmed = local_app_data.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(
        strip_windows_verbatim_prefix(&PathBuf::from(trimmed))
            .join("Dragon Browser")
            .join("profile"),
    )
}

fn resolve_override(root: &Path, raw: &str) -> PathBuf {
    let expanded = expand_windows_env_vars(raw.trim());
    let candidate = PathBuf::from(&expanded);
    if candidate.is_absolute() || is_windows_drive_path(&expanded) || expanded.starts_with(r"\\") {
        strip_windows_verbatim_prefix(&candidate)
    } else {
        strip_windows_verbatim_prefix(&root.join(candidate))
    }
}

/// Remove Windows extended-length verbatim prefixes (`\\?\` and `\\?\UNC\`)
/// that `fs::canonicalize` produces on Windows and that Gecko CLI/policies can reject.
pub fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = strip_prefix_ignore_ascii_case(&raw, r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = strip_prefix_ignore_ascii_case(&raw, "//?/UNC/") {
        return PathBuf::from(format!(r"\\{}", rest.replace('/', r"\")));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    if let Some(rest) = raw.strip_prefix("//?/") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn is_windows_drive_path(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'\\' || bytes[2] == b'/')
}

fn strip_prefix_ignore_ascii_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix_len = prefix.len();
    if s.len() >= prefix_len
        && s.is_char_boundary(prefix_len)
        && s[..prefix_len].eq_ignore_ascii_case(prefix)
    {
        Some(&s[prefix_len..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_verbatim_prefixes_are_stripped() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\C:\VS\Dragon browser\profile")),
            PathBuf::from(r"C:\VS\Dragon browser\profile")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(
                r"\\?\UNC\FileServer\Shared Apps\Dragon browser\profile"
            )),
            PathBuf::from(r"\\FileServer\Shared Apps\Dragon browser\profile")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new("/mnt/c/VS/Dragon browser/profile")),
            PathBuf::from("/mnt/c/VS/Dragon browser/profile")
        );
    }

    #[test]
    fn portable_layout_matches_shared_contract() {
        let layout = PortableLayout::from_root("/opt/Dragon browser");
        assert_eq!(
            layout.runtime_policies_json,
            PathBuf::from("/opt/Dragon browser/runtime/distribution/policies.json")
        );
        assert_eq!(
            layout.runtime_autoconfig_js,
            PathBuf::from("/opt/Dragon browser/runtime/defaults/pref/autoconfig.js")
        );
        assert_eq!(
            layout.runtime_dragon_cfg,
            PathBuf::from("/opt/Dragon browser/runtime/dragon.cfg")
        );
        assert_eq!(
            layout.profile_user_js,
            PathBuf::from("/opt/Dragon browser/profile/user.js")
        );
        assert_eq!(
            layout.profile_user_chrome_css,
            PathBuf::from("/opt/Dragon browser/profile/chrome/userChrome.css")
        );
        assert_eq!(
            layout.profile_user_content_css,
            PathBuf::from("/opt/Dragon browser/profile/chrome/userContent.css")
        );
        assert_eq!(
            layout.profile_dragon_chrome_js,
            PathBuf::from("/opt/Dragon browser/profile/chrome/dragon-chrome.uc.js")
        );
        assert_eq!(
            layout.runtime_dragon_exe(),
            PathBuf::from("/opt/Dragon browser/runtime/dragon.exe")
        );
        assert_eq!(
            layout.runtime_engine_stamp(),
            PathBuf::from("/opt/Dragon browser/runtime/dragon-engine.json")
        );
        assert_eq!(
            layout.resolve_runtime_executable(),
            PathBuf::from("/opt/Dragon browser/runtime/firefox.exe")
        );
        assert_eq!(layout.required_resources().len(), 7);
    }

    #[test]
    fn resolve_runtime_executable_prefers_dragon_exe_and_falls_back_to_firefox_exe() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dragon_paths_resolve_test_{}_{}",
            std::process::id(),
            nanos
        ));
        let layout = PortableLayout::from_root(&root);
        fs::create_dir_all(&layout.runtime_dir).unwrap();

        // 1. When runtime/ is empty, defaults to runtime/firefox.exe
        assert_eq!(
            layout.resolve_runtime_executable(),
            layout.runtime_dir.join("firefox.exe")
        );

        // 2. When only firefox.exe exists, resolves to firefox.exe
        let firefox_exe = layout.runtime_dir.join("firefox.exe");
        fs::write(&firefox_exe, b"MZ-firefox").unwrap();
        assert_eq!(layout.resolve_runtime_executable(), firefox_exe);

        // 3. When dragon.exe is added alongside firefox.exe, prefers dragon.exe
        let dragon_exe = layout.runtime_dir.join("dragon.exe");
        fs::write(&dragon_exe, b"MZ-dragon").unwrap();
        assert_eq!(layout.resolve_runtime_executable(), dragon_exe);
        assert_eq!(layout.runtime_dragon_exe(), dragon_exe);

        // 4. When dragon.exe is removed, falls back to firefox.exe
        fs::remove_file(&dragon_exe).unwrap();
        assert_eq!(layout.resolve_runtime_executable(), firefox_exe);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_override_expands_windows_env_vars() {
        std::env::set_var("LOCALAPPDATA", "/tmp/dragon-localappdata-test");
        let layout = PortableLayout::from_root("/opt/DragonBrowser")
            .with_overrides(None, Some(r"%LOCALAPPDATA%\Dragon Browser\profile"));
        assert!(layout
            .profile_dir
            .to_string_lossy()
            .starts_with("/tmp/dragon-localappdata-test"));
        assert!(layout.profile_dir.to_string_lossy().contains("profile"));
        std::env::remove_var("LOCALAPPDATA");
    }
}
