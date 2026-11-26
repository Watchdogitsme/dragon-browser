#!/usr/bin/env python3
"""
Dragon Browser — Direct Gecko Engine Pack Compiler (`compile-engine-pack.py`).

Re-compiles a Gecko runtime directory (`dist/runtime/`) into a native
Dragon Browser Gecko Engine:
  1. Patches `runtime/omni.ja` via `MozJar`:
     - Transforms `modules/AppConstants.sys.mjs` (disables telemetry, data reporting,
       updater, crashreporter, normandy, maintenance service, update agent, signing
       enforcement, remote settings signature checks; sets Dragon app identity;
       scrubs any Google/Mozilla API keys).
     - Transforms `localization/en-US/toolkit/branding/brandings.ftl` to Dragon branding.
  2. Patches `runtime/browser/omni.ja` via `MozJar`:
     - Replaces `localization/en-US/branding/brand.ftl` and
       `chrome/en-US/locale/branding/brand.properties` (and `brand.dtd` if present).
     - Replaces `defaults/preferences/firefox-branding.js`.
     - Appends Dragon's compiled engine preferences (`gecko/user.js` converted from
       `user_pref(` to `pref(`) onto `defaults/preferences/firefox.js` idempotently
       guarded by `/* === DRAGON_ENGINE_COMPILED_PREFS === */`.
     - Replaces branding icons/logos inside `chrome/browser/content/branding/`.
     - Embeds `native/modules/` and `native/content/` inside `chrome/dragon/`,
       registers `content dragon` & `resource dragon` in `chrome/chrome.manifest`,
       and registers `DragonNativeInit.init` on `browser-before-ui-startup` in
       `components/components.manifest`.
  3. Rewrites `runtime/application.ini` (and `runtime/browser/application.ini`).
  4. Creates `runtime/dragon.exe` (copied from `runtime/firefox.exe` if needed) and
     strips signature/crashhelper bloat binaries (`firefox.exe.sig`, `crashhelper.exe`,
     `private_browsing.exe`, `xul.dll.sig`, `plugin-container.exe.sig`).
  5. Removes any legacy `dragon-core@dragonbrowser.local.xpi` remnants.
  6. Writes `runtime/dragon-engine.json` metadata stamp (`native_core: true`).
"""

from __future__ import annotations

import argparse
import configparser
from datetime import datetime, timezone
import json
import re
import shutil
import struct
import sys
import zlib
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from mozjar import MozJar  # noqa: E402

COMPILED_PREFS_MARKER = "/* === DRAGON_ENGINE_COMPILED_PREFS === */"
DRAGON_RECOMMENDATIONS_MARKER = "/* === DRAGON_OPTIONAL_BUILTINS_RECOMMENDATIONS === */"
BUILTIN_EXT_ID = "dragon-core@dragonbrowser.local"

NATIVE_CHROME_MANIFEST_LINES = (
    "content dragon dragon/content/ contentaccessible=yes",
    "resource dragon dragon/modules/ contentaccessible=yes",
)
NATIVE_COMPONENTS_MANIFEST_LINE = (
    "category browser-before-ui-startup resource://dragon/DragonNativeInit.sys.mjs DragonNativeInit.init"
)

DEFAULT_BRAND_FTL = """\
-brand-shorter-name = Dragon
-brand-short-name = Dragon Browser
-brand-shortcut-name = Dragon Browser
-brand-full-name = Dragon Browser
-brand-product-name = Dragon Browser
-vendor-short-name = Dragon
trademarkInfo = Dragon Browser is an independent Gecko-powered web browser.
"""

DEFAULT_BRAND_PROPERTIES = """\
brandShorterName=Dragon
brandShortName=Dragon Browser
brandFullName=Dragon Browser
vendorShortName=Dragon
"""

DEFAULT_BRAND_DTD = """\
<!ENTITY  brandShorterName      "Dragon">
<!ENTITY  brandShortName        "Dragon Browser">
<!ENTITY  brandFullName         "Dragon Browser">
<!ENTITY  vendorShortName       "Dragon">
<!ENTITY  trademarkInfo.part1   "Dragon Browser is an independent Gecko-powered web browser.">
"""

DEFAULT_FIREFOX_BRANDING_JS = """\
/* Dragon Browser — Compiled Branding Preferences */
pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");
pref("app.update.auto", false);
pref("app.update.enabled", false);
pref("app.update.url.manual", "");
pref("app.update.url.details", "");
pref("app.releaseNotesURL", "");
pref("app.releaseNotesURL.aboutDialog", "");
pref("app.releaseNotesURL.prompt", "");
pref("devtools.selfxss.count", 5);
"""

BRANDING_CONTENT_ASSETS = (
    "about-logo.svg",
    "about-wordmark.svg",
    "firefox-wordmark.svg",
    "aboutDialog.css",
    "icon16.png",
    "icon32.png",
    "icon48.png",
    "icon64.png",
    "icon128.png",
    "about-logo.png",
    "about-logo@2x.png",
    "about-logo-private.png",
    "about-logo-private@2x.png",
    "about.png",
    "document.ico",
)

STRIP_BINARIES = (
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
    "dependentlibs.list.gtest",
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
)

STRIP_DIRS = (
    "gmp-fake",
    "gmp-fakeopenh264",
    "uninstall",
    "desktop-launcher",
)

# Loose unpacked directories already packaged inside omni.ja / browser/omni.ja
STRIP_LOOSE_OMNI_DIRS = (
    "actors",
    "chrome",
    "components",
    "contentaccessible",
    "dictionaries",
    "hyphenation",
    "localization",
    "modules",
    "moz-src",
    "res",
    "defaults/autoconfig",
    "defaults/backgroundtasks",
    "browser/actors",
    "browser/chrome",
    "browser/components",
    "browser/defaults",
    "browser/localization",
    "browser/modules",
)

STRIP_LOOSE_OMNI_FILES = (
    "chrome.manifest",
    "greprefs.js",
    "default.locale",
    ".lldbinit",
    ".mkdir.done",
    "defaults/pref/PdfJsDefaultPrefs.js",
    "browser/chrome.manifest",
)

ROOT_BLOAT_COMPONENT_TOKENS = (
    "TelemetryStartup",
    "amGleanDaily",
    "nsUpdateService",
    "ModelHubProvider",
)

BROWSER_BLOAT_COMPONENT_TOKENS = (
    "Normandy.init",
    "Normandy.uninit",
    "AboutHomeStartupCache.init",
    "AccountsGlue.init",
    "LinkPreview.init",
    "IPProtectionActivator.init",
    "IPProtectionActivator.uninit",
    "CaptchaDetectionPingUtils.init",
    "GenAI.init",
    "SERPCategorization.init",
    "SERPCategorization.uninit",
    "SearchSERPTelemetry.uninit",
    "ContentRelevancyManager.init",
    "UpdateListener.",
    "UpdatePolicyEnforcer.",
    "DefaultWindowsLaunchOnLogin.",
    "StartupTelemetry.",
    "BrowserUsageTelemetry.uninit",
    "AIWindow.",
)

DRAGON_RECOMMENDATIONS_SNIPPET = f"""
{DRAGON_RECOMMENDATIONS_MARKER}
(function patchDragonRecommendedOptionalBuiltins() {{
  if (typeof RecommendedExtensionsSection === "undefined") {{
    return;
  }}
  const proto = RecommendedExtensionsSection.prototype;
  if (proto.__dragonPatched) {{
    return;
  }}
  proto.__dragonPatched = true;
  const origRender = proto.render;
  proto.render = async function dragonRender() {{
    if (typeof origRender === "function") {{
      await origRender.apply(this, arguments);
    }}
    try {{
      const {{ DragonCoreService }} = ChromeUtils.importESModule(
        "resource://dragon/DragonCoreService.sys.mjs"
      );
      if (!DragonCoreService || typeof DragonCoreService.getOptionalBuiltins !== "function") {{
        return;
      }}
      let host = this.querySelector("#dragon-optional-builtins-card");
      if (!host) {{
        host = document.createElement("section");
        host.id = "dragon-optional-builtins-card";
        host.style.margin = "16px 0";
        host.style.padding = "14px 16px";
        host.style.borderRadius = "10px";
        host.style.border = "1px solid var(--in-content-box-border-color, rgba(128,128,128,0.28))";
        host.style.background = "var(--in-content-box-background, rgba(128,128,128,0.08))";
        this.prepend(host);
      }}
      const renderItems = async () => {{
        const items = await DragonCoreService.getOptionalBuiltins();
        host.replaceChildren();
        const heading = document.createElement("h3");
        heading.textContent = "Dragon Recommended Optional Extensions";
        heading.style.margin = "0 0 4px 0";
        heading.style.fontSize = "1.05em";
        host.appendChild(heading);

        const note = document.createElement("p");
        note.textContent =
          "Disabled at startup to eliminate the background extension process and save RAM. Install only what you need.";
        note.style.margin = "0 0 12px 0";
        note.style.opacity = "0.78";
        note.style.fontSize = "0.9em";
        host.appendChild(note);

        for (const item of items) {{
          const row = document.createElement("div");
          row.style.display = "flex";
          row.style.alignItems = "center";
          row.style.justifyContent = "space-between";
          row.style.gap = "12px";
          row.style.padding = "8px 0";
          row.style.borderTop = "1px solid rgba(128,128,128,0.18)";

          const left = document.createElement("div");
          const title = document.createElement("div");
          title.textContent = `${{item.name}} (${{item.category}})`;
          title.style.fontWeight = "600";
          const desc = document.createElement("div");
          desc.textContent = item.description;
          desc.style.fontSize = "0.88em";
          desc.style.opacity = "0.78";
          left.appendChild(title);
          left.appendChild(desc);

          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = item.installed ? "Remove" : "Install";
          btn.className = item.installed ? "" : "primary";
          btn.addEventListener("click", async () => {{
            btn.disabled = true;
            try {{
              if (item.installed) {{
                await DragonCoreService.removeOptionalBuiltin(item.id);
              }} else {{
                await DragonCoreService.installOptionalBuiltin(item.id);
              }}
            }} finally {{
              await renderItems();
            }}
          }});

          row.appendChild(left);
          row.appendChild(btn);
          host.appendChild(row);
        }}
      }};
      await renderItems();
    }} catch (_err) {{
      // DragonCoreService unavailable in isolated test contexts
    }}
  }};
}})();
"""


def transform_app_constants(text: str) -> str:
    """Transform `modules/AppConstants.sys.mjs` inside `omni.ja` or source tree."""
    bool_overrides: Dict[str, str] = {
        "MOZ_DATA_REPORTING": "false",
        "MOZ_TELEMETRY_REPORTING": "false",
        "MOZ_UPDATER": "false",
        "MOZ_CRASHREPORTER": "false",
        "MOZ_NORMANDY": "false",
        "MOZ_MAINTENANCE_SERVICE": "false",
        "MOZ_UPDATE_AGENT": "false",
        "MOZ_REQUIRE_SIGNING": "false",
        "MOZ_UNSIGNED_APP_SCOPE": "true",
        "MOZ_UNSIGNED_SYSTEM_SCOPE": "true",
        "REMOTE_SETTINGS_VERIFY_SIGNATURE": "false",
    }

    for key, val in bool_overrides.items():
        ifdef_pattern = re.compile(
            rf"(\b{re.escape(key)}\s*:\s*)\r?\n\s*#if[^\n]*\r?\n[\s\S]*?#endif\b[^\n]*",
            re.MULTILINE,
        )
        text = ifdef_pattern.sub(rf"{key}: {val},", text)

        pattern = re.compile(
            rf"(\b{re.escape(key)}\s*:\s*)(?://@line[^\n]*\r?\n\s*)?(?:true|false|@[A-Z0-9_]+@)",
            re.MULTILINE,
        )
        text = pattern.sub(rf"{key}: {val}", text)

    str_overrides: Dict[str, str] = {
        "MOZ_APP_NAME": "dragon",
        "MOZ_APP_BASENAME": "Dragon",
        "MOZ_APP_DISPLAYNAME_DO_NOT_USE": "Dragon Browser",
        "MOZ_GOOGLE_SAFEBROWSING_API_KEY": "no-safebrowsing-api-key",
        "MOZ_MOZILLA_API_KEY": "no-mozilla-api-key",
    }

    for key, val in str_overrides.items():
        ifdef_str_pattern = re.compile(
            rf"(\b{re.escape(key)}\s*:\s*)\r?\n\s*#if[^\n]*\r?\n[\s\S]*?#endif\b[^\n]*",
            re.MULTILINE,
        )
        text = ifdef_str_pattern.sub(f'{key}: "{val}",', text)

        pattern = re.compile(
            rf'(\b{re.escape(key)}\s*:\s*)(?://@line[^\n]*\r?\n\s*)?"[^"]*"',
            re.MULTILINE,
        )
        text = pattern.sub(f'{key}: "{val}"', text)

    return text


def transform_toolkit_brandings_ftl(text: str) -> str:
    """Transform `localization/en-US/toolkit/branding/brandings.ftl`."""
    replacements = {
        "-firefox-home-brand-name": "Dragon Home",
        "-firefoxview-brand-name": "Dragon View",
        "-firefoxlabs-brand-name": "Dragon Labs",
        "-firefox-suggest-brand-name": "Dragon Suggest",
        "-profiler-brand-name": "Dragon Profiler",
        "-screenshots-brand-name": "Dragon Screenshots",
        "-translations-brand-name": "Dragon Translations",
    }
    for term, replacement in replacements.items():
        pattern = re.compile(rf"^(\s*{re.escape(term)}\s*=\s*).*$", re.MULTILINE)
        if pattern.search(text):
            text = pattern.sub(rf"\g<1>{replacement}", text)
        else:
            if not text.endswith("\n"):
                text += "\n"
            text += f"{term} = {replacement}\n"
    return text


def convert_user_js_to_default_prefs(user_js_text: str) -> str:
    """Convert `user_pref("...", ...);` lines from `gecko/user.js` into `pref("...", ...);`."""
    converted_lines = [COMPILED_PREFS_MARKER]
    for line in user_js_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("user_pref("):
            converted_lines.append(re.sub(r"^\s*user_pref\s*\(", "pref(", line))
        else:
            converted_lines.append(line)
    return "\n".join(converted_lines) + "\n"


def append_compiled_prefs_idempotent(firefox_js_text: str, user_js_text: str) -> str:
    """Append Dragon's compiled preferences onto `firefox.js` idempotently."""
    compiled_block = convert_user_js_to_default_prefs(user_js_text)
    if COMPILED_PREFS_MARKER in firefox_js_text:
        idx = firefox_js_text.index(COMPILED_PREFS_MARKER)
        base = firefox_js_text[:idx].rstrip()
    else:
        base = firefox_js_text.rstrip()
    return f"{base}\n\n{compiled_block}"


def rewrite_application_ini(ini_text: str) -> str:
    """Update `application.ini` with Dragon vendor, app name, remoting name, and disabled crashreporter."""
    ini_text = re.sub(r"(?m)^Vendor=.*$", "Vendor=Dragon", ini_text)
    ini_text = re.sub(r"(?m)^Name=.*$", "Name=Dragon Browser", ini_text)
    ini_text = re.sub(r"(?m)^RemotingName=.*$", "RemotingName=dragon-browser", ini_text)
    def _fix_crash_section(match: "re.Match[str]") -> str:
        return re.sub(r"(?m)^Enabled=\d+", "Enabled=0", match.group(0))

    if "[Crash Reporter]" in ini_text:
        ini_text = re.sub(r"\[Crash Reporter\][^\[]*", _fix_crash_section, ini_text)
        section = re.search(r"\[Crash Reporter\][^\[]*", ini_text)
        if section and "Enabled=0" not in section.group(0):
            ini_text = ini_text.replace("[Crash Reporter]", "[Crash Reporter]\nEnabled=0", 1)
    else:
        ini_text = ini_text.rstrip("\n") + "\n\n[Crash Reporter]\nEnabled=0\n"
    return ini_text


def strip_builtin_addons_manifest(json_text: str) -> str:
    """Clear auto-installed Mozilla builtins from `built_in_addons.json` while keeping dictionaries."""
    data = json.loads(json_text)
    if isinstance(data, dict):
        data["builtins"] = []
    return json.dumps(data)


def patch_recommended_extensions_section(text: str) -> str:
    """Inject Dragon's Recommended Optional Extensions block idempotently."""
    if DRAGON_RECOMMENDATIONS_MARKER in text:
        base = text[: text.index(DRAGON_RECOMMENDATIONS_MARKER)].rstrip()
    else:
        base = text.rstrip()
    return f"{base}\n\n{DRAGON_RECOMMENDATIONS_SNIPPET.lstrip()}"


def prune_bloat_component_entries(manifest_text: str, forbidden_tokens: Iterable[str]) -> str:
    """Remove startup category entries for stripped telemetry/AI/update subsystems."""
    tokens = tuple(forbidden_tokens)
    kept = []
    for line in manifest_text.splitlines():
        stripped = line.strip()
        if stripped and any(tok in stripped for tok in tokens):
            continue
        kept.append(line.rstrip("\r\n"))
    if not kept:
        return ""
    return "\n".join(kept) + "\n"


def _append_manifest_lines_idempotent(manifest_text: str, lines: Iterable[str]) -> str:
    """Append chrome/components manifest directives without duplicating existing lines."""
    existing_lines = [line.rstrip("\r\n") for line in manifest_text.splitlines()]
    existing_normalized = {line.strip() for line in existing_lines if line.strip()}
    for raw_line in lines:
        line = raw_line.strip()
        if line and line not in existing_normalized:
            existing_lines.append(line)
            existing_normalized.add(line)
    if not existing_lines:
        return ""
    return "\n".join(existing_lines) + "\n"


def _parse_ini_values(ini_path: Path) -> Dict[str, str]:
    """Read key/value pairs from an INI file (`application.ini` / `platform.ini`)."""
    if not ini_path.is_file():
        return {}
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str  # preserve case
    try:
        parser.read(ini_path, encoding="utf-8")
    except (configparser.Error, OSError):
        return {}
    result: Dict[str, str] = {}
    for section in parser.sections():
        for key, val in parser.items(section):
            result[f"{section}.{key}"] = val.strip()
            result.setdefault(key, val.strip())
    return result


def detect_runtime_metadata(
    runtime_dir: Path,
    root_app_constants: Optional[str] = None,
    channel_hint: Optional[str] = None,
) -> Dict[str, str]:
    """Detect Gecko version, channel (`esr` or `release`), build ID, and source stamp."""
    app_ini = _parse_ini_values(runtime_dir / "browser" / "application.ini")
    if not app_ini:
        app_ini = _parse_ini_values(runtime_dir / "application.ini")
    plat_ini = _parse_ini_values(runtime_dir / "platform.ini")

    version = app_ini.get("App.Version") or plat_ini.get("Build.Milestone") or ""
    build_id = app_ini.get("App.BuildID") or plat_ini.get("Build.BuildID") or ""
    source_stamp = app_ini.get("App.SourceStamp") or plat_ini.get("Build.SourceStamp") or ""

    is_esr: Optional[bool] = None
    display_version = ""
    update_channel = ""
    if root_app_constants:
        if not version:
            m_ver = re.search(r'\bMOZ_APP_VERSION\s*:\s*"([^"]+)"', root_app_constants)
            if m_ver:
                version = m_ver.group(1)
        m_disp = re.search(r'\bMOZ_APP_VERSION_DISPLAY\s*:\s*"([^"]+)"', root_app_constants)
        if m_disp:
            display_version = m_disp.group(1)
        m_esr = re.search(r"\bIS_ESR\s*:\s*(true|false)\b", root_app_constants)
        if m_esr:
            is_esr = m_esr.group(1) == "true"
        m_chan = re.search(r'\bMOZ_UPDATE_CHANNEL\s*:\s*"([^"]+)"', root_app_constants)
        if m_chan:
            update_channel = m_chan.group(1).lower()

    if not version:
        version = "unknown"

    normalized_hint = channel_hint.lower().strip() if channel_hint else None
    if normalized_hint in ("esr", "release"):
        channel = normalized_hint
    elif is_esr is True or "esr" in display_version.lower() or "esr" in update_channel:
        channel = "esr"
    elif is_esr is False:
        channel = "release"
    else:
        channel = "esr"

    if not display_version:
        if channel == "esr" and version != "unknown" and not version.lower().endswith("esr"):
            display_version = f"{version}esr"
        else:
            display_version = version

    engine_name = "Dragon Gecko ESR" if channel == "esr" else "Dragon Gecko Release"
    return {
        "engine": engine_name,
        "channel": channel,
        "version": version,
        "display_version": display_version,
        "build_id": build_id,
        "source_stamp": source_stamp,
    }


def _is_valid_pe32_plus_x64(exe_path: Path) -> bool:
    """Return True if `exe_path` has valid MZ + PE32+ x86_64 headers."""
    try:
        data = exe_path.read_bytes()
    except OSError:
        return False
    if len(data) < 0x100 or data[:2] != b"MZ":
        return False
    (e_lfanew,) = struct.unpack_from("<I", data, 0x3C)
    if e_lfanew <= 0 or e_lfanew > len(data) - 26:
        return False
    if data[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        return False
    (machine,) = struct.unpack_from("<H", data, e_lfanew + 4)
    (opt_magic,) = struct.unpack_from("<H", data, e_lfanew + 24)
    return machine == 0x8664 and opt_magic == 0x20B


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


def verify_compiled_runtime(
    runtime_dir: Path,
    native_dir: Optional[Path] = None,
    require_native_dlls: bool = True,
    require_signed_binaries: bool = False,
) -> Tuple[List[str], List[str]]:
    """Verify compiled Dragon runtime integrity and upstream Gecko hooks.

    Returns `(errors, warnings)`. Any non-empty `errors` list indicates an invalid runtime.
    """
    runtime_dir = runtime_dir.resolve()
    native_dir = (native_dir or (REPO_ROOT / "native")).resolve()
    errors: List[str] = []
    warnings: List[str] = []

    dragon_exe = runtime_dir / "dragon.exe"
    if not dragon_exe.is_file():
        errors.append(f"Missing runtime binary: {dragon_exe}")
    elif not _is_valid_pe32_plus_x64(dragon_exe):
        errors.append(f"Invalid PE32+ x86_64 executable: {dragon_exe}")

    if require_native_dlls:
        for dll_name in ("xul.dll", "mozglue.dll"):
            if not (runtime_dir / dll_name).is_file():
                errors.append(f"Missing required runtime library: {runtime_dir / dll_name}")

    if require_signed_binaries:
        for bin_name in ("dragon.exe", "xul.dll", "mozglue.dll", "plugin-container.exe"):
            bin_path = runtime_dir / bin_name
            if bin_name == "plugin-container.exe" and not bin_path.is_file():
                continue
            if not bin_path.is_file():
                errors.append(f"Missing binary for signature check: {bin_name}")
            elif not has_pe_authenticode_signature(bin_path):
                errors.append(
                    f"Unsigned runtime binary (Smart App Control incompatible): {bin_name}"
                )

    for bloat_rel in STRIP_BINARIES:
        if (runtime_dir / bloat_rel).is_file():
            errors.append(f"Unstripped bloat binary present: {bloat_rel}")

    stamp_path = runtime_dir / "dragon-engine.json"
    if not stamp_path.is_file():
        errors.append(f"Missing engine metadata stamp: {stamp_path}")
    else:
        try:
            stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
            if stamp.get("compiled_omni") is not True:
                errors.append("dragon-engine.json missing compiled_omni=true")
            if stamp.get("native_core") is not True:
                errors.append("dragon-engine.json missing native_core=true")
            if stamp.get("binary") != "dragon.exe":
                errors.append("dragon-engine.json binary must be 'dragon.exe'")
            if not stamp.get("version"):
                errors.append("dragon-engine.json missing version")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"Invalid dragon-engine.json: {exc}")

    root_omni_path = runtime_dir / "omni.ja"
    if not root_omni_path.is_file():
        errors.append(f"Missing root omni.ja: {root_omni_path}")
    else:
        try:
            root_jar = MozJar.load(root_omni_path)
            if "modules/AppConstants.sys.mjs" not in root_jar:
                errors.append("omni.ja missing modules/AppConstants.sys.mjs")
            else:
                ac_entry = root_jar.get_entry("modules/AppConstants.sys.mjs")
                ac_bytes = ac_entry.read()
                if (zlib.crc32(ac_bytes) & 0xFFFFFFFF) != ac_entry.crc:
                    errors.append("CRC32 mismatch for modules/AppConstants.sys.mjs in omni.ja")
                ac_text = ac_bytes.decode("utf-8", errors="replace")
                for token in (
                    "MOZ_TELEMETRY_REPORTING: false",
                    "MOZ_DATA_REPORTING: false",
                    "MOZ_CRASHREPORTER: false",
                    "MOZ_REQUIRE_SIGNING: false",
                    'MOZ_APP_NAME: "dragon"',
                    'MOZ_APP_BASENAME: "Dragon"',
                ):
                    if token not in ac_text:
                        errors.append(f"AppConstants.sys.mjs missing `{token}`")
                if "AIza" in ac_text:
                    errors.append("AppConstants.sys.mjs still contains Google API key prefix")

            for hook in (
                "modules/NetUtil.sys.mjs",
                "modules/Timer.sys.mjs",
                "modules/AddonManager.sys.mjs",
            ):
                if hook not in root_jar:
                    warnings.append(f"Upstream Gecko module missing in omni.ja: {hook}")
        except Exception as exc:
            errors.append(f"Failed to inspect omni.ja: {exc}")

    browser_omni_path = runtime_dir / "browser" / "omni.ja"
    if not browser_omni_path.is_file():
        errors.append(f"Missing browser/omni.ja: {browser_omni_path}")
    else:
        try:
            browser_jar = MozJar.load(browser_omni_path)
            if "localization/en-US/branding/brand.ftl" not in browser_jar:
                errors.append("browser/omni.ja missing localization/en-US/branding/brand.ftl")
            else:
                bftl = browser_jar.read_text("localization/en-US/branding/brand.ftl")
                if "Dragon Browser" not in bftl:
                    errors.append("brand.ftl does not contain 'Dragon Browser'")

            if "defaults/preferences/firefox.js" not in browser_jar:
                errors.append("browser/omni.ja missing defaults/preferences/firefox.js")
            else:
                ffjs = browser_jar.read_text("defaults/preferences/firefox.js")
                if COMPILED_PREFS_MARKER not in ffjs:
                    errors.append("firefox.js missing DRAGON_ENGINE_COMPILED_PREFS marker")

            chrome_manifest = (
                browser_jar.read_text("chrome/chrome.manifest")
                if "chrome/chrome.manifest" in browser_jar
                else ""
            )
            for line in NATIVE_CHROME_MANIFEST_LINES:
                if line not in chrome_manifest:
                    errors.append(f"chrome.manifest missing `{line}`")

            comp_manifest = (
                browser_jar.read_text("components/components.manifest")
                if "components/components.manifest" in browser_jar
                else ""
            )
            if NATIVE_COMPONENTS_MANIFEST_LINE not in comp_manifest:
                errors.append("components.manifest missing DragonNativeInit startup registration")

            native_modules_dir = native_dir / "modules"
            native_content_dir = native_dir / "content"
            if native_modules_dir.is_dir():
                for fp in sorted(native_modules_dir.rglob("*")):
                    if not fp.is_file() or fp.name == ".DS_Store" or "__pycache__" in fp.parts or fp.suffix == ".pyc":
                        continue
                    rel = fp.relative_to(native_modules_dir).as_posix()
                    key = f"chrome/dragon/modules/{rel}"
                    if key not in browser_jar:
                        errors.append(f"Missing embedded native module: {key}")
                    elif browser_jar.read_entry(key) != fp.read_bytes():
                        errors.append(f"Stale embedded native module: {key}")

            if native_content_dir.is_dir():
                for fp in sorted(native_content_dir.rglob("*")):
                    if not fp.is_file() or fp.name == ".DS_Store":
                        continue
                    rel = fp.relative_to(native_content_dir).as_posix()
                    key = f"chrome/dragon/content/{rel}"
                    if key not in browser_jar:
                        errors.append(f"Missing embedded native content: {key}")
                    elif browser_jar.read_entry(key) != fp.read_bytes():
                        errors.append(f"Stale embedded native content: {key}")

            for hook in (
                "chrome/browser/content/browser/browser.xhtml",
                "modules/AboutNewTab.sys.mjs",
                "modules/BrowserWindowTracker.sys.mjs",
            ):
                if hook not in browser_jar:
                    warnings.append(f"Upstream Gecko hook missing in browser/omni.ja: {hook}")
        except Exception as exc:
            errors.append(f"Failed to inspect browser/omni.ja: {exc}")

    return errors, warnings


def compile_engine_pack(
    runtime_dir: Path,
    xpi_path: Optional[Path] = None,
    branding_dir: Optional[Path] = None,
    user_js_path: Optional[Path] = None,
    native_dir: Optional[Path] = None,
    channel_hint: Optional[str] = None,
    refresh_binary: bool = False,
) -> Dict[str, object]:
    """Compile a Gecko runtime folder into the 100% Native Dragon Browser Gecko Engine."""
    del xpi_path  # Legacy XPI argument ignored; Dragon Core is now embedded in omni.ja
    runtime_dir = runtime_dir.resolve()
    if not runtime_dir.is_dir():
        raise FileNotFoundError(f"Runtime directory does not exist: {runtime_dir}")

    branding_dir = (branding_dir or (REPO_ROOT / "engine" / "branding" / "dragon")).resolve()
    user_js_path = (user_js_path or (REPO_ROOT / "gecko" / "user.js")).resolve()
    native_dir = (native_dir or (REPO_ROOT / "native")).resolve()

    native_modules_dir = native_dir / "modules"
    native_content_dir = native_dir / "content"
    if not native_modules_dir.is_dir():
        raise FileNotFoundError(f"Native modules directory not found at {native_modules_dir}")
    if not native_content_dir.is_dir():
        raise FileNotFoundError(f"Native content directory not found at {native_content_dir}")

    # 1. Patch root runtime/omni.ja
    root_omni_path = runtime_dir / "omni.ja"
    if not root_omni_path.is_file():
        raise FileNotFoundError(f"Root omni.ja not found at {root_omni_path}")

    root_jar = MozJar.load(root_omni_path)
    original_app_constants: Optional[str] = None
    if "modules/AppConstants.sys.mjs" in root_jar:
        original_app_constants = root_jar.read_text("modules/AppConstants.sys.mjs")
        patched_app_constants = transform_app_constants(original_app_constants)
        root_jar.set_entry("modules/AppConstants.sys.mjs", patched_app_constants, compress=False)

    detected_meta = detect_runtime_metadata(
        runtime_dir,
        root_app_constants=original_app_constants,
        channel_hint=channel_hint,
    )

    brandings_key = "localization/en-US/toolkit/branding/brandings.ftl"
    if brandings_key in root_jar:
        brandings_ftl = root_jar.read_text(brandings_key)
        root_jar.set_entry(brandings_key, transform_toolkit_brandings_ftl(brandings_ftl), compress=False)

    rec_section_key = "chrome/toolkit/content/mozapps/extensions/components/recommended-extensions-section.mjs"
    if rec_section_key in root_jar:
        rec_text = root_jar.read_text(rec_section_key)
        root_jar.set_entry(
            rec_section_key,
            patch_recommended_extensions_section(rec_text),
            compress=False,
        )

    root_components_key = "components/components.manifest"
    if root_components_key in root_jar:
        root_comp = root_jar.read_text(root_components_key)
        root_jar.set_entry(
            root_components_key,
            prune_bloat_component_entries(root_comp, ROOT_BLOAT_COMPONENT_TOKENS),
            compress=False,
        )

    root_jar.save(root_omni_path, optimize=True)

    # 2. Patch runtime/browser/omni.ja
    browser_omni_path = runtime_dir / "browser" / "omni.ja"
    if not browser_omni_path.is_file():
        raise FileNotFoundError(f"Browser omni.ja not found at {browser_omni_path}")

    browser_jar = MozJar.load(browser_omni_path)

    brand_ftl_file = branding_dir / "locales" / "en-US" / "brand.ftl"
    brand_ftl_data = brand_ftl_file.read_text(encoding="utf-8") if brand_ftl_file.is_file() else DEFAULT_BRAND_FTL
    browser_jar.set_entry("localization/en-US/branding/brand.ftl", brand_ftl_data, compress=False)

    brand_props_file = branding_dir / "locales" / "en-US" / "brand.properties"
    brand_props_data = (
        brand_props_file.read_text(encoding="utf-8") if brand_props_file.is_file() else DEFAULT_BRAND_PROPERTIES
    )
    browser_jar.set_entry("chrome/en-US/locale/branding/brand.properties", brand_props_data, compress=False)

    brand_dtd_file = branding_dir / "locales" / "en-US" / "brand.dtd"
    if "chrome/en-US/locale/branding/brand.dtd" in browser_jar or brand_dtd_file.is_file():
        brand_dtd_data = brand_dtd_file.read_text(encoding="utf-8") if brand_dtd_file.is_file() else DEFAULT_BRAND_DTD
        browser_jar.set_entry("chrome/en-US/locale/branding/brand.dtd", brand_dtd_data, compress=False)

    ff_branding_file = branding_dir / "pref" / "firefox-branding.js"
    ff_branding_data = (
        ff_branding_file.read_text(encoding="utf-8") if ff_branding_file.is_file() else DEFAULT_FIREFOX_BRANDING_JS
    )
    browser_jar.set_entry("defaults/preferences/firefox-branding.js", ff_branding_data, compress=False)

    user_js_text = user_js_path.read_text(encoding="utf-8") if user_js_path.is_file() else ""
    firefox_js_key = "defaults/preferences/firefox.js"
    existing_firefox_js = browser_jar.read_text(firefox_js_key) if firefox_js_key in browser_jar else ""
    patched_firefox_js = append_compiled_prefs_idempotent(existing_firefox_js, user_js_text)
    browser_jar.set_entry(firefox_js_key, patched_firefox_js, compress=False)

    content_dir = branding_dir / "content"
    if content_dir.is_dir():
        for asset_name in BRANDING_CONTENT_ASSETS:
            asset_path = content_dir / asset_name
            if asset_path.is_file():
                browser_jar.set_entry(
                    f"chrome/browser/content/branding/{asset_name}",
                    asset_path.read_bytes(),
                    compress=False,
                )

    # Remove stale built-in add-on entries inside browser/omni.ja if present
    for key in list(browser_jar.namelist()):
        if key.startswith("chrome/browser/builtin-addons/dragon-core/") or key.startswith("chrome/dragon/"):
            browser_jar.remove_entry(key)

    # Embed 100% Native Dragon Core modules & content into chrome/dragon/
    for file_path in sorted(native_modules_dir.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.name == ".DS_Store" or "__pycache__" in file_path.parts or file_path.suffix == ".pyc":
            continue
        rel = file_path.relative_to(native_modules_dir).as_posix()
        browser_jar.set_entry(f"chrome/dragon/modules/{rel}", file_path.read_bytes(), compress=False)

    for file_path in sorted(native_content_dir.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.name == ".DS_Store":
            continue
        rel = file_path.relative_to(native_content_dir).as_posix()
        browser_jar.set_entry(f"chrome/dragon/content/{rel}", file_path.read_bytes(), compress=False)

    chrome_manifest_key = "chrome/chrome.manifest"
    existing_chrome_manifest = (
        browser_jar.read_text(chrome_manifest_key) if chrome_manifest_key in browser_jar else ""
    )
    browser_jar.set_entry(
        chrome_manifest_key,
        _append_manifest_lines_idempotent(existing_chrome_manifest, NATIVE_CHROME_MANIFEST_LINES),
        compress=False,
    )

    components_manifest_key = "components/components.manifest"
    existing_components_manifest = (
        browser_jar.read_text(components_manifest_key)
        if components_manifest_key in browser_jar
        else ""
    )
    pruned_components_manifest = prune_bloat_component_entries(
        existing_components_manifest, BROWSER_BLOAT_COMPONENT_TOKENS
    )
    browser_jar.set_entry(
        components_manifest_key,
        _append_manifest_lines_idempotent(
            pruned_components_manifest, (NATIVE_COMPONENTS_MANIFEST_LINE,)
        ),
        compress=False,
    )

    builtin_addons_key = "chrome/browser/content/browser/built_in_addons.json"
    if builtin_addons_key in browser_jar:
        builtin_raw = browser_jar.read_text(builtin_addons_key)
        browser_jar.set_entry(
            builtin_addons_key,
            strip_builtin_addons_manifest(builtin_raw),
            compress=False,
        )

    browser_jar.save(browser_omni_path, optimize=True)

    # 3. Rewrite application.ini (and browser/application.ini)
    app_ini_path = runtime_dir / "application.ini"
    browser_app_ini_path = runtime_dir / "browser" / "application.ini"
    if app_ini_path.is_file():
        patched_ini = rewrite_application_ini(app_ini_path.read_text(encoding="utf-8"))
        app_ini_path.write_text(patched_ini, encoding="utf-8")
        if (runtime_dir / "browser").is_dir():
            browser_app_ini_path.write_text(patched_ini, encoding="utf-8")
    elif browser_app_ini_path.is_file():
        patched_ini = rewrite_application_ini(browser_app_ini_path.read_text(encoding="utf-8"))
        browser_app_ini_path.write_text(patched_ini, encoding="utf-8")

    # 4. Create/refresh runtime/dragon.exe (and drop redundant firefox.exe once dragon.exe is verified)
    dragon_exe = runtime_dir / "dragon.exe"
    firefox_exe = runtime_dir / "firefox.exe"
    if firefox_exe.is_file():
        should_copy = (
            not dragon_exe.is_file()
            or refresh_binary
            or (firefox_exe.stat().st_mtime > dragon_exe.stat().st_mtime)
        )
        if should_copy:
            shutil.copy2(firefox_exe, dragon_exe)
    if dragon_exe.is_file() and dragon_exe.stat().st_size > 100_000 and firefox_exe.is_file():
        try:
            firefox_exe.unlink()
        except OSError:
            pass

    for bloat_rel in STRIP_BINARIES:
        bloat_path = runtime_dir / bloat_rel
        if bloat_path.is_file():
            try:
                bloat_path.unlink()
            except OSError:
                pass

    for bloat_dir_rel in STRIP_DIRS:
        bloat_dir = runtime_dir / bloat_dir_rel
        if bloat_dir.is_dir():
            shutil.rmtree(bloat_dir, ignore_errors=True)

    # Strip empty browser/features/ directory if present
    features_dir = runtime_dir / "browser" / "features"
    if features_dir.is_dir() and not any(features_dir.iterdir()):
        shutil.rmtree(features_dir, ignore_errors=True)

    # Prune loose unpacked duplicate directories/files only when both compiled omni.ja archives are intact
    if (
        root_omni_path.is_file()
        and root_omni_path.stat().st_size > 1_000_000
        and browser_omni_path.is_file()
        and browser_omni_path.stat().st_size > 1_000_000
    ):
        for loose_dir_rel in STRIP_LOOSE_OMNI_DIRS:
            loose_dir = runtime_dir / loose_dir_rel
            if loose_dir.is_dir():
                shutil.rmtree(loose_dir, ignore_errors=True)
        for loose_file_rel in STRIP_LOOSE_OMNI_FILES:
            loose_file = runtime_dir / loose_file_rel
            if loose_file.is_file():
                try:
                    loose_file.unlink()
                except OSError:
                    pass
        # Clean empty defaults/ directories while preserving defaults/pref/{autoconfig.js,channel-prefs.js}
        defaults_dir = runtime_dir / "defaults"
        if defaults_dir.is_dir():
            for child in list(defaults_dir.iterdir()):
                if child.is_dir() and not any(child.iterdir()):
                    shutil.rmtree(child, ignore_errors=True)

    # 5. Remove legacy dragon-core XPI / builtin-addons remnants if present
    for legacy_path in (
        runtime_dir / "browser" / "features" / f"{BUILTIN_EXT_ID}.xpi",
        runtime_dir / "distribution" / "extensions" / f"{BUILTIN_EXT_ID}.xpi",
    ):
        if legacy_path.is_file():
            try:
                legacy_path.unlink()
            except OSError:
                pass

    legacy_builtin_dir = runtime_dir / "browser" / "chrome" / "browser" / "builtin-addons" / "dragon-core"
    if legacy_builtin_dir.is_dir():
        shutil.rmtree(legacy_builtin_dir, ignore_errors=True)

    # 6. Write runtime/dragon-engine.json metadata stamp
    metadata = {
        "engine": detected_meta["engine"],
        "channel": detected_meta["channel"],
        "version": detected_meta["version"],
        "display_version": detected_meta["display_version"],
        "build_id": detected_meta["build_id"],
        "source_stamp": detected_meta["source_stamp"],
        "compiled_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "compiled_omni": True,
        "native_core": True,
        "binary": "dragon.exe",
        "low_ram_profile": "balanced_isolate_high_value",
        "stripped_builtin_addons": True,
    }
    stamp_path = runtime_dir / "dragon-engine.json"
    stamp_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    return metadata


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compile Gecko runtime into Dragon Browser Gecko Engine")
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        default=REPO_ROOT / "dist" / "runtime",
        help="Path to Gecko runtime directory (default: dist/runtime)",
    )
    parser.add_argument(
        "--native-dir",
        type=Path,
        default=REPO_ROOT / "native",
        help="Path to Dragon Native Core modules/content directory (default: native)",
    )
    parser.add_argument(
        "--xpi",
        type=Path,
        default=None,
        help="Deprecated no-op; Dragon Core is now embedded natively in browser/omni.ja",
    )
    parser.add_argument(
        "--branding-dir",
        type=Path,
        default=REPO_ROOT / "engine" / "branding" / "dragon",
        help="Path to Dragon branding directory (default: engine/branding/dragon)",
    )
    parser.add_argument(
        "--user-js",
        type=Path,
        default=REPO_ROOT / "gecko" / "user.js",
        help="Path to Dragon gecko/user.js preferences file",
    )
    parser.add_argument(
        "--channel",
        choices=("esr", "release"),
        default=None,
        help="Optional Gecko channel hint ('esr' or 'release')",
    )
    parser.add_argument(
        "--refresh-binary",
        action="store_true",
        help="Force overwrite runtime/dragon.exe from runtime/firefox.exe if present",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify compiled runtime integrity after compiling",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Only verify an already-compiled runtime without modifying it",
    )
    parser.add_argument(
        "--require-signed-runtime",
        action="store_true",
        help="Fail verification if core runtime PE binaries lack Authenticode signatures",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if not args.verify_only:
        meta = compile_engine_pack(
            runtime_dir=args.runtime_dir,
            xpi_path=args.xpi,
            branding_dir=args.branding_dir,
            user_js_path=args.user_js,
            native_dir=args.native_dir,
            channel_hint=args.channel,
            refresh_binary=args.refresh_binary,
        )
        print(
            f"[OK] Compiled {meta['engine']} {meta['display_version']} -> {args.runtime_dir} "
            f"(binary={meta['binary']}, native_core={meta['native_core']})"
        )

    if args.verify or args.verify_only:
        errors, warnings = verify_compiled_runtime(
            args.runtime_dir,
            native_dir=args.native_dir,
            require_signed_binaries=args.require_signed_runtime,
        )
        for w in warnings:
            print(f"[WARN] {w}", file=sys.stderr)
        if errors:
            for err in errors:
                print(f"[FAIL] {err}", file=sys.stderr)
            return 1
        print(f"[OK] Verified compiled Dragon Gecko runtime at {args.runtime_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
