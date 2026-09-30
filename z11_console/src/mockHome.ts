import type { Device, HomeState, LightDevice } from './types';

const light = (id: string, roomId: string, name: string, on = false, options: Partial<Pick<LightDevice, 'supportedColorModes' | 'brightness' | 'colorTemp' | 'minColorTempKelvin' | 'maxColorTempKelvin' | 'color'>> = {}): LightDevice => ({
  id, roomId, name, kind: 'light', available: true, on, supportedColorModes: ['onoff'], ...options,
});

const devices: Device[] = [
  light('living-entry', 'living', '入户灯'),
  light('living-edge', 'living', '边灯'),
  light('living-background', 'living', '背景灯', true),
  light('living-surround', 'living', '环绕灯'),
  light('living-spot', 'living', '环岛射灯'),
  light('living-balcony', 'living', '阳台灯'),
  light('dining-ceiling', 'dining', '顶灯'),
  light('dining-surround', 'dining', '环绕灯', true),
  light('dining-spot', 'dining', '环绕射灯'),
  light('dining-storage', 'dining', '储物灯'),
  light('master-ceiling', 'master', '顶灯', false, { supportedColorModes: ['color_temp'], brightness: 50, colorTemp: 4000, minColorTempKelvin: 2700, maxColorTempKelvin: 6500 }),
  light('master-wardrobe', 'master', '衣帽间灯', true),
  light('master-foot', 'master', '床尾灯'),
  light('master-bedstrip', 'master', '床下灯带', false, { supportedColorModes: ['color_temp', 'hs'], brightness: 45, colorTemp: 3000, minColorTempKelvin: 2702, maxColorTempKelvin: 6535, color: '#ffb35c' }),
  light('child-stars', 'child', '星空灯', false, { supportedColorModes: ['color_temp'], brightness: 60, colorTemp: 4000, minColorTempKelvin: 2700, maxColorTempKelvin: 6500 }),
  light('child-desk', 'child', '大台灯', false, { supportedColorModes: ['brightness'], brightness: 60 }),
  light('second-stars', 'second', '星空灯', false, { supportedColorModes: ['color_temp'], brightness: 60, colorTemp: 4000, minColorTempKelvin: 2700, maxColorTempKelvin: 6500 }),
  light('second-spot', 'second', '床左射灯'),
  light('mainbath-ceiling', 'mainbath', '顶灯'),
  light('mainbath-mirror', 'mainbath', '镜前灯', true),
  light('bath-ceiling', 'bath', '顶灯'),
  light('bath-shower', 'bath', '淋浴灯'),
  {
    id: 'living-ac', roomId: 'living', name: '空调', kind: 'climate', available: true,
    on: false, target: 26, current: 28, mode: 'cool', hvacModes: ['heat', 'dry', 'fan_only', 'auto', 'off', 'cool'],
    fanMode: 'low', fanModes: ['low', 'medium', 'high', 'auto'], min: 16, max: 30, step: 1,
  },
  ...(['dining', 'master', 'child', 'second'] as const).map((roomId) => ({
    id: `${roomId}-ac`, roomId, name: '空调', kind: 'climate' as const, available: true,
    on: false, target: 26, mode: 'cool', hvacModes: ['heat', 'dry', 'fan_only', 'auto', 'off', 'cool'],
    fanMode: { dining: 'low', master: 'low', child: 'auto', second: 'medium' }[roomId],
    fanModes: ['low', 'medium', 'high', 'auto'], min: 16, max: 30, step: 1,
  })),
  ...(['living', 'dining', 'study'] as const).map((roomId) => ({
    id: `${roomId}-heating`, roomId, name: '制热', kind: 'heating' as const, available: true,
    on: false, target: 22, mode: 'heat', hvacModes: ['heat', 'off'], min: 16, max: 32, step: 0.5,
  })),
  { id: 'living-temp', roomId: 'living', name: '温度', kind: 'sensor', available: true, value: '28', unit: '°C', metric: 'temperature' },
  { id: 'living-humidity', roomId: 'living', name: '湿度', kind: 'sensor', available: true, value: '71', unit: '%', metric: 'humidity' },
  { id: 'dining-humidity', roomId: 'dining', name: '湿度', kind: 'sensor', available: true, value: '74', unit: '%', metric: 'humidity' },
  { id: 'kitchen-temp', roomId: 'kitchen', name: '温度', kind: 'sensor', available: true, value: '28.5', unit: '°C', metric: 'temperature' },
  { id: 'kitchen-humidity', roomId: 'kitchen', name: '湿度', kind: 'sensor', available: true, value: '72', unit: '%', metric: 'humidity' },
  { id: 'living-door', roomId: 'living', name: '入户门', kind: 'safety', sensorType: 'door', available: true, status: 'normal', message: '已关闭' },
  { id: 'mainbath-leak', roomId: 'mainbath', name: '水浸', kind: 'safety', sensorType: 'leak', available: true, status: 'normal', message: '未检测到水浸' },
  { id: 'bath-motion', roomId: 'bath', name: '移动', kind: 'safety', sensorType: 'motion', available: true, status: 'normal', message: '未检测到移动' },
  { id: 'kitchen-leak', roomId: 'kitchen', name: '水浸', kind: 'safety', sensorType: 'leak', available: true, status: 'normal', message: '未检测到水浸' },
  { id: 'kitchen-smoke', roomId: 'kitchen', name: '烟雾', kind: 'safety', sensorType: 'smoke', available: true, status: 'normal', message: '未检测到烟雾' },
  { id: 'living-apple-tv', roomId: 'living', name: 'AppleTV', kind: 'media', mediaType: 'tv', available: true, status: 'off', canPower: true, canPlayPause: true },
  { id: 'living-leftpod', roomId: 'living', name: 'LeftPod', kind: 'media', mediaType: 'speaker', available: true, status: 'idle', canPlayPause: true, volume: 40 },
  { id: 'living-rightpod', roomId: 'living', name: 'RightPod', kind: 'media', mediaType: 'speaker', available: true, status: 'idle', canPlayPause: true, volume: 35 },
  { id: 'living-vacuum', roomId: 'living', name: '小智', kind: 'vacuum', available: true, status: 'docked', battery: 88, fanSpeed: '标准', fanSpeeds: ['安静', '标准', '强力'] },
  { id: 'living-plug', roomId: 'living', name: '客厅插座', kind: 'switch', available: true, on: false },
];

/** 全屋页“常用设备”的默认清单；用户在编辑布局里加星后以 localStorage 中的为准。 */
export const defaultFavoriteIds = ['living-ac', 'living-background', 'living-apple-tv'];

export const mockHome: HomeState = {
  rooms: [
    { id: 'living', name: '客厅', category: 'main' },
    { id: 'dining', name: '餐厅', category: 'main' },
    { id: 'master', name: '主卧', category: 'main' },
    { id: 'child', name: '儿童房', category: 'main' },
    { id: 'second', name: '次卧', category: 'main' },
    { id: 'mainbath', name: '主卫', category: 'main' },
    { id: 'bath', name: '次卫', category: 'main' },
    { id: 'kitchen', name: '厨房', category: 'main' },
    { id: 'study', name: '书房', category: 'other' },
  ],
  devices,
  batteries: [
    { id: 'living-motion-battery', roomId: 'living', name: '入户门移动传感器', level: 92, available: true },
    { id: 'living-environment-battery', roomId: 'living', name: '温湿度传感器', level: 100, available: true },
    { id: 'kitchen-leak-battery', roomId: 'kitchen', name: '水浸传感器', level: 100, available: true },
    { id: 'mainbath-leak-battery', roomId: 'mainbath', name: '浸水传感器', level: 100, available: true },
    { id: 'second-environment-battery', roomId: 'second', name: '温湿度传感器', level: 100, available: true },
    { id: 'master-wireless-battery', roomId: 'master', name: '衣帽间无线开关', level: null, available: false },
  ],
  people: [
    { id: 'haiyang', name: '海洋', status: 'away', source: 'UniFi' },
    { id: 'beibei', name: '贝贝', status: 'home', source: 'UniFi' },
  ],
};
