import { ArrowDownToLine, ArrowUpFromLine, Blinds, CircleStop, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { deviceIcon } from '../appearance';
import { releasePointerFocus } from '../focus';
import type { CoverDevice, Room } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

interface CoverCardProps {
  layout: TileLayoutProps;
  cover: CoverDevice;
  room: Room;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onStop: (id: string) => void;
  onPosition: (id: string, position: number) => void;
  /** 绑定的子窗帘：显示在设置弹窗里（大卡片）；宿主卡片因此获得设置按钮。 */
  childDevices?: CoverDevice[];
}

/** 窗帘 / 卷帘卡片：开合开关、位置滑杆（0 全关 - 100 全开）与停止。 */
export function CoverCard({ layout, cover, room, onOpen, onClose, onStop, onPosition, childDevices }: CoverCardProps) {
  const { size, editing } = layout;
  const DeviceIcon = deviceIcon(cover);
  const compact = size === '1x1';
  const childCovers = childDevices ?? [];
  const hasChildren = childCovers.length > 0;
  const disabled = !cover.available || Boolean(editing);
  const moving = cover.state === 'opening' || cover.state === 'closing';
  const active = cover.state === 'open' || moving;
  const position = cover.position ?? 0;
  const status = !cover.available
    ? '设备不可用'
    : cover.state === 'opening'
      ? '正在打开…'
      : cover.state === 'closing'
        ? '正在关闭…'
        : cover.state === 'open'
          ? cover.position !== undefined ? `已打开 · ${cover.position}%` : '已打开'
          : cover.state === 'closed'
            ? '已关闭'
            : '状态未知';
  const rangeStyle = { '--range-progress': `${position}%` } as CSSProperties;
  // 打开按钮只在完全打开（100%）时禁用；没有位置反馈的设备退回按状态判断。
  const openDisabled = disabled || (cover.position !== undefined ? position >= 100 : cover.state === 'open');
  // 关闭按钮只在完全关闭（0%）时禁用。
  const closeDisabled = disabled || (cover.position !== undefined ? position <= 0 : cover.state === 'closed');
  // 小卡空白处 / 电源按钮：在开与关之间反转。
  const toggleCover = () => (active ? onClose(cover.id) : onOpen(cover.id));
  const label = `${room.name}${cover.name}`;
  const detailId = useId();
  const detailRef = useRef<HTMLDialogElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => { if (detailOpen && detailRef.current && !detailRef.current.open) detailRef.current.showModal(); }, [detailOpen]);
  useEffect(() => { if (disabled) setDetailOpen(false); }, [disabled]);

  const powerButton = (
    <button type="button" className="tile__power" onClick={toggleCover} disabled={disabled} aria-label={`${active ? '关闭' : '打开'}${label}`} aria-pressed={active}><DeviceIcon size={21} /></button>
  );

  const wideButtons = (
    <div className="cover-card__buttons">
      <button type="button" className="cover-card__button" onClick={() => onOpen(cover.id)} disabled={openDisabled} aria-label={`打开${label}`}><ArrowUpFromLine size={17} /><span>打开</span></button>
      {cover.supportsStop && <button type="button" className="cover-card__button" onClick={() => onStop(cover.id)} disabled={disabled} aria-label={`停止${label}`}><CircleStop size={17} /><span>停止</span></button>}
      <button type="button" className="cover-card__button" onClick={() => onClose(cover.id)} disabled={closeDisabled} aria-label={`关闭${label}`}><ArrowDownToLine size={17} /><span>关闭</span></button>
    </div>
  );

  return (
    <>
    <TileFrame {...layout} className={`cover-card${compact ? ' cover-card--compact' : ''}`} active={active} onOpen={compact && cover.available ? toggleCover : undefined}>
      {!compact ? (
        <>
          <div className="tile__top">
            {powerButton}
            <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{cover.name}</span><span className="tile__note">{status}</span></div>
            <span className="tile__room">{room.name}</span>
            {/* 大卡片本身没有设置按钮；绑定了子窗帘后与小卡片一样弹出设置弹窗（内含子窗帘大卡片）。 */}
            {hasChildren && !editing && <button type="button" className="light-card__settings" onClick={() => setDetailOpen(true)} disabled={!cover.available} aria-label={`设置${label}与它的子窗帘`} aria-haspopup="dialog" aria-controls={detailOpen ? detailId : undefined}><SlidersHorizontal size={18} /></button>}
          </div>
          <div className="light-card__controls">
            {cover.supportsPosition && <div className="light-card__range cover-card__range">
              <span className="light-card__control-icon cover-card__control-icon" aria-hidden="true"><Blinds size={16} /></span>
              <input type="range" min="0" max="100" value={position} style={rangeStyle} onChange={(event) => onPosition(cover.id, Number(event.target.value))} disabled={disabled} aria-label={`调整${label}开合位置`} />
              <output>{position}%</output>
            </div>}
            {wideButtons}
          </div>
        </>
      ) : (
        <>
          <div className="tile__top">
            {powerButton}
            <span className="tile__room">{room.name}</span>
          </div>
          <div className="cover-card__compact-bottom">
            <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{cover.name}</span><span className="tile__note">{status}</span></div>
            {compact && !editing && <button type="button" className="light-card__settings" onClick={() => setDetailOpen(true)} disabled={!cover.available} aria-label={`设置${label}开合位置、打开关闭和停止`} aria-haspopup="dialog" aria-controls={detailOpen ? detailId : undefined}><SlidersHorizontal size={18} /></button>}
          </div>
        </>
      )}
    </TileFrame>
    {detailOpen && createPortal(<dialog ref={detailRef} id={detailId} className="light-detail-dialog" aria-labelledby={`${detailId}-title`} onClose={() => { setDetailOpen(false); releasePointerFocus(); }} onCancel={() => setDetailOpen(false)} onClick={(e) => { if (e.target === e.currentTarget) setDetailOpen(false); }}>
      <div className="light-detail-dialog__heading"><div><small>{room.name}</small><h2 id={`${detailId}-title`}>{cover.name}</h2></div><button type="button" onClick={() => setDetailOpen(false)} autoFocus aria-label="关闭窗帘控制"><X size={20} /></button></div>
      {cover.supportsPosition && <div className="light-detail-dialog__control"><div><label htmlFor={`${detailId}-position`}>开合位置</label><output>{position}%</output></div><input id={`${detailId}-position`} type="range" min="0" max="100" value={position} style={rangeStyle} onChange={(event) => onPosition(cover.id, Number(event.target.value))} disabled={!cover.available} /></div>}
      <div className="cover-card__buttons cover-card__buttons--dialog">
        <button type="button" className="cover-card__button" onClick={() => onOpen(cover.id)} disabled={!cover.available || (cover.position !== undefined ? position >= 100 : cover.state === 'open')} aria-label={`打开${label}`}><ArrowUpFromLine size={17} /><span>打开</span></button>
        {cover.supportsStop && <button type="button" className="cover-card__button" onClick={() => onStop(cover.id)} disabled={!cover.available} aria-label={`停止${label}`}><CircleStop size={17} /><span>停止</span></button>}
        <button type="button" className="cover-card__button" onClick={() => onClose(cover.id)} disabled={!cover.available || (cover.position !== undefined ? position <= 0 : cover.state === 'closed')} aria-label={`关闭${label}`}><ArrowDownToLine size={17} /><span>关闭</span></button>
      </div>
      {hasChildren && <div className="light-detail-dialog__children">
        <span className="light-detail-dialog__children-title">子窗帘</span>
        <div className="light-detail-dialog__children-grid">
          {childCovers.map((child) => (
            <CoverCard key={child.id} layout={{ id: child.id, label: `${room.name}${child.name}`, size: '2x1' }} cover={child} room={room} onOpen={onOpen} onClose={onClose} onStop={onStop} onPosition={onPosition} />
          ))}
        </div>
      </div>}
    </dialog>, document.body)}
    </>
  );
}
