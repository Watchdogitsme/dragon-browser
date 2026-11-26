# Dragon Browser — Development & UI Iteration Workflow

Use this guide in any session to know the fastest way to test changes locally vs. shipping updates to other Windows devices (including Windows 11 with **Smart App Control** turned **On**).

---

## Quick Decision Matrix

| What you changed | Fast local test (your PC) | Local unsigned installer (SAC Off) | Signed release for other PCs (SAC On) |
| :--- | :--- | :--- | :--- |
| **Chrome UI / CSS / AutoConfig**<br>(`gecko/chrome/userChrome.css`, `userContent.css`, `dragon-chrome.uc.js`, `user.js`, `policies.template.json`) | Copy into `dist/resources/` and run `.\dragon-browser.exe --reset-ui` *(no engine download, no Rust compile)* | `.\scripts\upgrade-and-package.ps1 -SkipUpgrade -ReuseBinaries` | Push to `main` & run `.github/workflows/release-signed.yml` |
| **Home / Settings / Native Core**<br>(`native/content/*`, `native/modules/*`) | Re-pack `omni.ja` in ~2s with `compile-engine-pack.py`, then run `.\dragon-browser.exe --reset-ui` | `.\scripts\upgrade-and-package.ps1 -SkipUpgrade -ReuseBinaries` | Push to `main` & run `.github/workflows/release-signed.yml` |
| **Launcher / Installer Rust code**<br>(`launcher/src/*`, `installer/src/*`) | `bash scripts/build.sh` (or `cargo build --release`) | `.\scripts\upgrade-and-package.ps1 -SkipUpgrade` | Push to `main` & run `.github/workflows/release-signed.yml` |
| **Gecko Engine upgrade**<br>(new Firefox ESR or Rapid Release) | `.\scripts\upgrade-and-package.ps1` (or `-Channel release`) | `.\scripts\upgrade-and-package.ps1` (`-AlsoZip` optional) | Run `.github/workflows/release-signed.yml` on GitHub |

---

## 1. Fast Local UI Iteration (Seconds, Zero Rebuilds)

### A. Editing Browser Chrome (`gecko/`)
Files:
- `gecko/chrome/userChrome.css` (tab bar, URL bar, floating pills, window chrome)
- `gecko/chrome/userContent.css` (internal page styles)
- `gecko/autoconfig/dragon-chrome.uc.js` (window chrome behavior, shortcuts, split view, Shield popover)
- `gecko/user.js` & `gecko/policies.template.json`

Sync into `dist/resources/` and relaunch with `--reset-ui` (clears `profile/startupCache/` and re-syncs without touching bookmarks/cookies/history):
```powershell
Copy-Item gecko\chrome\* dist\resources\chrome\ -Force
Copy-Item gecko\autoconfig\* dist\resources\autoconfig\ -Force
Copy-Item gecko\user.js dist\resources\user.js -Force
Copy-Item gecko\policies.template.json dist\resources\policies.template.json -Force
.\dist\dragon-browser.exe --reset-ui
```

### B. Editing Native Pages & Core Modules (`native/`)
Files:
- `native/content/home/*`, `native/content/settings/*`
- `native/modules/*.sys.mjs`, `native/modules/filter-lists.json`

These are embedded inside `dist/runtime/browser/omni.ja`. Re-compile just `omni.ja` in ~2 seconds (no engine download, no Rust compile):
```bash
python3 engine/scripts/compile-engine-pack.py --runtime-dir dist/runtime --native-dir native
```
Then relaunch with `--reset-ui` so Gecko reloads the updated `omni.ja` instead of cached bytecode:
```powershell
.\dist\dragon-browser.exe --reset-ui
```

---

## 2. Building an Updated Local Installer (No Engine Download)

When you only changed UI, `native/`, or `gecko/` files and want a new local `DragonBrowser-Setup-*.exe` without re-downloading Gecko or recompiling Rust:

```powershell
# Windows PowerShell (~15s)
.\scripts\upgrade-and-package.ps1 -SkipUpgrade -ReuseBinaries
```
```bash
# WSL2 / Linux (~15s)
bash scripts/upgrade-and-package.sh --skip-upgrade --reuse-binaries
```

---

## 3. Why Smart App Control Still Needs a GitHub Release for Setup `.exe`

- **Smart App Control (SAC)** only verifies **`.exe` and `.dll` Authenticode signatures** — it does **not** check `userChrome.css`, `dragon-chrome.uc.js`, or `omni.ja`.
- However, `DragonBrowser-Setup-<version>-win64.exe` bundles all UI files inside itself, so any UI edit changes the `.exe` hash and invalidates the outer SignPath signature.
- Therefore:
  1. **To distribute a single-file Setup `.exe` to any Windows 11 PC with SAC On**: push your changes to GitHub and run `.github/workflows/release-signed.yml` (via a `v*` tag or *Actions → Release (Signed) → Run workflow*).
  2. **Hot-swap tip for already-installed PCs**: if another PC already has a SignPath-signed `dragon-browser.exe` + Mozilla-signed `runtime/`, copying updated `resources/` or `runtime/browser/omni.ja` into that install folder will **not** trigger Smart App Control because none of the signed `.exe`/`.dll` binaries changed.
