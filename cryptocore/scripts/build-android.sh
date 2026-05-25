#!/usr/bin/env bash
# 用 cargo-ndk 把 cryptocore 编译为 Android 4 ABI 的 libcryptocore.so
#
# 前置依赖：
#   - rust toolchain（>= 1.85 for edition 2024）
#   - Android NDK
#       export ANDROID_NDK_HOME=$HOME/Android/Sdk/ndk/<version>
#   - cargo-ndk
#       cargo install cargo-ndk
#   - 4 个 Android target 三元组
#       rustup target add aarch64-linux-android armv7-linux-androideabi \
#         x86_64-linux-android i686-linux-android
#
# 产物布局（被 phone/plugins/with-cryptocore.js 复制到 app/src/main/jniLibs/）：
#   cryptocore/build/jniLibs/arm64-v8a/libcryptocore.so
#   cryptocore/build/jniLibs/armeabi-v7a/libcryptocore.so
#   cryptocore/build/jniLibs/x86_64/libcryptocore.so
#   cryptocore/build/jniLibs/x86/libcryptocore.so
#
# 体积参考（release + opt-level=z + lto + strip）：单 ABI ~400-700KB
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$CRATE_DIR/build/jniLibs"

# 默认 4 ABI；可通过 CRYPTOCORE_ABIS 覆盖（调试时缩到单个）
#   CRYPTOCORE_ABIS="arm64-v8a" ./build-android.sh
ABIS="${CRYPTOCORE_ABIS:-arm64-v8a armeabi-v7a x86_64 x86}"

# Android API level —— 必须 >= phone/android 的 minSdkVersion
ANDROID_API="${CRYPTOCORE_ANDROID_API:-24}"

if ! command -v cargo-ndk >/dev/null 2>&1; then
  cat <<EOF >&2
[error] cargo-ndk 未安装。请先执行：
  cargo install cargo-ndk
EOF
  exit 1
fi

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${NDK_HOME:-}" ]; then
  cat <<EOF >&2
[error] 没有找到 ANDROID_NDK_HOME。请：
  export ANDROID_NDK_HOME=\$HOME/Android/Sdk/ndk/<version>
EOF
  exit 1
fi

# Android ABI → rustc target triple
declare -A ABI_TO_TARGET=(
  ["arm64-v8a"]="aarch64-linux-android"
  ["armeabi-v7a"]="armv7-linux-androideabi"
  ["x86_64"]="x86_64-linux-android"
  ["x86"]="i686-linux-android"
)

# 自动安装缺失的 rustup target（已装是 no-op，开销可忽略）
if command -v rustup >/dev/null 2>&1; then
  TARGETS_TO_ADD=()
  for abi in $ABIS; do
    triple="${ABI_TO_TARGET[$abi]:-}"
    if [ -z "$triple" ]; then
      echo "[error] 未知 ABI: $abi" >&2
      exit 1
    fi
    if ! rustup target list --installed 2>/dev/null | grep -qx "$triple"; then
      TARGETS_TO_ADD+=("$triple")
    fi
  done
  if [ "${#TARGETS_TO_ADD[@]}" -gt 0 ]; then
    echo "[setup] 安装缺失的 rustup target: ${TARGETS_TO_ADD[*]}"
    rustup target add "${TARGETS_TO_ADD[@]}"
  fi
else
  echo "[warn] 未检测到 rustup —— 跳过 target 自动安装，假设你已手工装好" >&2
fi

# 把 ABI 列表转成 -t 参数列表（cargo-ndk 用 Android ABI 名而非 Rust target 三元组）
T_ARGS=()
for abi in $ABIS; do
  T_ARGS+=(-t "$abi")
done

mkdir -p "$OUT_DIR"
echo "[build] abis=$ABIS api=$ANDROID_API → $OUT_DIR"

cd "$CRATE_DIR"
cargo ndk \
  "${T_ARGS[@]}" \
  --platform "$ANDROID_API" \
  --output-dir "$OUT_DIR" \
  -- build \
  --release \
  --features android

echo "[done] 产物："
find "$OUT_DIR" -name 'libcryptocore.so' -printf '  %p (%s bytes)\n'
