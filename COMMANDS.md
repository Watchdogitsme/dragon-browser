# Dragon Browser — Essential Commands

All commands below assume you are in the repository root (`C:\VS\Dragon browser` on Windows PowerShell, or `/mnt/c/VS/Dragon browser` in WSL2/Bash).

> For deciding when you only need a quick local UI refresh vs. a full upgrade or signed release, see [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md).

---

## 1. Upgrade the Gecko Engine & Build a Windows Installer (One Command)

### Windows PowerShell (Recommended)
```powershell
# Upgrade Gecko ESR (default) if a newer version is out, then build Setup .exe
.\scripts\upgrade-and-package.ps1

# Upgrade to latest Rapid Release Firefox Gecko instead of ESR
.\scripts\upgrade-and-package.ps1 -Channel release

# Upgrade & generate BOTH Setup .exe and Portable .zip
.\scripts\upgrade-and-package.ps1 -AlsoZip

# Check if a newer Gecko engine is available without modifying anything
.\scripts\upgrade-and-package.ps1 -CheckOnly

# Force re-download & re-compile the engine, then rebuild installer
.\scripts\upgrade-and-package.ps1 -Force

# Package an installer right now from your current dist\runtime\ (no download)
.\scripts\upgrade-and-package.ps1 -SkipUpgrade -AlsoZip

# Pin a specific Gecko version
.\scripts\upgrade-and-package.ps1 -Channel esr -Version 153.8.0esr

# Full C++/Rust from-source Gecko compilation + installer packaging
.\scripts\upgrade-and-package.ps1 -FromSource
```

### WSL2 / Linux Bash
```bash
# Upgrade Gecko ESR (default) if newer, rebuild binaries, and build Setup .exe
bash scripts/upgrade-and-package.sh

# Switch to latest Rapid Release Gecko
bash scripts/upgrade-and-package.sh --channel release

# Generate BOTH Setup .exe and Portable .zip
bash scripts/upgrade-and-package.sh --also-zip

# Check if a newer Gecko engine is available
bash scripts/upgrade-and-package.sh --check-only

# Package installer immediately from current dist/runtime/
bash scripts/upgrade-and-package.sh --skip-upgrade --also-zip

# Force re-download & re-compile engine + package
bash scripts/upgrade-and-package.sh --force

# Full C++/Rust from-source Gecko compilation + installer packaging
bash scripts/upgrade-and-package.sh --from-source
```

Generated release artifacts land in `release/`:
- `release/DragonBrowser-Setup-<version>-win64.exe` — Self-contained native Windows installer
- `release/DragonBrowser-Portable-<version>-win64.zip` — Portable archive (when `-AlsoZip` / `--also-zip` is passed)
- `release/SHA256SUMS.txt` — SHA-256 verification checksums

---

## 2. Installing, Upgrading, and Using on Other Windows Devices

Copy `release\DragonBrowser-Setup-<version>-win64.exe` to any Windows x64 PC:

```powershell
# Interactive GUI install or in-place upgrade (double-click or run directly)
.\DragonBrowser-Setup-153.7.0esr-win64.exe

# Silent unattended install / upgrade into default %LOCALAPPDATA%\Dragon Browser
.\DragonBrowser-Setup-153.7.0esr-win64.exe /S

# Silent install into a custom folder (profile/ is preserved on upgrades)
.\DragonBrowser-Setup-153.7.0esr-win64.exe /S /D=D:\Apps\DragonBrowser

# Extract portable copy only (no shortcuts, registry entry, or uninstaller)
.\DragonBrowser-Setup-153.7.0esr-win64.exe /S --portable /D=D:\Portable\DragonBrowser

# Verify installer payload CRC32 & inspect embedded engine manifest
.\DragonBrowser-Setup-153.7.0esr-win64.exe --verify
.\DragonBrowser-Setup-153.7.0esr-win64.exe --info

# Uninstall from an installed folder (preserves profile\ by default)
.\uninstall.exe --uninstall
# Silent uninstall (add --remove-profile to also delete bookmarks/cookies/prefs)
.\uninstall.exe --uninstall --silent
```

> **Note:** Upgrading an existing installation automatically preserves `profile/` (bookmarks, history, logins, cookies, settings) and clears only `profile/startupCache/`.

---

## 3. Running Dragon Browser Launcher CLI

Inside `dist\` (or any installed Dragon Browser folder):

```powershell
.\dragon-browser.exe                       # Launch Dragon Browser
.\dragon-browser.exe https://example.com   # Launch and open URL(s)
.\dragon-browser.exe --private             # Launch in Private Browsing mode (-p)
.\dragon-browser.exe --reset-ui            # Re-sync UI CSS/JS, AutoConfig, user.js, policies
.\dragon-browser.exe --doctor              # Run bundle & runtime health diagnostics
.\dragon-browser.exe --doctor --json       # Output diagnostics as JSON
.\dragon-browser.exe --version             # Show launcher & Gecko engine version
```

---

## 4. Individual Engine & Packaging Scripts (Advanced)

```bash
# Check / upgrade engine only (without packaging an installer)
python3 engine/scripts/upgrade-engine.py --check-only
python3 engine/scripts/upgrade-engine.py --channel esr
python3 engine/scripts/upgrade-engine.py --channel release

# Re-compile Native Dragon Core & patches into an existing runtime
python3 engine/scripts/compile-engine-pack.py --runtime-dir dist/runtime --native-dir native --refresh-binary --verify

# Verify an already-compiled runtime
python3 engine/scripts/compile-engine-pack.py --runtime-dir dist/runtime --verify-only

# Rebuild Windows launcher & installer stub (WSL2 / cargo-zigbuild)
bash scripts/build.sh

# Package installer only from dist/
python3 scripts/package-installer.py --also-zip
```

---

## 5. Automated Tests & Post-Build Cleanup

```bash
# Run all Rust unit & integration tests (launcher, win-icon-res, installer)
PATH="$HOME/.cargo/bin:$PATH" cargo test --workspace --offline

# Run all Python bundle, engine, upgrader & installer tests
pytest -v tests/
```

```powershell
# Reclaim disk space after a full C++/Rust from-source Gecko build (never touches dist\)
powershell -ExecutionPolicy Bypass -File engine\scripts\cleanup-build-tools.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File engine\scripts\cleanup-build-tools.ps1
```

---

## 6. Windows Smart App Control, Signature Audits & GitHub Signed Releases

To pass **Windows 11 Smart App Control**, every `.exe` and `.dll` must carry a valid Microsoft Trusted Root signature:
- **Runtime (`runtime\*.exe`, `runtime\*.dll`)**: Uses official **Mozilla-signed** binaries (if your `dist\runtime\` came from an unsigned from-source compile, switch to Mozilla-signed ESR binaries with `-Force`):
  ```powershell
  .\scripts\upgrade-and-package.ps1 -Force
  ```
- **Audit all local Authenticode signatures**:
  ```powershell
  # Show signature status & signer for every .exe and .dll in dist\ and release\
  .\scripts\verify-signatures.ps1

  # Fail if any runtime binary is unsigned
  .\scripts\verify-signatures.ps1 -RuntimeOnly -Strict
  ```
- **Cut a SignPath-signed GitHub Release** (after completing [docs/SIGNPATH-SETUP.md](docs/SIGNPATH-SETUP.md)):
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
