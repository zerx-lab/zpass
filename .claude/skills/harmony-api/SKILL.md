---
name: harmony-api
description: 在 harmony/ 子项目调用系统能力、配置权限、或新增原生(NAPI)API 前调用。覆盖 Stage 模型与 UIAbility 生命周期、module.json5 权限配置、本项目所用 12 个 Kit(剪贴板/加密/文件/网络/HUKS/生物认证/扫码等)的真实用法、NAPI 原生桥(libcryptocore.so)链路，以及 BusinessError/hilog 运行时约定。
---

# HarmonyOS 系统 API 开发

本 skill 是 ZPass `harmony/` 子项目调用系统能力的权威范式。所有 import 路径、API、字段
都取自项目真实代码与本地 SDK 声明，照抄优先于凭记忆。

## 一、何时用本 skill

满足任一条件即应先读本 skill：

- 要在 ArkTS 里调用系统能力：剪贴板、加密、文件读写、网络、HUKS、生物认证、扫码、振动等
- 要配置或申请权限（改 `module.json5` 的 `requestPermissions`，或运行时弹权限框）
- 要新增 / 修改原生 NAPI API（动 `cryptocore/src/harmony.rs`、`.d.ts` 声明、`oh-package.json5`）
- 要处理 UIAbility 生命周期、窗口沉浸式、系统栏、安全区
- 遇到 `BusinessError` 错误码、`hilog` 日志、`async` 与原生异步的映射问题

## 二、Stage 模型与工程结构

本项目是 **Stage 模型**（`entry/build-profile.json5` 的 `"apiType": "stageMode"`），
单 `entry` 模块（HAP），`module.json5` 里 `"type": "entry"`、`mainElement: "EntryAbility"`。

编译目标（以 `harmony/build-profile.json5` 的 `products[0]` 为准，不要写错）：

- `targetSdkVersion`: **6.0.0(20)** — 即 API 20
- `compatibleSdkVersion`: **5.0.0(12)** — 即 API 12，最低兼容
- `runtimeOS`: `HarmonyOS`

注意：`harmony/.sdk-ref/sdk-api/` 下的 `.d.ts` 声明取自本地已装的 **API 24** SDK，**仅供查阅
签名与 import 路径，不是编译目标**。写代码时不要因为某 API 在 API 24 声明里存在就假设它在
API 12 可用；拿不准时以本项目已实际调用过的 API 为准。

关键工程文件：

- `harmony/build-profile.json5` — 应用级编译目标 / product
- `harmony/entry/build-profile.json5` — 模块级 `apiType` / `nativeLib`（把 `entry/libs/<arch>/*.so` 打入 HAP）
- `harmony/entry/oh-package.json5` — 模块依赖（含 `libcryptocore.so` 的 `file:` 依赖）
- `harmony/oh-package.json5` — 工程级 devDependencies（hvigor / hypium）
- `harmony/entry/src/main/module.json5` — abilities / pages / requestPermissions
- `harmony/entry/src/main/resources/base/profile/main_pages.json` — 路由页面列表

字体：本项目实际字体是 `'HarmonyOS Sans'` / `'HarmonyOS Sans Condensed'`。
（Geist 是 phone(RN) 端 token，**勿带入 harmony**。）

## 三、UIAbility 生命周期与 context

入口 `harmony/entry/src/main/ets/entryability/EntryAbility.ets`，`extends UIAbility`，
生命周期顺序：`onCreate` → `onWindowStageCreate` → `onForeground` ↔ `onBackground` →
`onWindowStageDestroy` → `onDestroy`。

import 行（真实）：

```ts
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { display, mediaquery, window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
```

### context 与 filesDir 写入 AppStorage

`onCreate` 里把沙箱 `filesDir` 写进 AppStorage，供 VaultStorage / TrustedDeviceHuks 读取
（OHOS 5+ 沙箱路径可变，禁止硬编码）：

```ts
onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
  const ctx = this.context;
  AppStorage.setOrCreate<string>('filesDir', ctx.filesDir);
}
```

下游用 `AppStorage.get<string>('filesDir')` 取回（见 VaultStorage.ets / TrustedDeviceHuks.ets）。

### 加载页面

`onWindowStageCreate` 里 `windowStage.loadContent('pages/Index', cb)`，`pages/Index` 必须
在 `main_pages.json` 的 `src` 数组里登记，否则路由失败。

### 沉浸式 / 系统栏 / 安全区（边到边）

四步（`applyImmersive`）：

1. `mainWin.setWindowLayoutFullScreen(true)` — 窗口扩展到状态栏 / 导航栏区域
2. `mainWin.setWindowSystemBarProperties({...})` — 系统栏背景透明、按主题设前景色
3. `win.getWindowAvoidArea(type)` 取避让区，换算成 vp 写进 `safeAreaState`
4. `mainWin.on('avoidAreaChange', cb)` 订阅横竖屏 / 折叠态切换

真实片段：

```ts
const mainWin = windowStage.getMainWindowSync();
mainWin.setWindowLayoutFullScreen(true).catch((err: BusinessError) => {
  hilog.error(DOMAIN, TAG, 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(err));
});
mainWin.setWindowSystemBarProperties({
  statusBarColor: '#00000000',
  statusBarContentColor: fg,          // 暗底白前景 / 亮底黑前景
  navigationBarColor: '#00000000',
  navigationBarContentColor: fg,
});
// avoidArea：window API 返回 px，ArkUI 单位是 vp，要用像素密度换算
const density = display.getDefaultDisplaySync().densityPixels || 1;
const area = mainWin.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
safeAreaState.top = area.topRect.height / density;
mainWin.on('avoidAreaChange', (data) => {
  if (data.type === window.AvoidAreaType.TYPE_SYSTEM) {
    safeAreaState.top = data.area.topRect.height / density;
  } else if (data.type === window.AvoidAreaType.TYPE_KEYBOARD) {
    safeAreaState.keyboard = data.area.bottomRect.height / density;
  }
});
```

避让区类型用到：`TYPE_SYSTEM`（状态栏）、`TYPE_NAVIGATION_INDICATOR`（底部导航条）、
`TYPE_KEYBOARD`（软键盘）。

安全区状态走 `@ObservedV2` 单例（`state/SafeArea.ets`），不是 AppStorage：

```ts
@ObservedV2
export class SafeAreaState {
  @Trace top: number = 0;
  @Trace bottom: number = 0;
  @Trace keyboard: number = 0;   // 键盘占据高度(vp)，不弹时 0
}
export const safeAreaState: SafeAreaState = new SafeAreaState();
```

页面里用 `@Local safeArea: SafeAreaState = safeAreaState;`，再 `.padding({ bottom: this.safeArea.keyboard })`。
原因：`@StorageProp` 是 ArkUI V1 装饰器，不能用在 `@ComponentV2` 里；本项目全量 V2。

### 跟随系统暗 / 亮模式

`mediaquery.matchMediaSync('(dark-mode: true)')` 拿初值 + `listener.on('change', cb)` 持续同步，
驱动 themeStore，再回调刷新系统栏前景色。`onDestroy` 里 `this.darkModeListener?.off('change')`。

## 四、module.json5 配置与权限

### 静态声明（已申请，照抄即可）

`module.json5` 的 `requestPermissions`（真实）：

```json5
"requestPermissions": [
  {
    "name": "ohos.permission.ACCESS_BIOMETRIC",
    "reason": "$string:permission_biometric_reason",
    "usedScene": { "abilities": ["EntryAbility"], "when": "always" }
  },
  { "name": "ohos.permission.VIBRATE" },
  { "name": "ohos.permission.INTERNET" }
]
```

权限用途映射：

| 权限 | 用途 | 触发场景 |
|---|---|---|
| `ohos.permission.ACCESS_BIOMETRIC` | 信任设备 / 生物解锁 | TrustedDeviceHuks（HUKS+UserAuth） |
| `ohos.permission.VIBRATE` | 剪贴板复制触感反馈 | Clipboard.lightHaptic |
| `ohos.permission.INTERNET` | HIBP 泄露检测 / LAN 同步 | Breach / SyncProtocol |

要点：
- `user_grant` 级权限（如 `ACCESS_BIOMETRIC`）必须带 `reason`（指向 `$string:` 资源）和 `usedScene`
- `system_grant` 级权限（`VIBRATE` / `INTERNET`）只写 `name` 即可，安装时自动授予
- abilities 里 `EntryAbility` 的 `skills` 含 `entity.system.home` + `action.system.home`（桌面图标入口）

### 运行时申请（user_grant 权限按需弹框）

声明在 `module.json5` 只是「可申请」；`user_grant` 权限实际授予要运行时弹框。
API（已用 `@kit.AbilityKit` 的 `abilityAccessCtrl`，声明 `@ohos.abilityAccessCtrl.d.ts`）：

```ts
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';

const atManager = abilityAccessCtrl.createAtManager();
const perms: Permissions[] = ['ohos.permission.ACCESS_BIOMETRIC'];
const result = await atManager.requestPermissionsFromUser(context, perms);
// result.authResults[i] === 0 表示已授予
```

注意：`ScanKit` 的相机权限由系统级扫码 UI 自己弹，**不需要**手动申请（见第五节 ScanKit）。

## 五、12 个 Kit 实战速查

每个 Kit 下：真实 import 行 + 关键 API + 所需权限 + 本项目最小片段 + 易踩坑。
（佐证文件见第九节。）

### 1. @kit.AbilityKit（UIAbility / context / 权限 / picker context）

```ts
import { AbilityConstant, UIAbility, Want, common } from '@kit.AbilityKit';
```

- 关键：`UIAbility` 生命周期、`this.context`（`UIAbilityContext`）、`common.Context`
- `common.Context` 作为参数传给 picker（见 Transfer.ets `exportVaultToFile(context: common.Context)`）
- 权限：无
- 坑：页面里拿 context 用 `getContext(this) as Context`；Ability 里用 `this.context`，二者不可混

### 2. @kit.ArkUI（window / display / mediaquery / router / promptAction）

```ts
import { display, mediaquery, window } from '@kit.ArkUI';
import { promptAction, router } from '@kit.ArkUI';
```

- 关键：见第三节（沉浸式 / 安全区 / 暗模式）；页面跳转 `router.back()` / `router.pushUrl`
- `promptAction.showToast({ message, duration })`、`showDialog`、`showActionMenu`
- 权限：无
- 坑：`window` API 返回 px，UI 是 vp，必须 `display.getDefaultDisplaySync().densityPixels` 换算

### 3. @kit.BasicServicesKit（pasteboard / BusinessError）

```ts
import { pasteboard } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
```

- 关键：`pasteboard.getSystemPasteboard()`、`pasteboard.createData(MIMETYPE_TEXT_PLAIN, value)`、
  `pb.setData(data)` / `pb.getData()` / `data.getPrimaryText()`
- 权限：无（剪贴板本身不要权限；触感反馈走另一个 Kit）
- 片段（Clipboard.ets `copyEphemeral`：30s 后剪贴板未变则清空）：

```ts
const pb = pasteboard.getSystemPasteboard();
const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value);
await pb.setData(data);
setTimeout(async () => {
  const cur = (await pb.getData()).getPrimaryText();
  if (cur === value) await pb.setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, ''));
}, 30_000);
```

- 坑：`BusinessError` 也从这个 Kit 导，不是从 `@ohos.base`（项目统一这么写）

### 4. @kit.SensorServiceKit（vibrator）

```ts
import { vibrator } from '@kit.SensorServiceKit';
```

- 关键：`vibrator.startVibration({ type: 'time', duration }, { id, usage })`
- 权限：`ohos.permission.VIBRATE`
- 片段（Clipboard.ets `lightHaptic`）：

```ts
await vibrator.startVibration({ type: 'time', duration: 12 }, { id: 0, usage: 'touch' });
```

- 坑：模拟器 / 无马达设备会 reject，必须 try/catch 静默忽略，不要让它阻断主流程

### 5. @kit.CryptoArchitectureKit（cryptoFramework — 系统级哈希）

```ts
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
```

- 关键：`cryptoFramework.createMd('SHA1' | 'SHA256')` → `md.updateSync({ data })` → `md.digestSync()`
- 用途：HIBP 的 SHA-1（Breach.ets）、sync 的 SHA-256（SyncProtocol.ets）
- 权限：无
- 片段（Breach.ets，SHA-1 大写 hex）：

```ts
const md = cryptoFramework.createMd('SHA1');
md.updateSync({ data: utf8(password) });
const bytes = new Uint8Array(md.digestSync().data);
```

- 坑：本项目 **HMAC-SHA256 故意不走** `cryptoFramework.createMac`。原因：OHOS HMAC 要先
  `createSymKeyGenerator('HMAC|SHA256')` 把字节 key 包成 SymKey 再 `convertKey`，调用栈过长；
  SyncProtocol.ets 直接基于系统 SHA-256 手写 RFC 2104 HMAC（block size 64）。新增哈希优先复用此模式。
- 坑：Argon2id / XChaCha20 **不走系统加密**，走 cryptocore NAPI（见第六节）

### 6. @kit.CoreFileKit（fileIo / picker）

```ts
import { fileIo as fs } from '@kit.CoreFileKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
```

- 关键：`fs.open(path, OpenMode)` → `fs.write(fd, buf)` / `fs.read(fd, buf)` → `fs.close(fd)`；
  `fs.access(path)`（boolean Promise）、`fs.unlink`、`fs.moveFile(src, dst)`、`fs.readText`、`fs.stat(fd)`
- `OpenMode`：`READ_WRITE | CREATE | TRUNC`（写）、`READ_ONLY`（读）
- picker：`DocumentSaveOptions` / `DocumentSelectOptions` + `DocumentViewPicker(context)` 的 `.save()` / `.select()`
- 权限：沙箱 filesDir 读写无权限；picker 选文件由系统 UI 授权
- 片段（VaultStorage.ets 原子写：写 tmp + rename）：

```ts
const handle = await fs.open(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
try { await fs.write(handle.fd, text); } finally { await fs.close(handle.fd); }
await unlinkIfExists(dst);   // moveFile 目标存在会失败，先 unlink
await fs.moveFile(tmp, dst);
```

- 坑：OHOS fs 是 open/write/close 三步，不是 Node 的 `writeFile` 一步；`moveFile` 目标存在会失败，
  必须先 `unlink`。文件落 `filesDir`（卸载随之清除）。

### 7. @kit.NetworkKit（http）

```ts
import { http } from '@kit.NetworkKit';
```

- 关键：`http.createHttp()` → `request.request(url, options)` → `request.destroy()`（finally 必须调）
- options：`method`（`http.RequestMethod.GET/POST`）、`header`、`extraData`、`connectTimeout`、
  `readTimeout`、`expectDataType`（`http.HttpDataType.ARRAY_BUFFER` 收二进制）
- 响应：`resp.responseCode`、`resp.result`（文本时 string，二进制时 ArrayBuffer）
- 权限：`ohos.permission.INTERNET`
- 片段（SyncProtocol.ets `postBinary`，二进制响应）：

```ts
const request = http.createHttp();
try {
  const resp = await request.request(url, {
    method: http.RequestMethod.POST,
    header: { 'content-type': 'application/octet-stream' },
    extraData: ab,                                 // ArrayBuffer
    connectTimeout: 10_000, readTimeout: 60_000,
    expectDataType: http.HttpDataType.ARRAY_BUFFER, // 否则默认按文本解析
  });
  if (resp.result instanceof ArrayBuffer) return new Uint8Array(resp.result);
} finally { request.destroy(); }
```

- 坑：默认按文本解析响应，收二进制**必须**设 `expectDataType: ARRAY_BUFFER`；
  每次请求结束 `request.destroy()` 释放连接；catch 里 `e as BusinessError` 取 `code`/`message`

### 8. @kit.ArkTS（util — base64 / TextEncoder）

```ts
import { util } from '@kit.ArkTS';
```

- 关键：`new util.Base64Helper()` 的 `encodeToStringSync` / `decodeSync`；
  `new util.TextEncoder('utf-8').encodeInto(s)`、`util.TextDecoder.create('utf-8').decodeToString(b)`
- 权限：无
- 坑：ArkTS 没有全局 `btoa`/`atob`/`TextEncoder`，必须走 `util`（见 Crypto.ets）

### 9. @kit.PerformanceAnalysisKit（hilog）

```ts
import { hilog } from '@kit.PerformanceAnalysisKit';
```

- 关键：`hilog.info/warn/error(DOMAIN, TAG, fmt, ...args)`
- 权限：无
- 约定见第七节
- 坑：格式串用 `%{public}s` / `%{public}d` 才会明文输出，否则脱敏为 `<private>`；敏感值不要打

### 10. @kit.UserAuthenticationKit（userAuth — 生物认证）

```ts
import { userAuth } from '@kit.UserAuthenticationKit';
```

- 关键：`getAvailableStatus(type, trustLevel)` 探测可用性；`getUserAuthInstance(authParam, widgetParam)`
  → `inst.on('result', { onResult })` → `inst.start()`；`AuthResult.token` 灌进 HUKS
- 类型：`UserAuthType.FINGERPRINT/FACE/PIN`、`AuthTrustLevel.ATL1`、`UserAuthResultCode.SUCCESS`
- 权限：`ohos.permission.ACCESS_BIOMETRIC`
- 片段（TrustedDeviceHuks.ets，先过滤可用类型再起认证）：

```ts
const authParam: userAuth.AuthParam = { challenge, authType: types, authTrustLevel: userAuth.AuthTrustLevel.ATL1 };
const inst = userAuth.getUserAuthInstance(authParam, { title: '解锁 ZPass 保险库' });
inst.on('result', { onResult: (r) => {
  if (r.result === userAuth.UserAuthResultCode.SUCCESS && r.token?.length) resolve(r.token);
}});
inst.start();
```

- 坑：`authType` 数组里**每一项**都必须在该 trustLevel 被设备支持，否则 `getUserAuthInstance` 抛 401；
  必须先 `getAvailableStatus` 逐项过滤。本项目用 `ATL1`（兼容性最佳，PIN 在 ATL1 才能当 fallback）。

### 11. @kit.UniversalKeystoreKit（huks — 硬件密钥库）

```ts
import { huks } from '@kit.UniversalKeystoreKit';
```

- 关键：`generateKeyItem(alias, opts)`、`isKeyItemExist`、`deleteKeyItem`、
  `initSession`（拿 `handle` + `challenge`）→ userAuth → `finishSession`（灌 `HUKS_TAG_AUTH_TOKEN`）/ `abortSession`
- Tag / 枚举：`HuksTag.HUKS_TAG_ALGORITHM/KEY_SIZE/PURPOSE/BLOCK_MODE/PADDING/USER_AUTH_TYPE/
  KEY_AUTH_ACCESS_TYPE/CHALLENGE_TYPE/IV/AUTH_TOKEN`，`HuksKeyAlg.HUKS_ALG_AES`、
  `HuksKeySize.HUKS_AES_KEY_SIZE_256`、`HuksCipherMode.HUKS_MODE_CBC`、`HuksKeyPadding.HUKS_PADDING_PKCS7`
- 权限：（生物保护 key）配合 `ACCESS_BIOMETRIC`
- 坑（关键约束）：HUKS 在 `USER_AUTH` 保护下对 ENC+DEC 双向 AES key **唯一**合法模式是
  **AES-256-CBC + PKCS7**；GCM/CTR/ECB 在 USER_AUTH 下会被 `initSession` 以 -4 NOT_SUPPORTED 拒绝。
  本项目因此用 CBC，AEAD 完整性由上层 verifier 兜底校验。新生物录入用
  `HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL` 自动失效旧 key。

### 12. @kit.ScanKit（HMS — 系统级扫码，声明在 hms/ 下）

```ts
import { scanBarcode, scanCore } from '@kit.ScanKit';
```

- 关键：`scanBarcode.startScanForResult(context, options)`，`options.scanTypes: [scanCore.ScanType.QR_CODE]`；
  结果 `result.originalValue`
- 权限：相机权限由系统级扫码 UI 自己弹，**不需** module.json5 申请 / 运行时申请
- 片段（TotpScan.ets）：

```ts
const options: scanBarcode.ScanOptions = {
  scanTypes: [scanCore.ScanType.QR_CODE], enableMultiMode: false, enableAlbum: true,
};
const result = await scanBarcode.startScanForResult(getContext(this) as Context, options);
this.applyRaw(result.originalValue);
```

- 坑：用户取消扫描会抛 `err.code === 1000500002`（SDK 声明值，见 `@hms.core.scan.scanBarcode.d.ts`；`1000500001` 才是 Internal error），要判掉当成正常返回，别报错。SDK 中**不存在** `1000500000`，勿凭旧印象写错（`TotpScan.ets` 已校正为 `1000500002`）。
- 坑：ScanKit 是 HMS 专有（`@kit.ScanKit`，声明在 `hms/kits/`，不在 openharmony/）

## 六、NAPI 原生桥完整链路（libcryptocore.so）

Argon2id / XChaCha20-Poly1305 / CSPRNG 走 Rust 原生（cryptocore），不在 ArkTS 端引 JS 兜底。
完整链路：**Rust `#[napi]` → `.d.ts` 声明 → `oh-package.json5` 的 `file:` 依赖 → `import mod from 'libcryptocore.so'`**。

### 1) Rust 侧 `#[napi]` 导出（cryptocore/src/harmony.rs）

用 `napi_derive_ohos` / `napi_ohos`，`#[napi(js_name = "...")]` 指定 JS 名（camelCase）。
同步 vs 异步：

```rust
// 同步（µs 级，AEAD / 随机数）：直接返回 Buffer
#[napi(js_name = "sealAead")]
pub fn seal_aead_napi(key: Buffer, plaintext: Buffer, aad: Buffer) -> NapiResult<Buffer> { ... }

// 异步（Argon2id 数百 ms，必须不阻塞 UI 主线程）：返回 AsyncTask，框架搬到 libuv worker
#[napi(js_name = "deriveKek")]
pub fn derive_kek_napi(password: String, salt: Buffer, ...) -> AsyncTask<DeriveKekTask> { ... }
```

- 错误：统一 `Error::new(Status::GenericFailure, msg)`；ArkTS 侧异步函数表现为 Promise reject，
  同步函数则在调用栈抛 `BusinessError`
- 传输：用 `Buffer`（零拷贝到 ArkTS 的 ArrayBuffer），密码 / AAD 例外按需走 `String`/`Buffer`

### 2) `.d.ts` 类型声明（entry/src/main/cpp/types/libcryptocore/index.d.ts）

声明一个 interface，**default export** 一个该类型常量。同步函数返回 `ArrayBuffer`，
异步函数返回 `Promise<ArrayBuffer>`：

```ts
interface Cryptocore {
  deriveKek: (password: string, salt: ArrayBuffer, memKib: number, iter: number,
    par: number, keyLen: number) => Promise<ArrayBuffer>;
  sealAead: (key: ArrayBuffer, plaintext: ArrayBuffer, aad: ArrayBuffer) => ArrayBuffer;
  randomBytes: (n: number) => ArrayBuffer;
  // ...openAead / argon2idRaw / sealAeadWithNonce / openAeadWithNonce
}
declare const cryptocore: Cryptocore;
export default cryptocore;
```

### 3) `oh-package.json5` 的 `file:` 依赖（entry/oh-package.json5）

```json5
"dependencies": {
  "libcryptocore.so": "file:./src/main/cpp/types/libcryptocore"
}
```

语义：模块名 `libcryptocore.so` 指向**类型声明目录**；运行时由系统 napi loader 解析到
`entry/libs/<arch>/libcryptocore.so`（二进制由 `entry/build-profile.json5` 的 `nativeLib` 打入 HAP）。
即「类型声明」与「二进制 .so」分开打包，名字必须一致（与 Rust 模块注册名一致）。

### 4) ArkTS 端导入与封装（entry/src/main/ets/lib/RustCryptoCore.ets）

```ts
import cryptocore from 'libcryptocore.so';   // 必须 default import
const native = cryptocore as CryptocoreNative;
```

- **关键坑**：必须 `default import`。OHOS native module 通过 `napi_set_named_property` 把每个
  `#[napi]` 函数挂到 exports 对象的属性上；只有 default import 才拿到 exports 对象本身。
  写 `import { randomBytes } from 'libcryptocore.so'` 会去模块的 ES 具名 export 表里找（与
  exports 对象属性是两套），找不到。
- 类型转换：ArkTS 的 `Uint8Array` 与原生 `ArrayBuffer` 互转（`toAB` / `fromAB`）；
  注意 `byteOffset` / `byteLength` 非整 buffer 时要 `slice`
- 可用性探测：`isNativeCryptoAvailable()` 调一次 `randomBytes(1)`，catch 即判定未加载

### 5) 交叉编译（cryptocore/scripts/build-harmony.sh）

OHOS NDK 交叉编译两 target：`aarch64-unknown-linux-ohos`（真机 arm64-v8a）、
`x86_64-unknown-linux-ohos`（模拟器 x86_64）。要点：

- 需 `export HARMONY_NDK_HOME=.../openharmony/native`（含 `llvm/bin/clang` 与 `sysroot/`）
- 用 OHOS `clang` 当 linker，`cargo build --release --no-default-features --features harmony --target <triple>`
- 产物拷到 `harmony/entry/libs/<arch>/libcryptocore.so`；在 harmony 目录 `task crypto` 一键完成

## 七、BusinessError / async / hilog 约定

### BusinessError

系统异步 API 失败 reject 一个 `BusinessError`（`{ code: number, message: string }`）。
统一捕获模式：

```ts
try {
  await someSystemApi();
} catch (e) {
  const err = e as BusinessError;
  hilog.error(DOMAIN, TAG, 'xxx failed: code=%{public}d msg=%{public}s', err.code, err.message);
}
```

`BusinessError` 从 `@kit.BasicServicesKit` 导。按 `err.code` 分支处理（如 ScanKit 取消是
`1000500002`；HUKS / userAuth 错误码见 TrustedDeviceHuks.ets 的 `ABSENT_CODES` 映射表）。

### async

系统 API 多为 Promise（也有 callback 重载）。NAPI 异步函数（`AsyncTask`）在 ArkTS 端是 Promise，
`await` 即可；同步 NAPI 函数直接返回值，失败在调用栈抛 `BusinessError`，要 try/catch。
回调式 API（如 userAuth 的 `on('result')`）用 `new Promise` 包成 Promise（见 TrustedDeviceHuks
`runUserAuth`），并在 settled 后 `inst.off('result')` 清理。

### hilog

固定 `DOMAIN` + `TAG`：

```ts
const DOMAIN = 0xFF00;          // 项目统一
const TAG = 'EntryAbility';     // 每个模块自己的 tag
hilog.info(DOMAIN, TAG, 'filesDir=%{public}s', ctx.filesDir);
```

脱敏：格式串里 `%{public}s` / `%{public}d` 才明文；不加 `public` 默认脱敏成 `<private>`。
**密码 / DEK / token / 完整哈希等敏感值绝不打日志**（HIBP 只暴露 5 位前缀就是这个原则的延伸）。

## 八、常见坑

1. **default import .so** — native module 只能 `import x from 'libcryptocore.so'`，不能具名导入
2. **px vs vp** — window/avoidArea API 返回 px，UI 单位是 vp，必须用 `densityPixels` 换算
3. **fs 三步走** — open/write/close，不是 Node `writeFile`；`moveFile` 目标存在先 `unlink`
4. **http 二进制** — 收二进制必须 `expectDataType: ARRAY_BUFFER`；每次请求 finally `destroy()`
5. **HUKS + USER_AUTH 只支持 AES-CBC+PKCS7** — GCM/CTR/ECB 会被 -4 NOT_SUPPORTED 拒绝
6. **userAuth authType 全项必须可用** — 否则 `getUserAuthInstance` 抛 401；先 `getAvailableStatus` 过滤
7. **filesDir 不硬编码** — OHOS 5+ 沙箱路径可变，从 AppStorage 取（EntryAbility.onCreate 写入）
8. **@StorageProp 不能用于 @ComponentV2** — V2 用 `@ObservedV2` + `@Trace` 单例（SafeAreaState）
9. **ArkTS 无 btoa/TextEncoder/全局 URL** — base64/utf8 走 `util.*`；URL 手解析（见 SyncProtocol/Totp）
10. **vibrator / 触感会 reject** — 模拟器无马达，必须 try/catch 静默忽略
11. **ScanKit 取消不是错误** — 取消码是 `1000500002`（SDK 中无 `1000500000`，勿写错），判掉当正常返回
12. **声明版本 ≠ 编译目标** — `.sdk-ref` 是 API 24 声明，编译目标是 API 12/20，别把声明当目标
13. **system_grant 权限只写 name** — `VIBRATE` / `INTERNET` 无须 reason/usedScene；user_grant 必须带

## 九、深入查阅（harmony/.sdk-ref/ 下精确路径）

### Kit / @ohos SDK 声明

- Kit 聚合：`harmony/.sdk-ref/sdk-api/openharmony/kits/@kit.<Name>.d.ts`
  （AbilityKit / ArkUI / BasicServicesKit / CryptoArchitectureKit / CoreFileKit /
  NetworkKit / ArkTS / PerformanceAnalysisKit / UserAuthenticationKit /
  UniversalKeystoreKit / SensorServiceKit）
- HMS 专有：`harmony/.sdk-ref/sdk-api/hms/kits/@kit.ScanKit.d.ts`
- 关键 @ohos：`harmony/.sdk-ref/sdk-api/openharmony/api/` 下
  `@ohos.pasteboard.d.ts`、`@ohos.net.http.d.ts`、`@ohos.file.fs.d.ts`、
  `@ohos.userIAM.userAuth.d.ts`、`@ohos.security.huks.d.ts`、`@ohos.security.cryptoFramework.d.ts`、
  `@ohos.hilog.d.ts`、`@ohos.abilityAccessCtrl.d.ts`、`@ohos.base.d.ts`（BusinessError）、
  `@ohos.app.ability.UIAbility.d.ts`、`@ohos.vibrator.d.ts`、`@ohos.systemDateTime.d.ts`、
  `@ohos.file.picker.d.ts`

### 官方文档

- NAPI：`harmony/.sdk-ref/docs/zh-cn/application-dev/napi/`
  （`napi-guidelines.md`、`napi-introduction.md`、`napi-data-types-interfaces.md`、`build-with-ndk-*.md`）
- V2 状态管理：`harmony/.sdk-ref/docs/zh-cn/application-dev/ui/state-management/`
  （`arkts-new-componentV2.md`、`arkts-new-local.md`、`arkts-mvvm-V2.md`、`arkts-appstorage.md`）

### 项目权威范式代码

- Ability / 窗口：`harmony/entry/src/main/ets/entryability/EntryAbility.ets`、`state/SafeArea.ets`、`pages/Index.ets`
- 系统能力封装：`harmony/entry/src/main/ets/lib/`
  （`Clipboard.ets`、`Breach.ets`、`Crypto.ets`、`SyncProtocol.ets`、`TrustedDeviceHuks.ets`、
  `VaultStorage.ets`、`Transfer.ets`、`Totp.ets`、`RustCryptoCore.ets`）
- 扫码：`harmony/entry/src/main/ets/pages/TotpScan.ets`
- NAPI 桥：`harmony/entry/src/main/cpp/types/libcryptocore/index.d.ts`、
  `cryptocore/src/harmony.rs`、`cryptocore/src/lib.rs`、`cryptocore/scripts/build-harmony.sh`
- 配置：`harmony/build-profile.json5`、`harmony/entry/build-profile.json5`、
  `harmony/entry/oh-package.json5`、`harmony/entry/src/main/module.json5`、
  `harmony/entry/src/main/resources/base/profile/main_pages.json`
- 迁移记录：`harmony/MIGRATION.md`
