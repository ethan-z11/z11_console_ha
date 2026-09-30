"""会话与登录限流。

会话通过 sessions.json 持久化，重启后浏览器复用 Cookie 免重新登录（默认 30 天）；
服务侧仍然校验 Cookie 有效性，登出（/api/admin/logout）即从 sessions.json 中移除该 token。
"""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

SESSION_IDLE_SECONDS = 10 * 60
REMEMBER_SECONDS = 30 * 24 * 60 * 60  # 记住登录：30 天
FREE_ATTEMPTS = 5
BASE_LOCK_SECONDS = 60
MAX_LOCK_SECONDS = 15 * 60


def _write_private(path: Path, text: str) -> None:
    """原子写入并限制为仅属主可读写。"""
    import os
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temp, path)


class Sessions:
    """会话存储：token → {expires_at, username, is_admin, remember}。

    持久化到 sessions.json；登录时调用 create() 拿 token 写入 Cookie，
    每次请求 touch() 校验有效性。登出 revoke() 移除单个 token。
    """

    def __init__(self, persist_path: Path | None = None) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}
        self._persist_path = persist_path
        self._load()

    def _load(self) -> None:
        if not self._persist_path or not self._persist_path.exists():
            return
        try:
            raw = json.loads(self._persist_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        if not isinstance(raw, dict):
            return
        now = time.time()
        for token, info in raw.items():
            if not isinstance(info, dict):
                continue
            expires_at = info.get("expires_at", 0)
            if not isinstance(expires_at, (int, float)) or expires_at < now:
                continue
            self._sessions[token] = {
                "expires_at": expires_at,
                "username": str(info.get("username", "")),
                "isAdmin": bool(info.get("isAdmin", False)),
                "remember": bool(info.get("remember", True)),
            }
        # 加载完顺便清理掉过期的，避免文件无限增长。
        self._persist()

    def _persist(self) -> None:
        if not self._persist_path:
            return
        try:
            payload = {token: info for token, info in self._sessions.items()}
            _write_private(self._persist_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        except OSError:
            pass

    def create(self, username: str, is_admin: bool, remember: bool = True) -> str:
        session_id = secrets.token_urlsafe(32)
        ttl = REMEMBER_SECONDS if remember else SESSION_IDLE_SECONDS
        self._sessions[session_id] = {
            "expires_at": time.time() + ttl,
            "username": username,
            "isAdmin": is_admin,
            "remember": remember,
        }
        self._persist()
        return session_id

    def get(self, session_id: str | None) -> dict[str, Any] | None:
        """返回会话信息 {username, isAdmin, remember}；过期或不存在返回 None。"""
        if not session_id:
            return None
        info = self._sessions.get(session_id)
        if not info:
            return None
        now = time.time()
        if info["expires_at"] < now:
            self._sessions.pop(session_id, None)
            self._persist()
            return None
        return {"username": info["username"], "isAdmin": info["isAdmin"], "remember": info["remember"]}

    def touch(self, session_id: str | None) -> bool:
        """仅校验有效性；记住登录的会话不再顺延，到期需重新登录。"""
        return self.get(session_id) is not None

    def revoke(self, session_id: str | None) -> None:
        if session_id:
            self._sessions.pop(session_id, None)
            self._persist()

    def revoke_all(self) -> None:
        self._sessions.clear()
        self._persist()

    def revoke_user(self, username: str) -> None:
        """账户被删除或改密码时，吊销该账户的所有会话。"""
        self._sessions = {t: i for t, i in self._sessions.items() if i["username"] != username}
        self._persist()


class LoginLimiter:
    """登录限流：连续输错 5 次后锁定，锁定时间逐次翻倍，最长 15 分钟。"""

    def __init__(self) -> None:
        self.failures = 0
        self.locked_until = 0.0

    def retry_after(self) -> int:
        return max(0, int(self.locked_until - time.monotonic() + 0.999))

    def record_failure(self) -> int:
        """返回锁定秒数；未锁定时为 0。"""
        self.failures += 1
        if self.failures < FREE_ATTEMPTS:
            return 0
        seconds = min(MAX_LOCK_SECONDS, BASE_LOCK_SECONDS * 2 ** (self.failures - FREE_ATTEMPTS))
        self.locked_until = time.monotonic() + seconds
        return seconds

    def remaining_attempts(self) -> int:
        return max(0, FREE_ATTEMPTS - self.failures)

    def record_success(self) -> None:
        self.failures = 0
        self.locked_until = 0.0
