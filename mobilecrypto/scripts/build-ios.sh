#!/usr/bin/env bash
# 编译 mobilecrypto 为 iOS XCFramework，输出到 phone/ios/Mobilecrypto.xcframework
#
# 注：当前 phone/ 没有 ios/ 项目（待 expo prebuild ios 之后再启用）。
# 这里先把脚本占位；切到 iOS 时直接复用。
#
# 前置依赖：
#   - macOS + Xcode（含 iOS SDK）
#   - go + gomobile + gobind
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOD_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/phone/ios"
OUT_FRAMEWORK="$OUT_DIR/Mobilecrypto.xcframework"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[error] iOS XCFramework 只能在 macOS + Xcode 上编译" >&2
  exit 1
fi
if ! command -v gomobile >/dev/null 2>&1; then
  echo "[error] gomobile 未安装：go install golang.org/x/mobile/cmd/gomobile@latest" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$MOD_DIR"
echo "[build] iOS → $OUT_FRAMEWORK"
gomobile bind \
  -target=ios,iossimulator \
  -o "$OUT_FRAMEWORK" \
  ./

echo "[ok] XCFramework built: $OUT_FRAMEWORK"
