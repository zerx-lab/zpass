# ZPass 官网（Astro + @astrojs/node standalone SSR）容器镜像
# ---------------------------------------------------------------------------
# astro.config.mjs 用 @astrojs/node(mode:"standalone") 适配器，整站以 static
# 预渲染为主，个别端点按需 SSR，产物入口 dist/server/entry.mjs，需 Node 长驻
# 进程托管静态资源 + 动态端点，故必须容器化运行而非纯静态托管。
#
# 多阶段：
#   1) deps/build  用 bun 装依赖并 `astro build`
#   2) runtime     仅拷构建产物 + 生产依赖，用精简 node 跑 entry.mjs
# ---------------------------------------------------------------------------

# ---- build stage ----------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# 先拷锁文件，最大化利用 Docker 层缓存
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# 拷源码并构建
COPY . .
RUN bun run build

# ---- runtime stage --------------------------------------------------------
# @astrojs/node 9 要求 Node >= 18.17，与 nixpacks.toml 保持 22 LTS 对齐
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321

# standalone 产物入口 entry.mjs 运行时仍引用磁盘上的 node_modules（astro
# 运行时等生产依赖未被打包内联），故需连同 dist 与 node_modules 一并拷入。
# 直接复用 build 阶段已装好的 node_modules，避免 runtime 阶段再装一次。
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
