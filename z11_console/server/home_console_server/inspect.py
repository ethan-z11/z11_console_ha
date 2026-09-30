"""只读诊断：用服务保存的 HA 地址和令牌读取一次注册表和全部状态，按房间列出自动发现的实体，并标出过滤结果。

不调用任何服务、不修改 HA，也不输出令牌。用法：
    uv run python -m home_console_server.inspect [--data data] [--json 输出文件]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import aiohttp

from .discovery import build_catalogue, visible_ids
from .ha import websocket_url
from .store import Store

SERVER_DIR = Path(__file__).resolve().parent.parent
COMMANDS = ["config/area_registry/list", "config/device_registry/list", "config/entity_registry/list", "config/label_registry/list", "get_states"]


async def fetch(url: str, token: str) -> list[Any]:
    """依次读取区域、设备、实体注册表和全部状态。"""
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(websocket_url(url), max_msg_size=64 * 1024 * 1024) as ws:
            await ws.receive_json(timeout=10)
            await ws.send_json({"type": "auth", "access_token": token})
            reply = await ws.receive_json(timeout=10)
            if reply.get("type") != "auth_ok":
                raise SystemExit(f"认证失败：{reply.get('message') or reply.get('type')}")
            print(f"已连接 HA {reply.get('ha_version')}：{url}")
            results = []
            for index, command in enumerate(COMMANDS, start=1):
                await ws.send_json({"id": index, "type": command})
                while True:
                    message = await ws.receive_json(timeout=30)
                    if message.get("id") == index:
                        if not message.get("success"):
                            raise SystemExit(f"{command} 失败：{message.get('error')}")
                        results.append(message["result"])
                        break
            return results


def main() -> None:
    parser = argparse.ArgumentParser(description="只读查看 HA 自动发现结果")
    parser.add_argument("--data", type=Path, default=SERVER_DIR / "data")
    parser.add_argument("--json", type=Path, help="把发现结果另存为 JSON")
    args = parser.parse_args()

    store = Store(args.data)
    settings = store.settings
    if not settings.ha_url or not store.token():
        raise SystemExit("服务中尚未保存 HA 地址或令牌")
    areas, devices, registry, labels, states = asyncio.run(fetch(settings.ha_url, store.token()))
    state_map = {state["entity_id"]: state for state in states}
    catalogue = build_catalogue(areas, devices, registry, labels, state_map)
    shown = visible_ids(catalogue, settings.filter_mode, settings.blacklist, settings.whitelist)
    mode = "白名单" if settings.filter_mode == "whitelist" else "黑名单"

    print(f"实体总数 {len(states)}，区域 {len(areas)} 个；自动发现 {len(catalogue['entities'])} 个，按{mode}过滤后显示 {len(shown)} 个")
    room_names = {room["id"]: room["name"] for room in catalogue["rooms"]}
    for area_id in [room["id"] for room in catalogue["rooms"]] + [None]:
        members = [entity for entity in catalogue["entities"] if entity["areaId"] == area_id]
        if not members:
            continue
        print(f"\n【{room_names.get(area_id, '未分配区域')}】")
        for entity in members:
            mark = "显示" if entity["id"] in shown else "隐藏"
            state = state_map[entity["id"]]["state"]
            print(f"  {mark}  {entity['id']:<52} {state:<12} {entity['name']}")
    if args.json:
        args.json.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n已写入 {args.json}")


if __name__ == "__main__":
    sys.exit(main())
