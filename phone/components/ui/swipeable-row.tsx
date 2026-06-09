// SwipeableRow —— 自实现的「左滑露出动作」行组件
//
// 取代 react-native-gesture-handler/ReanimatedSwipeable，针对密码列表场景做了
// 平滑度与手感打磨：
//   · UI 线程驱动（Gesture.Pan + Reanimated shared value），无 JS 桥抖动；
//   · 速度感应吸附（位置阈值 + 手势速度投影共同决定开/合），贴近 iOS 邮件；
//   · 橡皮筋阻尼（反向拖拽 / 超程拖拽都有阻力，不生硬到底）；
//   · 动作区与行内容 1:1 联动滑入，全程无缝隙；超程时露出末位动作色（拉伸感）；
//   · 单行展开内置（模块级注册表，展开新行自动收起旧行）；
//   · 展开态拦截行内容点击（收起而非误触跳转）；
//   · 吸附到展开时给一次轻触感。
//
// 仅实现「右侧动作（左滑露出）」，与列表页诉求一致；如需左侧动作可对称扩展。

import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { Spacing, Type } from "@/constants/theme";
import { IconSymbol } from "@/components/ui/icon-symbol";

type IconName = ComponentProps<typeof IconSymbol>["name"];

export interface SwipeAction {
  /** React key */
  key: string;
  icon: IconName;
  label: string;
  /** 背景色 */
  color: string;
  onPress: () => void;
}

export interface SwipeableRowHandle {
  /** 弹簧收起 */
  close: () => void;
  /** 弹簧展开（露出全部右侧动作） */
  open: () => void;
}

export interface SwipeableRowProps {
  /** 右侧动作（左滑露出），从左到右排列 */
  rightActions: SwipeAction[];
  children: ReactNode;
  /** 单个动作宽度（默认 76） */
  actionWidth?: number;
  /** 是否启用滑动（默认 true） */
  enabled?: boolean;
  /** 吸附到展开/收起的回调（UI→JS） */
  onOpen?: () => void;
  onClose?: () => void;
}

/* ── 调参常量 ─────────────────────────────────────────────────── */

const DEFAULT_ACTION_WIDTH = 76;

// 展开时的弹簧：略带回弹，干脆利落
const OPEN_SPRING = {
  damping: 26,
  stiffness: 300,
  mass: 0.7,
  overshootClamping: false,
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 2,
} as const;

// 收起时的弹簧：钳制回弹，避免越过 0 露出左侧空隙
const CLOSE_SPRING = {
  damping: 30,
  stiffness: 320,
  mass: 0.7,
  overshootClamping: true,
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 2,
} as const;

// 反向（向右）拖拽阻尼系数：越小越「拉不动」
const RUBBER_REVERSE = 0.16;
// 超过完全展开后的阻尼系数
const RUBBER_OVERSHOOT = 0.22;

/* ── 模块级单行展开注册表 ─────────────────────────────────────── */
// 同一时间只允许一行展开；展开新行时自动收起上一行（iOS 邮件/微信习惯）。

let activeRow: SwipeableRowHandle | null = null;

function activate(row: SwipeableRowHandle) {
  if (activeRow && activeRow !== row) activeRow.close();
  activeRow = row;
}

function deactivate(row: SwipeableRowHandle) {
  if (activeRow === row) activeRow = null;
}

/* ── 单个动作按钮 ─────────────────────────────────────────────── */
// 动作内容随展开进度做轻微缩放/淡入，增强「浮现」质感（UI 线程）。

function ActionButton({
  action,
  width,
  progress,
  index,
  count,
}: {
  action: SwipeAction;
  width: number;
  progress: SharedValue<number>;
  index: number;
  count: number;
}) {
  // 越靠内（左）的动作越晚浮现，形成轻微错峰
  const start = 0.2 + (index / count) * 0.4;
  const contentStyle = useAnimatedStyle(() => {
    const p = interpolate(
      progress.value,
      [start, 1],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity: p,
      transform: [{ scale: 0.6 + p * 0.4 }],
    };
  });

  return (
    <Pressable
      onPress={action.onPress}
      style={[styles.action, { width, backgroundColor: action.color }]}
      android_ripple={{ color: "rgba(255,255,255,0.18)" }}
    >
      <Animated.View style={[styles.actionInner, contentStyle]}>
        <IconSymbol name={action.icon} size={20} color="#fff" />
        <Text style={styles.actionLabel} numberOfLines={1}>
          {action.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/* ── 主组件 ───────────────────────────────────────────────────── */

export const SwipeableRow = forwardRef<SwipeableRowHandle, SwipeableRowProps>(
  function SwipeableRow(
    {
      rightActions,
      children,
      actionWidth = DEFAULT_ACTION_WIDTH,
      enabled = true,
      onOpen,
      onClose,
    },
    ref,
  ) {
    const count = rightActions.length;
    const maxDrag = actionWidth * count;

    const translateX = useSharedValue(0);
    const startX = useSharedValue(0);
    // 0=收起 1=完全展开，供动作内容浮现插值
    const progress = useSharedValue(0);

    const [isOpen, setIsOpen] = useState(false);

    // 末位动作色：超程拖拽时填充背板缝隙，模拟 iOS「拉伸末位动作」
    const lastColor = count > 0 ? rightActions[count - 1].color : "transparent";

    // 稳定的 handle 引用，用于注册表去重
    const handleRef = useRef<SwipeableRowHandle | null>(null);

    const markOpen = useCallback(() => {
      setIsOpen(true);
      if (handleRef.current) activate(handleRef.current);
      onOpen?.();
    }, [onOpen]);

    const markClosed = useCallback(() => {
      setIsOpen(false);
      if (handleRef.current) deactivate(handleRef.current);
      onClose?.();
    }, [onClose]);

    const fireHaptic = useCallback(() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    // 普通 JS 函数：从 JS 线程写 shared value + withSpring 完全合法，
    // 动画本身仍在 UI 线程执行。手势 onEnd（worklet）通过 runOnJS 调用它，
    // 避免把它标成 worklet 后跨线程调用的捕获坑。
    const animateTo = useCallback(
      (open: boolean, withHaptic = false) => {
        const target = open ? -maxDrag : 0;
        const spring = open ? OPEN_SPRING : CLOSE_SPRING;
        progress.value = withSpring(open ? 1 : 0, spring);
        translateX.value = withSpring(target, spring, (finished) => {
          // 此回调由 Reanimated 自动 workletize，在 UI 线程完成时触发
          if (finished) {
            if (open) runOnJS(markOpen)();
            else runOnJS(markClosed)();
          }
        });
        if (open && withHaptic) fireHaptic();
      },
      [maxDrag, progress, translateX, markOpen, markClosed, fireHaptic],
    );

    // 命令式 API（供调用方在动作处理后收起 / 程序化展开）
    useImperativeHandle(ref, () => {
      const handle: SwipeableRowHandle = {
        close: () => {
          // JS 线程触发 worklet 写入 shared value，Reanimated 会在 UI 线程动画
          animateTo(false);
        },
        open: () => {
          animateTo(true);
        },
      };
      handleRef.current = handle;
      return handle;
    }, [animateTo]);

    const pan = useMemo(() => {
      return (
        Gesture.Pan()
          .enabled(enabled && count > 0)
          // 仅水平意图超过 12px 才接管，给 FlatList 垂直滚动让路
          .activeOffsetX([-12, 12])
          .failOffsetY([-14, 14])
          .onStart(() => {
            startX.value = translateX.value;
          })
          .onUpdate((e) => {
            let next = startX.value + e.translationX;
            if (next > 0) {
              // 向右（收起方向）超出：橡皮筋阻尼
              next = next * RUBBER_REVERSE;
            } else if (next < -maxDrag) {
              // 超过完全展开：橡皮筋阻尼
              const overshoot = next + maxDrag; // 负值
              next = -maxDrag + overshoot * RUBBER_OVERSHOOT;
            }
            translateX.value = next;
            progress.value = interpolate(
              next,
              [-maxDrag, 0],
              [1, 0],
              Extrapolation.CLAMP,
            );
          })
          .onEnd((e) => {
            // 速度投影：预测松手后惯性落点，再结合位置阈值决定开/合
            const projected = translateX.value + e.velocityX * 0.12;
            const wasOpen = startX.value <= -maxDrag / 2;
            let open: boolean;
            if (e.velocityX < -800) open = true;
            else if (e.velocityX > 800) open = false;
            else open = projected < -maxDrag * 0.5;
            // onEnd 是 UI 线程 worklet，切回 JS 启动弹簧（仅松手一次，无性能损耗）
            // 仅在「由合变开」的瞬间给触感
            runOnJS(animateTo)(open, open && !wasOpen);
          })
      );
    }, [enabled, count, maxDrag, startX, translateX, progress, animateTo]);

    const frontStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: translateX.value }],
    }));

    // 动作区与行内容 1:1 联动：始终紧贴行内容右缘滑入，全程无缝隙
    const actionsStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: translateX.value + maxDrag }],
    }));

    const handleOverlayPress = useCallback(() => {
      animateTo(false);
    }, [animateTo]);

    if (count === 0) {
      return <>{children}</>;
    }

    return (
      <View style={styles.root}>
        {/* 背板：右侧动作，置于行内容之下 */}
        <Animated.View
          style={[
            styles.actionsContainer,
            { width: maxDrag, backgroundColor: lastColor },
            actionsStyle,
          ]}
        >
          {rightActions.map((action, i) => (
            <ActionButton
              key={action.key}
              action={action}
              width={actionWidth}
              progress={progress}
              index={i}
              count={count}
            />
          ))}
        </Animated.View>

        {/* 前景：行内容 */}
        <GestureDetector gesture={pan}>
          <Animated.View style={frontStyle}>
            {children}
            {/* 展开态：透明遮罩拦截点击，点行内容即收起（避免误触跳转） */}
            {isOpen && (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={handleOverlayPress}
              />
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  root: {
    position: "relative",
    overflow: "hidden",
  },
  actionsContainer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "stretch",
  },
  action: {
    alignItems: "center",
    justifyContent: "center",
  },
  actionInner: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: Spacing.sm,
  },
  actionLabel: {
    ...Type.caption,
    fontSize: 11,
    fontWeight: "600",
    color: "#fff",
  },
});
