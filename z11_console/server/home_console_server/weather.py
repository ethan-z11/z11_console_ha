"""中国天气网（weather.com.cn）天气代理：无需 API Key，直接抓取公开接口。

接口来自开源集成 hasscc/tianqi，仅依赖 Referer + 浏览器 UA 即可访问：
- 城市搜索：toy1.weather.com.cn/search?cityname=...
- 实况与指数：d1.weather.com.cn/weather_index/{areaid}.html?_=时间戳  （页面内含 var dataSK / var fc 等 JS 变量）
- 逐日预报：d1.weather.com.cn/weixinfc/{areaid}.html?_=时间戳
- 站点坐标：d7.weather.com.cn/geong/v1/api?params={"method":"stationinfo","areaid":...}

返回结构沿用数字天气图标代码（now.icon 等），前端 weatherIcon() 按此映射；
把天气网的两位图标代码映射到数字代码表，缺失字段用空串占位。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import aiohttp

WEATHER_HOST = "d1.weather.com.cn"
SEARCH_HOST = "toy1.weather.com.cn"
WEATHER_TTL = 600          # 实况 + 预报缓存 10 分钟
GEO_TTL = 86_400           # 城市搜索缓存 1 天
CACHE_LIMIT = 500

HTTP_HEADERS = {
    "Referer": "https://m.weather.com.cn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
}

LOCATION_ID = re.compile(r"^\d{6,12}$")        # 天气网城市 ID，如 101010100
COORDINATES = re.compile(r"^-?\d{1,3}(\.\d{1,6})?,-?\d{1,2}(\.\d{1,6})?$")

# 天气网两位图标代码 → 数字图标代码（前端 weatherIcon 按此表映射）
ICON_MAP = {
    "00": "100", "01": "101", "02": "104", "03": "300", "04": "302", "05": "313",
    "06": "401", "07": "305", "08": "306", "09": "307", "10": "308", "11": "309",
    "12": "310", "13": "407", "14": "400", "15": "401", "16": "402", "17": "403",
    "18": "501", "19": "312", "20": "504", "21": "305", "22": "306", "23": "307",
    "24": "308", "25": "309", "26": "400", "27": "401", "28": "402", "29": "502",
    "30": "503", "31": "504", "32": "504", "53": "502",
}

NOW_FIELDS = ("obsTime", "temp", "feelsLike", "icon", "text", "windDir", "windScale",
              "windSpeed", "humidity", "precip", "pressure", "vis")
DAILY_FIELDS = ("fxDate", "tempMax", "tempMin", "iconDay", "textDay", "iconNight",
                "textNight", "windDirDay", "windScaleDay", "precip", "humidity",
                "uvIndex", "sunrise", "sunset")


class WeatherError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def valid_location(value: str) -> bool:
    return bool(LOCATION_ID.match(value) or COORDINATES.match(value))


def _to_icon_code(code: str) -> str:
    """天气网图标代码（'d01' / '01'）→ 数字图标代码；查不到时返回 '104'（阴）兜底。"""
    digits = re.sub(r"^[dn]", "", code or "")
    return ICON_MAP.get(digits, "104")


def _parse_var(text: str, name: str) -> Any:
    """从 JS 页面里取出 var name = ...; 的 JSON 值（支持花括号/方括号嵌套）。"""
    marker = f"var {name}"
    start = text.find(marker)
    if start < 0:
        return None
    eq = text.find("=", start)
    if eq < 0:
        return None
    # 跳过空白，找第一个 { 或 [
    idx = eq + 1
    while idx < len(text) and text[idx] in " \t\r\n":
        idx += 1
    if idx >= len(text) or text[idx] not in "{[":
        return None
    open_ch = text[idx]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_string = False
    escape = False
    end = idx
    for i in range(idx, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    else:
        return None
    try:
        return json.loads(text[idx:end])
    except json.JSONDecodeError:
        return None


class Weather:
    """中国天气网代理；无需密钥。"""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str, tuple[tuple[str, str], ...]], tuple[float, dict[str, Any]]] = {}
        self._session: aiohttp.ClientSession | None = None

    def reset(self) -> None:
        self._cache.clear()

    async def close(self) -> None:
        if self._session:
            await self._session.close()

    async def _get_text(self, host: str, path: str, params: dict[str, str], ttl: int) -> str:
        cache_key = (host, path, tuple(sorted(params.items())))
        cached = self._cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return cached[1]  # type: ignore[return-value]
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10), trust_env=True)
        try:
            async with self._session.get(f"http://{host}{path}", params=params, headers=HTTP_HEADERS) as response:
                raw = await response.read()
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise WeatherError(f"无法连接中国天气网：{error.__class__.__name__}") from error
        if response.status >= 400:
            raise WeatherError(f"中国天气网返回 HTTP {response.status}", 502)
        # 天气网接口混合 UTF-8 / GBK，优先按响应声明解码，失败时用 GBK 兜底。
        charset = response.charset or "utf-8"
        try:
            text = raw.decode(charset)
        except (UnicodeDecodeError, LookupError):
            text = raw.decode("gbk", errors="replace")
        if len(self._cache) >= CACHE_LIMIT:
            now = time.monotonic()
            self._cache = {key: value for key, value in self._cache.items() if value[0] > now}
        self._cache[cache_key] = (time.monotonic() + ttl, text)
        return text

    async def search(self, query: str) -> list[dict[str, Any]]:
        text = await self._get_text(SEARCH_HOST, "/search", {"cityname": query}, GEO_TTL)
        # 返回形如 ([{"ref":"101010100~beijing~北京~Beijing~...~北京"}, ...])
        match = re.search(r"\[(.*)\]", text, re.S)
        places: list[dict[str, Any]] = []
        if not match:
            return places
        try:
            items = json.loads(f"[{match.group(1)}]")
        except json.JSONDecodeError:
            return places
        for item in items:
            ref = str(item.get("ref", ""))
            parts = ref.split("~")
            if len(parts) < 4 or not parts[0]:
                continue
            places.append({
                "id": parts[0],
                "name": parts[2],
                "adm2": parts[2] if len(parts) > 9 else "",
                "adm1": parts[9] if len(parts) > 9 else (parts[5] if len(parts) > 5 else ""),
                "country": "中国",
                "lat": 0.0,
                "lon": 0.0,
            })
        return places

    async def place_at(self, lon: float, lat: float) -> dict[str, Any]:
        # 天气网公开接口不支持按坐标反查城市；提示用户改用城市搜索。
        raise WeatherError("中国天气网暂不支持坐标定位，请在搜索框输入城市名选择", 404)

    async def forecast(self, location: str) -> dict[str, Any]:
        timestamp = str(int(time.time() * 1000))
        index_text = await self._get_text(
            WEATHER_HOST, f"/weather_index/{location}.html", {"_": timestamp}, WEATHER_TTL)
        fc_text = await self._get_text(
            WEATHER_HOST, f"/weixinfc/{location}.html", {"_": timestamp}, WEATHER_TTL)

        sk = _parse_var(index_text, "dataSK") or {}
        fc = _parse_var(fc_text, "fc") or {}
        daily_raw = fc.get("f") or []

        now_icon = _to_icon_code(str(sk.get("weathercode", "")))
        now = {
            "obsTime": f"{time.strftime('%Y-%m-%d')}T{sk.get('time', '00:00')}+08:00",
            "temp": str(sk.get("temp", "")),
            "feelsLike": "",
            "icon": now_icon,
            "text": str(sk.get("weather", "")),
            "windDir": str(sk.get("WD", "")),
            "windScale": str(sk.get("WS", "")),
            "windSpeed": str(sk.get("wse", "")),
            "humidity": str(sk.get("SD", "")).rstrip("%"),
            "precip": str(sk.get("rain", "")),
            "pressure": str(sk.get("qy", "")),
            "vis": str(sk.get("njd", "")).rstrip("km").strip(),
        }
        # 实况页里的 fc（若有）通常只含今天；优先用 weixinfc 的完整逐日数组。
        daily: list[dict[str, Any]] = []
        year = time.strftime("%Y")
        for day in daily_raw[:7]:
            date_md = str(day.get("fi", ""))       # "9/29"
            fx_date = ""
            if "/" in date_md:
                m, d = date_md.split("/", 1)
                fx_date = f"{year}-{int(m):02d}-{int(d):02d}"
            daily.append({
                "fxDate": fx_date,
                "tempMax": str(day.get("fc", "")),
                "tempMin": str(day.get("fd", "")),
                "iconDay": _to_icon_code(str(day.get("fa", ""))),
                "textDay": "",
                "iconNight": _to_icon_code(str(day.get("fb", ""))),
                "textNight": "",
                "windDirDay": str(day.get("fe", "")),
                "windScaleDay": str(day.get("fg", "")),
                "precip": "",
                "humidity": str(day.get("fm", "")),
                "uvIndex": str(day.get("fk", "")),
                "sunrise": "",
                "sunset": "",
            })

        return {
            "updateTime": now["obsTime"],
            "fxLink": f"http://www.weather.com.cn/weather/{location}.shtml",
            "now": {key: now.get(key, "") for key in NOW_FIELDS},
            "daily": [{key: day.get(key, "") for key in DAILY_FIELDS} for day in daily],
        }
