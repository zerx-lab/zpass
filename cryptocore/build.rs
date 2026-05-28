// cryptocore build script
//
// 仅在 feature=harmony 时调用 napi-build —— 它会插入 napi 模块注册符号
// 以及导出 dynamic linker 期望的 `napi_register_module_v1` 入口。
//
// 其他 target（rlib / android JNI / staticlib for iOS）不需要此步骤；
// build-dependencies 不能 optional，但 napi-build 自身的 setup() 只在
// 显式调用时才生效，所以这里用 cfg 守门即可。

fn main() {
    #[cfg(feature = "harmony")]
    {
        napi_build_ohos::setup();
    }
}
