---
name: harmony-arkui-ui
description: 在 harmony/ 子项目编写或修改 ArkTS(.ets) 界面代码前调用。覆盖 ArkUI 声明式 UI、容器与组件、V2 状态(@ComponentV2/@Local/@Param/@Event/@Monitor/@Computed)、@Builder、router/promptAction 导航弹层，以及 ZPass 设计 token 与 UI 铁律(禁emoji/禁紫/圆角5·7·10·14)。
---

# ZPass HarmonyOS ArkUI 界面开发

面向「在本仓库 `harmony/` 子项目写 ArkTS(.ets)」的工程师/agent。编译目标以 `build-profile.json5` 为准：`targetSdkVersion 6.0.0(API 20)` / `compatibleSdkVersion 5.0.0(API 12)`（`.sdk-ref/` 下的 `.d.ts` 声明取自本地已装 API 24 SDK，**仅作查阅，不是编译目标**——勿误用仅 API 21+ 才有的特性）。全栈 ArkTS V2 装饰器栈，严格模式 + useNormalizedOHMUrl。本文所有 API/装饰器/枚举均取自项目实读的 SDK 声明与 `entry/src/main/ets/**` 真实代码，可直接照抄。

## 1. 何时用本 skill 与心智模型

写或改 `harmony/entry/src/main/ets/**` 下任意 `.ets` 界面代码前，先读本文对齐范式与铁律，再动手。

V2 声明式 UI 与 React 的关键映射（避免凭 React 直觉踩坑）：

- 组件是 `struct`（不是 class/函数），用 `@ComponentV2` 装饰；UI 写在 `build()` 里，语法是「容器(){ 子组件 }.属性().属性()」链式。
- 状态不是 `useState`，而是装饰器字段：组件本地态 `@Local`、父传子入参 `@Param`、子回写父 `@Event`、派生值 `@Computed get`、监听 `@Monitor`。
- 全局/跨组件状态不是 `Context`，而是「`@ObservedV2` 类 + `@Trace` 字段 + 进程级 `new` 单例」，组件里 `@Local x = singleton` 拿引用（见第 5 节）。字段级追踪，粒度比 React 细。
- 列表渲染用 `ForEach(arr, item => {...}, keyGen)`，严格模式下第三个 keyGenerator 必写。
- 本项目无任何 V1（`@Component/@State/@Link/@Prop/@StorageProp/@Watch/@Provide/@Consume/@ObjectLink`）。看到这些一律不要写进项目，原因见 `state/SafeArea.ets` 注释（`@StorageProp` 不能用于 `@ComponentV2`）。

## 2. @ComponentV2 组件骨架与生命周期

```ts
@Entry            // 页面入口：单页仅一个；build 根节点必须是容器组件
@ComponentV2      // V2 组件；只能用 V2 状态装饰器
struct Index {
  @Local activeTab: string = 'vault';

  aboutToAppear(): void { /* 创建后、build 前；可发起 refresh / 订阅 */ }
  aboutToDisappear(): void { /* 销毁前；解订阅 / 清理 */ }
  onDidBuild(): void { /* 首次 build 完成后回调；不要在此改状态 */ }

  // router 页面专属生命周期
  onPageShow(): void { /* 从子页 back 回来时刷新数据 */ }
  onPageHide(): void {}

  build() {                              // 必有；根节点唯一且必要
    Stack() { Column() { /* ... */ } }   // @Entry 根节点必须为容器组件
  }

  @Builder tabBarItem(tab: TabSpec) { /* 成员 @Builder，见第 6 节 */ }
}
```

`@ComponentV2` 规则：

- 仅可用 V2 状态装饰器：`@Local`/`@Param`/`@Once`/`@Event`/`@Provider`/`@Consumer`，外加 `@Monitor`/`@Computed`。不支持 `LocalStorage`/`@StorageProp` 等 V1 能力。
- 同一 struct 不能同时被 `@ComponentV2` 与 `@Component` 装饰。
- 跨文件用 `export struct Foo`（项目里 `VaultTab`/`SpaceAvatar` 等都如此），import 后以 `Foo()` 调用。
- 可选参数 `freezeWhenInactive: boolean` 开组件冻结：`@ComponentV2({ freezeWhenInactive: true })`，非激活时不刷新、`@Monitor` 不调用，激活后统一生效。支持 router / `TabContent` / `Navigation` / `Repeat` 场景。

`build()` 函数铁律（极易踩）：

- 根节点唯一且必要；`@Entry` 根必须为容器组件；`ForEach` 禁止作根节点。
- 禁止：声明本地变量（`let x = 1`）、`console.info`、本地作用域 `{}`、`switch`（改用 `if/else`）、三元表达式直出组件（改用 `if/else`）、直接改状态变量（`this.count++` 在 build 里会循环渲染）。
- 不允许调用非 `@Builder` 方法生成 UI 节点；但系统组件的参数**可以**是普通 TS 方法的返回值，如 `Text(this.getSubtitle(item))`（VaultTab 大量使用）。

## 3. 容器与布局速查

### Column / Row —— 线性布局

```ts
Column({ space: ZSpacing.sm }) {       // 子元素垂直间距
  Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text)
}
.alignItems(HorizontalAlign.Start)     // 交叉轴(水平)对齐
.justifyContent(FlexAlign.Start)       // 主轴(垂直)对齐

Row() {
  Text(label).fontSize(ZType.bodySize).fontColor(this.zc.text).layoutWeight(1)  // 占满, 把尾标推到右
  Text(value).fontSize(ZType.subheadSize).fontColor(this.zc.text3)
}
.width('100%')
.padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.md, bottom: ZSpacing.md })
```

枚举不要混：`Column.alignItems` 收 `HorizontalAlign`；`Row.alignItems` 收 `VerticalAlign`；`Flex.alignItems` 收 `ItemAlign`；三者 `justifyContent` 都收 `FlexAlign`。混用编译错。

### Stack —— 层叠

`Stack(options?: { alignContent?: Alignment })`。两个高频用途：全屏遮罩浮层（`build()` 最外层 Stack + 条件 Builder）、自绘进度条/开关轨道叠加。

```ts
// 自绘进度条：底轨 + 前景按 % 宽
Stack({ alignContent: Alignment.Start }) {
  Row().width('100%').height(3).borderRadius(2).backgroundColor(this.zc.lineSoft)
  Row().width(`${this.genStrength.score}%`).height(3).borderRadius(2).backgroundColor(this.strengthColor())
}
.width('100%').height(3)
```

### Scroll —— 单子节点滚动容器

`Scroll(scroller?: Scroller)` 只能有一个直接子组件（通常包一层 Column）。项目纵向滚动页定式（顶对齐 + 撑满高度，三 Tab 一致，务必背）：

```ts
Scroll() {
  Column({ space: ZSpacing.md }) {
    // ...内容...
    Row().height(80).width('100%')       // 底部 Tab bar 避让占位
  }
  .width('100%')
  .constraintSize({ minHeight: '100%' }) // 强制至少撑满 Scroll 视口
  .justifyContent(FlexAlign.Start)        // 短内容也贴顶, 不居中
  .alignItems(HorizontalAlign.Start)
  .padding({ left: ZSpacing.lg, right: ZSpacing.lg })
}
.scrollBar(BarState.Off)
.layoutWeight(1)                          // 吃掉表头之外的剩余高度
.width('100%')
.align(Alignment.TopStart)
```

横向 chip 滚动条：`Scroll(){ Row({ space }){ ForEach(...) } }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).height(44)`。

### List + ListItem + swipeAction —— 长/可滑动数据列表

```ts
List({ space: 1 }) {
  ForEach(this.store.filteredItems, (it: ItemPayload) => {
    ListItem() {
      this.itemRow(it)                          // @Builder 渲染行内容
    }
    .onClick(() => this.onTapItem(it))
    .swipeAction({ end: this.swipeActions(it) }) // end=右滑露出
  }, (it: ItemPayload) => it.id)                 // 严格模式必带 key
}
.layoutWeight(1)
.width('100%')
.scrollBar(BarState.Off)
.divider({ strokeWidth: 0.5, color: this.zc.lineSoft })

@Builder
swipeActions(item: ItemPayload) {
  Row({ space: 0 }) {
    this.swipeButton('收藏', this.zc.warn, () => this.onToggleFavorite(item))
    this.swipeButton('编辑', this.zc.info, () => this.onEditItem(item))
    this.swipeButton('删除', this.zc.danger, () => this.onDeleteItem(item))
  }.height('100%')
}
```

`ListItem.swipeAction(value: SwipeActionOptions)`，`SwipeActionOptions { start?, end?: CustomBuilder | SwipeActionItem; edgeEffect? }`。`onClick` 直接挂 ListItem 上。

实战取舍：**静态分组列表**（设置项、指标卡）用 `Column + ForEach + Divider`；**长/可滑动数据列表**（条目）才用 List。少量固定行用 Column 更简单。

### Flex / Grid / Tabs / Swiper —— 现状

- `Flex`：项目未用，线性布局一律 Column/Row（性能更好）。需换行流式才上 `Flex({ wrap: FlexWrap.Wrap })`。
- `Grid`：项目未用。需等宽宫格再上 `Grid` + `.columnsTemplate('1fr 1fr')`。
- `Tabs + TabContent`：本项目**主界面承载**（4 Tab：密码库/生成器/安全/我的，见第 7 节），不进页面栈。
- `Swiper`/`RelativeContainer`/`Refresh`：项目未用，按需引入。

## 4. 基础组件速查

### Text —— 兼任伪按钮/伪 chip

项目**不用 Button 组件**，按钮一律 `Text + backgroundColor + borderRadius + textAlign(Center) + onClick` 自绘，以贯彻 token 与禁紫配色。

```ts
// 主操作按钮(accent 实底)
Text('重新生成')
  .fontSize(ZType.bodySize).fontWeight(FontWeight.Medium)
  .fontColor(this.zc.accentInk).backgroundColor(this.zc.accent)
  .borderRadius(ZRadius.lg).height(44).layoutWeight(1)
  .textAlign(TextAlign.Center)
  .onClick(() => this.regenerate())

// 单行省略
Text(item.name).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
```

高频链：`.fontColor / .fontSize / .fontWeight / .fontFamily / .maxLines / .textAlign / .textOverflow({ overflow: TextOverflow.Ellipsis }) / .lineHeight / .copyOption(CopyOptions.LocalDevice)`。`CopyOptions` 成员 `None=0 / InApp=1 / LocalDevice=2 / CROSS_DEVICE=3`，项目允许复制处统一用 `LocalDevice`（见 `ItemDetail.ets`）。字体：正文用 `.fontFamily('HarmonyOS Sans')`，密码/TOTP 等宽场景用 `.fontFamily('HarmonyOS Sans Condensed')`（见 `TotpDetail.ets`）；项目未注册 Geist，勿照搬 phone(RN) 端的 Geist token，否则静默回退默认字体。

### TextInput

```ts
TextInput({ placeholder: '当前主密码', text: this.cpOld })
  .type(InputType.Password)
  .placeholderColor(this.zc.text3)
  .placeholderFont({ size: ZType.bodySize })
  .fontColor(this.zc.text).fontSize(ZType.bodySize)
  .backgroundColor(this.zc.bg).borderRadius(ZRadius.lg)
  .padding({ left: ZSpacing.md, right: ZSpacing.md })
  .height(44).width('100%')
  .enabled(!this.store.busy)
  .onChange((v: string) => { this.cpOld = v; this.cpError = ''; })
  .onSubmit(() => this.onChangePwSubmit())
```

`InputType` 成员：`Normal, Number, PhoneNumber, Email, Password, NUMBER_PASSWORD, USER_NAME, NEW_PASSWORD, NUMBER_DECIMAL, URL, ONE_TIME_CODE`。搜索框定式：去背景去圆角 `.backgroundColor('#00000000').borderRadius(0).padding(0).layoutWeight(1)`，外层 Row 提供胶囊背景。

### Toggle —— 开关

```ts
Toggle({ type: ToggleType.Switch, isOn: value })
  .selectedColor(this.zc.text)          // 开态轨道=黑/白(禁紫)
  .switchPointColor(this.zc.accentInk)
  .onChange((isOn: boolean) => onChange(isOn))
```

`ToggleType`: `Checkbox`/`Switch`/`Button`。带 busy 态/禁用样式的开关项目用自绘（Stack + 两 Row + margin 位移）。

### 图标：禁 emoji 后怎么放图标

项目现状（照此做）：图标统一用 `Image($r('app.media.ic_*'))` 媒体资源 + `.fillColor()` 单色染色。Tab 栏图标即如此（`Index.ets` 的 `tabBarItem`）：

```ts
Image(tab.icon)                          // tab.icon = $r('app.media.ic_tab_vault')
  .width(22).height(22)
  .fillColor(active ? this.zc.text : this.zc.text3)   // 选中/未选中染色，禁紫，走 token
```

新增图标的正路：把 SVG/PNG 放进 `entry/src/main/resources/base/media/`，用 `$r('app.media.<name>')` + `Image().fillColor()` 引用。

`SymbolGlyph`（系统符号库）是官方备选方案，API 正确但**项目当前未使用**，无既有范式可循；如要引入需自行验证：

```ts
// 备选，项目尚未采用：
SymbolGlyph($r('sys.symbol.lock'))
  .fontSize(20)
  .fontColor([this.zc.text])            // 入参必须是数组 Array<ResourceColor>，不是单色
  .renderingStrategy(SymbolRenderingStrategy.SINGLE)
```

### Slider

```ts
Slider({ value: this.genLength, min: 6, max: 64, step: 1, style: SliderStyle.OutSet })
  .blockColor(this.zc.text).selectedColor(this.zc.text).trackColor(this.zc.lineSoft)  // 全黑白
  .width('100%')
  .onChange((v: number) => { this.genLength = Math.round(v); this.regenerate(); })
```

### Divider / Image / 其它

- `Divider().strokeWidth(0.5).color(this.zc.line).margin({ left: ZSpacing.lg, right: ZSpacing.lg })`。
- `Image($r('app.media.xxx')).width(22).height(22).fillColor(...)`；项目无网络头像，头像用文字方块（SpaceAvatar）。
- `Button`/`Checkbox`/`Radio`/`Progress`/`Search`/`Badge`：项目均未用（进度条/搜索/单选都用 Text/Stack/TextInput 自绘，保持 token 与禁紫一致）。需要红点角标时用 `Badge`。

通用属性（CommonMethod，全组件可链）：`.width/.height/.size/.constraintSize({ minWidth?, maxWidth?, minHeight?, maxHeight? }) / .layoutWeight(number) / .padding / .margin / .backgroundColor / .border / .borderRadius / .opacity / .clip(boolean) / .align(Alignment) / .position / .offset / .zIndex / .visibility(Visibility) / .enabled(boolean) / .onClick / .onAppear / .onDisappear`。`Length = number | string | Resource`（`number` 为 vp，`'100%'` 为百分比）。

## 5. V2 状态与单例 store 范式

核心范式 = `@ObservedV2` 类 + `@Trace` 字段 + 进程级 `new` 单例 + 组件内 `@Local x = singleton` 取引用。

```ts
// state/XxxStore.ets —— 数据中心
@ObservedV2
export class VaultStore {
  @Trace status: VaultStatus = { initialized: false, unlocked: false, itemCount: 0 };
  @Trace busy: boolean = false;
  @Trace items: ItemPayload[] = [];
  @Trace query: string = '';

  // 普通 getter 即可做派生(依赖 @Trace 字段, 读取时已被追踪)
  get filteredItems(): ItemPayload[] { return this.items.filter(/* ... */); }

  // 业务动作写成 async 方法, 内部改 @Trace 字段 → 依赖视图自动重渲
  async refresh(): Promise<void> {
    this.status = await vaultService.status();
    this.items = await vaultService.listItems();
  }
}
export const vaultStore = new VaultStore();   // 文件底部 new 一次导出
```

```ts
// 任意 @ComponentV2 组件：@Local 拿同一对象引用(不是拷贝)
@ComponentV2
export struct VaultTab {
  @Local store: VaultStore = vaultStore;            // 业务状态单例
  @Local zc: ZColorsClass = ZColors;                // 主题单例
  @Local safeArea: SafeAreaState = safeAreaState;   // 安全区单例
  @Local showSpacePicker: boolean = false;          // 组件本地态

  aboutToAppear(): void { this.store.refresh(); }
  build() { /* store 的 @Trace 字段变更 → 本组件依赖处自动重渲 */ }
}
```

### 各 V2 装饰器要点

- `@Local`：组件内部状态。必须本地初始化，禁止外部传入。装饰对象时只观测整体赋值，深层属性靠类的 `@ObservedV2`+`@Trace`。数组可观测 API：`push/pop/shift/unshift/splice/copyWithin/fill/reverse/sort`。
- `@Param`：父→子单向入参。禁止本地直接改 `this.param = ...`；要改值配 `@Once`（改本地），要回写父配 `@Event`。无本地默认值则必须配 `@Require`。持对象引用，改属性会同步回父。
- `@Once`：仅初始化同步一次，只能与 `@Param` 搭配（`@Param @Once x`）。
- `@Event`：子对外输出回调，箭头函数。改父值立即生效，但回传到子 `@Param` 是异步的。
  ```ts
  @Event changeIndex: (val: number) => void = (_v: number) => {};
  // 父：Child({ index: this.index, changeIndex: (v: number) => { this.index = v; } })
  ```
- `@Monitor('a', 'b')`：监听成员方法，参数 `IMonitor`。被监听变量须是 `@Local`/`@Param`/`@Provider`/`@Consumer`/`@Computed`（组件中）或 `@Trace`（类中）。深层路径用 `.`：`@Monitor('info.name')`。回调内用 `monitor.dirty` (脏路径数组) 与 `monitor.value(path)?.before / .now`。
- `@Computed get`：计算属性，只重算一次走缓存，只读禁赋值。getter 内勿改参与计算的属性、勿副作用、勿成环。简单计算别用（本身有开销），复杂/多处复用才划算。本项目 `filteredItems` 用普通 get 而非 `@Computed`。
- `@ObservedV2` + `@Trace`：类属性深观测。两者必须配合；只 `@Trace` 属性变化能触发刷新。嵌套类须各自 `@ObservedV2`+`@Trace`。`@ObservedV2` 实例不支持 `JSON.stringify`。
- `@Provider`/`@Consumer`：跨层级双向同步，本项目未用（状态走单例）。

观测能力速查：`@Local`/`@Param` 对象成员变更需类 `@ObservedV2`+`@Trace`；`@Monitor` 监听整体数组无法感知单项变化，可监听 `arr.length` 判断增删。Proxy 化的数组重复赋同源值会多刷新 → 用 `UIUtils.getTarget(this.x)`（`import { UIUtils } from '@kit.ArkUI'`）比对后再赋值。

跨 ability 共享态才用 `AppStorageV2.connect<T>(...)`（只支持 class 类型）；本项目用进程级单例即可。裸字符串传递可用 `AppStorage.setOrCreate<string>('filesDir', ...)`（EntryAbility 注入 filesDir）。

## 6. @Builder / @Styles / @Extend 复用

- **`@Builder`**（最常用）：把重复 UI 抽成成员函数，`build()` 内 `this.xxx(arg)` 调用。`this` 指当前组件，可访问状态变量。内部禁定义状态变量/用生命周期。参数仅「传入单个对象字面量」时按引用（状态变化能刷新 Builder 内 UI），其余按值。
  ```ts
  @Builder itemRow(item: ItemPayload) { Row(){ /* ... */ } }
  @Builder swipeButton(label: string, bg: string, onTap: () => void) {
    Text(label).fontSize(ZType.footnoteSize).fontColor('#ffffff')
      .width(72).height('100%').textAlign(TextAlign.Center)
      .backgroundColor(bg).onClick(() => onTap())
  }
  ```
- **`@LocalBuilder`**：成员级，内部组件始终绑定声明它的组件（`this` 恒指宿主），跨组件传 Builder 又要保持父归属时用。不可全局、不可装饰静态函数。
- **`@BuilderParam`**：持有 `@Builder` 引用做插槽，只能被 `@Builder` 初始化。直传 `this.componentBuilder` → `this` 指子组件；包箭头 `() => this.componentBuilder()` → 指父组件。
- **`@Extend`/`@Styles`**：本项目目前未用，样式走 `.链式` + Tokens 常量。需跨文件复用样式用 `AttributeModifier`。

## 7. 导航·弹层·Toast

本项目用 `@ohos.router`（页面路由），**不用 Navigation/NavDestination**。import 一律 `import { promptAction, router } from '@kit.ArkUI';`。主界面用 Tabs 承载，跨页跳转用 router push/back。模态浮层用 Stack 手搓（不用任何 dialog/sheet API）。

### 页面注册（router 必须）

`resources/base/profile/main_pages.json` 的 `src` 数组列出所有 `@Entry` 页（相对 `pages/`、无扩展名），如 `"pages/ItemDetail"`。**未注册的 url 调 `pushUrl` 抛 `100002 Uri error`**，项目把每个 `pushUrl` 都包在 `try/catch` 里。

### router 跳转 / 传参 / 返回（实测定式）

```ts
// 发起跳转(传参对象)
await router.pushUrl({ url: 'pages/ItemDetail', params: { id: item.id } });
await router.pushUrl({ url: 'pages/ItemEdit', params: { mode: 'edit', id: item.id } });
await router.pushUrl({ url: 'pages/Sync' });   // 无参

// 目标页读取：统一断言成 Record<string, Object>, 逐字段 typeof 校验
aboutToAppear(): void {
  const params = router.getParams() as Record<string, Object> | null;
  if (params && typeof params.id === 'string') { this.load(params.id); }
}

// 返回：无参 back
router.back();

// 从子页 back 回来时刷新数据
onPageShow(): void { if (this.item) this.load(this.item.id); }
```

其它签名：`replaceUrl(options)`（销毁当前页再跳）、`back(index, params?)`、`clear()`、`getLength()`、`getState()`、`RouterMode.Standard / Single`。注意这些顶层函数 since 18 deprecated（API 24 仍可用），新代码可改 `this.getUIContext().getRouter().pushUrl(...)` 消除警告。

### Tabs（主界面承载，不进页面栈）

```ts
Tabs({ barPosition: BarPosition.End, index: this.currentTabIndex() }) {
  TabContent() { VaultTab(); }.tabBar(this.tabBarItem(TABS[0]));
  TabContent() { GeneratorTab(); }.tabBar(this.tabBarItem(TABS[1]));
  // ...
}
.vertical(false)
.barMode(BarMode.Fixed)               // Fixed 固定 / Scrollable 可滚动
.barHeight(56 + this.safeArea.bottom)
.barBackgroundColor(this.zc.bg)
.scrollable(false)                    // 禁手势滑动切页
.animationDuration(0)                 // 切换无动画
.onChange((idx: number) => { if (idx >= 0 && idx < TABS.length) this.activeTab = TABS[idx].key; })
```

`BarPosition.Start`(顶)/`End`(底)；`BarMode.Fixed`/`Scrollable`。Tab 切换不入栈，所以主界面用 Tabs、详情页用 router。

### Toast / Dialog / ActionMenu（promptAction 主力反馈）

```ts
// 即发即忘 Toast（项目唯一用法）
promptAction.showToast({ message: '已锁定', duration: 1200 });

// 二次确认：Promise + 按 r.index 分支
const r = await promptAction.showDialog({
  title: '删除条目',
  message: `确认删除「${item.name}」？该操作不可撤销。`,
  buttons: [
    { text: '取消', color: this.zc.text2 },     // index 0
    { text: '删除', color: this.zc.danger },     // index 1
  ],
});
if (r.index !== 1) return;
await this.store.deleteItem(item.id);

// 长按操作菜单(ArkUI 无 ActionSheet, 用此模拟; 用户取消会 reject, 必须 try/catch)
try {
  const r = await promptAction.showActionMenu({
    title: sp.name,
    buttons: [
      { text: '重命名', color: this.zc.text },
      { text: '删除', color: this.zc.danger },
    ],
  });
  if (r.index === 0) this.openRenameSpace(sp);
  else if (r.index === 1) await this.onDeleteSpace(sp);
} catch (_e) { /* 用户取消会抛 error, 吞掉 */ }
```

长按触发：`.gesture(LongPressGesture({ repeat: false }).onAction(() => this.onLongPressSpace(sp)))`。`ShowToastOptions.duration` 默认 1500，<1500 强制 1500，上限 10000。

### 手搓 overlay 浮层（取代 dialog/sheet 的项目做法）

纯 `Stack` + `@Local boolean` + 条件渲染，不依赖任何 dialog API：

```ts
build() {
  Stack() {
    Column() { /* 主内容 */ }
    if (this.showChangePw)    { this.changePwOverlay(); }     // 危险表单: 遮罩点击不关闭
    if (this.showThemePicker) { this.themePickerOverlay(); }  // 非危险: 点遮罩即关
  }
  .width('100%').height('100%').alignContent(Alignment.Center);
}

@Builder
themePickerOverlay() {
  Column() {
    Column({ space: ZSpacing.sm }) { /* 卡片内容 */ }
      .width('100%').padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
  }
  .width('100%').height('100%')
  .padding({ left: ZSpacing.xl, right: ZSpacing.xl, bottom: this.safeArea.keyboard })  // 键盘避让
  .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
  .backgroundColor(this.zc.overlay)                       // 半透明遮罩
  .onClick(() => { this.showThemePicker = false });       // 点遮罩关闭
}
```

`@CustomDialog`/`CustomDialogController`(属 V1 装饰器)、`bindSheet`/`bindContentCover`/`bindMenu`(属性方法，V2 可用) 项目均未用，优先手搓 overlay。

## 8. ZPass 设计 token 与 UI 铁律 + 新建页面模板

### UI 铁律（写每个片段前对照）

- 装饰器栈仅 V2，无任何 V1。
- **渲染层禁 emoji / Unicode 装饰符号**。图标走 `Image($r('app.media.*')).fillColor()`（项目现行做法），`SymbolGlyph` / 内嵌 SVG 为备选。注意：现有代码残留 `＋ ★ › · +` 等字符是技术债，新代码勿照抄。
- **主题色禁紫**（禁 indigo/violet/紫蓝）；accent 仅黑/白（`zc.accent` / `zc.accentInk`）。
- **圆角仅 5/7/10/14** → 用 `ZRadius.sm/md/lg/xl`，禁裸写其它值（圆形头像 `borderRadius(size/2)` 例外）。
- 字体用 `'HarmonyOS Sans'`（正文）/ `'HarmonyOS Sans Condensed'`（密码/TOTP/等宽场景）；项目未注册 Geist，勿把 phone(RN) 端的 Geist token 带进来。
- 间距只用 `ZSpacing.*`，字号只用 `ZType.*`，颜色只用 `zc.*`（禁字面色值）。
- 描边优先于填充；分隔线用 `zc.line` / `zc.lineSoft`。

### Token 标尺（`theme/Tokens.ets`，务必复用）

```
ZSpacing  xs=4  sm=8  md=12  lg=16  xl=20  xxl=24  xxxl=32
ZRadius   sm=5  md=7  lg=10  xl=14
ZType     largeTitleSize=32 titleSize=22 title2Size=17 headlineSize=15
          bodySize=15 calloutSize=14 subheadSize=13 footnoteSize=12 captionSize=11
```

`ZColors` (`@ObservedV2 ZColorsClass` 单例，每字段 `@Trace`)：`bg bgElev bgElev2 bgHover bgActive line lineSoft text text2 text3 text4 accent accentInk accentGlow danger warn ok info overlay`，外加 `isDark` / `faviconColors` / `faviconInk`(固定白)。访问 `this.zc.bg` 即被记录依赖，切主题时 `setPalette` 同步所有 `@Trace` 字段，依赖处自动重渲。语义：`bgElev`=卡片/输入框底，`bgElev2`=二级浮层底，`text`/`text2`/`text3`/`text4`=主/次/三/四级文，`accent`=强调(黑白互换)，`accentInk`=accent 上反色文字，`danger`=删除，`warn`=收藏星，`info`=编辑/当前 badge，`overlay`=浮层遮罩。

主题联动：`ThemeStore`(单例 `themeStore`) 的 `@Trace effective` 变 → `ZColors.applyDark()/applyLight()` → 所有 `this.zc.x` 处重渲。`themeStore.setMode('system'|'dark'|'light')` 用户手动切；EntryAbility 用 mediaquery 跟随系统。

安全区：`SafeAreaState` 单例 `safeAreaState`，`@Trace top/bottom/keyboard`。顶部状态栏避让 `Row().height(this.safeArea.top).width('100%')`；浮层/输入页底部 `.padding({ bottom: this.safeArea.keyboard })`；底部 Tab 留白 `Row().height(80).width('100%')`。

### 新建页面模板（可直接套用）

```ts
import { ZColors, ZColorsClass, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';
import { vaultStore, VaultStore } from '../state/VaultStore';
import { promptAction } from '@kit.ArkUI';

@ComponentV2
export struct ExampleTab {
  @Local safeArea: SafeAreaState = safeAreaState;
  @Local zc: ZColorsClass = ZColors;
  @Local store: VaultStore = vaultStore;
  @Local showSheet: boolean = false;

  build() {
    Stack() {
      Column({ space: ZSpacing.sm }) {
        Row().height(this.safeArea.top).width('100%');   // 顶部状态栏避让

        Row() {
          Text('标题').fontSize(ZType.titleSize).fontWeight(FontWeight.Bold)
            .fontColor(this.zc.text).layoutWeight(1);
        }
        .width('100%')
        .padding({ left: ZSpacing.lg, right: ZSpacing.lg, top: ZSpacing.xs, bottom: ZSpacing.sm });

        Scroll() {
          Column({ space: ZSpacing.lg }) {
            this.card();
            Row().height(80).width('100%');               // 底部 Tab 留白
          }
          .width('100%')
          .constraintSize({ minHeight: '100%' })
          .justifyContent(FlexAlign.Start)
          .alignItems(HorizontalAlign.Start)
          .padding({ left: ZSpacing.lg, right: ZSpacing.lg });
        }
        .scrollBar(BarState.Off).layoutWeight(1).width('100%').align(Alignment.TopStart);
      }
      .width('100%').height('100%')
      .justifyContent(FlexAlign.Start).alignItems(HorizontalAlign.Start)
      .align(Alignment.TopStart)                          // 顶对齐铁律
      .backgroundColor(this.zc.bg);

      if (this.showSheet) { this.sheetOverlay(); }
    }
    .width('100%').height('100%').alignContent(Alignment.Center);
  }

  @Builder
  card() {
    Column() { /* 行... */ }
      .width('100%').backgroundColor(this.zc.bgElev)
      .borderRadius(ZRadius.xl).clip(true);               // 圆角卡片必加 clip
  }

  @Builder
  sheetOverlay() {
    Column() {
      Column({ space: ZSpacing.md }) {
        Text('标题').fontSize(ZType.title2Size).fontWeight(FontWeight.Bold).fontColor(this.zc.text);
      }
      .width('100%').padding(ZSpacing.xl)
      .backgroundColor(this.zc.bgElev).borderRadius(ZRadius.xl);
    }
    .width('100%').height('100%')
    .padding({ left: ZSpacing.xl, right: ZSpacing.xl, bottom: this.safeArea.keyboard })
    .justifyContent(FlexAlign.Center).alignItems(HorizontalAlign.Center)
    .backgroundColor(this.zc.overlay);
  }
}
```

## 9. 常见坑

1. `Column.alignItems` 收 `HorizontalAlign`；`Row.alignItems` 收 `VerticalAlign`；`Flex.alignItems` 收 `ItemAlign`。混用编译错。
2. `Scroll` 只允许一个直接子（包一层 Column）。
3. `SymbolGlyph.fontColor` 入参是 `Array<ResourceColor>`（`[color]`），不是单色。
4. `ForEach` 第三参 keyGenerator 严格模式必写，key 唯一稳定（用 id）；`ForEach` 不能作根节点。
5. 圆角卡片内有内容/分隔线必加 `.clip(true)`，否则圆角处溢出。
6. `build()` 内不能写 `let`/`switch`/三元直出组件/`console`/改状态；条件渲染用 `if/else`；派生值用 `@Computed get` 或私有方法（`Text(this.foo())` 合法，但普通方法不能直接当 UI 节点）。
7. `@ComponentV2` 里不能出现任何 V1 装饰器（`@State/@Prop/@Link/@StorageProp/@Watch/@Provide/@Consume/@ObjectLink`）。
8. `@Local`/`@Param` 装饰对象只看整体赋值；要属性级刷新，对象的类必须 `@ObservedV2` + 属性 `@Trace`。
9. `@Param` 不可本地写；要本地写配 `@Once`，要回写父配 `@Event`，无默认值配 `@Require`。
10. `@Computed` getter 只读、勿副作用、勿成环、勿配 `!!`；getter 内勿改参与计算的属性。
11. Proxy 化的 Array/Map/Set/Date 重复赋同源值会多刷新 → 用 `UIUtils.getTarget()` 比对。`@ObservedV2` 实例不能 `JSON.stringify`。
12. 透明色用 8 位 `'#00000000'` 或 `'rgba(0,0,0,0.5)'`，优先 `zc.overlay`；accent 永远黑/白系，禁紫。
13. 不要新引入 Button 组件，统一用 Text 自绘按钮。
14. router 跳转的 url 必须在 `main_pages.json` 注册，否则 `100002 Uri error`；`showActionMenu` 用户取消会 reject，必须 try/catch。

## 10. 深入查阅

精确定位路径（均在 `harmony/.sdk-ref/` 与项目代码下）：

- 容器/组件 SDK 声明：`harmony/.sdk-ref/sdk-api/openharmony/component/{column,row,stack,scroll,list,list_item,text,text_input,toggle,symbolglyph,slider,divider,image,tabs,tab_content,common,enums,units}.d.ts`
- router 签名：`harmony/.sdk-ref/sdk-api/openharmony/api/@ohos.router.d.ts`
- promptAction 签名：`harmony/.sdk-ref/sdk-api/openharmony/api/@ohos.promptAction.d.ts`
- ArkTS 语言库：`harmony/.sdk-ref/sdk-api/openharmony/arkts/@arkts.lang.d.ets`、`@arkts.collections.d.ets`
- V2 装饰器文档（均在 `ui/state-management/` 下，不在 `quick-start/`）：`harmony/.sdk-ref/docs/zh-cn/application-dev/ui/state-management/arkts-new-componentV2.md`、`arkts-new-local.md`、`arkts-new-param.md`、`arkts-new-event.md`、`arkts-new-monitor.md`、`arkts-new-Computed.md`、`arkts-new-observedV2-and-trace.md`、`arkts-builder.md`、`arkts-create-custom-components.md`
- 导航/弹层/Toast 文档：`harmony/.sdk-ref/docs/zh-cn/application-dev/ui/arkts-navigation-introduction.md`、`arkts-navigation-tabs.md`、`arkts-create-toast.md`、`arkts-router-to-navigation.md`
- 设计铁律：`/home/zero/Desktop/code/zerx-lab/zpass/AGENTS.md`
- 项目真实范式：
  - token 与调色板：`harmony/entry/src/main/ets/theme/Tokens.ets`
  - 单例 store：`harmony/entry/src/main/ets/state/{VaultStore,ThemeStore,SafeArea}.ets`
  - 主题/沉浸式/安全区注入：`harmony/entry/src/main/ets/entryability/EntryAbility.ets`
  - Tabs 壳层：`harmony/entry/src/main/ets/pages/Index.ets`
  - 列表/滑动/弹层/路由：`harmony/entry/src/main/ets/views/{VaultTab,GeneratorTab,SecurityTab,MeTab}.ets`
  - 可复用子组件(@Param 范式)：`harmony/entry/src/main/ets/components/SpaceAvatar.ets`
  - router 取参/back/onPageShow：`harmony/entry/src/main/ets/pages/{ItemDetail,ItemEdit,TotpDetail,Sync}.ets`
  - 页面注册：`harmony/entry/src/main/resources/base/profile/main_pages.json`
