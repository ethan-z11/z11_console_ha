"""ONVIF 摄像头的最小异步客户端（只实现控制台需要的几个方法）。

不依赖 onvif-zeep / zeep 等重型库：ONVIF 本身就是带 WSSE 鉴权头的 SOAP/XML，
用 aiohttp + xml.etree 手写请求即可，覆盖：
- GetCapabilities：拿 Media / PTZ 服务地址，判断摄像头是否支持云台；
- GetProfiles + GetStreamUri：取第一个码流的 RTSP 地址，再交给 cameras.py 的 ffmpeg 转码；
- ContinuousMove / Stop：云台上 / 下 / 左 / 右连续转动与停止。

账号密码只保存在服务端，探测结果（RTSP 地址等）也只留在服务端内存缓存中。
"""

from __future__ import annotations

import asyncio
import base64
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

import aiohttp

log = logging.getLogger("home_console_server")

NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "tt": "http://www.onvif.org/ver10/schema",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tptz": "http://www.onvif.org/ver20/ptz/wsdl",
}

CALL_TIMEOUT = 8.0
# 云台连续移动速度（-1～1）；家用摄像头太大会一窜过头，0.35 比较跟手。
PTZ_SPEED = 0.35

_ENVELOPE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
 xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
 xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
 xmlns:wsa="http://www.w3.org/2005/08/addressing"
 xmlns:tt="http://www.onvif.org/ver10/schema"
 xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
 xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
 xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
  <s:Header>
    <wsse:Security s:mustUnderstand="1">
      <wsse:UsernameToken>
        <wsse:Username>{username}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce}</wsse:Nonce>
        <wsu:Created>{created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>
    <wsa:Action>{action}</wsa:Action>
    <wsa:To>{to}</wsa:To>
    <wsa:MessageID>urn:uuid:{message_id}</wsa:MessageID>
  </s:Header>
  <s:Body>
{body}
  </s:Body>
</s:Envelope>"""


class OnvifError(RuntimeError):
    """ONVIF 探测或控制失败（连不上 / 鉴权失败 / 设备不支持等）。"""


def _xml_escape(value: str) -> str:
    return (value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _local_name(tag: str) -> str:
    """去掉 XML 命名空间前缀（{...}local 或 ns:local 都只取 local）。"""
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _inject_credentials(uri: str, username: str, password: str) -> str:
    """ONVIF GetStreamUri 返回的 RTSP 地址通常不含账号密码，按配置补进 netloc。"""
    parts = urlsplit(uri)
    if parts.username or not username:
        return uri
    auth = quote(username, safe="")
    if password:
        auth = f"{auth}:{quote(password, safe='')}"
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    netloc = f"{auth}@{host}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


class OnvifClient:
    def __init__(self, host: str, port: int, username: str, password: str, session: aiohttp.ClientSession) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.device_url = f"http://{host}:{port}/onvif/device_service"
        self._session = session

    def _envelope(self, body: str, action: str = "", to: str = "") -> str:
        nonce = secrets.token_bytes(16)
        created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digest = base64.b64encode(
            hashlib_sha1(nonce + created.encode("utf-8") + self.password.encode("utf-8"))
        ).decode("ascii")
        return _ENVELOPE_TEMPLATE.format(
            username=_xml_escape(self.username),
            digest=digest,
            nonce=base64.b64encode(nonce).decode("ascii"),
            created=created,
            action=action,
            to=to,
            message_id=str(uuid.uuid4()),
            body=body,
        )

    async def _call(self, url: str, soap_action: str, body: str, timeout: float | None = None) -> ET.Element:
        payload = self._envelope(body, soap_action, url)
        headers = {
            "Content-Type": "application/soap+xml; charset=utf-8",
            "SOAPAction": f'"{soap_action}"',
        }
        # PullMessages 是长轮询（默认挂 30 秒），必须用比它更长的单次超时覆盖会话默认的 8 秒，
        # 否则长轮询每次都被本地掐断，反复重建订阅会把海康等固件搅成 HTTP 400/500。
        call_timeout = aiohttp.ClientTimeout(total=timeout) if timeout else None
        try:
            async with self._session.post(url, data=payload.encode("utf-8"), headers=headers,
                                          timeout=call_timeout) as response:
                text = await response.text()
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise OnvifError(f"无法连接摄像头（{self.host}:{self.port}）：{error.__class__.__name__}") from error
        if response.status != 200:
            raise OnvifError(f"摄像头返回 HTTP {response.status}，请检查地址、端口、账号密码")
        try:
            root = ET.fromstring(text)
        except ET.ParseError as error:
            raise OnvifError("摄像头返回的内容不是有效的 ONVIF 响应") from error
        fault = root.find(".//s:Fault", NS)
        if fault is not None:
            reason = fault.find(".//s:Reason/s:Text", NS)
            if reason is None:
                reason = fault.find(".//faultstring")
            detail = (reason.text if reason is not None and reason.text else "设备拒绝了请求")
            raise OnvifError(f"ONVIF 错误：{detail}")
        return root

    async def get_service_urls(self) -> tuple[str, str | None, str | None]:
        """返回 (媒体服务地址, 云台服务地址或 None, 事件服务地址或 None)。"""
        body = '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>'
        root = await self._call(self.device_url, "http://www.onvif.org/ver10/device/wsdl/GetCapabilities", body)

        def find_xaddr(service: str) -> str | None:
            # 按 local-name 找 Capabilities/<Service>/XAddr，兼容不同厂商的命名空间前缀
            # 以及把能力塞进 Extension 的老固件（iter 会覆盖扩展节点里的后代）。
            caps = next((el for el in root.iter() if _local_name(el.tag) == "Capabilities"), None)
            if caps is None:
                return None
            service_node = next((ch for ch in caps.iter() if _local_name(ch.tag) == service), None)
            if service_node is None:
                return None
            xaddr = next((g for g in service_node.iter() if _local_name(g.tag) == "XAddr" and g.text), None)
            return xaddr.text.strip() if xaddr is not None else None

        media_url = find_xaddr("Media")
        if not media_url:
            raise OnvifError("摄像头没有提供 ONVIF 媒体服务（Media）")
        ptz_url = find_xaddr("PTZ")
        events_url = find_xaddr("Events")
        return media_url, ptz_url, events_url

    async def get_profiles(self, media_url: str) -> list[tuple[str, str]]:
        body = '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>'
        root = await self._call(media_url, "http://www.onvif.org/ver10/media/wsdl/GetProfiles", body)
        profiles: list[tuple[str, str]] = []
        for node in root.iter():
            if _local_name(node.tag) != "Profiles":
                continue
            token = node.get("token")
            if token:
                name_node = next((ch for ch in node.iter() if _local_name(ch.tag) == "Name" and ch.text), None)
                profiles.append((token, name_node.text if name_node is not None else ""))
        if not profiles:
            raise OnvifError("摄像头没有可用的码流配置（Profile）")
        return profiles

    async def get_stream_uri(self, media_url: str, profile_token: str) -> str:
        body = (
            '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
            "<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>"
            "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>"
            f"<trt:ProfileToken>{_xml_escape(profile_token)}</trt:ProfileToken></trt:GetStreamUri>"
        )
        root = await self._call(media_url, "http://www.onvif.org/ver10/media/wsdl/GetStreamUri", body)
        # MediaUri 在媒体服务命名空间（trt）下，里面的 Uri 才是 tt:；
        # 个别小厂固件命名空间乱挂，这里按 local-name 兜底找一遍。
        media_uri_el = next((el for el in root.iter() if _local_name(el.tag) == "MediaUri"), None)
        uri_node = None
        if media_uri_el is not None:
            uri_node = next((ch for ch in media_uri_el if _local_name(ch.tag) == "Uri" and ch.text), None)
        if uri_node is None or not uri_node.text:
            raise OnvifError("摄像头没有返回 RTSP 取流地址")
        return _inject_credentials(uri_node.text.strip(), self.username, self.password)

    async def continuous_move(self, ptz_url: str, profile_token: str, x: float, y: float) -> None:
        body = (
            '<tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
            f"<tptz:ProfileToken>{_xml_escape(profile_token)}</tptz:ProfileToken>"
            f'<tptz:Velocity><tt:PanTilt x="{x}" y="{y}"/><tt:Zoom x="0"/></tptz:Velocity>'
            "</tptz:ContinuousMove>"
        )
        await self._call(ptz_url, "http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove", body)

    async def stop(self, ptz_url: str, profile_token: str) -> None:
        body = (
            '<tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">'
            f"<tptz:ProfileToken>{_xml_escape(profile_token)}</tptz:ProfileToken>"
            "<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom>"
            "</tptz:Stop>"
        )
        await self._call(ptz_url, "http://www.onvif.org/ver20/ptz/wsdl/Stop", body)

    # ---------- 事件（拉取摄像头自身的运动告警等） ----------

    async def create_pullpoint(self, events_url: str) -> str:
        """在事件服务上创建一个拉模式订阅点，返回 PullPoint 地址（后续 PullMessages 打到这里）。"""
        body = '<tev:CreatePullPointSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl"/>'
        root = await self._call(events_url, "http://www.onvif.org/ver10/events/wsdl/CreatePullPointSubscription", body)
        # SubscriptionReference/Address，命名空间前缀不固定，按 local-name 找。
        ref = next((el for el in root.iter() if _local_name(el.tag) == "SubscriptionReference"), None)
        address = next((g for g in (ref.iter() if ref is not None else []) if _local_name(g.tag) == "Address" and g.text), None)
        if address is None or not address.text:
            raise OnvifError("摄像头没有返回事件订阅地址")
        return address.text.strip()

    async def pull_messages(self, pullpoint_url: str, timeout_seconds: int = 30) -> list[dict]:
        """长轮询拉取事件；返回解析后的事件列表（空列表表示这次没有事件）。"""
        body = (
            '<tev:PullMessages xmlns:tev="http://www.onvif.org/ver10/events/wsdl">'
            f"<tev:Timeout>PT{timeout_seconds}S</tev:Timeout>"
            "<tev:MessageLimit>32</tev:MessageLimit>"
            "</tev:PullMessages>"
        )
        root = await self._call(pullpoint_url, "http://www.onvif.org/ver10/events/wsdl/PullMessages", body,
                                timeout=timeout_seconds + 8.0)
        messages: list[dict] = []
        for msg in root.iter():
            if _local_name(msg.tag) != "NotificationMessage":
                continue
            topic = next((g for g in msg.iter() if _local_name(g.tag) == "Topic" and g.text), None)
            entry: dict = {"topic": topic.text if topic is not None else ""}
            for child in msg.iter():
                name = _local_name(child.tag)
                if name == "SimpleItem":
                    item_name = (child.get("Name") or "").strip().lower()
                    if item_name == "state" and "state" not in entry:
                        entry["state"] = (child.get("Value") or "").strip().lower() or None
                elif name == "Message" and child.get("PropertyOperation"):
                    entry["operation"] = child.get("PropertyOperation") or ""
            messages.append(entry)
        return messages


# 名字太长，包一层便于阅读；保持在模块级避免 import 循环感。
def hashlib_sha1(data: bytes) -> bytes:
    import hashlib

    return hashlib.sha1(data).digest()


@dataclass
class _OnvifCache:
    key: tuple[str, int, str, str]
    media_url: str
    ptz_url: str | None
    events_url: str | None
    profile_token: str
    rtsp_url: str


class OnvifManager:
    """按摄像头 id 缓存 ONVIF 探测结果（服务地址 / 码流 token / RTSP 地址）；失败自动失效重探。"""

    def __init__(self) -> None:
        self._caches: dict[str, _OnvifCache] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=CALL_TIMEOUT, connect=CALL_TIMEOUT, sock_connect=CALL_TIMEOUT, sock_read=CALL_TIMEOUT)
            self._session = aiohttp.ClientSession(timeout=timeout)

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None
        self._caches.clear()

    def invalidate(self, camera_id: str | None = None) -> None:
        if camera_id is None:
            self._caches.clear()
        else:
            self._caches.pop(camera_id, None)

    def _client_for(self, camera: dict) -> OnvifClient:
        if self._session is None:
            raise OnvifError("ONVIF 服务尚未启动")
        return OnvifClient(camera["host"], int(camera["port"]), camera["username"], camera.get("password", ""), self._session)

    def _lock(self, camera_id: str) -> asyncio.Lock:
        lock = self._locks.get(camera_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[camera_id] = lock
        return lock

    async def resolve(self, camera: dict) -> _OnvifCache:
        """探测摄像头并缓存；返回含 RTSP 地址与 PTZ 能力的缓存记录。"""
        camera_id = camera["id"]
        key = (camera["host"], int(camera["port"]), camera["username"], camera.get("password", ""))
        async with self._lock(camera_id):
            cached = self._caches.get(camera_id)
            if cached is not None and cached.key == key:
                return cached
            await self.start()
            client = self._client_for(camera)
            media_url, ptz_url, events_url = await client.get_service_urls()
            profiles = await client.get_profiles(media_url)
            profile_token = profiles[0][0]
            rtsp_url = await client.get_stream_uri(media_url, profile_token)
            cached = _OnvifCache(key, media_url, ptz_url, events_url, profile_token, rtsp_url)
            self._caches[camera_id] = cached
            log.info("ONVIF 摄像头 %s（%s:%s）探测成功，PTZ=%s Events=%s", camera.get("name"), camera["host"], camera["port"], bool(ptz_url), bool(events_url))
            return cached

    async def info(self, camera: dict) -> dict:
        cached = await self.resolve(camera)
        return {"type": "onvif", "ptz": cached.ptz_url is not None}

    async def event_pullpoint(self, camera: dict) -> str:
        """为摄像头创建事件拉取点；摄像头不支持事件服务时抛 OnvifError。"""
        cached = await self.resolve(camera)
        if not cached.events_url:
            raise OnvifError("摄像头没有提供 ONVIF 事件服务")
        await self.start()
        return await self._client_for(camera).create_pullpoint(cached.events_url)

    async def pull_messages(self, camera: dict, pullpoint_url: str, timeout_seconds: int = 30) -> list[dict]:
        await self.start()
        return await self._client_for(camera).pull_messages(pullpoint_url, timeout_seconds)

    async def ptz(self, camera: dict, direction: str) -> None:
        """direction: up/down/left/right 开始连续移动，stop 停止。"""
        cached = await self.resolve(camera)
        if cached.ptz_url is None:
            raise OnvifError("这台摄像头不支持云台控制")
        await self.start()
        client = self._client_for(camera)
        try:
            if direction == "stop":
                await client.stop(cached.ptz_url, cached.profile_token)
            else:
                x, y = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}[direction]
                await client.continuous_move(cached.ptz_url, cached.profile_token, x * PTZ_SPEED, y * PTZ_SPEED)
        except OnvifError:
            # 转动失败可能是 token / 服务地址过期，下次重探。
            self.invalidate(camera["id"])
            raise
