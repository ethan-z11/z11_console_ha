import type { DeviceCommand } from './deviceCommands';
import type { Catalogue, CatalogueEntity, CustomConfig, EntityState, MetricName } from './consoleClient';
import type { BatteryReading, ClimateDevice, CoverDevice, Device, FanDevice, HomeState, LightDevice, MediaDevice, Person, Room, SafetyDevice, SensorDevice, SwitchDevice, VacuumDevice } from './types';

type States = Map<string, EntityState>;

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

function usable(state: EntityState | undefined): state is EntityState {
  return Boolean(state && state.state !== 'unavailable' && state.state !== 'unknown');
}

const hex = (parts: number[]) => `#${parts.map((part) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('')}`;

function hsToHex(hue: number, saturation: number): string {
  const s = saturation / 100;
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return 255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return hex([f(5), f(3), f(1)]);
}

function lightColor(attributes: Record<string, unknown>): string | undefined {
  const rgb = attributes.rgb_color;
  if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((part) => typeof part === 'number')) return hex(rgb);
  const hs = attributes.hs_color;
  if (Array.isArray(hs) && hs.length === 2 && hs.every((part) => typeof part === 'number')) return hsToHex(hs[0], hs[1]);
  return undefined;
}

const colorModes = ['hs', 'rgb', 'xy', 'rgbw', 'rgbww'];

function toLight(base: LightDevice, previous: LightDevice | undefined, state: EntityState): LightDevice {
  const a = state.attributes;
  const brightness = num(a.brightness);
  const colorMode = str(a.color_mode);
  return {
    ...base,
    available: true,
    on: state.state === 'on',
    supportedColorModes: strings(a.supported_color_modes) ?? ['onoff'],
    brightness: brightness !== undefined ? Math.max(1, Math.round(brightness / 255 * 100)) : previous?.brightness,
    colorTemp: num(a.color_temp_kelvin) ?? previous?.colorTemp,
    minColorTempKelvin: num(a.min_color_temp_kelvin),
    maxColorTempKelvin: num(a.max_color_temp_kelvin),
    color: lightColor(a) ?? previous?.color,
    activeColorMode: colorMode === 'color_temp' ? 'color_temp' : colorMode && colorModes.includes(colorMode) ? 'color' : previous?.activeColorMode,
  };
}

function toClimate(base: ClimateDevice, previous: ClimateDevice | undefined, state: EntityState): ClimateDevice {
  const a = state.attributes;
  const on = state.state !== 'off';
  return {
    ...base,
    available: true,
    on,
    // 关闭时 HA 状态为 off，保留上次的运行模式用于显示“已关闭 · 制冷”和重新打开。
    mode: on ? state.state : previous?.mode ?? base.mode,
    target: num(a.temperature) ?? previous?.target ?? base.target,
    current: num(a.current_temperature),
    hvacModes: strings(a.hvac_modes) ?? base.hvacModes,
    fanMode: str(a.fan_mode),
    fanModes: strings(a.fan_modes),
    swingMode: str(a.swing_mode),
    swingModes: strings(a.swing_modes),
    min: num(a.min_temp) ?? base.min,
    max: num(a.max_temp) ?? base.max,
    step: num(a.target_temp_step) ?? base.step,
  };
}

// media_player 的 supported_features 位
const feature = { pause: 1, volumeSet: 4, turnOn: 128, turnOff: 256, play: 16384 };
const mediaStatus: Record<string, MediaDevice['status']> = { off: 'off', standby: 'off', idle: 'idle', on: 'idle', playing: 'playing', paused: 'paused', buffering: 'playing' };

function toMedia(base: MediaDevice, previous: MediaDevice | undefined, state: EntityState): MediaDevice {
  const a = state.attributes;
  const features = num(a.supported_features) ?? 0;
  const volume = num(a.volume_level);
  return {
    ...base,
    available: true,
    status: mediaStatus[state.state] ?? 'unknown',
    detail: str(a.media_title) ?? str(a.app_name),
    canPower: Boolean(features & (feature.turnOn | feature.turnOff)),
    canPlayPause: Boolean(features & (feature.play | feature.pause)),
    volume: features & feature.volumeSet ? volume !== undefined ? Math.round(volume * 100) : previous?.volume : undefined,
  };
}

function toFan(base: FanDevice, previous: FanDevice | undefined, state: EntityState): FanDevice {
  const a = state.attributes;
  const percentage = num(a.percentage);
  const hasOscillate = typeof a.oscillating === 'boolean';
  return {
    ...base,
    available: true,
    on: state.state === 'on',
    // 关风扇后 HA 不再上报 percentage，保留上次值用于滑杆回显与下次开机。
    percentage: percentage !== undefined ? Math.round(percentage) : previous?.percentage,
    presetMode: str(a.preset_mode),
    presetModes: strings(a.preset_modes) ?? previous?.presetModes,
    // oscillating 属性存在即代表支持摇头；属性暂缺时沿用上次的能力标记与状态。
    oscillating: hasOscillate ? Boolean(a.oscillating) : previous?.oscillating,
  };
}

// CoverEntityFeature 位：OPEN=1, CLOSE=2, SET_POSITION=4, STOP=8。
const coverFeature = { open: 1, close: 2, setPosition: 4, stop: 8 };
const coverStates = new Set(['open', 'closed', 'opening', 'closing']);

function toCover(base: CoverDevice, previous: CoverDevice | undefined, state: EntityState): CoverDevice {
  const a = state.attributes;
  const features = num(a.supported_features) ?? 0;
  const position = num(a.current_position);
  return {
    ...base,
    available: true,
    state: coverStates.has(state.state) ? state.state as CoverDevice['state'] : 'unknown',
    position: position !== undefined ? Math.round(position) : previous?.position,
    supportsPosition: Boolean(features & coverFeature.setPosition),
    supportsStop: Boolean(features & coverFeature.stop),
    coverClass: str(a.device_class),
  };
}

const vacuumStatuses = new Set(['cleaning', 'docked', 'paused', 'idle', 'returning', 'error']);

function toVacuum(base: VacuumDevice, previous: VacuumDevice | undefined, state: EntityState): VacuumDevice {
  const a = state.attributes;
  const battery = num(a.battery_level);
  return {
    ...base,
    available: true,
    status: vacuumStatuses.has(state.state) ? state.state as VacuumDevice['status'] : 'unknown',
    battery: battery !== undefined ? Math.round(battery) : previous?.battery,
    fanSpeed: str(a.fan_speed) ?? previous?.fanSpeed,
    fanSpeeds: strings(a.fan_speed_list) ?? previous?.fanSpeeds,
  };
}

/** 普通开关：state 仅 on/off。 */
function toSwitch(base: SwitchDevice, state: EntityState): SwitchDevice {
  return { ...base, available: true, on: state.state === 'on' };
}

const HOME_SCOPE = 'home';
const METRIC_UNIT: Record<MetricName, string> = { temperature: '°C', humidity: '%' };

/** 读取温湿度来源当前数值：state 状态值或指定属性，非有限数字返回 undefined（按不可用处理）。 */
function readMetric(state: EntityState | undefined, attribute: string): number | undefined {
  if (!usable(state)) return undefined;
  const raw = attribute === 'state' ? state.state : state.attributes[attribute];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function formatMetric(metric: MetricName, value: number): string {
  return metric === 'temperature' ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** HA 没给显示精度时的兜底：温度最多 1 位小数，湿度取整。 */
const fallbackPrecision: Record<SensorDevice['metric'], number> = { temperature: 1, humidity: 0 };

/** 按 HA 显示精度格式化数值状态（27.700006 → 27.7）；没有精度时按兜底位数去掉浮点误差、不补零；非数值状态原样保留。 */
function formatSensorValue(raw: string, metric: SensorDevice['metric'], precision: number | undefined): string {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return raw;
  return precision !== undefined ? value.toFixed(precision) : String(Number(value.toFixed(fallbackPrecision[metric])));
}

function toSensor(base: SensorDevice, state: EntityState): SensorDevice {
  return { ...base, available: true, value: formatSensorValue(state.state, base.metric, base.precision), unit: str(state.attributes.unit_of_measurement) ?? base.unit };
}

const safetyMessages: Record<SafetyDevice['sensorType'], [string, string]> = {
  door: ['已打开', '已关闭'],
  motion: ['检测到移动', '未检测到移动'],
  leak: ['检测到水浸', '未检测到水浸'],
  smoke: ['检测到烟雾', '未检测到烟雾'],
};

function toSafety(base: SafetyDevice, state: EntityState): SafetyDevice {
  const status = state.state === 'on' ? 'alert' : state.state === 'off' ? 'normal' : 'unknown';
  const [alertText, normalText] = safetyMessages[base.sensorType];
  return { ...base, available: true, status, message: status === 'alert' ? alertText : status === 'normal' ? normalText : '状态未知' };
}

function toDevice(base: Device, previous: Device | undefined, state: EntityState): Device {
  switch (base.kind) {
    case 'light': return toLight(base, previous?.kind === 'light' ? previous : undefined, state);
    case 'climate':
    case 'heating': return toClimate(base, previous && (previous.kind === 'climate' || previous.kind === 'heating') ? previous : undefined, state);
    case 'media': return toMedia(base, previous?.kind === 'media' ? previous : undefined, state);
    case 'fan': return toFan(base, previous?.kind === 'fan' ? previous : undefined, state);
    case 'cover': return toCover(base, previous?.kind === 'cover' ? previous : undefined, state);
    case 'vacuum': return toVacuum(base, previous?.kind === 'vacuum' ? previous : undefined, state);
    case 'switch': return toSwitch(base, state);
    case 'sensor': return toSensor(base, state);
    case 'safety': return toSafety(base, state);
  }
}

const safetyTypes: Record<string, SafetyDevice['sensorType']> = {
  door: 'door', window: 'door', opening: 'door', garage_door: 'door',
  motion: 'motion', occupancy: 'motion', presence: 'motion',
  moisture: 'leak',
  smoke: 'smoke', gas: 'smoke', carbon_monoxide: 'smoke',
};

/** 只能制热（或只有制热和关闭）的温控按地暖显示。 */
function isHeatingOnly(state: EntityState | undefined): boolean {
  const modes = strings(state?.attributes.hvac_modes);
  return Boolean(modes && modes.length > 0 && modes.every((mode) => mode === 'heat' || mode === 'off'));
}

/** 由目录条目生成设备骨架（尚无状态时的默认值）；非设备卡类实体返回 null。 */
function baseDevice(entity: CatalogueEntity, roomId: string, state: EntityState | undefined): Device | null {
  const common = { id: entity.id, roomId, name: entity.name, available: false };
  switch (entity.domain) {
    case 'light':
      return { ...common, kind: 'light', on: false, supportedColorModes: ['onoff'] };
    case 'climate': {
      const heating = isHeatingOnly(state);
      return { ...common, kind: heating ? 'heating' : 'climate', on: false, target: 0, mode: heating ? 'heat' : 'cool', hvacModes: [], min: 5, max: 35, step: heating ? 0.5 : 1 };
    }
    case 'media_player':
      return { ...common, kind: 'media', mediaType: entity.deviceClass === 'speaker' ? 'speaker' : 'tv', status: 'unknown' };
    case 'fan':
      // fan 域混入了新风机 / 浴霸换气，卡片按通用风扇处理，能力由状态属性补齐。
      return { ...common, kind: 'fan', on: false };
    case 'cover':
      return { ...common, kind: 'cover', state: 'unknown', supportsPosition: false, supportsStop: false };
    case 'vacuum':
      return { ...common, kind: 'vacuum', status: 'unknown', mapEntity: entity.mapEntityId };
    case 'switch':
    case 'input_boolean':
      // HA 助手布尔开关（input_boolean）与普通开关同样只有 on/off，统一成开关卡片。
      return { ...common, kind: 'switch', on: false };
    case 'sensor':
      if (entity.deviceClass !== 'temperature' && entity.deviceClass !== 'humidity') return null;
      return { ...common, kind: 'sensor', metric: entity.deviceClass, value: '', unit: entity.deviceClass === 'temperature' ? '°C' : '%', precision: entity.precision };
    case 'binary_sensor': {
      const sensorType = entity.deviceClass ? safetyTypes[entity.deviceClass] : undefined;
      return sensorType ? { ...common, kind: 'safety', sensorType, status: 'unknown', message: '状态未知' } : null;
    }
    default:
      return null;
  }
}

/**
 * 情景按钮可指向的“一键执行”类实体域，与后端 discovery.SCENE_DOMAINS /
 * store.SCENE_TARGET_DOMAINS 保持一致（很多家庭的情景实际是无线开关的 button 实体或自动化）。
 */
export const SCENE_TARGET_DOMAINS = new Set(['scene', 'script', 'button', 'input_button', 'automation']);

export function isSceneTarget(entity: Pick<CatalogueEntity, 'domain'>): boolean {
  return SCENE_TARGET_DOMAINS.has(entity.domain);
}

/** 各域一键执行对应的 HA 服务：scene/script 为 turn_on，button/input_button 为 press，automation 为 trigger。 */
export function sceneTargetService(entityId: string): string {
  const domain = entityId.split('.')[0];
  return domain === 'button' || domain === 'input_button' ? 'press' : domain === 'automation' ? 'trigger' : 'turn_on';
}

/** 情景按钮显示名：设置中未命名时回退到目标实体的名称，实体也查不到时显示实体 id。 */
export function sceneDisplayName(scene: { name: string; entity: string }, entities: readonly Pick<CatalogueEntity, 'id' | 'name'>[]): string {
  if (scene.name.trim()) return scene.name;
  return entities.find((entity) => entity.id === scene.entity)?.name ?? scene.entity;
}

/** 设置页显示用的实体类型名称。 */
export function entityKindLabel(entity: Pick<CatalogueEntity, 'domain' | 'deviceClass'>): string {
  switch (entity.domain) {
    case 'light': return '灯';
    case 'climate': return '温控';
    case 'media_player': return '播放器';
    case 'fan': return '风扇';
    case 'cover': {
      if (entity.deviceClass === 'blind') return '百叶帘';
      if (entity.deviceClass === 'shutter' || entity.deviceClass === 'shade') return '卷帘';
      if (entity.deviceClass === 'window') return '窗';
      if (entity.deviceClass === 'garage') return '车库门';
      return '窗帘';
    }
    case 'vacuum': return '扫地机';
    case 'switch':
    case 'input_boolean': return '开关';
    case 'scene': return '场景';
    case 'script': return '脚本';
    case 'button': return '按钮';
    case 'input_button': return '虚拟按钮';
    case 'automation': return '自动化';
    case 'person': return '人员';
    case 'sensor': return entity.deviceClass === 'temperature' ? '温度' : entity.deviceClass === 'humidity' ? '湿度' : entity.deviceClass === 'lunar' ? '农历' : '电量';
    case 'binary_sensor': {
      const type = entity.deviceClass ? safetyTypes[entity.deviceClass] : undefined;
      return type === 'door' ? '门窗' : type === 'motion' ? '人体' : type === 'leak' ? '水浸' : '烟雾';
    }
    default: return entity.domain;
  }
}

const EMPTY_CUSTOM: CustomConfig = { rooms: [], assignments: {}, scenes: [], entities: {}, cameras: [], metricSources: [], occupancy: {} };

/**
 * 以后端发现并过滤后的目录为骨架，用 HA 实时状态生成页面数据。房间完全来自设置中的手动房间，
 * 设备只有被手动加入某个房间才显示（人员与农历为全局信息除外；一键执行类实体只供情景按钮使用，不生成设备卡）。
 * 温湿度与门窗、人体、水浸、烟雾进房间顶部摘要，电量传感器进电池提醒，人员进在家状态。
 * 不可用的设备一律显示为不可用，不会显示成“关”；previous 用来保留 HA 暂未上报的属性（例如关灯后的亮度）。
 */
export function liveHome(catalogue: Catalogue | null, states: States, previous: HomeState | null, customConfig?: CustomConfig | null): HomeState {
  const custom = customConfig ?? EMPTY_CUSTOM;
  const entities = catalogue?.entities ?? [];
  const rooms: Room[] = custom.rooms.map((room) => ({ id: room.id, name: room.name, category: 'main', icon: room.icon }));
  const roomIds = new Set(custom.rooms.map((room) => room.id));
  const previousDevices = new Map(previous?.devices.map((device) => [device.id, device]));
  const devices: Device[] = [];
  const batteries: BatteryReading[] = [];
  const people: Person[] = [];

  // 手动指定的温湿度来源 → 合成只用于房间/主页状态摘要的传感器。
  // 规则：每个作用域每个指标只认一条（设置里同槽位保存即替代）；来源不可用时自动改用同房间内可用的同类实体参数；
  // 房间一旦配置了来源，该房间原来的同指标独立传感器就被替代、不再显示。
  const replacedSensorIds = new Set<string>();
  const metricSensors: SensorDevice[] = [];
  for (const source of custom.metricSources ?? []) {
    if (source.scope !== HOME_SCOPE && !roomIds.has(source.scope)) continue;
    let entityId = source.entity;
    let attribute = source.attribute;
    let value = readMetric(states.get(entityId), attribute);
    if (value === undefined && source.scope !== HOME_SCOPE) {
      const fallback = entities.find((candidate) => {
        if (custom.assignments[candidate.id] !== source.scope) return false;
        const option = candidate.metrics?.find((item) => item.metric === source.metric);
        return Boolean(option && readMetric(states.get(candidate.id), option.key) !== undefined);
      });
      if (fallback) {
        entityId = fallback.id;
        attribute = fallback.metrics!.find((item) => item.metric === source.metric)!.key;
        value = readMetric(states.get(entityId), attribute);
      }
    }
    if (source.scope !== HOME_SCOPE) {
      for (const candidate of entities) {
        if (custom.assignments[candidate.id] === source.scope && candidate.domain === 'sensor' && candidate.deviceClass === source.metric) {
          replacedSensorIds.add(candidate.id);
        }
      }
    }
    metricSensors.push({
      id: `$metric:${source.scope}:${source.metric}`,
      roomId: source.scope,
      name: source.metric === 'temperature' ? '温度' : '湿度',
      available: value !== undefined,
      kind: 'sensor',
      value: value === undefined ? '' : formatMetric(source.metric, value),
      unit: METRIC_UNIT[source.metric],
      metric: source.metric,
      precision: source.metric === 'temperature' ? 1 : 0,
    });
  }

  for (const entity of entities) {
    const state = states.get(entity.id);
    if (entity.domain === 'person') {
      people.push({ id: entity.id, name: entity.name, source: 'HA', status: !usable(state) ? 'unknown' : state.state === 'home' ? 'home' : 'away' });
      continue;
    }
    // 一键执行类实体（scene/script/button/input_button/automation）不是房间设备，由情景模式按钮使用。
    if (SCENE_TARGET_DOMAINS.has(entity.domain)) continue;
    // 电量传感器不做房间筛选：无论是否分配房间都收录，已分配的记各自房间（房间摘要低电提醒），未分配的记 'home'（主页电量提醒）。
    if (entity.domain === 'sensor' && entity.deviceClass === 'battery') {
      const level = usable(state) ? Number(state.state) : NaN;
      const batteryRoom = custom.assignments[entity.id];
      batteries.push({ id: entity.id, roomId: batteryRoom && roomIds.has(batteryRoom) ? batteryRoom : 'home', name: entity.name, available: usable(state), level: Number.isFinite(level) ? Math.round(level) : null });
      continue;
    }
    // 完全手动房间：未加入任何（仍存在的）房间的实体一律不显示，包括农历这类全局文本实体。
    const roomId = custom.assignments[entity.id];
    if (!roomId || !roomIds.has(roomId)) continue;
    // 已为该房间手动指定温湿度来源时，原来的同指标独立传感器被替代。
    if (replacedSensorIds.has(entity.id)) continue;
    const base = baseDevice(entity, roomId, state);
    if (!base) continue;
    // 设置里可按实体改名 / 换图标，不影响 HA 本身。
    const override = custom.entities?.[entity.id];
    if (override) {
      if (override.name) base.name = override.name;
      if (override.icon) base.icon = override.icon;
    }
    const prior = previousDevices.get(entity.id);
    if (!usable(state)) devices.push(prior && prior.kind === base.kind ? { ...prior, roomId, name: base.name, icon: base.icon, available: false } : base);
    else devices.push(toDevice(base, prior && prior.kind === base.kind ? prior : undefined, state));
  }
  devices.push(...metricSensors);
  return { rooms, devices, batteries, people };
}

export interface ServiceCall {
  /** 仅用于说明；后端按设备映射的实体自行确定 domain。 */
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

function rgbFromHex(color: string): number[] {
  const value = color.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

/** 把已通过能力校验的操作翻译成 HA 服务调用；后端还会按白名单再次校验服务与参数。 */
export function serviceCall(after: Device, command: DeviceCommand): ServiceCall | null {
  switch (command.type) {
    case 'toggle':
      if (after.kind === 'light') return { domain: 'light', service: after.on ? 'turn_on' : 'turn_off', data: {} };
      if (after.kind === 'climate' || after.kind === 'heating') {
        const mode = after.mode !== 'off' ? after.mode : after.hvacModes.find((option) => option !== 'off');
        return mode ? { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: after.on ? mode : 'off' } } : null;
      }
      if (after.kind === 'fan') return { domain: 'fan', service: after.on ? 'turn_on' : 'turn_off', data: {} };
      if (after.kind === 'cover') {
        // applyCommand 的乐观值是终态：切换后为 closed 说明原本开着，要收帘；反之开帘。
        return { domain: 'cover', service: after.state === 'closed' ? 'close_cover' : 'open_cover', data: {} };
      }
      if (after.kind === 'vacuum') return { domain: 'vacuum', service: after.status === 'cleaning' || after.status === 'returning' ? 'pause' : 'start', data: {} };
      if (after.kind === 'switch') {
        // 开关卡片同时承载 switch 与 input_boolean 两个 HA 域，域从实体 id 取。
        const domain = after.id.startsWith('input_boolean.') ? 'input_boolean' : 'switch';
        return { domain, service: after.on ? 'turn_on' : 'turn_off', data: {} };
      }
      return null;
    case 'turnOff':
      if (after.kind === 'light') return { domain: 'light', service: 'turn_off', data: {} };
      if (after.kind === 'climate' || after.kind === 'heating') return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: 'off' } };
      if (after.kind === 'fan') return { domain: 'fan', service: 'turn_off', data: {} };
      if (after.kind === 'cover') return { domain: 'cover', service: 'close_cover', data: {} };
      if (after.kind === 'switch') return { domain: after.id.startsWith('input_boolean.') ? 'input_boolean' : 'switch', service: 'turn_off', data: {} };
      return null;
    case 'adjust':
      return after.kind === 'climate' || after.kind === 'heating' ? { domain: 'climate', service: 'set_temperature', data: { temperature: after.target } } : null;
    case 'light': {
      const data: Record<string, unknown> = {};
      if (command.patch.brightness !== undefined) data.brightness_pct = command.patch.brightness;
      if (command.patch.colorTemp !== undefined) data.color_temp_kelvin = command.patch.colorTemp;
      if (command.patch.color !== undefined) data.rgb_color = rgbFromHex(command.patch.color);
      return { domain: 'light', service: 'turn_on', data };
    }
    case 'hvacMode':
      return { domain: 'climate', service: 'set_hvac_mode', data: { hvac_mode: command.mode } };
    case 'fanMode':
      return { domain: 'climate', service: 'set_fan_mode', data: { fan_mode: command.fanMode } };
    case 'swingMode':
      return { domain: 'climate', service: 'set_swing_mode', data: { swing_mode: command.swingMode } };
    case 'mediaPower':
      return after.kind === 'media' ? { domain: 'media_player', service: after.status === 'off' ? 'turn_off' : 'turn_on', data: {} } : null;
    case 'mediaPlayPause':
      return { domain: 'media_player', service: 'media_play_pause', data: {} };
    case 'mediaVolume':
      return { domain: 'media_player', service: 'volume_set', data: { volume_level: command.volume / 100 } };
    case 'fanSpeed':
      return { domain: 'fan', service: 'set_percentage', data: { percentage: command.percentage } };
    case 'fanPreset':
      return { domain: 'fan', service: 'set_preset_mode', data: { preset_mode: command.preset } };
    case 'fanOscillate':
      return { domain: 'fan', service: 'oscillate', data: { oscillating: command.oscillating } };
    case 'coverOpen':
      return { domain: 'cover', service: 'open_cover', data: {} };
    case 'coverClose':
      return { domain: 'cover', service: 'close_cover', data: {} };
    case 'coverStop':
      return { domain: 'cover', service: 'stop_cover', data: {} };
    case 'coverPosition':
      return { domain: 'cover', service: 'set_cover_position', data: { position: command.position } };
    case 'vacuumStart':
      return { domain: 'vacuum', service: 'start', data: {} };
    case 'vacuumPause':
      return { domain: 'vacuum', service: 'pause', data: {} };
    case 'vacuumReturn':
      return { domain: 'vacuum', service: 'return_to_base', data: {} };
    case 'vacuumLocate':
      return { domain: 'vacuum', service: 'locate', data: {} };
    case 'vacuumFanSpeed':
      return { domain: 'vacuum', service: 'set_fan_speed', data: { fan_speed: command.fanSpeed } };
  }
}
