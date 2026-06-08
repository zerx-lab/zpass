import { motion } from '@kit.MultimodalAwarenessKit';

type HoldingCb = (s: motion.HoldingHandStatus) => void;

@ObservedV2
export class MotionStore {
  @Trace gripEnabled: boolean = false;
  /** true = 左手持机，FAB 移到左侧 */
  @Trace holdingLeft: boolean = false;

  private cb: HoldingCb | null = null;

  setGripEnabled(v: boolean): void {
    this.gripEnabled = v;
    if (v) {
      this.subscribe();
    } else {
      this.unsubscribe();
    }
  }

  subscribe(): void {
    if (this.cb) return;
    try {
      this.cb = (s: motion.HoldingHandStatus): void => {
        this.holdingLeft = s === motion.HoldingHandStatus.LEFT_HAND_HELD;
      };
      motion.on('holdingHandChanged', this.cb);
    } catch (_e) {
      this.cb = null;
    }
  }

  unsubscribe(): void {
    if (!this.cb) return;
    try {
      motion.off('holdingHandChanged', this.cb);
    } catch (_e) {}
    this.cb = null;
    this.holdingLeft = false;
  }
}

export const motionStore = new MotionStore();
