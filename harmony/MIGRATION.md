# ZPass HarmonyOS —— phone 迁移说明

本文档记录 `phone/`（Expo React Native）→ `harmony/`（HarmonyOS Next / ArkTS）的功能迁移。源文件 ~16.3k 行 phone TS/TSX，本次迁移产出 ~8k 行 ArkTS + napi-rs 桥。

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
- `lib/VaultService.ets`：Initialize / Unlock / Lock / ChangeMasterPassword / Space CRUD / Item CRUD / 信任设备
- `lib/Spaces.ets`、`lib/CustomFields.ets`、`lib/Format.ets`、`lib/Password.ets`：纯逻辑工具
- `state/VaultStore.ets`：`@ObservedV2 / @Trace` 反应式状态（替代 React Context）
- `lib/TrustedDeviceHuks.ets`：HUKS 集成（生物认证 + 设备绑定 AEAD）

### Phase 3 ✅ 主 UI

- `pages/Index.ets`：路由壳，按 status 切换 Onboarding / Lock / Tabs（4 个）
- `views/OnboardingOverlay.ets`：**两步引导**（设主密码 → 给默认空间命名），与 phone 一致
- `views/LockOverlay.ets`：解锁 + 信任设备解锁；头像走 SpaceAvatar
- `views/VaultTab.ets`：空间切换 + 搜索 + 类型筛选 + item 列表；顶栏头像走 SpaceAvatar
- `views/GeneratorTab.ets`：密码 / 词组 / PIN 三模式生成器
- `views/SecurityTab.ets`：弱密码 / 重复 + HIBP 泄露检测
- `views/MeTab.ets`：用户卡 / 改主密码 / 生物解锁 / 同步入口 / 主题切换 / 导入导出 / 重置 / 条目统计 / 关于
- `pages/ItemDetail.ets`：条目详情 + 复制 + 显示/隐藏敏感字段
- `pages/ItemEdit.ets`：7 种类型创建 / 编辑 + 删除
- `components/SpaceAvatar.ets`：空间头像统一组件，与 phone/components/space-avatar.tsx 行为对齐

### Phase 4 ✅ TOTP

- `lib/Totp.ets`：自带 SHA-1 / SHA-256 + HMAC + base32 + otpauth 解析（与 phone 字节级一致；SHA-512 暂留接口）
- `pages/TotpScan.ets`：用 `@kit.ScanKit` 系统级二维码扫描 + 手动粘贴 fallback
- `pages/TotpDetail.ets`：TOTP 大屏详情页（大号代码 + 周期进度条 + 元信息 + 30s 临时复制），与 phone/app/totp/[id].tsx 1:1

### Phase 5 ✅ 剪贴板 / 泄露检测 / 设置项

- `lib/Clipboard.ets`：剪贴板封装（`@ohos.pasteboard` + `@ohos.vibrator`）。`copyText` / `copyEphemeral` 与 phone/lib/clipboard.ts 一致；30s 后剪贴板内容未变则清空
- `lib/Breach.ets`：HIBP k-anonymity 泄露检测（`cryptoFramework.createMd('SHA1')` + `@ohos.net.http`）。内存缓存 + 100ms 节流 + 8s 超时 + Add-Padding 过滤；vault 锁定时清缓存
- `state/VaultStore.lock()`：触发 `clearBreachCache()`，与 phone 锁定即清扫描结果一致
- `views/SecurityTab.ets`：接入 HIBP 扫描按钮 + 命中列表 + 重新扫描；锁屏即清 UI 状态
- `views/MeTab.ets`：新增"修改主密码"全屏 sheet + 主题三档浮层（跟随系统 / 深色 / 浅色） + UserCard + 条目类型统计 + 关于版本

### Phase 6 ✅ Sync (LAN client) + Transfer

- `cryptocore/src/lib.rs`：新增 3 个公共 API
  - `argon2id_raw(password, salt, ...)`：salt / keyLen 不限长版本（sync session key 派生用，salt = baseSalt ‖ sid ‖ cn ‖ sn = 64 字节）
  - `seal_aead_with_nonce(key, plaintext, aad, nonce)` / `open_aead_with_nonce(...)`：调用方提供 24-byte nonce 的 XChaCha20-Poly1305
- `cryptocore/src/harmony.rs`：对应 3 个 #[napi] 包装（`argon2idRaw` 走 AsyncTask）
- `cryptocore` `cargo test --lib` 46 个测试全过；OHOS arm64-v8a 重新 cross-compile 通过；新 .so 已拷到 `harmony/entry/libs/arm64-v8a/`
- `harmony/entry/src/main/cpp/types/libcryptocore/index.d.ts`：补 3 个新 API 类型声明
- `harmony/entry/src/main/ets/lib/RustCryptoCore.ets`：补 3 个新封装函数
- `harmony/entry/src/main/ets/lib/VaultService.ets`：新增 `ingestForeignPayload(id, payload, createdAt, updatedAt)` —— LWW 策略，与 phone 字节级一致
- `harmony/entry/src/main/ets/lib/SyncProtocol.ets`：完整 LAN 同步 client（~700 行；与 phone/lib/sync-protocol.ts 1:1）
  - `SyncSession`：dir + 7-byte BE counter nonce + `sealJSON` / `openJSON`
  - `connectAndSync(baseUrl, pin)`：pair → confirm → manifest → fetch → push → report-conflicts → poll-resolutions 全流程
  - `mergeManifests`：与 desktop `mergeManifests` 字节级一致
  - HMAC-SHA256：基于系统 `cryptoFramework` SHA-256 手写 RFC 2104（避开 OHOS HMAC SymKey 转换链）
  - HTTP：`@kit.NetworkKit` 的 `http.createHttp()`；二进制走 `expectDataType=ARRAY_BUFFER`
  - `parseSyncQRPayload(payload)`：解析 `zpass-sync://host:port?pin=` URI
- `harmony/entry/src/main/ets/pages/Sync.ets`：UI（~480 行）—— IP / 端口 / PIN 6 格输入 + 粘贴 QR 自动填充 + 进度卡 + 结果卡 + 错误卡，与 phone/app/sync.tsx 行为对齐
- `lib/Transfer.ets`：明文 JSON 导出 / 导入（picker + fileIo），接入 MeTab

## 权限

`entry/src/main/module.json5` requestPermissions：

| 权限 | 用途 |
|---|---|
| `ohos.permission.ACCESS_BIOMETRIC` | 信任设备 / 生物解锁 |
| `ohos.permission.VIBRATE` | 剪贴板复制 / 触感反馈 |
| `ohos.permission.INTERNET` | HIBP 泄露检测网络请求 |

### Phase 7 ✅ SpacesModal / VaultTab swipe / x86_64 .so

- `lib/VaultService.toggleFavorite(id)`：合并 fields 翻转 favorite，与 phone updateItem({favorite:!cur.favorite}) 等价
- `state/VaultStore.toggleFavorite(id)`：包装 + refresh items
- `views/MeTab` 新增 SpacesModal（用户卡 onClick 触发）：
  - 空间列表（SpaceAvatar + 名 + #order + 当前 badge）
  - 「+」新建按钮 → spacePromptOverlay（输入名）
  - 长按 → `promptAction.showActionMenu`（切换 / 重命名 / 删除）
  - 删除前 `promptAction.showDialog` 确认 + 至少保留 1 个的护栏
- `views/VaultTab` 新增 swipeAction 右滑暴露 3 个动作：收藏 / 编辑 / 删除
  - 列表项在 favorite=true 时显示 `★` 标记（与 phone Badge "2FA" 同类位置）
  - 删除前 confirm 对话框，与 phone Swipeable 行为一致
- `cryptocore` x86_64 OHOS .so：用 `CRYPTOCORE_OHOS_ABIS=x86_64 bash cryptocore/scripts/build-harmony.sh` 编译，630 KB，部署到 `harmony/entry/libs/x86_64/`，HarmonyOS 模拟器可用

### Phase 8 ✅ 全量页面对等 + 同步服务端角色

目标升级：从「核心功能可用」推进到「**每个页面与 phone 功能 + UI 布局一致**」，并补齐 phone 的同步**服务端**角色。以 14 个页面对的逐页审计（见 `MIGRATION-PARITY-AUDIT.md`）为驱动，146 项差距按"缺功能/缺UI/布局偏差/可接受适配/设计违例"分诊后逐项落地。

- **设计基础**
  - `theme/Tokens.ets` LIGHT_PALETTE 对齐 phone（iOS 系统色：danger `#ff3b30` / warn `#ff9500` / ok `#34c759` / info `#007aff` / text·accent `#000`）；深色两端早已一致。
  - 图标系统：`resources/base/media/` 新增 **57 个 Material Symbols rounded 单色 SVG**（`ic_*.svg`），统一 `Image($r('app.media.ic_*')).fillColor(zc.*)`。清除所有页面残留的 unicode-as-icon 技术债（`★ ＋ › • ✓ × ••••` 等 → 图标 / `LoadingProgress` / 自绘点阵）。
- **页面对等（12 个已有页）**：VaultTab（收藏 chip / 2FA·泄露 badge / 强度条 / FAB / swipe 图标）、GeneratorTab（批量去重生成 / 字符着色 / 保存到库 / 复制反馈）、SecurityTab（综合评分 hero / StatTile / 行动建议 / 强度直方图 / HIBP）、MeTab（图标行 / 让别人连我入口）、Onboarding（实时校验 + 键盘提交）、Lock（居中 + 反应式生物按钮）、ItemEdit（自定义字段 / TOTP·密码预填）、ItemDetail（实时 TOTP / 强度 / 自定义字段 / 复制）、TotpDetail、Sync、TotpScan（扫码→编辑表单流程）、Index（tab 壳 + 启动水合）。
- **共享层**：`VaultStore.hydrated`、`PassGen.generateUniqueBatch` + `GenOptions.pronounceable`、`VaultService.nextTimestamp`、`CustomFields.parseCustomFields` 跨端兼容（兼容 phone/desktop 的原生数组与本端 JSON 字符串两种 `_customFields` 形态）。
- **同步服务端角色（新增，phone sync-host / sync-conflicts 对等）**
  - `cryptocore`：新增内部 feature `lan-server`（`tiny_http` + `if-addrs`），由 `android` 与 `harmony` 共同启用；抽出 `src/lan_transport.rs` 传输层（android.rs 重构复用）；`src/harmony.rs` 新增 napi **ThreadsafeFunction 反向回调桥**（`registerSyncRequestHandler` / `startSyncServer` / `stopSyncServer` / `respondSyncRequest` / `isSyncServerAvailable`），与 android.rs 的 JNI 桥同构。`cargo check --features harmony` 通过，48 单测全过（46 原 + 2 lan_transport 往返），双 ABI OHOS .so 重新交叉编译部署。
  - `lib/SyncServer.ets`：`@ObservedV2` 单例协议驱动，逐端点忠实移植 `phone/lib/sync-server.ts`（pair/confirm/manifest/fetch/push/commit/report-conflicts/poll-resolutions + 冲突镜像 + applyMerge），复用 `SyncProtocol.ets` 原语（已补 export）。
  - `pages/SyncHost.ets` + `pages/SyncConflicts.ets`：两整页 UI；`main_pages.json` 注册；`module.json5` 增 `GET_NETWORK_INFO`；MeTab「让别人连我」入口。

> **验证范围（重要）**：本阶段所有产物**编译通过**（`hvigorw assembleHap` 全绿）+ Rust `cargo check/test` + 交叉编译 + .so 符号在位。但**本环境无设备**，以下为**运行时未验证**项，需真机/模拟器联调：所有页面的实际渲染与交互、以及同步服务端的 napi TSFN 反向回调在 ArkVM 上的真实投递与 LAN 端到端往返。

## 待完成（后续迭代）

- **主题持久化**：phone 不持久化（每次启动跟随系统）；harmony 当前一致，未来可走 `@ohos.data.preferences`
- **运行时联调**：连真机/模拟器跑 `task run`，验证 Phase 8 全部页面渲染交互 + 同步服务端往返（见上「验证范围」）。
- **自定义字段写端格式**：本端 `_customFields` 受 `ItemFields = Record<string,string>` 约束写为 JSON 字符串，phone/desktop 写为原生数组；读端已双向兼容，写端完全对齐需后续统一字段模型。

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
- HIBP SHA-1 / sync SHA-256：走 `@ohos.security.cryptoFramework` 系统级算法（不引入 @noble JS 兜底）
- Sync 协议字节：Argon2id + XChaCha20-Poly1305 全部走 cryptocore；HMAC-SHA256 走手写 RFC 2104（基于系统 SHA-256）；CBOR 不用（phone 实际协议是 JSON，cryptocore::sync SPAKE2 模块未用到）
- Sync 角色：**客户端 + 服务端均支持**（Phase 8 起）。客户端走 `SyncProtocol.ets::connectAndSync`；服务端走 `SyncServer.ets` + cryptocore `lan-server` feature 的 tiny_http 监听 + napi TSFN 反向回调。早期文档「仅客户端」的说法已过时。
- 信任设备 method 命名：`"huks-harmony"`（与 desktop `dpapi/keychain/libsecret`、phone `keystore-ios/keystore-android` 并列）
