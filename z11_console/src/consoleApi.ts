/** 控制台后端的 HTTP 接口。管理接口依赖登录后下发的 HttpOnly 会话 Cookie。 */
import type { CatalogueEntity, CustomConfig, LabelInfo, Season, ServerLayout } from './consoleClient';
import type { Accent } from './theme';

export interface AdminSettings {
  haUrl: string;
  hasToken: boolean;
  controlEnabled: boolean;
  dataSource: 'demo' | 'live';
  homeTitle: string;
  brandTitle: string;
  theme: 'dark' | 'light' | 'auto';
  tileScale: number;
  accent: Accent;
  /** 季节规则：启用后由控制台在 HA 中维护季节辅助元素和三条季节自动化。 */
  seasonRules: boolean;
  /** 音乐页内嵌地址；为空表示未配置。 */
  musicUrl: string;
  /** go2rtc 流媒体服务地址；为空时摄像头走本机 ffmpeg 转 MJPEG。 */
  go2rtcUrl: string;
  /** “一键关闭”可关的设备类别；默认只有灯。 */
  allOffKinds: string[];
  /** “一键关闭”可关的区域（房间 ID）；空列表 = 全部房间。 */
  allOffScopes: string[];
  /** “一键关闭”额外指定的实体 ID。 */
  allOffEntities: string[];
  /** “一键关闭”要排除的实体 ID。 */
  allOffExcludes: string[];
  /** 人员在家配置列表。 */
  people: PersonConfig[];
  season: Season | null;
  seasonSync: { state: 'idle' | 'demo' | 'waiting' | 'syncing' | 'off' | 'ok' | 'pending' | 'error'; message: string };
}

/** 人员在家配置（保存在服务端 settings.json）。 */
export interface PersonConfig {
  id: string;
  name: string;
  /** HA 实体 ID（device_tracker / person / input_boolean 等）。 */
  entityId: string;
  /** 自定义头像文件名；null 或空表示用默认图片。 */
  image: string | null;
  /** 判定在家的状态值列表（默认 on / home）。 */
  homeStates: string[];
}

export interface AuditEntry {
  time: string;
  event: string;
  ip: string;
  /** 操作账户名（账户系统上线后由后端写入；旧记录可能为空）。 */
  user?: string;
  [key: string]: unknown;
}

export type FilterMode = 'blacklist' | 'whitelist';

export interface EntityFilter {
  mode: FilterMode;
  blacklist: string[];
  whitelist: string[];
}

/** 设置页用：全部已发现的实体（过滤前）及当前状态。 */
export interface DiscoveredEntities {
  filter: EntityFilter;
  labels: LabelInfo[];
  rooms: { id: string; name: string }[];
  entities: (CatalogueEntity & { state: string | null })[];
}

/** 账户信息（不含密码哈希）。 */
export interface AccountInfo {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

/** /api/admin/me 返回值：当前登录账户 + 首跑引导状态。 */
export interface MeResponse {
  authenticated: boolean;
  user?: { username: string; isAdmin: boolean };
  /** firstRun=true 表示管理员尚未完成首跑引导（admin/admin 仍是默认值）。 */
  firstRun?: boolean;
  setupCompleted?: boolean;
}

/** /api/admin/accounts 返回值。 */
export interface AccountsResponse {
  accounts: AccountInfo[];
  setupCompleted: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * HAOS Ingress 下页面挂在 /api/hassio_ingress/<令牌>/ 子路径上，所有 API/静态请求必须基于当前路径走相对地址；
 * 独立部署时路径为 '/'，结果与原来的绝对路径一致。
 */
const BASE_PATH = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
export const apiPath = (path: string) => `${BASE_PATH}${path.replace(/^\/+/, '')}`;

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath(path), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '无法连接控制台服务');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, String(data.error ?? `请求失败（${response.status}）`), data);
  return data as T;
}

export type LoginResult = { ok: true; user: { username: string; isAdmin: boolean }; firstRun: boolean } | { ok: false; message: string; retryAfter?: number };

/** 账号 + 密码登录；默认 remember=true，Cookie 30 天，下次进入页面无需重新输入。 */
export async function login(username: string, password: string, remember = true): Promise<LoginResult> {
  try {
    const data = await request<{ ok: true; user: { username: string; isAdmin: boolean }; firstRun: boolean; setupCompleted: boolean }>('/api/admin/login', 'POST', { username, password, remember });
    return { ok: true, user: data.user, firstRun: Boolean(data.firstRun) };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const retryAfter = typeof error.body.retryAfter === 'number' ? error.body.retryAfter : undefined;
    const remaining = typeof error.body.remaining === 'number' ? error.body.remaining : undefined;
    if (retryAfter) return { ok: false, message: `尝试次数过多，请 ${retryAfter} 秒后再试`, retryAfter };
    if (error.status === 401) return { ok: false, message: remaining !== undefined ? `账号或密码不正确，还可尝试 ${remaining} 次` : '账号或密码不正确' };
    return { ok: false, message: error.message };
  }
}

export const logout = () => request('/api/admin/logout', 'POST').catch(() => undefined);
/** 查询当前登录账户与首跑状态；前端据此决定显示登录页 / 引导页 / 主界面。 */
export const getMe = () => request<MeResponse>('/api/admin/me');
/** 首跑引导：管理员改账户名 + 密码，完成后 setupCompleted=true。 */
export const setupAdmin = (username: string, password: string) =>
  request<{ ok: true; user: { username: string; isAdmin: boolean }; setupCompleted: boolean }>('/api/admin/setup', 'POST', { username, password });
/** 修改自己密码（管理员 / 子账户均可）。需提供旧密码二次确认。 */
export const changePassword = (oldPassword: string, newPassword: string) =>
  request<{ ok: true }>('/api/admin/password', 'PUT', { oldPassword, newPassword });
/** 管理员查看全部账户。 */
export const getAccounts = () => request<AccountsResponse>('/api/admin/accounts');
/** 管理员新增子账户（无管理权限）。 */
export const createAccount = (username: string, password: string) =>
  request<{ ok: true; account: AccountInfo }>('/api/admin/accounts', 'POST', { username, password });
/** 管理员删除子账户；管理员账户不可删除。 */
export const deleteAccount = (id: string) => request<{ ok: true }>(`/api/admin/accounts/${encodeURIComponent(id)}`, 'DELETE');

export const getSettings = () => request<AdminSettings>('/api/admin/settings');
export const updateSettings = (patch: Partial<AdminSettings> & { haToken?: string; clearToken?: boolean }) => request<AdminSettings>('/api/admin/settings', 'PUT', patch);
/** 上传自定义人员头像；返回文件名和 URL。 */
export async function uploadPeopleImage(file: File): Promise<{ image: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(apiPath('/api/admin/people-image'), { method: 'POST', body: form, credentials: 'same-origin' });
  if (!response.ok) {
    const text = await response.text();
    let message = '上传失败';
    try { message = JSON.parse(text).error ?? message; } catch { /* 非 JSON 就用默认消息 */ }
    throw new ApiError(response.status, message, { error: message });
  }
  return response.json();
}
/**
 * 读取操作记录。
 * @param limit 条数
 * @param event 事件类型过滤；传 'service_call' 只看“操控设备记录”。
 */
export const getAudit = (limit = 30, event?: string) =>
  request<AuditEntry[]>(`/api/admin/audit?limit=${limit}${event ? `&event=${encodeURIComponent(event)}` : ''}`);
/** “操控设备记录”：只看 service_call 事件，按账户名区分谁操作了什么设备。 */
export const getDeviceAudit = (limit = 50) => getAudit(limit, 'service_call');
export const putLayout = (layout: ServerLayout) => request<ServerLayout>('/api/layout', 'PUT', layout);
export const getEntities = () => request<DiscoveredEntities>('/api/admin/entities');
export const putFilter = (filter: Partial<EntityFilter>) => request<DiscoveredEntities>('/api/admin/filter', 'PUT', filter);
export const getCustom = () => request<CustomConfig>('/api/admin/custom');
export const putCustom = (custom: CustomConfig) => request<CustomConfig>('/api/admin/custom', 'PUT', custom);

/** HA 自动化（设置 → 自动化）；演示模式为服务内存中的演示数据。state 为 on / off / unavailable。 */
export interface AutomationItem {
  id: string;
  name: string;
  state: string | null;
  lastTriggered: string | null;
}

export interface AutomationList {
  source: 'demo' | 'live';
  /** HA 模式下是否已连接；未连接时列表为空。 */
  connected: boolean;
  automations: AutomationItem[];
}

export const getAutomations = () => request<AutomationList>('/api/admin/automations');
export const setAutomation = (id: string, enabled: boolean) => request<{ ok: true; id: string; state: string }>('/api/admin/automations', 'PUT', { id, enabled });
