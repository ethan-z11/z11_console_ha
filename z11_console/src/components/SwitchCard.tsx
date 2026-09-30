import { deviceIcon } from '../appearance';
import type { Room, SwitchDevice } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

interface SwitchCardProps {
  layout: TileLayoutProps;
  device: SwitchDevice;
  room: Room;
  onToggle: (id: string) => void;
}

/** 普通开关 / 智能插座卡片：只有开与关，点卡片任意位置或电源按钮即翻转，无需弹窗。 */
export function SwitchCard({ layout, device, room, onToggle }: SwitchCardProps) {
  const { editing } = layout;
  const DeviceIcon = deviceIcon(device);
  const disabled = !device.available || Boolean(editing);
  const status = !device.available ? '设备不可用' : device.on ? '已打开' : '已关闭';

  return (
    <TileFrame {...layout} className="light-card light-card--switch switch-card" active={device.on} onOpen={device.available ? () => onToggle(device.id) : undefined}>
      <div className="tile__top">
        <button type="button" className="tile__power" onClick={() => onToggle(device.id)} disabled={disabled} aria-label={`${device.on ? '关闭' : '打开'}${room.name}${device.name}`} aria-pressed={device.on}><DeviceIcon size={21} /></button>
        <span className="tile__room">{room.name}</span>
      </div>
      <div className="light-card__compact-bottom">
        <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{device.name}</span><span className="tile__note">{status}</span></div>
      </div>
    </TileFrame>
  );
}
