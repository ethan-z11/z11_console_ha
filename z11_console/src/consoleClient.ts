/**
 * 与控制台后端（home-console/server）的 WebSocket 连接。
 * 后端保管 HA 令牌并持有唯一的 HA 连接，自动发现设备并按黑白名单过滤；浏览器只接收目录、状态和布局，按实体请求控制。
 */
import type { Accent } from './theme';
import type { LayoutState } from './types';

export type Season = 'summer' | 'winter';

export interface EntityState {
  state: string;
  attributes: Record<string, unknown>;
}

/** HA 标签。 */
export interface LabelInfo {
  id: string;
  name: string;
}

/** 后端自动发现并过滤后的实体；areaId 为实体在 HA 中的区域（仅设置页参考，房间归属以 custom 为准）。 */
export interface CatalogueEntity {
  id: string;
  domain: string;
  deviceClass: string | null;
  areaId: string | null;
  name: string;
  /** 所属 HA 设备名（用户改名优先）；有人传感器按“设备名含人”匹配，实体未关联设备时为空。 */
  deviceName?: string | null;
  /** 实体上的 HA 标签，用于设置页按标签分组与筛选。 */
  labels: LabelInfo[];
  /** 传感器在 HA 中的显示小数位（用户设置优先，其次集成建议）；没有时为 undefined。 */
  precision?: number;
  /** 扫地机关联的地图 image 实体 id（后端发现，仅 vacuum 域）。 */
  mapEntityId?: string;
  /** 该实体可作为房间温度 / 湿度显示的数值参数（climate 的 current_temperature 等）；没有时不允许选为来源。 */
  metrics?: MetricOption[];
  /** HA 实时状态是否可用；unavailable 的实体不允许加入房间（缺省按可用处理，兼容演示模式）。 */
  available?: boolean;
}

export type MetricName = 'temperature' | 'humidity';

/** 实体上可供“温湿度来源”选择的一个数值参数。 */
export interface MetricOption {
  /** 取值位置：'state' 为实体状态值，其余为 attributes 中的属性键。 */
  key: string;
  metric: MetricName;
  /** 设置页下拉显示名，如“当前温度”。 */
  label: string;
}

export interface Catalogue {
  labels: LabelInfo[];
  rooms: { id: string; name: string }[];
  entities: CatalogueEntity[];
}

/** 手动房间、设备归属与情景模式按钮（custom.json，管理设置，所有屏幕共用）。 */
export interface CustomConfig {
  /** icon 为图标表中的 kebab 键，空字符串表示按名称自动匹配。 */
  rooms: { id: string; name: string; icon: string }[];
  /** 实体 id → 房间 id；未出现的设备实体不在任何房间显示。 */
  assignments: Record<string, string>;
  /** 情景按钮；scope 为 'home'（我的家庭页）或某个房间 id。name 为空时前端回退显示目标实体名称。 */
  scenes: { id: string; name: string; entity: string; scope: string; icon: string }[];
  /** 实体 id → 显示覆盖（改名 / 自定义图标）；name 或 icon 为空字符串表示跟随原名 / 自动匹配。 */
  entities: Record<string, { name: string; icon: string }>;
  /** 自定义摄像头；scope 为 'home'（我的家庭页）或某个房间 id。 */
  cameras: CameraConfig[];
  /** 房间 / 主页的温湿度来源：每个 scope+metric 最多一条，手动指定实体与其数值参数，同槽位新增自动替代。 */
  metricSources?: MetricSource[];
  /** 区域有人传感器：scope（home / 房间 id）→ 实体 id 列表；多个为“或”，任一触发即有人。 */
  occupancy?: Record<string, string[]>;
  /** 电量传感器显示偏好：主页药丸开关、手动剔除、改名、常驻实体。 */
  battery?: BatteryConfig;
  /** 子设备绑定：宿主实体 id → 子设备实体 id 列表（灯→灯 / 窗帘→窗帘）。
   *  子设备不再单独显示卡片，只在宿主的设置弹窗里以大卡片展示与控制。 */
  children?: Record<string, string[]>;
}

export interface BatteryConfig {
  /** 主页“电池 N 个”药丸按钮是否显示；缺省 true。 */
  enabled?: boolean;
  /** 从自动收录列表中手动剔除的实体 id（不再出现在主页电池列表和弹窗里）。 */
  excluded?: string[];
  /** 手动添加的实体 id（自动没识别出来的电量实体，可多个）。 */
  added?: string[];
  /** 实体 id → 自定义显示名。 */
  names?: Record<string, string>;
  /** 首页常驻显示的单个电池实体 id；必须是电量 sensor 实体。 */
  highlightEntity?: string;
}

/** 温湿度显示来源：scope 为 'home'（主页）或房间 id；attribute 为 'state' 或实体属性键。 */
export interface MetricSource {
  id: string;
  scope: string;
  metric: MetricName;
  entity: string;
  attribute: string;
}

/** 摄像头接入方式：rtsp 直填地址；onvif 填主机 / 端口 / 账密，取流地址由后端探测（可另填 rtspUrl 覆盖）。 */
export type CameraType = 'rtsp' | 'onvif';

/**
 * 自定义摄像头。
 * rtspUrl（RTSP 必填，ONVIF 可选作画面地址覆盖）与 host/port/username/password（ONVIF）仅管理接口返回；
 * WS 推送给普通屏幕时被服务端剥离，只保留 id/name/scope/type。
 */
export interface CameraConfig {
  id: string;
  name: string;
  scope: string;
  /** 旧数据没有 type 字段，按 rtsp 处理。 */
  type?: CameraType;
  rtspUrl?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  /** 运动检测截图的单台开关（仅 ONVIF 参与监测）；缺省视为开启，仅关闭时为 false。 */
  motionEnabled?: boolean;
}

/** 统一取接入类型（兼容旧数据）。 */
export const cameraType = (camera: CameraConfig): CameraType => camera.type ?? 'rtsp';

/** 天气地区（中国天气网城市）；全屋共用，保存在服务端设置里。 */
export interface WeatherPlace {
  id: string;
  name: string;
  adm2: string;
  adm1: string;
  country: string;
  lat: number;
  lon: number;
}

export type HaStatus =
  | { kind: 'disabled' }
  | { kind: 'unconfigured' }
  | { kind: 'connecting' }
  | { kind: 'connected'; version?: string }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'disconnected'; message: string; retryInSeconds: number };

export interface ServerStatus {
  dataSource: 'demo' | 'live';
  controlEnabled: boolean;
  /** 运动检测截图总开关（设置 → 设备）；关闭后停止所有 ONVIF 事件订阅与帧差兜底。 */
  motionCapture?: boolean;
  /** "我的家庭"页标题与副标题（设置 → 显示），所有屏幕共用；副标题为空表示不显示。 */
  homeTitle?: string;
  /** 家庭名称（默认"家庭控制"，同步网页标题）。 */
  brandTitle?: string;
  /** 主题模式（设置 → 显示）：自动为日出到日落浅色。 */
  theme?: 'dark' | 'light' | 'auto';
  /** 设备格子缩放百分比（设置 → 显示，80–120），所有屏幕共用；旧服务没有时按 100。 */
  tileScale?: number;
  /** 强调色（设置 → 显示），所有屏幕共用；旧服务没有时按琥珀。 */
  accent?: Accent;
  /** 季节（设置 → 自动化 → 季节规则）；未启用季节规则时为 null。 */
  season?: Season | null;
  /** 音乐页内嵌地址（设置 → 音乐）；为空表示未配置，不显示音乐入口。 */
  musicUrl?: string;
  /** “一键关闭”可关的设备类别；默认只有灯。 */
  allOffKinds?: string[];
  /** “一键关闭”可关的区域（房间 ID）；空列表 = 全部房间。 */
  allOffScopes?: string[];
  /** “一键关闭”额外指定的实体 ID。 */
  allOffEntities?: string[];
  /** “一键关闭”排除的实体 ID（即使符合类别与区域也不关闭）。 */
  allOffExcludes?: string[];
  /** 全屋共用的天气地区（服务端保存）；未选择时为 null。 */
  weatherPlace?: WeatherPlace | null;
  /** 人员在家状态列表（从 HA 实体判断后由后端下发）。 */
  people?: PersonStatus[];
  /** go2rtc 低延迟流媒体：enabled 时摄像头走 WebRTC（回退 MSE/HLS/MP4/MJPEG）。 */
  go2rtc?: { enabled: boolean; modes?: string };
  /** 区域有人状态：scope（home / 房间 id）→ 是否有人；只包含已配置传感器的区域。 */
  occupancy?: Record<string, boolean>;
  ha: HaStatus;
}

/** 人员在家状态（后端判断后下发）。 */
export interface PersonStatus {
  id: string;
  name: string;
  /** 头像 URL（默认图片或自定义上传图片）。 */
  image: string;
  /** 是否在家。 */
  home: boolean;
}

/** 后端布局中 favorites 为 null 表示使用默认常用清单。 */
export type ServerLayout = Omit<LayoutState, 'favorites' | 'rooms'> & { favorites: string[] | null; rooms?: string[] };

type ServerMessage =
  | { type: 'hello'; catalogue: Catalogue; layout: ServerLayout; custom: CustomConfig }
  | ({ type: 'status' } & ServerStatus)
  | { type: 'entities'; changed: Record<string, EntityState | null>; snapshot?: boolean }
  | { type: 'layout'; layout: ServerLayout }
  | { type: 'catalogue'; catalogue: Catalogue }
  | { type: 'custom'; custom: CustomConfig }
  | { type: 'result'; id: number; success: boolean; error?: string | null }
  | { type: 'pong' };

interface ConsoleClientHandlers {
  onConnection: (connected: boolean) => void;
  onHello: (catalogue: Catalogue, layout: ServerLayout, custom: CustomConfig) => void;
  onStatus: (status: ServerStatus) => void;
  onEntities: (changed: Record<string, EntityState | null>, snapshot: boolean) => void;
  onLayout: (layout: ServerLayout) => void;
  onCatalogue: (catalogue: Catalogue) => void;
  onCustom: (custom: CustomConfig) => void;
}

const retryDelays = [1, 2, 5, 10, 30];
const callTimeoutMs = 15_000;
/** 手机解锁后网络可能还没就绪，新连接卡在建立阶段时超时重试。 */
const connectTimeoutMs = 8_000;
const offlineMessage = '正在重新连接，操作未发送';
/** 已发出但连接中断、没收到结果的请求：可能已执行，也可能没有，重连后以设备状态为准。 */
const interruptedMessage = '连接中断，结果未知，请以设备状态为准';
/** 定时确认连接可用：发 ping，超时未收到 pong 视为连接已失效并立即重连。 */
const keepaliveMs = 25_000;
const pongTimeoutMs = 5_000;

export class ConsoleClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: number }>();
  private retryIndex = 0;
  private retryTimer = 0;
  private connectTimer = 0;
  private keepaliveTimer = 0;
  private pongTimer = 0;
  private closed = false;

  constructor(private readonly handlers: ConsoleClientHandlers) {}

  connect() {
    this.closed = false;
    this.open();
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.connectTimer);
    this.stopKeepalive();
    this.rejectPending('连接已关闭');
    this.socket?.close();
    this.socket = null;
  }

  /**
   * 页面回到前台、网络恢复时调用：没有可用连接就立即重连（不再等退避计时），连接看似正常则立即确认一次；
   * force 时直接重建，手机锁屏较久后旧连接可能已失效却未报告关闭。
   */
  wake(force = false) {
    if (this.closed) return;
    const socket = this.socket;
    if (socket && !force) {
      if (socket.readyState === WebSocket.OPEN) { this.ping(); return; }
      if (socket.readyState === WebSocket.CONNECTING) return;
    }
    window.clearTimeout(this.retryTimer);
    this.retryIndex = 0;
    if (socket) {
      // 先解除引用，旧连接的关闭事件不再触发重试或断线状态，页面继续显示已有数据直到新连接送来快照。
      this.socket = null;
      this.stopKeepalive();
      this.rejectPending(interruptedMessage);
      socket.close();
    }
    this.open();
  }

  private ping() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pongTimer) return;
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = 0;
      if (this.socket === socket) this.dropDeadSocket(socket);
    }, pongTimeoutMs);
    socket.send(JSON.stringify({ type: 'ping' }));
  }

  /** 连接已失效但浏览器还没报告关闭：不等关闭握手，直接按断线处理并立即重连。 */
  private dropDeadSocket(socket: WebSocket) {
    this.socket = null;
    this.stopKeepalive();
    this.rejectPending(interruptedMessage);
    this.handlers.onConnection(false);
    socket.close();
    if (!this.closed) this.open();
  }

  private stopKeepalive() {
    window.clearInterval(this.keepaliveTimer);
    window.clearTimeout(this.pongTimer);
    this.keepaliveTimer = 0;
    this.pongTimer = 0;
  }

  /** 请求控制某个实体；后端校验实体可见、服务与参数在白名单内。 */
  callService(entity: string, service: string, data: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(offlineMessage));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('响应超时')); }, callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, type: 'call_service', entity, service, data }));
    });
  }

  private open() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    this.socket = socket;
    window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
    }, connectTimeoutMs);
    socket.onopen = () => {
      window.clearTimeout(this.connectTimer);
      this.stopKeepalive();
      this.keepaliveTimer = window.setInterval(() => this.ping(), keepaliveMs);
      this.retryIndex = 0;
      this.handlers.onConnection(true);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      this.handle(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      window.clearTimeout(this.connectTimer);
      this.stopKeepalive();
      this.rejectPending(interruptedMessage);
      this.handlers.onConnection(false);
      if (this.closed) return;
      const delay = retryDelays[Math.min(this.retryIndex, retryDelays.length - 1)];
      this.retryIndex += 1;
      this.retryTimer = window.setTimeout(() => this.open(), delay * 1000);
    };
  }

  private handle(message: ServerMessage) {
    switch (message.type) {
      case 'hello': this.handlers.onHello(message.catalogue, message.layout, message.custom); return;
      case 'status': this.handlers.onStatus({ dataSource: message.dataSource, controlEnabled: message.controlEnabled, motionCapture: message.motionCapture, homeTitle: message.homeTitle, brandTitle: message.brandTitle, theme: message.theme, tileScale: message.tileScale, accent: message.accent, season: message.season, musicUrl: message.musicUrl, allOffKinds: message.allOffKinds, allOffScopes: message.allOffScopes, allOffEntities: message.allOffEntities, allOffExcludes: message.allOffExcludes, weatherPlace: message.weatherPlace, people: message.people, go2rtc: message.go2rtc, occupancy: message.occupancy, ha: message.ha }); return;
      case 'catalogue': this.handlers.onCatalogue(message.catalogue); return;
      case 'custom': this.handlers.onCustom(message.custom); return;
      case 'entities': this.handlers.onEntities(message.changed, Boolean(message.snapshot)); return;
      case 'layout': this.handlers.onLayout(message.layout); return;
      case 'pong': window.clearTimeout(this.pongTimer); this.pongTimer = 0; return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        window.clearTimeout(pending.timer);
        if (message.success) pending.resolve();
        else pending.reject(new Error(message.error || '操作失败'));
      }
    }
  }

  private rejectPending(reason: string) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
