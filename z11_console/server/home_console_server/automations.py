"""HA 自动化列表：从实时状态与实体注册表整理出自动化的名称、开关状态和上次触发时间。

- 设置页“自动化”标签使用：只列出 automation.* 实体，注册表中已禁用的不列出。
- 开关只调用 automation.turn_on / automation.turn_off，并且只接受当前列表中的实体（由 app.py 校验）。
- 演示模式没有 HA，使用内存中的演示自动化，开关只改内存。
"""

from __future__ import annotations

from typing import Any

DOMAIN = "automation"


def build_automations(states: dict[str, dict[str, Any]], registry: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries = {entry.get("entity_id"): entry for entry in registry}
    items: list[dict[str, Any]] = []
    for entity_id, state in states.items():
        if not entity_id.startswith(f"{DOMAIN}."):
            continue
        entry = entries.get(entity_id) or {}
        if entry.get("disabled_by"):
            continue
        attributes = state.get("attributes") or {}
        items.append({
            "id": entity_id,
            "name": str(attributes.get("friendly_name") or entry.get("name") or entry.get("original_name") or entity_id),
            "state": state.get("state"),
            "lastTriggered": attributes.get("last_triggered"),
        })
    return sorted(items, key=lambda item: item["name"])


def demo_automations() -> dict[str, dict[str, Any]]:
    """演示数据：几条常见的家庭自动化。"""
    samples = [
        ("automation.demo_evening_lights", "傍晚自动开客厅灯", "on", "2026-09-24T18:02:11+08:00"),
        ("automation.demo_leave_home", "离家关闭全部灯光", "on", "2026-09-24T08:31:45+08:00"),
        ("automation.demo_bedtime", "睡前关闭公共区域", "on", "2026-09-23T23:15:03+08:00"),
        ("automation.demo_bathroom_motion", "卫生间有人自动亮灯", "off", None),
        ("automation.demo_summer_ac", "室温超过 28° 提醒开空调", "on", None),
    ]
    return {entity_id: {"id": entity_id, "name": name, "state": state, "lastTriggered": last} for entity_id, name, state, last in samples}
