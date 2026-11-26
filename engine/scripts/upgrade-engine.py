#!/usr/bin/env python3
"""
Dragon Browser — Cross-Platform Gecko Engine Upgrader (`upgrade-engine.py`).

Upgrades Dragon Browser's Gecko engine safely in an isolated staging directory,
re-compiles Dragon's zero-telemetry `omni.ja` & `browser/omni.ja` with Native Core,
verifies integrity and upstream Gecko hooks, atomically swaps `dist/runtime/` with
automatic rollback on failure, and clears only `dist/profile/startupCache/` while
100% preserving all user profile data.

Supports:
  - Fast Binary Engine Upgrade (default, ~30-60s) from Mozilla ESR (`--channel esr`)
    or Rapid Release (`--channel release`), with SHA256SUMS verification.
  - Exact version pinning (`--version 153.8.0esr` / `--version 154.0`).
  - Version check mode (`--check-only [--json]`).
  - Offline / test staging (`--local-installer <exe>` or `--local-runtime <dir>`).
  - Full From-Source C++/Rust compilation (`--from-source`).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_DIR = SCRIPT_DIR.parent
REPO_ROOT = ENGINE_DIR.parent

PRODUCT_DETAILS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json"
ARCHIVE_BASE_URL = "https://archive.mozilla.org/pub/firefox/releases"
USER_AGENT = "DragonBrowser-EngineUpgrader/1.0"


def _load_compile_engine_pack() -> Any:
    cep_path = SCRIPT_DIR / "compile-engine-pack.py"
    spec = importlib.util.spec_from_file_location("compile_engine_pack", cep_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {cep_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["compile_engine_pack"] = mod
    spec.loader.exec_module(mod)
    return mod


def _http_get_bytes(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _http_download_file(url: str, dest: Path, timeout: int = 300) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    if part.exists():
        part.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(part, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        downloaded = 0
        last_pct = -10
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = int(downloaded * 100 / total)
                if pct >= last_pct + 20:
                    last_pct = pct
                    mb_done = downloaded / (1024 * 1024)
                    mb_total = total / (1024 * 1024)
                    print(f"    Downloading: {pct:3d}% ({mb_done:.1f} / {mb_total:.1f} MiB)")
    os.replace(part, dest)


def parse_version_tuple(version_str: str) -> Tuple[int, ...]:
    """Parse version string (e.g. '153.7.0esr', '154.0.1') into a numeric tuple for comparison."""
    cleaned = re.sub(r"(?:esr|a\d+|b\d+)$", "", version_str.strip(), flags=re.IGNORECASE)
    parts: List[int] = []
    for seg in cleaned.split("."):
        m = re.match(r"^(\d+)", seg)
        if m:
            parts.append(int(m.group(1)))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def compare_versions(installed: str, available: str) -> int:
    """Return -1 if installed < available, 0 if equal, 1 if installed > available."""
    if not installed or installed == "unknown":
        return -1
    a = parse_version_tuple(installed)
    b = parse_version_tuple(available)
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def get_installed_engine_info(runtime_dir: Path) -> Dict[str, Any]:
    """Read currently installed Dragon Gecko engine metadata from `runtime_dir`."""
    cep = _load_compile_engine_pack()
    stamp_path = runtime_dir / "dragon-engine.json"
    info: Dict[str, Any] = {
        "installed": False,
        "engine": None,
        "channel": None,
        "version": None,
        "display_version": None,
        "build_id": None,
        "binary_present": False,
    }
    if not runtime_dir.is_dir():
        return info

    dragon_exe = runtime_dir / "dragon.exe"
    firefox_exe = runtime_dir / "firefox.exe"
    info["binary_present"] = dragon_exe.is_file() or firefox_exe.is_file()

    if stamp_path.is_file():
        try:
            stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
            info.update(
                {
                    "installed": info["binary_present"],
                    "engine": stamp.get("engine"),
                    "channel": stamp.get("channel"),
                    "version": stamp.get("version"),
                    "display_version": stamp.get("display_version") or stamp.get("version"),
                    "build_id": stamp.get("build_id"),
                }
            )
        except (OSError, json.JSONDecodeError):
            pass

    if not info.get("version") or info.get("version") == "unknown":
        detected = cep.detect_runtime_metadata(runtime_dir)
        if detected["version"] != "unknown":
            info["installed"] = info["binary_present"]
            info["engine"] = info["engine"] or detected["engine"]
            info["channel"] = info["channel"] or detected["channel"]
            info["version"] = detected["version"]
            info["display_version"] = detected["display_version"]
            info["build_id"] = detected["build_id"]

    return info


def resolve_latest_version(
    channel: str = "esr",
    pinned_version: Optional[str] = None,
    product_details_fetcher: Callable[[str], bytes] = _http_get_bytes,
) -> Dict[str, str]:
    """Resolve target Gecko version, installer download URL, and SHA256SUMS URL."""
    channel = channel.lower().strip()
    if channel not in ("esr", "release"):
        raise ValueError(f"Unsupported channel '{channel}' (expected 'esr' or 'release')")

    if pinned_version:
        version = pinned_version.strip()
        if channel == "esr" and not version.lower().endswith("esr"):
            version = f"{version}esr"
    else:
        raw = product_details_fetcher(PRODUCT_DETAILS_URL)
        data = json.loads(raw.decode("utf-8"))
        if channel == "esr":
            version = (data.get("FIREFOX_ESR_NEXT") or data.get("FIREFOX_ESR") or "").strip()
            if not version:
                raise RuntimeError("Mozilla product-details did not return FIREFOX_ESR")
        else:
            version = (data.get("LATEST_FIREFOX_VERSION") or "").strip()
            if not version:
                raise RuntimeError("Mozilla product-details did not return LATEST_FIREFOX_VERSION")

    installer_name = f"Firefox Setup {version}.exe"
    rel_installer_path = f"win64/en-US/{installer_name}"
    download_url = f"{ARCHIVE_BASE_URL}/{version}/win64/en-US/{urllib.parse.quote(installer_name)}"
    sha256sums_url = f"{ARCHIVE_BASE_URL}/{version}/SHA256SUMS"
    redirect_product = "firefox-esr-latest-ssl" if channel == "esr" else "firefox-latest-ssl"
    redirect_url = f"https://download.mozilla.org/?product={redirect_product}&os=win64&lang=en-US"

    return {
        "channel": channel,
        "version": version,
        "base_version": re.sub(r"esr$", "", version, flags=re.IGNORECASE),
        "installer_name": installer_name,
        "rel_installer_path": rel_installer_path,
        "download_url": download_url,
        "sha256sums_url": sha256sums_url,
        "redirect_url": redirect_url,
    }


def verify_sha256(file_path: Path, sha256sums_text: str, rel_suffix: str) -> Tuple[bool, str]:
    """Verify `file_path` SHA-256 against a Mozilla `SHA256SUMS` document."""
    expected: Optional[str] = None
    norm_suffix = rel_suffix.replace("\\", "/").lstrip("./")
    for line in sha256sums_text.splitlines():
        m = re.match(r"^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
        if not m:
            continue
        digest, rel_path = m.group(1).lower(), m.group(2).replace("\\", "/").lstrip("./")
        if rel_path == norm_suffix or rel_path.endswith("/" + norm_suffix):
            expected = digest
            break

    if expected is None:
        return False, f"Entry '{norm_suffix}' not found in SHA256SUMS"

    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            buf = f.read(1024 * 256)
            if not buf:
                break
            h.update(buf)
    actual = h.hexdigest().lower()
    if actual != expected:
        return False, f"SHA-256 mismatch: expected {expected}, got {actual}"
    return True, actual


def _find_seven_zip() -> Optional[str]:
    for name in ("7z", "7zz", "7z.exe"):
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == "win32":
        for root_env in ("ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(root_env)
            if base:
                candidate = Path(base) / "7-Zip" / "7z.exe"
                if candidate.is_file():
                    return str(candidate)
    else:
        for candidate in (
            Path("/mnt/c/Program Files/7-Zip/7z.exe"),
            Path("/mnt/c/Program Files (x86)/7-Zip/7z.exe"),
        ):
            if candidate.is_file():
                return str(candidate)
    return None


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False


def _to_win_path(p: Path) -> str:
    res = subprocess.run(["wslpath", "-w", str(p)], capture_output=True, text=True, check=True)
    return res.stdout.strip()


def extract_mozilla_installer(installer_exe: Path, dest_dir: Path) -> None:
    """Extract Mozilla Firefox Win64 installer `core/` payload into `dest_dir`."""
    installer_exe = installer_exe.resolve()
    dest_dir = dest_dir.resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    seven_zip = _find_seven_zip()
    if seven_zip:
        stage = dest_dir.parent / f".extract-{os.getpid()}-{int(time.time())}"
        stage.mkdir(parents=True, exist_ok=True)
        try:
            if seven_zip.lower().endswith(".exe") and sys.platform != "win32" and _is_wsl():
                inst_arg = _to_win_path(installer_exe)
                out_arg = _to_win_path(stage)
            else:
                inst_arg = str(installer_exe)
                out_arg = str(stage)
            res = subprocess.run(
                [seven_zip, "x", "-y", f"-o{out_arg}", inst_arg, "core/*"],
                capture_output=True,
                text=True,
                check=False,
            )
            core_dir = stage / "core"
            if res.returncode == 0 and (core_dir / "firefox.exe").is_file():
                shutil.copytree(core_dir, dest_dir, dirs_exist_ok=True)
                return
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    if sys.platform == "win32":
        install_args = (
            f'/S /InstallDirectoryPath="{dest_dir}" '
            "/MaintenanceService=false /TaskbarShortcut=false "
            "/DesktopShortcut=false /StartMenuShortcut=false"
        )
        ps_cmd = (
            f"$p = Start-Process -FilePath '{str(installer_exe)}' "
            f"-ArgumentList '{install_args}' -Wait -PassThru; exit $p.ExitCode"
        )
        res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], check=False)
        if res.returncode != 0 or not (dest_dir / "firefox.exe").is_file():
            raise RuntimeError(
                f"Mozilla silent installer extraction failed (exit={res.returncode})"
            )
        return

    raise RuntimeError(
        "No 7-Zip extractor (`7z` or `7zz`) found in this Linux/WSL environment.\n"
        "Install p7zip-full (`sudo apt update && sudo apt install -y p7zip-full`) "
        "or run the Windows PowerShell script instead:\n"
        "  .\\scripts\\upgrade-and-package.ps1"
    )


def sync_gecko_runtime_files(runtime_dir: Path, gecko_dir: Path) -> None:
    """Pre-sync `policies.json`, `autoconfig.js`, and `dragon.cfg` into `runtime_dir`."""
    policies_src = gecko_dir / "policies.template.json"
    autoconfig_src = gecko_dir / "autoconfig" / "autoconfig.js"
    dragon_cfg_src = gecko_dir / "autoconfig" / "dragon.cfg"

    if policies_src.is_file():
        policies_text = policies_src.read_text(encoding="utf-8")
        parsed = json.loads(policies_text)
        if not isinstance(parsed.get("policies"), dict):
            raise ValueError("policies.template.json must contain a top-level 'policies' object")
        dist_dir = runtime_dir / "distribution"
        dist_dir.mkdir(parents=True, exist_ok=True)
        (dist_dir / "policies.json").write_text(policies_text, encoding="utf-8")

    if autoconfig_src.is_file():
        pref_dir = runtime_dir / "defaults" / "pref"
        pref_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(autoconfig_src, pref_dir / "autoconfig.js")

    if dragon_cfg_src.is_file():
        shutil.copy2(dragon_cfg_src, runtime_dir / "dragon.cfg")


def check_runtime_not_locked(runtime_dir: Path) -> None:
    """Ensure `dragon.exe` / `firefox.exe` are not actively locked by a running browser."""
    if sys.platform != "win32" or not runtime_dir.is_dir():
        return
    for name in ("dragon.exe", "firefox.exe"):
        candidate = runtime_dir / name
        if candidate.is_file():
            try:
                with open(candidate, "r+b"):
                    pass
            except OSError as exc:
                raise RuntimeError(
                    f"Dragon Browser appears to be running ({candidate} is locked: {exc}). "
                    "Close all Dragon Browser windows and retry."
                ) from exc


def upgrade_runtime_atomic(
    runtime_dir: Path,
    channel: str = "esr",
    pinned_version: Optional[str] = None,
    force: bool = False,
    local_installer: Optional[Path] = None,
    local_runtime: Optional[Path] = None,
    skip_checksum: bool = False,
    keep_backup: bool = False,
    repo_root: Path = REPO_ROOT,
    require_native_dlls: Optional[bool] = None,
    post_swap_hook: Optional[Callable[[Path], None]] = None,
) -> Dict[str, Any]:
    """Perform a staged, verified, rollback-safe Gecko engine upgrade in `runtime_dir`."""
    cep = _load_compile_engine_pack()
    runtime_dir = runtime_dir.resolve()
    dist_dir = runtime_dir.parent
    profile_dir = dist_dir / "profile"
    gecko_dir = repo_root / "gecko"
    native_dir = repo_root / "native"
    branding_dir = repo_root / "engine" / "branding" / "dragon"

    installed = get_installed_engine_info(runtime_dir)
    target_info: Optional[Dict[str, str]] = None

    if not local_installer and not local_runtime:
        target_info = resolve_latest_version(channel=channel, pinned_version=pinned_version)
        if not force and installed.get("installed") and installed.get("version"):
            same_channel = (installed.get("channel") or "esr") == target_info["channel"]
            cmp = compare_versions(installed["version"], target_info["base_version"])
            if same_channel and cmp >= 0:
                print(
                    f"[OK] Engine is already up-to-date: "
                    f"{installed.get('display_version')} (channel={target_info['channel']})"
                )
                return {
                    "upgraded": False,
                    "reason": "already_up_to_date",
                    "installed": installed,
                    "target": target_info,
                }

    check_runtime_not_locked(runtime_dir)

    dist_dir.mkdir(parents=True, exist_ok=True)
    pid_tag = f"{os.getpid()}-{int(time.time())}"
    staging_dir = dist_dir / f".runtime-staging-{pid_tag}"
    backup_dir = dist_dir / f".runtime-backup-{installed.get('version') or 'prev'}-{pid_tag}"
    temp_dl_dir: Optional[Path] = None

    try:
        if local_runtime:
            local_runtime = local_runtime.resolve()
            if not local_runtime.is_dir():
                raise FileNotFoundError(f"Local runtime directory not found: {local_runtime}")
            print(f"==> Staging runtime from local directory: {local_runtime}")
            shutil.copytree(local_runtime, staging_dir, dirs_exist_ok=True)
        elif local_installer:
            local_installer = local_installer.resolve()
            if not local_installer.is_file():
                raise FileNotFoundError(f"Local installer not found: {local_installer}")
            print(f"==> Extracting local installer: {local_installer}")
            extract_mozilla_installer(local_installer, staging_dir)
        else:
            assert target_info is not None
            temp_dl_dir = Path(tempfile.mkdtemp(prefix="dragon-gecko-dl-"))
            dl_exe = temp_dl_dir / target_info["installer_name"]
            print(f"==> Downloading Mozilla Firefox {target_info['version']} (win64)...")
            print(f"    Source: {target_info['download_url']}")
            try:
                _http_download_file(target_info["download_url"], dl_exe)
            except urllib.error.URLError as exc:
                print(f"    Archive download failed ({exc}); trying Mozilla redirect...")
                _http_download_file(target_info["redirect_url"], dl_exe)

            if not skip_checksum:
                print("==> Verifying installer SHA-256 against Mozilla SHA256SUMS...")
                sums_raw = _http_get_bytes(target_info["sha256sums_url"]).decode(
                    "utf-8", errors="replace"
                )
                ok, detail = verify_sha256(dl_exe, sums_raw, target_info["rel_installer_path"])
                if not ok:
                    raise RuntimeError(f"Checksum verification failed: {detail}")
                print(f"    SHA-256 verified: {detail}")

            print("==> Extracting runtime core into staging directory...")
            extract_mozilla_installer(dl_exe, staging_dir)

        print("==> Compiling Dragon Gecko Engine pack in staging directory...")
        meta = cep.compile_engine_pack(
            runtime_dir=staging_dir,
            branding_dir=branding_dir if branding_dir.is_dir() else None,
            user_js_path=(gecko_dir / "user.js") if (gecko_dir / "user.js").is_file() else None,
            native_dir=native_dir,
            channel_hint=channel,
            refresh_binary=True,
        )
        sync_gecko_runtime_files(staging_dir, gecko_dir)

        if require_native_dlls is None:
            # Real Win64 runtimes always ship xul.dll; synthetic test trees may omit DLLs
            check_dlls = (staging_dir / "xul.dll").is_file() or (
                not local_runtime and not local_installer
            )
        else:
            check_dlls = require_native_dlls

        print("==> Verifying staged Dragon Gecko Engine integrity & upstream hooks...")
        errors, warnings = cep.verify_compiled_runtime(
            staging_dir,
            native_dir=native_dir,
            require_native_dlls=check_dlls,
        )
        for w in warnings:
            print(f"[WARN] {w}", file=sys.stderr)
        if errors:
            raise RuntimeError("Staged runtime verification failed:\n  - " + "\n  - ".join(errors))

        print(f"==> Swapping staged runtime into {runtime_dir}...")
        had_existing = runtime_dir.exists()
        if had_existing:
            shutil.move(str(runtime_dir), str(backup_dir))

        try:
            shutil.move(str(staging_dir), str(runtime_dir))
            if post_swap_hook is not None:
                post_swap_hook(runtime_dir)
            post_errors, _ = cep.verify_compiled_runtime(
                runtime_dir,
                native_dir=native_dir,
                require_native_dlls=check_dlls,
            )
            if post_errors:
                raise RuntimeError("Post-swap verification failed: " + "; ".join(post_errors))
        except Exception:
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir, ignore_errors=True)
            if had_existing and backup_dir.exists():
                shutil.move(str(backup_dir), str(runtime_dir))
            raise

        # Clear ONLY Gecko's compiled UI bytecode cache so updated omni.ja loads cleanly.
        # NEVER touch any user profile data (bookmarks, cookies, logins, prefs.js, etc.).
        startup_cache = profile_dir / "startupCache"
        if startup_cache.is_dir():
            shutil.rmtree(startup_cache, ignore_errors=True)

        if backup_dir.exists() and not keep_backup:
            shutil.rmtree(backup_dir, ignore_errors=True)

        print(
            f"[OK] Upgraded Dragon Gecko Engine to {meta['engine']} {meta['display_version']} "
            f"(build {meta.get('build_id') or 'n/a'})"
        )
        return {
            "upgraded": True,
            "previous": installed,
            "metadata": meta,
            "warnings": warnings,
            "backup_dir": str(backup_dir) if keep_backup and backup_dir.exists() else None,
        }
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        if temp_dl_dir and temp_dl_dir.exists():
            shutil.rmtree(temp_dl_dir, ignore_errors=True)


def run_from_source_upgrade(
    channel: str,
    pinned_version: Optional[str],
    repo_root: Path = REPO_ROOT,
) -> Dict[str, Any]:
    """Delegate engine upgrade to the full C++/Rust Gecko from-source pipeline."""
    target_info = resolve_latest_version(channel=channel, pinned_version=pinned_version)
    gecko_ver = target_info["version"]
    print(f"==> Starting from-source Gecko build for {gecko_ver} (channel={channel})...")

    if sys.platform == "win32":
        fetch_ps1 = repo_root / "engine" / "scripts" / "fetch-source.ps1"
        build_ps1 = repo_root / "engine" / "scripts" / "build-engine.ps1"
        subprocess.run(
            [
                "powershell",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(fetch_ps1),
                "-Target",
                "win64",
                "-GeckoVersion",
                gecko_ver,
            ],
            check=True,
        )
        subprocess.run(
            [
                "powershell",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(build_ps1),
                "-GeckoVersion",
                gecko_ver,
            ],
            check=True,
        )
    else:
        env = os.environ.copy()
        env["DRAGON_GECKO_VERSION"] = gecko_ver
        env.setdefault("DRAGON_TARGET", "linux64")
        subprocess.run(["bash", str(repo_root / "engine" / "scripts" / "fetch-source.sh")], env=env, check=True)
        subprocess.run(["bash", str(repo_root / "engine" / "scripts" / "build-engine.sh")], env=env, check=True)

    runtime_dir = repo_root / "dist" / "runtime"
    sync_gecko_runtime_files(runtime_dir, repo_root / "gecko")
    cep = _load_compile_engine_pack()
    errors, warnings = cep.verify_compiled_runtime(runtime_dir, native_dir=repo_root / "native")
    for w in warnings:
        print(f"[WARN] {w}", file=sys.stderr)
    if errors:
        raise RuntimeError("From-source runtime verification failed:\n  - " + "\n  - ".join(errors))

    return {
        "upgraded": True,
        "from_source": True,
        "metadata": get_installed_engine_info(runtime_dir),
        "warnings": warnings,
    }


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upgrade Dragon Browser's Gecko engine safely with atomic swap and rollback"
    )
    parser.add_argument(
        "--channel",
        choices=("esr", "release"),
        default="esr",
        help="Mozilla release channel to track (default: esr)",
    )
    parser.add_argument(
        "--version",
        default=None,
        help="Pin an explicit Gecko/Firefox version (e.g. 153.8.0esr or 154.0)",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Check installed vs latest available Mozilla version without modifying files",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output machine-readable JSON result",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download and re-compile even if already on the target version",
    )
    parser.add_argument(
        "--from-source",
        action="store_true",
        help="Run full C++/Rust Gecko compilation via fetch-source + build-engine",
    )
    parser.add_argument(
        "--local-installer",
        type=Path,
        default=None,
        help="Upgrade from a local Firefox Win64 Setup .exe (offline/testing)",
    )
    parser.add_argument(
        "--local-runtime",
        type=Path,
        default=None,
        help="Upgrade from a local extracted Gecko runtime directory (offline/testing)",
    )
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        default=REPO_ROOT / "dist" / "runtime",
        help="Target runtime directory (default: dist/runtime)",
    )
    parser.add_argument(
        "--keep-backup",
        action="store_true",
        help="Keep dist/.runtime-backup-* folder after successful upgrade",
    )
    parser.add_argument(
        "--skip-checksum",
        action="store_true",
        help="Skip Mozilla SHA256SUMS verification (not recommended)",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.check_only:
        installed = get_installed_engine_info(args.runtime_dir)
        latest = resolve_latest_version(channel=args.channel, pinned_version=args.version)
        cmp = compare_versions(installed.get("version") or "", latest["base_version"])
        same_channel = (installed.get("channel") or "esr") == latest["channel"]
        update_available = (not installed.get("installed")) or (not same_channel) or (cmp < 0)
        payload = {
            "channel": args.channel,
            "installed": installed,
            "latest": latest,
            "update_available": update_available,
        }
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            cur_ver = installed.get("display_version") or "not installed"
            print(f"Installed : {cur_ver} (channel={installed.get('channel') or 'none'})")
            print(f"Latest    : {latest['version']} (channel={latest['channel']})")
            print(f"Status    : {'UPDATE AVAILABLE' if update_available else 'UP TO DATE'}")
        return 0

    if args.from_source:
        result = run_from_source_upgrade(channel=args.channel, pinned_version=args.version)
    else:
        result = upgrade_runtime_atomic(
            runtime_dir=args.runtime_dir,
            channel=args.channel,
            pinned_version=args.version,
            force=args.force,
            local_installer=args.local_installer,
            local_runtime=args.local_runtime,
            skip_checksum=args.skip_checksum,
            keep_backup=args.keep_backup,
        )

    if args.json:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
