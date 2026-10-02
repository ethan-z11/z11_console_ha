/** 天气：经控制台服务 /api/weather* 代理中国天气网数据，以及天气代码 → 图标、日期文字等展示辅助。 */
import { CloudDrizzle, CloudFog, CloudHail, CloudLightning, CloudMoon, CloudMoonRain, CloudRain, CloudRainWind, CloudSnow, CloudSun, CloudSunRain, Cloud, Haze, Moon, Sun, ThermometerSnowflake, ThermometerSun, Wind } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { request } from './consoleApi';
import type { WeatherPlace } from './consoleClient';

export type { WeatherPlace };

export interface WeatherNow {
  obsTime: string;
  temp: string;
  feelsLike: string;
  icon: string;
  text: string;
  windDir: string;
  windScale: string;
  windSpeed: string;
  humidity: string;
  precip: string;
  pressure: string;
  vis: string;
}

export interface WeatherDay {
  fxDate: string;
  tempMax: string;
  tempMin: string;
  iconDay: string;
  textDay: string;
  iconNight: string;
  textNight: string;
  windDirDay: string;
  windScaleDay: string;
  precip: string;
  humidity: string;
  uvIndex: string;
  sunrise: string;
  sunset: string;
}

export interface Forecast {
  updateTime: string;
  fxLink: string;
  now: WeatherNow;
  daily: WeatherDay[];
}

export const searchPlaces = (query: string) =>
  request<{ places: WeatherPlace[] }>(`/api/weather/search?q=${encodeURIComponent(query)}`).then((data) => data.places);
export const placeAt = (lon: number, lat: number) =>
  request<{ place: WeatherPlace }>(`/api/weather/place?lon=${lon}&lat=${lat}`).then((data) => data.place);
export const homePlace = () => request<{ place: WeatherPlace }>('/api/weather/place?home=1').then((data) => data.place);
export const getForecast = (place: WeatherPlace) => request<Forecast>(`/api/weather?location=${encodeURIComponent(place.id)}`);
/** 把天气地区保存到服务端，全屋所有屏幕共用（WS status 会即时广播）。 */
export const saveSharedPlace = (place: WeatherPlace) =>
  request<{ ok: boolean; place: WeatherPlace }>('/api/weather/place', 'POST', { place }).then((data) => data.place);

/** 地名的补充说明：省、市，重复或与地名相同的省略。 */
export function placeDetail(place: WeatherPlace): string {
  return [place.adm2, place.adm1].filter((part, index, parts) => part && part !== place.name && parts.indexOf(part) === index).join(' · ');
}

// ---------- 当前位置：每块屏幕各自记住 ----------

const placeKey = 'hass-home-console-weather-place-v1';

export function readPlace(): WeatherPlace | null {
  try {
    const raw = JSON.parse(localStorage.getItem(placeKey) ?? 'null') as Partial<WeatherPlace> | null;
    return raw && typeof raw.id === 'string' && typeof raw.name === 'string' ? raw as WeatherPlace : null;
  } catch {
    return null;
  }
}

export function savePlace(place: WeatherPlace): void {
  try {
    localStorage.setItem(placeKey, JSON.stringify(place));
  } catch {
    // 浏览器禁用存储时只在本次打开期间记住。
  }
}

// ---------- 展示 ----------

export type WeatherTone = 'sun' | 'night' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'hot' | 'cold';

/** 数字天气图标代码 → 图标与色调。代码表：100 晴、101–104 云、150–153 夜间、3xx 雨、4xx 雪、5xx 雾霾沙尘、900/901 热/冷。 */
export function weatherIcon(code: string): { Icon: LucideIcon; tone: WeatherTone } {
  const value = Number(code);
  if (value === 100) return { Icon: Sun, tone: 'sun' };
  if (value === 150) return { Icon: Moon, tone: 'night' };
  if (value >= 101 && value <= 103) return { Icon: CloudSun, tone: 'cloud' };
  if (value >= 151 && value <= 153) return { Icon: CloudMoon, tone: 'night' };
  if (value === 104) return { Icon: Cloud, tone: 'cloud' };
  if (value === 300 || value === 301) return { Icon: CloudSunRain, tone: 'rain' };
  if (value === 350 || value === 351) return { Icon: CloudMoonRain, tone: 'rain' };
  if (value >= 302 && value <= 304) return { Icon: CloudLightning, tone: 'storm' };
  if (value === 313) return { Icon: CloudHail, tone: 'rain' };
  if (value === 305 || value === 309 || value === 314) return { Icon: CloudDrizzle, tone: 'rain' };
  if ((value >= 307 && value <= 312) || (value >= 315 && value <= 318)) return { Icon: CloudRainWind, tone: 'rain' };
  if (value >= 300 && value < 400) return { Icon: CloudRain, tone: 'rain' };
  if (value >= 400 && value < 500) return { Icon: CloudSnow, tone: 'snow' };
  if (value === 502 || value === 511 || value === 512 || value === 513) return { Icon: Haze, tone: 'fog' };
  if (value >= 503 && value <= 508) return { Icon: Wind, tone: 'fog' };
  if (value >= 500 && value < 600) return { Icon: CloudFog, tone: 'fog' };
  if (value === 900) return { Icon: ThermometerSun, tone: 'hot' };
  if (value === 901) return { Icon: ThermometerSnowflake, tone: 'cold' };
  return { Icon: Cloud, tone: 'cloud' };
}

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 预报日期 → “今天 / 明天 / 周X”与“9/25”。 */
export function dayLabel(fxDate: string, today: Date): { name: string; date: string } {
  const [year, month, day] = fxDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = Math.round((date.getTime() - base.getTime()) / 86_400_000);
  return { name: offset === 0 ? '今天' : offset === 1 ? '明天' : weekdays[date.getDay()], date: `${month}/${day}` };
}

/** ISO 时间 “2026-09-24T14:48+08:00” → “14:48”。 */
export function clockOf(isoTime: string | undefined): string {
  return isoTime?.match(/T(\d{2}:\d{2})/)?.[1] ?? '';
}

export function uvLevel(index: string): string {
  const value = Number(index);
  if (!Number.isFinite(value)) return '';
  return value <= 2 ? '弱' : value <= 4 ? '中等' : value <= 6 ? '强' : value <= 9 ? '很强' : '极强';
}
