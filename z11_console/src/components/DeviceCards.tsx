import { Home } from 'lucide-react';
import { allowedSizesForDevice } from '../layout';
import { isClimate } from '../selectors';
import type { CoverDevice, Device, DeviceActions, LightDevice, Room } from '../types';
import { ClimateCard } from './ClimateCard';
import { CoverCard } from './CoverCard';
import { FanCard } from './FanCard';
import { LightCard } from './LightCard';
import { MediaPlayerCard } from './MediaPlayerCard';
import { SwitchCard } from './SwitchCard';
import { VacuumCard } from './VacuumCard';
import type { TileLayoutProps } from './TileFrame';

export type TilePlacement = Omit<TileLayoutProps, 'id' | 'label' | 'allowedSizes'>;

interface DeviceCardProps {
  device: Device;
  room: Room;
  tile: TilePlacement;
  actions: DeviceActions;
  onOpenClimate: (id: string) => void;
  /** 季节限制说明（如夏季的地暖显示“夏季停用”）；只影响温控卡片的显示。 */
  seasonLock?: string;
  /** 绑定的子设备（hidden）：显示在宿主设置弹窗里，不单独显示卡片。 */
  childDevices?: Device[];
}

/** 按设备类型选择卡片；只读传感器与安全告警不进网格，由顶部摘要显示。 */
export function DeviceCard({ device, room, tile, actions, onOpenClimate, seasonLock, childDevices }: DeviceCardProps) {
  const layout: TileLayoutProps = { ...tile, id: device.id, label: `${room.name}${device.name}`, allowedSizes: allowedSizesForDevice(device) };

  if (device.kind === 'light') {
    return <LightCard layout={layout} light={device} room={room} onToggle={actions.toggle} onChange={actions.changeLight} childDevices={childDevices?.filter((item): item is LightDevice => item.kind === 'light')} />;
  }

  if (device.kind === 'media') {
    return <MediaPlayerCard layout={layout} media={device} room={room} onPower={actions.mediaPower} onPlayPause={actions.mediaPlayPause} onVolume={actions.mediaVolume} />;
  }

  if (isClimate(device)) {
    return <ClimateCard layout={layout} climate={device} room={room} onToggle={actions.toggle} onAdjust={actions.adjust} onOpenDetails={onOpenClimate} seasonLock={seasonLock} />;
  }

  if (device.kind === 'fan') {
    return <FanCard layout={layout} fan={device} room={room} onToggle={actions.toggle} onSpeed={actions.changeFanSpeed} onPreset={actions.changeFanPreset} onOscillate={actions.setFanOscillate} />;
  }

  if (device.kind === 'cover') {
    return <CoverCard layout={layout} cover={device} room={room} onOpen={actions.coverOpen} onClose={actions.coverClose} onStop={actions.coverStop} onPosition={actions.coverPosition} childDevices={childDevices?.filter((item): item is CoverDevice => item.kind === 'cover')} />;
  }

  if (device.kind === 'vacuum') {
    return <VacuumCard layout={layout} vacuum={device} room={room} onToggle={actions.toggle} onStart={actions.vacuumStart} onPause={actions.vacuumPause} onReturn={actions.vacuumReturn} onLocate={actions.vacuumLocate} onFanSpeed={actions.vacuumFanSpeed} />;
  }

  if (device.kind === 'switch') {
    return <SwitchCard layout={layout} device={device} room={room} onToggle={actions.toggle} />;
  }

  return null;
}

export function EmptyRoomCard({ name }: { name: string }) {
  return <div className="empty-room"><span className="tile__chip"><Home size={20} /></span><p>{name}目前只有模拟清单中已确认的设备。</p></div>;
}
