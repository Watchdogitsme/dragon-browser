"""Automated verification suite for the compiled Dragon Gecko Engine, branding, mozjar, and source overlay."""

from __future__ import annotations

import importlib.util
import json
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = REPO_ROOT / "engine"
BRANDING_DIR = ENGINE_DIR / "branding" / "dragon"
PATCHES_DIR = ENGINE_DIR / "patches"
SCRIPTS_DIR = ENGINE_DIR / "scripts"
DIST_RUNTIME_DIR = REPO_ROOT / "dist" / "runtime"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
ICO_MAGIC = b"\x00\x00\x01\x00"


def _load_mozjar_module() -> Any:
    mozjar_path = SCRIPTS_DIR / "mozjar.py"
    assert mozjar_path.is_file(), f"Missing mozjar module: {mozjar_path}"
    spec = importlib.util.spec_from_file_location("mozjar", mozjar_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["mozjar"] = module
    spec.loader.exec_module(module)
    return module


def _build_synthetic_optimizejars_omni(path: Path, entries: list[tuple[str, bytes, int]]) -> None:
    """Create a synthetic Mozilla optimizejars-format omni.ja archive for testing."""
    cd_records: list[bytes] = []
    local_blocks: list[bytes] = []

    # First pass: build local header+payload blocks and measure total CD size
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
        csize = len(payload)
        prepared.append((name_bytes, payload, method, crc, csize, usize))

    cd_size = sum(46 + len(nb) for nb, *_ in prepared)
    # In optimizejars format:
    # 0..4: readahead header (<I)
    # 4..4+cd_size: Central Directory entries
    # 4+cd_size..4+cd_size+22: First EOCD
    # 4+cd_size+22..: Local File Header + payload blocks
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
        4,  # cd_offset == 4 in Mozilla optimizejars format
        0,
    )
    readahead = struct.pack("<I", 4 + len(cd_blob) + 22 + len(local_blob))
    path.write_bytes(readahead + cd_blob + eocd + local_blob + eocd)


# ---------------------------------------------------------------------------
# 1. Mozconfig verification (win64 & linux64)
# ---------------------------------------------------------------------------
def test_engine_mozconfigs_exist_and_configure_dragon_engine() -> None:
    required_directives = (
        "--with-app-name=dragon",
        "--with-branding=browser/branding/dragon",
        "--with-unsigned-addon-scopes=app,system",
        "--disable-crashreporter",
        "--disable-updater",
        "MOZ_TELEMETRY_REPORTING=",
        "MOZ_REQUIRE_SIGNING=",
    )
    forbidden_exports = (
        "MOZ_SERVICES_HEALTHREPORT",
        "MOZ_NORMANDY",
        "MOZ_DATA_REPORTING",
        "MOZ_ADDON_SIGNING",
    )

    for target in ("mozconfig.win64", "mozconfig.linux64"):
        cfg_path = ENGINE_DIR / target
        assert cfg_path.is_file(), f"Missing engine mozconfig: {cfg_path}"
        content = cfg_path.read_text(encoding="utf-8")
        for token in required_directives:
            assert token in content, f"{target} must contain {token!r}"
        assert "MOZ_REQUIRE_SIGNING=0" not in content, (
            f"{target} must use empty MOZ_REQUIRE_SIGNING= (not =0; Mozilla options.py rejects =0)"
        )
        for bad in forbidden_exports:
            assert f"export {bad}" not in content, (
                f"{target} must not export {bad} (project_flag/obsolete in mozilla-esr153)"
            )

    win64_cfg = (ENGINE_DIR / "mozconfig.win64").read_text(encoding="utf-8")
    assert "--target=x86_64-pc-windows-msvc" in win64_cfg
    assert "--with-app-basename=Dragon" in win64_cfg
    assert "--enable-optimize" in win64_cfg
    assert "x86_64-pc-mingw32" not in win64_cfg


# ---------------------------------------------------------------------------
# 2. Dragon branding package & generated binary PNG / Windows ICO assets
# ---------------------------------------------------------------------------
def test_engine_branding_files_and_generated_icons() -> None:
    required_text_files = [
        BRANDING_DIR / "configure.sh",
        BRANDING_DIR / "moz.build",
        BRANDING_DIR / "content" / "moz.build",
        BRANDING_DIR / "content" / "jar.mn",
        BRANDING_DIR / "locales" / "moz.build",
        BRANDING_DIR / "locales" / "jar.mn",
        BRANDING_DIR / "firefox.VisualElementsManifest.xml",
        BRANDING_DIR / "private_browsing.VisualElementsManifest.xml",
        BRANDING_DIR / "locales" / "en-US" / "brand.ftl",
        BRANDING_DIR / "locales" / "en-US" / "brand.dtd",
        BRANDING_DIR / "locales" / "en-US" / "brand.properties",
        BRANDING_DIR / "pref" / "firefox-branding.js",
    ]
    for path in required_text_files:
        assert path.is_file(), f"Missing required Dragon branding file: {path}"
        assert path.read_text(encoding="utf-8").strip(), f"Branding file is empty: {path}"

    brand_ftl = (BRANDING_DIR / "locales" / "en-US" / "brand.ftl").read_text(encoding="utf-8")
    assert "-brand-full-name = Dragon Browser" in brand_ftl
    assert "-brand-shorter-name = Dragon" in brand_ftl

    brand_props = (BRANDING_DIR / "locales" / "en-US" / "brand.properties").read_text(
        encoding="utf-8"
    )
    assert "brandFullName=Dragon Browser" in brand_props

    # Ensure configure.sh does not assign project_flags rejected from confvars origin
    configure_sh = (BRANDING_DIR / "configure.sh").read_text(encoding="utf-8")
    assert "MOZ_APP_DISPLAYNAME" in configure_sh
    for forbidden_confvar in (
        "MOZ_APP_VENDOR",
        "MOZ_APP_NAME",
        "MOZ_APP_BASENAME",
        "MOZ_APP_PROFILE",
        "MOZ_APP_REMOTINGNAME",
    ):
        assert forbidden_confvar not in configure_sh, (
            f"configure.sh must not set {forbidden_confvar} (rejected as confvars in mozilla-esr153)"
        )

    branding_nsi = (BRANDING_DIR / "branding.nsi").read_text(encoding="utf-8")
    assert "!define BrandShortName" not in branding_nsi, (
        "branding.nsi must not define BrandShortName (already defined by defines.nsi)"
    )
    for required_nsi in (
        "BrandFullNameInternal",
        "BrandFullName",
        "CompanyName",
        "COMMON_BACKGROUND_COLOR",
    ):
        assert required_nsi in branding_nsi, f"branding.nsi missing {required_nsi!r}"

    required_icos = [
        REPO_ROOT / "assets" / "dragon.ico",
        BRANDING_DIR / "default.ico",
        BRANDING_DIR / "firefox.ico",
        BRANDING_DIR / "firefox64.ico",
        BRANDING_DIR / "document.ico",
        BRANDING_DIR / "document_pdf.ico",
        BRANDING_DIR / "newtab.ico",
        BRANDING_DIR / "newwindow.ico",
        BRANDING_DIR / "pbmode.ico",
        BRANDING_DIR / "content" / "document.ico",
    ]
    for ico_path in required_icos:
        assert ico_path.is_file(), f"Missing generated Windows ICO file: {ico_path}"
        raw = ico_path.read_bytes()
        assert len(raw) > 22, f"ICO file unexpectedly small: {ico_path}"
        assert raw[:4] == ICO_MAGIC, f"Invalid Windows ICO magic in {ico_path}: {raw[:4]!r}"

    required_pngs = [
        BRANDING_DIR / "default16.png",
        BRANDING_DIR / "default22.png",
        BRANDING_DIR / "default24.png",
        BRANDING_DIR / "default32.png",
        BRANDING_DIR / "default48.png",
        BRANDING_DIR / "default64.png",
        BRANDING_DIR / "default128.png",
        BRANDING_DIR / "default256.png",
        BRANDING_DIR / "VisualElements_150.png",
        BRANDING_DIR / "VisualElements_70.png",
        BRANDING_DIR / "PrivateBrowsing_150.png",
        BRANDING_DIR / "PrivateBrowsing_70.png",
        BRANDING_DIR / "content" / "icon16.png",
        BRANDING_DIR / "content" / "icon32.png",
        BRANDING_DIR / "content" / "icon48.png",
        BRANDING_DIR / "content" / "icon64.png",
        BRANDING_DIR / "content" / "icon128.png",
        BRANDING_DIR / "content" / "about-logo.png",
        BRANDING_DIR / "content" / "about-logo@2x.png",
        BRANDING_DIR / "content" / "about-logo-private.png",
        BRANDING_DIR / "content" / "about-logo-private@2x.png",
        BRANDING_DIR / "content" / "about.png",
    ]
    for png_path in required_pngs:
        assert png_path.is_file(), f"Missing generated PNG asset: {png_path}"
        raw = png_path.read_bytes()
        assert len(raw) > 64, f"PNG file unexpectedly small: {png_path}"
        assert raw[:8] == PNG_MAGIC, f"Invalid PNG signature in {png_path}: {raw[:8]!r}"


# ---------------------------------------------------------------------------
# 3. Engine patches integrity & zero hardcoded API keys
# ---------------------------------------------------------------------------
def test_engine_patches_exist_and_contain_no_hardcoded_api_keys() -> None:
    expected_prefixes = ("0001", "0002", "0003", "0004")
    patch_files = sorted(PATCHES_DIR.glob("*.patch"))
    assert len(patch_files) >= 4, f"Expected 4 patch files in {PATCHES_DIR}, found {patch_files}"

    for prefix in expected_prefixes:
        matching = [p for p in patch_files if p.name.startswith(prefix)]
        assert matching, f"Missing patch starting with {prefix} in {PATCHES_DIR}"

    for patch_file in patch_files:
        text = patch_file.read_text(encoding="utf-8")
        assert text.strip(), f"Patch file must not be empty: {patch_file}"
        assert "AIza" not in text, (
            f"Hardcoded Google API key prefix 'AIza' found in {patch_file.name}"
        )


# ---------------------------------------------------------------------------
# 4. MozJar optimizejars omni.ja round-trip test
# ---------------------------------------------------------------------------
def test_mozjar_optimizejars_round_trip(tmp_path: Path) -> None:
    mozjar = _load_mozjar_module()
    MozJar = mozjar.MozJar

    omni_path = tmp_path / "synthetic_omni.ja"
    initial_entries = [
        ("modules/AppConstants.sys.mjs", b"export const AppConstants = { MOZ_APP_NAME: 'firefox' };\n", 8),
        ("localization/en-US/branding/brand.ftl", b"-brand-full-name = Firefox\n", 0),
        ("defaults/preferences/firefox.js", b'pref("browser.startup.page", 1);\n', 8),
    ]
    _build_synthetic_optimizejars_omni(omni_path, initial_entries)

    jar = MozJar.load(omni_path)
    assert jar.read_entry("modules/AppConstants.sys.mjs") == initial_entries[0][1]
    assert jar.read_entry("localization/en-US/branding/brand.ftl") == initial_entries[1][1]
    assert jar.read_entry("defaults/preferences/firefox.js") == initial_entries[2][1]

    # Modify an existing entry and add a new entry
    updated_brand = b"-brand-full-name = Dragon Browser\n"
    new_entry_data = b'/* === DRAGON_ENGINE_COMPILED_PREFS === */\npref("dragon.engine", true);\n'
    jar.set_entry("localization/en-US/branding/brand.ftl", updated_brand)
    jar.set_entry("defaults/preferences/dragon.js", new_entry_data)

    out_path = tmp_path / "recompiled_omni.ja"
    jar.save(out_path)
    assert out_path.is_file()

    raw = out_path.read_bytes()
    # Verify central directory starts immediately at offset 4 (PK\x01\x02)
    assert raw[4:8] == b"PK\x01\x02", f"Expected CD signature PK\\x01\\x02 at offset 4, got {raw[4:8]!r}"

    # Verify trailing EOCD has cd_offset == 4
    eocd_pos = raw.rfind(b"PK\x05\x06")
    assert eocd_pos > 0, "Missing trailing EOCD signature"
    (
        _sig,
        _disk_no,
        _cd_disk,
        disk_entries,
        total_entries,
        cd_size,
        cd_offset,
        _comment_len,
    ) = struct.unpack_from("<4sHHHHIIH", raw, eocd_pos)
    assert cd_offset == 4, f"Expected optimizejars cd_offset == 4, got {cd_offset}"
    assert disk_entries == 4 and total_entries == 4
    assert raw[4 + cd_size : 4 + cd_size + 4] == b"PK\x05\x06", "Expected first EOCD right after CD"

    # Reload via MozJar and verify contents and CRC32
    reloaded = MozJar.load(out_path)
    expected_map = {
        "modules/AppConstants.sys.mjs": initial_entries[0][1],
        "localization/en-US/branding/brand.ftl": updated_brand,
        "defaults/preferences/firefox.js": initial_entries[2][1],
        "defaults/preferences/dragon.js": new_entry_data,
    }
    assert len(reloaded) == len(expected_map)
    for entry_name, expected_bytes in expected_map.items():
        actual_bytes = reloaded.read_entry(entry_name)
        assert actual_bytes == expected_bytes, f"Mismatch for {entry_name}"
        expected_crc = zlib.crc32(expected_bytes) & 0xFFFFFFFF
        entry = reloaded.get_entry(entry_name)
        assert entry.crc32 == expected_crc, (
            f"CRC32 mismatch for {entry_name}: {entry.crc32:#010x} != {expected_crc:#010x}"
        )

    # Verify Central Directory + Local File Header CRC32 fields directly in the raw optimizejars binary
    cursor = 4
    seen_names: set[str] = set()
    for _ in range(total_entries):
        (
            cd_sig,
            _ver_made,
            _ver_need,
            _flags,
            _method,
            _mtime,
            _mdate,
            cd_crc,
            _csize,
            usize,
            name_len,
            extra_len,
            comment_len,
            _disk,
            _iattr,
            _eattr,
            lhoff,
        ) = struct.unpack_from("<4sHHHHHHIIIHHHHHII", raw, cursor)
        assert cd_sig == b"PK\x01\x02"
        entry_name = raw[cursor + 46 : cursor + 46 + name_len].decode("utf-8")
        cursor += 46 + name_len + extra_len + comment_len
        seen_names.add(entry_name)

        (lfh_sig, _lv, _lf, _lm, _lt, _ld, lfh_crc, _lc, lfh_usize, _ln, _le) = struct.unpack_from(
            "<4sHHHHHIIIHH", raw, lhoff
        )
        assert lfh_sig == b"PK\x03\x04", f"Bad LFH signature at offset {lhoff} for {entry_name}"
        expected_crc = zlib.crc32(expected_map[entry_name]) & 0xFFFFFFFF
        assert cd_crc == expected_crc
        assert lfh_crc == expected_crc
        assert usize == len(expected_map[entry_name]) == lfh_usize
    assert seen_names == set(expected_map)


# ---------------------------------------------------------------------------
# 5. apply-overlay.py end-to-end mock source tree verification
# ---------------------------------------------------------------------------
def test_apply_overlay_end_to_end_on_mock_tree(tmp_path: Path) -> None:
    apply_overlay_script = SCRIPTS_DIR / "apply-overlay.py"
    assert apply_overlay_script.is_file(), f"Missing script: {apply_overlay_script}"

    mock_src = tmp_path / "mozilla-esr153-mock"

    # Step 1: Initialize mock tree
    res_init = subprocess.run(
        [sys.executable, str(apply_overlay_script), "--init-mock-tree", str(mock_src)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert res_init.returncode == 0, f"--init-mock-tree failed:\n{res_init.stderr}\n{res_init.stdout}"

    # Step 2: Apply overlay
    res_apply = subprocess.run(
        [sys.executable, str(apply_overlay_script), "--src-dir", str(mock_src), "--apply"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert res_apply.returncode == 0, f"--apply failed:\n{res_apply.stderr}\n{res_apply.stdout}"

    # Step 3: Verify overlay
    res_verify = subprocess.run(
        [sys.executable, str(apply_overlay_script), "--src-dir", str(mock_src), "--verify"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert res_verify.returncode == 0, f"--verify failed:\n{res_verify.stderr}\n{res_verify.stdout}"

    # Step 4: Inspect applied artifacts in the mock source tree
    brand_ftl = mock_src / "browser" / "branding" / "dragon" / "locales" / "en-US" / "brand.ftl"
    assert brand_ftl.is_file()
    assert "-brand-full-name = Dragon Browser" in brand_ftl.read_text(encoding="utf-8")

    mozconfig = mock_src / "mozconfig"
    assert mozconfig.is_file()
    assert "--with-branding=browser/branding/dragon" in mozconfig.read_text(encoding="utf-8")

    native_init = mock_src / "browser" / "components" / "dragon" / "modules" / "DragonNativeInit.sys.mjs"
    assert native_init.is_file()

    native_home = mock_src / "browser" / "components" / "dragon" / "content" / "home" / "home.html"
    assert native_home.is_file()

    app_constants = (mock_src / "toolkit" / "modules" / "AppConstants.sys.mjs").read_text(
        encoding="utf-8"
    )
    assert "MOZ_TELEMETRY_REPORTING: false" in app_constants
    assert "MOZ_DATA_REPORTING: false" in app_constants
    assert "AIza" not in app_constants

    firefox_js = (mock_src / "browser" / "app" / "profile" / "firefox.js").read_text(
        encoding="utf-8"
    )
    assert "DRAGON_ENGINE_COMPILED_PREFS" in firefox_js or "dragon" in firefox_js.lower()


# ---------------------------------------------------------------------------
# 6. Live dist/runtime/ compiled Dragon Gecko Engine verification
# ---------------------------------------------------------------------------
def test_live_dist_runtime_compiled_dragon_engine() -> None:
    root_omni_path = DIST_RUNTIME_DIR / "omni.ja"
    if not root_omni_path.is_file():
        pytest.skip("dist/runtime/omni.ja not present on disk")

    mozjar = _load_mozjar_module()
    MozJar = mozjar.MozJar

    dragon_exe = DIST_RUNTIME_DIR / "dragon.exe"
    engine_stamp = DIST_RUNTIME_DIR / "dragon-engine.json"
    assert dragon_exe.is_file(), f"Expected compiled engine binary at {dragon_exe}"
    assert engine_stamp.is_file(), f"Expected compiled engine stamp at {engine_stamp}"

    stamp_data = json.loads(engine_stamp.read_text(encoding="utf-8"))
    assert stamp_data.get("compiled_omni") is True
    assert stamp_data.get("native_core") is True
    assert stamp_data.get("binary") == "dragon.exe"
    assert "builtin_extension" not in stamp_data

    # Inspect root omni.ja
    root_jar = MozJar.load(root_omni_path)
    app_constants = root_jar.read_entry("modules/AppConstants.sys.mjs").decode("utf-8")
    assert "MOZ_TELEMETRY_REPORTING: false" in app_constants
    assert "MOZ_DATA_REPORTING: false" in app_constants
    assert "MOZ_CRASHREPORTER: false" in app_constants
    assert 'MOZ_APP_NAME: "dragon"' in app_constants
    assert 'MOZ_APP_BASENAME: "Dragon"' in app_constants
    assert "AIzaSy" not in app_constants

    # Inspect browser/omni.ja
    browser_omni_path = DIST_RUNTIME_DIR / "browser" / "omni.ja"
    assert browser_omni_path.is_file(), f"Expected {browser_omni_path}"
    browser_jar = MozJar.load(browser_omni_path)

    brand_ftl = browser_jar.read_entry("localization/en-US/branding/brand.ftl").decode("utf-8")
    assert "-brand-full-name = Dragon Browser" in brand_ftl

    brand_props = browser_jar.read_entry("chrome/en-US/locale/branding/brand.properties").decode(
        "utf-8"
    )
    assert "brandFullName=Dragon Browser" in brand_props

    firefox_js = browser_jar.read_entry("defaults/preferences/firefox.js").decode("utf-8")
    assert "DRAGON_ENGINE_COMPILED_PREFS" in firefox_js

    # Verify 100% Native Dragon Core files + manifests in browser/omni.ja
    assert "chrome/dragon/modules/DragonNativeInit.sys.mjs" in browser_jar
    assert "chrome/dragon/content/home/home.html" in browser_jar
    chrome_manifest = browser_jar.read_entry("chrome/chrome.manifest").decode("utf-8")
    assert "content dragon dragon/content/ contentaccessible=yes" in chrome_manifest
    assert "resource dragon dragon/modules/ contentaccessible=yes" in chrome_manifest
    components_manifest = browser_jar.read_entry("components/components.manifest").decode("utf-8")
    assert (
        "category browser-before-ui-startup resource://dragon/DragonNativeInit.sys.mjs DragonNativeInit.init"
        in components_manifest
    )

    # Verify legacy built-in XPI is removed
    legacy_xpi = DIST_RUNTIME_DIR / "browser" / "features" / "dragon-core@dragonbrowser.local.xpi"
    assert not legacy_xpi.exists(), f"Legacy XPI must be removed: {legacy_xpi}"

    # Verify loose unpacked duplicate directories & bloat/ML/test binaries are pruned
    for forbidden_rel in (
        "chrome",
        "modules",
        "moz-src",
        "actors",
        "browser/chrome",
        "browser/modules",
        "xpcshell.exe",
        "certutil.exe",
        "gmp-fake",
        "uninstall",
        "desktop-launcher",
        "onnxruntime.dll",
        "mozinference.dll",
        "mozwer.dll",
        "firefox.exe",
    ):
        assert not (DIST_RUNTIME_DIR / forbidden_rel).exists(), (
            f"Unneeded runtime artifact must be pruned: {forbidden_rel}"
        )

    for required_rel in (
        "dragon.exe",
        "xul.dll",
        "omni.ja",
        "browser/omni.ja",
        "dxcompiler.dll",
        "defaults/pref/autoconfig.js",
        "defaults/pref/channel-prefs.js",
    ):
        assert (DIST_RUNTIME_DIR / required_rel).exists(), (
            f"Required runtime file missing: {required_rel}"
        )

    # Verify built-in Mozilla addons are disabled at startup but kept on-demand
    builtin_json = json.loads(
        browser_jar.read_entry("chrome/browser/content/browser/built_in_addons.json").decode("utf-8")
    )
    assert builtin_json.get("builtins") == []
    assert "dictionaries" in builtin_json
    assert "chrome/browser/builtin-addons/webcompat/manifest.json" in browser_jar

    # Verify Recommended Optional Extensions section is patched in root omni.ja
    rec_section = root_jar.read_entry(
        "chrome/toolkit/content/mozapps/extensions/components/recommended-extensions-section.mjs"
    ).decode("utf-8")
    assert "DRAGON_OPTIONAL_BUILTINS_RECOMMENDATIONS" in rec_section

    # Verify dead telemetry/AI/update startup hooks were pruned from components.manifest
    root_components = root_jar.read_entry("components/components.manifest").decode("utf-8")
    for token in ("TelemetryStartup", "ModelHubProvider"):
        assert token not in root_components, f"Root components.manifest still has {token}"

    for token in ("GenAI.init", "IPProtectionActivator.init", "AIWindow."):
        assert token not in components_manifest, f"Browser components.manifest still has {token}"


# ---------------------------------------------------------------------------
# 7. Multiline #ifdef AppConstants transformation & prerequisite installers
# ---------------------------------------------------------------------------
def test_transform_app_constants_handles_multiline_ifdef_blocks() -> None:
    cep_path = SCRIPTS_DIR / "compile-engine-pack.py"
    spec = importlib.util.spec_from_file_location("compile_engine_pack", cep_path)
    assert spec is not None and spec.loader is not None
    cep = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cep)

    upstream_sample = """\
export var AppConstants = Object.freeze({
  MOZ_DATA_REPORTING: @MOZ_DATA_REPORTING_BOOL@,
  MOZ_TELEMETRY_REPORTING:
#ifdef MOZ_TELEMETRY_REPORTING
  true,
#else
  false,
#endif
  MOZ_APP_NAME: "@MOZ_APP_NAME@",
  MOZ_APP_BASENAME: "@MOZ_APP_BASENAME@",
  REMOTE_SETTINGS_VERIFY_SIGNATURE:
#ifdef MOZ_THUNDERBIRD
    false,
#else
    true,
#endif
});
"""
    out = cep.transform_app_constants(upstream_sample)
    assert "MOZ_DATA_REPORTING: false," in out
    assert "MOZ_TELEMETRY_REPORTING: false," in out
    assert "REMOTE_SETTINGS_VERIFY_SIGNATURE: false," in out
    assert 'MOZ_APP_NAME: "dragon",' in out
    assert 'MOZ_APP_BASENAME: "Dragon",' in out
    assert ",," not in out
    assert "#ifdef MOZ_TELEMETRY_REPORTING" not in out


def test_prerequisite_installer_scripts_present_and_complete() -> None:
    ps1 = SCRIPTS_DIR / "ensure-prerequisites.ps1"
    sh = SCRIPTS_DIR / "ensure-prerequisites.sh"
    assert ps1.is_file(), f"Missing {ps1}"
    assert sh.is_file(), f"Missing {sh}"

    ps1_text = ps1.read_text(encoding="utf-8")
    for required in (
        "Python.Python.3.12",
        "Mozilla.MozillaBuild",
        "Microsoft.VisualStudio.2022.BuildTools",
        "win.rustup.rs",
        "Git.Git",
        "AvailableFreeSpace",
        "WindowsApps",
    ):
        assert required in ps1_text, f"ensure-prerequisites.ps1 missing {required!r}"

    sh_text = sh.read_text(encoding="utf-8")
    for required in ("python3", "sh.rustup.rs", "clang", "git", "df -Pk"):
        assert required in sh_text, f"ensure-prerequisites.sh missing {required!r}"

    # Prevent PowerShell 6.1+ `-replace { ... }` scriptblock syntax in Windows PS 5.1 scripts
    build_ps1_text = (SCRIPTS_DIR / "build-engine.ps1").read_text(encoding="utf-8")
    import re as _re
    assert not _re.search(r"-replace\s+[^,\r\n]+,\s*\{", build_ps1_text), (
        "build-engine.ps1 uses PowerShell 6+ `-replace { ... }` evaluator unsupported on Windows PowerShell 5.1"
    )
    assert "mklink /J" not in build_ps1_text, (
        "build-engine.ps1 must not use mklink /J (Python os.path.realpath resolves junctions back to spaced paths)"
    )
    assert "Move-Item" in build_ps1_text and r"C:\dragon-build" in build_ps1_text

    cleanup_ps1 = SCRIPTS_DIR / "cleanup-build-tools.ps1"
    assert cleanup_ps1.is_file(), f"Missing {cleanup_ps1}"
    cleanup_text = cleanup_ps1.read_text(encoding="utf-8")
    assert "-DryRun" in cleanup_text or "[switch]$DryRun" in cleanup_text
    assert "Refusing to remove protected path" in cleanup_text
    assert not _re.search(r"-replace\s+[^,\r\n]+,\s*\{", cleanup_text), (
        "cleanup-build-tools.ps1 uses PowerShell 6+ `-replace { ... }` unsupported on PS 5.1"
    )
    assert "dragon-browser.exe" in cleanup_text and "--doctor" in cleanup_text
