// Sync —— 设备间端到端同步（占位）
//
// 完整的 PAKE 同步协议（phone/lib/sync-protocol.ts 1137 行 + cryptocore::sync）
// 需要：
//   1. 在 cryptocore napi 桥追加导出 SyncPake / SyncSession / SyncMerge
//   2. ArkTS 侧重写 sync-protocol（WebSocket + CBOR + 状态机）
//   3. PIN 输入 / 显示 UI
//
// 当前为占位页：提示用户走 desktop / phone 同步，鸿蒙端将在后续 Phase 接入。
//
// 字节级一致性保证：cryptocore::sync 已通过单测；接入鸿蒙时直接复用 .so 内的
// 同一份 Rust 实现，与 desktop / phone 三端完全字节级对齐。

import { ZColors, ZRadius, ZSpacing, ZType } from '../theme/Tokens';
import { router } from '@kit.ArkUI';
import { safeAreaState, SafeAreaState } from '../state/SafeArea';

@Entry
@ComponentV2
struct Sync {
  @Local safeArea: SafeAreaState = safeAreaState;

  build() {
    Column() {
      Row().height(this.safeArea.top).width('100%');

      Row({ space: ZSpacing.sm }) {
        Text('返回')
          .fontSize(ZType.bodySize)
          .fontColor(ZColors.text2)
          .onClick(() => router.back());
        Text('设备同步')
          .fontSize(ZType.title2Size)
          .fontWeight(FontWeight.Bold)
          .fontColor(ZColors.text)
          .layoutWeight(1)
          .textAlign(TextAlign.Center);
        Text(' ').fontSize(ZType.bodySize);
      }
      .width('100%')
      .padding({
        left: ZSpacing.lg,
        right: ZSpacing.lg,
        top: ZSpacing.sm,
        bottom: ZSpacing.sm,
      });

      Column({ space: ZSpacing.lg }) {
        Column() {
          Text('S')
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(ZColors.text3);
        }
        .width(72)
        .height(72)
        .borderRadius(ZRadius.xl)
        .backgroundColor(ZColors.bgElev)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center);

        Text('设备同步即将上线')
          .fontSize(ZType.titleSize)
          .fontWeight(FontWeight.Bold)
          .fontColor(ZColors.text);

        Text(
          '端到端加密的设备间同步（PAKE 握手 + XChaCha20）需要在 cryptocore napi 桥追加 SPAKE2 + 会话编解码导出，鸿蒙端的接入预计在下一个迭代完成。\n\n' +
          '当前可用替代：\n' +
          '· desktop 端可与已有 phone / extension 互通同步\n' +
          '· vault 文件 schema 与三端完全一致，未来鸿蒙加入同步无需迁移数据',
        )
          .fontSize(ZType.bodySize)
          .fontColor(ZColors.text2)
          .lineHeight(22)
          .textAlign(TextAlign.Start)
          .width('100%');
      }
      .layoutWeight(1)
      .width('100%')
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .padding({ left: ZSpacing.xl, right: ZSpacing.xl });

      Row().height(this.safeArea.bottom).width('100%');
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ZColors.bg)
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM]);
  }
}
