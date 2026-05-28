#!/usr/bin/env bash
# 把 cryptocore 编译为 HarmonyOS 的 libcryptocore.so（napi-rs 桥）
#
# 前置依赖：
#   - rust toolchain（>= 1.85 for edition 2024）
#   - 鸿蒙 Command Line Tools / DevEco Studio 自带的 NDK
#       export HARMONY_NDK_HOME=$HOME/HarmonyOS/command-line-tools/sdk/default/openharmony/native
#     该路径下应当包含：
#       llvm/bin/clang
#       sysroot/usr/lib/<triple>/
#   - 对应 Rust target：
#       rustup target add aarch64-unknown-linux-ohos x86_64-unknown-linux-ohos
#
# 产物布局（由 harmony/entry/build-profile.json5 的 nativeLib filter 引入）：
#   cryptocore/build/ohosLibs/arm64-v8a/libcryptocore.so
#   cryptocore/build/ohosLibs/x86_64/libcryptocore.so
#
# 同 build-android.sh 的设计：失败立即退出，缺 target 自动 rustup add。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$CRATE_DIR/build/ohosLibs"

# 默认产出 arm64（鸿蒙真机）+ x64（鸿蒙模拟器）；可通过 CRYPTOCORE_OHOS_ABIS 缩到单个
ABIS="${CRYPTOCORE_OHOS_ABIS:-arm64-v8a x86_64}"

if [ -z "${HARMONY_NDK_HOME:-}" ] && [ -z "${OHOS_NDK_HOME:-}" ]; then
  cat <<'EOF' >&2
[error] 没有找到 HARMONY_NDK_HOME / OHOS_NDK_HOME。请：
  export HARMONY_NDK_HOME=$HOME/HarmonyOS/command-line-tools/sdk/default/openharmony/native

  该目录下应有 llvm/bin/clang 与 sysroot/。
EOF
  exit 1
fi

NDK_HOME="${HARMONY_NDK_HOME:-${OHOS_NDK_HOME}}"
CLANG="$NDK_HOME/llvm/bin/clang"
AR="$NDK_HOME/llvm/bin/llvm-ar"

# napi-build-ohos 1.x 的 build.rs 只读 OHOS_NDK_HOME；把 HARMONY_NDK_HOME 也对齐过去。
export OHOS_NDK_HOME="$NDK_HOME"

if [ ! -x "$CLANG" ]; then
  echo "[error] 未找到 clang: $CLANG" >&2
  exit 1
fi

# OHOS ABI → rustc target triple
abi_to_triple() {
  case "$1" in
    arm64-v8a)  echo "aarch64-unknown-linux-ohos" ;;
    x86_64)     echo "x86_64-unknown-linux-ohos" ;;
    armeabi-v7a) echo "armv7-unknown-linux-ohos" ;;
    *) echo "" ;;
  esac
}

# 自动安装缺失的 rustup target
if command -v rustup >/dev/null 2>&1; then
  for abi in $ABIS; do
    triple="$(abi_to_triple "$abi")"
    if [ -z "$triple" ]; then
      echo "[error] 未知 ABI: $abi" >&2
      exit 1
    fi
    if ! rustup target list --installed 2>/dev/null | grep -qx "$triple"; then
      echo "[setup] rustup target add $triple"
      rustup target add "$triple"
    fi
  done
else
  echo "[warn] 未检测到 rustup —— 假设 target 已手工装好" >&2
fi

mkdir -p "$OUT_DIR"
echo "[build] HARMONY_NDK_HOME=$NDK_HOME"
echo "[build] abis=$ABIS → $OUT_DIR"

cd "$CRATE_DIR"

for abi in $ABIS; do
  triple="$(abi_to_triple "$abi")"
  echo ""
  echo "[build] $abi ($triple)"

  # shell 变量名不允许 `-`，cargo/cc-rs 也都识别 underscored 形式：
  #   AARCH64_UNKNOWN_LINUX_OHOS（cargo target env）
  #   CC_aarch64_unknown_linux_ohos（cc-rs，按 triple lowercase + _）
  envtail_upper="$(echo "$triple" | tr 'a-z-' 'A-Z_')"
  envtail_lower="$(echo "$triple" | tr '-' '_')"

  # 用 ohos clang 当 linker。clang 自动通过 -target $triple 选 sysroot；
  # 我们显式传 --target=$triple 给 RUSTFLAGS 用的 cc 调用，保证一致。
  export "CARGO_TARGET_${envtail_upper}_LINKER=$CLANG"
  export "CC_${envtail_lower}=$CLANG"
  export "CXX_${envtail_lower}=$CLANG"
  export "AR_${envtail_lower}=$AR"
  export "CFLAGS_${envtail_lower}=--target=${triple}"
  export "RUSTFLAGS=-C link-arg=--target=${triple} -C link-arg=-fuse-ld=lld"

  cargo build \
    --release \
    --no-default-features \
    --features harmony \
    --target "$triple"

  # 拷贝产物
  src="$CRATE_DIR/target/$triple/release/libcryptocore.so"
  if [ ! -f "$src" ]; then
    echo "[error] 编译完成但找不到 $src" >&2
    exit 1
  fi
  dst_dir="$OUT_DIR/$abi"
  mkdir -p "$dst_dir"
  cp "$src" "$dst_dir/libcryptocore.so"
  echo "[ok] $dst_dir/libcryptocore.so ($(stat -c%s "$dst_dir/libcryptocore.so") bytes)"

  unset "CARGO_TARGET_${envtail_upper}_LINKER" \
        "CC_${envtail_lower}" "CXX_${envtail_lower}" "AR_${envtail_lower}" "CFLAGS_${envtail_lower}" \
        RUSTFLAGS
done

echo ""
echo "[done] 产物："
find "$OUT_DIR" -name 'libcryptocore.so' -printf '  %p (%s bytes)\n'
