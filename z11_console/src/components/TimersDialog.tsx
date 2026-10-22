import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { openModalQuietly, releasePointerFocus } from '../focus';
import { formatRemaining, useNowTick } from './DelayTimer';

export interface TimerItem {
  id: string;
  name: string;
  roomName: string;
  endsAt: number;
}

interface TimersDialogProps {
  /** 非空时弹窗打开。 */
  timers: TimerItem[];
  onClose: () => void;
  /** 提前取消某一项计时（不改变设备当前状态）。 */
  onClear: (id: string) => void;
}

/** 「正在计时」列表弹窗：展示所有延时关闭中的设备与剩余时间，可逐项取消。 */
export function TimersDialog({ timers, onClose, onClear }: TimersDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = timers.length > 0;
  const now = useNowTick(open);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="device-dialog timers-dialog" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="device-dialog__heading">
        <div><small>延时关闭</small><h2>正在计时</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭正在计时列表"><X size={20} /></button>
      </div>
      <div className="timers-dialog__list">
        {timers.map((timer) => (
          <div key={timer.id} className="timers-dialog__row">
            <div className="timers-dialog__meta">
              <span className="timers-dialog__name">{timer.name}</span>
              <span className="timers-dialog__room">{timer.roomName}</span>
            </div>
            <output>{formatRemaining(timer.endsAt - now)}</output>
            <button type="button" className="timers-dialog__cancel" onClick={() => onClear(timer.id)} aria-label={`取消${timer.roomName}${timer.name}的计时`}>取消计时</button>
          </div>
        ))}
      </div>
      <p className="timers-dialog__hint">倒计时结束时设备将自动关闭；设备被其它方式关闭时计时自动作废。</p>
    </dialog>
  );
}
