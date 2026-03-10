#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist-firefox"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

cp "${ROOT_DIR}/manifest.firefox.json" "${OUT_DIR}/manifest.json"
cp "${ROOT_DIR}/focus-locker-logo.png" "${OUT_DIR}/"
cp -R "${ROOT_DIR}/src" "${OUT_DIR}/"
