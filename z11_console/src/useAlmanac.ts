import { useEffect, useState } from 'react';
import { getAlmanac } from './almanac';
import type { Almanac } from './almanac';

const REFRESH_MS = 10 * 60 * 1000;

/** 农历/黄历：按天与时辰变化，打开页面、回到前台及每 10 分钟刷新。 */
export function useAlmanac(): { almanac: Almanac | null } {
  const [almanac, setAlmanac] = useState<Almanac | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getAlmanac()
        .then((data) => { if (!cancelled) setAlmanac(data); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { almanac };
}
