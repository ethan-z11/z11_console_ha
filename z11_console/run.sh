#!/usr/bin/with-contenv bashio

bashio::log.info "启动 Z11 Console（Ingress 端口 8765，数据目录 /data）"

# SUPERVISOR_TOKEN 由 Supervisor 注入，后端检测到后自动连接 http://supervisor/core，无需手动配置。
cd /app/server
exec python3 -m home_console_server
