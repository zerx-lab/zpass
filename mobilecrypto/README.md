# mobilecrypto

ZPass 移动端（React Native / Expo）的 Go 加密原语，通过 `gomobile bind`
编译为 Android AAR / iOS XCFramework，被 `phone/modules/zpass-crypto` 引用。

## 为什么独立 go.mod

- desktop 的 go.mod 拖入 sqlite / huma / gozxing 等大体积依赖；
  gomobile bind 整个 desktop 模块会让 AAR 涨到 50MB+ 且夹带无关代码。
- 本模块只依赖 `golang.org/x/crypto`（argon2 + chacha20poly1305），
  AAR 体积 ~6MB（含 4 ABI）。

## 与 desktop 的对齐

算法、参数、字节布局与 `desktop/internal/services/cryptoutil.go` 严格一致。
同一个 vault 文件必须能被两端互相解读：

| 项 | 值 |
|---|---|
| KDF | Argon2id |
| AEAD | XChaCha20-Poly1305 |
| Key size | 32 字节 |
| Nonce size | 24 字节 |
| Salt size | 32 字节 |
| 输出布局 | `[24B nonce][ct][16B tag]` |

修改本模块的任何常量或参数顺序前，必须同步 desktop cryptoutil 与
phone/lib/crypto.ts —— 三处必须像同一份源代码。

## 构建

### Android AAR

```sh
# 安装 gomobile（一次性）
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest

# 设置 NDK
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/<version>

# 构建
./scripts/build-android.sh
# → phone/android/app/libs/mobilecrypto.aar
```

调试时只编 arm64 以节省时间：

```sh
MOBILECRYPTO_TARGETS=android/arm64 ./scripts/build-android.sh
```

### iOS XCFramework（占位）

```sh
./scripts/build-ios.sh  # 需要 macOS + Xcode
```

## 测试

```sh
go test ./...
```

`TestDeriveKEKKnownVector` 锁定 Argon2id 输出，防止隐式版本升级破坏与
desktop / hash-wasm 的字节级兼容。
