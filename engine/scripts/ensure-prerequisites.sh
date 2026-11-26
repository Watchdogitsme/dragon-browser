#!/usr/bin/env bash
# =============================================================================
# Dragon Browser — Linux / WSL Prerequisite Checker & Auto-Installer
# Verifies (and installs via apt-get / rustup when available) tools required
# to fetch, patch, and compile mozilla-esr153.
# =============================================================================
set -euo pipefail

MODE="build"
NO_AUTO_INSTALL=0
TARGET_DRIVE_PATH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            MODE="${2:-build}"
            shift 2
            ;;
        --no-auto-install)
            NO_AUTO_INSTALL=1
            shift
            ;;
        --path)
            TARGET_DRIVE_PATH="${2:-}"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ENGINE_DIR}/.." && pwd)"
CHECK_PATH="${TARGET_DRIVE_PATH:-${REPO_ROOT}}"

echo "=== Dragon Browser Prerequisite Check (Linux/WSL, mode=${MODE}) ==="

# 1. Disk space check (KB -> GB)
AVAIL_KB="$(df -Pk "${CHECK_PATH}" | awk 'NR==2 {print $4}')"
AVAIL_GB="$((AVAIL_KB / 1024 / 1024))"
MIN_GB=5
if [[ "${MODE}" == "build" ]]; then
    MIN_GB=40
fi
if (( AVAIL_GB < MIN_GB )); then
    echo "  [FAIL] Disk Space: ${AVAIL_GB} GB available at ${CHECK_PATH}; >= ${MIN_GB} GB required." >&2
    exit 1
fi
echo "  [OK]   Disk Space: ${AVAIL_GB} GB free (required >= ${MIN_GB} GB)"

can_apt_install() {
    if (( NO_AUTO_INSTALL == 1 )); then
        return 1
    fi
    if ! command -v apt-get >/dev/null 2>&1; then
        return 1
    fi
    if [[ "$(id -u)" -eq 0 ]]; then
        return 0
    fi
    command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null
}

install_apt_pkgs() {
    local pkgs=("$@")
    if ! can_apt_install; then
        echo "  [FAIL] Missing tools (${pkgs[*]}). Install manually: sudo apt-get update && sudo apt-get install -y ${pkgs[*]}" >&2
        exit 1
    fi
    echo "  [INFO] Installing via apt-get: ${pkgs[*]}"
    if [[ "$(id -u)" -eq 0 ]]; then
        apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkgs[@]}"
    else
        sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkgs[@]}"
    fi
}

# 2. Fetch tools (curl, tar, xz, python3)
missing_apt=()
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || missing_apt+=("curl")
command -v tar >/dev/null 2>&1 || missing_apt+=("tar")
command -v xz >/dev/null 2>&1 || missing_apt+=("xz-utils")
command -v python3 >/dev/null 2>&1 || missing_apt+=("python3")

if (( ${#missing_apt[@]} > 0 )); then
    install_apt_pkgs "${missing_apt[@]}"
fi
echo "  [OK]   Fetch & Python tools: $(python3 --version 2>&1)"

if [[ "${MODE}" == "build" ]]; then
    build_apt=()
    command -v git >/dev/null 2>&1 || build_apt+=("git")
    command -v clang >/dev/null 2>&1 || build_apt+=("clang")
    command -v lld >/dev/null 2>&1 || build_apt+=("lld")
    command -v make >/dev/null 2>&1 || build_apt+=("make")
    command -v pkg-config >/dev/null 2>&1 || build_apt+=("pkg-config")
    command -v m4 >/dev/null 2>&1 || build_apt+=("m4")
    command -v unzip >/dev/null 2>&1 || build_apt+=("unzip")
    if (( ${#build_apt[@]} > 0 )); then
        install_apt_pkgs "${build_apt[@]}"
    fi
    echo "  [OK]   Native C/C++ build tools: git, clang, lld, make"

    export PATH="${HOME}/.cargo/bin:${PATH}"
    if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
        if (( NO_AUTO_INSTALL == 1 )); then
            echo "  [FAIL] rustc/cargo not found and --no-auto-install specified." >&2
            exit 1
        fi
        echo "  [INFO] Installing Rust toolchain via rustup..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        export PATH="${HOME}/.cargo/bin:${PATH}"
    fi
    echo "  [OK]   Rust: $(rustc --version 2>&1)"
fi

echo "[OK] All prerequisites for mode=${MODE} verified."
