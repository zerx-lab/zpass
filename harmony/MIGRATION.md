# ZPass HarmonyOS —— phone 迁移说明

本文档记录 `phone/`（Expo React Native）→ `harmony/`（HarmonyOS Next / ArkTS）的功能迁移。源文件 ~16.3k 行 phone TS/TSX，本次迁移产出 ~6k 行 ArkTS + napi-rs 桥。

## 完成进度

### Phase 1 ✅ cryptocore napi-rs 桥

- `cryptocore/Cargo.toml` 增加 `harmony` feature（`napi` + `napi-derive`）
- `cryptocore/src/harmony.rs`：`#[napi]` 导出 `deriveKek` (异步) / `sealAead` / `openAead` / `randomBytes`
- `cryptocore/build.rs`：feature gate 下调用 `napi-build`
- `cryptocore/scripts/build-harmony.sh`：用 OHOS NDK 编译 `aarch64-unknown-linux-ohos` + `x86_64-unknown-linux-ohos`
- `harmony/entry/src/main/cpp/types/libcryptocore/`：napi 模块类型声明
- `harmony/entry/oh-package.json5` + `build-profile.json5` 引入 `libcryptocore.so`
- `harmony/entry/src/main/ets/lib/RustCryptoCore.ets`：ArkTS 封装

**验证**：`cargo check --features harmony` 通过；`cargo test --lib` 46 个原 sync + crypto 单测全过。

### Phase 2 ✅ Vault 核心

- `model/Vault.ets`：7 种 item 类型（login/card/note/identity/ssh/passkey/totp）
- `lib/Crypto.ets`：Argon2id + XChaCha20-Poly1305 + base64 + utf8 + constantTimeEqual（与 phone/lib/crypto.ts 一一对齐）
- `lib/VaultStorage.ets`：`@ohos.file.fs` 单文件 + 原子写（tmp + rename）
- `lib/VaultService.ets`：Initialize / Unlock / Lock / ChangeMasterPassword / Space CRUD / Item CRUD / 信任设备（占位）
- `lib/Spaces.ets`、`lib/CustomFields.ets`、`lib/Format.ets`、`lib/Password.ets`：纯逻辑工具
- `state/VaultStore.ets`：`@ObservedV2 / @Trace` 反应式状态（替代 React Context）
- `lib/TrustedDeviceHuks.ets`：HUKS 桩（返回 unsupported；后续 Phase 接入）

### Phase 3 ✅ 主 UI

- `pages/Index.ets`：路由壳，按 status 切换 Onboarding / Lock / Tabs（4 个）
- `views/OnboardingOverlay.ets`：首次设主密码
- `views/LockOverlay.ets`：解锁 + 信任设备解锁
- `views/VaultTab.ets`：空间切换 + 搜索 + 类型筛选 + item 列表（连 vaultStore）
- `views/GeneratorTab.ets`：密码 / 词组 / PIN 三模式生成器
- `views/SecurityTab.ets`：弱密码 / 重复 / 泄露审计（本地审计，泄露检测待联网）
- `views/MeTab.ets`：锁定 / 同步入口 / 导入导出 / 重置
- `pages/ItemDetail.ets`：条目详情 + 复制 + 显示/隐藏敏感字段
- `pages/ItemEdit.ets`：7 种类型创建 / 编辑 + 删除

### Phase 4 ✅ TOTP

- `lib/Totp.ets`：自带 SHA-1 / SHA-256 + HMAC + base32 + otpauth 解析（与 phone 字节级一致；SHA-512 暂留接口）
- `pages/TotpScan.ets`：用 `@kit.ScanKit` 系统级二维码扫描 + 手动粘贴 fallback

### Phase 5 ⚠️ Sync 占位 + Transfer ✅

- `pages/Sync.ets`：**占位** —— PAKE 同步协议（cryptocore::sync）需追加 napi 导出 + ArkTS 状态机，未完成
- `lib/Transfer.ets`：明文 JSON 导出 / 导入（picker + fileIo），接入 MeTab

## 待完成（后续迭代）

1. **PAKE 同步协议**（最大块）
   - cryptocore::harmony 追加导出 `SyncPake` / `SyncSession` / `SyncMerge`
   - ArkTS sync-protocol.ets 重写（WebSocket + CBOR）
   - PIN 显示 / 输入 UI
2. **信任设备 HUKS 集成**
   - 申请 `ohos.permission.ACCESS_BIOMETRIC`
   - `huks.generateKeyItem` (AES-256-GCM, requireAuthBeforeUse)
   - `userAuth.authV9` → authToken → `huks.finishSession`
   - 把 `TrustedDeviceHuks.ets` 三个函数填实
3. **泄露检测**：联网调 HaveIBeenPwned API（k-anonymity SHA-1 prefix）
4. **设置项细化**：主密码修改入口、自动锁定时长、剪贴板清空时长

## 字节级一致性

vault file schema 与 phone/desktop 三端完全一致：

| 项 | 字节 / 值 |
|---|---|
| Argon2id 默认参数 | 64 MiB / 3 iter / 4 lanes / 32 byte key |
| KDF salt 长度 | 32 字节 |
| XChaCha20-Poly1305 nonce | 24 字节 |
| Poly1305 tag | 16 字节 |
| KEK wrap AAD | `"zpass:dek"` |
| Verifier AAD | `"zpass:verifier"` |
| Verifier plaintext | `"zpass-vault-verifier-v1"` |
| 信任设备 wrap AAD | `"zpass:trusted-device:v1"` |
| 文件 schema | `"zpass-vault-file-v1"` |

测试向量在 `cryptocore/src/lib.rs` 的 `derive_kek_known_vector_is_stable` 锁定。

## 构建步骤

```sh
# 1. 编译 cryptocore .so（首次或 cryptocore/ 改动后）
export HARMONY_NDK_HOME=$HOME/HarmonyOS/command-line-tools/sdk/default/openharmony/native
cd harmony
task crypto    # → entry/libs/{arm64-v8a,x86_64}/libcryptocore.so

# 2. 一键 build → sign → install → start
task run
```

## 模块边界（与根 AGENTS.md 一致）

- 所有 vault 加密走 `cryptocore`（Rust napi-rs），不另起 JS 兜底
- Random：优先 cryptocore；未加载时回退 `@ohos.security.cryptoFramework`（密码生成器在 vault 未初始化前也能用）
- 信任设备 method 命名：`"huks-harmony"`（与 desktop `dpapi/keychain/libsecret`、phone `keystore-ios/keystore-android` 并列）
