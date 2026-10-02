/** 内置中国老黄历：由后端 /api/almanac 按中国时区计算，不依赖 HA 实体。 */
import { request } from './consoleApi';

export interface AlmanacFlyPosition {
  /** 方位名：中宫/正东… */
  place: string;
  /** 八卦名（中宫为空）。 */
  gua: string;
  number: string;
  color: string;
  star: string;
}

export interface AlmanacTwoHour {
  /** 子时…亥时。 */
  label: string;
  /** 时段 "23-01"。 */
  range: string;
  /** 吉 / 凶。 */
  value: string;
}

export interface AlmanacMoon {
  /** 月相名：朔月/峨眉月/上弦月/渐盈凸月/满月/渐亏凸月/下弦月/残月。 */
  phase: string;
  /** 月龄（天，字符串）。 */
  age: string;
  /** 月亮照亮度百分比。 */
  illumination: string;
  /** 夜月别称。 */
  nightMoon: string;
  yinYang: string;
  wuxing: string;
  luck: string;
}

export interface Almanac {
  solarDate: string;
  /** 首页副标题：丙午(马)年 八月小廿二 */
  text: string;
  yearGanZhi: string;
  zodiac: string;
  lunarMonthCn: string;
  lunarDayCn: string;
  weekday: string;
  isoWeek: number;
  season: string;
  holiday: string;
  /** 四柱：年、月、日、时干支。 */
  bazi: string[];
  nayin: string;
  term: string;
  nextTerm: string;
  nextTermDate: string;
  zodiacClash: string;
  starZodiac: string;
  eastZodiac: string;
  level: string;
  good: string[];
  bad: string[];
  pengTaboo: string[];
  officers12: string;
  stars28: string;
  trines: string[];
  sixPair: string;
  flyCenter: string;
  flyPositions: AlmanacFlyPosition[];
  luckyDirections: string[];
  fetalGod: string;
  goodGods: string[];
  badGods: string[];
  shichen: string;
  meridian: string;
  sixYao: string;
  dayLu: string;
  animal36: string;
  gua64: string;
  twohourLuck: AlmanacTwoHour[];
  moon: AlmanacMoon;
}

export const getAlmanac = () => request<Almanac>('/api/almanac');
