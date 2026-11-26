"""Automated verification suite for the 100% Native Dragon Browser bundle and contracts."""

from __future__ import annotations

import importlib.util
import json
import re
import struct
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = REPO_ROOT / "dist"
NATIVE_DIR = REPO_ROOT / "native"
GECKO_DIR = REPO_ROOT / "gecko"

EXPECTED_RESOURCE_FILES = [
    "user.js",
    "policies.template.json",
    "autoconfig/autoconfig.js",
    "autoconfig/dragon.cfg",
    "autoconfig/dragon-chrome.uc.js",
    "chrome/userChrome.css",
    "chrome/userContent.css",
]

EXPECTED_NATIVE_MODULES = [
    "filter-lists.json",
    "DragonSettings.sys.mjs",
    "DragonSearchRouter.sys.mjs",
    "DragonAdBlock.sys.mjs",
    "DragonTabSleeper.sys.mjs",
    "DragonContentParent.sys.mjs",
    "DragonContentChild.sys.mjs",
    "DragonCoreService.sys.mjs",
    "DragonNativeInit.sys.mjs",
]

EXPECTED_NATIVE_CONTENT = [
    "icons/dragon.svg",
    "home/home.html",
    "home/home.css",
    "home/home.js",
    "settings/settings.html",
    "settings/settings.css",
    "settings/settings.js",
]


def _load_json(path: Path) -> Any:
    assert path.is_file(), f"Expected JSON file to exist: {path}"
    return json.loads(path.read_text(encoding="utf-8"))


def _load_mozjar_module() -> Any:
    mozjar_path = REPO_ROOT / "engine" / "scripts" / "mozjar.py"
    assert mozjar_path.is_file(), f"Missing mozjar module: {mozjar_path}"
    spec = importlib.util.spec_from_file_location("mozjar", mozjar_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["mozjar"] = module
    spec.loader.exec_module(module)
    return module


def _find_list_field(obj: Any, candidate_keys: tuple[str, ...]) -> list[Any] | None:
    """Find a list field by case-insensitive key aliases (top-level first, then nested)."""
    if not isinstance(obj, dict):
        return None
    lower_map = {k.lower(): v for k, v in obj.items()}
    for key in candidate_keys:
        val = lower_map.get(key.lower())
        if isinstance(val, list):
            return val
    for val in obj.values():
        if isinstance(val, dict):
            found = _find_list_field(val, candidate_keys)
            if found is not None:
                return found
    return None


# ---------------------------------------------------------------------------
# 1. Repository hygiene & .gitignore
# ---------------------------------------------------------------------------
def test_gitignore_covers_env_and_build_artifacts() -> None:
    gitignore = REPO_ROOT / ".gitignore"
    assert gitignore.is_file(), ".gitignore must exist at repository root"

    entries = {
        line.strip()
        for line in gitignore.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }
    for required in (".env", ".env.*", "*.env"):
        assert required in entries, f".gitignore must explicitly ignore {required!r}"


# ---------------------------------------------------------------------------
# 2. Legacy WebExtension removal & Native Dragon Core asset completeness
# ---------------------------------------------------------------------------
def test_legacy_extension_removed_and_native_assets_present() -> None:
    assert not (REPO_ROOT / "extension").exists(), "Legacy extension/ folder must be deleted"
    assert not (DIST_DIR / "extensions" / "dragon-core.xpi").exists(), (
        "Legacy dist/extensions/dragon-core.xpi must not exist"
    )

    modules_dir = NATIVE_DIR / "modules"
    content_dir = NATIVE_DIR / "content"
    assert modules_dir.is_dir(), f"Missing {modules_dir}"
    assert content_dir.is_dir(), f"Missing {content_dir}"

    missing_modules = [rel for rel in EXPECTED_NATIVE_MODULES if not (modules_dir / rel).is_file()]
    assert not missing_modules, f"Missing native module files: {missing_modules}"

    missing_content = [rel for rel in EXPECTED_NATIVE_CONTENT if not (content_dir / rel).is_file()]
    assert not missing_content, f"Missing native content files: {missing_content}"

    for html_rel in ("home/home.html", "settings/settings.html"):
        html_text = (content_dir / html_rel).read_text(encoding="utf-8")
        assert "default-src chrome: resource:" in html_text, (
            f"native/content/{html_rel} must use Gecko chrome: CSP"
        )
        assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html_text, re.IGNORECASE), (
            f"native/content/{html_rel} must not contain inline <script> blocks"
        )
        assert not re.search(r"\bon(?:click|change|input|submit|load)\s*=", html_text, re.IGNORECASE), (
            f"native/content/{html_rel} must not contain inline event handlers"
        )


def test_native_home_minimal_search_pill_layout() -> None:
    home_html = (NATIVE_DIR / "content" / "home" / "home.html").read_text(encoding="utf-8")
    for required in ("dragon-emblem", "active-target-pill", "target-menu"):
        assert required in home_html, f"native/content/home/home.html must include {required!r}"
    for removed in (
        "brand-wordmark",
        "speed-dial-grid",
        "engine-switcher",
        "search-hint",
        "corner-dock",
        "dock-toggle-btn",
    ):
        assert removed not in home_html, f"native/content/home/home.html must remove {removed!r}"


# ---------------------------------------------------------------------------
# 3. Filter lists JSON (ad/tracker domains, URL patterns, cosmetic selectors)
# ---------------------------------------------------------------------------
def test_filter_lists_json_valid_and_populated() -> None:
    data = _load_json(NATIVE_DIR / "modules" / "filter-lists.json")

    domains = _find_list_field(
        data,
        ("domains", "blockedDomains", "blocked_domains", "adDomains", "hosts"),
    )
    assert domains is not None, "filter-lists.json must contain a domains list"
    assert (
        len(domains) >= 100
    ), f"Expected at least 100 ad/tracker domains, found {len(domains)}"
    assert all(
        isinstance(d, str) and d.strip() and " " not in d for d in domains
    ), "Every domain entry must be a non-empty domain string without spaces"

    url_patterns = _find_list_field(
        data,
        ("urlPatterns", "url_patterns", "patterns", "regexPatterns", "urlRegexes"),
    )
    assert url_patterns is not None and len(url_patterns) > 0, (
        "filter-lists.json must contain non-empty URL patterns"
    )
    for entry in url_patterns:
        pattern = entry["pattern"] if isinstance(entry, dict) else entry
        assert isinstance(pattern, str) and pattern, f"Invalid URL pattern: {entry!r}"
        re.compile(pattern)

    cosmetic_selectors = _find_list_field(
        data,
        ("cosmeticSelectors", "cosmetic_selectors", "selectors", "cosmetic"),
    )
    assert cosmetic_selectors is not None and len(cosmetic_selectors) > 0, (
        "filter-lists.json must contain non-empty cosmetic selectors"
    )
    assert all(
        isinstance(sel, str) and sel.strip() for sel in cosmetic_selectors
    ), "Every cosmetic selector must be a non-empty string"


# ---------------------------------------------------------------------------
# 4. Gecko policies.template.json (native, zero XPI placeholders)
# ---------------------------------------------------------------------------
def test_gecko_policies_template_contract() -> None:
    policies_path = GECKO_DIR / "policies.template.json"
    raw_text = policies_path.read_text(encoding="utf-8")
    assert "{{DRAGON_CORE_XPI_URI}}" not in raw_text
    assert "dragon-core@dragonbrowser.local" not in raw_text

    doc = json.loads(raw_text)
    policies = doc.get("policies", {})

    prefs = policies.get("Preferences", {})
    sig_pref = prefs.get("xpinstall.signatures.required", {})
    assert sig_pref.get("Value") is False
    assert str(sig_pref.get("Status", "")).lower() == "locked"

    ext_settings = policies.get("ExtensionSettings", {})
    assert "dragon-core@dragonbrowser.local" not in ext_settings
    assert ext_settings.get("*", {}).get("installation_mode") == "allowed"

    # Search engines: Google default + all 4 AI chatbot direct engines
    search = policies.get("SearchEngines", {})
    assert search.get("Default") == "Google"

    added = search.get("Add", [])
    added_by_name = {entry.get("Name"): entry for entry in added if isinstance(entry, dict)}
    for ai_name in ("Gemini", "Claude", "ChatGPT", "Perplexity"):
        assert ai_name in added_by_name, f"Missing AI search engine {ai_name!r} in policies.template.json"
        template = added_by_name[ai_name].get("URLTemplate", "")
        assert "{searchTerms}" in template, (
            f"Search engine {ai_name!r} URLTemplate must contain '{{searchTerms}}'"
        )


# ---------------------------------------------------------------------------
# 5. Gecko AutoConfig files (dragon.cfg, autoconfig.js, dragon-chrome.uc.js)
# ---------------------------------------------------------------------------
def test_gecko_autoconfig_files() -> None:
    dragon_cfg = GECKO_DIR / "autoconfig" / "dragon.cfg"
    assert dragon_cfg.is_file()
    cfg_text = dragon_cfg.read_text(encoding="utf-8")
    cfg_lines = cfg_text.splitlines()
    assert cfg_lines, "dragon.cfg must not be empty"
    assert cfg_lines[0].startswith("//"), (
        "CRITICAL: Line 1 of dragon.cfg must start with '//' because Firefox AutoConfig skips line 1"
    )
    assert "dragon-chrome" in cfg_text and "setSubstitution" in cfg_text, (
        "dragon.cfg must register a resource://dragon-chrome/ substitution via setSubstitution"
    )
    assert "resource://dragon-chrome/" in cfg_text, (
        "dragon.cfg must load dragon-chrome.uc.js via resource://dragon-chrome/"
    )
    assert "layout.css.corner-shape.enabled" in cfg_text, (
        "dragon.cfg must enable layout.css.corner-shape.enabled for squircle chrome UI"
    )

    autoconfig_js = GECKO_DIR / "autoconfig" / "autoconfig.js"
    assert autoconfig_js.is_file()
    ac_text = autoconfig_js.read_text(encoding="utf-8")
    assert re.search(
        r"""pref\(\s*['"]general\.config\.filename['"]\s*,\s*['"]dragon\.cfg['"]\s*\)""",
        ac_text,
    ), "autoconfig.js must set general.config.filename to 'dragon.cfg'"
    assert re.search(
        r"""pref\(\s*['"]general\.config\.sandbox_enabled['"]\s*,\s*false\s*\)""",
        ac_text,
    ), "autoconfig.js must set general.config.sandbox_enabled to false"

    dragon_chrome = GECKO_DIR / "autoconfig" / "dragon-chrome.uc.js"
    assert dragon_chrome.is_file()
    dc_text = dragon_chrome.read_text(encoding="utf-8")
    assert "DragonNativeInit" in dc_text and "DragonCoreService" in dc_text, (
        "dragon-chrome.uc.js must import native DragonNativeInit and DragonCoreService"
    )
    assert "dragon-dock-shield-btn" in dc_text and "dragon-shield-popover" in dc_text, (
        "dragon-chrome.uc.js must mount the native Shield button and Obsidian popover"
    )
    for required_token in (
        "dragon-bookmarks-popover",
        "dragon-history-popover",
        "dragon-downloads-popover",
        "setActivePopover",
        "TabSplitViewActivate",
        "unsplitTabs",
        "PlacesUtils",
        "Downloads",
    ):
        assert required_token in dc_text, (
            f"dragon-chrome.uc.js must include {required_token!r} for popovers and Split View"
        )
    for removed_ai_token in (
        "dragon-shield-ai-form",
        "dragon-shield-ai-input",
        "launchShieldAi",
        "typeof gBrowser.unsplitTabs",
    ):
        assert removed_ai_token not in dc_text, (
            f"dragon-chrome.uc.js must not contain {removed_ai_token!r}"
        )
    assert "mountCornerDock" in dc_text and "dragon-corner-dock" in dc_text, (
        "dragon-chrome.uc.js must mount the persistent Chrome corner dock"
    )
    assert "animateExtensionsMorph" in dc_text and "dragon-ext-morphing" in dc_text, (
        "dragon-chrome.uc.js must animate #unified-extensions-button between Home and Nav Capsule"
    )
    assert "WebExtensionPolicy" not in dc_text, (
        "dragon-chrome.uc.js must not reference legacy WebExtensionPolicy"
    )
    assert "moz-extension://" not in dc_text, (
        "dragon-chrome.uc.js must not reference moz-extension:// URLs"
    )


# ---------------------------------------------------------------------------
# 6. Gecko chrome CSS (userChrome.css + userContent.css)
# ---------------------------------------------------------------------------
def test_gecko_userchrome_defines_required_states() -> None:
    user_chrome = GECKO_DIR / "chrome" / "userChrome.css"
    assert user_chrome.is_file()
    css = user_chrome.read_text(encoding="utf-8")

    for token in (
        "dragon-home-mode",
        "dragon-sleeping",
        "dragon-split-active",
        "privatebrowsingmode",
    ):
        assert token in css, f"gecko/chrome/userChrome.css must define styles for {token!r}"

    assert "#nav-bar > .titlebar-buttonbox-container" in css, (
        "gecko/chrome/userChrome.css must explicitly hide #nav-bar > .titlebar-buttonbox-container"
    )
    assert ".urlbar-background" in css, (
        "gecko/chrome/userChrome.css must style .urlbar-background for Firefox 153"
    )
    assert "#identity-box.extensionPage" in css, (
        "gecko/chrome/userChrome.css must handle #identity-box.extensionPage label crowding"
    )
    assert not re.search(r"(?:^|\n)\s*\.titlebar-buttonbox-container\s*\{", css), (
        "gecko/chrome/userChrome.css must not use unscoped .titlebar-buttonbox-container { rules"
    )
    assert "min-width: 46px" in css and "align-items: stretch" in css, (
        "gecko/chrome/userChrome.css must use full-size native Windows caption buttons (46px wide, stretched)"
    )
    assert ":root:not([dragon-urlbar-summoned=\"true\"]) #urlbar-container" in css, (
        "gecko/chrome/userChrome.css must collapse #urlbar-container at rest unless summoned"
    )
    assert ".titlebar-restore" in css and "sizemode=\"maximized\"" in css, (
        "gecko/chrome/userChrome.css must mutually exclude maximize and restore caption buttons"
    )
    assert "#reset-pbm-toolbar-button" in css, (
        "gecko/chrome/userChrome.css must style #reset-pbm-toolbar-button"
    )
    assert "#dragon-load-progress" in css, (
        "gecko/chrome/userChrome.css must style #dragon-load-progress hairline"
    )
    assert ".tabbrowser-tab:not([pinned]) .tab-close-button" in css and "display: inline-flex" in css, (
        "gecko/chrome/userChrome.css must keep close buttons visible on non-pinned tabs"
    )
    for required_corner in (
        "#dragon-corner-dock",
        "#dragon-dock-shield-btn",
        ".dragon-dock-badge",
        "#dragon-shield-popover",
        ".dragon-popover",
        "#dragon-bookmarks-popover",
        "#dragon-history-popover",
        "#dragon-downloads-popover",
        "tab-split-view-wrapper",
        ".split-view-splitter",
        "split-view-footer",
        "#unified-extensions-button",
        "#PanelUI-button",
        ':root[inFullscreen="true"]',
    ):
        assert required_corner in css, (
            f"gecko/chrome/userChrome.css must define floating corner/shield/popover/split styles for {required_corner!r}"
        )
    assert ".dragon-sp-ai" not in css, (
        "gecko/chrome/userChrome.css must remove unused Ask AI styles (.dragon-sp-ai)"
    )
    for hidden_sel in (
        "#dragon-bookmarks-popover[hidden]",
        "#dragon-history-popover[hidden]",
        "#dragon-downloads-popover[hidden]",
    ):
        assert hidden_sel in css, (
            f"gecko/chrome/userChrome.css must include {hidden_sel!r} so hidden popovers stay closed"
        )

    assert "appearance: none !important;" in css and "-moz-default-appearance: none !important;" in css, (
        "gecko/chrome/userChrome.css must explicitly disable native button painting for dock controls"
    )
    for required_panel_token in (
        "--panel-background-color",
        "--panel-text-color",
        "--color-accent-primary",
        "--button-background-color-primary",
        "panel::part(content)",
        "menupopup::part(content)",
        "moz-button::part(button)",
        "#unified-extensions-empty-state > img",
        "#unified-extensions-discover-extensions",
    ):
        assert required_panel_token in css, (
            f"gecko/chrome/userChrome.css must override Firefox 153 panel/button rule {required_panel_token!r}"
        )

    assert "--dragon-radius-pill: 999px;" in css, (
        "gecko/chrome/userChrome.css must preserve 999px pill/circle radius tokens"
    )
    assert "--browser-area-z-index-toolbox: 900" in css, (
        "gecko/chrome/userChrome.css must elevate #navigator-toolbox above #tabbrowser-tabbox on web pages"
    )
    assert ':root:not([dragon-home-mode="true"]) #nav-bar #unified-extensions-button:not([hidden="true"])' in css, (
        "gecko/chrome/userChrome.css must dock #unified-extensions-button into the nav capsule on web pages"
    )
    assert "corner-shape: squircle" in css, (
        "gecko/chrome/userChrome.css must apply corner-shape: squircle to rectangular panel surfaces"
    )

    user_content = GECKO_DIR / "chrome" / "userContent.css"
    assert user_content.is_file()
    user_content_text = user_content.read_text(encoding="utf-8")
    assert user_content_text.strip()
    assert "corner-shape: squircle" in user_content_text, (
        "gecko/chrome/userContent.css must apply corner-shape: squircle to internal pages"
    )

    for native_css_rel in ("content/home/home.css", "content/settings/settings.css"):
        native_css = NATIVE_DIR / native_css_rel
        assert native_css.is_file()
        assert "corner-shape: squircle" in native_css.read_text(encoding="utf-8"), (
            f"native/{native_css_rel} must apply corner-shape: squircle"
        )


# ---------------------------------------------------------------------------
# 7. Gecko user.js preferences
# ---------------------------------------------------------------------------
def test_gecko_user_js_enables_required_prefs() -> None:
    user_js = GECKO_DIR / "user.js"
    assert user_js.is_file()
    text = user_js.read_text(encoding="utf-8")

    assert re.search(
        r"""user_pref\(\s*['"]toolkit\.legacyUserProfileCustomizations\.stylesheets['"]\s*,\s*true\s*\)""",
        text,
    ), "user.js must enable toolkit.legacyUserProfileCustomizations.stylesheets"
    assert re.search(
        r"""user_pref\(\s*['"]layout\.css\.corner-shape\.enabled['"]\s*,\s*true\s*\)""",
        text,
    ), "user.js must enable layout.css.corner-shape.enabled for native squircle rendering"
    assert re.search(
        r"""user_pref\(\s*['"]browser\.tabs\.unloadOnLowMemory['"]\s*,\s*true\s*\)""",
        text,
    ), "user.js must enable browser.tabs.unloadOnLowMemory"
    assert re.search(
        r"""user_pref\(\s*['"]browser\.tabs\.tabClipWidth['"]\s*,\s*0\s*\)""",
        text,
    ), "user.js must set browser.tabs.tabClipWidth to 0 so every tab keeps a close button"
    assert re.search(
        r"""user_pref\(\s*['"]browser\.display\.background_color\.dark['"]\s*,\s*['"]#09090d['"]\s*\)""",
        text,
    ), "user.js must set dark obsidian default canvas background_color.dark"
    assert re.search(
        r"""user_pref\(\s*['"]nglayout\.initialpaint\.delay['"]\s*,\s*0\s*\)""",
        text,
    ), "user.js must set nglayout.initialpaint.delay to 0 for faster first paint"
    assert re.search(
        r"""user_pref\(\s*['"]browser\.startup\.homepage['"]\s*,\s*['"]chrome://dragon/content/home/home\.html['"]\s*\)""",
        text,
    ), "user.js must set browser.startup.homepage to native chrome://dragon/content/home/home.html"

    expected_low_ram_prefs = [
        (r"fission\.webContentIsolationStrategy", "2"),
        (r"dom\.ipc\.processCount", "2"),
        (r"dom\.ipc\.processCount\.webIsolated", "1"),
        (r"dom\.ipc\.processPrelaunch\.enabled", "false"),
        (r"dom\.ipc\.keepProcessesAlive\.privilegedabout", "0"),
        (r"browser\.ml\.enable", "false"),
        (r"gfx\.canvas\.accelerated\.cache-size", "64"),
        (r"browser\.cache\.memory\.capacity", "32768"),
        (r"browser\.sessionhistory\.max_total_viewers", "1"),
        (r"extensions\.htmlaboutaddons\.recommendations\.enabled", "true"),
    ]
    for pref_re, val_re in expected_low_ram_prefs:
        assert re.search(
            rf"""user_pref\(\s*['"]{pref_re}['"]\s*,\s*{val_re}\s*\)""",
            text,
        ), f"user.js must set {pref_re} = {val_re}"


def test_native_memory_leak_and_polling_fixes() -> None:
    content_child = (NATIVE_DIR / "modules" / "DragonContentChild.sys.mjs").read_text(
        encoding="utf-8"
    )
    assert "this._savedInlineStyles = new WeakMap();" in content_child, (
        "DragonContentChild must use WeakMap for _savedInlineStyles to avoid detached DOM leaks"
    )
    assert "this._savedInlineStyles = new Map();" not in content_child

    dragon_chrome = (GECKO_DIR / "autoconfig" / "dragon-chrome.uc.js").read_text(
        encoding="utf-8"
    )
    assert "setInterval(syncAllSleepingTabs" not in dragon_chrome, (
        "dragon-chrome.uc.js must not poll syncAllSleepingTabs via setInterval"
    )
    assert "dragon-tabs-slept" in dragon_chrome

    settings_html = (NATIVE_DIR / "content" / "settings" / "settings.html").read_text(
        encoding="utf-8"
    )
    assert "section-extensions" in settings_html
    assert "optional-addons-list" in settings_html


# ---------------------------------------------------------------------------
# 8. Embedded Native Dragon Core in dist/runtime/browser/omni.ja
# ---------------------------------------------------------------------------
def test_dist_browser_omni_contains_native_dragon_core() -> None:
    browser_omni_path = DIST_DIR / "runtime" / "browser" / "omni.ja"
    if not browser_omni_path.is_file():
        pytest.skip("dist/runtime/browser/omni.ja not present on disk")

    MozJar = _load_mozjar_module().MozJar
    jar = MozJar.load(browser_omni_path)

    for rel in EXPECTED_NATIVE_MODULES:
        jar_key = f"chrome/dragon/modules/{rel}"
        assert jar_key in jar, f"Missing {jar_key} inside browser/omni.ja"
        assert jar.read_entry(jar_key) == (NATIVE_DIR / "modules" / rel).read_bytes(), (
            f"Stale {jar_key} inside browser/omni.ja; re-run scripts/build.sh"
        )

    for rel in EXPECTED_NATIVE_CONTENT:
        jar_key = f"chrome/dragon/content/{rel}"
        assert jar_key in jar, f"Missing {jar_key} inside browser/omni.ja"
        assert jar.read_entry(jar_key) == (NATIVE_DIR / "content" / rel).read_bytes(), (
            f"Stale {jar_key} inside browser/omni.ja; re-run scripts/build.sh"
        )

    chrome_manifest = jar.read_text("chrome/chrome.manifest")
    assert "content dragon dragon/content/ contentaccessible=yes" in chrome_manifest
    assert "resource dragon dragon/modules/ contentaccessible=yes" in chrome_manifest

    components_manifest = jar.read_text("components/components.manifest")
    assert (
        "category browser-before-ui-startup resource://dragon/DragonNativeInit.sys.mjs DragonNativeInit.init"
        in components_manifest
    )

    assert not any(
        k.startswith("chrome/browser/builtin-addons/dragon-core/") for k in jar.namelist()
    ), "Legacy builtin-addons/dragon-core entries must not remain in browser/omni.ja"


# ---------------------------------------------------------------------------
# 9. Compiled Windows PE32+ x86_64 executable validation
# ---------------------------------------------------------------------------
def test_dist_windows_exe_is_valid_pe32plus_x86_64() -> None:
    exe_path = DIST_DIR / "dragon-browser.exe"
    assert exe_path.is_file(), f"Compiled launcher not found at {exe_path}; run scripts/build.sh first"

    data = exe_path.read_bytes()
    assert len(data) > 0x100, "dragon-browser.exe is unexpectedly small"
    assert data[:2] == b"MZ", "Missing DOS 'MZ' signature"

    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    assert 0 < e_lfanew <= len(data) - 26, f"Invalid PE header offset e_lfanew={e_lfanew:#x}"
    assert data[e_lfanew : e_lfanew + 4] == b"PE\x00\x00", "Missing 'PE\\0\\0' signature"

    (machine,) = struct.unpack_from("<H", data, e_lfanew + 4)
    assert machine == 0x8664, f"Expected x86_64 machine (0x8664), got {machine:#06x}"

    (opt_magic,) = struct.unpack_from("<H", data, e_lfanew + 24)
    assert opt_magic == 0x20B, f"Expected PE32+ optional header magic (0x20B), got {opt_magic:#06x}"


# ---------------------------------------------------------------------------
# 10. dist/resources/ and setup scripts match launcher layout
# ---------------------------------------------------------------------------
def test_dist_resources_and_setup_scripts_layout() -> None:
    for rel in EXPECTED_RESOURCE_FILES:
        src = GECKO_DIR / rel
        dst = DIST_DIR / "resources" / rel
        assert src.is_file(), f"Missing source gecko file: {src}"
        assert dst.is_file(), f"Missing packaged dist/resources file: {dst}"
        assert dst.read_bytes() == src.read_bytes(), (
            f"dist/resources/{rel} is out of sync with gecko/{rel}; re-run scripts/build.sh"
        )

    for script_name in ("setup-runtime.ps1", "setup-runtime.sh"):
        src = REPO_ROOT / "scripts" / script_name
        dst = DIST_DIR / script_name
        assert dst.is_file(), f"Missing {script_name} in dist/"
        assert dst.read_bytes() == src.read_bytes(), (
            f"dist/{script_name} is out of sync with scripts/{script_name}"
        )
