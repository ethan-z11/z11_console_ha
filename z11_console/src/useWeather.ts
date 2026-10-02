import { useCallback, useEffect, useState } from 'react';
import { getForecast, homePlace, placeAt, readPlace, savePlace, saveSharedPlace } from './weather';
import type { Forecast, WeatherPlace } from './weather';

const REFRESH_MS = 10 * 60 * 1000;

export interface WeatherState {
  place: WeatherPlace | null;
  forecast: Forecast | null;
  loading: boolean;
  error: string | null;
  locating: boolean;
  locateError: string | null;
  choosePlace: (place: WeatherPlace) => void;
  locate: () => void;
  refresh: () => void;
}

function currentPosition(): Promise<GeolocationPosition> {
  if (!window.isSecureContext) return Promise.reject(new Error('当前页面不是 HTTPS 或本机地址，浏览器不允许定位，请搜索位置'));
  if (!('geolocation' in navigator)) return Promise.reject(new Error('此浏览器不支持定位，请搜索位置'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, (error) => {
    reject(new Error(error.code === error.PERMISSION_DENIED ? '未允许定位，请在浏览器中允许，或搜索位置'
      : error.code === error.TIMEOUT ? '定位超时，请重试或搜索位置' : '无法获取当前位置，请搜索位置'));
  }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60 * 1000 }));
}

/**
 * 天气：地区全屋共用（保存在服务端，一块屏幕选好后所有屏幕直接显示）。
 * 本地 localStorage 只作首次进入/服务端暂不可用时的兜底；未选择过时用 HA 中“家”的位置。
 * 每 10 分钟及页面回到前台时刷新（服务端另有 10 分钟缓存）。
 */
export function useWeather(sharedPlace?: WeatherPlace | null): WeatherState {
  const [place, setPlace] = useState<WeatherPlace | null>(readPlace);
  const [forecast, setForecast] = useState<{ placeId: string; data: Forecast } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const choosePlace = useCallback((next: WeatherPlace) => {
    savePlace(next);
    setPlace(next);
    setLocateError(null);
    // 存为全屋共用；网络失败时不影响本机显示，下次选择会再试。
    void saveSharedPlace(next).catch(() => undefined);
  }, []);

  // 服务端下发的共用地区优先级最高（任何一块屏幕改了地区，所有屏幕立即跟随）。
  useEffect(() => {
    if (!sharedPlace) return;
    savePlace(sharedPlace);
    setPlace((previous) => (previous?.id === sharedPlace.id ? previous : sharedPlace));
  }, [sharedPlace]);

  // 本地和服务端都没选过位置：尝试 HA 的“家”，拿到后直接存成全屋共用；失败则等待用户选择。
  useEffect(() => {
    if (sharedPlace || readPlace()) return;
    let cancelled = false;
    homePlace()
      .then((home) => { if (!cancelled && !readPlace()) choosePlace(home); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sharedPlace, choosePlace]);

  useEffect(() => {
    if (!place) return;
    let cancelled = false;
    setLoading(true);
    getForecast(place)
      .then((data) => { if (!cancelled) { setForecast({ placeId: place.id, data }); setError(null); } })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [place, tick]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') setTick((value) => value + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const locate = useCallback(() => {
    setLocating(true);
    setLocateError(null);
    currentPosition()
      .then((position) => placeAt(position.coords.longitude, position.coords.latitude))
      .then(choosePlace)
      .catch((reason: Error) => setLocateError(reason.message))
      .finally(() => setLocating(false));
  }, [choosePlace]);

  return {
    place,
    // 切换位置后、新数据到达前不显示上一个位置的天气。
    forecast: forecast && place && forecast.placeId === place.id ? forecast.data : null,
    loading,
    error,
    locating,
    locateError,
    choosePlace,
    locate,
    refresh: useCallback(() => setTick((value) => value + 1), []),
  };
}
