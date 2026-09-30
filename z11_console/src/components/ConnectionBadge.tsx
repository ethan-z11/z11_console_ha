import type { HaStatus, ServerStatus } from '../consoleClient';
import { formatTime } from '../time';

/** 断线不超过这个时长只提示“正在重新连接”（手机锁屏解锁、切换网络通常很快恢复），超过才按连接中断提示。 */
const reconnectGraceMs = 20_000;

interface ConnectionBadgeProps {
  connected: boolean;
  status: ServerStatus | null;
  /** 当前显示数据的时间；实时时为 null。 */
  staleSince: number | null;
  /** 本次未连接开始的时间；已连接时为 null。 */
  offlineSince: number | null;
  now: Date;
  /** 为 true 时状态正常（已连接 HA 或演示数据）不显示，只在断线、重连等异常时出现；首页以外的页面使用。 */
  quiet?: boolean;
}

/** 顶部数据来源标签：控制台服务未连接、演示数据，或 HA 连接状态。 */
export function ConnectionBadge({ connected, status, staleSince, offlineSince, now, quiet = false }: ConnectionBadgeProps) {
  if (!connected) {
    if (offlineSince !== null && now.getTime() - offlineSince < reconnectGraceMs) {
      return <span className="demo-flag demo-flag--pending" role="status"><span />{staleSince !== null ? '正在重新连接…' : '正在连接…'}</span>;
    }
    const text = status?.dataSource !== 'live'
      ? '控制台服务未连接 · 演示数据'
      : staleSince !== null ? `连接中断，显示 ${formatTime(new Date(staleSince))} 的状态` : '控制台服务未连接，正在重试…';
    return <span className="demo-flag demo-flag--alert" role="status"><span />{text}</span>;
  }
  if (!status || status.dataSource === 'demo') return quiet ? null : <span className="demo-flag"><span />演示数据 · 未连接 HA</span>;
  const [tone, text] = connectionText(status.ha);
  if (quiet && tone === 'good') return null;
  return <span className={`demo-flag demo-flag--${tone}`} role="status"><span />{text}</span>;
}

export function connectionText(status: HaStatus | null): ['good' | 'pending' | 'alert', string] {
  switch (status?.kind) {
    case 'connected': return ['good', `已连接 HA${status.version ? ` ${status.version}` : ''}`];
    case 'auth_failed': return ['alert', `HA 令牌无效：${status.message}`];
    case 'disconnected': return ['alert', status.retryInSeconds > 0 ? `HA 未连接，${status.retryInSeconds} 秒后重试` : `HA 未连接：${status.message}`];
    case 'unconfigured': return ['alert', '尚未设置 HA 地址或令牌'];
    case 'disabled': return ['pending', '演示数据'];
    default: return ['pending', '正在连接 HA…'];
  }
}
