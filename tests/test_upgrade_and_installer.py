"""Automated verification suite for Gecko engine upgrader, metadata, and native Windows installer."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
ENGINE_SCRIPTS_DIR = REPO_ROOT / "engine" / "scripts"
NATIVE_DIR = REPO_ROOT / "native"
GECKO_DIR = REPO_ROOT / "gecko"
DIST_DIR = REPO_ROOT / "dist"


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _build_synthetic_optimizejars_omni(path: Path, entries: list[tuple[str, bytes, int]]) -> None:
    cd_records: list[bytes] = []
    local_blocks: list[bytes] = []
    prepared: list[tuple[bytes, bytes, int, int, int, int]] = []
    for name, raw_data, method in entries:
        name_bytes = name.encode("utf-8")
        crc = zlib.crc32(raw_data) & 0xFFFFFFFF
        usize = len(raw_data)
        if method == 8:
            comp = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload = comp.compress(raw_data) + comp.flush()
        else:
            payload = raw_data
        prepared.append((name_bytes, payload, method, crc, len(payload), usize))

    cd_size = sum(46 + len(nb) for nb, *_ in prepared)
    current_lhoff = 4 + cd_size + 22
    for name_bytes, payload, method, crc, csize, usize in prepared:
        lfh = (
            struct.pack(
                "<4sHHHHHIIIHH",
                b"PK\x03\x04",
                20,
                0,
                method,
                0,
                0x21,
                crc,
                csize,
                usize,
                len(name_bytes),
                0,
            )
            + name_bytes
        )
        local_blocks.append(lfh + payload)
        cdh = (
            struct.pack(
                "<4sHHHHHHIIIHHHHHII",
                b"PK\x01\x02",
                20,
                20,
                0,
                method,
                0,
                0x21,
                crc,
                csize,
                usize,
                len(name_bytes),
                0,
                0,
                0,
                0,
                0,
                current_lhoff,
            )
            + name_bytes
        )
        cd_records.append(cdh)
        current_lhoff += len(lfh) + len(payload)

    cd_blob = b"".join(cd_records)
    local_blob = b"".join(local_blocks)
    total_entries = len(prepared)
    eocd = struct.pack(
        "<4sHHHHIIH",
        b"PK\x05\x06",
        0,
        0,
        total_entries,
        total_entries,
        len(cd_blob),
        4,
        0,
    )
    readahead = struct.pack("<I", 4 + len(cd_blob) + 22 + len(local_blob))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(readahead + cd_blob + eocd + local_blob + eocd)


def _fake_pe32_plus_exe(marker: bytes = b"DRAGON") -> bytes:
    buf = bytearray(0x200)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, 0x80)
    buf[0x80:0x84] = b"PE\x00\x00"
    struct.pack_into("<H", buf, 0x84, 0x8664)  # AMD64
    struct.pack_into("<H", buf, 0x98, 0x20B)   # PE32+
    buf[0x100 : 0x100 + len(marker)] = marker
    return bytes(buf)


def _seed_synthetic_gecko_runtime(
    runtime_dir: Path,
    version: str = "154.0.1",
    is_esr: bool = False,
    build_id: str = "20261201010101",
    exe_marker: bytes = b"NEW-GECKO",
) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "firefox.exe").write_bytes(_fake_pe32_plus_exe(exe_marker))
    (runtime_dir / "xul.dll").write_bytes(b"MZ-XUL")
    (runtime_dir / "mozglue.dll").write_bytes(b"MZ-MOZGLUE")
    (runtime_dir / "updater.exe").write_bytes(b"bloat")
    (runtime_dir / "application.ini").write_text(
        f"[App]\nVendor=Mozilla\nName=Firefox\nRemotingName=firefox\n"
        f"Version={version}\nBuildID={build_id}\nSourceStamp=deadbeef1234\n"
        f"[Crash Reporter]\nEnabled=1\n",
        encoding="utf-8",
    )
    display_ver = f"{version}esr" if is_esr else version
    app_constants = (
        "export var AppConstants = Object.freeze({\n"
        f"  IS_ESR: {'true' if is_esr else 'false'},\n"
        "  MOZ_DATA_REPORTING: true,\n"
        "  MOZ_TELEMETRY_REPORTING: true,\n"
        "  MOZ_UPDATER: true,\n"
        "  MOZ_CRASHREPORTER: true,\n"
        "  MOZ_NORMANDY: true,\n"
        "  MOZ_MAINTENANCE_SERVICE: true,\n"
        "  MOZ_UPDATE_AGENT: true,\n"
        "  MOZ_REQUIRE_SIGNING: true,\n"
        "  MOZ_UNSIGNED_APP_SCOPE: false,\n"
        "  MOZ_UNSIGNED_SYSTEM_SCOPE: false,\n"
        "  REMOTE_SETTINGS_VERIFY_SIGNATURE: true,\n"
        '  MOZ_APP_NAME: "firefox",\n'
        '  MOZ_APP_BASENAME: "Firefox",\n'
        '  MOZ_APP_DISPLAYNAME_DO_NOT_USE: "Firefox",\n'
        f'  MOZ_APP_VERSION: "{version}",\n'
        f'  MOZ_APP_VERSION_DISPLAY: "{display_ver}",\n'
        '  MOZ_GOOGLE_SAFEBROWSING_API_KEY: "AIzaFakeKey",\n'
        '  MOZ_MOZILLA_API_KEY: "mozilla-key",\n'
        "});\n"
    ).encode("utf-8")

    _build_synthetic_optimizejars_omni(
        runtime_dir / "omni.ja",
        [
            ("modules/AppConstants.sys.mjs", app_constants, 8),
            ("localization/en-US/toolkit/branding/brandings.ftl", b"-firefox-home-brand-name = Firefox Home\n", 0),
            ("modules/NetUtil.sys.mjs", b"// netutil\n", 0),
            ("modules/Timer.sys.mjs", b"// timer\n", 0),
            ("modules/AddonManager.sys.mjs", b"// addonmgr\n", 0),
        ],
    )
    _build_synthetic_optimizejars_omni(
        runtime_dir / "browser" / "omni.ja",
        [
            ("localization/en-US/branding/brand.ftl", b"-brand-full-name = Firefox\n", 0),
            ("chrome/en-US/locale/branding/brand.properties", b"brandFullName=Firefox\n", 0),
            ("defaults/preferences/firefox.js", b'pref("browser.startup.page", 1);\n', 8),
            ("chrome/chrome.manifest", b"", 0),
            ("components/components.manifest", b"", 0),
            ("chrome/browser/content/browser/browser.xhtml", b"<html/>", 0),
            ("modules/AboutNewTab.sys.mjs", b"// newtab\n", 0),
            ("modules/BrowserWindowTracker.sys.mjs", b"// tracker\n", 0),
        ],
    )


def _has_pe_rsrc_icons(exe_path: Path) -> bool:
    """Verify PE32+ executable has a `.rsrc` section containing RT_ICON(3) & RT_GROUP_ICON(14)."""
    data = exe_path.read_bytes()
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    (num_sections,) = struct.unpack_from("<H", data, e_lfanew + 6)
    (opt_size,) = struct.unpack_from("<H", data, e_lfanew + 20)
    sec_off = e_lfanew + 24 + opt_size
    rsrc_raw_ptr = None
    rsrc_raw_size = None
    for idx in range(num_sections):
        off = sec_off + idx * 40
        name = data[off : off + 8].split(b"\x00", 1)[0]
        if name == b".rsrc":
            rsrc_raw_size = struct.unpack_from("<I", data, off + 16)[0]
            rsrc_raw_ptr = struct.unpack_from("<I", data, off + 20)[0]
            break
    if rsrc_raw_ptr is None or not rsrc_raw_size:
        return False
    rsrc = data[rsrc_raw_ptr : rsrc_raw_ptr + rsrc_raw_size]
    (named_count, id_count) = struct.unpack_from("<HH", rsrc, 12)
    ids = {
        struct.unpack_from("<I", rsrc, 16 + (named_count + i) * 8)[0]
        for i in range(id_count)
    }
    return 3 in ids and 14 in ids


def test_compile_engine_pack_detects_release_and_esr_metadata_and_refreshes_binary(tmp_path: Path) -> None:
    cep = _load_module("compile_engine_pack_test", ENGINE_SCRIPTS_DIR / "compile-engine-pack.py")

    rt_release = tmp_path / "rt_release"
    _seed_synthetic_gecko_runtime(rt_release, version="154.0.1", is_esr=False, exe_marker=b"REL-154")
    # Place an older dragon.exe to ensure refresh_binary=True overwrites it
    (rt_release / "dragon.exe").write_bytes(_fake_pe32_plus_exe(b"OLD-153"))

    meta = cep.compile_engine_pack(
        runtime_dir=rt_release,
        native_dir=NATIVE_DIR,
        refresh_binary=True,
    )
    assert meta["engine"] == "Dragon Gecko Release"
    assert meta["channel"] == "release"
    assert meta["version"] == "154.0.1"
    assert meta["display_version"] == "154.0.1"
    assert meta["build_id"] == "20261201010101"
    assert b"REL-154" in (rt_release / "dragon.exe").read_bytes()

    errors, warnings = cep.verify_compiled_runtime(rt_release, native_dir=NATIVE_DIR)
    assert not errors, f"Unexpected verification errors: {errors}"
    assert not warnings, f"Unexpected verification warnings: {warnings}"

    rt_esr = tmp_path / "rt_esr"
    _seed_synthetic_gecko_runtime(rt_esr, version="153.8.0", is_esr=True, exe_marker=b"ESR-153")
    meta_esr = cep.compile_engine_pack(runtime_dir=rt_esr, native_dir=NATIVE_DIR)
    assert meta_esr["engine"] == "Dragon Gecko ESR"
    assert meta_esr["channel"] == "esr"
    assert meta_esr["display_version"] == "153.8.0esr"


def test_upgrade_engine_atomic_swap_preserves_profile_and_rolls_back_on_error(tmp_path: Path) -> None:
    upg = _load_module("upgrade_engine_test", ENGINE_SCRIPTS_DIR / "upgrade-engine.py")

    assert upg.compare_versions("153.7.0", "153.8.0esr") == -1
    assert upg.compare_versions("153.8.0esr", "153.8.0") == 0
    assert upg.compare_versions("154.0.1", "153.9.0esr") == 1

    sample_file = tmp_path / "Firefox Setup 153.8.0esr.exe"
    sample_file.write_bytes(b"fake-installer-payload")
    digest = hashlib.sha256(b"fake-installer-payload").hexdigest()
    sums_text = f"{digest}  win64/en-US/Firefox Setup 153.8.0esr.exe\n"
    ok, _ = upg.verify_sha256(sample_file, sums_text, "win64/en-US/Firefox Setup 153.8.0esr.exe")
    assert ok
    bad_ok, _ = upg.verify_sha256(sample_file, "0" * 64 + "  win64/en-US/Firefox Setup 153.8.0esr.exe\n", "win64/en-US/Firefox Setup 153.8.0esr.exe")
    assert not bad_ok

    # Seed existing dist/ with v1 runtime and user profile
    fake_dist = tmp_path / "dist"
    runtime_dir = fake_dist / "runtime"
    profile_dir = fake_dist / "profile"
    startup_cache = profile_dir / "startupCache"
    startup_cache.mkdir(parents=True)
    (profile_dir / "places.sqlite").write_bytes(b"USER-BOOKMARKS-DB")
    (profile_dir / "prefs.js").write_text('user_pref("custom", true);\n', encoding="utf-8")
    (startup_cache / "bytecode.bin").write_bytes(b"old-cache")

    v1_src = tmp_path / "v1_src"
    _seed_synthetic_gecko_runtime(v1_src, version="153.7.0", is_esr=True, exe_marker=b"V1")
    upg.upgrade_runtime_atomic(
        runtime_dir=runtime_dir,
        channel="esr",
        local_runtime=v1_src,
        repo_root=REPO_ROOT,
        require_native_dlls=True,
    )
    assert json.loads((runtime_dir / "dragon-engine.json").read_text())["version"] == "153.7.0"

    # Rollback test: inject failure during post-swap hook and verify v1 runtime remains intact
    v2_src = tmp_path / "v2_src"
    _seed_synthetic_gecko_runtime(v2_src, version="153.8.0", is_esr=True, exe_marker=b"V2")

    def _boom(_rt: Path) -> None:
        raise RuntimeError("Simulated post-swap failure")

    with pytest.raises(RuntimeError, match="Simulated post-swap failure"):
        upg.upgrade_runtime_atomic(
            runtime_dir=runtime_dir,
            channel="esr",
            local_runtime=v2_src,
            repo_root=REPO_ROOT,
            require_native_dlls=True,
            post_swap_hook=_boom,
        )
    assert json.loads((runtime_dir / "dragon-engine.json").read_text())["version"] == "153.7.0"
    assert b"V1" in (runtime_dir / "dragon.exe").read_bytes()

    # Successful upgrade to v2: clears startupCache, preserves places.sqlite & prefs.js
    res = upg.upgrade_runtime_atomic(
        runtime_dir=runtime_dir,
        channel="esr",
        local_runtime=v2_src,
        repo_root=REPO_ROOT,
        require_native_dlls=True,
    )
    assert res["upgraded"] is True
    assert json.loads((runtime_dir / "dragon-engine.json").read_text())["version"] == "153.8.0"
    assert b"V2" in (runtime_dir / "dragon.exe").read_bytes()
    assert not startup_cache.exists()
    assert (profile_dir / "places.sqlite").read_bytes() == b"USER-BOOKMARKS-DB"
    assert (profile_dir / "prefs.js").read_text(encoding="utf-8") == 'user_pref("custom", true);\n'


def test_package_installer_excludes_profile_and_validates_sfx(tmp_path: Path) -> None:
    pkg = _load_module("package_installer_test", SCRIPTS_DIR / "package-installer.py")
    cep = _load_module("compile_engine_pack_pkg_test", ENGINE_SCRIPTS_DIR / "compile-engine-pack.py")

    mock_dist = tmp_path / "dist"
    (mock_dist / "resources" / "autoconfig").mkdir(parents=True)
    (mock_dist / "resources" / "chrome").mkdir(parents=True)
    for rel in (
        "user.js",
        "policies.template.json",
        "autoconfig/autoconfig.js",
        "autoconfig/dragon.cfg",
        "autoconfig/dragon-chrome.uc.js",
        "chrome/userChrome.css",
        "chrome/userContent.css",
    ):
        (mock_dist / "resources" / rel).write_bytes((GECKO_DIR / rel).read_bytes())

    (mock_dist / "dragon-browser.exe").write_bytes(_fake_pe32_plus_exe(b"LAUNCHER"))
    # Seed user profile that must NEVER enter Setup .exe or Portable .zip
    (mock_dist / "profile").mkdir(parents=True)
    (mock_dist / "profile" / "secret-cookies.sqlite").write_bytes(b"PRIVATE-USER-DATA")

    rt = mock_dist / "runtime"
    _seed_synthetic_gecko_runtime(rt, version="154.0", is_esr=False, exe_marker=b"GECKO154")
    (rt / ".lldbinit").write_text("dev", encoding="utf-8")
    (rt / "moz-src").mkdir()
    (rt / "moz-src" / "junk.txt").write_text("junk", encoding="utf-8")
    cep.compile_engine_pack(runtime_dir=rt, native_dir=NATIVE_DIR, refresh_binary=True)

    fake_stub = tmp_path / "stub.exe"
    fake_stub.write_bytes(_fake_pe32_plus_exe(b"STUB"))
    out_dir = tmp_path / "release"

    res = pkg.package_release(
        dist_dir=mock_dist,
        output_dir=out_dir,
        stub_path=fake_stub,
        also_zip=True,
        repo_root=REPO_ROOT,
    )
    setup_exe = Path(res["setup_exe"])
    portable_zip = Path(res["portable_zip"])
    sums_txt = Path(res["sha256sums"])
    assert setup_exe.is_file() and setup_exe.name == "DragonBrowser-Setup-154.0-win64.exe"
    assert portable_zip.is_file() and portable_zip.name == "DragonBrowser-Portable-154.0-win64.zip"
    assert sums_txt.is_file()

    # Verify trailer and embedded ZIP payload of Setup .exe
    raw = setup_exe.read_bytes()
    magic, ver, offset, size, crc = pkg.TRAILER_STRUCT.unpack_from(raw, len(raw) - pkg.TRAILER_STRUCT.size)
    assert magic == b"DRGNINST" and ver == 1
    assert offset == len(fake_stub.read_bytes())
    zip_slice = raw[offset : offset + size]
    assert (zlib.crc32(zip_slice) & 0xFFFFFFFF) == crc

    import io
    with zipfile.ZipFile(io.BytesIO(zip_slice), "r") as zf:
        names = set(zf.namelist())
        assert "dragon-manifest.json" in names
        assert "dragon-browser.exe" in names
        assert "dragon.ico" in names
        assert "runtime/dragon.exe" in names
        assert "runtime/distribution/policies.json" in names
        assert "runtime/defaults/pref/autoconfig.js" in names
        assert "runtime/dragon.cfg" in names
        assert not any(n.startswith("profile/") or n == "profile" for n in names)
        assert "runtime/.lldbinit" not in names
        assert not any(n.startswith("runtime/moz-src/") for n in names)

    with zipfile.ZipFile(portable_zip, "r") as pzf:
        pnames = set(pzf.namelist())
        assert "DragonBrowser/dragon-browser.exe" in pnames
        assert not any("profile/" in n for n in pnames)


def test_windows_binaries_embed_rsrc_icons_and_live_release_artifacts() -> None:
    launcher_exe = DIST_DIR / "dragon-browser.exe"
    stub_exe = REPO_ROOT / "installer" / "build" / "dragon-installer-stub.exe"
    assert launcher_exe.is_file(), "dist/dragon-browser.exe must exist"
    assert stub_exe.is_file(), "installer/build/dragon-installer-stub.exe must exist"
    assert _has_pe_rsrc_icons(launcher_exe), "dragon-browser.exe missing .rsrc RT_ICON/RT_GROUP_ICON"
    assert _has_pe_rsrc_icons(stub_exe), "dragon-installer-stub.exe missing .rsrc RT_ICON/RT_GROUP_ICON"

    release_dir = REPO_ROOT / "release"
    setup_exes = sorted(release_dir.glob("DragonBrowser-Setup-*-win64.exe"))
    if setup_exes:
        pkg = _load_module("package_installer_live_test", SCRIPTS_DIR / "package-installer.py")
        for exe in setup_exes:
            pkg._verify_setup_exe(exe)
            assert _has_pe_rsrc_icons(exe), f"{exe.name} missing .rsrc icons"
        sums_file = release_dir / "SHA256SUMS.txt"
        assert sums_file.is_file(), "release/SHA256SUMS.txt must exist"


def test_powershell_51_syntax_and_commands_doc() -> None:
    for ps1 in (
        SCRIPTS_DIR / "upgrade-and-package.ps1",
        SCRIPTS_DIR / "setup-runtime.ps1",
        SCRIPTS_DIR / "verify-signatures.ps1",
        ENGINE_SCRIPTS_DIR / "fetch-source.ps1",
        ENGINE_SCRIPTS_DIR / "build-engine.ps1",
    ):
        text = ps1.read_text(encoding="utf-8")
        assert not re.search(r"-replace\s+[^,\r\n]+,\s*\{", text), (
            f"{ps1.name} uses PowerShell 6+ '-replace {{ ... }}' syntax unsupported in PS 5.1"
        )

    commands_md = REPO_ROOT / "COMMANDS.md"
    assert commands_md.is_file(), "COMMANDS.md must exist at repository root"
    cmd_text = commands_md.read_text(encoding="utf-8")
    for required in (
        "upgrade-and-package.ps1",
        "upgrade-and-package.sh",
        "verify-signatures.ps1",
        "--channel release",
        "--also-zip",
        "--uninstall",
        "/S",
    ):
        assert required in cmd_text, f"COMMANDS.md missing {required!r}"


def _append_fake_authenticode_sig(pe_bytes: bytes, pad_len: int = 0) -> bytes:
    buf = bytearray(pe_bytes)
    (e_lfanew,) = struct.unpack_from("<I", buf, 0x3C)
    struct.pack_into("<I", buf, e_lfanew + 24 + 108, 16)
    buf.extend(b"\x00" * pad_len)
    cert_offset = len(buf)
    fake_cert = b"\x30\x82\x01\x00" + b"\xaa" * 60
    buf.extend(fake_cert)
    struct.pack_into("<II", buf, e_lfanew + 24 + 144, cert_offset, len(fake_cert))
    return bytes(buf)


def test_authenticode_signature_detection_and_signed_sfx_packager(tmp_path: Path) -> None:
    cep = _load_module("compile_engine_pack_sig_test", ENGINE_SCRIPTS_DIR / "compile-engine-pack.py")
    pkg = _load_module("package_installer_sig_test", SCRIPTS_DIR / "package-installer.py")

    unsigned_pe = tmp_path / "unsigned.exe"
    unsigned_pe.write_bytes(_fake_pe32_plus_exe(b"UNSIGNED"))
    assert not cep.has_pe_authenticode_signature(unsigned_pe)
    assert not pkg.has_pe_authenticode_signature(unsigned_pe)

    signed_pe = tmp_path / "signed.exe"
    signed_pe.write_bytes(_append_fake_authenticode_sig(_fake_pe32_plus_exe(b"SIGNED")))
    assert cep.has_pe_authenticode_signature(signed_pe)
    assert pkg.has_pe_authenticode_signature(signed_pe)

    # Set up mock dist with unsigned runtime -> verify_compiled_runtime(require_signed_binaries=True) fails
    mock_dist = tmp_path / "dist"
    (mock_dist / "resources" / "autoconfig").mkdir(parents=True)
    (mock_dist / "resources" / "chrome").mkdir(parents=True)
    for rel in (
        "user.js",
        "policies.template.json",
        "autoconfig/autoconfig.js",
        "autoconfig/dragon.cfg",
        "autoconfig/dragon-chrome.uc.js",
        "chrome/userChrome.css",
        "chrome/userContent.css",
    ):
        (mock_dist / "resources" / rel).write_bytes((GECKO_DIR / rel).read_bytes())

    rt = mock_dist / "runtime"
    _seed_synthetic_gecko_runtime(rt, version="153.7.0", is_esr=True, exe_marker=b"MOZ")
    cep.compile_engine_pack(runtime_dir=rt, native_dir=NATIVE_DIR, refresh_binary=True)
    errs_unsigned, _ = cep.verify_compiled_runtime(
        rt, native_dir=NATIVE_DIR, require_signed_binaries=True
    )
    assert any("Unsigned runtime binary" in e for e in errs_unsigned)

    # Sign runtime binaries -> verify_compiled_runtime passes
    for bin_name in ("dragon.exe", "xul.dll", "mozglue.dll"):
        p = rt / bin_name
        p.write_bytes(_append_fake_authenticode_sig(_fake_pe32_plus_exe(bin_name.encode("ascii"))))
    errs_signed, _ = cep.verify_compiled_runtime(
        rt, native_dir=NATIVE_DIR, require_signed_binaries=True
    )
    assert not errs_signed, f"Unexpected errors for signed runtime: {errs_signed}"

    # Package with --signed-uninstaller and strict signed checks
    (mock_dist / "dragon-browser.exe").write_bytes(
        _append_fake_authenticode_sig(_fake_pe32_plus_exe(b"LAUNCHER"))
    )
    signed_uninst = tmp_path / "uninstall.exe"
    signed_uninst.write_bytes(_append_fake_authenticode_sig(_fake_pe32_plus_exe(b"UNINST")))
    stub = tmp_path / "stub.exe"
    stub.write_bytes(_fake_pe32_plus_exe(b"STUB"))
    out_dir = tmp_path / "release"

    res = pkg.package_release(
        dist_dir=mock_dist,
        output_dir=out_dir,
        stub_path=stub,
        signed_uninstaller=signed_uninst,
        also_zip=False,
        require_signed_runtime=True,
        require_signed_launcher=True,
        repo_root=REPO_ROOT,
    )
    setup_exe = Path(res["setup_exe"])
    raw = setup_exe.read_bytes()
    magic, ver, offset, size, crc = pkg.TRAILER_STRUCT.unpack_from(
        raw, len(raw) - pkg.TRAILER_STRUCT.size
    )
    assert magic == b"DRGNINST" and ver == 1
    import io
    with zipfile.ZipFile(io.BytesIO(raw[offset : offset + size]), "r") as zf:
        assert "uninstall.exe" in zf.namelist()
        assert zf.read("uninstall.exe") == signed_uninst.read_bytes()

    # Simulate SignPath signing the outer Setup .exe with 0..7 alignment padding bytes
    for pad in range(8):
        signed_setup = tmp_path / f"Setup-Signed-{pad}.exe"
        signed_setup.write_bytes(_append_fake_authenticode_sig(raw, pad_len=pad))
        pkg._verify_setup_exe(signed_setup)


def test_github_and_signpath_readiness_files() -> None:
    license_file = REPO_ROOT / "LICENSE"
    security_file = REPO_ROOT / "SECURITY.md"
    signpath_doc = REPO_ROOT / "docs" / "SIGNPATH-SETUP.md"
    ci_yml = REPO_ROOT / ".github" / "workflows" / "ci.yml"
    release_yml = REPO_ROOT / ".github" / "workflows" / "release-signed.yml"

    for req in (license_file, security_file, signpath_doc, ci_yml, release_yml):
        assert req.is_file(), f"Missing GitHub/SignPath readiness file: {req}"

    assert "Mozilla Public License Version 2.0" in license_file.read_text(encoding="utf-8")

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "SignPath.io" in readme and "SignPath Foundation" in readme
    assert "Code Signing Policy" in readme

    ci_text = ci_yml.read_text(encoding="utf-8")
    assert "windows-latest" in ci_text
    assert "cargo test --workspace" in ci_text
    assert "pytest -v tests/" in ci_text

    rel_text = release_yml.read_text(encoding="utf-8")
    assert "signpath/github-action-submit-signing-request@v3" in rel_text
    assert "artifact-configuration-slug: core-binaries" in rel_text
    assert "artifact-configuration-slug: windows-installer" in rel_text
    assert "--require-signed-runtime" in rel_text
    assert "--signed-uninstaller" in rel_text
    assert "softprops/action-gh-release" in rel_text
    # Ensure no job-level `if:` directly references `secrets.` (unsupported in GitHub Actions)
    assert not re.search(r"(?m)^\s{4}if:.*secrets\.", rel_text)
