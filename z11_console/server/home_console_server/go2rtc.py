"""go2rtc 流媒体网关。

为什么需要：浏览器不能直接播放摄像头 RTSP。原方案是后端用 ffmpeg 转 MJPEG（4fps、高 CPU、
无声音）；go2rtc 支持 WebRTC（亚秒延迟、有声音）并可自动回退 MSE/HLS/MP4/MJPEG，且只向摄像
头拉一路流，多端同时观看不增加摄像头连接数。

工作方式：
- 设置项 go2rtc_url 指向 go2rtc API（默认端口 1984），如 http://192.168.2.203:1984；
  HAOS 加载项内可走 hassio 内网域名（http://a0d7b954_go2rtc:1984），无需对局域网暴露端口。
- 每路摄像头打开时注册为 go2rtc 命名流（PUT /api/streams?name=…&src=rtsp://…），
  RTSP 地址（含账密）只在本服务与 go2rtc 之间传递，浏览器只拿到流名。
- 播放器页面与信令通过本服务同源反向代理 /go2rtc/… 访问：既兼容 Ingress 子路径，又避免跨域。
  只放行播放器必需的 3 个静态文件和 /api/ws（WebRTC 信令 + MSE/HLS/MP4/MJPEG 全走此 WS），
  不代理可改 go2rtc 配置的管理接口。
- 媒体流（SRTP）由浏览器直连 go2rtc 的 WebRTC 端口，不经过本服务。
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlsplit

import aiohttp
from aiohttp import WSMsgType, web

log = logging.getLogger("home_console_server")

# HAOS 内网候选地址：
# - AlexxIT go2rtc 加载项在 hassio 内网的名字是「仓库哈希_slug」（AlexxIT 仓库哈希 a0d7b954）
# - AlexxIT/WebRTC 自定义集成自带的 go2rtc 跑在 HA Core 容器的 1984 端口
ADDON_CANDIDATES = ("http://a0d7b954_go2rtc:1984", "http://homeassistant:1984")

# 播放器 iframe 只允许访问这些 go2rtc 自带的静态文件；其余路径（/api/config、/api/streams
# 写入接口等）一律不代理，避免开放 go2rtc 管理面。
ALLOWED_STATIC = {"stream.html", "video-stream.js", "video-rtc.js", "favicon.ico"}

# 播放器回退顺序：WebRTC（UDP）→ WebRTC/TCP（部分路由器 UDP 不通）→ MSE → HLS → MP4（老 iOS）→ MJPEG。
PLAYER_MODES = "webrtc,webrtc/tcp,mse,hls,mp4,mjpeg"
# go2rtc 的 WebRTC 媒体端口（UDP/TCP 同号）。浏览器走 WebRTC 的前提是它能直连这个端口；
# 部分部署（如没映射 UDP 的容器 / 跨网络）只有 1984 可达，这时必须从下发模式里剔除 webrtc，
# 否则播放器把 webrtc 与 mse 绑在同一条 WS 上协商，webrtc 失败会拖垮 mse 报 "streams: EOF"。
WEBRTC_PORT = 8555

CHECK_TIMEOUT = aiohttp.ClientTimeout(total=6, connect=4)
PROXY_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_connect=10, sock_read=None)
# MSE/MJPEG 关键帧消息可能较大，两侧 WS 都放宽到 16MB。
WS_MAX_SIZE = 16 * 1024 * 1024

# 逐跳头不能转发；accept-encoding 不转发，让上游返回未压缩内容（aiohttp 客户端不会再帮我们解压）。
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
              "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host"}
DROP_RESPONSE = HOP_BY_HOP | {"content-length", "content-encoding"}


def normalize_base(value: str) -> str | None:
    """校验并归一化 go2rtc 地址：必须是 http(s) URL，去掉末尾斜杠。"""
    value = (value or "").strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return parts.geturl().rstrip("/")


async def check(base_url: str) -> dict:
    """探测 go2rtc 是否可用（GET /api/streams）；不可用抛 RuntimeError。"""
    async with aiohttp.ClientSession(timeout=CHECK_TIMEOUT) as session:
        try:
            async with session.get(f"{base_url}/api/streams") as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                data = await response.json()
        except aiohttp.ClientError as error:
            raise RuntimeError(str(error) or "连接失败") from error
    return data if isinstance(data, dict) else {}


async def _webrtc_reachable(base_url: str) -> bool:
    """从本服务视角探测 go2rtc 的 WebRTC UDP 端口是否开放。

    浏览器需直连此端口收发 SRTP；探测不通则从下发模式剔除 webrtc，避免它拖垮 mse。
    UDP 无连接，用「发包后短时间内收到 ICMP 端口不可达 / 连接被拒」判不可达。
    """
    host = urlsplit(base_url).hostname
    if not host:
        return False
    loop = asyncio.get_running_loop()
    try:
        transport, _ = await asyncio.wait_for(
            loop.create_datagram_endpoint(asyncio.DatagramProtocol, remote_addr=(host, WEBRTC_PORT)),
            timeout=CHECK_TIMEOUT.connect)
    except (OSError, asyncio.TimeoutError):
        return False
    try:
        transport.sendto(b"\x00")
        await asyncio.sleep(0.6)  # 等待可能的 ICMP 不可达
        return True
    finally:
        transport.close()


async def player_modes(base_url: str) -> str:
    """按 WebRTC 可达性裁剪下发给播放器的模式串；不可达时从 mse 开始。"""
    if await _webrtc_reachable(base_url):
        return PLAYER_MODES
    log.info("go2rtc 的 WebRTC 端口 %s 不可达，本次画面只用 MSE/HLS/MP4/MJPEG", WEBRTC_PORT)
    return "mse,hls,mp4,mjpeg"


async def detect(candidates: tuple[str, ...] = ADDON_CANDIDATES) -> str | None:
    """按候选顺序探测 go2rtc，返回第一个可用的归一化地址。"""
    for candidate in candidates:
        base_url = normalize_base(candidate)
        if not base_url:
            continue
        try:
            await check(base_url)
            log.info("自动发现 go2rtc：%s", base_url)
            return base_url
        except Exception:
            continue
    return None


async def ensure_stream(base_url: str, name: str, src: str) -> None:
    """把一路 RTSP 注册（或更新）为 go2rtc 命名流。

    PUT 创建；若同名流已存在（go2rtc 重启后内存中仍有旧注册的极端情况），用 PATCH 改源。
    go2rtc 只在有观看者时才真正连接摄像头，注册本身不产生连接。
    """
    params = {"name": name, "src": src}
    async with aiohttp.ClientSession(timeout=CHECK_TIMEOUT) as session:
        async with session.put(f"{base_url}/api/streams", params=params) as response:
            if response.status < 300:
                return
            put_detail = (await response.text())[:200]
        async with session.request("PATCH", f"{base_url}/api/streams", params=params) as response:
            if response.status >= 300:
                detail = (await response.text())[:200]
                raise RuntimeError(f"go2rtc 注册流失败（PUT {response.status}：{put_detail}；PATCH：{detail}）")


async def proxy_static(request: web.Request, base_url: str) -> web.StreamResponse:
    """反向代理 go2rtc 播放器静态文件（白名单内）。"""
    tail = request.match_info.get("tail", "")
    if tail not in ALLOWED_STATIC:
        raise web.HTTPNotFound()
    headers = {key: value for key, value in request.headers.items()
               if key.lower() not in HOP_BY_HOP and key.lower() != "accept-encoding"}
    async with aiohttp.ClientSession(timeout=PROXY_TIMEOUT) as session:
        async with session.get(f"{base_url}/{tail}", headers=headers) as upstream:
            response = web.StreamResponse(status=upstream.status)
            content_type = upstream.headers.get("Content-Type")
            if content_type:
                response.headers["Content-Type"] = content_type
            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(65536):
                await response.write(chunk)
            await response.write_eof()
            return response


async def proxy_ws(request: web.Request, base_url: str) -> web.WebSocketResponse:
    """反向代理 /api/ws：WebRTC 信令与 MSE/HLS/MP4/MJPEG 全部走这一条 WebSocket。"""
    client_ws = web.WebSocketResponse(heartbeat=30, max_msg_size=WS_MAX_SIZE)
    await client_ws.prepare(request)

    upstream_url = f"{base_url}/api/ws"
    if request.query_string:
        upstream_url = f"{upstream_url}?{request.query_string}"
    session = aiohttp.ClientSession()
    try:
        async with session.ws_connect(upstream_url, heartbeat=30, max_msg_size=WS_MAX_SIZE) as upstream_ws:
            async def pump_to_upstream() -> None:
                async for message in client_ws:
                    if message.type == WSMsgType.TEXT:
                        await upstream_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await upstream_ws.send_bytes(message.data)
                    else:
                        break
                if not upstream_ws.closed:
                    await upstream_ws.close()

            async def pump_to_client() -> None:
                async for message in upstream_ws:
                    if message.type == WSMsgType.TEXT:
                        await client_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await client_ws.send_bytes(message.data)
                    else:
                        break
                if not client_ws.closed:
                    await client_ws.close()

            await asyncio.gather(pump_to_upstream(), pump_to_client())
    except aiohttp.ClientError as error:
        log.debug("go2rtc WS 代理结束：%s", error)
    finally:
        await session.close()
    return client_ws
