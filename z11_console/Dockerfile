# HAOS 加载项镜像：BUILD_FROM 由 Supervisor / 官方构建器按架构注入（见 build.yaml）。
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.20
ARG NODE_IMAGE=node:20-alpine

# ============================================================
# Stage 1: 构建前端 (Vite + React + TypeScript)
# ============================================================
FROM ${NODE_IMAGE} AS frontend

WORKDIR /build

# 先复制依赖描述文件，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 复制源码并构建（base 为 ./，资源走相对路径以兼容 Ingress 子路径）
COPY . .
RUN npm run build

# ============================================================
# Stage 2: 运行时（HA 基础镜像 + Python 后端 + 静态文件）
# ============================================================
FROM ${BUILD_FROM}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME_CONSOLE_HOST=0.0.0.0 \
    HOME_CONSOLE_PORT=8765 \
    HOME_CONSOLE_DATA=/data \
    HOME_CONSOLE_STATIC=/app/dist

# cryptography / aiohttp 用 Alpine 预编译包，覆盖全部架构，避免 pip 拉源码编译。
# ffmpeg：摄像头 RTSP → MJPEG 实时转码、ONVIF 不支持事件时的帧差检测都依赖它。
RUN apk add --no-cache python3 py3-aiohttp py3-cryptography ffmpeg

WORKDIR /app/server

COPY server/ ./
COPY --from=frontend /build/dist /app/dist
COPY run.sh /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
