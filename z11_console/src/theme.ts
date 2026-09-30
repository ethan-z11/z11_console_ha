/** 主题：浅色 / 深色 / 自动（日出到日落浅色，其余深色）。设置为全局（设置 → 显示），实际主题按本屏的天气与时间计算。 */
import type { Forecast } from './weather';

export type ThemeMode = 'dark' | 'light' | 'auto';
export type Theme = 'dark' | 'light';

const cacheKey = 'hass-home-console-theme-v1';
const themeColors: Record<Theme, string> = { dark: '#0d0f11', light: '#f2f1ed' };
export const DEFAULT_SUNRISE = '06:00';
export const DEFAULT_SUNSET = '18:00';

function minutesOf(time: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 当天日出、日落：取天气预报中今天的数据；没有天气（未配置或未获取到）时按 06:00 与 18:00。 */
export function daylight(forecast: Forecast | null, now: Date): { sunrise: string; sunset: string } {
  const today = forecast?.daily.find((day) => day.fxDate === localDate(now));
  const sunrise = minutesOf(today?.sunrise) !== null ? today!.sunrise : DEFAULT_SUNRISE;
  const sunset = minutesOf(today?.sunset) !== null ? today!.sunset : DEFAULT_SUNSET;
  return { sunrise, sunset };
}

export function resolveTheme(mode: ThemeMode, now: Date, forecast: Forecast | null): Theme {
  if (mode !== 'auto') return mode;
  const { sunrise, sunset } = daylight(forecast, now);
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= minutesOf(sunrise)! && current < minutesOf(sunset)! ? 'light' : 'dark';
}

/** 应用到页面并记住，下次打开时在连接服务之前先用上次的主题，避免闪烁。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
  try {
    localStorage.setItem(cacheKey, theme);
  } catch {
    // 浏览器禁用存储时只影响下次打开的首帧。
  }
}

export function cachedTheme(): Theme {
  try {
    return localStorage.getItem(cacheKey) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 强调色（设置 → 显示）：选中态、主按钮、导航高亮等使用；灯光光晕、亮度条、冷暖色、告警色按含义保持不变。 */
export const ACCENTS = [
  { value: 'amber', label: '琥珀', swatch: '#f4b764' },
  { value: 'coral', label: '珊瑚', swatch: '#ff8f73' },
  { value: 'rose', label: '玫瑰', swatch: '#f47fa6' },
  { value: 'violet', label: '紫罗兰', swatch: '#a894ff' },
  { value: 'sky', label: '天蓝', swatch: '#6fb8ff' },
  { value: 'teal', label: '青绿', swatch: '#4fd1c1' },
  { value: 'green', label: '草绿', swatch: '#7fd67a' },
] as const;
export type Accent = (typeof ACCENTS)[number]['value'];

const accentCacheKey = 'hass-home-console-accent-v1';

function isAccent(value: unknown): value is Accent {
  return ACCENTS.some((item) => item.value === value);
}

/** 写到根元素的 data-accent（琥珀为默认，不写属性），并记住给下次打开的首帧用。 */
export function applyAccent(accent: Accent): void {
  if (accent === 'amber') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
  try {
    localStorage.setItem(accentCacheKey, accent);
  } catch {
    // 浏览器禁用存储时只影响下次打开的首帧。
  }
}

export function cachedAccent(): Accent {
  try {
    const value = localStorage.getItem(accentCacheKey);
    return isAccent(value) ? value : 'amber';
  } catch {
    return 'amber';
  }
}
