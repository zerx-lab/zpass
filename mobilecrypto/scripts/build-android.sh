#!/usr/bin/env bash
# 编译 mobilecrypto 为 Android AAR，落到 phone/android/app/libs/mobilecrypto.aar
#
# 前置依赖：
#   - go (>= 1.22)
#   - gomobile（gomobile 命令）
#       go install golang.org/x/mobile/cmd/gomobile@latest
#       go install golang.org/x/mobile/cmd/gobind@latest
#   - Android NDK，并通过以下任一方式让 gomobile 找到：
#       export ANDROID_HOME=$HOME/Android/Sdk
#       export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/<version>
#
# 产物：
#   phone/android/app/libs/mobilecrypto.aar  (包含 4 个 ABI 的 .so + Java 绑定)
#
# AAR 体积参考：~6 MB（含 4 ABI）；若只编 arm64-v8a 可缩到 ~2 MB。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# 产物落到 mobilecrypto/build/，由 phone/plugins/with-mobilecrypto.js
# 在 expo prebuild 时复制到 phone/android/app/libs/。这样 phone/android/
# 始终是 prebuild 可重生的纯净产物（它在 phone/.gitignore 里）。
OUT_DIR="$MOD_DIR/build"
OUT_AAR="$OUT_DIR/mobilecrypto.aar"

# 默认编 4 个 ABI；可通过环境变量覆盖（节省调试时编译时间）
#   MOBILECRYPTO_TARGETS="android/arm64" ./build-android.sh
TARGETS="${MOBILECRYPTO_TARGETS:-android/arm64,android/arm,android/amd64,android/386}"

# Android API level —— 必须 >= phone/android/build.gradle 中 minSdkVersion
ANDROID_API="${MOBILECRYPTO_ANDROID_API:-24}"

if ! command -v gomobile >/dev/null 2>&1; then
  cat <<EOF >&2
[error] gomobile 未安装。请先执行：
  go install golang.org/x/mobile/cmd/gomobile@latest
  go install golang.org/x/mobile/cmd/gobind@latest
然后确保 \$(go env GOPATH)/bin 在 PATH 中。
EOF
  exit 1
fi

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_HOME:-}" ]; then
  cat <<EOF >&2
[error] 没有找到 ANDROID_NDK_HOME 或 ANDROID_HOME。
请通过 sdkmanager 安装 NDK 并 export：
  export ANDROID_HOME=\$HOME/Android/Sdk
  export ANDROID_NDK_HOME=\$ANDROID_HOME/ndk/<version>
EOF
  exit 1
fi

mkdir -p "$OUT_DIR"

cd "$MOD_DIR"
echo "[build] targets=$TARGETS api=$ANDROID_API → $OUT_AAR"
  # -javapkg 是 Java 包**前缀**，gomobile 会再拼接 Go 包名作为子包。
  # 这里传 com.zerx.zpass，最终类路径为
  #   com.zerx.zpass.mobilecrypto.Mobilecrypto
gomobile bind \
  -target="$TARGETS" \
  -androidapi="$ANDROID_API" \
  -javapkg=com.zerx.zpass \
  -o "$OUT_AAR" \
  ./

echo "[ok] AAR built: $OUT_AAR"
ls -lh "$OUT_AAR"
