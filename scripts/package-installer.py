#!/usr/bin/env python3
"""
Dragon Browser — Native Windows Setup .exe & Portable .zip Packager (`package-installer.py`).

Builds a self-contained single-file Windows installer (`DragonBrowser-Setup-<ver>-win64.exe`)
from `dist/` and `dragon-installer-stub.exe`, plus an optional portable `.zip` (`--also-zip`),
and writes `SHA256SUMS.txt`.

Safety guarantees:
  - NEVER includes `dist/profile/` or user browsing data in any package.
  - Strips dev/test/unpacked `dist/bin` artifacts when packed `omni.ja` files are present.
  - Pre-syncs `policies.json`, `autoconfig.js`, and `dragon.cfg` into `runtime/` so
    read-only installations work out of the box.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import re
import shutil
import struct
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

TRAILER_MAGIC = b"DRGNINST"
TRAILER_VERSION = 1
TRAILER_STRUCT = struct.Struct("<8sIQQI")

EXCLUDE_RUNTIME_FILES = {
    "firefox.exe",
    "firefox.exe.sig",
    "xul.dll.sig",
    "plugin-container.exe.sig",
    "crashhelper.exe",
    "private_browsing.exe",
    "crashreporter.exe",
    "crashreporter",
    "maintenanceservice.exe",
    "maintenanceservice_installer.exe",
    "updater.exe",
    "updater",
    "pingsender.exe",
    "pingsender",
    "default-browser-agent.exe",
    "xpcshell.exe",
    "certutil.exe",
    "pk12util.exe",
    "modutil.exe",
    "ssltunnel.exe",
    "dependentlibs.list.gtest",
    ".lldbinit",
    ".mkdir.done",
    "ScalarArtifactDefinitions.json",
    "EventArtifactDefinitions.json",
    "mozwer.dll",
    "updater.ini",
    "update-settings.ini",
    "precomplete",
    "removed-files",
    "onnxruntime.dll",
    "mozinference.dll",
    "browser/blank.pdf",
    "browser/confused_fox.pdf",
}

EXCLUDE_RUNTIME_DIRS = {
    "gmp-fake",
    "gmp-fakeopenh264",
    "uninstall",
    "desktop-launcher",
    "moz-src",
}

EXCLUDE_UNPACKED_OMNI_DIRS = {
    "actors",
    "chrome",
    "components",
    "contentaccessible",
    "dictionaries",
    "hyphenation",
    "localization",
    "modules",
    "res",
    "defaults/autoconfig",
    "defaults/backgroundtasks",
    "browser/actors",
    "browser/chrome",
    "browser/components",
    "browser/defaults",
    "browser/localization",
    "browser/modules",
}

EXCLUDE_UNPACKED_OMNI_FILES = {
    "chrome.manifest",
    "greprefs.js",
    "default.locale",
    "defaults/pref/PdfJsDefaultPrefs.js",
    "browser/chrome.manifest",
}


def _read_app_version(repo_root: Path) -> str:
    cargo_toml = repo_root / "Cargo.toml"
    if cargo_toml.is_file():
        m = re.search(
            r'(?m)^version\s*=\s*"([^"]+)"',
            cargo_toml.read_text(encoding="utf-8"),
        )
        if m:
            return m.group(1)
    return "1.0.0"


def find_installer_stub(repo_root: Path, explicit_stub: Optional[Path] = None) -> Path:
    candidates: List[Path] = []
    if explicit_stub is not None:
        candidates.append(explicit_stub)
    candidates.extend(
        [
            repo_root / "installer" / "build" / "dragon-installer-stub.exe",
            repo_root / "target" / "x86_64-pc-windows-gnu" / "release" / "dragon-installer-stub.exe",
            repo_root / "target" / "x86_64-pc-windows-msvc" / "release" / "dragon-installer-stub.exe",
            repo_root / "target" / "release" / "dragon-installer-stub.exe",
        ]
    )
    for c in candidates:
        if c.is_file():
            return c.resolve()
    raise FileNotFoundError(
        "Installer stub binary `dragon-installer-stub.exe` not found. "
        "Build it first via `bash scripts/build.sh` or `cargo build --release --bin dragon-installer-stub`."
    )


def _should_skip_runtime_rel(rel_posix: str, strip_unpacked_omni: bool) -> bool:
    parts = rel_posix.split("/")
    if parts[0] == "profile":
        return True
    if parts[0] in EXCLUDE_RUNTIME_DIRS:
        return True
    if rel_posix in EXCLUDE_RUNTIME_FILES or parts[-1] in {".DS_Store", "Thumbs.db"}:
        return True
    if strip_unpacked_omni:
        if rel_posix in EXCLUDE_UNPACKED_OMNI_FILES:
            return True
        for prefix in EXCLUDE_UNPACKED_OMNI_DIRS:
            if rel_posix == prefix or rel_posix.startswith(prefix + "/"):
                return True
    return False


def has_pe_authenticode_signature(pe_path: Path) -> bool:
    """Return True if `pe_path` carries a non-empty PE32+ Authenticode Security Directory."""
    try:
        data = pe_path.read_bytes()
    except OSError:
        return False
    if len(data) < 0x120 or data[:2] != b"MZ":
        return False
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    if e_lfanew <= 0 or e_lfanew + 24 + 152 > len(data):
        return False
    if data[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        return False
    (opt_magic,) = struct.unpack_from("<H", data, e_lfanew + 24)
    if opt_magic != 0x20B:
        return False
    (num_rva,) = struct.unpack_from("<I", data, e_lfanew + 24 + 108)
    if num_rva <= 4:
        return False
    (cert_offset, cert_size) = struct.unpack_from("<II", data, e_lfanew + 24 + 144)
    return cert_offset > 0 and cert_size > 0 and (cert_offset + cert_size) <= len(data)


def stage_clean_payload(
    dist_dir: Path,
    repo_root: Path,
    stage_dir: Path,
    signed_uninstaller: Optional[Path] = None,
    require_signed_runtime: bool = False,
    require_signed_launcher: bool = False,
) -> Tuple[Dict[str, object], List[Dict[str, object]]]:
    """Copy a strictly allowlisted, profile-free payload from `dist_dir` into `stage_dir`."""
    launcher_exe = dist_dir / "dragon-browser.exe"
    if not launcher_exe.is_file():
        raise FileNotFoundError(f"Missing launcher binary: {launcher_exe}")
    if require_signed_launcher and not has_pe_authenticode_signature(launcher_exe):
        raise RuntimeError(
            f"Launcher binary is not Authenticode-signed: {launcher_exe}"
        )

    if signed_uninstaller is not None:
        signed_uninstaller = signed_uninstaller.resolve()
        if not signed_uninstaller.is_file():
            raise FileNotFoundError(f"Missing signed uninstaller: {signed_uninstaller}")
        if require_signed_launcher and not has_pe_authenticode_signature(signed_uninstaller):
            raise RuntimeError(
                f"Uninstaller binary is not Authenticode-signed: {signed_uninstaller}"
            )

    ico_path = repo_root / "assets" / "dragon.ico"
    if not ico_path.is_file():
        raise FileNotFoundError(f"Missing Dragon icon: {ico_path}")

    resources_dir = dist_dir / "resources"
    required_resources = (
        "user.js",
        "policies.template.json",
        "autoconfig/autoconfig.js",
        "autoconfig/dragon.cfg",
        "autoconfig/dragon-chrome.uc.js",
        "chrome/userChrome.css",
        "chrome/userContent.css",
    )
    for rel in required_resources:
        if not (resources_dir / rel).is_file():
            raise FileNotFoundError(f"Missing required resource file: {resources_dir / rel}")

    runtime_dir = dist_dir / "runtime"
    dragon_exe = runtime_dir / "dragon.exe"
    root_omni = runtime_dir / "omni.ja"
    browser_omni = runtime_dir / "browser" / "omni.ja"
    stamp_path = runtime_dir / "dragon-engine.json"
    for req in (dragon_exe, root_omni, browser_omni, stamp_path):
        if not req.is_file():
            raise FileNotFoundError(f"Missing compiled runtime file: {req}")

    if require_signed_runtime:
        for bin_name in ("dragon.exe", "xul.dll", "mozglue.dll", "plugin-container.exe"):
            bin_path = runtime_dir / bin_name
            if bin_name == "plugin-container.exe" and not bin_path.is_file():
                continue
            if not bin_path.is_file() or not has_pe_authenticode_signature(bin_path):
                raise RuntimeError(
                    f"Runtime binary is missing an Authenticode signature: {bin_path}"
                )

    engine_meta = json.loads(stamp_path.read_text(encoding="utf-8"))
    if engine_meta.get("compiled_omni") is not True or engine_meta.get("native_core") is not True:
        raise RuntimeError(
            f"{stamp_path} is not a compiled Native Dragon Gecko Engine; run compile-engine-pack.py first"
        )

    stage_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(launcher_exe, stage_dir / "dragon-browser.exe")
    if signed_uninstaller is not None:
        shutil.copy2(signed_uninstaller, stage_dir / "uninstall.exe")
    shutil.copy2(ico_path, stage_dir / "dragon.ico")
    shutil.copytree(resources_dir, stage_dir / "resources", dirs_exist_ok=True)

    strip_unpacked_omni = (
        root_omni.stat().st_size > 1_000_000 and browser_omni.stat().st_size > 1_000_000
    )

    staged_runtime = stage_dir / "runtime"
    staged_runtime.mkdir(parents=True, exist_ok=True)
    for src_file in sorted(runtime_dir.rglob("*")):
        if not src_file.is_file():
            continue
        rel_posix = src_file.relative_to(runtime_dir).as_posix()
        if _should_skip_runtime_rel(rel_posix, strip_unpacked_omni=strip_unpacked_omni):
            continue
        dst_file = staged_runtime / rel_posix
        dst_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dst_file)

    # Pre-sync distribution/policies.json, defaults/pref/autoconfig.js, and dragon.cfg
    # into runtime/ so read-only install directories never need to write to runtime/ at launch.
    dist_policies_dir = staged_runtime / "distribution"
    dist_policies_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(resources_dir / "policies.template.json", dist_policies_dir / "policies.json")

    pref_dir = staged_runtime / "defaults" / "pref"
    pref_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(resources_dir / "autoconfig" / "autoconfig.js", pref_dir / "autoconfig.js")
    shutil.copy2(resources_dir / "autoconfig" / "dragon.cfg", staged_runtime / "dragon.cfg")

    # Build manifest inventory (asserting zero profile/ entries)
    inventory: List[Dict[str, object]] = []
    total_bytes = 0
    for fpath in sorted(stage_dir.rglob("*")):
        if not fpath.is_file():
            continue
        rel_posix = fpath.relative_to(stage_dir).as_posix()
        if rel_posix == "profile" or rel_posix.startswith("profile/"):
            raise AssertionError(f"Refusing to package user profile entry: {rel_posix}")
        raw = fpath.read_bytes()
        total_bytes += len(raw)
        inventory.append(
            {
                "path": rel_posix,
                "size": len(raw),
                "crc32": zlib.crc32(raw) & 0xFFFFFFFF,
            }
        )

    engine_ver = str(engine_meta.get("version") or "unknown")
    display_ver = str(engine_meta.get("display_version") or engine_ver)
    channel = str(engine_meta.get("channel") or ("esr" if "esr" in display_ver.lower() else "release"))

    manifest = {
        "app_name": "Dragon Browser",
        "app_version": _read_app_version(repo_root),
        "engine": str(engine_meta.get("engine") or "Dragon Gecko ESR"),
        "engine_channel": channel,
        "engine_version": engine_ver,
        "display_version": display_ver,
        "build_id": str(engine_meta.get("build_id") or ""),
        "built_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "file_count": len(inventory),
        "uncompressed_bytes": total_bytes,
        "files": inventory,
    }
    (stage_dir / "dragon-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest, inventory


def _verify_setup_exe(setup_exe: Path) -> None:
    data = setup_exe.read_bytes()
    if len(data) < 0x100 + TRAILER_STRUCT.size or data[:2] != b"MZ":
        raise RuntimeError(f"Generated setup executable is not a valid PE file: {setup_exe}")
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    if e_lfanew <= 0 or e_lfanew + 24 + 152 > len(data):
        raise RuntimeError(f"Invalid PE header offset in {setup_exe}")
    if data[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        raise RuntimeError(f"Missing PE signature in {setup_exe}")

    cert_offset = 0
    cert_size = 0
    (opt_magic,) = struct.unpack_from("<H", data, e_lfanew + 24)
    if opt_magic == 0x20B:
        (num_rva,) = struct.unpack_from("<I", data, e_lfanew + 24 + 108)
        if num_rva > 4:
            (cert_offset, cert_size) = struct.unpack_from("<II", data, e_lfanew + 24 + 144)

    found = None
    if cert_offset > 0 and cert_size > 0 and cert_offset + cert_size <= len(data):
        for pad in range(8):
            trailer_pos = cert_offset - pad - TRAILER_STRUCT.size
            if trailer_pos < 0:
                continue
            magic, ver, payload_offset, payload_size, payload_crc32 = TRAILER_STRUCT.unpack_from(
                data, trailer_pos
            )
            if magic == TRAILER_MAGIC and ver == TRAILER_VERSION and payload_offset + payload_size == trailer_pos:
                found = (payload_offset, payload_size, payload_crc32)
                break
        if found is None:
            raise RuntimeError("Missing DRGNINST trailer before Authenticode signature")
    else:
        trailer_pos = len(data) - TRAILER_STRUCT.size
        magic, ver, payload_offset, payload_size, payload_crc32 = TRAILER_STRUCT.unpack_from(
            data, trailer_pos
        )
        if magic != TRAILER_MAGIC or ver != TRAILER_VERSION:
            raise RuntimeError("Invalid DRGNINST trailer written to setup executable")
        if payload_offset + payload_size != trailer_pos:
            raise RuntimeError("Payload size/offset mismatch in generated setup executable")
        found = (payload_offset, payload_size, payload_crc32)

    payload_offset, payload_size, payload_crc32 = found
    actual_crc = zlib.crc32(memoryview(data)[payload_offset : payload_offset + payload_size]) & 0xFFFFFFFF
    if actual_crc != payload_crc32:
        raise RuntimeError(f"Payload CRC32 mismatch: {actual_crc:#x} != {payload_crc32:#x}")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 256)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest().lower()


def package_release(
    dist_dir: Path,
    output_dir: Path,
    stub_path: Optional[Path] = None,
    signed_uninstaller: Optional[Path] = None,
    also_zip: bool = False,
    require_signed_runtime: bool = False,
    require_signed_launcher: bool = False,
    repo_root: Path = REPO_ROOT,
) -> Dict[str, object]:
    """Package `dist_dir` into `output_dir/DragonBrowser-Setup-*.exe` (+ optional portable `.zip`)."""
    dist_dir = dist_dir.resolve()
    output_dir = output_dir.resolve()
    resolved_stub = find_installer_stub(repo_root, stub_path)

    with tempfile.TemporaryDirectory(prefix="dragon-pkg-") as tmp_str:
        tmp_dir = Path(tmp_str)
        stage_dir = tmp_dir / "payload"
        manifest, _ = stage_clean_payload(
            dist_dir,
            repo_root,
            stage_dir,
            signed_uninstaller=signed_uninstaller,
            require_signed_runtime=require_signed_runtime,
            require_signed_launcher=require_signed_launcher,
        )

        safe_ver = re.sub(r"[^A-Za-z0-9._-]", "_", str(manifest["display_version"]))
        output_dir.mkdir(parents=True, exist_ok=True)

        zip_payload_path = tmp_dir / "payload.zip"
        with zipfile.ZipFile(
            zip_payload_path,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as zf:
            for fpath in sorted(stage_dir.rglob("*")):
                if fpath.is_file():
                    rel = fpath.relative_to(stage_dir).as_posix()
                    zf.write(fpath, arcname=rel)

        stub_bytes = resolved_stub.read_bytes()
        zip_bytes = zip_payload_path.read_bytes()
        zip_crc = zlib.crc32(zip_bytes) & 0xFFFFFFFF
        trailer = TRAILER_STRUCT.pack(
            TRAILER_MAGIC,
            TRAILER_VERSION,
            len(stub_bytes),
            len(zip_bytes),
            zip_crc,
        )

        setup_name = f"DragonBrowser-Setup-{safe_ver}-win64.exe"
        setup_path = output_dir / setup_name
        setup_tmp = output_dir / f".{setup_name}.tmp"
        with open(setup_tmp, "wb") as out:
            out.write(stub_bytes)
            out.write(zip_bytes)
            out.write(trailer)
        setup_tmp.replace(setup_path)
        _verify_setup_exe(setup_path)

        artifacts: List[Path] = [setup_path]

        portable_zip_path: Optional[Path] = None
        if also_zip:
            zip_name = f"DragonBrowser-Portable-{safe_ver}-win64.zip"
            portable_zip_path = output_dir / zip_name
            zip_tmp = output_dir / f".{zip_name}.tmp"
            with zipfile.ZipFile(
                zip_tmp,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=6,
            ) as zf:
                for fpath in sorted(stage_dir.rglob("*")):
                    if fpath.is_file():
                        rel = fpath.relative_to(stage_dir).as_posix()
                        zf.write(fpath, arcname=f"DragonBrowser/{rel}")
            zip_tmp.replace(portable_zip_path)
            artifacts.append(portable_zip_path)

        sums_lines = [f"{_sha256_file(p)}  {p.name}" for p in artifacts]
        sums_path = output_dir / "SHA256SUMS.txt"
        sums_path.write_text("\n".join(sums_lines) + "\n", encoding="utf-8")

        return {
            "manifest": manifest,
            "setup_exe": str(setup_path),
            "setup_bytes": setup_path.stat().st_size,
            "portable_zip": str(portable_zip_path) if portable_zip_path else None,
            "portable_bytes": portable_zip_path.stat().st_size if portable_zip_path else None,
            "sha256sums": str(sums_path),
        }


def _fmt_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.2f} MiB ({num_bytes:,} bytes)"
    if num_bytes >= 1024:
        return f"{num_bytes / 1024:.1f} KiB ({num_bytes:,} bytes)"
    return f"{num_bytes} bytes"


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Package Dragon Browser dist/ into a self-contained Windows Setup .exe"
    )
    parser.add_argument(
        "--dist-dir",
        type=Path,
        default=REPO_ROOT / "dist",
        help="Path to dist/ bundle (default: dist)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / "release",
        help="Output release directory (default: release)",
    )
    parser.add_argument(
        "--stub",
        type=Path,
        default=None,
        help="Explicit path to dragon-installer-stub.exe",
    )
    parser.add_argument(
        "--signed-uninstaller",
        type=Path,
        default=None,
        help="Optional pre-signed uninstall.exe to embed in the installer payload",
    )
    parser.add_argument(
        "--also-zip",
        action="store_true",
        help="Also generate a DragonBrowser-Portable-<ver>-win64.zip archive",
    )
    parser.add_argument(
        "--require-signed-runtime",
        action="store_true",
        help="Fail packaging if runtime PE binaries lack Authenticode signatures",
    )
    parser.add_argument(
        "--require-signed-launcher",
        action="store_true",
        help="Fail packaging if dragon-browser.exe (or --signed-uninstaller) lacks an Authenticode signature",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    res = package_release(
        dist_dir=args.dist_dir,
        output_dir=args.output_dir,
        stub_path=args.stub,
        signed_uninstaller=args.signed_uninstaller,
        also_zip=args.also_zip,
        require_signed_runtime=args.require_signed_runtime,
        require_signed_launcher=args.require_signed_launcher,
    )
    manifest = res["manifest"]
    print("")
    print("[OK] Dragon Browser release packaged!")
    print(f"  Engine       : {manifest['engine']} {manifest['display_version']}")
    print(f"  Setup .exe   : {res['setup_exe']} ({_fmt_size(int(res['setup_bytes']))})")
    if res["portable_zip"]:
        print(
            f"  Portable .zip: {res['portable_zip']} ({_fmt_size(int(res['portable_bytes']))})"
        )
    print(f"  Checksums    : {res['sha256sums']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
