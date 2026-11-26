#!/usr/bin/env bash
# =============================================================================
# Dragon Browser — Mozilla ESR 153 Source Fetcher & Overlay Bootstrap (Linux/WSL)
# Checks/installs prerequisites, downloads firefox-153.7.0esr.source.tar.xz,
# extracts (or migrates) to a real space-free directory, and applies + verifies overlay.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ENGINE_DIR}/.." && pwd)"

GECKO_TAG="${DRAGON_GECKO_VERSION:-153.7.0esr}"
ESR_VERSION="${GECKO_TAG%esr}"
TARBALL_NAME="firefox-${GECKO_TAG}.source.tar.xz"
SOURCE_URL="https://archive.mozilla.org/pub/firefox/releases/${GECKO_TAG}/source/${TARBALL_NAME}"

CACHE_DIR="${ENGINE_DIR}/cache"
LEGACY_SRC_DIR="${ENGINE_DIR}/src/firefox-${ESR_VERSION}"
BUILD_ROOT="${DRAGON_BUILD_ROOT:-${HOME}/dragon-build}"

if [[ "${ENGINE_DIR}" == *" "* ]]; then
    SRC_PARENT="${BUILD_ROOT}/src"
else
    SRC_PARENT="${ENGINE_DIR}/src"
fi
SRC_DIR="${SRC_PARENT}/firefox-${ESR_VERSION}"
TARBALL_PATH="${CACHE_DIR}/${TARBALL_NAME}"
TARGET_PLATFORM="${DRAGON_TARGET:-linux64}"
MIN_TAR_BYTES=104857600

PREREQ_ARGS=(--mode fetch --path "${ENGINE_DIR}")
if [[ "${DRAGON_NO_AUTO_INSTALL:-0}" == "1" ]]; then
    PREREQ_ARGS+=(--no-auto-install)
fi
bash "${SCRIPT_DIR}/ensure-prerequisites.sh" "${PREREQ_ARGS[@]}"

mkdir -p "${CACHE_DIR}" "${SRC_PARENT}"

if [[ "${SRC_DIR}" != "${LEGACY_SRC_DIR}" && ! -d "${SRC_DIR}" && -f "${LEGACY_SRC_DIR}/mach" ]]; then
    echo "[INFO] Moving extracted source tree to space-free path: ${LEGACY_SRC_DIR} -> ${SRC_DIR} ..."
    mv "${LEGACY_SRC_DIR}" "${SRC_DIR}"
fi

echo "=== Dragon Browser Gecko Source Fetcher (mozilla-esr153 / ${ESR_VERSION}esr) ==="
if [[ -f "${TARBALL_PATH}" ]]; then
    TAR_SIZE="$(wc -c < "${TARBALL_PATH}")"
    if (( TAR_SIZE < MIN_TAR_BYTES )); then
        echo "[WARN] Cached tarball is too small (${TAR_SIZE} bytes) — removing and re-downloading..."
        rm -f "${TARBALL_PATH}"
    fi
fi

if [[ ! -f "${TARBALL_PATH}" ]]; then
    echo "[1/4] Downloading ${SOURCE_URL} -> ${TARBALL_PATH} ..."
    rm -f "${TARBALL_PATH}.part"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 -o "${TARBALL_PATH}.part" "${SOURCE_URL}"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "${TARBALL_PATH}.part" "${SOURCE_URL}"
    else
        echo "ERROR: Neither curl nor wget is installed." >&2
        exit 1
    fi
    PART_SIZE="$(wc -c < "${TARBALL_PATH}.part")"
    if (( PART_SIZE < MIN_TAR_BYTES )); then
        echo "ERROR: Downloaded source archive looks incomplete (${PART_SIZE} bytes)." >&2
        exit 1
    fi
    mv "${TARBALL_PATH}.part" "${TARBALL_PATH}"
else
    echo "[1/4] Found cached source tarball at ${TARBALL_PATH}"
fi

MARKER_FILE="${SRC_DIR}/.dragon-extracted-ok"
if [[ -f "${MARKER_FILE}" && -f "${SRC_DIR}/mach" && -f "${SRC_DIR}/toolkit/modules/AppConstants.sys.mjs" ]]; then
    echo "[2/4] Verified extracted source tree at ${SRC_DIR}"
elif [[ -f "${SRC_DIR}/mach" && -f "${SRC_DIR}/toolkit/modules/AppConstants.sys.mjs" ]]; then
    echo "[2/4] Existing source tree verified at ${SRC_DIR} — writing extraction marker"
    echo "ok" > "${MARKER_FILE}"
else
    if [[ -d "${SRC_DIR}" ]]; then
        echo "[WARN] Incomplete source tree detected at ${SRC_DIR} — cleaning up before re-extraction..."
        rm -rf "${SRC_DIR}"
    fi
    echo "[2/4] Extracting ${TARBALL_PATH} into ${SRC_PARENT} ..."
    tar -xJf "${TARBALL_PATH}" -C "${SRC_PARENT}"
    if [[ ! -f "${SRC_DIR}/mach" || ! -f "${SRC_DIR}/toolkit/modules/AppConstants.sys.mjs" ]]; then
        echo "ERROR: Expected files missing after extraction in ${SRC_DIR}" >&2
        exit 1
    fi
    echo "ok" > "${MARKER_FILE}"
fi

echo "[3/4] Ensuring Dragon branding assets..."
if [[ -f "${SCRIPT_DIR}/generate-branding-assets.py" && ! -f "${ENGINE_DIR}/branding/dragon/PrivateBrowsing_150.png" ]]; then
    python3 "${SCRIPT_DIR}/generate-branding-assets.py"
fi

echo "[4/4] Applying Dragon Browser overlay and patches (target=${TARGET_PLATFORM}) ..."
python3 "${ENGINE_DIR}/scripts/apply-overlay.py" \
    --src-dir "${SRC_DIR}" \
    --target "${TARGET_PLATFORM}" \
    --apply \
    --verify

echo "[OK] Dragon Browser Gecko ESR ${ESR_VERSION} source tree is ready at: ${SRC_DIR}"
