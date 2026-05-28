@Entry
@Component
struct Index {
  build() {
    Column({ space: 16 }) {
      Text('ZPass')
        .fontSize(36)
        .fontWeight(FontWeight.Bold)
        .fontColor('#FFFFFF');

      Text('HarmonyOS skeleton — ready to grow')
        .fontSize(14)
        .fontColor('#9CB3D9');
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#0A2540');
  }
}
