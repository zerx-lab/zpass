#!/usr/bin/env bash
# ZPass 官网服务器侧部署脚本
# ---------------------------------------------------------------------------
# 由 GitHub Actions 通过 SSH 在服务器上执行：
#   1. 在 git 仓库内拉取目标分支最新代码（hard reset，保证与远端一致）
#   2. 用 docker compose 重建并滚动重启 website 服务
#   3. 清理悬空镜像，避免磁盘膨胀
#
# 约定：本脚本所在目录即 website 项目目录（DEPLOY_PATH），
# 其上游某层是 git 仓库根。脚本对该仓库做 fetch/reset。
#
# 用法：./deploy.sh [branch]   branch 缺省为 main
# ---------------------------------------------------------------------------
set -euo pipefail

BRANCH="${1:-main}"

# 切到脚本所在目录（= website 项目目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 定位 git 仓库根并同步代码
REPO_ROOT="$(git rev-parse --show-toplevel)"
echo "==> 仓库根: $REPO_ROOT，目标分支: $BRANCH"
git -C "$REPO_ROOT" fetch --prune origin "$BRANCH"
git -C "$REPO_ROOT" checkout "$BRANCH"
git -C "$REPO_ROOT" reset --hard "origin/$BRANCH"

# 选择可用的 compose 命令（docker compose 优先，回退 docker-compose）
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "!! 未找到 docker compose / docker-compose" >&2
  exit 1
fi

echo "==> 构建并重启 website 服务"
$COMPOSE up -d --build website

echo "==> 清理悬空镜像"
docker image prune -f >/dev/null 2>&1 || true

echo "==> 部署完成"
$COMPOSE ps website
