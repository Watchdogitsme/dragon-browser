#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CHANNEL="esr"
RUNTIME_DIR="${SCRIPT_DIR}/runtime"
FORCE=0

usage() {
  cat <<'EOF'
Usage: setup-runtime.sh [--force] [--channel esr|release] [--target <dir>]

Downloads the official Mozilla Firefox Win64 installer (ESR by default, or release),
extracts core/ into ./runtime (using 7z/7zz), and strips unnecessary telemetry/updater binaries.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=1
      shift
      ;;
    --channel)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --channel requires 'esr' or 'release'." >&2
        exit 1
      fi
      CHANNEL="$2"
      shift 2
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --target requires a directory argument." >&2
        exit 1
      fi
      RUNTIME_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "${CHANNEL}" in
  esr)
    DOWNLOAD_URL="https://download.mozilla.org/?product=firefox-esr-latest-ssl&os=win64&lang=en-US"
    ;;
  release)
    DOWNLOAD_URL="https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US"
    ;;
  *)
    echo "ERROR: Invalid channel '${CHANNEL}' (expected 'esr' or 'release')." >&2
    exit 1
    ;;
esac

BLOAT_BINARIES=(
  "updater.exe"
  "maintenanceservice.exe"
  "maintenanceservice_installer.exe"
  "crashreporter.exe"
  "pingsender.exe"
  "default-browser-agent.exe"
  "crashhelper.exe"
  "private_browsing.exe"
  "firefox.exe.sig"
  "xul.dll.sig"
  "plugin-container.exe.sig"
  "mozwer.dll"
  "onnxruntime.dll"
  "mozinference.dll"
  "xpcshell.exe"
  "certutil.exe"
  "pk12util.exe"
  "updater.ini"
  "update-settings.ini"
  "precomplete"
  "removed-files"
  "browser/blank.pdf"
  "browser/confused_fox.pdf"
)

BLOAT_DIRS=(
  "uninstall"
  "desktop-launcher"
  "gmp-fake"
  "gmp-fakeopenh264"
)

strip_bloat() {
  local dir="$1"
  local removed=()
  for bin in "${BLOAT_BINARIES[@]}"; do
    if [[ -f "${dir}/${bin}" ]]; then
      rm -f -- "${dir}/${bin}"
      removed+=("${bin}")
    fi
  done
  for d in "${BLOAT_DIRS[@]}"; do
    if [[ -d "${dir}/${d}" ]]; then
      rm -rf -- "${dir}/${d}"
      removed+=("${d}/")
    fi
  done
  if [[ ${#removed[@]} -gt 0 ]]; then
    echo "==> Stripped bloat items: ${removed[*]}"
  fi
}

if [[ ( -f "${RUNTIME_DIR}/dragon.exe" || -f "${RUNTIME_DIR}/firefox.exe" ) && "${FORCE}" -eq 0 ]]; then
  echo "Dragon Browser runtime already installed at: ${RUNTIME_DIR}"
  strip_bloat "${RUNTIME_DIR}"
  echo "Pass --force to re-download. Launch on Windows with: .\\dragon-browser.exe"
  exit 0
fi

SEVENZ_BIN=""
if command -v 7z >/dev/null 2>&1; then
  SEVENZ_BIN="7z"
elif command -v 7zz >/dev/null 2>&1; then
  SEVENZ_BIN="7zz"
fi

if [[ -z "${SEVENZ_BIN}" ]]; then
  echo "NOTE: '7z' is not installed in this WSL/Linux environment." >&2
  echo "" >&2
  echo "To set up the portable Win64 Firefox ESR runtime, choose one of:" >&2
  echo "  1. (Recommended on Windows) Run in PowerShell inside this folder:" >&2
  echo "       .\\setup-runtime.ps1" >&2
  echo "  2. Install 7-Zip in WSL/Linux and re-run this script:" >&2
  echo "       sudo apt update && sudo apt install -y p7zip-full" >&2
  echo "       bash \"${BASH_SOURCE[0]}\"" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: 'curl' is required to download Firefox ESR." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "${TEMP_DIR}"
}
trap cleanup EXIT

INSTALLER_PATH="${TEMP_DIR}/Firefox-ESR-Win64-Setup.exe"
EXTRACT_DIR="${TEMP_DIR}/extract"

echo "==> Downloading official Mozilla Firefox ESR (Win64)..."
echo "    Source: ${DOWNLOAD_URL}"
curl -fL --retry 3 --progress-bar -o "${INSTALLER_PATH}" "${DOWNLOAD_URL}"

echo "==> Extracting core/ via ${SEVENZ_BIN}..."
mkdir -p "${EXTRACT_DIR}" "${RUNTIME_DIR}"
"${SEVENZ_BIN}" x -y "-o${EXTRACT_DIR}" "${INSTALLER_PATH}" "core/*" >/dev/null

if [[ ! -f "${EXTRACT_DIR}/core/firefox.exe" ]]; then
  echo "ERROR: Failed to extract core/firefox.exe from installer." >&2
  echo "Please run .\\setup-runtime.ps1 on Windows PowerShell instead." >&2
  exit 1
fi

cp -rf -- "${EXTRACT_DIR}/core/." "${RUNTIME_DIR}/"
strip_bloat "${RUNTIME_DIR}"

if [[ ! -f "${RUNTIME_DIR}/firefox.exe" ]]; then
  echo "ERROR: Verification failed: ${RUNTIME_DIR}/firefox.exe is missing." >&2
  exit 1
fi

echo ""
echo "Dragon Browser runtime ready!"
echo "  Runtime path : ${RUNTIME_DIR}"
echo "  Engine binary: ${RUNTIME_DIR}/firefox.exe"
echo ""
echo "Next step (on Windows):"
echo "  .\\dragon-browser.exe"
