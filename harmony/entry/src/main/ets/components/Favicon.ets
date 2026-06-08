// Favicon —— 「网站 icon + 字形回退」统一头像组件
//
// 行为对标 desktop ItemIcon：
//   - 有 host（login.url / passkey.rpId）→ 异步取站点 favicon（见 lib/Favicon）
//   - 加载中 / 失败 / 无 host / 非可联网类型 → 回退到品牌色块 + 首字母字形
//
// 取到 favicon 后用「浅底 + 1px 软描边 + 内留白」的图标卡承载（与 desktop 一致），
// 让裸 logo 不顶满、不直接贴行底色。
//
// 加载是幂等的：lib/Favicon 内有内存 + 磁盘缓存，重复挂载（列表滚动 / 重进页面）
// 命中缓存即同步返回，不重复发网络。

import { ZColors, ZColorsClass, ZRadius } from '../theme/Tokens';
import { faviconColor, faviconInitials } from '../lib/Format';
import { extractHost, resolveFavicon } from '../lib/Favicon';

@ComponentV2
export struct Favicon {
  /** 条目显示名 —— 字形回退用 */
  @Param @Require name: string;
  /** 原始 host 串（login.url / passkey.rpId）；为空则只显示字形 */
  @Param host: string | null = null;
  /** 方块边长（vp）—— 避开与内置属性 size() 重名 */
  @Param boxSize: number = 38;
  /** 外圆角 */
  @Param radius: number = ZRadius.lg;
  /** 字形字号 */
  @Param fontSize: number = 15;

  @Local zc: ZColorsClass = ZColors;
  @Local pixel: PixelMap | undefined = undefined;

  aboutToAppear(): void {
    this.loadFavicon();
  }

  // host 变化（如详情页重载到另一条目）时重取
  @Monitor('host')
  onHostChange(): void {
    this.pixel = undefined;
    this.loadFavicon();
  }

  private async loadFavicon(): Promise<void> {
    const h = extractHost(this.host);
    if (!h) return;
    try {
      const pm = await resolveFavicon(h);
      if (pm) this.pixel = pm;
    } catch (_e) {
      // 失败保持字形回退
    }
  }

  build() {
    // 单一根容器；if/else 只能出现在容器内，不能作为 build 根节点。
    // 加载成功 → 图标卡（浅底 + 软描边 + 内留白）；否则 → 品牌色块 + 字形。
    Column() {
      if (this.pixel) {
        Image(this.pixel)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Contain)
          .draggable(false);
      } else {
        Text(faviconInitials(this.name))
          .fontSize(this.fontSize)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.zc.faviconInk);
      }
    }
    .width(this.boxSize)
    .height(this.boxSize)
    .padding(this.pixel ? (this.boxSize >= 56 ? 8 : 4) : 0)
    .borderRadius(this.radius)
    .backgroundColor(this.pixel ? this.zc.bgElev2 : faviconColor(this.name))
    .border(this.pixel ? { width: 0.5, color: this.zc.lineSoft } : { width: 0 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .clip(true)
    .flexShrink(0);
  }
}
