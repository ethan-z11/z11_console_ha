import { Battery, BatteryCharging, Bell, Home, Pause, Play, SlidersHorizontal, X } from 'lucide-react';
import { apiPath } from '../consoleApi';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { deviceIcon } from '../appearance';
import { releasePointerFocus } from '../focus';
import type { Room, VacuumDevice, VacuumStatus } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

const STATUS_TEXT: Record<VacuumStatus, string> = {
  cleaning: '清扫中',
  docked: '已回充',
  paused: '已暂停',
  idle: '待机中',
  returning: '回充中',
  error: '需要协助',
  unknown: '状态未知',
};

/** 地图图片轮询间隔：清扫 / 回充时 5 秒，其余 15 秒。 */
const MAP_REFRESH_CLEANING_MS = 5_000;
const MAP_REFRESH_IDLE_MS = 15_000;

interface VacuumCardProps {
  layout: TileLayoutProps;
  vacuum: VacuumDevice;
  room: Room;
  /** 点卡片空白处 / 电源图标：清扫 / 回充中 → 暂停，其余 → 开始清扫。 */
  onToggle: (id: string) => void;
  onStart: (id: string) => void;
  onPause: (id: string) => void;
  onReturn: (id: string) => void;
  onLocate: (id: string) => void;
  onFanSpeed: (id: string, fanSpeed: string) => void;
}

/** 扫地机器人卡片：状态、电量、清扫地图（HA image 实体经后端代理）、清扫 / 回充 / 寻找与档位控制。 */
export function VacuumCard({ layout, vacuum, room, onToggle, onStart, onPause, onReturn, onLocate, onFanSpeed }: VacuumCardProps) {
  const { size, editing } = layout;
  const DeviceIcon = deviceIcon(vacuum);
  const disabled = !vacuum.available || Boolean(editing);
  const compact = size === '1x1';
  const busy = vacuum.status === 'cleaning' || vacuum.status === 'returning';
  const detailId = useId();
  const detailRef = useRef<HTMLDialogElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => { if (disabled) setDetailOpen(false); }, [disabled]);
  useEffect(() => { if (detailOpen && detailRef.current && !detailRef.current.open) detailRef.current.showModal(); }, [detailOpen]);

  // 地图只在小卡弹窗中显示（大卡不放地图），弹窗打开时才拉取。
  const mapActive = Boolean(vacuum.mapEntity) && compact && detailOpen;
  useEffect(() => {
    if (!mapActive) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), busy ? MAP_REFRESH_CLEANING_MS : MAP_REFRESH_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [mapActive, busy]);

  const statusText = !vacuum.available ? '设备不可用' : STATUS_TEXT[vacuum.status];

  const battery = vacuum.battery !== undefined
    ? <span className={`vacuum-card__battery${vacuum.battery <= 20 && vacuum.available ? ' vacuum-card__battery--low' : ''}`} aria-label={`电量 ${vacuum.battery}%`}>
        {busy ? <BatteryCharging size={14} /> : <Battery size={14} />}{vacuum.battery}%
      </span>
    : null;

  const mapImage = () => vacuum.mapEntity
    ? <img className="vacuum-card__map-img" src={apiPath(`/api/ha-image?entity=${encodeURIComponent(vacuum.mapEntity)}&v=${tick}`)} alt={`${room.name}${vacuum.name}清扫地图`} draggable={false} />
    : <div className="vacuum-card__map-img vacuum-card__map-empty"><DeviceIcon size={26} /><span>暂无地图</span></div>;

  const fanSpeeds = vacuum.fanSpeeds && vacuum.fanSpeeds.length > 0
    ? <div className="fan-card__presets vacuum-card__speeds">
        {vacuum.fanSpeeds.map((speed) => <button key={speed} type="button" className="fan-card__preset" disabled={disabled} aria-pressed={vacuum.fanSpeed === speed} onClick={() => onFanSpeed(vacuum.id, speed)}>{speed}</button>)}
      </div>
    : null;

  const buttons = (
    <div className="cover-card__buttons">
      <button type="button" className="cover-card__button" disabled={disabled} aria-pressed={busy} onClick={() => (busy ? onPause(vacuum.id) : onStart(vacuum.id))}>
        {busy ? <Pause size={15} /> : <Play size={15} />}<span>{busy ? '暂停' : '清扫'}</span>
      </button>
      <button type="button" className="cover-card__button" disabled={disabled || vacuum.status === 'docked'} onClick={() => onReturn(vacuum.id)} aria-label={`让${vacuum.name}回充`}>
        <Home size={15} /><span>回充</span>
      </button>
      <button type="button" className="cover-card__button" disabled={!vacuum.available} onClick={() => onLocate(vacuum.id)} aria-label={`寻找${vacuum.name}`}>
        <Bell size={15} /><span>寻找</span>
      </button>
    </div>
  );

  return (
    <>
    <TileFrame {...layout} className={`vacuum-card${compact ? ' vacuum-card--compact' : ''}`} active={busy} onOpen={compact && vacuum.available ? () => onToggle(vacuum.id) : undefined}>
      <div className="tile__top">
        <button type="button" className="tile__power" onClick={() => onToggle(vacuum.id)} disabled={disabled} aria-label={`${busy ? '暂停' : '开始清扫'}${room.name}${vacuum.name}`} aria-pressed={busy}><DeviceIcon size={21} /></button>
        {!compact && <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{vacuum.name}</span><span className={`tile__note${vacuum.status === 'error' ? ' tile__note--alert' : ''}`}>{statusText}</span></div>}
        {battery}
      </div>
      {!compact ? (
        <div className="vacuum-card__controls">
          {buttons}
        </div>
      ) : <div className="cover-card__compact-bottom">
        <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{vacuum.name}</span><span className={`tile__note${vacuum.status === 'error' ? ' tile__note--alert' : ''}`}>{statusText}</span></div>
        {!editing && <button type="button" className="light-card__settings" onClick={() => setDetailOpen(true)} disabled={!vacuum.available} aria-label={`设置${room.name}${vacuum.name}清扫、回充和档位`} aria-haspopup="dialog" aria-controls={detailOpen ? detailId : undefined}><SlidersHorizontal size={18} /></button>}
      </div>}
    </TileFrame>
    {compact && detailOpen && createPortal(<dialog ref={detailRef} id={detailId} className="light-detail-dialog" aria-labelledby={`${detailId}-title`} onClose={() => { setDetailOpen(false); releasePointerFocus(); }} onCancel={() => setDetailOpen(false)}>
      <div className="light-detail-dialog__heading"><div><small>{room.name}</small><h2 id={`${detailId}-title`}>{vacuum.name}</h2></div><button type="button" onClick={() => setDetailOpen(false)} autoFocus aria-label="关闭扫地机设置"><X size={20} /></button></div>
      <div className="vacuum-card__dialog">
        <div className="vacuum-card__map vacuum-card__map--dialog">
            {mapImage()}
          <div className="vacuum-card__map-overlay"><span>{statusText}</span>{vacuum.battery !== undefined && <span>{vacuum.battery}%</span>}</div>
        </div>
        {fanSpeeds}
        {buttons}
      </div>
    </dialog>, document.body)}
    </>
  );
}
