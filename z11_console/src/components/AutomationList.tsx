import { Search } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, getAutomations, setAutomation } from '../consoleApi';
import type { AutomationItem, AutomationList as AutomationData } from '../consoleApi';

interface AutomationListProps {
  /** 只读模式（关闭“允许控制设备”）时只看状态，开关不可点。 */
  canControl: boolean;
  onExpired: (message: string) => void;
}

/** 打开期间定时重新读取，HA 里修改的开关状态、触发时间也会同步过来。 */
const pollMs = 5000;

function lastTriggeredText(value: string | null, now: number): string {
  if (!value) return '从未触发';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '从未触发';
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 1) return '刚刚触发';
  if (minutes < 60) return `${minutes} 分钟前触发`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前触发`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} 天前触发` : `${new Date(time).toLocaleDateString('zh-CN')} 触发`;
}

/**
 * 设置页“自动化”：同步 HA 的自动化列表，逐个开启或关闭（服务只调用 automation.turn_on / turn_off）。
 * 点击后先显示新状态，失败则回退并提示；之后以 HA 回写的状态为准。
 */
export function AutomationList({ canControl, onExpired }: AutomationListProps) {
  const searchId = useId();
  const [data, setData] = useState<AutomationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 已点击、等待 HA 回写的目标状态；读取到一致的状态后清除。
  const [pending, setPending] = useState<Record<string, 'on' | 'off'>>({});

  const load = useCallback(async () => {
    try {
      const next = await getAutomations();
      setData(next);
      setError(null);
      setPending((previous) => {
        const remaining = Object.entries(previous).filter(([id, state]) => next.automations.find((item) => item.id === id)?.state !== state);
        return remaining.length === Object.keys(previous).length ? previous : Object.fromEntries(remaining);
      });
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) onExpired(loadError.message);
      else setError(loadError instanceof Error ? loadError.message : '读取失败');
    }
  }, [onExpired]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [load]);

  async function toggle(item: AutomationItem, enabled: boolean) {
    setPending((previous) => ({ ...previous, [item.id]: enabled ? 'on' : 'off' }));
    setError(null);
    try {
      await setAutomation(item.id, enabled);
      window.setTimeout(() => { void load(); }, 800);
    } catch (toggleError) {
      setPending((previous) => {
        const next = { ...previous };
        delete next[item.id];
        return next;
      });
      if (toggleError instanceof ApiError && toggleError.status === 401) onExpired(toggleError.message);
      else setError(`${item.name}：${toggleError instanceof Error ? toggleError.message : '切换失败'}`);
    }
  }

  if (!data) return <p className="settings-message" role="status">{error ?? '正在读取自动化…'}</p>;

  const keyword = query.trim().toLowerCase();
  const items = keyword ? data.automations.filter((item) => item.name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword)) : data.automations;
  const enabledCount = data.automations.filter((item) => (pending[item.id] ?? item.state) === 'on').length;
  const now = Date.now();

  return (
    <div className="automation-list">
      {data.source === 'demo' && <p className="automation-list__note">当前为演示数据，开关只影响演示，不会改动 HA。</p>}
      {data.source === 'live' && !data.connected && <p className="automation-list__note">HA 未连接，连接后显示自动化。</p>}
      {!canControl && <p className="automation-list__note">已关闭“允许控制设备”（只读模式），只能查看状态。</p>}
      {data.automations.length > 0 && (
        <div className="automation-list__tools">
          <label className="entity-filter__search" htmlFor={searchId}><Search size={16} /><input id={searchId} type="search" placeholder="搜索名称或实体 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <span>{enabledCount} / {data.automations.length} 已开启</span>
        </div>
      )}
      {items.length > 0 ? (
        <ul>
          {items.map((item) => {
            const state = pending[item.id] ?? item.state;
            const available = state === 'on' || state === 'off';
            return (
              <li key={item.id} className={`automation-list__row${state === 'on' ? '' : ' automation-list__row--off'}`}>
                <div>
                  <span className="automation-list__name">{item.name}</span>
                  <small>{available ? lastTriggeredText(item.lastTriggered, now) : '不可用'} · <code>{item.id}</code></small>
                </div>
                <button type="button" role="switch" className="settings-switch" aria-checked={state === 'on'} aria-label={`${state === 'on' ? '关闭' : '开启'}自动化${item.name}`} disabled={!canControl || !available || item.id in pending} onClick={() => { void toggle(item, state !== 'on'); }}><span /></button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="settings-message" role="status">{data.automations.length === 0 ? (data.source === 'live' && data.connected ? 'HA 中还没有自动化。' : '') : '没有匹配的自动化。'}</p>
      )}
      <p className={`settings-message${error ? ' settings-message--error' : ''}`} role="status">{error}</p>
    </div>
  );
}
