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

### Phase 12 ✅ 登录即下拉云端空间（双向自动镜像，对标 1Password）

修复「登录选择云端同步时，云端已有的空间不在本地创建/同步」的缺口：`CloudService.doReconcile` 此前只做**本地 → 云**单向（按名领养 + 为本地空间建库），漏了 desktop `stores/cloud-mirror.ts` 的**云 → 本地**一步，导致新设备登录后看不到账户已有的保险库。实现方式与 desktop 不完全一致（desktop 在渲染层 store + 其本地新库无默认空间；harmony 在 `CloudService` 单例 + `ensureDefaultsInSnapshot` 恒有默认空间），故按 harmony 实际重写。

- **云 → 本地下拉（核心）**：`doReconcile` 遍历账户云 vault，对未绑定者解密空间名——本地有唯一同名空间则领养（`adoptRemoteVault`），无同名则**新建本地空间并绑定**（`vaultService.createSpace(name, silent=true)` + 绑定，cursor=0 → 随后全量同步把条目灌入新空间）。无名旧 vault 跳过，留设置页手动绑定兜底（与 desktop 一致）。
- **`createSpace` 静默档**：`VaultService.createSpace(name, silent=false)` 新增 `silent`——为 true 时不触发 `fireSpaceMutation('create')`（对应 desktop `createSpaceWithoutAutoLink`）。下拉落地的空间随即绑到**已存在**的云 vault，绝不能再触发自动镜像 mint 新 vault。
- **默认空间空内容守护（与 desktop 的差异）**：本地 → 云一步中，唯一**自动创建**的默认空间（`id='default'`）在账户已有云 vault 且其自身为空时**不上云**，避免新设备的初始默认空间生成垃圾 vault；用户**显式新建**的空间（`id='sp-…'`）不受限，照常镜像（即便为空）；全新/空账户则连默认一并播种。
- **解绑空间不复活（harmony 特有）**：harmony 的 `unlinkSpace` 会保留云端 vault 并 detach 本地空间（desktop 的 detached 仅指「云端 vault 已删」）。step 1 遇到与某 detached 同名的云 vault 时整体跳过，不再自动领养/下拉，尊重显式解绑意图（防把刚解绑的同步以「重复空间」复活）。
- **首次登录焦点切换（1Password 体验）**：`doReconcile` 在首次登录（本地尚无任何绑定）且发生下拉时返回首个下拉空间 id；`reconcileSpaces` 在全量同步**落地后** `maybeFocusPulledSpace` 把激活空间从空的默认切到真实数据空间（仅当前激活空间为空时才切，不抢占用户已有焦点）。

> **验证范围**：纯 ArkTS 逻辑改动，不涉 cargo / Rust（`cryptocore` 未动）。step 1/step 2 决策核（领养 / 下拉新建 / 同名歧义 / 默认守护 / 解绑跳过 / 播种 / 焦点返回）已用等价 JS 模型跑 10 个场景矩阵全通过（fresh 无匹配、默认同名领养、品牌新账户播种、既有账户本地数据、用户空空间、二次解锁稳定、同名双 vault、无名 vault、解绑+活 vault 不复活、解绑不阻塞他者）。仍**无 DevEco SDK / 设备**：登录/解锁触发下拉、条目灌库、焦点切换需真机端到端联调。

### Phase 13 ✅ vault 删除墓碑跨设备传播（主动删除 → 跨端物理删空间）

补齐 Phase 12 遗留的「删除传播」：此前本端删除空间只解绑、保留云端 vault（注「可后续清理」），云端 vault 被其它设备删除时本地也无反应。对接 `zpass_cloud` migration 0004 的 `vault_tombstones`（`seq BIGSERIAL` 单调游标）+ `DELETE /v1/vaults/{id}`（owner 删库写墓碑）+ `GET /v1/vaults/deleted?since=&limit=`（增量拉墓碑）+ SSE `vault_deleted` 事件，实现 desktop `processDeletionTombstones` 的双向能力。

- **emit（本端删空间 → 删云 vault）**：`handleSpaceMutation('delete')` 改为解绑后调 `deleteRemoteVaultBestEffort` 删云 vault（服务端写墓碑）。先 `runSync` 把重指派到 fallback 的条目推上其 vault，再删被删空间的 vault（先保命再删库）。403/404（非 owner / 已删）视终态忽略；网络/500 入 `pendingRemoteDeletes` 队列，reconcile step 0 幂等重试。
- **consume（云 vault 被删 → 本地物理删空间）**：新增 `CloudService.processDeletionTombstones` 作为 `doReconcile` step 0：按 `tombstoneCursor`（单调）增量拉墓碑，命中本地绑定者 → 拆绑定 + 清水位/key + `vaultService.purgeSpace`（HARD 删条目 + 删空间，区别于 `deleteSpace` 的「重指派 fallback」）。无绑定的墓碑只推进游标。
- **实时**：SSE `vault_deleted` 事件 → `kickReconcile`，step 0 立即消费墓碑（跨端即时生效，origin_sid 让删除者自身不收回显）。
- **抗复活加固**：`runSync` 的 404 分支（vault 失踪）除解绑外**追加标记 detached**，杜绝 reconcile step 2 把它当「仅本地空间」重新上云（resurrection）；真「主动删除」由墓碑物理删，「失去访问」走 detached 保留——对应 0004 注释「主动删除 vs 失去访问」的区分。
- **持久化**：`CloudState` 增 `tombstoneCursor: number` + `pendingRemoteDeletes: string[]`（`CloudStorage` 读写归一化，旧状态缺失回退 0/空）；登出清零。
- **客户端线缆**：`CloudClient` 增 `listDeletedVaults(since, limit)`（`deleteVault` 早已存在）+ `DeletedVault`/`DeletedVaultsResponse` 类型，字段名 `vault_id`/`seq`/`deleted_at`/`next_cursor`/`has_more` 与服务端 snake_case 对齐。

> **验证范围**：纯 ArkTS + 既有服务端端点，不涉 cargo / Rust（`cryptocore` 未动）。consume/retry/step1-exclude/游标单调 决策核已用等价 JS 模型跑 7 个场景全通过（命中绑定物理删、未绑定只推游标、已消费 no-op、混合页游标取 max、retry 的 ok/403/0 分类、404 终态、step1 排除待删）；叠加 Phase 12 的 10 场景模型仍全绿。仍**无 DevEco SDK / 设备**：删库写墓碑、跨设备拉取消费、SSE vault_deleted 即时删、404→detached 抗复活需真机端到端联调。

### Phase 14 ✅ 无名云 vault 也能下拉 + 404 删除墓碑感知（用户实测「多空间不下拉」修复）

实测发现：账户里**无名云 vault**（无 meta 名——CLI/e2e 播种、老客户端、desktop `name=""` 旧流程所建）登录后不会下拉到本地（设置页「绑定已有」里只显示为 UUID）。根因：Phase 12 的 `doReconcile` step 1 对无名 vault 直接 `continue` 跳过（沿用 desktop「无名留手动绑定」）。经核对 `sealVaultMeta`/`openVaultMeta` 跨端**字节兼容**（AAD `zpass:vault-meta:v1` + `{name,glyph}` JSON），故非解密 bug，确系这些 vault 本就无 meta。

- **无名 vault 下拉**（`CloudService.doReconcile` step 1）：无名 vault 若**有数据**（`item_count>0`）且 **vault key 可解**，用 vault id 派生的确定性兜底名 `云保险库 <前8位>` 新建本地空间并绑定下拉（跨设备同名 → 不重复建空间）；空的无名 vault（疑似垃圾）仍跳过。先验 `ensureVaultKeyFor` 成功再建空间，避免建出无法同步条目的空壳。
- **404 删除墓碑感知**（`handlePerBindingError` 改 async）：sync 命中 404 时先 `processDeletionTombstones` 区分——有墓碑（owner 主动删）→ 已物理删该空间，收尾返回；无墓碑（被移出 / 瞬时不可见）→ 解绑 + detached 保留。修掉 Phase 13 遗留的「被删 vault 经周期 sync 的 404 把本地默认空间永久 detached、无法再同步」的粗糙边（主动删除现在干净物理删，而非卡在 detached）。

> **验证范围**：纯 ArkTS，不涉 cargo / Rust。无名下拉 / 空跳过 / 密钥不可解跳过 / detached 兜底 / 确定性兜底名不碰撞 / 404 有墓碑→purge、无墓碑→detached 决策核已用等价 JS 模型跑 10 场景全通过。服务端现状经 `docker exec psql` 核对（`vaults`/`vault_tombstones`），确认无名 vault 系无 meta 而非密钥不匹配。真机端到端（无名 vault 落地为「云保险库 xxxxxxxx」空间并同步其条目、404 墓碑物理删）需联调。

### Phase 15 ✅ 重置 / 清空所有数据：覆盖云账户与全部空间（数据管理页）

按用户要求重做 `pages/MeData` 两个危险操作的语义。

- **重置 ZPass = 整机出厂**：`onReset` 在 `vaultStore.reset()`（删主密码 / 空间 / 条目 / 信任设备 key）之外，先 `cloudService.signOut()`——清除本地云账户记录、token、Secret Key、所有空间绑定与同步水位（并 best-effort 吊销当前会话）。修复了此前「重置只删本地 vault 文件，云账户与绑定残留在 `zpass-cloud-v1.json`」的缺口。云端服务器数据不动（可重新登录恢复）。
- **清空所有条目 → 清空所有数据**：`onClearAllData` 删除**所有空间及其全部条目**（`vaultService.purgeAllData`：回到单个空默认空间，保留主密码），不再只逐条删 item。
  - **未登录云账户**：警告 + 确认即清本地。
  - **已登录云账户**：弹浮层**二次验证主密码 + Secret Key**（`vaultService.verifyPassword` 复用信任设备的 KEK→DEK 常量时间比对；`cloudService.verifySecretKey` 去分隔符大写比对），通过后**先删云端所有 owner vault**（`cloudService.clearAllCloudData`，写墓碑 → 跨设备物理删）**再清本地**——云端删除失败即中止、不动本地，避免清空后被下次同步拉回。
  - **有账户但会话未恢复（MFA / 离线）**：提示先登录再清，避免本地清空被同步拉回。
- 复用既有原语：`verifyPassword` 由 `enableTrustedDevice` 抽取共用；浮层 MP/SK 输入沿用 `CloudAccount` 的 TextInput 范式。

> **验证范围**：纯 ArkTS，不涉 cargo / Rust。路由（无账户→本地 / 已登录→云浮层 / 有账户无会话→拦截）、验证门（MP 错 / SK 错均中止）、清空顺序（云删失败→**不**清本地，防 resurrection；全 OK→先云后本地）决策核已用等价 JS 模型跑 8 场景全通过。真机端到端（验证浮层、purgeAllData、clearAllCloudData 删库写墓碑、signOut 吊销）需联调。

### Phase 16 ✅ 登录下拉鲁棒性 + 可见性（用户实测「登录不下拉多空间」跟进）

针对「本地空、登录后云端有多空间却没下拉」的反馈，核查 `doReconcile` step 1 下拉逻辑正确、登录链路（`signIn`/`completeMfa` → `kickReconcile` + `onLogin` → `syncNow`）会触发对账。加固两处易被吞掉的边角并补上可见性：

- **对账重跑（防竞态）** `reconcileSpaces`：新增 `reconcilePending`——对账进行中又收到触发时，结束后 `do/while` 重跑一次。修复「首轮在 vault 锁定期空跑、解锁后到来的 `syncNow` 撞上 `reconciling` 仅补 runSync 而漏掉 doReconcile」的窗口，保证登录后最新一次请求必有一次完整下拉。
- **错误不再静默** `reconcileSpaces`：`doReconcile` 抛错从 `catch {}` 改为写入 `lastError`（同步设置页状态卡已展示），下拉失败可见原因，不再「看起来什么都没发生」。
- **云端概览可见** `pages/CloudSync`：进入页/立即同步后拉 `listRemoteVaults`，状态卡显示「云端 N 个保险库 · M 个未在本地 / 均已同步」，用户可直接判断云端是否有数据、是否已落本地。
- **用户向澄清**：设置页「新建并同步」是**上行**（为本地空间在云端新建一个 vault），不是下拉；下拉是登录 / 进入同步页 / 立即同步时**自动**进行。

> **验证范围**：纯 ArkTS，不涉 cargo / Rust。重跑/错误冒泡/概览为控制流与只读展示，决策核（重跑保证完整对账、错误写 lastError）已审阅。服务端经 `docker exec psql` 核对：当前账户仅 1 个**带名但空**的 vault（非多空间带数据），故实测若「无下拉」高度疑似 **设备运行的是未含 Phase 12/14 下拉代码的旧构建**，或连接了与本地 docker 不同的服务端——需 DevEco 重新构建部署并在同步页查看「云端 N 个保险库」核实。

### Phase 17 ✅ 首次使用即选云同步：不留占位默认空间 + 超额手动指定（对标 desktop bootstrapLocalVault）

对齐两条产品规则。**req 1**：首次使用 app 直接选云同步，不应在本地留一个空的「默认」空间——只用云端已有空间下拉到本地。**req 2**：本地空间数超出账户套餐的云保险库上限时，不自动任选要上云的空间，留用户在同步页手动指定。参照 desktop：`SignInPage.bootstrapLocalVault` 首启 `initialize` 后只镜像云端空间，且 desktop 的 `initialize` **根本不建默认空间**（渲染层 spaces store 起始为空）；harmony 的 `VaultService.initialize` 恒建 `id='default'` 空间，故需在下拉后清除该占位符。

- **占位默认空间标记**：`CloudAccount.ensureLocalVault` 仅在 `!st.initialized`（确系为云登录新建本地库）分支 `initialize` 后调 `CloudService.markFreshLocalVault()` 置 `freshLocalVault`。已初始化的本地用户后补登录云端**不**置位，其既有空间（含默认）不受影响。
- **下拉后清除占位默认（req 1）**：`doReconcile` 一次性消费 `freshLocalVault`；当「首登（`bindings.size===0`）+ 确有云端下拉新建空间（`firstPulledSpaceId` 非空）」时置 `removeDefaultAfterFocus`。`reconcileSpaces` 在 `maybeFocusPulledSpace` 切焦点**后**调 `cleanupPlaceholderDefault`：防御式校验（默认空间仍存在、**未绑定**、**为空**、**非当前激活**、**非唯一空间**）全过才 `purgeSpace('default')`。
  - 同名领养例外：云端有同名 `默认` vault → step 1 领养本地默认空间（绑定），`firstPulledSpaceId` 不置、默认已绑定 → 清除被跳过，默认空间作为真实云空间保留。
  - 全新注册（云端空）：`firstPulledSpaceId` 不置 → 不清除；默认空间照常上云成为首个云保险库（对标 desktop 新账户走 onboarding 命名首空间 → 自动上云）。
- **超额手动指定（req 2）**：`doReconcile` step 2 改为先收集本轮应上云的候选空间，再 `fetchVaultQuota`（`max_vaults` 维度：`limit`/`current`）预判剩余额度。**候选数 > 剩余额度** → 全部标记 `overQuotaSpaces`、不自动建任何 vault，留用户在 `pages/CloudSync` 用每空间「新建并同步 / 绑定已有」**手动指定**（UI 既有，无需改）；额度不可知（离线 / 老服务端）→ 回退「逐个尝试、撞 403 才停」旧行为。每轮对账重算 `overQuotaSpaces`（额度释放后旧超额空间可重新上云）。

> **验证范围**：纯 ArkTS，不涉 cargo / Rust（`cryptocore`/`zpass_cloud` 未动）。环境无 `DEVECO_SDK_HOME`/`HARMONY_NDK_HOME`、`hvigorw`/`ohpm` 不可用，无法 hvigor 构建/真机跑。决策核（首登下拉清默认 / 注册保默认 / 同名领养保默认 / 既有用户非 fresh 全保留 / 超额全标记手动 / 恰好够上传 / 额度未知 try-all / 剩余为 0 预判 / 无名 vault 下拉清默认）已用等价 JS 模型跑 9 场景全通过。真机端到端（首登清占位默认、超额时同步页手动指定上云）需 DevEco 联调。

### Phase 18 ✅ 锁屏/生物解锁后云会话自动恢复（用户实测「每次进云账户都要重输主密码」跟进）

针对「锁屏后再次进入云账户页面需手动输入主密码、不自动同步」的反馈。根因：云会话恢复只挂在**主密码解锁**路径（`VaultStore.unlock` → `cloudOnUnlocked(pw)`），且 `restoreSession` 直接拿**本地解锁密码**重跑 SRP——信任设备/生物解锁（`tryAutoUnlock`）压根不触发恢复，且本地解锁密码 ≠ 云密码时恢复必 401 自禁用。对齐 desktop `cloudservice.go`「DEK 包裹云主密码」方案：

- **DEK 包裹云主密码**：`VaultService.sealCloudCredential/openCloudCredential`（AAD `"zpass:cloud-cred:v1"`，与 desktop `cloudCredAAD` 同义）。登录成功后 `CloudService.establishSession` 把云主密码用本地 DEK 封装，随 `persist` 落 `CloudStorage` 的 `account.wrappedPassword`。密文仅在 vault 解锁后可解（DEK 受主密码或信任设备 HUKS 保护），非明文主密码，零知识不变量不破。
- **解锁优先用封装密码**：`restoreSession` 先 `unwrapCloudPassword` 取真实云密码登录，失败且用户另键入主密码时回退重试；兼容「本地解锁密码 ≠ 云密码」。`onVaultUnlocked` 放开 `!masterPassword` 守卫——无主密码（生物解锁）只要有封装密码即可恢复。
- **生物解锁接线**：`VaultStore.tryAutoUnlock` 信任设备解锁成功后 `cloudOnUnlocked('')`，触发同一恢复路径（EntryAbility 切前台、LockOverlay 自动/手动生物解锁均经此）。
- **进页面兜底**：`CloudService.ensureRestored` + `CloudAccount.initState` 调用——已解锁但会话未恢复（冷启动钩子竞态）时进页面静默重建，幂等。
- **平滑迁移**：fix 前登录的存量用户（`wrappedPassword` 为空）首次仍需一次主密码解锁/手动恢复，此时补存封装密码；之后生物解锁即自动恢复。

> **验证范围**：纯 ArkTS（`cryptocore`/`zpass_cloud` 未动）。环境无 `DEVECO_SDK_HOME`/`HARMONY_NDK_HOME`，无法 hvigor 构建/真机跑。恢复决策核（封装优先→失败回退键入、无主密码靠封装、生物解锁触发、幂等兜底）已审阅；真机端到端（背景锁→生物解锁→进云账户页已登录免输密码）需 DevEco 联调。

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
| 云凭据 wrap AAD | `"zpass:cloud-cred:v1"` |
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
