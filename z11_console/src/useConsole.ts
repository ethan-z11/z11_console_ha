import { useEffect, useRef, useState } from 'react';
import { ConsoleClient } from './consoleClient';
import type { Catalogue, CustomConfig, EntityState, ServerLayout, ServerStatus } from './consoleClient';

/** HA 模式下最后一次的目录、状态与手动房间配置缓存，页面被系统回收后重新打开时先显示它，连上后以后端快照为准。 */
const cacheKey = 'hass-home-console-live-cache-v2';
const cacheMaxAgeMs = 12 * 60 * 60 * 1000;
const cacheSaveDelayMs = 2_000;
/** 页面在后台超过这个时长，回到前台时主动重建连接（锁屏后旧连接可能已失效）。 */
const hiddenReconnectMs = 15_000;

interface LiveCache {
  savedAt: number;
  status: ServerStatus;
  catalogue: Catalogue;
  custom?: CustomConfig;
  entities: [string, EntityState][];
}

function readCache(): LiveCache | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Partial<LiveCache>;
    if (typeof cache.savedAt !== 'number' || Date.now() - cache.savedAt > cacheMaxAgeMs) return null;
    if (cache.status?.dataSource !== 'live' || !Array.isArray(cache.catalogue?.rooms) || !Array.isArray(cache.catalogue?.entities) || !Array.isArray(cache.entities)) return null;
    return cache as LiveCache;
  } catch {
    return null;
  }
}

function writeCache(cache: LiveCache | null) {
  try {
    if (cache) localStorage.setItem(cacheKey, JSON.stringify(cache));
    else localStorage.removeItem(cacheKey);
  } catch {
    // 浏览器存储不可用时只是没有离线缓存，不影响在线使用。
  }
}

/**
 * 与控制台后端保持连接：数据来源、控制开关、HA 状态、设备目录、实体状态、共用布局都以后端为准。
 * 断线（例如手机锁屏）时保留最后一次的状态继续显示，不清空；回到前台或网络恢复时立即重连，收到快照后恢复为实时状态。
 * staleSince 为当前显示数据的时间（实时时为 null），offlineSince 为本次未连接开始的时间。
 */
export function useConsole() {
  const [cache] = useState(readCache);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(cache?.status ?? null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(cache?.catalogue ?? null);
  const [custom, setCustom] = useState<CustomConfig | null>(cache?.custom ?? null);
  const [entityStates, setEntityStates] = useState<Map<string, EntityState>>(() => new Map(cache?.entities));
  const [layout, setLayout] = useState<ServerLayout | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(cache?.savedAt ?? null);
  const [offlineSince, setOfflineSince] = useState<number | null>(() => Date.now());
  const clientRef = useRef<ConsoleClient | null>(null);
  // 待写入的缓存（null 表示当前不写）；写入按节流进行，页面转入后台时立即写一次。
  const pendingCacheRef = useRef<LiveCache | null>(null);
  const cacheTimerRef = useRef(0);

  function flushCache() {
    window.clearTimeout(cacheTimerRef.current);
    cacheTimerRef.current = 0;
    if (pendingCacheRef.current) writeCache(pendingCacheRef.current);
    pendingCacheRef.current = null;
  }

  useEffect(() => {
    const client = new ConsoleClient({
      onConnection: (next) => {
        setConnected(next);
        if (next) {
          setOfflineSince(null);
          return;
        }
        const now = Date.now();
        setOfflineSince((previous) => previous ?? now);
        setStaleSince((previous) => previous ?? now);
      },
      onHello: (nextCatalogue, nextLayout, nextCustom) => {
        setCatalogue(nextCatalogue);
        setLayout(nextLayout);
        setCustom(nextCustom);
      },
      onStatus: setStatus,
      onEntities: (changed, snapshot) => {
        if (snapshot) setStaleSince(null);
        setEntityStates((previous) => {
          const next = snapshot ? new Map<string, EntityState>() : new Map(previous);
          for (const [entityId, state] of Object.entries(changed)) {
            if (state) next.set(entityId, state);
            else next.delete(entityId);
          }
          return next;
        });
      },
      onLayout: setLayout,
      onCatalogue: setCatalogue,
      onCustom: setCustom,
    });
    clientRef.current = client;
    client.connect();

    let hiddenAt = document.hidden ? Date.now() : 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        flushCache();
        return;
      }
      const longHidden = hiddenAt > 0 && Date.now() - hiddenAt > hiddenReconnectMs;
      hiddenAt = 0;
      client.wake(longHidden);
    };
    const onOnline = () => client.wake();
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) client.wake(true); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      window.clearTimeout(cacheTimerRef.current);
      client.close();
      clientRef.current = null;
    };
  }, []);

  // 连接正常时把 HA 模式的目录与状态写入缓存（最多每 2 秒一次）；切到演示数据则清除缓存。
  useEffect(() => {
    if (!connected || staleSince !== null || !status) return;
    if (status.dataSource !== 'live') {
      pendingCacheRef.current = null;
      writeCache(null);
      return;
    }
    if (!catalogue) return;
    pendingCacheRef.current = { savedAt: Date.now(), status, catalogue, custom: custom ?? undefined, entities: [...entityStates] };
    if (!cacheTimerRef.current) cacheTimerRef.current = window.setTimeout(flushCache, cacheSaveDelayMs);
  }, [connected, staleSince, status, catalogue, custom, entityStates]);

  function callService(entity: string, service: string, data: Record<string, unknown>): Promise<void> {
    return clientRef.current?.callService(entity, service, data) ?? Promise.reject(new Error('正在重新连接，操作未发送'));
  }

  return { connected, status, catalogue, custom, entityStates, layout, staleSince, offlineSince, callService };
}
