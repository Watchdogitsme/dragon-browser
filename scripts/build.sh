#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

export PATH="${HOME}/.cargo/bin:${PATH}"

TARGET_TRIPLE="x86_64-pc-windows-gnu"
DIST_DIR="${REPO_ROOT}/dist"
NATIVE_DIR="${REPO_ROOT}/native"
GECKO_DIR="${REPO_ROOT}/gecko"
TARGET_BIN="${REPO_ROOT}/target/${TARGET_TRIPLE}/release/dragon-browser.exe"
STUB_BIN="${REPO_ROOT}/target/${TARGET_TRIPLE}/release/dragon-installer-stub.exe"
STUB_STAGE="${REPO_ROOT}/installer/build/dragon-installer-stub.exe"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Required command '$1' not found in PATH." >&2
    exit 1
  fi
}

format_size() {
  local file_path="$1"
  local bytes
  bytes="$(stat -c%s -- "$file_path")"
  python3 - "$bytes" <<'PY'
import sys
b = int(sys.argv[1])
if b >= 1024 * 1024:
    print(f"{b / (1024 * 1024):.2f} MiB ({b:,} bytes)")
elif b >= 1024:
    print(f"{b / 1024:.1f} KiB ({b:,} bytes)")
else:
    print(f"{b} bytes")
PY
}

require_cmd cargo
require_cmd cargo-zigbuild
require_cmd python3

if [[ -f "${REPO_ROOT}/engine/scripts/generate-branding-assets.py" ]]; then
  echo "==> Generating Dragon Browser engine branding assets (PNG/ICO)..."
  python3 "${REPO_ROOT}/engine/scripts/generate-branding-assets.py"
fi

echo "==> Building Dragon Browser launcher & installer stub (${TARGET_TRIPLE})..."
(
  cd -- "${REPO_ROOT}"
  cargo zigbuild --release --target "${TARGET_TRIPLE}" -p dragon-browser -p dragon-installer-stub --offline
)

if [[ ! -f "${TARGET_BIN}" ]]; then
  echo "ERROR: Compiled binary not found at ${TARGET_BIN}" >&2
  exit 1
fi
if [[ ! -f "${STUB_BIN}" ]]; then
  echo "ERROR: Compiled installer stub not found at ${STUB_BIN}" >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/installer/build"
cp -f -- "${STUB_BIN}" "${STUB_STAGE}"

echo "==> Preparing portable dist/ layout..."
mkdir -p \
  "${DIST_DIR}/resources/autoconfig" \
  "${DIST_DIR}/resources/chrome"

cp -f -- "${TARGET_BIN}" "${DIST_DIR}/dragon-browser.exe"

# Copy Gecko resources in the exact layout expected by the launcher
cp -f -- "${GECKO_DIR}/user.js" "${DIST_DIR}/resources/user.js"
cp -f -- "${GECKO_DIR}/policies.template.json" "${DIST_DIR}/resources/policies.template.json"
cp -f -- "${GECKO_DIR}/autoconfig/autoconfig.js" "${DIST_DIR}/resources/autoconfig/autoconfig.js"
cp -f -- "${GECKO_DIR}/autoconfig/dragon.cfg" "${DIST_DIR}/resources/autoconfig/dragon.cfg"
cp -f -- "${GECKO_DIR}/autoconfig/dragon-chrome.uc.js" "${DIST_DIR}/resources/autoconfig/dragon-chrome.uc.js"
cp -f -- "${GECKO_DIR}/chrome/userChrome.css" "${DIST_DIR}/resources/chrome/userChrome.css"
cp -f -- "${GECKO_DIR}/chrome/userContent.css" "${DIST_DIR}/resources/chrome/userContent.css"

# Copy portable runtime setup scripts into dist/
cp -f -- "${REPO_ROOT}/scripts/setup-runtime.ps1" "${DIST_DIR}/setup-runtime.ps1"
cp -f -- "${REPO_ROOT}/scripts/setup-runtime.sh" "${DIST_DIR}/setup-runtime.sh"
chmod +x "${DIST_DIR}/setup-runtime.sh" 2>/dev/null || true

# Remove any legacy Dragon Core XPI artifacts
rm -rf -- "${DIST_DIR}/extensions"

if [[ -f "${DIST_DIR}/runtime/omni.ja" && -f "${DIST_DIR}/runtime/browser/omni.ja" && -f "${REPO_ROOT}/engine/scripts/compile-engine-pack.py" ]]; then
  echo "==> Compiling Dragon Gecko Engine pack (100% Native) into ${DIST_DIR}/runtime..."
  python3 "${REPO_ROOT}/engine/scripts/compile-engine-pack.py" \
    --runtime-dir "${DIST_DIR}/runtime" \
    --native-dir "${NATIVE_DIR}" \
    --refresh-binary \
    --verify
fi

echo ""
echo "Dragon Browser build complete!"
echo "  Output directory : ${DIST_DIR}"
echo "  dragon-browser.exe : $(format_size "${DIST_DIR}/dragon-browser.exe")"
echo "  installer stub     : $(format_size "${STUB_STAGE}")"
echo "  native modules     : $(find "${NATIVE_DIR}/modules" -maxdepth 1 -type f | wc -l) file(s)"
echo "  native content     : $(find "${NATIVE_DIR}/content" -type f | wc -l) file(s)"
if [[ -f "${DIST_DIR}/runtime/dragon.exe" ]]; then
  echo "  runtime/dragon.exe : $(format_size "${DIST_DIR}/runtime/dragon.exe")"
fi
echo ""
echo "Next step (if runtime/ is not set up yet):"
echo "  Windows PowerShell: cd dist; .\\setup-runtime.ps1"
echo "  WSL/Linux (7z)    : bash dist/setup-runtime.sh"
