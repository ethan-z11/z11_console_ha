import { AirVent, Fan, Lightbulb, Power, Waves, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { hvacModeLabel } from '../climate';
import { openModalQuietly, releasePointerFocus } from '../focus';
import { isClimate } from '../selectors';
import type { Device, DeviceActions, HomeState } from '../types';

export type ActiveKind = 'light' | 'climate' | 'heating' | 'fan';

export interface ActiveListRequest {
  kind: ActiveKind;
  /** 只列出某个房间；为空表示全家。 */
  roomId?: string;
}

const titles: Record<ActiveKind, { on: string; noun: string; icon: typeof Lightbulb }> = {
  light: { on: '亮着的灯', noun: '灯', icon: Lightbulb },
  climate: { on: '开着的空调', noun: '空调', icon: AirVent },
  heating: { on: '开着的制热', noun: '制热', icon: Waves },
  fan: { on: '开着的风扇', noun: '风扇', icon: Fan },
};

function matches(device: Device, request: ActiveListRequest): boolean {
  return device.kind === request.kind && (!request.roomId || device.roomId === request.roomId);
}

function isOn(device: Device): boolean {
  return 'on' in device && device.available && device.on;
}

function detail(device: Device): string {
  if (!device.available) return '不可用';
  if (device.kind === 'light') {
    if (!device.on) return '已关闭';
    return [device.brightness !== undefined ? `亮度 ${device.brightness}%` : '', device.activeColorMode === 'color_temp' && device.colorTemp ? `${device.colorTemp}K` : ''].filter(Boolean).join(' · ') || '已打开';
  }
  if (isClimate(device)) {
    if (!device.on) return '已关闭';
    return [hvacModeLabel(device.mode), `设定 ${device.target}°`, device.current !== undefined ? `室温 ${device.current}°` : ''].filter(Boolean).join(' · ');
  }
  if (device.kind === 'fan') {
    if (!device.on) return '已关闭';
    return [device.percentage !== undefined ? `风速 ${device.percentage}%` : '', device.presetMode ?? ''].filter(Boolean).join(' · ') || '已打开';
  }
  return '';
}

/**
 * 状态标签点开的列表：打开时开着的灯 / 空调 / 地暖，按房间分组，可逐个开关或一键全部关闭。
 * 列表以打开那一刻为准，在这里关掉的设备仍留在原位（可再打开）；只读模式只显示状态。
 */
export function ActiveDevicesDialog({ request, home, actions, canControl, onClose }: {
  request: ActiveListRequest | null;
  home: HomeState;
  actions: DeviceActions;
  canControl: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [ids, setIds] = useState<string[]>([]);
  const open = request !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 打开时记下当时开着的设备。
  useEffect(() => {
    if (request) setIds(home.devices.filter((device) => matches(device, request) && isOn(device)).map((device) => device.id));
    // 只在打开（或切换到另一类）时取快照，之后设备状态变化不改变列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return <dialog ref={dialogRef} className="device-dialog active-dialog" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose} />;

  const { on: title, noun, icon: KindIcon } = titles[request.kind];
  const listed = ids.map((id) => home.devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device));
  const stillOn = listed.filter(isOn);
  const scopeRoom = request.roomId ? home.rooms.find((room) => room.id === request.roomId) : undefined;
  const groups = home.rooms
    .map((room) => ({ room, devices: listed.filter((device) => device.roomId === room.id) }))
    .filter((group) => group.devices.length > 0);
  const ungrouped = listed.filter((device) => !home.rooms.some((room) => room.id === device.roomId));
  if (ungrouped.length > 0) groups.push({ room: { id: '', name: '其他', category: 'other' }, devices: ungrouped });

  return (
    <dialog ref={dialogRef} className="device-dialog active-dialog" aria-label={title} onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose}>
      <div className="device-dialog__heading">
        <div><small>{scopeRoom?.name ?? '全部房间'}</small><h2>{title}<em>{stillOn.length}</em></h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭列表"><X size={20} /></button>
      </div>
      {listed.length === 0 ? (
        <p className="active-dialog__empty">当前没有打开的{noun}。</p>
      ) : (
        <div className="active-dialog__groups">
          {groups.map(({ room, devices }) => (
            <section key={room.id || 'other'} className="active-dialog__group" aria-label={room.name}>
              {!scopeRoom && <h3>{room.name}</h3>}
              <ul>
                {devices.map((device) => {
                  const on = isOn(device);
                  return (
                    <li key={device.id} className={on ? 'is-on' : undefined}>
                      <span className="active-dialog__icon"><KindIcon size={18} /></span>
                      <span className="active-dialog__name"><strong>{device.name}</strong><small>{detail(device)}</small></span>
                      {canControl && device.available && (
                        <button type="button" role="switch" className="settings-switch" aria-checked={on} aria-label={`${on ? '关闭' : '打开'}${room.name}${device.name}`} onClick={() => actions.toggle(device.id)}><span /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {canControl ? (
        listed.length > 0 && (
          <div className="active-dialog__actions">
            <button type="button" className="small-button small-button--selected active-dialog__all-off" disabled={stillOn.length === 0} onClick={() => stillOn.forEach((device) => actions.turnOff(device.id))}>
              <Power size={15} />{stillOn.length > 0 ? `全部关闭（${stillOn.length}）` : `已全部关闭`}
            </button>
          </div>
        )
      ) : <p className="active-dialog__empty">只读模式，只能查看状态。</p>}
    </dialog>
  );
}
