"""设置与审计记录的持久化。

- settings.json：HA 地址、控制开关、数据来源、设备过滤（黑名单 / 白名单）、管理密码的 scrypt 哈希、加密后的 HA 令牌。文件权限 0600。
- HA 令牌用 Fernet（AES-128-CBC + HMAC）加密。密钥优先取环境变量 HOME_CONSOLE_SECRET；
  未设置时在数据目录生成 secret.key（与 Node-RED 的 _credentialSecret 同理：能读到整个数据目录的人仍可解密）。
- layout.json：全家共用的布局（卡片尺寸、房间内顺序、常用设备、房间顺序），所有屏幕看到同一份。
- audit.log：每行一条 JSON，记录登录、设置变更与设备控制；从不写入令牌或密码。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

DEFAULT_PIN = "1234"
THEMES = ("dark", "light", "auto")
ACCENTS = ("amber", "coral", "rose", "violet", "sky", "teal", "green")  # 强调色，第一个为默认
DEFAULT_HOME_TITLE = "我的家庭"
HOME_TITLE_MAX = 12
DEFAULT_HOME_SUBTITLE = ""
DEFAULT_BRAND_TITLE = "家庭控制"
BRAND_TITLE_MAX = 7  # 家庭名称最长 7 个中文字
TILE_SCALE_MIN, TILE_SCALE_MAX, TILE_SCALE_DEFAULT = 80, 120, 100  # 设备格子缩放百分比
AUDIT_MAX_BYTES = 1_000_000

# ---------- 账户系统：accounts.json 独立文件，便于 Docker/compose 映射备份 ----------

# 默认管理员：首次启动自动创建，登录后引导修改账户名与密码；完成后 setup_completed=True。
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin"
USERNAME_MAX = 32
PASSWORD_MIN = 4
PASSWORD_MAX = 128
ACCOUNTS_MAX = 20  # 子账户最多 20 个（不含管理员）
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{2,32}$")


def _write_private(path: Path, text: str) -> None:
    """原子写入并限制为仅属主可读写。"""
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temp, path)


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    return hmac.compare_digest(hash_pin(pin, bytes.fromhex(salt_hex)).split("$")[2], digest_hex)


TILE_SIZES = ("1x1", "2x1")
MAX_ID_LENGTH = 255

# ---------- 手动房间 / 设备归属 / 情景模式按钮（custom.json） ----------

CUSTOM_ROOM_MAX = 50
CUSTOM_ROOM_NAME_MAX = 12
CUSTOM_ASSIGN_MAX = 2000
CUSTOM_SCENE_MAX = 100
CUSTOM_SCENE_NAME_MAX = 12
# 设备实体自定义显示名（改名）的最大长度。
CUSTOM_ENTITY_NAME_MAX = 24
CUSTOM_CAMERA_MAX = 24
CUSTOM_CAMERA_NAME_MAX = 12
CUSTOM_CAMERA_URL_MAX = 300
# 房间温湿度来源（手动指定实体及其数值参数）：主页 + 每个房间各有温度 / 湿度两条。
CUSTOM_METRIC_SOURCE_MAX = 100
METRIC_ATTR_RE = re.compile(r"^[A-Za-z0-9_]{1,48}$")
METRIC_NAMES = ("temperature", "humidity")
RTSP_URL_RE = re.compile(r"^rtsp://\S+$", re.IGNORECASE)
# ONVIF 摄像头：主机（IP 或域名）、端口、登录账号密码；不存整 URL，取流时由后端组装。
CUSTOM_CAMERA_HOST_MAX = 128
ONVIF_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")
CUSTOM_CAMERA_USER_MAX = 64
CUSTOM_CAMERA_PASSWORD_MAX = 128
ONVIF_DEFAULT_PORT = 8000
ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
ENTITY_ID_RE = re.compile(r"^(?:[a-z0-9_]{1,32})\.(?:[a-z0-9_]{1,64})$")
# 图标键：前端图标表中的短横线 kebab 名（如 sofa / bed-double）；空字符串表示用默认图标。
ICON_KEY_RE = re.compile(r"^$|^[a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3}$")
SCENE_TARGET_DOMAINS = ("scene", "script", "button", "input_button", "automation")
HOME_SCOPE = "home"


def clean_custom(raw: Any, known_rooms: set[str] | None = None, known_entities: set[str] | None = None,
                 known_metrics: dict[str, set[str]] | None = None) -> dict[str, Any]:
    """校验手动房间、设备归属和情景按钮。

    保存时以当前发现结果为准：归属房间必须存在、实体必须已发现；未知的条目直接丢弃。
    known_rooms/known_entities 为 None 时只做格式校验（例如加载历史文件）。
    """
    raw = raw if isinstance(raw, dict) else {}
    rooms_in: list[Any] = raw.get("rooms") if isinstance(raw.get("rooms"), list) else []
    rooms: list[dict[str, str]] = []
    room_ids: set[str] = set()
    for item in rooms_in[:CUSTOM_ROOM_MAX]:
        if not isinstance(item, dict):
            continue
        room_id, name = item.get("id"), item.get("name")
        if not isinstance(room_id, str) or not ROOM_ID_RE.fullmatch(room_id) or room_id in room_ids or room_id == HOME_SCOPE:
            continue
        name = " ".join(str(name).split()) if isinstance(name, str) else ""
        if not 0 < len(name) <= CUSTOM_ROOM_NAME_MAX:
            continue
        icon = item.get("icon", "")
        icon = icon if isinstance(icon, str) and ICON_KEY_RE.fullmatch(icon) else ""
        room_ids.add(room_id)
        rooms.append({"id": room_id, "name": name, "icon": icon})
    valid_rooms = room_ids if known_rooms is None else room_ids & known_rooms

    assignments_in = raw.get("assignments") if isinstance(raw.get("assignments"), dict) else {}
    assignments: dict[str, str] = {}
    for entity_id, room_id in assignments_in.items():
        if len(assignments) >= CUSTOM_ASSIGN_MAX:
            break
        if not isinstance(entity_id, str) or not ENTITY_ID_RE.fullmatch(entity_id) or entity_id in assignments:
            continue
        if not isinstance(room_id, str) or room_id not in valid_rooms:
            continue
        if known_entities is not None and entity_id not in known_entities:
            continue
        assignments[entity_id] = room_id

    scenes_in: list[Any] = raw.get("scenes") if isinstance(raw.get("scenes"), list) else []
    scenes: list[dict[str, str]] = []
    scene_ids: set[str] = set()
    for item in scenes_in[:CUSTOM_SCENE_MAX]:
        if not isinstance(item, dict):
            continue
        scene_id, name, entity_id, scope = item.get("id"), item.get("name"), item.get("entity"), item.get("scope")
        if not isinstance(scene_id, str) or not ROOM_ID_RE.fullmatch(scene_id) or scene_id in scene_ids:
            continue
        # 名称可空：空名称时前端直接显示目标实体的名称。
        name = " ".join(str(name).split()) if isinstance(name, str) else ""
        if len(name) > CUSTOM_SCENE_NAME_MAX:
            continue
        icon = item.get("icon", "")
        icon = icon if isinstance(icon, str) and ICON_KEY_RE.fullmatch(icon) else ""
        if not isinstance(entity_id, str) or not ENTITY_ID_RE.fullmatch(entity_id) or entity_id.split(".")[0] not in SCENE_TARGET_DOMAINS:
            continue
        if known_entities is not None and entity_id not in known_entities:
            continue
        if not isinstance(scope, str) or not (scope == HOME_SCOPE or scope in valid_rooms):
            continue
        scene_ids.add(scene_id)
        scenes.append({"id": scene_id, "name": name, "entity": entity_id, "scope": scope, "icon": icon})

    # 设备实体的显示覆盖：改名 / 换图标。name 空字符串表示跟随原名称，icon 空字符串表示自动匹配；两者皆空的条目不保存。
    entities_in = raw.get("entities") if isinstance(raw.get("entities"), dict) else {}
    entities: dict[str, dict[str, str]] = {}
    for entity_id, item in entities_in.items():
        if len(entities) >= CUSTOM_ASSIGN_MAX:
            break
        if not isinstance(entity_id, str) or not ENTITY_ID_RE.fullmatch(entity_id) or entity_id in entities:
            continue
        if known_entities is not None and entity_id not in known_entities:
            continue
        if not isinstance(item, dict):
            continue
        name = " ".join(str(item.get("name")).split()) if isinstance(item.get("name"), str) else ""
        if len(name) > CUSTOM_ENTITY_NAME_MAX:
            name = ""
        icon = item.get("icon", "")
        icon = icon if isinstance(icon, str) and ICON_KEY_RE.fullmatch(icon) else ""
        if not name and not icon:
            continue
        entities[entity_id] = {"name": name, "icon": icon}

    # 自定义摄像头：名称 + 接入方式 + 显示位置（我的家庭或某个房间）。
    # - rtsp：完整 rtsp 地址（可能含账号密码，只保存在服务端）。
    # - onvif：主机 / 端口 / 账号 / 密码，取流地址由后端经 ONVIF 协议动态获取，账密绝不下发。
    cameras_in = raw.get("cameras") if isinstance(raw.get("cameras"), list) else []
    cameras: list[dict[str, Any]] = []
    camera_ids: set[str] = set()
    for item in cameras_in[:CUSTOM_CAMERA_MAX]:
        if not isinstance(item, dict):
            continue
        camera_id = item.get("id")
        if not isinstance(camera_id, str) or not ROOM_ID_RE.fullmatch(camera_id) or camera_id in camera_ids:
            continue
        name = " ".join(str(item.get("name")).split()) if isinstance(item.get("name"), str) else ""
        if not 1 <= len(name) <= CUSTOM_CAMERA_NAME_MAX:
            continue
        scope = item.get("scope")
        if not isinstance(scope, str) or not (scope == HOME_SCOPE or scope in valid_rooms):
            continue
        # 旧数据没有 type 字段，按 rtsp 处理。
        camera_type = item.get("type", "rtsp")
        if camera_type not in ("rtsp", "onvif"):
            continue
        entry: dict[str, Any] | None = None
        if camera_type == "rtsp":
            rtsp_url = str(item.get("rtspUrl", "")).strip() if isinstance(item.get("rtspUrl"), str) else ""
            if RTSP_URL_RE.fullmatch(rtsp_url) and len(rtsp_url) <= CUSTOM_CAMERA_URL_MAX:
                entry = {"id": camera_id, "name": name, "type": "rtsp", "rtspUrl": rtsp_url, "scope": scope}
        else:
            host = str(item.get("host", "")).strip() if isinstance(item.get("host"), str) else ""
            port = item.get("port", ONVIF_DEFAULT_PORT)
            if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
                port = 0
            username = str(item.get("username", "")).strip() if isinstance(item.get("username"), str) else ""
            password = item.get("password", "")
            # 密码允许空白（个别摄像头无鉴权），但必须是字符串；不去空格，避免改掉真实密码。
            if not isinstance(password, str):
                password = ""
            if (ONVIF_HOST_RE.fullmatch(host) and len(host) <= CUSTOM_CAMERA_HOST_MAX and port
                    and 1 <= len(username) <= CUSTOM_CAMERA_USER_MAX and len(password) <= CUSTOM_CAMERA_PASSWORD_MAX):
                entry = {"id": camera_id, "name": name, "type": "onvif", "host": host, "port": port,
                         "username": username, "password": password, "scope": scope}
        if entry is not None:
            camera_ids.add(camera_id)
            cameras.append(entry)

    # 温湿度来源：每个作用域（主页 home 或某个房间）的每个指标最多一条；新增同槽位条目自动替代旧条目。
    # attribute 为 "state"（实体状态值）或实体属性键（如 climate 的 current_temperature / current_humidity）。
    metric_in = raw.get("metricSources") if isinstance(raw.get("metricSources"), list) else []
    metric_sources: list[dict[str, str]] = []
    metric_slots: set[tuple[str, str]] = set()
    for item in metric_in[:CUSTOM_METRIC_SOURCE_MAX]:
        if not isinstance(item, dict):
            continue
        source_id = item.get("id")
        scope, metric, entity_id, attribute = item.get("scope"), item.get("metric"), item.get("entity"), item.get("attribute")
        if not isinstance(source_id, str) or not ROOM_ID_RE.fullmatch(source_id) or source_id in {s["id"] for s in metric_sources}:
            continue
        if not isinstance(scope, str) or not (scope == HOME_SCOPE or scope in valid_rooms):
            continue
        if metric not in METRIC_NAMES or (scope, metric) in metric_slots:
            continue
        if not isinstance(entity_id, str) or not ENTITY_ID_RE.fullmatch(entity_id):
            continue
        if known_entities is not None and entity_id not in known_entities:
            continue
        if not isinstance(attribute, str) or not METRIC_ATTR_RE.fullmatch(attribute):
            continue
        if known_metrics is not None and f"{metric}:{attribute}" not in known_metrics.get(entity_id, set()):
            continue
        metric_slots.add((scope, metric))
        metric_sources.append({"id": source_id, "scope": scope, "metric": metric, "entity": entity_id, "attribute": attribute})

    return {"rooms": rooms, "assignments": assignments, "scenes": scenes, "entities": entities,
            "cameras": cameras, "metricSources": metric_sources}


def id_list(value: Any) -> list[str] | None:
    if not isinstance(value, list) or len(value) > 2000:
        return None
    if not all(isinstance(item, str) and 0 < len(item) <= MAX_ID_LENGTH for item in value):
        return None
    return list(dict.fromkeys(value))


def clean_layout(raw: Any) -> dict[str, Any]:
    """只保留合法字段：sizes 设备 → 1x1/2x1，order 房间 → 设备顺序，favorites 常用设备（null 表示用默认清单），rooms 导航房间顺序（空表示默认顺序）。"""
    raw = raw if isinstance(raw, dict) else {}
    sizes = raw.get("sizes") if isinstance(raw.get("sizes"), dict) else {}
    order = raw.get("order") if isinstance(raw.get("order"), dict) else {}
    layout: dict[str, Any] = {
        "sizes": {key: value for key, value in sizes.items() if isinstance(key, str) and len(key) <= MAX_ID_LENGTH and value in TILE_SIZES},
        "order": {key: ids for key, value in order.items() if isinstance(key, str) and len(key) <= MAX_ID_LENGTH and (ids := id_list(value)) is not None},
        "favorites": id_list(raw.get("favorites")),
        "rooms": id_list(raw.get("rooms")) or [],
    }
    return layout


def is_pin(value: object) -> bool:
    return isinstance(value, str) and len(value) == 4 and value.isdigit()


@dataclass
class Settings:
    ha_url: str = ""
    control_enabled: bool = True
    data_source: str = "demo"  # demo | live
    token_encrypted: str = ""
    filter_mode: str = "blacklist"  # blacklist：显示全部发现的实体，名单内的隐藏；whitelist：只显示名单内的
    blacklist: list[str] = field(default_factory=list)
    whitelist: list[str] = field(default_factory=list)
    theme: str = "dark"  # dark | light | auto（日出到日落浅色，其余深色）
    home_title: str = DEFAULT_HOME_TITLE  # 首页标题，同时用作导航入口名称；不能为空
    brand_title: str = DEFAULT_BRAND_TITLE  # 家庭名称（导航栏品牌、网页标题），最长 7 个中文字
    accent: str = ACCENTS[0]  # 强调色（设置 → 显示），所有屏幕共用
    season_rules: bool = False  # 季节规则（设置 → 自动化）：启用后由控制台在 HA 中维护季节辅助元素和自动化
    season_demo: str = "summer"  # 演示模式下的季节；HA 模式的季节保存在 HA 的季节辅助元素中
    tile_scale: int = TILE_SCALE_DEFAULT  # 设备格子缩放百分比（80–120），所有屏幕共用
    music_url: str = ""  # 音乐页内嵌地址（iframe），空表示未配置，首页不显示音乐入口
    # “一键关闭”可关的设备类别（默认只关灯）与区域（空列表 = 全部房间）。
    all_off_kinds: list[str] = field(default_factory=lambda: ['light'])
    all_off_scopes: list[str] = field(default_factory=list)
    # “一键关闭”额外指定的实体 ID（不在上面的类别内、但也要一起关闭）。
    all_off_entities: list[str] = field(default_factory=list)
    # 人员在家配置：每人 id/name/entityId/image(自定义图片名,null=默认)/homeStates(判定在家的状态值列表)
    people: list[dict[str, Any]] = field(default_factory=list)

    def filter(self) -> dict[str, Any]:
        return {"mode": self.filter_mode, "blacklist": self.blacklist, "whitelist": self.whitelist}

    def public(self) -> dict[str, Any]:
        """给已登录管理员看的设置；令牌只返回是否已保存。"""
        return {
            "haUrl": self.ha_url,
            "hasToken": bool(self.token_encrypted),
            "controlEnabled": self.control_enabled,
            "dataSource": self.data_source,
            "homeTitle": self.home_title,
            "brandTitle": self.brand_title,
            "theme": self.theme,
            "tileScale": self.tile_scale,
            "accent": self.accent,
            "seasonRules": self.season_rules,
            "musicUrl": self.music_url,
            "allOffKinds": self.all_off_kinds,
            "allOffScopes": self.all_off_scopes,
            "allOffEntities": self.all_off_entities,
            "people": self.people,
        }


@dataclass
class Account:
    """账户：管理员（is_admin=True）或子账户（无管理权限）。

    管理员账户名在 setup_completed=False 时可改（首次进入引导），完成后锁定；
    子账户由管理员在设置 → 安全 中创建，不能进入管理界面之外的设置板块。
    """
    id: str
    username: str
    password_hash: str  # scrypt 哈希（复用 hash_pin/verify_pin）
    is_admin: bool = False
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "passwordHash": self.password_hash,
            "isAdmin": self.is_admin,
            "createdAt": self.created_at,
        }

    def public(self) -> dict[str, Any]:
        """下发到前端的账户信息（不含密码哈希）。"""
        return {
            "id": self.id,
            "username": self.username,
            "isAdmin": self.is_admin,
            "createdAt": self.created_at,
        }


def is_tile_scale(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and TILE_SCALE_MIN <= value <= TILE_SCALE_MAX


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(data_dir, 0o700)
        self.settings_path = data_dir / "settings.json"
        self.audit_path = data_dir / "audit.log"
        self.fernet = Fernet(self._load_key())
        self.settings = self._load_settings()
        self.layout_path = data_dir / "layout.json"
        self.layout = self._load_layout()
        self.custom_path = data_dir / "custom.json"
        self.custom = self._load_custom()
        # 账户系统：accounts.json 独立文件，便于 Docker/compose 单独映射备份。
        # sessions.json 持久化会话，重启后浏览器复用 Cookie 免重新登录。
        self.accounts_path = data_dir / "accounts.json"
        self.sessions_path = data_dir / "sessions.json"
        self.accounts, self.setup_completed = self._load_accounts()

    def _load_key(self) -> bytes:
        secret = os.environ.get("HOME_CONSOLE_SECRET")
        if secret:
            return secret.encode()
        key_path = self.data_dir / "secret.key"
        if not key_path.exists():
            _write_private(key_path, Fernet.generate_key().decode())
        return key_path.read_text().strip().encode()

    def _load_settings(self) -> Settings:
        if not self.settings_path.exists():
            settings = Settings()
            self._save(settings)
            return settings
        raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
        return Settings(
            ha_url=str(raw.get("haUrl", "")),
            control_enabled=bool(raw.get("controlEnabled", True)),
            data_source="live" if raw.get("dataSource") == "live" else "demo",
            token_encrypted=str(raw.get("tokenEncrypted", "")),
            filter_mode="whitelist" if raw.get("filterMode") == "whitelist" else "blacklist",
            blacklist=id_list(raw.get("blacklist")) or [],
            whitelist=id_list(raw.get("whitelist")) or [],
            theme=raw.get("theme") if raw.get("theme") in THEMES else "dark",
            home_title=str(raw.get("homeTitle") or DEFAULT_HOME_TITLE)[:HOME_TITLE_MAX],
            brand_title=str(raw.get("brandTitle") or DEFAULT_BRAND_TITLE)[:BRAND_TITLE_MAX],
            tile_scale=raw["tileScale"] if is_tile_scale(raw.get("tileScale")) else TILE_SCALE_DEFAULT,
            accent=raw.get("accent") if raw.get("accent") in ACCENTS else ACCENTS[0],
            season_rules=raw.get("seasonRules") is True,
            season_demo=raw.get("seasonDemo") if raw.get("seasonDemo") in ("summer", "winter") else "summer",
            music_url=str(raw.get("musicUrl", "")),
            all_off_kinds=id_list(raw.get("allOffKinds")) or ["light"],
            all_off_scopes=id_list(raw.get("allOffScopes")) or [],
            all_off_entities=id_list(raw.get("allOffEntities")) or [],
            people=raw.get("people") if isinstance(raw.get("people"), list) else [],
        )

    def _save(self, settings: Settings) -> None:
        payload = {
            "haUrl": settings.ha_url,
            "controlEnabled": settings.control_enabled,
            "dataSource": settings.data_source,
            "tokenEncrypted": settings.token_encrypted,
            "filterMode": settings.filter_mode,
            "blacklist": settings.blacklist,
            "whitelist": settings.whitelist,
            "homeTitle": settings.home_title,
            "brandTitle": settings.brand_title,
            "theme": settings.theme,
            "tileScale": settings.tile_scale,
            "accent": settings.accent,
            "seasonRules": settings.season_rules,
            "seasonDemo": settings.season_demo,
            "musicUrl": settings.music_url,
            "allOffKinds": settings.all_off_kinds,
            "allOffScopes": settings.all_off_scopes,
            "allOffEntities": settings.all_off_entities,
            "people": settings.people,
        }
        _write_private(self.settings_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    # ---------- 账户系统 ----------

    def _load_accounts(self) -> tuple[list[Account], bool]:
        """加载 accounts.json；首次启动无文件时创建默认管理员 admin/admin。

        返回 (accounts, setup_completed)：setup_completed=False 时管理员仍可改用户名。
        """
        if not self.accounts_path.exists():
            admin = Account(
                id=secrets.token_hex(8),
                username=DEFAULT_ADMIN_USERNAME,
                password_hash=hash_pin(DEFAULT_ADMIN_PASSWORD),
                is_admin=True,
                created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            )
            self._save_accounts([admin], setup_completed=False)
            return [admin], False
        try:
            raw = json.loads(self.accounts_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raw = {}
        accounts: list[Account] = []
        items = raw.get("accounts") if isinstance(raw.get("accounts"), list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            account_id = str(item.get("id", ""))
            username = str(item.get("username", ""))
            password_hash = str(item.get("passwordHash", ""))
            if not account_id or not username or not password_hash:
                continue
            accounts.append(Account(
                id=account_id,
                username=username,
                password_hash=password_hash,
                is_admin=bool(item.get("isAdmin", False)),
                created_at=str(item.get("createdAt", "")),
            ))
        # 兜底：万一管理员被误删，重建默认管理员（仍按未完成 setup 处理）。
        if not any(a.is_admin for a in accounts):
            admin = Account(
                id=secrets.token_hex(8),
                username=DEFAULT_ADMIN_USERNAME,
                password_hash=hash_pin(DEFAULT_ADMIN_PASSWORD),
                is_admin=True,
                created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            )
            accounts.append(admin)
            self._save_accounts(accounts, setup_completed=False)
            return accounts, False
        return accounts, bool(raw.get("setupCompleted", False))

    def _save_accounts(self, accounts: list[Account], setup_completed: bool) -> None:
        payload = {
            "accounts": [account.to_dict() for account in accounts],
            "setupCompleted": setup_completed,
            "version": 1,
        }
        _write_private(self.accounts_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    def save_accounts(self) -> None:
        self._save_accounts(self.accounts, self.setup_completed)

    def find_account(self, username: str) -> Account | None:
        return next((a for a in self.accounts if a.username == username), None)

    def find_account_by_id(self, account_id: str) -> Account | None:
        return next((a for a in self.accounts if a.id == account_id), None)

    def verify_account(self, username: str, password: str) -> Account | None:
        account = self.find_account(username)
        if not account or not verify_pin(password, account.password_hash):
            return None
        return account

    def add_account(self, username: str, password: str, is_admin: bool = False) -> Account | None:
        """新增子账户（管理员在设置 → 安全 中创建）。返回 None 表示参数不合法或重名。"""
        username = " ".join(username.split())
        if not USERNAME_RE.fullmatch(username) or len(username) > USERNAME_MAX:
            return None
        if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
            return None
        if self.find_account(username):
            return None  # 用户名已存在
        non_admin_count = sum(1 for a in self.accounts if not a.is_admin)
        if not is_admin and non_admin_count >= ACCOUNTS_MAX:
            return None
        account = Account(
            id=secrets.token_hex(8),
            username=username,
            password_hash=hash_pin(password),
            is_admin=is_admin,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        )
        self.accounts.append(account)
        self.save_accounts()
        return account

    def delete_account(self, account_id: str) -> bool:
        """删除子账户；管理员账户不可删除。"""
        account = self.find_account_by_id(account_id)
        if not account or account.is_admin:
            return False
        self.accounts = [a for a in self.accounts if a.id != account_id]
        self.save_accounts()
        return True

    def change_password(self, account_id: str, new_password: str) -> bool:
        """修改自己密码（管理员与子账户均可）。"""
        account = self.find_account_by_id(account_id)
        if not account or not PASSWORD_MIN <= len(new_password) <= PASSWORD_MAX:
            return False
        account.password_hash = hash_pin(new_password)
        self.save_accounts()
        return True

    def complete_setup(self, new_username: str, new_password: str) -> bool:
        """首次进入引导：管理员改账户名 + 密码，并把 setup_completed 置为 True。

        完成后管理员账户名锁定，仅在“安全”中改密码。
        """
        if self.setup_completed:
            return False
        admin = next((a for a in self.accounts if a.is_admin), None)
        if not admin:
            return False
        new_username = " ".join(new_username.split())
        if not USERNAME_RE.fullmatch(new_username) or len(new_username) > USERNAME_MAX:
            return False
        conflict = self.find_account(new_username)
        if conflict and conflict.id != admin.id:
            return False
        if not PASSWORD_MIN <= len(new_password) <= PASSWORD_MAX:
            return False
        admin.username = new_username
        admin.password_hash = hash_pin(new_password)
        self.setup_completed = True
        self.save_accounts()
        return True

    def public_accounts(self) -> list[dict[str, Any]]:
        """下发到前端的账户列表（不含密码哈希）；按创建时间排序。"""
        return [account.public() for account in sorted(self.accounts, key=lambda a: a.created_at)]

    def save(self) -> None:
        self._save(self.settings)

    def _load_layout(self) -> dict[str, Any]:
        if not self.layout_path.exists():
            return clean_layout({})
        try:
            return clean_layout(json.loads(self.layout_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            return clean_layout({})

    def save_layout(self, layout: dict[str, Any]) -> None:
        self.layout = clean_layout(layout)
        _write_private(self.layout_path, json.dumps(self.layout, ensure_ascii=False, indent=2) + "\n")

    def _load_custom(self) -> dict[str, Any]:
        if not self.custom_path.exists():
            return clean_custom({})
        try:
            return clean_custom(json.loads(self.custom_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            return clean_custom({})

    def save_custom(self, custom: dict[str, Any]) -> None:
        self.custom = custom
        _write_private(self.custom_path, json.dumps(custom, ensure_ascii=False, indent=2) + "\n")

    def _decrypt(self, value: str) -> str:
        if not value:
            return ""
        try:
            return self.fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            # 加密密钥更换后旧值无法解密，按未设置处理，需重新填写。
            return ""

    def _encrypt(self, value: str) -> str:
        return self.fernet.encrypt(value.encode()).decode() if value else ""

    def token(self) -> str:
        return self._decrypt(self.settings.token_encrypted)

    def set_token(self, token: str) -> None:
        self.settings.token_encrypted = self._encrypt(token)

    def audit(self, event: str, ip: str, username: str = "", **detail: Any) -> None:
        """审计日志：username 记录是哪个账户操作；service_call 即“操控设备记录”。"""
        entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, "ip": ip, "user": username, **detail}
        if self.audit_path.exists() and self.audit_path.stat().st_size > AUDIT_MAX_BYTES:
            os.replace(self.audit_path, self.audit_path.with_suffix(".log.1"))
        fd = os.open(self.audit_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def recent_audit(self, limit: int = 50, event: str | None = None) -> list[dict[str, Any]]:
        """读取审计日志。event 不为 None 时只返回该类型（如 service_call 只看设备操控记录）。"""
        if not self.audit_path.exists():
            return []
        lines = self.audit_path.read_text(encoding="utf-8").splitlines()
        entries: list[dict[str, Any]] = []
        for line in reversed(lines):
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event is not None and item.get("event") != event:
                continue
            entries.append(item)
            if len(entries) >= limit:
                break
        return entries
