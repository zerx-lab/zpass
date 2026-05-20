// 独立小模块 —— 故意与 desktop/go.mod 隔离。
//
// 这个工具的职责是在 desktop/third_party/wails-v3/ 里物化一份打过
// "KDE 标题栏" 补丁的 Wails 3 源码，并生成 desktop/go.work 把主模块
// 重定向到这份本地副本。
//
// 为什么要单独 go.mod？因为这个工具必须能在 go.work / replace
// 链路都还没建立的时候运行（首次 clone 后的 bootstrap 场景）；如果
// 它和 desktop/go.mod 同模块，那么一旦未来 desktop/go.work 引入了
// 指向不存在路径的 replace 指令，连这个 setup 工具自身都跑不起来。
// 分模块即可彻底切断这条依赖循环。
//
// 这里只依赖标准库，不需要额外 require。
module github.com/zerx-lab/zpass/zpass-desktop/scripts/setup-wails

go 1.25
