# Dragon Browser

A lightweight, low-RAM, consolidated-process, portable Windows desktop browser powered by the compiled **Dragon Gecko ESR Engine** (`dragon.exe` + compiled `omni.ja` & `browser/omni.ja`), a native **Rust launcher**, and the 100% native **Dragon Core** (`chrome://dragon` & `resource://dragon`).

## Key Features

- **Compiled Dragon Gecko Engine**: Strips Mozilla telemetry, crash reporting, updater, maintenance services, on-device ML (`onnxruntime.dll`, `mozinference.dll`), and API keys directly inside `omni.ja` / `AppConstants.sys.mjs`, embeds `native/` into `browser/omni.ja`, prunes duplicate unpacked runtime files, and ships a lean `runtime/dragon.exe` with `runtime/dragon-engine.json`.
- **Consolidated Process & Low-RAM Architecture**: Uses Balanced Fission (`IsolateHighValue`, `dom.ipc.processCount=2`, `webIsolated=1`), disables idle prelaunched content processes, keeps `privilegedabout` & ML inference processes off, disables auto-started built-in Mozilla WebExtensions (while keeping them installable on demand as Recommended Optional Extensions in **Dragon Settings -> Extensions** and `about:addons`), and caps memory/canvas/image/media caches.
- **Adaptive Zero-Top-Bar Home Mode**: Launches into a clean, full-bleed dark obsidian Home Page with no toolbar clutter. Opening any website or a 2nd tab smoothly transitions into an ultra-compact (~36px) single-row navigation & tab bar.
- **Instant Search & Direct AI Switching**: Search Google, DuckDuckGo, Brave, Bing, or Startpage—or jump straight into **Gemini**, **Claude**, **ChatGPT**, or **Perplexity** via clickable chips or `@prefix` shortcuts (including automatic prompt submission on Gemini).
- **Dragon Shield (Built-in Ad & Tracker Blocker)**: Native `http-on-modify-request` network filter + shared-memory cosmetic element hiding, per-site allowlist toggles, custom domain blocks, and automatic Obsidian Force Dark mode.
- **Auto-Sleeping Tabs & Heap Reclamation**: Automatically discards idle tabs after a configurable timeout (default 5 min) while exempting active, pinned, audible, and excluded domains—plus memory-pressure heap minimization on sleep.
- **Split-Screen View & Reader Mode**: Side-by-side browsing (`Ctrl+Alt+S`) and dark-themed Reader Mode (`Ctrl+Alt+R`).
- **Zero Bloat & Portable**: Self-contained folder (`runtime/`, `profile/`, `resources/`) with no legacy WebExtension XPI overhead.

---

## Upgrading the Gecko Engine & Building a Windows Installer

Use the single-command upgrader & packager to pull the latest Gecko engine (Firefox ESR by default, or Rapid Release via `--channel release`), re-compile Dragon's zero-telemetry `omni.ja` & Native Core, and produce a self-contained Windows Setup `.exe` in `release/` for use on other devices:

```powershell
# Windows PowerShell
.\scripts\upgrade-and-package.ps1
.\scripts\upgrade-and-package.ps1 -Channel release -AlsoZip
```

```bash
# WSL2 / Linux
bash scripts/upgrade-and-package.sh
bash scripts/upgrade-and-package.sh --channel release --also-zip
```

See [COMMANDS.md](COMMANDS.md) for the complete reference of engine upgrade, multi-device installation (`/S`, `/D=`, `--portable`, `--uninstall`), launcher, and test commands.

---

## Building from Source (WSL2 / Linux)

### Prerequisites
- Rust toolchain + `cargo-zigbuild` + `zig` (in `$HOME/.cargo/bin`)
- `zip`, `python3`, `pytest`

### Build the Portable Windows Bundle & Instant Engine Pack Compiler
```bash
bash scripts/build.sh
```
This end-to-end build pipeline:
1. Generates multi-resolution Dragon PNG & Windows ICO branding assets (`engine/scripts/generate-branding-assets.py`).
2. Compiles `dragon-browser.exe` (`x86_64-pc-windows-gnu`), which prefers `runtime/dragon.exe` and falls back to `runtime/firefox.exe` when needed.
3. Copies Gecko templates (`gecko/`) and runtime setup scripts into `dist/`.
4. **Instant Engine Pack Compiler**: Whenever `dist/runtime/omni.ja` and `dist/runtime/browser/omni.ja` are present, `scripts/build.sh` automatically invokes `engine/scripts/compile-engine-pack.py`:
   ```bash
   python3 engine/scripts/compile-engine-pack.py \
     --runtime-dir dist/runtime \
     --native-dir native
   ```
   Using `engine/scripts/mozjar.py` (pure-Python Mozilla `optimizejars` compiler), this re-compiles:
   - `runtime/omni.ja`: patches `modules/AppConstants.sys.mjs`, transforms toolkit branding strings, surfaces Dragon's Recommended Optional Extensions in `about:addons`, and prunes telemetry/update/ML component hooks.
   - `runtime/browser/omni.ja`: embeds `native/modules/` & `native/content/` as `chrome://dragon` / `resource://dragon`, embeds Dragon branding & compiled preferences (`DRAGON_ENGINE_COMPILED_PREFS`), disables auto-started Mozilla built-in add-ons in `built_in_addons.json` (keeping them installable on demand), and prunes telemetry/GenAI startup hooks.
   - Prunes duplicate unpacked runtime directories/files already inside `omni.ja` plus test/updater/ML bloat binaries, leaving a lean `dist/runtime/`.

### Run Tests
```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test
pytest -v tests/test_dragon_bundle.py tests/test_dragon_engine.py
```

---

## Full From-Source `mozilla-esr153` C++/Rust Engine Build Pipeline

To compile the entire Gecko / SpiderMonkey C++ and Rust engine from Mozilla's official `mozilla-esr153` (`153.7.0esr`) source tarball with Dragon branding, mozconfigs (`engine/mozconfig.win64` / `engine/mozconfig.linux64`), and all 4 source patches (`engine/patches/0001..0004`):

### Windows (MozillaBuild + Visual Studio — Self-Healing)
1. **Fetch source & apply the Dragon overlay**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File engine\scripts\fetch-source.ps1
   ```
2. **Verify the patched source tree** (optional):
   ```powershell
   python3 engine\scripts\apply-overlay.py --src-dir engine\src\firefox-153.7.0 --verify
   ```
3. **Compile & package the Dragon Gecko engine**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File engine\scripts\build-engine.ps1
   ```

### Linux / WSL2
```bash
bash engine/scripts/fetch-source.sh
bash engine/scripts/build-engine.sh
```

---

## Setting Up the Portable Runtime (Quick Bootstrap)

If you prefer not to run a multi-hour C++/Rust Gecko compilation, bootstrap `dist/runtime/` from Mozilla's official Firefox ESR Win64 build and then run `bash scripts/build.sh` so the Instant Engine Pack Compiler transforms it into the lean Dragon Gecko Engine (`dragon.exe` + compiled `omni.ja`).

### Option 1: Native Windows PowerShell (Recommended)
Open PowerShell inside `dist\` and run:
```powershell
.\setup-runtime.ps1
```

### Option 2: WSL2 / Linux (requires `7z`)
```bash
bash dist/setup-runtime.sh
```
Then run `bash scripts/build.sh` to compile and prune `dist/runtime/`.

---

## Usage & CLI Flags

From `dist\` on Windows:
```powershell
.\dragon-browser.exe                       # Launch Dragon Browser
.\dragon-browser.exe https://example.com   # Launch and open URL(s)
.\dragon-browser.exe --private             # Launch in Private Browsing mode (-p)
.\dragon-browser.exe --reset-ui            # Force re-sync chrome CSS, policies & user.js
.\dragon-browser.exe --doctor              # Run bundle & runtime health diagnostics
.\dragon-browser.exe --help                # Show CLI help
```

---

## Search & AI Shortcuts

Type any prefix in the Dragon Home Page search bar or the browser address bar:

| Target | Prefixes |
| --- | --- |
| **Google** (default) | `@google`, `!g` |
| **DuckDuckGo** | `@ddg`, `!ddg` |
| **Brave Search** | `@brave`, `!b` |
| **Bing** | `@bing` |
| **Startpage** | `@sp` |
| **Gemini** | `@gemini`, `!gm` |
| **Claude** | `@claude`, `!cl` |
| **ChatGPT** | `@gpt`, `@chatgpt`, `!gpt` |
| **Perplexity** | `@perp`, `@perplexity`, `!p` |

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+S` | Toggle Split-Screen View |
| `Ctrl+Alt+R` | Toggle Reader Mode |
| `Ctrl+Shift+L` | Quick URL Bar Summon |
| `Ctrl+Shift+P` | Open New Private Window |
| `Ctrl+T` / `Ctrl+W` | New Tab / Close Tab |
| `Tab` (Home Page) | Cycle Search & AI target chips |

---

## Portable `dist/` Layout

```text
dist/
├── dragon-browser.exe
├── setup-runtime.ps1
├── setup-runtime.sh
├── resources/
│   ├── user.js
│   ├── policies.template.json
│   ├── autoconfig/
│   │   ├── autoconfig.js
│   │   ├── dragon.cfg
│   │   └── dragon-chrome.uc.js
│   └── chrome/
│       ├── userChrome.css
│       └── userContent.css
├── runtime/          # Lean Compiled Dragon Gecko Engine (dragon.exe, dragon-engine.json, compiled omni.ja)
└── profile/          # Created & synced automatically on first launch
```

---

## Code Signing Policy & Windows Smart App Control

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

### Governance & Team Roles
- **Committers & Reviewers**: Repository maintainers who author, review, and merge changes on `main`.
- **Approvers**: Designated project maintainers authorized in SignPath to approve release signing requests from `.github/workflows/release-signed.yml`.

### Signing Scope & Third-Party Binaries
- **Dragon Browser custom binaries** (`dragon-browser.exe`, `uninstall.exe`, and `DragonBrowser-Setup-*-win64.exe`) are compiled from this public repository on GitHub-hosted `windows-latest` runners and signed by **SignPath Foundation**.
- **Gecko runtime libraries** inside `runtime/` (`dragon.exe` and `.dll` files) originate from official Mozilla Win64 releases verified against Mozilla `SHA256SUMS` and retain their original **Mozilla Corporation** Authenticode signatures without re-signing.

### Privacy Policy
Dragon Browser collects zero telemetry, crash reports, analytics, or personal data. Telemetry, Normandy studies, Pocket, and Mozilla updater endpoints are stripped at build time. Network requests occur solely from user-initiated browsing, user-triggered searches, or explicit manual engine update checks (`upgrade-engine.py`).

### Project Documentation
- [LICENSE](LICENSE) (Mozilla Public License 2.0)
- [SECURITY.md](SECURITY.md) (Vulnerability reporting & release signature verification)
- [docs/SIGNPATH-SETUP.md](docs/SIGNPATH-SETUP.md) (GitHub + SignPath Foundation setup guide)
- [docs/DEV-WORKFLOW.md](docs/DEV-WORKFLOW.md) (Fast local UI iteration vs. signed release workflow)
- [COMMANDS.md](COMMANDS.md) (Upgrade, installer, audit & test commands)
