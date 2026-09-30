"""与 Home Assistant 的唯一连接：令牌认证、订阅全部实体状态与注册表变更、代发命令和服务调用、断线重连。

协议见 https://developers.home-assistant.io/docs/api/websocket/
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import aiohttp

log = logging.getLogger(__name__)

RETRY_DELAYS = [1, 2, 5, 10, 30]
REGISTRY_EVENTS = ("area_registry_updated", "device_registry_updated", "entity_registry_updated", "label_registry_updated")
CALL_TIMEOUT = 10

Status = dict[str, Any]
States = dict[str, dict[str, Any]]


def websocket_url(ha_url: str) -> str:
    """http(s)://host:8123 → ws(s)://host:8123/api/websocket"""
    parts = urlsplit(ha_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + "/api/websocket", "", ""))


class HaAuthError(Exception):
    pass


class HaUpstream:
    def __init__(
        self,
        on_status: Callable[[Status], Awaitable[None]],
        on_states: Callable[[States, dict[str, dict[str, Any] | None]], Awaitable[None]],
        on_registry: Callable[[], Awaitable[None]],
    ) -> None:
        self._on_status = on_status
        self._on_states = on_states
        self._on_registry = on_registry
        self._registry_subscriptions: set[int] = set()
        self._task: asyncio.Task[None] | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 1
        self.states: States = {}
        self.status: Status = {"kind": "disabled"}

    async def configure(self, url: str, token: str, enabled: bool) -> None:
        """设置变化时调用：停止旧连接，按新配置重新连接。"""
        await self.stop()
        if not enabled:
            await self._set_status({"kind": "disabled"})
            return
        if not url or not token:
            await self._set_status({"kind": "unconfigured"})
            return
        self._task = asyncio.create_task(self._run(url, token))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self._clear_states()

    async def command(self, payload: dict[str, Any]) -> Any:
        """发送任意只读命令（如读取注册表），返回 result。"""
        return await self._send(payload)

    async def call_service(self, domain: str, service: str, entity_id: str, data: dict[str, Any]) -> None:
        await self._send({
            "type": "call_service",
            "domain": domain,
            "service": service,
            "service_data": data,
            "target": {"entity_id": entity_id},
        })

    async def _set_status(self, status: Status) -> None:
        self.status = status
        await self._on_status(status)

    async def _clear_states(self) -> None:
        if self.states:
            removed = {entity_id: None for entity_id in self.states}
            self.states = {}
            await self._on_states(self.states, removed)

    async def _run(self, url: str, token: str) -> None:
        attempt = 0
        async with aiohttp.ClientSession() as session:
            while True:
                await self._set_status({"kind": "connecting"})
                try:
                    await self._connect_once(session, url, token)
                    message = "连接已断开"
                except HaAuthError as error:
                    await self._set_status({"kind": "auth_failed", "message": str(error)})
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # 网络错误、地址错误等都按断线重试
                    message = str(error) or error.__class__.__name__
                    log.warning("HA 连接失败：%s", message)
                finally:
                    self._ws = None
                    for future in self._pending.values():
                        if not future.done():
                            future.set_exception(ConnectionError("HA 连接已断开"))
                    self._pending.clear()
                    await self._clear_states()
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                attempt = 0 if self.status.get("kind") == "connected" else attempt + 1
                await self._set_status({"kind": "disconnected", "message": message, "retryInSeconds": delay})
                await asyncio.sleep(delay)

    async def _connect_once(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        async with session.ws_connect(websocket_url(url), heartbeat=30, max_msg_size=16 * 1024 * 1024) as ws:
            first = await ws.receive_json(timeout=10)
            if first.get("type") != "auth_required":
                raise ConnectionError("不是 Home Assistant WebSocket 接口")
            await ws.send_json({"type": "auth", "access_token": token})
            reply = await ws.receive_json(timeout=10)
            if reply.get("type") == "auth_invalid":
                raise HaAuthError(str(reply.get("message") or "令牌无效"))
            if reply.get("type") != "auth_ok":
                raise ConnectionError("认证未完成")
            self._ws = ws
            subscription = self._next_id
            self._next_id += 1
            await ws.send_json({"id": subscription, "type": "subscribe_entities"})
            self._registry_subscriptions = set()
            for event_type in REGISTRY_EVENTS:
                self._registry_subscriptions.add(self._next_id)
                await ws.send_json({"id": self._next_id, "type": "subscribe_events", "event_type": event_type})
                self._next_id += 1
            await self._set_status({"kind": "connected", "version": reply.get("ha_version")})
            async for message in ws:
                if message.type != aiohttp.WSMsgType.TEXT:
                    break
                await self._handle(message.json(), subscription)

    async def _handle(self, message: dict[str, Any], subscription: int) -> None:
        if message.get("type") == "event" and message.get("id") == subscription:
            await self._apply(message.get("event") or {})
        elif message.get("type") == "event" and message.get("id") in self._registry_subscriptions:
            await self._on_registry()
        elif message.get("type") == "result":
            future = self._pending.pop(int(message.get("id", 0)), None)
            if future and not future.done():
                if message.get("success"):
                    future.set_result(message.get("result"))
                else:
                    error = message.get("error") or {}
                    future.set_exception(RuntimeError(str(error.get("message") or "调用失败")))
            elif message.get("id") == subscription and not message.get("success"):
                raise ConnectionError(f"订阅失败：{(message.get('error') or {}).get('message')}")

    async def _apply(self, event: dict[str, Any]) -> None:
        """应用 subscribe_entities 的压缩格式：a 新增/全量，c 增量（"+" 变化，"-" 删除的属性键），r 移除。"""
        changed: dict[str, dict[str, Any] | None] = {}
        for entity_id, compressed in (event.get("a") or {}).items():
            changed[entity_id] = {"state": compressed.get("s"), "attributes": compressed.get("a") or {}}
        for entity_id, diff in (event.get("c") or {}).items():
            previous = self.states.get(entity_id)
            if not previous:
                continue
            plus = diff.get("+") or {}
            attributes = {**previous["attributes"], **(plus.get("a") or {})}
            for key in (diff.get("-") or {}).get("a") or []:
                attributes.pop(key, None)
            changed[entity_id] = {"state": plus.get("s", previous["state"]), "attributes": attributes}
        for entity_id in event.get("r") or []:
            changed[entity_id] = None
        for entity_id, state in changed.items():
            if state is None:
                self.states.pop(entity_id, None)
            else:
                self.states[entity_id] = state
        if changed:
            await self._on_states(self.states, changed)

    async def _send(self, payload: dict[str, Any]) -> Any:
        ws = self._ws
        if ws is None or ws.closed:
            raise ConnectionError("未连接 HA")
        message_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        await ws.send_json({"id": message_id, **payload})
        try:
            return await asyncio.wait_for(future, CALL_TIMEOUT)
        except asyncio.TimeoutError as error:
            raise TimeoutError("HA 响应超时") from error
        finally:
            self._pending.pop(message_id, None)
