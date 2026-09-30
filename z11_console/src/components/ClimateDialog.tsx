import { Minus, Plus, Power, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { climateTone } from '../appearance';
import { autoFirst, fanModeLabel, hvacModeLabel } from '../climate';
import { openModalQuietly, releasePointerFocus } from '../focus';
import type { ClimateDevice, DeviceActions, Room } from '../types';

interface ClimateDialogProps {
  /** 要设置的空调或地暖；为空时弹窗关闭。 */
  climate: ClimateDevice | undefined;
  room: Room | undefined;
  actions: DeviceActions;
  onClose: () => void;
}

export function ClimateDialog({ climate, room, actions, onClose }: ClimateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = Boolean(climate);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className={`device-dialog${climate ? ` climate-card--${climateTone(climate)}` : ''}`} onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose}>
      {climate && <>
        <div className="device-dialog__heading">
          <div><small>{room?.name}</small><h2>{climate.name}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={20} /></button>
        </div>
        <div className="climate-detail__temperature">
          <div>
            <small>设定温度</small>
            <strong>{climate.available ? climate.target : '--'}°</strong>
            {climate.current !== undefined && <span>室温 {climate.current}°</span>}
            <span>{!climate.available ? '设备不可用' : climate.on ? hvacModeLabel(climate.mode) : '已关闭'}</span>
          </div>
          <div className="climate-card__actions">
            <button type="button" onClick={() => actions.adjust(climate.id, -climate.step)} disabled={!climate.available || !climate.on} aria-label="降低设定温度"><Minus size={20} /></button>
            <button type="button" onClick={() => actions.adjust(climate.id, climate.step)} disabled={!climate.available || !climate.on} aria-label="升高设定温度"><Plus size={20} /></button>
            <button type="button" onClick={() => actions.toggle(climate.id)} disabled={!climate.available} aria-label={climate.on ? '关闭设备' : '打开设备'} aria-pressed={climate.on}><Power size={20} /></button>
          </div>
        </div>
        <div className="climate-detail__group">
          <h3>模式</h3>
          <div className="climate-detail__options">
            {autoFirst(climate.hvacModes.filter((mode) => mode !== 'off')).map((mode) => (
              <button key={mode} type="button" onClick={() => actions.changeClimateMode(climate.id, mode)} disabled={!climate.available} aria-pressed={climate.on && climate.mode === mode}>{hvacModeLabel(mode)}</button>
            ))}
          </div>
        </div>
        {climate.fanModes && climate.fanModes.length > 0 && (
          <div className="climate-detail__group">
            <h3>风速</h3>
            <div className="climate-detail__options">
              {autoFirst(climate.fanModes).map((fanMode) => (
                <button key={fanMode} type="button" onClick={() => actions.changeFanMode(climate.id, fanMode)} disabled={!climate.available || !climate.on} aria-pressed={climate.fanMode === fanMode}>{fanModeLabel(fanMode)}</button>
              ))}
            </div>
            {!climate.on && <p className="climate-detail__hint">先开启空调或选择模式，再调整风速。</p>}
          </div>
        )}
        {climate.swingModes && climate.swingModes.length > 0 && (
          <div className="climate-detail__group">
            <h3>扫风</h3>
            <div className="climate-detail__options">
              {climate.swingModes.map((swingMode) => (
                <button key={swingMode} type="button" onClick={() => actions.setSwingMode(climate.id, swingMode)} disabled={!climate.available || !climate.on} aria-pressed={climate.swingMode === swingMode}>{swingMode === 'on' ? '开启' : swingMode === 'off' ? '关闭' : swingMode}</button>
              ))}
            </div>
          </div>
        )}
      </>}
    </dialog>
  );
}
