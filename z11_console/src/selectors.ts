import type { ClimateDevice, Device, FanDevice, HomeState, LightDevice, SafetyDevice } from './types';

export function isClimate(device: Device): device is ClimateDevice {
  return device.kind === 'climate' || device.kind === 'heating';
}

export function isLit(device: Device): device is LightDevice {
  return device.kind === 'light' && device.available && device.on;
}

/** 需要提示的安全告警：只有水浸和烟雾。门窗打开、人体移动只作普通状态显示。 */
export function isActiveAlert(device: Device): device is SafetyDevice {
  return device.kind === 'safety' && (device.sensorType === 'leak' || device.sensorType === 'smoke') && device.available && device.status === 'alert';
}

/** 打开着的门窗（门磁为“开”），作为普通状态显示。 */
export function isOpenDoor(device: Device): device is SafetyDevice {
  return device.kind === 'safety' && device.sensorType === 'door' && device.available && device.status === 'alert';
}

/** 运行中的温控在摘要里只分冷暖两色：地暖和制热为暖，其余为冷。 */
export function climateSummaryTone(device: ClimateDevice): 'heat' | 'cool' {
  return device.kind === 'heating' || device.mode === 'heat' ? 'heat' : 'cool';
}

/** 设备卡只放可操控的设备；只读传感器和告警进顶部摘要。 */
function isControllable(device: Device): boolean {
  if (device.kind === 'light' || isClimate(device) || device.kind === 'fan' || device.kind === 'cover' || device.kind === 'vacuum' || device.kind === 'switch') return true;
  return device.kind === 'media' && Boolean(device.canPower || device.canPlayPause || device.volume !== undefined);
}

const roomOrder: Record<Device['kind'], number> = { light: 0, climate: 1, heating: 2, fan: 3, cover: 4, media: 5, vacuum: 6, switch: 7, sensor: 9, safety: 9 };

export function getRoomDevices(home: HomeState, roomId: string): Device[] {
  return home.devices
    .filter((device) => device.roomId === roomId && !device.hidden && isControllable(device))
    .sort((a, b) => roomOrder[a.kind] - roomOrder[b.kind]);
}

export type ActivityTone = 'alert' | 'light' | 'heat' | 'cool' | 'media';

export function getRoomActivity(home: HomeState, roomId: string): { key: string; tone: ActivityTone; label: string }[] {
  const devices = home.devices.filter((device) => device.roomId === roomId && !device.hidden);
  const lit = devices.filter(isLit).length;
  const runningClimate = devices.filter((device): device is ClimateDevice => isClimate(device) && device.available && device.on);
  const runningFans = devices.filter((device): device is FanDevice => device.kind === 'fan' && device.available && device.on);
  const playing = devices.filter((device) => device.kind === 'media' && device.available && device.status === 'playing');
  return [
    ...devices.filter(isActiveAlert).map((device) => ({ key: device.id, tone: 'alert' as const, label: `${device.name}报警` })),
    ...(lit > 0 ? [{ key: 'lit', tone: 'light' as const, label: `${lit} 盏灯亮` }] : []),
    ...runningClimate.map((device) => ({ key: device.id, tone: climateSummaryTone(device), label: `${device.name}运行` })),
    ...runningFans.map((device) => ({ key: device.id, tone: 'cool' as const, label: `${device.name}运行` })),
    ...playing.map((device) => ({ key: device.id, tone: 'media' as const, label: `${device.name}播放中` })),
  ];
}

export function isRunning(device: Device): boolean {
  if (!device.available) return false;
  if (device.kind === 'light' || isClimate(device) || device.kind === 'fan' || device.kind === 'switch') return device.on;
  if (device.kind === 'vacuum') return device.status === 'cleaning' || device.status === 'returning';
  if (device.kind === 'media') return device.status === 'playing' || device.status === 'paused' || (Boolean(device.canPower) && device.status === 'idle');
  return false;
}

export function runningDeviceIds(home: HomeState): string[] {
  // 子设备（hidden）不进「正在运行」列表，也不参与一键关闭：只通过宿主设置弹窗控制。
  return home.devices.filter((device) => !device.hidden && isRunning(device)).map((device) => device.id);
}

const runningOrder: Record<Device['kind'], number> = { climate: 0, heating: 1, fan: 2, light: 3, media: 4, vacuum: 5, switch: 6, cover: 9, sensor: 9, safety: 9 };

/** 全屋“正在运行”：按空调、地暖、灯、播放器排序，同类按房间顺序。 */
export function sortRunning(home: HomeState, devices: Device[]): Device[] {
  const roomIndex = new Map(home.rooms.map((room, index) => [room.id, index]));
  const deviceIndex = new Map(home.devices.map((device, index) => [device.id, index]));
  return [...devices].sort((a, b) => runningOrder[a.kind] - runningOrder[b.kind]
    || (roomIndex.get(a.roomId) ?? 99) - (roomIndex.get(b.roomId) ?? 99)
    || (deviceIndex.get(a.id) ?? 0) - (deviceIndex.get(b.id) ?? 0));
}
