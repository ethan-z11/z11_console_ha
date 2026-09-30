"""季节规则：由控制台用 HA 令牌在 HA 中创建并维护季节辅助元素和三条自动化。

- 辅助元素 input_select.home_console_season（控制台-季节，选项 夏季 / 冬季）是唯一的季节状态；控制台的季节开关读写它。
- 自动化（固定 id，描述中注明由控制台维护，手动修改会被覆盖）：
  1. home_console_season_heating_off：夏季地暖一打开就关闭；季节切到夏季时关闭全部地暖。
  2. home_console_season_ac_summer：夏季空调从关闭变为制热时改为制冷。
  3. home_console_season_ac_winter：冬季空调从关闭变为制冷时改为制热。
  送风、除湿、自动等其他模式不处理。
- 设备按支持的模式自动识别：只有制热 / 关闭的是地暖，同时支持制冷和制热的是空调；设备变化时重新同步。
- 设置里关闭季节规则时删除这三条自动化，保留季节辅助元素。
- 创建后 HA 会按中文名生成拼音实体 ID，同步时按注册表的 unique_id 改为固定的英文 ID。
- 演示模式不连接 HA，季节保存在控制台设置中。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

import aiohttp

from .store import Store

log = logging.getLogger(__name__)

SEASONS = ("summer", "winter")
SEASON_LABELS = {"summer": "夏季", "winter": "冬季"}
SEASON_BY_LABEL = {label: season for season, label in SEASON_LABELS.items()}

HELPER_ID = "home_console_season"
HELPER_ENTITY = f"input_select.{HELPER_ID}"
HELPER_NAME = "控制台-季节"
MANAGED_NOTE = "由家庭控制台（设置 → 自动化 → 季节规则）自动维护，手动修改会被覆盖。"

HEATING_OFF = "home_console_season_heating_off"
AC_SUMMER = "home_console_season_ac_summer"
AC_WINTER = "home_console_season_ac_winter"
MANAGED_IDS = (HEATING_OFF, AC_SUMMER, AC_WINTER)

SYNC_DELAY = 1.0
RENAME_RETRY_DELAY = 3.0
RENAME_RETRIES = 5


def classify_climates(states: dict[str, dict[str, Any]]) -> tuple[list[str], list[str]]:
    """返回（地暖，空调）实体 ID：只有制热 / 关闭的算地暖，同时支持制冷和制热的算空调。"""
    heaters: list[str] = []
    acs: list[str] = []
    for entity_id, state in sorted(states.items()):
        if not entity_id.startswith("climate."):
            continue
        modes = set((state.get("attributes") or {}).get("hvac_modes") or [])
        if "heat" in modes and modes <= {"heat", "off"}:
            heaters.append(entity_id)
        elif {"heat", "cool"} <= modes:
            acs.append(entity_id)
    return heaters, acs


def _season_is(label: str) -> dict[str, Any]:
    return {"condition": "state", "entity_id": HELPER_ENTITY, "state": label}


def _set_mode(target: Any, mode: str) -> dict[str, Any]:
    return {"action": "climate.set_hvac_mode", "target": {"entity_id": target}, "data": {"hvac_mode": mode}}


def desired_automations(heaters: list[str], acs: list[str]) -> dict[str, dict[str, Any]]:
    """按当前设备生成三条自动化的完整配置；没有对应设备的规则不创建。"""
    configs: dict[str, dict[str, Any]] = {}
    summer, winter = SEASON_LABELS["summer"], SEASON_LABELS["winter"]
    if heaters:
        configs[HEATING_OFF] = {
            "id": HEATING_OFF,
            "alias": "控制台-夏季关闭地暖",
            "description": MANAGED_NOTE,
            "mode": "queued",
            "triggers": [
                {"trigger": "state", "entity_id": heaters, "to": "heat", "id": "device"},
                {"trigger": "state", "entity_id": HELPER_ENTITY, "to": summer, "id": "season"},
            ],
            "conditions": [_season_is(summer)],
            "actions": [{
                "choose": [{"conditions": [{"condition": "trigger", "id": "device"}], "sequence": [_set_mode("{{ trigger.entity_id }}", "off")]}],
                "default": [_set_mode(heaters, "off")],
            }],
        }
    if acs:
        configs[AC_SUMMER] = {
            "id": AC_SUMMER,
            "alias": "控制台-夏季空调制热改制冷",
            "description": MANAGED_NOTE,
            "mode": "queued",
            "triggers": [{"trigger": "state", "entity_id": acs, "from": "off", "to": "heat"}],
            "conditions": [_season_is(summer)],
            "actions": [_set_mode("{{ trigger.entity_id }}", "cool")],
        }
        configs[AC_WINTER] = {
            "id": AC_WINTER,
            "alias": "控制台-冬季空调制冷改制热",
            "description": MANAGED_NOTE,
            "mode": "queued",
            "triggers": [{"trigger": "state", "entity_id": acs, "from": "off", "to": "cool"}],
            "conditions": [_season_is(winter)],
            "actions": [_set_mode("{{ trigger.entity_id }}", "heat")],
        }
    return configs


class HaConfigApi:
    """HA 的自动化配置接口（REST，需要管理员令牌）。"""

    def __init__(self, url: str, token: str) -> None:
        self.base = url.rstrip("/") + "/api/config/automation/config/"
        self.headers = {"Authorization": f"Bearer {token}"}

    async def get(self, session: aiohttp.ClientSession, config_id: str) -> dict[str, Any] | None:
        async with session.get(self.base + config_id, headers=self.headers) as response:
            if response.status == 404:
                return None
            response.raise_for_status()
            return await response.json()

    async def save(self, session: aiohttp.ClientSession, config: dict[str, Any]) -> None:
        async with session.post(self.base + config["id"], headers=self.headers, json=config) as response:
            if response.status >= 400:
                raise RuntimeError(f"保存自动化失败（{response.status}）：{(await response.text())[:200]}")

    async def delete(self, session: aiohttp.ClientSession, config_id: str) -> None:
        async with session.delete(self.base + config_id, headers=self.headers) as response:
            if response.status not in (200, 404):
                raise RuntimeError(f"删除自动化失败（{response.status}）：{(await response.text())[:200]}")


class SeasonRules:
    """季节状态读写与 HA 端配置同步。sync_status 给设置页显示。"""

    def __init__(self, store: Store, upstream: Any, audit_ip: Callable[[], str], on_change: Callable[[], Awaitable[None]]) -> None:
        self.store = store
        self.upstream = upstream
        self._audit_ip = audit_ip
        self._on_change = on_change
        self._task: asyncio.Task[None] | None = None
        self._dirty = False
        self.sync_status: dict[str, Any] = {"state": "idle", "message": ""}

    # ---------- 季节 ----------

    def enabled(self) -> bool:
        return self.store.settings.season_rules

    def season(self) -> str | None:
        """当前季节；未启用季节规则、或 HA 中还没有季节辅助元素时为 None。"""
        settings = self.store.settings
        if not settings.season_rules:
            return None
        if settings.data_source != "live":
            return settings.season_demo
        return SEASON_BY_LABEL.get((self.upstream.states.get(HELPER_ENTITY) or {}).get("state"))

    async def set_season(self, season: str) -> None:
        settings = self.store.settings
        if settings.data_source != "live":
            settings.season_demo = season
            self.store.save()
            await self._on_change()
            return
        if HELPER_ENTITY not in self.upstream.states:
            raise RuntimeError("HA 中还没有季节辅助元素，请稍候同步完成后再切换")
        await self.upstream.call_service("input_select", "select_option", HELPER_ENTITY, {"option": SEASON_LABELS[season]})
        # 等 HA 回写新状态（最多 2 秒），让接口返回的季节就是新季节。
        for _ in range(20):
            if self.season() == season:
                return
            await asyncio.sleep(0.1)

    # ---------- 同步 ----------

    def schedule(self) -> None:
        """合并短时间内的多次触发（连接、设备变化、开关设置），只同步一次。"""
        self._dirty = True
        if self.store.settings.data_source == "live":
            self.sync_status = {"state": "syncing", "message": "正在同步到 HA…"}
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while self._dirty:
            self._dirty = False
            await asyncio.sleep(SYNC_DELAY)
            try:
                await self._sync()
            except Exception as error:  # 断线、权限不足、HA 返回错误
                log.warning("同步季节规则失败：%s", error)
                self.sync_status = {"state": "error", "message": str(error) or error.__class__.__name__}

    async def _sync(self) -> None:
        settings = self.store.settings
        if settings.data_source != "live":
            self.sync_status = {"state": "demo", "message": "演示模式，不会改动 HA"}
            return
        if self.upstream.status.get("kind") != "connected":
            self.sync_status = {"state": "waiting", "message": "等待连接 HA"}
            return
        url, token = settings.ha_url, self.store.token()
        api = HaConfigApi(url, token)
        created: list[str] = []
        updated: list[str] = []
        deleted: list[str] = []
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
            if not settings.season_rules:
                for config_id in MANAGED_IDS:
                    if await api.get(session, config_id) is not None:
                        await api.delete(session, config_id)
                        deleted.append(config_id)
                # 刚删除后可能还会有一次无事可做的同步，提示用两种情况都成立的说法。
                self.sync_status = {"state": "off", "message": "季节规则未启用，HA 中已没有季节自动化"}
                self._audit(created, updated, deleted)
                return
            if HELPER_ENTITY not in self.upstream.states:
                await self._create_helper()
                created.append(HELPER_ENTITY)
            heaters, acs = classify_climates(self.upstream.states)
            desired = desired_automations(heaters, acs)
            for config_id in MANAGED_IDS:
                current = await api.get(session, config_id)
                if config_id not in desired:
                    if current is not None:
                        await api.delete(session, config_id)
                        deleted.append(config_id)
                    continue
                if current != desired[config_id]:
                    await api.save(session, desired[config_id])
                    (updated if current is not None else created).append(config_id)
        self._audit(created, updated, deleted)
        renamed_all = await self._rename_entities(list(desired))
        counts = f"地暖 {len(heaters)} 个、空调 {len(acs)} 台，自动化 {len(desired)} 条"
        self.sync_status = {"state": "ok", "message": f"同步完成：{counts}"} if renamed_all else {"state": "pending", "message": f"{counts}已写入，正在等待 HA 生成实体"}
        await self._on_change()

    async def _create_helper(self) -> None:
        items = await self.upstream.command({"type": "input_select/list"}) or []
        if not any(item.get("id") == HELPER_ID for item in items):
            await self.upstream.command({"type": "input_select/create", "name": HELPER_ID, "options": list(SEASON_LABELS.values()), "icon": "mdi:sun-snowflake-variant"})
        # 按英文 id 创建以得到固定的实体 ID，再把显示名称改为中文。
        for _ in range(RENAME_RETRIES):
            registry = await self.upstream.command({"type": "config/entity_registry/list"}) or []
            if any(entry.get("entity_id") == HELPER_ENTITY for entry in registry):
                await self.upstream.command({"type": "config/entity_registry/update", "entity_id": HELPER_ENTITY, "name": HELPER_NAME})
                return
            await asyncio.sleep(RENAME_RETRY_DELAY / 3)

    async def _rename_entities(self, config_ids: list[str]) -> bool:
        """HA 按中文别名生成的实体 ID 改为 automation.<固定 id>；实体还没出现时稍后重试。"""
        for attempt in range(RENAME_RETRIES):
            registry = await self.upstream.command({"type": "config/entity_registry/list"}) or []
            by_unique = {entry.get("unique_id"): entry for entry in registry if entry.get("platform") == "automation"}
            missing = False
            for config_id in config_ids:
                entry = by_unique.get(config_id)
                if entry is None:
                    missing = True
                    continue
                target = f"automation.{config_id}"
                if entry.get("entity_id") != target:
                    await self.upstream.command({"type": "config/entity_registry/update", "entity_id": entry["entity_id"], "new_entity_id": target})
            if not missing:
                return True
            if attempt < RENAME_RETRIES - 1:
                await asyncio.sleep(RENAME_RETRY_DELAY)
        return False

    def _audit(self, created: list[str], updated: list[str], deleted: list[str]) -> None:
        if created or updated or deleted:
            self.store.audit("season_rules_synced", self._audit_ip(), created=created, updated=updated, deleted=deleted)
