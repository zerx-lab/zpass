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

### Phase 9 ✅ 云端远程同步（client；对接 zpass_cloud，借鉴 desktop）

补齐 phone/desktop 的**云端远程同步**客户端角色：鸿蒙连 Rust `zpass_cloud`（axum `/v1`）做零知识 E2EE 同步，逐层对照 desktop `internal/cloud` + `internal/cloudcrypto` + `internal/services/cloudsync.go`。

- **cryptocore napi 扩展**（`src/harmony.rs`，薄包装既有 `kdf2`/`srp`/`keyset` 字节权威实现）：新增 `deriveAuk` / `deriveSrpX`（2SKD，Argon2id 重活走 AsyncTask）、`srpRegister` / `srpClientStart` / `srpClientFinish`（SRP-6a；M2 校验在 ArkTS 侧 SHA-256(PAD(A)‖M1‖K)）、`keysetGenerate` / `sealToPubkey` / `openWithPrivkey`（X25519 sealed-box）。`index.d.ts` + `RustCryptoCore.ets` 补类型与封装。
- **ArkTS 云栈**（`entry/.../lib`）：
  - `CloudClient.ets`：`/v1` typed 线缆客户端（register / login·start·finish / keyset / vaults / members·self / snapshot / changes / entitlements），Bearer 鉴权，CAS 冲突走 HTTP 200，base64 std —— 逐字段对齐 desktop `client.go` json tag；不持有密钥。
  - `CloudCrypto.ets`：Z1 Secret Key 编解码、2SKD 编排、keyset/per-vault key 包裹、`content_hash = hex(HMAC-SHA256(vaultKey, canonicalJSON)[:16])`、web_vault `ItemRecord` 转码（信封键 / `ssh↔sshKey` / 字段重命名 / hyphenless↔连字符 id / manifest 哨兵跳过）。
  - `CloudSync.ets`：全量对账引擎（= desktop `syncVaultFull`，每次同步跑一次，无 per-item 水位、天然正确）—— 拉全量 snapshot → LWW `cloudDecide`（按 updatedAt；同戳异 hash = `concurrent_edit`；删 vs 改 = `delete_vs_edit`）→ 拉取(ingest)/推送(CAS + 冲突桥接)/捕获冲突。
  - `CloudService.ets`：`@ObservedV2` 服务 + 反应式状态合一（仿 `SyncServer.ets`）：注册 / SRP 登录 / 会话恢复 / 登出、keyset 收发、云 vault 新建·绑定、`syncNow` + 周期(90s) + 解锁自动 + 编辑去抖触发、冲突解决。会话密钥仅内存、锁定即清。
  - `CloudStorage.ets`：`zpass-cloud-v1.json`（沙箱）持久化 baseUrl/email/Secret Key/JWT/绑定 + cursor；**不**存主密码 / 账户私钥 / vault key。
- **页面/接线**：`pages/CloudAccount.ets`（注册 / 登录 / 恢复 / 登出 + Secret Key 一次性备份）+ `pages/CloudSync.ets`（新建·绑定云 vault / 立即同步 / 状态 / 冲突逐条决策）；`main_pages.json` 注册；MeTab「云同步」入口；`VaultStore` 加云钩子（解锁自动恢复会话 + 同步、锁定清密钥；钩子由 `CloudService.hydrate` 注册，`VaultStore` 不反向 import 避免环）；`Index` 启动调 `cloudService.hydrate()`。`module.json5` 的 `INTERNET` 权限已具备，无新增。
- **零知识不变量**：主密码 + Secret Key + AUK + SRP-x + 账户私钥 + per-vault key 永不出设备；服务端只见 SRP verifier/salt、AUK 包裹的账户私钥、账户公钥包裹的 vault key、XChaCha20-Poly1305 条目密文（aad=连字符 UUID）、HMAC content-hash。本地 DEK 与云端 vault key 两条独立通道，仅在明文 payload 转码边界相遇。

> **验证范围（重要）**：cryptocore `cargo test --lib`（63 单测全过）+ `cargo check --features harmony` 通过。但**本环境无 DevEco SDK / OHOS NDK / 设备**：ArkTS 未经 `hvigorw` 编译、未运行时联调；落地前需 `task crypto`（重出含新 napi 的双 ABI .so）+ `task run` 真机/模拟器验证 登录·绑定·拉推·冲突 端到端。

### Phase 10 ✅ 增量同步 + SSE 实时（云同步对齐 desktop 完整能力）

把 Phase 9 的「每次全量对账」升级为 desktop `cloudsync.go` 的双路径 + 实时，逐项对照 `cloudsync.go` / `events.go` / `cloudrealtime.go` / `cloudvaultdb.go`。本阶段纯 ArkTS，无新增 napi。

- **per-item 水位**：`CloudStorage` 增 `syncState: Record<localId, {seq, syncedHash, syncedAt, deleted}>`（对应 desktop `cloud_item_state`，按本地 id 键）；`CloudService` 内存持 `Map`，随每次同步整体持久化。
- **双路径**（`CloudSync.ets`，共享 LWW 决策核 `applyDecision`）：
  - `syncVaultFull`：cursor=0 拉全量、重建全部水位（首次绑定 / 手动 / SSE resync / 6h 周期 / 410 恢复）。
  - `syncVaultIncremental`：拉 `seq>cursor` 的 delta（含墓碑）+「内容哈希短名单」——只对 `updatedAt` 推进过 `synced_at` 的本地行解密 + 算哈希，未变行零解密。墓碑步骤 + live 工作集（delta-live ∪ 候选）。
  - base_seq 取 `delta.seq ?? state.seq ?? 0`；cursor 进到 snapshot 高水位（绝不进到自推 seq）；任一步抛错则不持久化 cursor（幂等重试）。
  - **410 Gone**：清空水位 + cursor 归零 → 全量重建。
  - CAS 冲突为**终态 LWW**（拉对端 / 同内容收敛 / 记冲突），常规推送不重试；仅「采用本端」`forcePushLocal` 重试 5 次。
- **SSE 实时**（`CloudClient.openEventStream` + `CloudService` realtime）：`GET /v1/events`（`requestInStream` 流式 + SSE 行解析 + 75s 静默看门狗）；`change`→去抖增量、`resync`→去抖全量、`revoked`→拆会话；断线指数退避（1s..2m）+ 抖动，连接存活 ≥30s 重置退避，服务端 15min 轮转即重连，401 终止。会话建立 / 绑定时启，锁定 / 登出 / 401 停。
- **触发合流**：手动 = 全量；登录 / 绑定 / 解锁恢复 = 全量；周期 90s（每 6h 升级全量）；本地编辑（`VaultService` 用户改动钩子，**排除** sync 摄取以免回环）+ SSE change = 2s 去抖增量。全部经 `syncing` 守护串行，进行中触发记 pending、结束补跑一次。
- **冲突累积**：增量同步按 localId upsert 合并冲突（不丢未解决项），全量同步以全量结果整体替换。

> **验证范围**：本阶段**纯 ArkTS**（无新增 napi / .so / 权限），复用 Phase 9 原生 + 系统 http，`cargo` 不涉及。仍**无 DevEco SDK / 设备**：未经 `hvigorw` 编译、未运行时联调；需真机验证 增量 delta / SSE 推送 / 断线重连 / 冲突合并 端到端。

### Phase 11 ✅ 自定义字段写端对齐 + 云同步加固（会话吊销 / HUKS / MFA）

- **自定义字段写端**：`CustomFields.serializeCustomFields` 改为返回**原生数组**（元素 {id,type,name,value}）而非 `JSON.stringify` 字符串，与 phone/desktop 写端一致。读端 `parseCustomFields` 早已双向兼容，唯一写点 `ItemEdit.collectFields`（存入 `Record<string,Object>`）无需改。副作用收益：云同步的 web_vault `_customFields` 现以原生数组上行，跨端（desktop / web_vault）读取与 content_hash 对齐。
- **登出服务端吊销**：`CloudService.signOut` 先解析自身 JWT 的 `sid`（HS256 三段式，base64url 解 payload 段、不验签）→ `CloudClient.revokeSession` 调 `DELETE /v1/sessions/{sid}`（best-effort，离线则忽略）。服务端 TenantConn 每请求校验 `user_sessions.revoked_at`，吊销后 token 立即失效。
- **HUKS 包裹敏感数据**：新增 `CloudSecretsHuks.ets`（AES-256-CBC + PKCS7、**无** USER_AUTH 的设备绑定 key，供自由读写），把 Secret Key + token 加密成 blob 存进 `CloudStorage.account.secrets`（base64），明文 secretKey/token 字段留空；HUKS 不可用（模拟器）时自动退化为明文。`CloudService` 缓存 `secretsBlobB64`，仅登录/恢复（secretKey/token 变更）时 `refreshSecretsBlob` 重算，每次同步的 cursor/syncState 持久化复用缓存、不重复加密；登出删 HUKS key。
- **MFA（TOTP）登录**：`/v1/auth/login/finish` 返回 `mfa_required + mfa_token`（SRP 的 M2 已在此前验过）时，`signInInternal` 先派生 AUK、暂存 `{mfaToken, sk, auk, …}` 待验上下文（持 auk 跨越验证码输入，锁定/登出/建会话即抹除）并置 `@Trace mfaRequired`；UI（`CloudAccount.mfaCard`）收 6 位 TOTP → `completeMfa` 调 `POST /v1/auth/login/mfa {mfa_token, code}` 拿 `session_token` → 用暂存 auk 恢复 keyset → 建会话。410=超时清上下文重登、401=验证码错误保留上下文可重试、429=限流提示。解锁自动恢复遇 MFA 账户静默放弃（每次都需 TOTP，转手动登录）。

> **验证范围**：自定义字段写端为纯 ArkTS 逻辑改动；云加固复用既有 HUKS（信任设备已验证的 init/finish 会话流）+ 系统 http，`cargo` 不涉及。仍**无 DevEco SDK / 设备**：HUKS 云密钥读写、JWT sid 自吊销、MFA 端到端需真机联调。

## 待完成（后续迭代）

- **主题持久化**：phone 不持久化（每次启动跟随系统）；harmony 当前一致，未来可走 `@ohos.data.preferences`
- **运行时联调**：连真机/模拟器跑 `task run`，验证 Phase 8 全部页面渲染交互 + 同步服务端往返（见上「验证范围」）。

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
- 云同步（远程 E2EE，Phase 9 起）：走 `CloudService.ets` + `CloudClient.ets`（zpass_cloud `/v1`）；SRP-6a / 2SKD / X25519 sealed-box 全走 cryptocore napi（`deriveAuk` / `deriveSrpX` / `srp*` / `keyset*`），与 LAN 同步（`SyncProtocol` / `SyncServer`）是两条独立通道。
