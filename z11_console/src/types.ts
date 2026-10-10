export type TileSize = '1x1' | '2x1';

export interface Room {
  id: string;
  name: string;
  category: 'main' | 'other';
  /** 手动房间自定义图标键（icons.ts）；演示房间或未设置时为 undefined，按名称自动匹配。 */
  icon?: string;
}

interface BaseDevice {
  id: string;
  roomId: string;
  name: string;
  available: boolean;
  /** 设置里给该实体自定义的图标键；未设置时按类型 / 名称自动匹配。 */
  icon?: string;
  /** 子设备（绑定在灯 / 窗帘宿主下）：不单独显示卡片，只在宿主的设置弹窗里以大卡片展示与控制。 */
  hidden?: boolean;
}

export interface LightDevice extends BaseDevice {
  kind: 'light';
  on: boolean;
  supportedColorModes: string[];
  brightness?: number;
  colorTemp?: number;
  minColorTempKelvin?: number;
  maxColorTempKelvin?: number;
  color?: string;
  activeColorMode?: 'color' | 'color_temp';
}

export interface ClimateDevice extends BaseDevice {
  kind: 'climate' | 'heating';
  on: boolean;
  target: number;
  current?: number;
  mode: string;
  hvacModes: string[];
  fanMode?: string;
  fanModes?: string[];
  /** HA 空调的扫风模式（swing_mode）；不支持扫风时为 undefined。 */
  swingMode?: string;
  swingModes?: string[];
  min: number;
  max: number;
  step: number;
}

export interface SensorDevice extends BaseDevice {
  kind: 'sensor';
  value: string;
  unit: string;
  metric: 'temperature' | 'humidity';
  /** HA 的显示小数位；用于把 27.700006 这类原始状态格式化为 27.7。 */
  precision?: number;
}

export interface SafetyDevice extends BaseDevice {
  kind: 'safety';
  sensorType: 'door' | 'motion' | 'leak' | 'smoke';
  status: 'normal' | 'alert' | 'unknown';
  message: string;
}

export interface BatteryReading {
  id: string;
  roomId: string;
  name: string;
  level: number | null;
  available: boolean;
  /** 是否被设为首页常驻显示的那一个。 */
  highlight?: boolean;
}

export interface MediaDevice extends BaseDevice {
  kind: 'media';
  mediaType: 'tv' | 'speaker';
  status: 'off' | 'idle' | 'playing' | 'paused' | 'unknown';
  detail?: string;
  canPower?: boolean;
  canPlayPause?: boolean;
  volume?: number;
}

export interface FanDevice extends BaseDevice {
  kind: 'fan';
  on: boolean;
  /** 百分比风速 0–100；不支持调速的设备为 undefined。 */
  percentage?: number;
  presetMode?: string;
  presetModes?: string[];
  /** 是否正在摇头；HA 没有该属性（不支持摇头）时为 undefined，卡片不显示摇头开关。 */
  oscillating?: boolean;
}

export interface CoverDevice extends BaseDevice {
  kind: 'cover';
  state: 'open' | 'closed' | 'opening' | 'closing' | 'unknown';
  /** 当前开合位置 0（全关）–100（全开）；不支持位置反馈时为 undefined。 */
  position?: number;
  supportsPosition: boolean;
  supportsStop: boolean;
  /** HA 的 cover device_class：curtain / blind / shutter 等。 */
  coverClass?: string;
}

/** HA vacuum 状态：清扫中 / 已回充 / 暂停 / 待机 / 回充中 / 异常 / 未知。 */
export type VacuumStatus = 'cleaning' | 'docked' | 'paused' | 'idle' | 'returning' | 'error' | 'unknown';

export interface VacuumDevice extends BaseDevice {
  kind: 'vacuum';
  status: VacuumStatus;
  /** 电量百分比；HA 暂未上报时为 undefined。 */
  battery?: number;
  /** 当前清扫档位（fan_speed）。 */
  fanSpeed?: string;
  fanSpeeds?: string[];
  /** HA image 实体 id（清扫地图）；没有地图实体时为 undefined。 */
  mapEntity?: string;
}

/** 普通开关 / 智能插座（HA switch 域）：只有开与关，无其他控制。 */
export interface SwitchDevice extends BaseDevice {
  kind: 'switch';
  on: boolean;
}

export type Device = LightDevice | ClimateDevice | SensorDevice | SafetyDevice | MediaDevice | FanDevice | CoverDevice | VacuumDevice | SwitchDevice;

export interface Person {
  id: string;
  name: string;
  status: 'home' | 'away' | 'unknown';
  source: string;
}

export interface HomeState {
  rooms: Room[];
  devices: Device[];
  batteries: BatteryReading[];
  people: Person[];
}

export type LightPatch = Partial<Pick<LightDevice, 'brightness' | 'colorTemp' | 'color'>>;

/** 设备卡可触发的操作；目前只改内存中的模拟状态，接入 HA 时在这一层换成服务调用。 */
export interface DeviceActions {
  toggle: (id: string) => void;
  /** 明确关闭（灯、空调、地暖）；已关闭的不发送请求。 */
  turnOff: (id: string) => void;
  adjust: (id: string, delta: number) => void;
  changeLight: (id: string, patch: LightPatch) => void;
  changeClimateMode: (id: string, mode: string) => void;
  changeFanMode: (id: string, fanMode: string) => void;
  /** 空调扫风模式（climate.set_swing_mode）；不支持扫风的设备不显示。 */
  setSwingMode: (id: string, swingMode: string) => void;
  mediaPower: (id: string) => void;
  mediaPlayPause: (id: string) => void;
  mediaVolume: (id: string, volume: number) => void;
  /** 风扇百分比风速（0–100）。 */
  changeFanSpeed: (id: string, percentage: number) => void;
  /** 风扇预设风类（直吹风 / 自然风 / 进风 等）。 */
  changeFanPreset: (id: string, preset: string) => void;
  /** 风扇摇头开关（仅支持摇头的设备可用）。 */
  setFanOscillate: (id: string, oscillating: boolean) => void;
  coverOpen: (id: string) => void;
  coverClose: (id: string) => void;
  coverStop: (id: string) => void;
  coverPosition: (id: string, position: number) => void;
  /** 扫地机器人：开始清扫 / 暂停 / 回充 / 寻找 / 设置清扫档位。 */
  vacuumStart: (id: string) => void;
  vacuumPause: (id: string) => void;
  vacuumReturn: (id: string) => void;
  vacuumLocate: (id: string) => void;
  vacuumFanSpeed: (id: string, fanSpeed: string) => void;
}

export interface LayoutState {
  sizes: Record<string, TileSize>;
  order: Record<string, string[]>;
  /** 全屋“常用设备”的设备 id 与顺序；未设置过时使用默认清单。 */
  favorites?: string[];
  /** 导航中的房间顺序（房间 id）；未列出的房间按自动发现 / 演示数据的原顺序排在后面。 */
  rooms?: string[];
}
