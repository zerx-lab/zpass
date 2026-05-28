// 安全区高度 —— 由 EntryAbility 在 avoidArea 变化时写入。
//
// 原本各组件用 @StorageProp(KEY) 接 AppStorage，但 @StorageProp 是 ArkUI V1
// 装饰器，不能用在 @ComponentV2 中。这里改成 @ObservedV2 单例：组件用
//   @Local safeArea: SafeAreaState = safeAreaState;
// 引用即可，@Trace 字段变更自动触发依赖该字段的视图重渲。
//
// keyboard 字段：sub'd 到 window 'keyboardHeightChange'。沉浸式（
// setWindowLayoutFullScreen(true)）会绕过 ArkUI 默认 KeyboardAvoidMode，
// TextInput 不会自动上移，所以由 Onboarding/Lock 等密码页根据 keyboard 高度
// 在最外层 Column padding({ bottom: ... }) 来主动避让。

@ObservedV2
export class SafeAreaState {
  @Trace top: number = 0;
  @Trace bottom: number = 0;
  /** 键盘弹出时占据的高度（vp）；不弹时为 0 */
  @Trace keyboard: number = 0;
}

export const safeAreaState: SafeAreaState = new SafeAreaState();
