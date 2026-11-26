#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

export PATH="${HOME}/.cargo/bin:${PATH}"

CHANNEL="esr"
VERSION=""
CHECK_ONLY=0
FORCE=0
FROM_SOURCE=0
SKIP_UPGRADE=0
ALSO_ZIP=0
REUSE_BINARIES=0
OUTPUT_DIR="${REPO_ROOT}/release"
LOCAL_INSTALLER=""
LOCAL_RUNTIME=""

usage() {
  cat <<'EOF'
Usage: upgrade-and-package.sh [OPTIONS]

Upgrades Dragon Browser's Gecko engine (default: Firefox ESR), rebuilds launcher/stub
binaries when available, and packages a single-file Windows Setup .exe in release/.

Options:
  --channel esr|release     Mozilla channel to track (default: esr)
  --version <ver>           Pin an exact Gecko/Firefox version (e.g. 153.8.0esr)
  --check-only              Check installed vs latest available engine version and exit
  --force                   Re-download and re-compile even if already on latest version
  --from-source             Compile Gecko from source instead of fast binary upgrade
  --skip-upgrade            Skip engine download/upgrade and package current dist/runtime/
  --also-zip                Also build DragonBrowser-Portable-<ver>-win64.zip
  --reuse-binaries          Skip Cargo rebuild and reuse existing dragon-browser.exe & stub
  --output-dir <dir>        Output directory for installer artifacts (default: release/)
  --local-installer <exe>   Use a local Firefox Win64 Setup .exe for offline upgrade
  --local-runtime <dir>     Use a local extracted Gecko runtime directory
  -h, --help                Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    --skip-upgrade)
      SKIP_UPGRADE=1
      shift
      ;;
    --also-zip)
      ALSO_ZIP=1
      shift
      ;;
    --reuse-binaries)
      REUSE_BINARIES=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --local-installer)
      LOCAL_INSTALLER="$2"
      shift 2
      ;;
    --local-runtime)
      LOCAL_RUNTIME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

UPGRADE_ARGS=(--channel "${CHANNEL}")
if [[ -n "${VERSION}" ]]; then
  UPGRADE_ARGS+=(--version "${VERSION}")
fi

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  exec python3 "${REPO_ROOT}/engine/scripts/upgrade-engine.py" "${UPGRADE_ARGS[@]}" --check-only
fi

if [[ "${SKIP_UPGRADE}" -eq 0 ]]; then
  if [[ "${FORCE}" -eq 1 ]]; then
    UPGRADE_ARGS+=(--force)
  fi
  if [[ "${FROM_SOURCE}" -eq 1 ]]; then
    UPGRADE_ARGS+=(--from-source)
  fi
  if [[ -n "${LOCAL_INSTALLER}" ]]; then
    UPGRADE_ARGS+=(--local-installer "${LOCAL_INSTALLER}")
  fi
  if [[ -n "${LOCAL_RUNTIME}" ]]; then
    UPGRADE_ARGS+=(--local-runtime "${LOCAL_RUNTIME}")
  fi
  echo "==> [1/3] Upgrading Dragon Gecko Engine (channel=${CHANNEL})..."
  python3 "${REPO_ROOT}/engine/scripts/upgrade-engine.py" "${UPGRADE_ARGS[@]}"
else
  echo "==> [1/3] Skipping engine upgrade (--skip-upgrade)."
fi

STUB_CACHE="${REPO_ROOT}/installer/build/dragon-installer-stub.exe"
if [[ "${REUSE_BINARIES}" -eq 0 ]] && command -v cargo >/dev/null 2>&1 && command -v cargo-zigbuild >/dev/null 2>&1; then
  echo "==> [2/3] Building launcher & installer stub via scripts/build.sh..."
  bash "${REPO_ROOT}/scripts/build.sh"
else
  echo "==> [2/3] Reusing existing launcher & installer stub binaries..."
  if [[ ! -f "${REPO_ROOT}/dist/dragon-browser.exe" || ! -f "${STUB_CACHE}" ]]; then
    echo "ERROR: Missing prebuilt dragon-browser.exe or installer stub (${STUB_CACHE}). Run scripts/build.sh first." >&2
    exit 1
  fi
  mkdir -p "${REPO_ROOT}/dist/resources/autoconfig" "${REPO_ROOT}/dist/resources/chrome"
  cp -f -- "${REPO_ROOT}/gecko/user.js" "${REPO_ROOT}/dist/resources/user.js"
  cp -f -- "${REPO_ROOT}/gecko/policies.template.json" "${REPO_ROOT}/dist/resources/policies.template.json"
  cp -f -- "${REPO_ROOT}/gecko/autoconfig/autoconfig.js" "${REPO_ROOT}/dist/resources/autoconfig/autoconfig.js"
  cp -f -- "${REPO_ROOT}/gecko/autoconfig/dragon.cfg" "${REPO_ROOT}/dist/resources/autoconfig/dragon.cfg"
  cp -f -- "${REPO_ROOT}/gecko/autoconfig/dragon-chrome.uc.js" "${REPO_ROOT}/dist/resources/autoconfig/dragon-chrome.uc.js"
  cp -f -- "${REPO_ROOT}/gecko/chrome/userChrome.css" "${REPO_ROOT}/dist/resources/chrome/userChrome.css"
  cp -f -- "${REPO_ROOT}/gecko/chrome/userContent.css" "${REPO_ROOT}/dist/resources/chrome/userContent.css"
fi

echo "==> [3/3] Packaging Windows Setup .exe into ${OUTPUT_DIR}..."
PKG_ARGS=(--dist-dir "${REPO_ROOT}/dist" --output-dir "${OUTPUT_DIR}")
if [[ "${ALSO_ZIP}" -eq 1 ]]; then
  PKG_ARGS+=(--also-zip)
fi
python3 "${REPO_ROOT}/scripts/package-installer.py" "${PKG_ARGS[@]}"
