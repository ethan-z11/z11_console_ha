import { RotateCw, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { deviceIcon } from '../appearance';
import { releasePointerFocus } from '../focus';
import type { FanDevice, Room } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

interface FanCardProps {
  layout: TileLayoutProps;
  fan: FanDevice;
  room: Room;
  onToggle: (id: string) => void;
  onSpeed: (id: string, percentage: number) => void;
  onPreset: (id: string, preset: string) => void;
  onOscillate: (id: string, oscillating: boolean) => void;
}

/** 风扇 / 新风机卡片：开关 + 百分比风速滑杆 + 预设风类（直吹风 / 自然风 / 进风 等）+ 摇头开关。 */
export function FanCard({ layout, fan, room, onToggle, onSpeed, onPreset, onOscillate }: FanCardProps) {
  const { size, editing } = layout;
  const DeviceIcon = deviceIcon(fan);
  const adjustable = fan.percentage !== undefined;
  // HA 上报 oscillating 属性才代表支持摇头。
  const canOscillate = fan.oscillating !== undefined;
  // 默认小卡：可调速或可摇头的风扇在小卡时点齿轮打开详情弹窗控制。
  const compact = (adjustable || canOscillate) && size === '1x1';
  const disabled = !fan.available || Boolean(editing);
  // 关机后风类 / 摇头按钮不可用，也不再显示高亮态。
  const controlsDisabled = disabled || !fan.on;
  const presets = fan.presetModes ?? [];
  const percentage = fan.percentage ?? 0;
  const status = !fan.available
    ? '设备不可用'
    : fan.on
      ? `已打开${fan.percentage !== undefined ? ` · ${fan.percentage}%` : ''}${fan.oscillating ? ' · 摇头中' : ''}${fan.presetMode ? ` · ${fan.presetMode}` : ''}`
      : '已关闭';
  // 小卡片状态只保留风速；摇头 / 风类在小卡弹窗里控制，不在状态行重复。
  const compactStatus = !fan.available
    ? '设备不可用'
    : fan.on
      ? `已打开${fan.percentage !== undefined ? ` · ${fan.percentage}%` : ''}`
      : '已关闭';
  const rangeStyle = { '--range-progress': `${fan.on ? percentage : 0}%` } as CSSProperties;
  const detailId = useId();
  const detailRef = useRef<HTMLDialogElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => { if (disabled) setDetailOpen(false); }, [disabled]);
  useEffect(() => { if (detailOpen && detailRef.current && !detailRef.current.open) detailRef.current.showModal(); }, [detailOpen]);

  const speedRange = (inputId?: string) => adjustable
    ? <div className="light-card__range fan-card__range">
        <span className="light-card__control-icon fan-card__control-icon" aria-hidden="true"><DeviceIcon size={16} /></span>
        <input id={inputId} type="range" min="0" max="100" value={percentage} style={rangeStyle} onChange={(event) => onSpeed(fan.id, Number(event.target.value))} disabled={disabled} aria-label={`调整${room.name}${fan.name}风速`} />
        <output>{percentage}%</output>
      </div>
    : null;

  const oscillateButton =
    <button
      type="button"
      className={`fan-card__oscillate${fan.oscillating ? ' fan-card__oscillate--on' : ''}`}
      onClick={() => onOscillate(fan.id, !fan.oscillating)}
      disabled={controlsDisabled}
      aria-pressed={fan.oscillating}
    >
      <RotateCw size={15} className={fan.on && fan.oscillating ? 'fan-card__oscillate-icon' : undefined} aria-hidden="true" />摇头
    </button>;

  // 大卡下与摇头按钮同排均分行宽；弹窗中再用 .fan-card__presets 容器包起来。
  const presetButtons = presets.length > 0
    ? presets.map((preset) => <button key={preset} type="button" className="fan-card__preset" onClick={() => onPreset(fan.id, preset)} disabled={controlsDisabled} aria-pressed={fan.presetMode === preset}>{preset}</button>)
    : null;

  return (
    <>
    <TileFrame {...layout} className={`light-card fan-card${compact ? ' light-card--compact fan-card--compact' : ''}`} active={fan.on} onOpen={compact && fan.available ? () => setDetailOpen(true) : undefined}>
      <div className="tile__top">
        <button type="button" className="tile__power" onClick={() => onToggle(fan.id)} disabled={disabled} aria-label={`${fan.on ? '关闭' : '打开'}${room.name}${fan.name}`} aria-pressed={fan.on}><DeviceIcon size={21} /></button>
        {!compact && <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{fan.name}</span><span className="tile__note">{status}</span></div>}
        <span className="tile__room">{room.name}</span>
      </div>
      {!compact ? (
        <div className="light-card__controls">
          {speedRange()}
          {(canOscillate || presets.length > 0) && (
            <div className="fan-card__control-row">
              {presetButtons}
              {canOscillate && oscillateButton}
            </div>
          )}
        </div>
      ) : <div className="light-card__compact-bottom"><div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{fan.name}</span><span className="tile__note">{compactStatus}</span></div>
        {compact && !editing && <button type="button" className="light-card__settings" onClick={() => setDetailOpen(true)} disabled={!fan.available} aria-label={`设置${room.name}${fan.name}风速、摇头和风类`} aria-haspopup="dialog" aria-controls={detailOpen ? detailId : undefined}><SlidersHorizontal size={18} /></button>}
      </div>}
    </TileFrame>
    {compact && detailOpen && createPortal(<dialog ref={detailRef} id={detailId} className="light-detail-dialog" aria-labelledby={`${detailId}-title`} onClose={() => { setDetailOpen(false); releasePointerFocus(); }} onCancel={() => setDetailOpen(false)} onClick={(e) => { if (e.target === e.currentTarget) setDetailOpen(false); }}>
      <div className="light-detail-dialog__heading"><div><small>{room.name}</small><h2 id={`${detailId}-title`}>{fan.name}</h2></div><button type="button" onClick={() => setDetailOpen(false)} autoFocus aria-label="关闭风扇设置"><X size={20} /></button></div>
      <div className="fan-card__dialog-control">
        {adjustable && <div className="light-detail-dialog__control"><div><label htmlFor={`${detailId}-speed`}>风速</label><output>{percentage}%</output></div>
          {speedRange(`${detailId}-speed`)}
        </div>}
        {canOscillate && <div className="fan-card__dialog-presets"><span>摇头</span>{oscillateButton}</div>}
        {presetButtons && <div className="fan-card__dialog-presets"><span>风类</span><div className="fan-card__presets">{presetButtons}</div></div>}
      </div>
    </dialog>, document.body)}
    </>
  );
}
