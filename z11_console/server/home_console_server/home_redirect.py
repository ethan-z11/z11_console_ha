"""HA 首页跳转：把控制台面板「强制设为首页」的开关实现。

背景：Ingress 面板不是 Lovelace 仪表盘，进不了 HA 的默认页选择器。这里的做法是——
向 HA 配置目录写入一个跳转脚本（/homeassistant/www/z11-home.js），并通过 HA WebSocket API
把它注册为 Lovelace 资源；每次打开 HA 落在默认仪表盘时，脚本自动跳转到本面板。
关闭开关：删除资源注册（脚本文件随之删除）。

依赖：
- config.yaml 的 `map: homeassistant_config:rw`（HA 配置目录映射到容器内 /homeassistant）
- homeassistant_api: true（SUPERVISOR_TOKEN 走 WS API 注册资源，以及查询本加载项 slug）
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import aiohttp

log = logging.getLogger("home_console_server")

HA_CONFIG = Path("/homeassistant")  # homeassistant_config 映射在容器内的位置
SCRIPT_NAME = "z11-home.js"
RESOURCE_URL = f"/local/{SCRIPT_NAME}"

# 跳转脚本：落在默认仪表盘时跳到本面板。新版 HA 默认面板是 home（/home/overview），旧版是 lovelace，
# 这里动态读 hass.defaultPanel（兜底 home）并兼容 /lovelace*，避免写死路径。
# 资源模块每次整页加载只执行一次（ES module 缓存），之后手动点「概览」是 SPA 导航不会重跑；
# hass 可能尚未就绪，故 500ms 重试一次，done 确保每次整页加载只跳转一次，performance.now() 兜底只覆盖刚打开 HA 的几秒。
SCRIPT_TEMPLATE = """// 由 Z11 Console 加载项自动写入：打开 HA 落在默认仪表盘时自动进入 Z11 Console 面板。
// 在 Z11 Console 设置页关闭「设为 HA 首页」后，此文件与资源注册会被移除。
(() => {
  const target = %s;
  let done = false;
  const go = () => {
    if (done || performance.now() > 30000) return;
    const path = location.pathname.replace(/\\/+$/, '');
    const panel = (document.querySelector('home-assistant') || {}).hass?.defaultPanel || 'home';
    const onDefault = path === '' || path === '/lovelace' || path.startsWith('/lovelace/')
      || path === '/' + panel || path.startsWith('/' + panel + '/');
    if (!onDefault) return;
    done = true;
    history.replaceState(null, '', target);
    window.dispatchEvent(new Event('location-changed'));
  };
  go();
  let tries = 0;
  const timer = setInterval(() => { if (done || ++tries > 20) clearInterval(timer); else go(); }, 500);
})();
"""


async def _addon_slug() -> str:
    """向 Supervisor 查询本加载项的完整 slug（带仓库前缀），用于拼 ingress 路径。"""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("此功能仅在 HA 加载项中可用")
    async with aiohttp.ClientSession() as session:
        async with session.get(
            "http://supervisor/addons/self/info",
            headers={"Authorization": f"Bearer {token}"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"查询加载项信息失败（HTTP {response.status}）")
            data = await response.json()
    slug = (data.get("data") or {}).get("slug")
    if not slug:
        raise RuntimeError("未能获取加载项标识")
    return str(slug)


async def _find_resource(upstream: Any) -> str | None:
    """在 Lovelace 资源列表里找我们注册的那条，返回资源 id。"""
    resources = await upstream.command({"type": "lovelace/resources"})
    for item in resources or []:
        if isinstance(item, dict) and item.get("url") == RESOURCE_URL:
            return str(item.get("id"))
    return None


async def set_home_redirect(upstream: Any, enabled: bool) -> None:
    """启用 / 关闭首页跳转。失败抛异常（由调用方转成 409 返回前端）。"""
    script_path = HA_CONFIG / "www" / SCRIPT_NAME
    if enabled:
        if not HA_CONFIG.exists():
            raise RuntimeError("找不到 HA 配置目录，请先把加载项更新到最新版本")
        target = f"/hassio/ingress/{await _addon_slug()}"
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script_path.write_text(SCRIPT_TEMPLATE % json.dumps(target), encoding="utf-8")
        if await _find_resource(upstream) is None:
            await upstream.command({"type": "lovelace/resources/create", "res_type": "module", "url": RESOURCE_URL})
        log.info("已启用 HA 首页跳转（%s）", target)
    else:
        resource_id = await _find_resource(upstream)
        if resource_id is not None:
            await upstream.command({"type": "lovelace/resources/delete", "resource_id": resource_id})
        script_path.unlink(missing_ok=True)
        log.info("已关闭 HA 首页跳转")
