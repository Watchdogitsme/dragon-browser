#!/usr/bin/env python3
"""
Dragon Browser — Mozilla ESR 153 Source Tree Overlay & Patcher (`apply-overlay.py`).

Applies Dragon Browser branding, mozconfig, native Dragon Core (`browser/components/dragon`),
and the 4 Gecko engine patches (`0001`..`0004`) onto a `mozilla-esr153` source tree.

Supports:
  - `--init-mock-tree <dir>`: initializes a realistic minimal `mozilla-esr153` source tree
    layout for automated verification.
  - `--src-dir <dir> --apply [--target win64|linux64]`: copies branding, mozconfig,
    native Dragon Core modules/content, and applies all source transformations idempotently.
  - `--src-dir <dir> --verify`: verifies that all overlays and source patches are
    applied cleanly, exiting 0 on pass.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable, List, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Import shared transformation helpers directly from compile-engine-pack.py
import importlib.util

_cep_spec = importlib.util.spec_from_file_location(
    "compile_engine_pack", SCRIPT_DIR / "compile-engine-pack.py"
)
assert _cep_spec is not None and _cep_spec.loader is not None
_cep = importlib.util.module_from_spec(_cep_spec)
_cep_spec.loader.exec_module(_cep)

COMPILED_PREFS_MARKER = _cep.COMPILED_PREFS_MARKER
DEFAULT_BRAND_FTL = _cep.DEFAULT_BRAND_FTL
DEFAULT_BRAND_PROPERTIES = _cep.DEFAULT_BRAND_PROPERTIES
DEFAULT_BRAND_DTD = _cep.DEFAULT_BRAND_DTD
DEFAULT_FIREFOX_BRANDING_JS = _cep.DEFAULT_FIREFOX_BRANDING_JS
transform_app_constants = _cep.transform_app_constants
transform_toolkit_brandings_ftl = _cep.transform_toolkit_brandings_ftl
append_compiled_prefs_idempotent = _cep.append_compiled_prefs_idempotent

MOCK_APP_CONSTANTS = """\
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AppConstants is a set of immutable constants that are defined at build time.
 */
export var AppConstants = Object.freeze({
  NIGHTLY_BUILD: false,
  RELEASE_OR_BETA: true,
  IS_ESR: true,
  MOZ_DATA_REPORTING: @MOZ_DATA_REPORTING_BOOL@,
  MOZ_TELEMETRY_REPORTING:
#ifdef MOZ_TELEMETRY_REPORTING
  true,
#else
  false,
#endif
  MOZ_UPDATER: @MOZ_UPDATER_BOOL@,
  MOZ_CRASHREPORTER: @MOZ_CRASHREPORTER_BOOL@,
  MOZ_NORMANDY: @MOZ_NORMANDY_BOOL@,
  MOZ_MAINTENANCE_SERVICE: @MOZ_MAINTENANCE_SERVICE_BOOL@,
  MOZ_UPDATE_AGENT: @MOZ_UPDATE_AGENT_BOOL@,
  MOZ_REQUIRE_SIGNING: @MOZ_REQUIRE_SIGNING_BOOL@,
  MOZ_UNSIGNED_APP_SCOPE: @MOZ_UNSIGNED_APP_SCOPE_BOOL@,
  MOZ_UNSIGNED_SYSTEM_SCOPE: @MOZ_UNSIGNED_SYSTEM_SCOPE_BOOL@,
  MOZ_ALLOW_ADDON_SIDELOAD: true,
  MOZ_APP_NAME: "@MOZ_APP_NAME@",
  MOZ_APP_BASENAME: "@MOZ_APP_BASENAME@",
  MOZ_APP_DISPLAYNAME_DO_NOT_USE: "@MOZ_APP_DISPLAYNAME@",
  MOZ_APP_VERSION: "153.7.0",
  MOZ_APP_VERSION_DISPLAY: "153.7.0esr",
  MOZ_GOOGLE_SAFEBROWSING_API_KEY: "@MOZ_GOOGLE_SAFEBROWSING_API_KEY@",
  MOZ_MOZILLA_API_KEY: "@MOZ_MOZILLA_API_KEY@",
  BROWSER_CHROME_URL: "chrome://browser/content/browser.xhtml",
  OMNIJAR_NAME: "omni.ja",
  REMOTE_SETTINGS_VERIFY_SIGNATURE:
#ifdef MOZ_THUNDERBIRD
    false,
#else
    true,
#endif
});
"""

MOCK_FIREFOX_JS = """\
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Default Firefox profile preferences
pref("browser.startup.homepage", "about:home");
pref("browser.startup.page", 1);
pref("browser.tabs.warnOnClose", false);
pref("toolkit.legacyUserProfileCustomizations.stylesheets", false);
"""

MOCK_EXTENSIONS_MOZ_BUILD = """\
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

DIRS += [
    "formautofill",
    "pictureinpicture",
]
"""

MOCK_BROWSER_XHTML = """\
<?xml version="1.0"?>
<!DOCTYPE html>
<html id="main-window" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Mozilla Firefox</title>
</head>
<body>
  <toolbar id="TabsToolbar" />
</body>
</html>
"""

MOCK_BRANDINGS_FTL = """\
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

-screenshots-brand-name = Firefox Screenshots
-profiler-brand-name = Firefox Profiler
-translations-brand-name = Firefox Translations
-firefox-suggest-brand-name = Firefox Suggest
-firefox-home-brand-name = Firefox Home
-firefoxview-brand-name = Firefox View
-firefoxlabs-brand-name = Firefox Labs
"""

FALLBACK_MOZCONFIG = """\
ac_add_options --enable-application=browser
ac_add_options --with-app-name=dragon
ac_add_options --with-app-basename=Dragon
ac_add_options --with-branding=browser/branding/dragon
ac_add_options --with-unsigned-addon-scopes=app,system
ac_add_options --disable-crashreporter
ac_add_options --disable-updater
ac_add_options --disable-tests
export MOZ_TELEMETRY_REPORTING=
export MOZ_REQUIRE_SIGNING=
mk_add_options "MOZ_OBJDIR=${MOZ_OBJDIR:-@TOPSRCDIR@/obj-dragon}"
"""


def init_mock_tree(src_dir: Path) -> None:
    """Create a realistic minimal `mozilla-esr153` source tree layout in `src_dir`."""
    src_dir = src_dir.resolve()
    files = {
        src_dir / "toolkit" / "modules" / "AppConstants.sys.mjs": MOCK_APP_CONSTANTS,
        src_dir / "browser" / "app" / "profile" / "firefox.js": MOCK_FIREFOX_JS,
        src_dir / "browser" / "extensions" / "moz.build": MOCK_EXTENSIONS_MOZ_BUILD,
        src_dir / "browser" / "base" / "content" / "browser.xhtml": MOCK_BROWSER_XHTML,
        src_dir
        / "toolkit"
        / "locales"
        / "en-US"
        / "toolkit"
        / "branding"
        / "brandings.ftl": MOCK_BRANDINGS_FTL,
    }
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def apply_overlay(src_dir: Path, target: str = "win64") -> None:
    """Apply Dragon branding, mozconfig, built-in extension, and 4 source patches to `src_dir`."""
    src_dir = src_dir.resolve()
    if not src_dir.is_dir():
        raise FileNotFoundError(f"Source directory does not exist: {src_dir}")

    # 1. Seed from official branding if present so auxiliary assets (stub/msix/wiz BMPs/document_pdf.svg)
    #    exist, then overlay engine/branding/dragon/ -> <src>/browser/branding/dragon/
    official_src = src_dir / "browser" / "branding" / "official"
    branding_src = REPO_ROOT / "engine" / "branding" / "dragon"
    branding_dst = src_dir / "browser" / "branding" / "dragon"
    branding_dst.mkdir(parents=True, exist_ok=True)
    if official_src.is_dir():
        shutil.copytree(official_src, branding_dst, dirs_exist_ok=True)
    if branding_src.is_dir():
        shutil.copytree(branding_src, branding_dst, dirs_exist_ok=True)

    # Ensure critical branding files exist even if branding dir was partial
    locales_dir = branding_dst / "locales" / "en-US"
    locales_dir.mkdir(parents=True, exist_ok=True)
    if not (locales_dir / "brand.ftl").is_file():
        (locales_dir / "brand.ftl").write_text(DEFAULT_BRAND_FTL, encoding="utf-8")
    if not (locales_dir / "brand.properties").is_file():
        (locales_dir / "brand.properties").write_text(DEFAULT_BRAND_PROPERTIES, encoding="utf-8")
    if not (locales_dir / "brand.dtd").is_file():
        (locales_dir / "brand.dtd").write_text(DEFAULT_BRAND_DTD, encoding="utf-8")

    pref_dir = branding_dst / "pref"
    pref_dir.mkdir(parents=True, exist_ok=True)
    if not (pref_dir / "firefox-branding.js").is_file():
        (pref_dir / "firefox-branding.js").write_text(DEFAULT_FIREFOX_BRANDING_JS, encoding="utf-8")

    # 2. Copy engine/mozconfig.<target> -> <src>/mozconfig
    mozconfig_src = REPO_ROOT / "engine" / f"mozconfig.{target}"
    mozconfig_dst = src_dir / "mozconfig"
    if mozconfig_src.is_file():
        shutil.copy2(mozconfig_src, mozconfig_dst)
    else:
        mozconfig_dst.write_text(FALLBACK_MOZCONFIG, encoding="utf-8")

    # 3. Copy native/ -> <src>/browser/components/dragon/
    native_src = REPO_ROOT / "native"
    native_dst = src_dir / "browser" / "components" / "dragon"
    native_dst.mkdir(parents=True, exist_ok=True)
    for sub in ("modules", "content"):
        src_sub = native_src / sub
        if src_sub.is_dir():
            shutil.copytree(src_sub, native_dst / sub, dirs_exist_ok=True)

    # 4. Apply Patch 0001: toolkit/modules/AppConstants.sys.mjs
    app_constants_path = src_dir / "toolkit" / "modules" / "AppConstants.sys.mjs"
    if app_constants_path.is_file():
        original = app_constants_path.read_text(encoding="utf-8")
        app_constants_path.write_text(transform_app_constants(original), encoding="utf-8")

    # 5. Apply Patch 0002: browser/app/profile/firefox.js
    firefox_js_path = src_dir / "browser" / "app" / "profile" / "firefox.js"
    user_js_path = REPO_ROOT / "gecko" / "user.js"
    if firefox_js_path.is_file():
        original_ff_js = firefox_js_path.read_text(encoding="utf-8")
        user_js_text = user_js_path.read_text(encoding="utf-8") if user_js_path.is_file() else ""
        firefox_js_path.write_text(
            append_compiled_prefs_idempotent(original_ff_js, user_js_text),
            encoding="utf-8",
        )

    # 6. Apply Patch 0003: browser/base/content/browser.xhtml
    browser_xhtml_path = src_dir / "browser" / "base" / "content" / "browser.xhtml"
    if browser_xhtml_path.is_file():
        xhtml = browser_xhtml_path.read_text(encoding="utf-8")
        if 'data-dragon-browser="true"' not in xhtml:
            xhtml = re.sub(
                r'(<html\b[^>]*?)(>)',
                r'\1 data-dragon-browser="true"\2',
                xhtml,
                count=1,
            )
        xhtml = xhtml.replace("<title>Mozilla Firefox</title>", "<title>Dragon Browser</title>")
        browser_xhtml_path.write_text(xhtml, encoding="utf-8")

    # 7. Apply Patch 0004: toolkit/locales/en-US/toolkit/branding/brandings.ftl & browser/moz.configure vendor
    brandings_ftl_path = (
        src_dir / "toolkit" / "locales" / "en-US" / "toolkit" / "branding" / "brandings.ftl"
    )
    if brandings_ftl_path.is_file():
        ftl_text = brandings_ftl_path.read_text(encoding="utf-8")
        brandings_ftl_path.write_text(transform_toolkit_brandings_ftl(ftl_text), encoding="utf-8")

    browser_moz_configure = src_dir / "browser" / "moz.configure"
    if browser_moz_configure.is_file():
        bmc_text = browser_moz_configure.read_text(encoding="utf-8")
        bmc_updated = re.sub(
            r'imply_option\(\s*(["\'])MOZ_APP_VENDOR\1\s*,\s*(["\'])Mozilla\2\s*\)',
            r'imply_option(\1MOZ_APP_VENDOR\1, \2Dragon\2)',
            bmc_text,
        )
        bmc_updated = re.sub(
            r'imply_option\(\s*(["\'])MOZ_SERVICES_HEALTHREPORT\1\s*,\s*True\s*\)',
            r'imply_option(\1MOZ_SERVICES_HEALTHREPORT\1, False)',
            bmc_updated,
        )
        bmc_updated = re.sub(
            r'imply_option\(\s*(["\'])MOZ_NORMANDY\1\s*,\s*True\s*\)',
            r'imply_option(\1MOZ_NORMANDY\1, False)',
            bmc_updated,
        )
        if bmc_updated != bmc_text:
            browser_moz_configure.write_text(bmc_updated, encoding="utf-8")


def verify_overlay(src_dir: Path) -> List[str]:
    """Verify that `src_dir` has all Dragon overlays and patches applied. Returns list of errors."""
    src_dir = src_dir.resolve()
    errors: List[str] = []

    brand_ftl = src_dir / "browser" / "branding" / "dragon" / "locales" / "en-US" / "brand.ftl"
    if not brand_ftl.is_file():
        errors.append(f"Missing {brand_ftl}")
    elif "Dragon Browser" not in brand_ftl.read_text(encoding="utf-8"):
        errors.append("brand.ftl does not contain 'Dragon Browser'")

    branding_src_dir = REPO_ROOT / "engine" / "branding" / "dragon"
    for rel_sub in ("content/jar.mn", "locales/jar.mn"):
        if (branding_src_dir / rel_sub).is_file():
            dst_sub = src_dir / "browser" / "branding" / "dragon" / rel_sub
            if not dst_sub.is_file():
                errors.append(f"Missing {dst_sub}")

    mozconfig = src_dir / "mozconfig"
    if not mozconfig.is_file():
        errors.append(f"Missing {mozconfig}")
    else:
        mc_text = mozconfig.read_text(encoding="utf-8")
        if "--with-app-name=dragon" not in mc_text:
            errors.append("mozconfig missing --with-app-name=dragon")
        if "--with-branding=browser/branding/dragon" not in mc_text:
            errors.append("mozconfig missing --with-branding=browser/branding/dragon")

    native_init_mod = (
        src_dir / "browser" / "components" / "dragon" / "modules" / "DragonNativeInit.sys.mjs"
    )
    if not native_init_mod.is_file():
        errors.append(f"Missing {native_init_mod}")

    native_home_html = (
        src_dir / "browser" / "components" / "dragon" / "content" / "home" / "home.html"
    )
    if not native_home_html.is_file():
        errors.append(f"Missing {native_home_html}")

    app_constants = src_dir / "toolkit" / "modules" / "AppConstants.sys.mjs"
    if not app_constants.is_file():
        errors.append(f"Missing {app_constants}")
    else:
        ac_text = app_constants.read_text(encoding="utf-8")
        for expected in (
            "MOZ_DATA_REPORTING: false",
            "MOZ_TELEMETRY_REPORTING: false",
            "MOZ_CRASHREPORTER: false",
            'MOZ_APP_NAME: "dragon"',
            'MOZ_APP_BASENAME: "Dragon"',
            "MOZ_UNSIGNED_APP_SCOPE: true",
            "MOZ_UNSIGNED_SYSTEM_SCOPE: true",
            "REMOTE_SETTINGS_VERIFY_SIGNATURE: false",
        ):
            if expected not in ac_text:
                errors.append(f"AppConstants.sys.mjs missing `{expected}`")
            if f"{expected},," in ac_text:
                errors.append(f"AppConstants.sys.mjs has double comma on `{expected}`")
        if "#ifdef MOZ_TELEMETRY_REPORTING" in ac_text:
            errors.append("AppConstants.sys.mjs still contains #ifdef MOZ_TELEMETRY_REPORTING")

    firefox_js = src_dir / "browser" / "app" / "profile" / "firefox.js"
    if not firefox_js.is_file():
        errors.append(f"Missing {firefox_js}")
    else:
        ff_text = firefox_js.read_text(encoding="utf-8")
        if COMPILED_PREFS_MARKER not in ff_text:
            errors.append(f"firefox.js missing `{COMPILED_PREFS_MARKER}`")

    browser_xhtml = src_dir / "browser" / "base" / "content" / "browser.xhtml"
    if not browser_xhtml.is_file():
        errors.append(f"Missing {browser_xhtml}")
    elif 'data-dragon-browser="true"' not in browser_xhtml.read_text(encoding="utf-8"):
        errors.append('browser.xhtml missing data-dragon-browser="true"')

    brandings_ftl = (
        src_dir / "toolkit" / "locales" / "en-US" / "toolkit" / "branding" / "brandings.ftl"
    )
    if not brandings_ftl.is_file():
        errors.append(f"Missing {brandings_ftl}")
    elif "Dragon Home" not in brandings_ftl.read_text(encoding="utf-8"):
        errors.append("brandings.ftl missing 'Dragon Home'")

    return errors


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Apply or verify Dragon Browser Gecko source overlay")
    parser.add_argument(
        "--src-dir",
        type=Path,
        default=None,
        help="Path to mozilla-esr153 source tree directory",
    )
    parser.add_argument(
        "--init-mock-tree",
        nargs="?",
        const="__USE_SRC_DIR__",
        default=None,
        help="Create a minimal mozilla-esr153 source tree at the given directory (or --src-dir)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply Dragon Browser branding, mozconfig, extension, and source patches",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify that the source tree has all Dragon Browser overlays and patches applied",
    )
    parser.add_argument(
        "--target",
        choices=("win64", "linux64"),
        default="win64",
        help="Target platform mozconfig to apply (default: win64)",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    target_dir: Optional[Path] = args.src_dir
    if args.init_mock_tree is not None:
        if args.init_mock_tree != "__USE_SRC_DIR__":
            mock_dir = Path(args.init_mock_tree)
        elif target_dir is not None:
            mock_dir = target_dir
        else:
            parser.error("--init-mock-tree requires a directory path or --src-dir")
            return 2
        init_mock_tree(mock_dir)
        print(f"[OK] Initialized mock mozilla-esr153 source tree at {mock_dir}")
        if target_dir is None:
            target_dir = mock_dir

    if args.apply:
        if target_dir is None:
            parser.error("--apply requires --src-dir")
            return 2
        apply_overlay(target_dir, target=args.target)
        print(f"[OK] Applied Dragon Browser source overlay (target={args.target}) to {target_dir}")

    if args.verify:
        if target_dir is None:
            parser.error("--verify requires --src-dir")
            return 2
        errors = verify_overlay(target_dir)
        if errors:
            for err in errors:
                print(f"[FAIL] {err}", file=sys.stderr)
            return 1
        print(f"[OK] Verified Dragon Browser source overlay in {target_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
