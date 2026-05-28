# cryptocore .so placeholder
#
# 真实的 libcryptocore.so 由 `cryptocore/scripts/build-harmony.sh` 产出
# 并由 `harmony/Taskfile.yml` 的 `task crypto` 复制到这里。
#
# 这个 placeholder 让 git 保留目录结构。.so 自身在 .gitignore 内不入库
# （二进制工件，应每次本地构建）。
