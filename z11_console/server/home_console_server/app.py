"""家庭控制台后端入口。

浏览器只和本服务通信：
- WebSocket /api/ws：推送数据来源、控制开关、HA 连接状态、自动发现的设备目录、实体状态和共用布局；接收按实体发起的控制请求。
- PUT /api/layout：保存全家共用的布局（卡片尺寸、顺序、常用设备、房间顺序）。
- /api/admin/*：4 位管理密码登录后管理 HA 地址、令牌、控制开关、数据来源、设备过滤（黑名单 / 白名单）和管理密码，查看操作记录，
  查看并开关 HA 自动化（只调用 automation.turn_on / turn_off，见 automations.py），
  启用季节规则后由本服务在 HA 中维护季节辅助元素与季节自动化（见 season.py）。
- /api/weather*：代理中国天气网（weather.com.cn）的城市搜索、实时天气与 7 天预报（见 weather.py）。
HA 令牌只保存在服务端，从不发给浏览器。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import aiohttp
from aiohttp import WSMsgType, web

from .auth import LoginLimiter, Sessions
from .automations import DOMAIN as AUTOMATION_DOMAIN, build_automations, demo_automations
from .cameras import BOUNDARY as CAMERA_BOUNDARY, CameraStreamer
from .discovery import SCENE_DOMAINS, build_catalogue, filtered, visible_ids
from .go2rtc import ADDON_CANDIDATES, PLAYER_MODES, check, detect, ensure_stream, normalize_base, proxy_static, proxy_ws
from .ha import HaUpstream
from .motion import PTZ_DIRECTIONS, MotionScreenshotter
from .onvif import OnvifError, OnvifManager
from .season import HELPER_ENTITY as SEASON_HELPER, SEASONS, SeasonRules
from .store import ACCENTS, BRAND_TITLE_MAX, DEFAULT_BRAND_TITLE, DEFAULT_HOME_TITLE, HOME_TITLE_MAX, THEMES, TILE_SCALE_MAX, TILE_SCALE_MIN, USERNAME_MAX, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX, ACCOUNTS_MAX, Account, Store, clean_custom, hash_pin, id_list, is_tile_scale, verify_pin, OCCUPIED_STATES
from .weather import Weather, WeatherError, valid_location

log = logging.getLogger("home_console_server")

SERVER_DIR = Path(__file__).resolve().parent.parent
COOKIE = "hc_session"  # 会话 Cookie 名（账户系统替换原 hc_admin PIN Cookie）
SESSION_MAX_AGE = 30 * 24 * 3600  # 记住登录：Cookie 30 天
EMPTY_CATALOGUE: dict[str, Any] = {"labels": [], "rooms": [], "entities": []}
REFRESH_DELAY = 0.5

# ---------- Cookie 策略：SameSite / Secure 可通过环境变量配置 ----------
# 适用于被 Home Assistant 等第三方页面以 iframe 嵌入的场景：
# - 同站（同 IP）嵌入：Strict / Lax 均可，默认 Strict 最安全。
# - 跨站（不同 IP）嵌入：必须用 None，且浏览器要求 SameSite=None 必须带 Secure（HTTPS）。
#   纯 HTTP 跨站嵌入浏览器不允许携带 Cookie，需用反向代理把控制台与 HA 变成同站。
COOKIE_SAMESITE = os.environ.get("HOME_CONSOLE_COOKIE_SAMESITE", "Strict").strip().capitalize()
if COOKIE_SAMESITE not in ("Strict", "Lax", "None"):
    COOKIE_SAMESITE = "Strict"
# Secure 显式开关；SameSite=None 时强制 Secure（浏览器硬性要求）。
COOKIE_SECURE = os.environ.get("HOME_CONSOLE_COOKIE_SECURE", "").lower() in ("1", "true", "yes")


def _cookie_attrs(request: web.Request) -> dict[str, Any]:
    """统一生成 Cookie 属性：httponly + 可配置的 samesite/secure/path。"""
    samesite = COOKIE_SAMESITE
    secure = COOKIE_SECURE or request.secure or samesite == "None"
    return {"httponly": True, "samesite": samesite, "path": "/", "secure": secure}


# ---------- 服务白名单：只允许这些服务及参数，目标必须是当前页面可见的实体 ----------

def _number(low: float, high: float) -> Callable[[Any], bool]:
    return lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high


def _short_text(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 40


def _rgb(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_number(0, 255)(part) for part in value)


ALLOWED_SERVICES: dict[str, dict[str, dict[str, Callable[[Any], bool]]]] = {
    "light": {
        "turn_on": {"brightness_pct": _number(1, 100), "color_temp_kelvin": _number(1000, 12000), "rgb_color": _rgb},
        "turn_off": {},
    },
    "climate": {
        "set_hvac_mode": {"hvac_mode": _short_text},
        "set_temperature": {"temperature": _number(5, 40)},
        "set_fan_mode": {"fan_mode": _short_text},
        "set_swing_mode": {"swing_mode": _short_text},
    },
    "media_player": {
        "turn_on": {},
        "turn_off": {},
        "media_play_pause": {},
        "volume_set": {"volume_level": _number(0, 1)},
    },
    # 风扇 / 新风机：开关、百分比风速、预设风类（直吹风 / 自然风 / 进风 等）、摇头。
    "fan": {
        "turn_on": {"percentage": _number(1, 100), "preset_mode": _short_text},
        "turn_off": {},
        "set_percentage": {"percentage": _number(0, 100)},
        "set_preset_mode": {"preset_mode": _short_text},
        "oscillate": {"oscillating": lambda value: isinstance(value, bool)},
    },
    # 窗帘 / 卷帘：开合、停止、按位置开合（0 全关 - 100 全开）。
    "cover": {
        "open_cover": {},
        "close_cover": {},
        "stop_cover": {},
        "set_cover_position": {"position": _number(0, 100)},
    },
    # 扫地机器人：开始 / 暂停 / 停止清扫、回充、定点清扫、寻找、风速档位。
    "vacuum": {
        "start": {},
        "pause": {},
        "stop": {},
        "return_to_base": {},
        "clean_spot": {},
        "locate": {},
        "set_fan_speed": {"fan_speed": _short_text},
    },
    # 普通开关 / 智能插座：只有开与关。
    "switch": {
        "turn_on": {},
        "turn_off": {},
    },
    # HA 助手类布尔开关（input_boolean）：服务与普通开关相同，卡片也按开关显示。
    "input_boolean": {
        "turn_on": {},
        "turn_off": {},
    },
    # 情景模式按钮：一键执行类实体，只允许无参数调用，且目标必须是设置中已配置的实体。
    "scene": {"turn_on": {}},
    "script": {"turn_on": {}},
    "button": {"press": {}},
    "input_button": {"press": {}},
    "automation": {"trigger": {}},
}


def normalize_ha_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")


def normalize_embed_url(value: str) -> str | None:
    """音乐页等内嵌页地址：必须是完整 http(s) URL，保留路径与查询串；空串表示未设置。"""
    value = value.strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return parts.geturl()


class ConsoleServer:
    def __init__(self, data_dir: Path) -> None:
        self.store = Store(data_dir)
        # HAOS 加载项：Supervisor 注入 SUPERVISOR_TOKEN，自动直连本机 HA，无需手动填地址与令牌。
        # 令牌随容器重建轮换，每次启动以注入值为准；用户已在设置页改过地址时保留。
        if supervisor_token := os.environ.get("SUPERVISOR_TOKEN"):
            if not self.store.settings.ha_url:
                self.store.settings.ha_url = "http://supervisor/core"
            self.store.settings.data_source = "live"
            self.store.set_token(supervisor_token)
            self.store.save()
        # 会话持久化到 sessions.json：重启后浏览器复用 Cookie 免重新登录。
        self.sessions = Sessions(self.store.sessions_path)
        self.limiter = LoginLimiter()
        self.clients: set[web.WebSocketResponse] = set()
        self._tasks: set[asyncio.Task[None]] = set()
        self.upstream = HaUpstream(self._on_status, self._on_states, self._on_registry)
        self.weather = Weather()
        # 自动发现：registries 为 HA 的区域 / 设备 / 实体 / 标签注册表；discovered 为过滤前的完整目录。
        self.registries: tuple[list[Any], list[Any], list[Any], list[Any]] | None = None
        self.discovered: dict[str, Any] = EMPTY_CATALOGUE
        self.known_ids: set[str] = set()
        self.visible: set[str] = set()
        self._refresh_task: asyncio.Task[None] | None = None
        self._refresh_dirty = False
        self._refresh_fetch = False
        # 演示模式下的自动化只存在内存中，重启服务后复位。
        self.demo_automations = demo_automations()
        self.season = SeasonRules(self.store, self.upstream, lambda: "控制台服务", self._broadcast_status)
        # RTSP 摄像头 → MJPEG 转码器（ffmpeg 路径在模块内自动探测）。
        self.camera_streamer = CameraStreamer()
        # ONVIF 摄像头：探测取流地址 / 云台能力；运动检测截图存 data/camera-shots/。
        self.onvif = OnvifManager()
        self.shots_dir = data_dir / "camera-shots"
        self.motion = MotionScreenshotter(self.camera_streamer.ffmpeg_path, self.shots_dir, self._camera_rtsp_url, self.onvif,
                                          occupied=self._scope_occupied)

    def _camera_entry(self, camera_id: str) -> dict[str, Any] | None:
        return next((item for item in self.store.custom.get("cameras", []) if item.get("id") == camera_id), None)

    async def _camera_rtsp_url(self, camera: dict[str, Any]) -> str:
        """按摄像头配置拿到可直接喂给 ffmpeg 的 RTSP 地址：RTSP 类型直取，ONVIF 类型动态探测。"""
        if camera.get("type") == "onvif":
            return (await self.onvif.resolve(camera)).rtsp_url
        return str(camera["rtspUrl"])

    # ---------- HA 连接与自动发现 ----------

    async def reconnect(self) -> None:
        settings = self.store.settings
        await self.upstream.configure(settings.ha_url, self.store.token(), settings.data_source == "live")

    def catalogue(self) -> dict[str, Any]:
        return filtered(self.discovered, self.visible)

    async def _broadcast_status(self) -> None:
        await self.broadcast(self.status_message())

    async def _on_status(self, status: dict[str, Any]) -> None:
        if status["kind"] == "connected":
            self.schedule_refresh(fetch=True)
        elif status["kind"] in ("disabled", "unconfigured", "auth_failed"):
            self.registries = None
            self.known_ids = set()
            await self._apply_catalogue(EMPTY_CATALOGUE)
        await self.broadcast(self.status_message())

    async def _on_states(self, _states: dict[str, Any], changed: dict[str, Any]) -> None:
        # 出现从未见过的实体（新设备或首次快照）时重新发现；注册表变更另有事件触发。
        if any(state is not None and entity_id not in self.known_ids for entity_id, state in changed.items()):
            self.schedule_refresh(fetch=False)
        if SEASON_HELPER in changed:
            await self.broadcast(self.status_message())
        # 人员在家实体 / 区域有人传感器状态变化时也广播状态更新
        people_ids = {p.get("entityId", "") for p in self.store.settings.people if p.get("entityId")}
        occupancy_ids = {entity_id for entity_ids in self.store.custom.get("occupancy", {}).values()
                         for entity_id in entity_ids}
        if (people_ids | occupancy_ids) & changed.keys():
            await self.broadcast(self.status_message())
        visible_changed = {entity_id: state for entity_id, state in changed.items() if entity_id in self.visible}
        if visible_changed:
            await self.broadcast({"type": "entities", "changed": visible_changed})

    async def _on_registry(self) -> None:
        self.schedule_refresh(fetch=True)

    def schedule_refresh(self, fetch: bool) -> None:
        """合并短时间内的多次变化，只重新发现一次。"""
        self._refresh_dirty = True
        self._refresh_fetch = self._refresh_fetch or fetch
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def _refresh_loop(self) -> None:
        while self._refresh_dirty:
            self._refresh_dirty = False
            await asyncio.sleep(REFRESH_DELAY)
            fetch, self._refresh_fetch = self._refresh_fetch, False
            if fetch or self.registries is None:
                try:
                    self.registries = (
                        await self.upstream.command({"type": "config/area_registry/list"}),
                        await self.upstream.command({"type": "config/device_registry/list"}),
                        await self.upstream.command({"type": "config/entity_registry/list"}),
                        await self.upstream.command({"type": "config/label_registry/list"}),
                    )
                except Exception as error:  # 断线或权限不足：先按无区域、无标签信息发现，之后再重试
                    log.warning("读取 HA 注册表失败：%s", error)
            if self.upstream.status.get("kind") != "connected":
                continue
            self.known_ids = set(self.upstream.states)
            await self._apply_catalogue(build_catalogue(*(self.registries or ([], [], [], [])), self.upstream.states))
            # 设备（地暖 / 空调）可能变化：按需更新 HA 中的季节自动化。
            if self.store.settings.season_rules:
                self.season.schedule()

    async def _apply_catalogue(self, catalogue: dict[str, Any]) -> None:
        """更新目录并按过滤设置计算可见实体；页面目录变化时推送，新可见的实体补发状态。"""
        settings = self.store.settings
        before = self.catalogue()
        previous_visible = self.visible
        self.discovered = catalogue
        self.visible = visible_ids(catalogue, settings.filter_mode, settings.blacklist, settings.whitelist)
        after = self.catalogue()
        if after != before:
            await self.broadcast({"type": "catalogue", "catalogue": after})
        added = {entity_id: self.upstream.states[entity_id] for entity_id in self.visible - previous_visible if entity_id in self.upstream.states}
        if added:
            await self.broadcast({"type": "entities", "changed": added})

    def status_message(self) -> dict[str, Any]:
        settings = self.store.settings
        return {"type": "status", "dataSource": settings.data_source, "controlEnabled": settings.control_enabled,
                "homeTitle": settings.home_title, "brandTitle": settings.brand_title, "theme": settings.theme,
                "tileScale": settings.tile_scale, "accent": settings.accent, "season": self.season.season(),
                "musicUrl": settings.music_url,
                "allOffKinds": settings.all_off_kinds, "allOffScopes": settings.all_off_scopes,
                "allOffEntities": settings.all_off_entities,
                "people": self._people_status(),
                "occupancy": self._occupancy_status(),
                "go2rtc": {"enabled": bool(settings.go2rtc_url), "modes": PLAYER_MODES},
                "ha": self.upstream.status}

    def public_custom(self) -> dict[str, Any]:
        """发给所有屏幕的自定义配置：RTSP 地址与 ONVIF 账密只留在服务端，只下发接入类型。"""
        custom = self.store.custom
        return {**custom, "cameras": [{"id": camera["id"], "name": camera["name"], "scope": camera["scope"],
                                       "type": camera.get("type", "rtsp")}
                                      for camera in custom.get("cameras", [])]}

    def _people_status(self) -> list[dict[str, Any]]:
        """构建人员在家状态列表：从 HA 实体状态判断每人是否在家。"""
        people_cfg = self.store.settings.people
        if not people_cfg:
            return []
        result: list[dict[str, Any]] = []
        for person in people_cfg:
            entity_id = person.get("entityId", "")
            home_states = person.get("homeStates") or ["on", "home"]
            image = person.get("image")
            # image 为 null 时用默认图片（按序号轮换 default_0/default_1）
            if not image:
                idx = len(result) % 2
                image_url = f"/api/people-images/default_{idx}.jpg"
            else:
                image_url = f"/api/people-images/{image}"
            # 从 HA 状态缓存判断是否在家
            is_home = False
            if entity_id and self.upstream.states:
                state = self.upstream.states.get(entity_id)
                if state is not None:
                    state_value = state.get("state", "") if isinstance(state, dict) else str(state)
                    is_home = state_value in home_states
            result.append({"id": person.get("id", ""), "name": person.get("name", ""),
                           "image": image_url, "home": is_home})
        return result

    def _occupancy_status(self) -> dict[str, bool]:
        """构建各区域（主页 / 房间）是否有人：每区域多个传感器为“或”，任一命中即有人。

        binary_sensor 按 on 判断；sensor 按 OCCUPIED_STATES 状态值集合判断；
        实体不可用 / 未知状态不算有人。未配置传感器的区域不出现在结果里。
        """
        occupancy_cfg = self.store.custom.get("occupancy", {})
        if not occupancy_cfg:
            return {}
        result: dict[str, bool] = {}
        for scope, entity_ids in occupancy_cfg.items():
            occupied = False
            for entity_id in entity_ids:
                if not self.upstream.states:
                    break
                state = self.upstream.states.get(entity_id)
                if state is None:
                    continue
                value = (state.get("state", "") if isinstance(state, dict) else str(state)).strip().lower()
                if value in OCCUPIED_STATES:
                    occupied = True
                    break
            result[scope] = occupied
        return result

    def _scope_occupied(self, scope: str) -> bool:
        """运动抓拍的有人门控：区域配置了有人传感器时按实时状态判断；
        未配置传感器的区域返回 True（放行，保持原来的始终抓拍行为）。"""
        return self._occupancy_status().get(scope, True)

    async def camera_stream(self, request: web.Request) -> web.StreamResponse | web.Response:
        """GET /api/camera-stream?cid=…：把自定义摄像头的 RTSP 转成 MJPEG 推给 <img>。

        无需管理员登录（与看设备状态同级），但 id 必须是配置中存在的摄像头；
        ONVIF 摄像头先经 ONVIF 协议换出 RTSP 地址；
        连不上（地址 / 账号密码 / 网络问题）在首帧前返回 502，前端显示错误提示。
        """
        camera_id = request.query.get("cid", "")
        camera = self._camera_entry(camera_id)
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        if not self.camera_streamer.ffmpeg_path:
            return web.json_response({"error": "服务器没有可用的 ffmpeg，无法播放摄像头"}, status=503)
        try:
            rtsp_url = await self._camera_rtsp_url(camera)
        except OnvifError as error:
            log.warning("ONVIF 摄像头 %s 取流地址失败：%s", camera_id, error)
            return web.json_response({"error": str(error)}, status=502)
        response = web.StreamResponse(headers={"Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"})
        response.content_type = f"multipart/x-mixed-replace; boundary={CAMERA_BOUNDARY}"
        prepared = False

        async def prepare_response() -> None:
            nonlocal prepared
            await response.prepare(request)
            prepared = True

        try:
            await self.camera_streamer.stream(rtsp_url, response.write, on_first_frame=prepare_response)
        except asyncio.TimeoutError:
            if not prepared:
                return web.json_response({"error": "无法连接摄像头，请检查地址、账号密码和网络"}, status=502)
            log.info("摄像头 %s 长时间无画面，已停止取流", camera_id)
        except RuntimeError as error:
            # 浏览器切页 / 关闭标签是正常断开；首帧前失败则把错误返回给画面卡片。
            if not prepared:
                log.warning("摄像头 %s 取流失败：%s", camera_id, error)
                return web.json_response({"error": "无法连接摄像头，请检查地址、账号密码和网络"}, status=502)
            log.info("摄像头 %s 取流结束：%s", camera_id, error)
        except ConnectionError:
            log.info("摄像头 %s 连接已断开", camera_id)
        return response

    async def camera_info(self, request: web.Request) -> web.Response:
        """GET /api/camera-info?cid=…：查询摄像头接入类型与云台能力（弹窗据此决定是否显示方向键）。"""
        camera = self._camera_entry(request.query.get("cid", ""))
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        if camera.get("type") != "onvif":
            return web.json_response({"type": "rtsp", "ptz": False})
        try:
            return web.json_response(await self.onvif.info(camera))
        except OnvifError as error:
            return web.json_response({"error": str(error)}, status=502)

    # ---------- go2rtc 低延迟流媒体（WebRTC，回退 MSE/HLS/MP4/MJPEG） ----------

    @staticmethod
    def _go2rtc_stream_name(camera_id: str) -> str:
        """摄像头 id 可能含中文 / 特殊字符，统一压成 go2rtc 安全的流名（同 id 稳定同名）。"""
        return "z11_" + hashlib.sha1(camera_id.encode("utf-8")).hexdigest()[:16]

    async def go2rtc_ensure(self, request: web.Request) -> web.Response:
        """GET /api/go2rtc-ensure?cid=…：确保该摄像头已注册到 go2rtc，返回播放器所需流名。

        与看实时画面同级，无需管理员登录；RTSP 地址（含账密）不出本服务。
        """
        camera = self._camera_entry(request.query.get("cid", ""))
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        base_url = self.store.settings.go2rtc_url
        if not base_url:
            return web.json_response({"error": "未配置 go2rtc 流媒体服务"}, status=409)
        try:
            rtsp_url = await self._camera_rtsp_url(camera)
            name = self._go2rtc_stream_name(str(camera.get("id", "")))
            await ensure_stream(base_url, name, rtsp_url)
        except Exception as error:
            return web.json_response({"error": f"go2rtc 连接摄像头失败：{error}"}, status=502)
        return web.json_response({"name": name, "modes": PLAYER_MODES})

    async def go2rtc_detect(self, request: web.Request) -> web.Response:
        """POST /api/admin/go2rtc-detect {url?}：测试给定地址，或在 HAOS 内网自动发现 go2rtc。"""
        self._require_admin(request)
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        given = str(body.get("url", "")).strip() if isinstance(body, dict) else ""
        if given:
            base_url = normalize_base(given)
            if base_url is None:
                return web.json_response({"error": "地址需以 http:// 或 https:// 开头"}, status=400)
            try:
                await check(base_url)
            except Exception as error:
                return web.json_response({"error": f"无法连接 go2rtc：{error}"}, status=502)
            return web.json_response({"url": base_url})
        found = await detect(ADDON_CANDIDATES)
        if not found:
            return web.json_response({"error": "未自动发现在运行的 go2rtc，请手动填写地址",
                                      "tried": list(ADDON_CANDIDATES)}, status=404)
        return web.json_response({"url": found})

    async def go2rtc_static(self, request: web.Request) -> web.StreamResponse:
        """GET /go2rtc/…：go2rtc 播放器静态文件的同源反向代理（白名单）。"""
        base_url = self.store.settings.go2rtc_url
        if not base_url:
            raise web.HTTPNotFound()
        return await proxy_static(request, base_url)

    async def go2rtc_ws(self, request: web.Request) -> web.WebSocketResponse:
        """GET /go2rtc/api/ws：go2rtc 信令 / 媒体 WebSocket 的同源反向代理。"""
        base_url = self.store.settings.go2rtc_url
        if not base_url:
            raise web.HTTPNotFound()
        return await proxy_ws(request, base_url)

    async def camera_ptz(self, request: web.Request) -> web.Response:
        """POST /api/camera-ptz {cid, direction}：ONVIF 云台连续移动 / 停止。无需管理员登录。"""
        body = await read_json(request)
        camera = self._camera_entry(str(body.get("cid", "")))
        direction = str(body.get("direction", ""))
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        if camera.get("type") != "onvif":
            return web.json_response({"error": "RTSP 摄像头不支持云台控制"}, status=400)
        if direction not in PTZ_DIRECTIONS:
            return web.json_response({"error": "方向参数不合法"}, status=400)
        try:
            await self.onvif.ptz(camera, direction)
        except OnvifError as error:
            return web.json_response({"error": str(error)}, status=502)
        return web.json_response({"ok": True})

    async def camera_shots(self, request: web.Request) -> web.Response:
        """GET /api/camera-shots?cid=…：列出该摄像头的运动检测截图（新的在前）。"""
        camera = self._camera_entry(request.query.get("cid", ""))
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        return web.json_response({"shots": self.motion.list_shots(camera["id"])[:200]})

    async def camera_shot(self, request: web.Request) -> web.Response:
        """GET /api/camera-shot?cid=…&file=…：取单张截图；文件名白名单校验防路径穿越。"""
        camera = self._camera_entry(request.query.get("cid", ""))
        if camera is None:
            raise web.HTTPNotFound(text="camera not found")
        path = self.motion.shot_path(camera["id"], request.query.get("file", ""))
        if path is None:
            raise web.HTTPNotFound(text="shot not found")
        return web.FileResponse(path, headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})

    # ---------- HA 图片代理（扫地机地图 image 实体） ----------

    async def ha_image(self, request: web.Request) -> web.Response:
        """GET /api/ha-image?entity=image.xxx：用服务端令牌代理 HA 的 image_proxy，浏览器拿不到 HA 令牌。

        只允许取“已显示的扫地机”关联的地图实体；卡片每几秒带不同查询串轮询，故不缓存。
        """
        self._require_login(request)
        entity = request.query.get("entity", "")
        if not re.fullmatch(r"image\.[A-Za-z0-9_]{1,64}", entity):
            raise web.HTTPBadRequest(text="bad entity")
        maps = {
            item.get("mapEntityId")
            for item in self.catalogue().get("entities", [])
            if item.get("domain") == "vacuum" and item.get("mapEntityId")
        }
        if entity not in maps:
            raise web.HTTPNotFound(text="map not found")
        settings = self.store.settings
        if settings.data_source != "live" or not settings.ha_url:
            raise web.HTTPServiceUnavailable(text="HA 未连接")
        token = self.store.token()
        if not token:
            raise web.HTTPServiceUnavailable(text="HA 未配置令牌")
        url = f"{settings.ha_url}/api/image_proxy/{entity}"
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers={"Authorization": f"Bearer {token}"}) as reply:
                    if reply.status != 200:
                        raise web.HTTPBadGateway(text="HA image error")
                    content_type = reply.headers.get("Content-Type", "image/jpeg")
                    if not content_type.startswith("image/"):
                        content_type = "image/jpeg"
                    body = await reply.read()
        except aiohttp.ClientError as error:
            log.warning("代理扫地机地图 %s 失败：%s", entity, error)
            raise web.HTTPBadGateway(text="HA image unavailable") from error
        return web.Response(body=body, content_type=content_type,
                            headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})

    # ---------- 人员在家头像图片 ----------

    PEOPLE_IMAGE_DIR = "people-images"
    _PEOPLE_NAME_RE = re.compile(r"^[a-zA-Z0-9_]+\.(jpg|jpeg|png|webp|gif|avif)$")

    async def people_image(self, request: web.Request) -> web.Response:
        """GET /api/people-images/{name}：提供默认或自定义的人员头像图片。"""
        name = request.match_info.get("name", "")
        if not self._PEOPLE_NAME_RE.match(name):
            raise web.HTTPNotFound(text="invalid name")
        path = self.store.data_dir / self.PEOPLE_IMAGE_DIR / name
        if not path.is_file():
            raise web.HTTPNotFound(text="image not found")
        return web.FileResponse(path, headers={"Cache-Control": "max-age=300", "X-Content-Type-Options": "nosniff"})

    async def upload_people_image(self, request: web.Request) -> web.Response:
        """POST /api/admin/people-image：上传自定义人员头像，返回文件名。"""
        self._require_admin(request)
        reader = await request.multipart()
        part = await reader.next()
        if part is None:
            return web.json_response({"error": "请上传图片文件"}, status=400)
        ct = part.headers.get("Content-Type", "")
        if not ct.startswith("image/"):
            return web.json_response({"error": "只支持图片文件"}, status=400)
        data = await part.read(decode=True)
        if len(data) > 2 * 1024 * 1024:
            return web.json_response({"error": "图片不能超过 2 MB"}, status=400)
        # 根据 Content-Type 决定扩展名
        ext_map = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
                   "image/gif": "gif", "image/heic": "jpg", "image/heif": "jpg",
                   "image/avif": "avif"}
        ext = ext_map.get(ct, "jpg")
        # HEIC/HEIF 用 ffmpeg 转为 JPG
        if ct in ("image/heic", "image/heif"):
            tmp_in = dest = None
            try:
                import tempfile
                tmp_in = self.store.data_dir / self.PEOPLE_IMAGE_DIR / f"_tmp_{int(time.time())}.heic"
                tmp_in.parent.mkdir(parents=True, exist_ok=True)
                tmp_in.write_bytes(data)
                filename = f"person_{int(time.time())}_{secrets.token_hex(4)}.jpg"
                dest = self.store.data_dir / self.PEOPLE_IMAGE_DIR / filename
                proc = await asyncio.create_subprocess_exec(
                    self.camera_streamer.ffmpeg_path, "-y", "-i", str(tmp_in),
                    "-frames:v", "1", "-q:v", "4", "-f", "image2", str(dest),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await proc.wait()
                if proc.returncode != 0 or not dest.is_file():
                    return web.json_response({"error": "HEIC 转换失败，请改用 JPG 或 PNG"}, status=400)
                return web.json_response({"image": filename, "url": f"/api/people-images/{filename}"})
            finally:
                if tmp_in and tmp_in.exists():
                    tmp_in.unlink(missing_ok=True)
        filename = f"person_{int(time.time())}_{secrets.token_hex(4)}.{ext}"
        dest = self.store.data_dir / self.PEOPLE_IMAGE_DIR / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return web.json_response({"image": filename, "url": f"/api/people-images/{filename}"})

    async def broadcast(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False)
        for client in list(self.clients):
            if client.closed:
                self.clients.discard(client)
                continue
            try:
                await client.send_str(payload)
            except ConnectionError:
                self.clients.discard(client)

    # ---------- 浏览器 WebSocket ----------

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        # WS 鉴权：未登录拒绝升级，前端在调 /api/admin/me 时已发现未登录并跳登录页。
        session = self._current_session(request)
        if not session:
            return web.Response(status=401, text="需要登录")
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.clients.add(ws)
        username = session["username"]
        try:
            await ws.send_json({"type": "hello", "layout": self.store.layout, "catalogue": self.catalogue(), "custom": self.public_custom()})
            await ws.send_json(self.status_message())
            states = {entity_id: self.upstream.states[entity_id] for entity_id in self.visible if entity_id in self.upstream.states}
            await ws.send_json({"type": "entities", "changed": states, "snapshot": True})
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "ping":
                    # 页面用来确认连接仍然可用（手机锁屏后旧连接可能已失效却未关闭）。
                    await ws.send_json({"type": "pong"})
                elif payload.get("type") == "call_service":
                    task = asyncio.create_task(self._call_service(ws, payload, client_ip(request), username))
                    self._tasks.add(task)
                    task.add_done_callback(self._tasks.discard)
        finally:
            self.clients.discard(ws)
        return ws

    async def _call_service(self, ws: web.WebSocketResponse, payload: dict[str, Any], ip: str, username: str) -> None:
        request_id = payload.get("id")
        entity_id = str(payload.get("entity", ""))
        service = str(payload.get("service", ""))
        data = payload.get("data") or {}
        error = self._reject_reason(entity_id, service, data)
        if error is None:
            try:
                await self.upstream.call_service(entity_id.split(".")[0], service, entity_id, data)
            except Exception as exc:  # HA 返回失败、超时或断线
                error = str(exc) or exc.__class__.__name__
        # service_call 即“操控设备记录”：记录哪个账户操作了什么设备。
        self.store.audit("service_call", ip, username=username, entity=entity_id, service=service, data=data, ok=error is None, error=error)
        if not ws.closed:
            await ws.send_json({"type": "result", "id": request_id, "success": error is None, "error": error})

    def _reject_reason(self, entity_id: str, service: str, data: Any) -> str | None:
        settings = self.store.settings
        if settings.data_source != "live":
            return "当前为演示数据，未连接 HA"
        if not settings.control_enabled:
            return "已关闭设备控制（只读模式）"
        domain = entity_id.split(".")[0]
        if domain in SCENE_DOMAINS:
            # 情景按钮：必须在设置中配置过、当前仍被 HA 发现，且无额外参数。
            configured = {scene["entity"] for scene in self.store.custom["scenes"]}
            if entity_id not in configured:
                return "该情景没有在设置中配置"
            if entity_id not in self.known_ids:
                return "情景目标实体不存在或不可用"
            if data:
                return "情景调用不允许带参数"
        elif entity_id not in self.visible:
            return "该设备未在控制台显示（未发现或已被过滤）"
        allowed = ALLOWED_SERVICES.get(domain, {}).get(service)
        if allowed is None:
            return f"不允许的服务：{service}"
        if not isinstance(data, dict) or any(key not in allowed or not allowed[key](value) for key, value in data.items()):
            return "服务参数不合法"
        if self.upstream.status.get("kind") != "connected":
            return "HA 未连接"
        return None

    # ---------- 管理接口 ----------

    def _current_session(self, request: web.Request) -> dict[str, Any] | None:
        """读取当前会话；None 表示未登录或会话已过期。"""
        return self.sessions.get(request.cookies.get(COOKIE))

    def _require_login(self, request: web.Request) -> dict[str, Any]:
        """要求任意已登录账户；返回 {username, isAdmin, remember}。"""
        session = self._current_session(request)
        if not session:
            raise web.HTTPUnauthorized(text=json.dumps({"error": "需要登录"}), content_type="application/json")
        return session

    def _require_admin(self, request: web.Request) -> dict[str, Any]:
        """要求管理员账户；返回 {username, isAdmin, remember}。"""
        session = self._require_login(request)
        if not session.get("isAdmin"):
            raise web.HTTPForbidden(text=json.dumps({"error": "需要管理员权限"}), content_type="application/json")
        return session

    async def me(self, request: web.Request) -> web.Response:
        """查询当前登录账户与首跑状态；前端据此决定显示登录页 / 引导页 / 主界面。"""
        session = self._current_session(request)
        if not session:
            return web.json_response({
                "authenticated": False,
                "firstRun": not self.store.setup_completed,
                "setupCompleted": self.store.setup_completed,
            })
        return web.json_response({
            "authenticated": True,
            "user": {"username": session["username"], "isAdmin": session["isAdmin"]},
            "firstRun": not self.store.setup_completed,
            "setupCompleted": self.store.setup_completed,
        })

    async def login(self, request: web.Request) -> web.Response:
        """账号 + 密码登录；默认 remember=True，下发 30 天 Cookie 并写入 sessions.json。"""
        ip = client_ip(request)
        retry_after = self.limiter.retry_after()
        if retry_after:
            return web.json_response({"error": "尝试次数过多", "retryAfter": retry_after}, status=429)
        body = await read_json(request)
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        remember = body.get("remember", True)
        if not isinstance(remember, bool):
            remember = True
        if not username or not password:
            return web.json_response({"error": "请输入账号和密码"}, status=400)
        account = self.store.verify_account(username, password)
        if not account:
            locked = self.limiter.record_failure()
            self.store.audit("login_failed", ip, username=username, locked_seconds=locked)
            if locked:
                return web.json_response({"error": "尝试次数过多", "retryAfter": locked}, status=429)
            return web.json_response({"error": "账号或密码不正确", "remaining": self.limiter.remaining_attempts()}, status=401)
        self.limiter.record_success()
        self.store.audit("login", ip, username=account.username)
        session_id = self.sessions.create(account.username, account.is_admin, remember=remember)
        response = web.json_response({
            "ok": True,
            "user": account.public(),
            "firstRun": not self.store.setup_completed,
            "setupCompleted": self.store.setup_completed,
        })
        # Cookie path 设为 "/"：WS 握手、摄像头流、天气等 /api/* 接口都需要带上。
        max_age = SESSION_MAX_AGE if remember else None
        response.set_cookie(COOKIE, session_id, **_cookie_attrs(request), max_age=max_age)
        return response

    async def logout(self, request: web.Request) -> web.Response:
        session = self._current_session(request)
        if session:
            self.store.audit("logout", client_ip(request), username=session["username"])
        self.sessions.revoke(request.cookies.get(COOKIE))
        response = web.json_response({"ok": True})
        # 删除 Cookie 时需带上与设置时一致的 samesite/secure，否则跨站场景下浏览器不会清除。
        attrs = _cookie_attrs(request)
        response.del_cookie(COOKIE, path=attrs["path"], secure=attrs["secure"], httponly=attrs["httponly"], samesite=attrs["samesite"])
        return response

    async def setup_admin(self, request: web.Request) -> web.Response:
        """首次进入引导：管理员改账户名 + 密码，完成后 setup_completed=True。"""
        session = self._require_admin(request)
        body = await read_json(request)
        new_username = str(body.get("username", "")).strip()
        new_password = str(body.get("password", ""))
        if not self.store.complete_setup(new_username, new_password):
            return web.json_response({"error": "账户名需 2–32 位（字母数字 _ . @ -）或密码至少 4 位，且不能与他人重名"}, status=400)
        # 旧 Cookie 失效（用户名变了）：重新签发并吊销该用户名下所有旧会话。
        self.sessions.revoke_user(session["username"])
        new_session = self.sessions.create(new_username, True, remember=True)
        self.store.audit("setup_completed", client_ip(request), username=new_username)
        response = web.json_response({"ok": True, "user": {"username": new_username, "isAdmin": True}, "setupCompleted": True})
        response.set_cookie(COOKIE, new_session, **_cookie_attrs(request), max_age=SESSION_MAX_AGE)
        return response

    async def change_password(self, request: web.Request) -> web.Response:
        """修改自己密码（管理员 / 子账户均可）。需提供旧密码二次确认。"""
        session = self._require_login(request)
        body = await read_json(request)
        old_password = str(body.get("oldPassword", ""))
        new_password = str(body.get("newPassword", ""))
        account_obj = next((a for a in self.store.accounts if a.username == session["username"]), None)
        if not account_obj or not verify_pin(old_password, account_obj.password_hash):
            return web.json_response({"error": "旧密码不正确"}, status=401)
        if not self.store.change_password(account_obj.id, new_password):
            return web.json_response({"error": f"新密码需 {PASSWORD_MIN}–{PASSWORD_MAX} 位"}, status=400)
        # 改密码后吊销该账户其他会话，但保留当前会话免得反复登录。
        self.sessions.revoke_user(session["username"])
        new_session = self.sessions.create(session["username"], session["isAdmin"], remember=True)
        self.store.audit("password_changed", client_ip(request), username=session["username"])
        response = web.json_response({"ok": True})
        response.set_cookie(COOKIE, new_session, **_cookie_attrs(request), max_age=SESSION_MAX_AGE)
        return response

    async def get_accounts(self, request: web.Request) -> web.Response:
        """管理员查看全部账户（不含密码哈希）。"""
        self._require_admin(request)
        return web.json_response({"accounts": self.store.public_accounts(), "setupCompleted": self.store.setup_completed})

    async def create_account(self, request: web.Request) -> web.Response:
        """管理员新增子账户（无管理权限）。"""
        session = self._require_admin(request)
        body = await read_json(request)
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        is_admin = bool(body.get("isAdmin", False))
        if is_admin:
            return web.json_response({"error": "仅允许创建子账户"}, status=400)
        account = self.store.add_account(username, password, is_admin=False)
        if not account:
            return web.json_response({"error": "账号需 2–32 位（字母数字 _ . @ -）且不重名，密码至少 4 位"}, status=400)
        self.store.audit("account_created", client_ip(request), username=session["username"], target=account.username)
        return web.json_response({"ok": True, "account": account.public()})

    async def delete_account(self, request: web.Request) -> web.Response:
        """管理员删除子账户；管理员账户不可删除。"""
        session = self._require_admin(request)
        account_id = request.match_info.get("id", "")
        target = self.store.find_account_by_id(account_id)
        if not target:
            return web.json_response({"error": "账户不存在"}, status=404)
        if target.is_admin:
            return web.json_response({"error": "管理员账户不可删除"}, status=400)
        if not self.store.delete_account(account_id):
            return web.json_response({"error": "删除失败"}, status=400)
        # 吊销被删账户的所有会话
        self.sessions.revoke_user(target.username)
        self.store.audit("account_deleted", client_ip(request), username=session["username"], target=target.username)
        return web.json_response({"ok": True})

    def _settings_payload(self) -> dict[str, Any]:
        return {**self.store.settings.public(), "season": self.season.season(), "seasonSync": self.season.sync_status}

    async def get_settings(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        return web.json_response(self._settings_payload())

    async def put_settings(self, request: web.Request) -> web.Response:
        session = self._require_admin(request)
        body = await read_json(request)
        settings = self.store.settings
        changed: list[str] = []
        reconnect = False

        if "haUrl" in body:
            url = normalize_ha_url(str(body["haUrl"]))
            if url is None:
                return web.json_response({"error": "地址需以 http:// 或 https:// 开头"}, status=400)
            if url != settings.ha_url:
                settings.ha_url, reconnect = url, True
                changed.append("haUrl")
        if body.get("clearToken"):
            self.store.set_token("")
            settings.data_source = "demo"
            reconnect = True
            changed += ["haToken(清除)", "dataSource"]
        elif isinstance(body.get("haToken"), str) and body["haToken"].strip():
            self.store.set_token(body["haToken"].strip())
            reconnect = True
            changed.append("haToken(更新)")
        if isinstance(body.get("controlEnabled"), bool) and body["controlEnabled"] != settings.control_enabled:
            settings.control_enabled = body["controlEnabled"]
            changed.append("controlEnabled")
        if body.get("dataSource") in ("demo", "live") and body["dataSource"] != settings.data_source:
            if body["dataSource"] == "live" and not (settings.ha_url and settings.token_encrypted):
                return web.json_response({"error": "请先保存 HA 地址和令牌"}, status=400)
            settings.data_source, reconnect = body["dataSource"], True
            changed.append("dataSource")

        if "theme" in body:
            if body["theme"] not in THEMES:
                return web.json_response({"error": "主题只能是浅色、深色或自动"}, status=400)
            if body["theme"] != settings.theme:
                settings.theme = body["theme"]
                changed.append("theme")
        if "accent" in body:
            if body["accent"] not in ACCENTS:
                return web.json_response({"error": "不支持的强调色"}, status=400)
            if body["accent"] != settings.accent:
                settings.accent = body["accent"]
                changed.append("accent")
        season_sync = False
        if "seasonRules" in body:
            if not isinstance(body["seasonRules"], bool):
                return web.json_response({"error": "参数错误"}, status=400)
            if body["seasonRules"] != settings.season_rules:
                settings.season_rules = body["seasonRules"]
                changed.append("seasonRules")
                season_sync = True
        if "season" in body:
            if body["season"] not in SEASONS:
                return web.json_response({"error": "季节只能是夏季或冬季"}, status=400)
            if not settings.season_rules:
                return web.json_response({"error": "请先启用季节规则"}, status=400)
            if body["season"] != self.season.season():
                try:
                    await self.season.set_season(body["season"])
                except Exception as exc:
                    return web.json_response({"error": f"切换季节失败：{exc}"}, status=409)
                changed.append("season")
        if "tileScale" in body:
            if not is_tile_scale(body["tileScale"]):
                return web.json_response({"error": f"格子大小需在 {TILE_SCALE_MIN}% 到 {TILE_SCALE_MAX}% 之间"}, status=400)
            if body["tileScale"] != settings.tile_scale:
                settings.tile_scale = body["tileScale"]
                changed.append("tileScale")
        if "homeTitle" in body:
            title = " ".join(str(body["homeTitle"]).split()) or DEFAULT_HOME_TITLE
            if len(title) > HOME_TITLE_MAX:
                return web.json_response({"error": f"标题最多 {HOME_TITLE_MAX} 个字"}, status=400)
            if title != settings.home_title:
                settings.home_title = title
                changed.append("homeTitle")
        if "brandTitle" in body:
            brand = " ".join(str(body["brandTitle"]).split()) or DEFAULT_BRAND_TITLE
            if len(brand) > BRAND_TITLE_MAX:
                return web.json_response({"error": f"家庭名称最多 {BRAND_TITLE_MAX} 个字"}, status=400)
            if brand != settings.brand_title:
                settings.brand_title = brand
                changed.append("brandTitle")
        if "musicUrl" in body:
            music_url = normalize_embed_url(str(body["musicUrl"]))
            if music_url is None:
                return web.json_response({"error": "音乐地址需是完整的 http:// 或 https:// 网址"}, status=400)
            if len(music_url) > 500:
                return web.json_response({"error": "音乐地址过长"}, status=400)
            if music_url != settings.music_url:
                settings.music_url = music_url
                changed.append("musicUrl")
        if "go2rtcUrl" in body:
            go2rtc_url = normalize_base(str(body["go2rtcUrl"]))
            if go2rtc_url is None:
                return web.json_response({"error": "go2rtc 地址需是完整的 http:// 或 https:// 网址"}, status=400)
            if len(go2rtc_url) > 300:
                return web.json_response({"error": "go2rtc 地址过长"}, status=400)
            # 非空地址保存前必须连得上，避免前端 iframe 静默黑屏；清空则随时允许。
            if go2rtc_url:
                try:
                    await check(go2rtc_url)
                except Exception as error:
                    return web.json_response({"error": f"无法连接 go2rtc：{error}"}, status=409)
            if go2rtc_url != settings.go2rtc_url:
                settings.go2rtc_url = go2rtc_url
                changed.append("go2rtcUrl")
        if "allOffKinds" in body:
            valid = {"light", "climate", "fan", "cover", "switch"}
            kinds = [k for k in id_list(body["allOffKinds"]) if k in valid] if body["allOffKinds"] is not None else ["light"]
            if not kinds:
                kinds = ["light"]
            if kinds != settings.all_off_kinds:
                settings.all_off_kinds = kinds
                changed.append("allOffKinds")
        if "allOffScopes" in body:
            scopes = id_list(body["allOffScopes"]) or []
            if scopes != settings.all_off_scopes:
                settings.all_off_scopes = scopes
                changed.append("allOffScopes")
        if "allOffEntities" in body:
            entities = id_list(body["allOffEntities"]) or []
            if entities != settings.all_off_entities:
                settings.all_off_entities = entities
                changed.append("allOffEntities")
        if "people" in body:
            people = body["people"]
            if not isinstance(people, list):
                return web.json_response({"error": "人员配置需是列表"}, status=400)
            if len(people) > 12:
                return web.json_response({"error": "人员最多 12 名"}, status=400)
            cleaned: list[dict[str, Any]] = []
            for person in people:
                if not isinstance(person, dict):
                    continue
                pid = str(person.get("id", ""))[:64]
                name = str(person.get("name", ""))[:30]
                entity_id = str(person.get("entityId", ""))[:100]
                image = person.get("image")
                if image is not None:
                    image = str(image)[:100]
                home_states = person.get("homeStates")
                if not isinstance(home_states, list) or not home_states:
                    home_states = ["on", "home"]
                home_states = [str(s)[:20] for s in home_states][:10]
                if name and entity_id:
                    cleaned.append({"id": pid, "name": name, "entityId": entity_id,
                                    "image": image, "homeStates": home_states})
            if cleaned != settings.people:
                settings.people = cleaned
                changed.append("people")

        if changed:
            self.store.save()
            self.store.audit("settings_changed", client_ip(request), username=session["username"], fields=changed,
                             controlEnabled=settings.control_enabled, dataSource=settings.data_source, haUrl=settings.ha_url)
        if reconnect:
            await self.reconnect()
        if season_sync or reconnect:
            self.season.schedule()
        await self.broadcast(self.status_message())
        return web.json_response(self._settings_payload())

    def _entities_payload(self) -> dict[str, Any]:
        """设置页用：过滤设置，以及全部已发现的实体（含当前状态，便于辨认）。"""
        states = self.upstream.states
        return {
            "filter": self.store.settings.filter(),
            "labels": self.discovered.get("labels", []),
            "rooms": self.discovered["rooms"],
            "entities": [{**entity, "state": (states.get(entity["id"]) or {}).get("state")} for entity in self.discovered["entities"]],
        }

    async def get_entities(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        return web.json_response(self._entities_payload())

    async def put_filter(self, request: web.Request) -> web.Response:
        session = self._require_admin(request)
        body = await read_json(request)
        settings = self.store.settings
        if "mode" in body:
            if body["mode"] not in ("blacklist", "whitelist"):
                return web.json_response({"error": "过滤方式只能是黑名单或白名单"}, status=400)
            settings.filter_mode = body["mode"]
        for key in ("blacklist", "whitelist"):
            if key in body:
                ids = id_list(body[key])
                if ids is None:
                    return web.json_response({"error": "名单格式错误"}, status=400)
                setattr(settings, key, ids)
        self.store.save()
        self.store.audit("filter_changed", client_ip(request), username=session["username"],
                         mode=settings.filter_mode,
                         blacklist=len(settings.blacklist), whitelist=len(settings.whitelist))
        await self._apply_catalogue(self.discovered)
        return web.json_response(self._entities_payload())

    def _automations(self) -> tuple[str, list[dict[str, Any]]]:
        if self.store.settings.data_source != "live":
            return "demo", sorted(self.demo_automations.values(), key=lambda item: item["name"])
        registry = self.registries[2] if self.registries else []
        return "live", build_automations(self.upstream.states, registry)

    async def get_automations(self, request: web.Request) -> web.Response:
        self._require_admin(request)
        source, items = self._automations()
        connected = source == "demo" or self.upstream.status.get("kind") == "connected"
        return web.json_response({"source": source, "connected": connected, "automations": items})

    async def put_automation(self, request: web.Request) -> web.Response:
        """开关一个自动化：只接受当前列表中的实体，只读模式下拒绝，结果写入操作记录。"""
        session = self._require_admin(request)
        if not self.store.settings.control_enabled:
            return web.json_response({"error": "已关闭设备控制（只读模式），不能切换自动化"}, status=403)
        body = await read_json(request)
        entity_id, enabled = body.get("id"), body.get("enabled")
        if not isinstance(entity_id, str) or not isinstance(enabled, bool):
            return web.json_response({"error": "参数错误"}, status=400)
        source, items = self._automations()
        if entity_id not in {item["id"] for item in items}:
            return web.json_response({"error": "找不到这个自动化"}, status=404)
        error: str | None = None
        if source == "demo":
            self.demo_automations[entity_id]["state"] = "on" if enabled else "off"
        else:
            try:
                await self.upstream.call_service(AUTOMATION_DOMAIN, "turn_on" if enabled else "turn_off", entity_id, {})
            except Exception as exc:  # HA 返回失败、超时或断线
                error = str(exc) or exc.__class__.__name__
        self.store.audit("automation_toggled", client_ip(request), username=session["username"],
                         entity=entity_id, enabled=enabled, ok=error is None, error=error)
        if error:
            return web.json_response({"error": f"切换失败：{error}"}, status=502)
        return web.json_response({"ok": True, "id": entity_id, "state": "on" if enabled else "off"})

    async def get_custom(self, request: web.Request) -> web.Response:
        """手动房间、设备归属与情景按钮配置。"""
        self._require_admin(request)
        return web.json_response(self.store.custom)

    async def put_custom(self, request: web.Request) -> web.Response:
        """整份保存自定义配置；以当前发现结果清洗，未知房间 / 实体丢弃，随后推送给所有屏幕。"""
        session = self._require_admin(request)
        body = await read_json(request)
        known_entities = {entity["id"] for entity in self.discovered["entities"]}
        # 温湿度来源只允许选择目录中实体实际提供的指标参数（metric:key）。
        known_metrics = {
            entity["id"]: {f"{option['metric']}:{option['key']}" for option in entity.get("metrics", [])}
            for entity in self.discovered["entities"] if entity.get("metrics")
        }
        old_occupancy = self.store.custom.get("occupancy", {})
        custom = clean_custom(body, known_entities=known_entities, known_metrics=known_metrics)
        self.store.save_custom(custom)
        # 摄像头配置可能增删改：ONVIF 探测缓存作废，并按新列表启停运动监测。
        self.onvif.invalidate()
        self.motion.sync(custom.get("cameras", []))
        self.store.audit("custom_changed", client_ip(request), username=session["username"],
                         rooms=len(custom["rooms"]), assignments=len(custom["assignments"]), scenes=len(custom["scenes"]))
        await self.broadcast({"type": "custom", "custom": self.public_custom()})
        # 有人传感器配置变化后立即重算并推送区域占用状态。
        if custom.get("occupancy", {}) != old_occupancy:
            await self.broadcast(self.status_message())
        return web.json_response(custom)

    async def put_layout(self, request: web.Request) -> web.Response:
        """全家共用布局；只读模式下不允许修改。修改后推送给所有已打开的页面。"""
        session = self._require_login(request)
        if not self.store.settings.control_enabled:
            return web.json_response({"error": "已关闭设备控制（只读模式），不能修改布局"}, status=403)
        body = await read_json(request)
        self.store.save_layout(body)
        self.store.audit("layout_changed", client_ip(request), username=session["username"],
                         favorites=len(self.store.layout["favorites"] or []))
        await self.broadcast({"type": "layout", "layout": self.store.layout})
        return web.json_response(self.store.layout)

    async def get_audit(self, request: web.Request) -> web.Response:
        """读取操作记录。?event=service_call 只返回“操控设备记录”，可按事件类型过滤。"""
        self._require_admin(request)
        event = request.query.get("event") or None
        return web.json_response(self.store.recent_audit(int(request.query.get("limit", "50")), event=event))


    # ---------- 天气（中国天气网，只读，无需登录） ----------

    async def weather_search(self, request: web.Request) -> web.Response:
        query = request.query.get("q", "").strip()
        if not 0 < len(query) <= 40:
            return web.json_response({"error": "请输入 1–40 个字的地名"}, status=400)
        try:
            return web.json_response({"places": await self.weather.search(query)})
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)

    async def weather_place(self, request: web.Request) -> web.Response:
        """浏览器定位的坐标，或 HA 中“家”（zone.home）的坐标 → 对应城市。"""
        if request.query.get("home"):
            attributes = (self.upstream.states.get("zone.home") or {}).get("attributes") or {}
            lat, lon = attributes.get("latitude"), attributes.get("longitude")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                return web.json_response({"error": "HA 未连接或未设置家的位置"}, status=404)
        else:
            try:
                lon, lat = float(request.query["lon"]), float(request.query["lat"])
            except (KeyError, ValueError):
                return web.json_response({"error": "坐标格式错误"}, status=400)
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                return web.json_response({"error": "坐标超出范围"}, status=400)
        try:
            return web.json_response({"place": await self.weather.place_at(lon, lat)})
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)

    async def weather_forecast(self, request: web.Request) -> web.Response:
        location = request.query.get("location", "").strip()
        if not valid_location(location):
            return web.json_response({"error": "位置格式错误"}, status=400)
        try:
            return web.json_response(await self.weather.forecast(location))
        except WeatherError as error:
            return web.json_response({"error": str(error)}, status=error.status)


def client_ip(request: web.Request) -> str:
    """只信任本机反向代理（如 Vite 开发代理）带来的 X-Forwarded-For。"""
    remote = request.remote or ""
    forwarded = request.headers.get("X-Forwarded-For")
    try:
        if forwarded and ipaddress.ip_address(remote).is_loopback:
            return forwarded.split(",")[0].strip()
    except ValueError:
        pass
    return remote


async def read_json(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text=json.dumps({"error": "请求格式错误"}), content_type="application/json")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": "请求格式错误"}), content_type="application/json")
    return body


def create_app(data_dir: Path, static_dir: Path | None) -> web.Application:
    console = ConsoleServer(data_dir)
    app = web.Application()
    app["console"] = console
    app.add_routes([
        web.get("/api/health", lambda _request: web.json_response({"ok": True})),
        web.get("/api/ws", console.handle_ws),
        web.get("/api/camera-stream", console.camera_stream),
        web.get("/api/camera-info", console.camera_info),
        web.post("/api/camera-ptz", console.camera_ptz),
        web.get("/api/camera-shots", console.camera_shots),
        web.get("/api/camera-shot", console.camera_shot),
        # go2rtc 低延迟流媒体：流注册 / 地址探测 / 播放器静态文件 + WS 反向代理。
        web.get("/api/go2rtc-ensure", console.go2rtc_ensure),
        web.post("/api/admin/go2rtc-detect", console.go2rtc_detect),
        web.get("/go2rtc/api/ws", console.go2rtc_ws),
        web.get("/go2rtc/{tail:.*}", console.go2rtc_static),
        web.get("/api/ha-image", console.ha_image),
        web.get("/api/people-images/{name}", console.people_image),
        web.post("/api/admin/people-image", console.upload_people_image),
        web.put("/api/layout", console.put_layout),
        # 账户系统：登录 / 登出 / 当前用户 / 首跑引导 / 改密码 / 子账户管理。
        web.get("/api/admin/me", console.me),
        web.post("/api/admin/login", console.login),
        web.post("/api/admin/logout", console.logout),
        web.post("/api/admin/setup", console.setup_admin),
        web.put("/api/admin/password", console.change_password),
        web.get("/api/admin/accounts", console.get_accounts),
        web.post("/api/admin/accounts", console.create_account),
        web.delete("/api/admin/accounts/{id}", console.delete_account),
        web.get("/api/admin/settings", console.get_settings),
        web.put("/api/admin/settings", console.put_settings),
        web.get("/api/admin/entities", console.get_entities),
        web.put("/api/admin/filter", console.put_filter),
        web.get("/api/admin/automations", console.get_automations),
        web.put("/api/admin/automations", console.put_automation),
        web.get("/api/admin/custom", console.get_custom),
        web.put("/api/admin/custom", console.put_custom),
        web.get("/api/admin/audit", console.get_audit),
        web.get("/api/weather", console.weather_forecast),
        web.get("/api/weather/search", console.weather_search),
        web.get("/api/weather/place", console.weather_place),
    ])

    if static_dir and (static_dir / "index.html").exists():
        async def spa(request: web.Request) -> web.FileResponse:
            path = (static_dir / request.match_info["tail"]).resolve()
            if path.is_file() and static_dir.resolve() in path.parents:
                # 带内容哈希的静态资源可长期缓存；入口文件不缓存，保证发版后浏览器立即拿到新版本。
                immutable = "assets/" in path.as_posix()
                return web.FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"})
            return web.FileResponse(static_dir / "index.html", headers={"Cache-Control": "no-cache"})
        app.router.add_get("/{tail:(?!api/|go2rtc/).*}", spa)

    async def on_startup(_app: web.Application) -> None:
        await console.reconnect()
        await console.onvif.start()
        await console.motion.start(console.store.custom.get("cameras", []))

    async def on_shutdown(_app: web.Application) -> None:
        # 先关闭页面的 WebSocket：否则 aiohttp 会等这些长连接自行结束（默认最长 60 秒），停止或重启服务时就会卡住。
        for client in list(console.clients):
            await client.close(code=1001, message=b"server shutdown")

    async def on_cleanup(_app: web.Application) -> None:
        await console.upstream.stop()
        await console.weather.close()
        await console.motion.stop_all()
        await console.onvif.close()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="家庭控制台后端")
    parser.add_argument("--host", default=os.environ.get("HOME_CONSOLE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("HOME_CONSOLE_PORT", "8765")))
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("HOME_CONSOLE_DATA", SERVER_DIR / "data")))
    parser.add_argument("--static", type=Path, default=Path(os.environ.get("HOME_CONSOLE_STATIC", SERVER_DIR.parent / "dist")),
                        help="构建后的前端目录；存在 index.html 时由本服务一并提供页面")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    web.run_app(create_app(args.data, args.static), host=args.host, port=args.port, access_log=None)
