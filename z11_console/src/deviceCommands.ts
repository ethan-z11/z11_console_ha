import { getLightVariant, supportsColor, supportsColorTemperature } from './light';
import { isClimate } from './selectors';
import type { Device, LightPatch } from './types';

export type DeviceCommand =
  | { type: 'toggle' }
  | { type: 'turnOff' }
  | { type: 'adjust'; delta: number }
  | { type: 'light'; patch: LightPatch }
  | { type: 'hvacMode'; mode: string }
  | { type: 'fanMode'; fanMode: string }
  | { type: 'swingMode'; swingMode: string }
  | { type: 'mediaPower' }
  | { type: 'mediaPlayPause' }
  | { type: 'mediaVolume'; volume: number }
  | { type: 'fanSpeed'; percentage: number }
  | { type: 'fanPreset'; preset: string }
  | { type: 'fanOscillate'; oscillating: boolean }
  | { type: 'coverOpen' }
  | { type: 'coverClose' }
  | { type: 'coverStop' }
  | { type: 'coverPosition'; position: number }
  | { type: 'vacuumStart' }
  | { type: 'vacuumPause' }
  | { type: 'vacuumReturn' }
  | { type: 'vacuumLocate' }
  | { type: 'vacuumFanSpeed'; fanSpeed: string };

/**
 * 按设备能力把操作应用到设备状态；不支持或不可用时原样返回同一个对象。
 * 演示模式直接用它改内存，HA 模式用它做乐观更新并判断是否需要调用服务。
 */
export function applyCommand(device: Device, command: DeviceCommand): Device {
  if (!device.available) return device;
  switch (command.type) {
    case 'toggle':
      if (device.kind === 'cover') {
        // 已打开或运动中按“收起（关闭）”处理，全关状态下重新打开。乐观值直接取终态，
        // 运动中的 opening/closing 由 HA 状态推送显示，避免确认期状态来回跳。
        const closing = device.state === 'open' || device.state === 'opening' || device.state === 'closing';
        return { ...device, state: closing ? 'closed' : 'open' };
      }
      if (device.kind === 'vacuum') {
        // 清扫 / 回充中点按为暂停，其余状态（回充完成、暂停、待机）点按开始清扫。
        const busy = device.status === 'cleaning' || device.status === 'returning';
        return { ...device, status: busy ? 'paused' : 'cleaning' };
      }
      return 'on' in device ? { ...device, on: !device.on } : device;
    case 'turnOff':
      // 明确关闭（用于“全部关闭”）：已关闭的不变，也就不会发送请求。
      if (device.kind === 'cover') return device.state === 'closed' ? device : { ...device, state: 'closed' };
      return 'on' in device && device.on ? { ...device, on: false } : device;
    case 'adjust':
      if (!isClimate(device) || !device.on) return device;
      return { ...device, target: Math.min(device.max, Math.max(device.min, device.target + command.delta)) };
    case 'light': {
      const { patch } = command;
      if (device.kind !== 'light' || getLightVariant(device) === 'switch') return device;
      if (patch.colorTemp !== undefined && !supportsColorTemperature(device)) return device;
      if (patch.color !== undefined && !supportsColor(device)) return device;
      const activeColorMode = patch.color !== undefined ? 'color' : patch.colorTemp !== undefined ? 'color_temp' : device.activeColorMode;
      return { ...device, ...patch, activeColorMode, on: true };
    }
    case 'hvacMode':
      if (!isClimate(device) || !device.hvacModes.includes(command.mode) || command.mode === 'off') return device;
      return { ...device, mode: command.mode, on: true };
    case 'fanMode':
      if (!isClimate(device) || !device.on || !device.fanModes?.includes(command.fanMode)) return device;
      return { ...device, fanMode: command.fanMode };
    case 'swingMode':
      if (!isClimate(device) || !device.swingModes?.includes(command.swingMode)) return device;
      return { ...device, swingMode: command.swingMode };
    case 'mediaPower':
      if (device.kind !== 'media' || !device.canPower) return device;
      return { ...device, status: device.status === 'off' ? 'idle' : 'off' };
    case 'mediaPlayPause':
      if (device.kind !== 'media' || !device.canPlayPause || device.status === 'off' || device.status === 'unknown') return device;
      return { ...device, status: device.status === 'playing' ? 'paused' : 'playing' };
    case 'mediaVolume':
      if (device.kind !== 'media' || device.volume === undefined) return device;
      return { ...device, volume: Math.min(100, Math.max(0, command.volume)) };
    case 'fanSpeed':
      // set_percentage 会同时打开风扇；不支持调速的设备忽略。
      if (device.kind !== 'fan' || device.percentage === undefined) return device;
      return { ...device, on: command.percentage > 0, percentage: Math.min(100, Math.max(0, command.percentage)) };
    case 'fanPreset':
      if (device.kind !== 'fan' || !device.presetModes?.includes(command.preset)) return device;
      return { ...device, on: true, presetMode: command.preset };
    case 'fanOscillate':
      // 不支持摇头（HA 无 oscillating 属性）的设备忽略。
      if (device.kind !== 'fan' || device.oscillating === undefined) return device;
      return { ...device, oscillating: command.oscillating };
    case 'coverOpen':
      if (device.kind !== 'cover' || device.state === 'open' || device.state === 'opening') return device;
      return { ...device, state: 'open' };
    case 'coverClose':
      if (device.kind !== 'cover' || device.state === 'closed' || device.state === 'closing') return device;
      return { ...device, state: 'closed' };
    case 'coverStop': {
      if (device.kind !== 'cover') return device;
      // 停止后 HA 会回到 open / closed：有位置时按位置推断，没有位置时按打开处理（可再点关闭）。
      const state = device.position === undefined ? 'open' : device.position <= 1 ? 'closed' : 'open';
      return { ...device, state };
    }
    case 'coverPosition': {
      if (device.kind !== 'cover' || !device.supportsPosition) return device;
      const position = Math.min(100, Math.max(0, command.position));
      return { ...device, position, state: position <= 0 ? 'closed' : 'open' };
    }
    case 'vacuumStart':
      return device.kind === 'vacuum' && device.status !== 'cleaning' ? { ...device, status: 'cleaning' } : device;
    case 'vacuumPause':
      return device.kind === 'vacuum' && device.status !== 'paused' ? { ...device, status: 'paused' } : device;
    case 'vacuumReturn':
      return device.kind === 'vacuum' && device.status !== 'docked' && device.status !== 'returning' ? { ...device, status: 'returning' } : device;
    case 'vacuumLocate':
      // 寻找只是让机器发声，不改变状态。
      return device;
    case 'vacuumFanSpeed':
      if (device.kind !== 'vacuum' || !device.fanSpeeds?.includes(command.fanSpeed)) return device;
      return { ...device, fanSpeed: command.fanSpeed };
  }
}
