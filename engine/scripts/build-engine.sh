#!/usr/bin/env bash
# =============================================================================
# Dragon Browser — From-Source Gecko Engine Builder (Linux / WSL)
# Checks/installs prerequisites, uses a real space-free directory when needed
# (since ./mach calls os.path.realpath() and rejects spaces), runs ./mach
# bootstrap + configure + build + package, stages dist/runtime/, and runs
# compile-engine-pack.py.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ENGINE_DIR}/.." && pwd)"

GECKO_TAG="${DRAGON_GECKO_VERSION:-153.7.0esr}"
ESR_VERSION="${GECKO_TAG%esr}"
BUILD_ROOT="${DRAGON_BUILD_ROOT:-${HOME}/dragon-build}"
LEGACY_SRC_DIR="${ENGINE_DIR}/src/firefox-${ESR_VERSION}"

if [[ -n "${DRAGON_GECKO_SRC:-}" ]]; then
    SRC_DIR="${DRAGON_GECKO_SRC}"
    OBJ_DIR="${SRC_DIR}/obj-dragon"
elif [[ "${ENGINE_DIR}" == *" "* ]]; then
    mkdir -p "${BUILD_ROOT}/src" "${BUILD_ROOT}/obj-dragon"
    SRC_DIR="${BUILD_ROOT}/src/firefox-${ESR_VERSION}"
    OBJ_DIR="${BUILD_ROOT}/obj-dragon"
    if [[ ! -d "${SRC_DIR}" && -f "${LEGACY_SRC_DIR}/mach" ]]; then
        echo "[INFO] Moving source tree to space-free path: ${LEGACY_SRC_DIR} -> ${SRC_DIR} ..."
        mv "${LEGACY_SRC_DIR}" "${SRC_DIR}"
    fi
else
    SRC_DIR="${LEGACY_SRC_DIR}"
    OBJ_DIR="${SRC_DIR}/obj-dragon"
fi

if [[ "${SRC_DIR}" == *" "* ]]; then
    echo "ERROR: Mozilla's ./mach forbids spaces in the real source path ('${SRC_DIR}')." >&2
    exit 1
fi

DIST_DIR="${REPO_ROOT}/dist"
RUNTIME_DIR="${DIST_DIR}/runtime"
NATIVE_DIR="${REPO_ROOT}/native"
CACHE_DIR="${ENGINE_DIR}/cache"
TARGET_PLATFORM="${DRAGON_TARGET:-linux64}"
SKIP_BOOTSTRAP="${DRAGON_SKIP_BOOTSTRAP:-0}"
FORCE_BOOTSTRAP="${DRAGON_FORCE_BOOTSTRAP:-0}"

echo "=== Dragon Browser From-Source Gecko Engine Builder ==="

PREREQ_ARGS=(--mode build --path "${ENGINE_DIR}")
if [[ "${DRAGON_NO_AUTO_INSTALL:-0}" == "1" ]]; then
    PREREQ_ARGS+=(--no-auto-install)
fi
bash "${SCRIPT_DIR}/ensure-prerequisites.sh" "${PREREQ_ARGS[@]}"

export PATH="${HOME}/.cargo/bin:${PATH}"

if [[ ! -d "${SRC_DIR}" || ! -f "${SRC_DIR}/mach" ]]; then
    echo "[1/6] Source tree missing or incomplete at ${SRC_DIR}. Running fetch-source.sh..."
    DRAGON_TARGET="${TARGET_PLATFORM}" DRAGON_GECKO_VERSION="${GECKO_TAG}" bash "${SCRIPT_DIR}/fetch-source.sh"
fi

echo "[2/6] Generating Dragon branding icon assets & verifying source overlay..."
if [[ -f "${SCRIPT_DIR}/generate-branding-assets.py" ]]; then
    python3 "${SCRIPT_DIR}/generate-branding-assets.py"
fi
python3 "${SCRIPT_DIR}/apply-overlay.py" \
    --src-dir "${SRC_DIR}" \
    --target "${TARGET_PLATFORM}" \
    --apply \
    --verify

mkdir -p "${CACHE_DIR}" "${OBJ_DIR}"
BOOTSTRAP_MARKER="${CACHE_DIR}/.mach-bootstrapped-linux"

echo "[3/6] Using space-free build directory: ${SRC_DIR} (obj=${OBJ_DIR})"
pushd "${SRC_DIR}" >/dev/null
export MOZCONFIG="${SRC_DIR}/mozconfig"
export MOZ_OBJDIR="${OBJ_DIR}"

if [[ "${SKIP_BOOTSTRAP}" != "1" ]] && [[ "${FORCE_BOOTSTRAP}" == "1" || ! -f "${BOOTSTRAP_MARKER}" ]]; then
    echo "[4/6] Running one-time ./mach --no-interactive bootstrap --application-choice=browser ..."
    ./mach --no-interactive bootstrap --application-choice=browser --no-system-changes || ./mach --no-interactive bootstrap --application-choice=browser
    echo "ok" > "${BOOTSTRAP_MARKER}"
fi

echo "[5/6] Running ./mach configure && ./mach build && ./mach package ..."
./mach configure
./mach build
./mach package
popd >/dev/null

OBJ_PKG_DIR="${OBJ_DIR}/dist/dragon"
if [[ -f "${OBJ_PKG_DIR}/omni.ja" ]]; then
    OBJ_BIN_DIR="${OBJ_PKG_DIR}"
else
    OBJ_BIN_DIR="${OBJ_DIR}/dist/bin"
fi
if [[ ! -d "${OBJ_BIN_DIR}" ]]; then
    echo "ERROR: Expected build output directory not found at ${OBJ_BIN_DIR}" >&2
    exit 1
fi

echo "[6/6] Staging compiled engine into ${RUNTIME_DIR} and running compile-engine-pack.py ..."
mkdir -p "${RUNTIME_DIR}"
cp -a "${OBJ_BIN_DIR}/." "${RUNTIME_DIR}/"

python3 "${SCRIPT_DIR}/compile-engine-pack.py" \
    --runtime-dir "${RUNTIME_DIR}" \
    --native-dir "${NATIVE_DIR}" \
    --refresh-binary \
    --verify

echo "[OK] Dragon Browser Gecko Engine build complete in: ${RUNTIME_DIR}"
