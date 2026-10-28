import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Power, X } from 'lucide-react';
import { deviceIcon } from '../appearance';
import { releasePointerFocus } from '../focus';
import type { Device, Room, SwitchDevice } from '../types';
import { BoundGrid } from './BoundGrid';
import { DelayTimerBlock } from './DelayTimer';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

interface SwitchCardProps {
  layout: TileLayoutProps;
  device: SwitchDevice;
  room: Room;
  /** 绑定的控制按钮与传感器（开关在前，只读状态在后）。 */
  extras?: Device[];
  onToggle: (id: string) => void;
  /** 延时关闭（设置弹窗内）：seconds 秒后由服务端关闭设备。 */
  onTimerSet: (id: string, seconds: number) => void;
  /** 提前取消延时关闭。 */
  onTimerClear: (id: string) => void;
}

/**
 * 普通开关 / 智能插座卡片：只有开与关，点卡片任意位置或电源按钮即翻转。
 * 长按卡片弹出设置弹窗（与 HomeKit 模式一致）：弹窗里可开关本体、操作绑定的控制按钮与传感器，
 * 下方提供「延时关闭」计时（米家风格）。
 */
export function SwitchCard({ layout, device, room, extras, onToggle, onTimerSet, onTimerClear }: SwitchCardProps) {
  const { editing } = layout;
  const DeviceIcon = deviceIcon(device);
  const disabled = !device.available || Boolean(editing);
  const status = !device.available ? '设备不可用' : device.on ? '已打开' : '已关闭';
  const detailId = useId();
  const detailRef = useRef<HTMLDialogElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const dialog = detailRef.current;
    if (!dialog) return;
    if (detailOpen && !dialog.open) dialog.showModal();
    if (!detailOpen && dialog.open) dialog.close();
  }, [detailOpen]);

  return (
    <>
    <TileFrame {...layout} className="light-card light-card--switch switch-card" active={device.on} onOpen={device.available ? () => onToggle(device.id) : undefined} onLongPress={device.available ? () => setDetailOpen(true) : undefined}>
      <div className="tile__top">
        <button type="button" className="tile__power" onClick={() => onToggle(device.id)} disabled={disabled} aria-label={`${device.on ? '关闭' : '打开'}${room.name}${device.name}`} aria-pressed={device.on}><DeviceIcon size={21} /></button>
        <span className="tile__room">{room.name}</span>
      </div>
      <div className="light-card__compact-bottom">
        <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{device.name}</span><span className="tile__note">{status}</span></div>
      </div>
    </TileFrame>
    {detailOpen && createPortal(<dialog ref={detailRef} id={detailId} className="light-detail-dialog switch-detail-dialog" aria-labelledby={`${detailId}-title`} onClose={() => { setDetailOpen(false); releasePointerFocus(); }} onCancel={() => setDetailOpen(false)} onClick={(e) => { if (e.target === e.currentTarget) setDetailOpen(false); }}>
      <div className="light-detail-dialog__heading"><div><small>{room.name}</small><h2 id={`${detailId}-title`}>{device.name}</h2></div><button type="button" onClick={() => setDetailOpen(false)} autoFocus aria-label="关闭开关设置"><X size={20} /></button></div>
      {/* 开关本体只留一个大图标按钮代表开关：点击翻转，状态文字随动。 */}
      <div className="switch-detail-dialog__body">
        <button type="button" className={`switch-detail-dialog__toggle${device.on ? ' is-on' : ''}`} onClick={() => onToggle(device.id)} disabled={!device.available} aria-label={`${device.on ? '关闭' : '打开'}${room.name}${device.name}`} aria-pressed={device.on}>
          <Power size={34} />
        </button>
        <span className="switch-detail-dialog__status">{!device.available ? '设备不可用' : device.on ? '已打开' : '已关闭'}</span>
      </div>
      {extras && extras.length > 0 && <BoundGrid devices={extras} onToggle={onToggle} />}
      <DelayTimerBlock device={device} armed={device.available && device.on} onSet={onTimerSet} onClear={onTimerClear} />
    </dialog>, document.body)}
    </>
  );
}
