"""内置中国老黄历（农历）：基于 vendored cnlunar 0.2.4（MIT）计算，不依赖 HA 实体。

数据与口径对齐 HA 自定义组件「中国老黄历」（tgtg/almanac_sensor.py、moon.py）：
- 农历年月日、干支八字、节气、宜忌、彭祖百忌、十二神、廿八宿、九宫飞星等来自 cnlunar；
- 月相（月龄/相位/照亮度/夜月/阴阳五行吉凶）为天文公式，仅用标准库。

所有时间均按中国时区（UTC+8）计算，与部署机器的时区无关。
"""

from __future__ import annotations

import math
import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from ._vendor import cnlunar

CHINA_TZ = timezone(timedelta(hours=8))

SHICHEN = ('子时', '丑时', '寅时', '卯时', '辰时', '巳时', '午时', '未时', '申时', '酉时', '戌时', '亥时')
TIME_RANGES = ('23-01', '01-03', '03-05', '05-07', '07-09', '09-11', '11-13',
               '13-15', '15-17', '17-19', '19-21', '21-23')
MARKS = ('初', '一', '二', '三', '四', '五', '六', '七')

MERIDIANS = ['足少阳胆', '足厥阴肝', '手太阴肺', '手阳明大肠', '足阳明胃', '足太阴脾',
             '手少阴心', '手太阳小肠', '足太阳膀胱', '足少阴肾', '手厥阴心包', '手少阳三焦']

# 六十四卦表（源自 tgtg 插件）：年、月索引 + 日索引求本卦/变卦。
BASE_GUA = (
    ("坤卦", "艮卦", "坎卦", "巽卦", "震卦", "离卦", "兑卦", "乾卦"),
    ("剥卦", "艮卦", "蹇卦", "渐卦", "小过卦", "旅卦", "咸卦", "遁卦"),
    ("比卦", "蒙卦", "坎卦", "节卦", "屯卦", "既济卦", "革卦", "需卦"),
    ("观卦", "渐卦", "节卦", "巽卦", "益卦", "家人卦", "涣卦", "姤卦"),
    ("豫卦", "小过卦", "屯卦", "益卦", "震卦", "丰卦", "归妹卦", "大壮卦"),
    ("晋卦", "旅卦", "既济卦", "家人卦", "丰卦", "离卦", "睽卦", "同人卦"),
    ("萃卦", "咸卦", "革卦", "涣卦", "归妹卦", "睽卦", "兑卦", "夬卦"),
    ("否卦", "遁卦", "需卦", "姤卦", "大壮卦", "同人卦", "夬卦", "乾卦"),
)

# 月相阈值（月龄）→ 名称。
PHASE_THRESHOLDS = (
    (0.5, '朔月'), (6.5, '峨眉月'), (7.5, '上弦月'), (13.5, '渐盈凸月'),
    (14.5, '满月'), (20.5, '渐亏凸月'), (21.5, '下弦月'), (27.5, '残月'),
    (float('inf'), '朔月'),
)

_FILTERS = {'上表章', '上册', '颁诏', '修置产室', '举正直', '选将', '宣政事', '冠带', '上官', '临政',
            '竖柱上梁', '修仓库', '营建', '穿井', '伐木', '畋猎', '招贤', '酝酿', '乘船渡水', '解除',
            '缮城郭', '筑堤防', '修宫室', '安碓硙', '纳采', '针刺', '开渠', '平治道涂', '裁制',
            '修饰垣墙', '塞穴', '庆赐', '破屋坏垣', '鼓铸', '启攒', '开仓', '纳畜', '牧养', '经络',
            '安抚边境', '布政事', '覃恩', '雪冤', '出师'}
_SPLIT_PATTERN = re.compile(r'\[.*?\]|[,;，；]')
_ZODIAC_CHARS = set('鼠牛虎兔龙蛇马羊猴鸡狗猪' + '建除满平定执破危成收开闭')


def _clean_list(value: Any) -> list[str]:
    """清洗 cnlunar 的宜忌/神煞列表：去标记、去重、过滤生僻官方事项。"""
    if isinstance(value, (list, tuple)):
        words: list[str] = []
        for item in value:
            words.extend(_SPLIT_PATTERN.sub(' ', str(item)).split())
    else:
        text = re.sub(r'黄道|黑道|日|-|、', '', str(value))
        words = _SPLIT_PATTERN.sub(' ', text).split()
    result: list[str] = []
    for word in words:
        if (len(word) > 1 or word in _ZODIAC_CHARS) and word not in _FILTERS and word not in result:
            result.append(word)
    return result


def _clean_text(value: Any, limit: int = 10) -> str:
    return ' '.join(_clean_list(value)[:limit])


def _shichen(hour: int, minute: int) -> str:
    """当前时辰与刻：午时三刻 形式。"""
    if hour == 23:
        idx = 0
        start_hour = 23
    else:
        idx = (hour + 1) // 2 % 12
        start_hour = (hour // 2) * 2 + 1
    k = ((hour - start_hour) * 60 + minute) // 15
    return f"{SHICHEN[idx]}{'初' if k == 0 else MARKS[min(7, k)]}刻"


def _twohour_index(hour: int) -> int:
    return 11 if hour == 23 else ((hour + 1) // 2) % 12


def _solar_terms(terms_dic: dict[str, tuple[int, int]], month: int, day: int) -> tuple[str, str, str]:
    """返回（当前节气，下一节气，下一节气日期）。"""
    terms = sorted(terms_dic.items(), key=lambda item: (item[1][0], item[1][1]))
    for i, (term, (m, d)) in enumerate(terms):
        if i == len(terms) - 1 and (m < month or (m == month and d <= day)):
            nxt = terms[0]
            return term, nxt[0], f"{nxt[1][0]}月{nxt[1][1]}日"
        if ((m < month) or (m == month and d <= day)) and \
           ((terms[i + 1][1][0] > month) or
                (terms[i + 1][1][0] == month and terms[i + 1][1][1] > day)):
            nxt = terms[i + 1]
            return term, nxt[0], f"{nxt[1][0]}月{nxt[1][1]}日"
        if i == 0 and (m > month or (m == month and d > day)):
            return terms[-1][0], term, f"{m}月{d}日"
    return '', '', ''


def _day_lu(stem: str, branch: str) -> str:
    bl = {'甲': '寅', '乙': '卯', '丙': '巳', '戊': '巳', '丁': '午', '己': '午',
          '庚': '申', '辛': '酉', '壬': '亥', '癸': '子'}
    sg = {'甲': ('寅', '卯'), '乙': ('卯', '辰'), '丙': ('巳', '午'), '戊': ('巳', '午'),
          '丁': ('午', '未'), '己': ('午', '未'), '庚': ('申', '酉'), '辛': ('酉', '戌'),
          '壬': ('亥', '子'), '癸': ('子', '丑')}
    luck_pos = bl.get(stem, '')
    if branch == luck_pos:
        return f"{branch}命进禄"
    if branch in sg.get(stem, ()):
        return f"{branch}命互禄"
    return f"{stem}命进{luck_pos}禄"


def _animal36(stem: str, branch: str) -> str:
    animals = {
        "子": ["貔貅", "天鼠", "天貂"], "丑": ["獬豸", "天牛", "蛟龙"], "寅": ["天马", "天虎", "天狗"],
        "卯": ["天兔", "天狐", "天獐"], "辰": ["螭吻", "天龙", "天麟"], "巳": ["天蛇", "天蜥", "天鳖"],
        "午": ["天马", "天驴", "天鹿"], "未": ["天羊", "天鸟", "天獝"], "申": ["猴王", "天猴", "天猿"],
        "酉": ["天鸡", "天燕", "天乌"], "戌": ["天狗", "天狼", "山犭"], "亥": ["天猪", "天豕", "天彘"],
    }
    stems = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]
    return animals[branch][stems.index(stem) % 3] if branch in animals and stem in stems else '未知'


def _gua64(year: int, month: int, day: int) -> str:
    y, m, d = max(1, abs(year)), max(1, min(12, abs(month))), max(1, abs(day))
    d_idx = ((d - 1) % 6) + 1
    y_idx = (y - 1) % 8
    m_idx = (m - 1) % 8
    yao_up = d_idx > 3
    change_y = (y_idx + (d_idx - 1)) % 8 if not yao_up else y_idx
    change_m = (m_idx + (d_idx - 1)) % 8 if yao_up else m_idx
    return f"{BASE_GUA[y_idx][m_idx]}=>{BASE_GUA[change_y][change_m]}"


def _cn_number(n: int) -> str:
    nums = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    if 1 <= n <= 10:
        return nums[n - 1]
    if 11 <= n <= 19:
        return f"十{_cn_number(n - 10)}"
    if n == 20:
        return '二十'
    return f"二十{_cn_number(n - 20)}"


def _night_moon_name(day: int) -> str:
    special = {15: '望月', 16: '既望月', 17: '立待月', 18: '居待月', 19: '寝待月', 30: '晦月'}
    return special.get(day, f"{_cn_number(day)}夜月")


def _moon_wuxing(day: int) -> str:
    return next(e for t, e in [(6, '水'), (11, '木'), (16, '火'), (22, '金'), (float('inf'), '土')] if day <= t)


def _moon_luck(day: int) -> str:
    luck_days = {
        '大吉': [1, 3, 8, 11, 15, 16, 23, 28],
        '吉': [2, 7, 13, 18, 22, 27, 29, 30],
        '平': [5, 9, 10, 14, 20, 24, 25],
        '凶': [4, 6, 12, 17, 19, 21, 26],
    }
    return next((luck for luck, days in luck_days.items() if day in days), '平')


def _moon(now: datetime, lunar_day: int) -> dict[str, Any]:
    """月相：月龄、相位、照亮度（与 tgtg/moon.py 同公式）。"""
    y, m = now.year, now.month
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    jd = int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + now.day + b - 1524.5 \
        + (now.hour + now.minute / 60 + now.second / 3600) / 24
    t = (jd - 2451545.0) / 36525
    d_deg = 297.8501921 + 445267.1114034 * t  # 月日平距角
    moon_age = (jd - 2451550.1) % 29.530588853
    # 与插件一致：i = acos(cos(D))，k=(1+cos(i))/2（角度制混用但保持结果一致）。
    i = math.degrees(math.acos(math.cos(math.radians(d_deg))))
    k = (1 + math.cos(math.radians(i))) / 2
    phase = next(name for threshold, name in PHASE_THRESHOLDS if moon_age < threshold)
    return {
        "phase": phase,
        "age": f"{moon_age:.1f}",
        "illumination": f"{k * 100:.1f}",
        "nightMoon": _night_moon_name(lunar_day),
        "yinYang": '阴' if lunar_day > 15 else '阳',
        "wuxing": _moon_wuxing(lunar_day),
        "luck": _moon_luck(lunar_day),
    }


class Almanac:
    """按中国时辰缓存当日黄历（时辰切换时自动重算）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache_key = ''
        self._cache: dict[str, Any] = {}

    def payload(self, moment: datetime | None = None) -> dict[str, Any]:
        now = (moment or datetime.now(CHINA_TZ)).astimezone(CHINA_TZ)
        key = f"{now:%Y-%m-%d}_{_twohour_index(now.hour)}"
        with self._lock:
            if key == self._cache_key:
                return self._cache
            self._cache = self._build(now)
            self._cache_key = key
            return self._cache

    def _build(self, now: datetime) -> dict[str, Any]:
        lunar = cnlunar.Lunar(now.replace(tzinfo=None), godType='8char')
        term, next_term, next_date = _solar_terms(lunar.thisYearSolarTermsDic, now.month, now.day)
        lucky_values = lunar.get_twohourLuckyList()
        twohour = [{"label": SHICHEN[i], "range": TIME_RANGES[i], "value": lucky_values[i]}
                   for i in range(12)]
        holiday = _clean_text(''.join(lunar.get_legalHolidays() + lunar.get_otherHolidays()
                                      + lunar.get_otherLunarHolidays())) or '暂无节日'
        fly_numbers = _clean_text(lunar.get_the9FlyStar()).replace(' ', '')
        gods = {'1': '贪狼星', '2': '巨门星', '3': '禄存星', '4': '文曲星', '5': '廉贞星',
                '6': '武曲星', '7': '破军星', '8': '左辅星', '9': '右弼星'}
        star_names = {'1': '一白', '2': '二黑', '3': '三碧', '4': '四绿', '5': '五黄',
                      '6': '六白', '7': '七赤', '8': '八白', '9': '九紫'}
        center = fly_numbers[5] if len(fly_numbers) == 9 else '5'
        fly_positions: list[dict[str, str]] = []
        if fly_numbers.isdigit() and len(fly_numbers) == 9:
            places = ('西北', '正北', '东北', '正西', '中宫', '正东', '西南', '正南', '东南')
            gua = ('乾', '坎', '艮', '兑', '', '震', '坤', '离', '巽')
            colors = {'1': '白', '2': '黑', '3': '碧', '4': '绿', '5': '黄',
                      '6': '白', '7': '赤', '8': '白', '9': '紫'}
            for place, gua_name, num in zip(places, gua, fly_numbers):
                fly_positions.append({"place": place, "gua": gua_name, "number": num,
                                      "color": colors.get(num, ''), "star": star_names.get(num, '')})
        stem, branch = lunar.day8Char[0], lunar.day8Char[1]
        six_idx = (lunar.lunarMonth + lunar.lunarDay) % 6
        six_yao = ("大安", "赤口", "先胜", "友引", "先负", "空亡")[six_idx]
        return {
            "solarDate": now.strftime('%Y-%m-%d'),
            # 首页副标题与 HA 版老黄历主传感器一致：丙午(马)年 八月小廿二
            "text": f"{lunar.year8Char}({lunar.chineseYearZodiac})年 {lunar.lunarMonthCn}{lunar.lunarDayCn}",
            "yearGanZhi": lunar.year8Char,
            "zodiac": lunar.chineseYearZodiac,
            "lunarMonthCn": lunar.lunarMonthCn,
            "lunarDayCn": lunar.lunarDayCn,
            "weekday": lunar.weekDayCn,
            "isoWeek": now.isocalendar()[1],
            "season": lunar.lunarSeason,
            "holiday": holiday,
            "bazi": [lunar.year8Char, lunar.month8Char, lunar.day8Char, lunar.twohour8Char],
            "nayin": lunar.get_nayin(),
            "term": term,
            "nextTerm": next_term,
            "nextTermDate": next_date,
            "zodiacClash": lunar.chineseZodiacClash,
            "starZodiac": lunar.starZodiac,
            "eastZodiac": lunar.todayEastZodiac,
            "level": lunar.todayLevelName,
            "good": _clean_list(lunar.goodThing),
            "bad": _clean_list(lunar.badThing),
            "pengTaboo": _clean_list(lunar.get_pengTaboo(long=4, delimit=' ')),
            "officers12": ' '.join(_clean_list(lunar.get_today12DayOfficer())),
            "stars28": _clean_text(lunar.get_the28Stars()),
            "trines": _clean_list(lunar.zodiacMark3List),
            "sixPair": lunar.zodiacMark6,
            "flyCenter": f"{gods.get(center, '')} {star_names.get(center, '')}".strip(),
            "flyPositions": fly_positions,
            "luckyDirections": [str(item) for item in lunar.get_luckyGodsDirection()],
            "fetalGod": lunar.get_fetalGod(),
            "goodGods": _clean_list(lunar.goodGodName),
            "badGods": _clean_list(lunar.badGodName),
            "shichen": _shichen(now.hour, now.minute),
            "meridian": MERIDIANS[_twohour_index(now.hour)],
            "sixYao": six_yao,
            "dayLu": _day_lu(stem, branch),
            "animal36": _animal36(stem, branch),
            "gua64": _gua64(now.year, now.month, now.day),
            "twohourLuck": twohour,
            "moon": _moon(now, lunar.lunarDay),
        }
