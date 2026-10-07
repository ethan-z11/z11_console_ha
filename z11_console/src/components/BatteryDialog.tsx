import { Battery, BatteryFull, BatteryMedium, BatteryWarning, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { openModalQuietly, releasePointerFocus } from '../focus';
import type { BatteryReading, HomeState } from '../types';

function batteryVisual(level: number | null, available: boolean) {
  if (!available || level === null) {
    return { icon: <BatteryWarning size={16} />, tone: 'battery-item--alert', label: '未知' };
  }
  if (level <= 20) {
    return { icon: <BatteryWarning size={16} />, tone: 'battery-item--alert', label: `${level}%` };
  }
  if (level <= 40) {
    return { icon: <Battery size={16} />, tone: 'battery-item--warning', label: `${level}%` };
  }
  if (level <= 70) {
    return { icon: <BatteryMedium size={16} />, tone: '', label: `${level}%` };
  }
  return { icon: <BatteryFull size={16} />, tone: 'battery-item--ok', label: `${level}%` };
}

/** 电池状态列表弹窗：按电量从低到高排序，图标和颜色按百分比区分。 */
export function BatteryDialog({ batteries, home, onClose }: { batteries: BatteryReading[]; home: HomeState; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) openModalQuietly(dialog);
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const sorted = [...batteries].sort((a, b) => {
    const pa = a.available && a.level !== null ? a.level : -1;
    const pb = b.available && b.level !== null ? b.level : -1;
    return pa - pb;
  });

  return (
    <dialog ref={dialogRef} className="device-dialog battery-dialog" aria-label="电池状态" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="device-dialog__heading">
        <div><small>电量传感器</small><h2>电池状态<em>{sorted.length}</em></h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭列表"><X size={20} /></button>
      </div>
      {sorted.length === 0 ? (
        <p className="active-dialog__empty">暂无电量传感器。</p>
      ) : (
        <ul className="battery-dialog__list">
          {sorted.map((b) => {
            const { icon, tone, label } = batteryVisual(b.level, b.available);
            const room = home.rooms.find((r) => r.id === b.roomId);
            return (
              <li key={b.id} className={`battery-dialog__item${tone ? ` ${tone}` : ''}`}>
                <span className="battery-dialog__icon">{icon}</span>
                <span className="battery-dialog__name">
                  <strong>{b.name}</strong>
                  <small>{room ? room.name : '未分配房间'}</small>
                </span>
                <span className="battery-dialog__level">{label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </dialog>
  );
}
