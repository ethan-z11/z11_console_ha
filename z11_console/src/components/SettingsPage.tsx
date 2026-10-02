import { Cctv, DoorOpen, Grid2x2, History, House, KeyRound, LayoutTemplate, ListChecks, LogOut, Minus, Music, Palette, Plus, Power, RotateCcw, Server, ShieldCheck, Sun, Trash2, Upload, UserPlus, Workflow, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { apiPath, ApiError, changePassword, createAccount, deleteAccount, getAccounts, getAudit, getCustom, getEntities, getSettings, request, updateSettings, uploadPeopleImage } from '../consoleApi';
import type { AccountInfo, AdminSettings, AuditEntry, DiscoveredEntities, PersonConfig } from '../consoleApi';
import type { CustomConfig } from '../consoleClient';
import type { ServerStatus } from '../consoleClient';
import { ACCENTS } from '../theme';
import { AutomationList } from './AutomationList';
import { CollapsibleCard } from './CollapsibleCard';
import { connectionText } from './ConnectionBadge';
import { CustomizeSettings } from './CustomizeSettings';
import { EntityFilter } from './EntityFilter';

interface SettingsPageProps {
  status: ServerStatus | null;
  /** 当前登录账户；未登录时为 undefined（理论上不会进入此页）。 */
  user?: { username: string; isAdmin: boolean };
  /** 是否处于首跑引导（管理员尚未修改默认账号密码）。 */
  firstRun: boolean;
  /** 退出登录：清除本地状态后回到登录页。 */
  onLogout: () => void;
  /** 打开首跑引导页（修改管理员账号与密码）。 */
  onOpenSetup: () => void;
  /** 会话过期或后端拒绝时退回，并提示原因。 */
  onExpired: (message: string) => void;
}

type Message = { tone: 'good' | 'error'; text: string } | null;

const auditLabels: Record<string, string> = {
  login: '账户登录',
  login_failed: '密码错误',
  logout: '退出登录',
  setup_completed: '首跑引导完成',
  password_changed: '修改密码',
  account_created: '新增子账户',
  account_deleted: '删除子账户',
  settings_changed: '修改设置',
  layout_changed: '修改布局',
  filter_changed: '修改设备筛选',
  custom_changed: '修改房间与情景',
  automation_toggled: '开关自动化',
  season_rules_synced: '同步季节规则',
  service_call: '操控设备',
};

const KIND_OPTIONS = [
  { value: 'light', label: '灯' },
  { value: 'climate', label: '空调/制热' },
  { value: 'fan', label: '风扇' },
  { value: 'cover', label: '窗帘' },
  { value: 'switch', label: '开关' },
] as const;

function kindLabel(value: string): string {
  return KIND_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

type Tab = 'connection' | 'rooms' | 'devices' | 'music' | 'automations' | 'display' | 'security' | 'audit' | 'login';

const allTabs: { id: Tab; label: string; icon: LucideIcon; adminOnly?: boolean }[] = [
  { id: 'connection', label: '连接', icon: Server, adminOnly: true },
  { id: 'rooms', label: '房间', icon: DoorOpen, adminOnly: true },
  { id: 'devices', label: '设备', icon: ListChecks, adminOnly: true },
  { id: 'music', label: '音乐', icon: Music, adminOnly: true },
  { id: 'automations', label: '自动化', icon: Workflow, adminOnly: true },
  { id: 'display', label: '显示', icon: LayoutTemplate, adminOnly: true },
  { id: 'security', label: '安全', icon: KeyRound, adminOnly: true },
  { id: 'audit', label: '记录', icon: History, adminOnly: true },
  { id: 'login', label: '登录', icon: LogOut },
];

function FormMessage({ message }: { message: Message }) {
  return <p className={`settings-message${message ? ` settings-message--${message.tone}` : ''}`} role="status">{message?.text}</p>;
}

function auditDetail(entry: AuditEntry): string {
  if (entry.event === 'service_call') return `${String(entry.entity)} · ${String(entry.service)}${entry.ok ? '' : ` · 失败：${String(entry.error)}`}`;
  if (entry.event === 'season_rules_synced') return ['created', 'updated', 'deleted'].map((key) => [key, entry[key]] as const).filter(([, ids]) => Array.isArray(ids) && ids.length).map(([key, ids]) => `${{ created: '创建', updated: '更新', deleted: '删除' }[key]} ${(ids as string[]).join('、')}`).join('；');
  if (entry.event === 'automation_toggled') return `${String(entry.entity)} · ${entry.enabled ? '开启' : '关闭'}${entry.ok ? '' : ` · 失败：${String(entry.error)}`}`;
  if (entry.event === 'filter_changed') return `${entry.mode === 'whitelist' ? '白名单' : '黑名单'}（黑名单 ${String(entry.blacklist)} 项，白名单 ${String(entry.whitelist)} 项）`;
  if (entry.event === 'settings_changed' && Array.isArray(entry.fields)) return entry.fields.join('、');
  if (entry.event === 'login_failed' && entry.locked_seconds) return `锁定 ${String(entry.locked_seconds)} 秒`;
  return '';
}

/** 管理设置；账户系统下任何已登录用户进入，非管理员仅可见「登录」板块，管理员可见全部板块。 */
export function SettingsPage({ status, user, firstRun, onLogout, onOpenSetup, onExpired }: SettingsPageProps) {
  const formId = useId();
  const isAdmin = user?.isAdmin ?? false;
  // 非管理员只能看见「登录」板块；管理员看见全部。
  const tabs = isAdmin ? allTabs : allTabs.filter((t) => !t.adminOnly);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [haUrl, setHaUrl] = useState('');
  const [haToken, setHaToken] = useState('');
  const [controlMessage, setControlMessage] = useState<Message>(null);
  const [motionMessage, setMotionMessage] = useState<Message>(null);
  const [connectionMessage, setConnectionMessage] = useState<Message>(null);
  const [musicUrl, setMusicUrl] = useState('');
  const [musicMessage, setMusicMessage] = useState<Message>(null);
  const [go2rtcUrl, setGo2rtcUrl] = useState('');
  const [go2rtcMessage, setGo2rtcMessage] = useState<Message>(null);
  const [go2rtcBusy, setGo2rtcBusy] = useState(false);
  const [themeMessage, setThemeMessage] = useState<Message>(null);
  // 格子大小：拖动时本地先显示数值，停下 400ms 后保存；保存后服务推送给所有屏幕。
  const [tileScale, setTileScale] = useState<number | null>(null);
  const [scaleMessage, setScaleMessage] = useState<Message>(null);
  const [seasonMessage, setSeasonMessage] = useState<Message>(null);
  // 改密码表单。
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<Message>(null);
  // 子账户管理。
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [accountMessage, setAccountMessage] = useState<Message>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  // 操作记录切换：全部 / 仅操控设备记录。
  const [auditFilter, setAuditFilter] = useState<'all' | 'service_call'>('all');
  const [custom, setCustom] = useState<CustomConfig | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredEntities | null>(null);
  const [entityInput, setEntityInput] = useState('');
  const [allOffMessage, setAllOffMessage] = useState<Message>(null);
  const [tab, setTab] = useState<Tab>(isAdmin ? 'connection' : 'login');

  // 刷新操作记录：按当前过滤拉取。
  function refreshAudit(filter: 'all' | 'service_call' = auditFilter) {
    getAudit(50, filter === 'service_call' ? 'service_call' : undefined)
      .then((entries) => setAudit(entries))
      .catch(() => undefined);
  }

  useEffect(() => {
    let active = true;
    if (isAdmin) {
      getSettings()
        .then((loaded) => { if (active) { setSettings(loaded); setHaUrl(loaded.haUrl); setTileScale(loaded.tileScale ?? 100); setMusicUrl(loaded.musicUrl ?? ''); setGo2rtcUrl(loaded.go2rtcUrl ?? ''); } })
        .catch((error: Error) => { if (active) onExpired(error.message); });
      getCustom().then((cfg) => { if (active) setCustom(cfg); }).catch(() => undefined);
      getEntities().then((entities) => { if (active) setDiscovered(entities); }).catch(() => undefined);
      getAccounts().then((data) => { if (active) setAccounts(data.accounts); }).catch(() => undefined);
    }
    refreshAudit('all');
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载拉取
  }, []);

  useEffect(() => {
    if (tileScale === null || !settings || tileScale === (settings.tileScale ?? 100)) return;
    const timer = window.setTimeout(() => { void save({ tileScale }, setScaleMessage, `格子大小已设为 ${tileScale}%`); }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在滑杆数值变化时保存
  }, [tileScale]);

  // 季节规则由服务异步同步到 HA：停留在“自动化”标签时定时刷新同步状态。
  useEffect(() => {
    if (tab !== 'automations') return;
    const timer = window.setInterval(() => { getSettings().then(setSettings).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [tab]);

  /** 格子大小按 1% 微调，限制在 80%–120%。 */
  function changeTileScale(delta: number) {
    setTileScale((current) => Math.min(120, Math.max(80, (current ?? 100) + delta)));
    setScaleMessage(null);
  }

  /** 统一处理保存：会话过期时退出设置页，其他错误显示在对应区块。 */
  async function save(patch: Parameters<typeof updateSettings>[0], show: (message: Message) => void, success: string): Promise<boolean> {
    try {
      const next = await updateSettings(patch);
      setSettings(next);
      show({ tone: 'good', text: success });
      refreshAudit();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else show({ tone: 'error', text: error instanceof Error ? error.message : '保存失败' });
      return false;
    }
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    const patch = haToken.trim() ? { haUrl, haToken: haToken.trim() } : { haUrl };
    if (await save(patch, setConnectionMessage, '已保存到控制台服务')) setHaToken('');
  }

  async function saveMusic(event: FormEvent) {
    event.preventDefault();
    const url = musicUrl.trim();
    const ok = await save({ musicUrl: url }, setMusicMessage, url ? '音乐界面地址已保存，侧栏出现“音乐”入口' : '已清空音乐界面，侧栏入口已隐藏');
    if (ok) setMusicUrl(url);
  }

  /** 保存 go2rtc 地址；服务端保存前会先探测连通性，连不上会返回错误。 */
  async function saveGo2rtc(event: FormEvent) {
    event.preventDefault();
    const url = go2rtcUrl.trim();
    const ok = await save({ go2rtcUrl: url }, setGo2rtcMessage, url ? 'go2rtc 已连接，摄像头切换为 WebRTC 低延迟画面' : '已关闭 go2rtc，摄像头回到本机转码模式');
    if (ok) setGo2rtcUrl(url);
  }

  /** 自动发现（HAOS 加载项内网）或测试手动填写的 go2rtc 地址。 */
  async function detectGo2rtc() {
    setGo2rtcBusy(true);
    setGo2rtcMessage(null);
    try {
      const data = await request<{ url: string }>('/api/admin/go2rtc-detect', 'POST', { url: go2rtcUrl.trim() });
      setGo2rtcUrl(data.url);
      setGo2rtcMessage({ tone: 'good', text: `已找到 go2rtc：${data.url}，点“保存”后生效` });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setGo2rtcMessage({ tone: 'error', text: error instanceof Error ? error.message : '未找到 go2rtc' });
    } finally {
      setGo2rtcBusy(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < 4) { setPasswordMessage({ tone: 'error', text: '新密码至少 4 位' }); return; }
    if (newPassword.length > 128) { setPasswordMessage({ tone: 'error', text: '新密码最多 128 位' }); return; }
    if (newPassword !== confirmPassword) { setPasswordMessage({ tone: 'error', text: '两次输入不一致' }); return; }
    if (!oldPassword) { setPasswordMessage({ tone: 'error', text: '请输入当前密码' }); return; }
    try {
      await changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({ tone: 'good', text: '密码已更新' });
      refreshAudit();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setPasswordMessage({ tone: 'error', text: error instanceof Error ? error.message : '修改失败' });
    }
  }

  /** 新增子账户：非管理员权限，可登录看见首页与设备，不能进入除「登录」外的设置板块。 */
  async function saveNewAccount(event: FormEvent) {
    event.preventDefault();
    const username = newAccountName.trim();
    const password = newAccountPassword;
    if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(username)) { setAccountMessage({ tone: 'error', text: '账户名需 2-32 位，仅字母、数字、_ . @ -' }); return; }
    if (password.length < 4 || password.length > 128) { setAccountMessage({ tone: 'error', text: '密码长度需 4-128 位' }); return; }
    try {
      await createAccount(username, password);
      const data = await getAccounts();
      setAccounts(data.accounts);
      setNewAccountName('');
      setNewAccountPassword('');
      setAccountMessage({ tone: 'good', text: `子账户「${username}」已创建` });
      refreshAudit();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setAccountMessage({ tone: 'error', text: error instanceof Error ? error.message : '创建失败' });
    }
  }

  async function removeAccount(account: AccountInfo) {
    if (!confirm(`确认删除子账户「${account.username}」？`)) return;
    try {
      await deleteAccount(account.id);
      const data = await getAccounts();
      setAccounts(data.accounts);
      setAccountMessage({ tone: 'good', text: `子账户「${account.username}」已删除` });
      refreshAudit();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired(error.message);
      else setAccountMessage({ tone: 'error', text: error instanceof Error ? error.message : '删除失败' });
    }
  }

  /** “一键关闭”设备类别切换。 */
  function toggleAllOffKind(kind: string) {
    if (!settings) return;
    const current = settings.allOffKinds ?? ['light'];
    const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
    void save({ allOffKinds: next.length ? next : ['light'] }, setAllOffMessage,
      `已更新：一键关闭${next.map(kindLabel).join('、')}`);
  }

  /** “一键关闭”区域切换：空列表 = 全部房间。 */
  function toggleAllOffScope(roomId: string) {
    if (!settings || !custom) return;
    const rooms = custom.rooms;
    const scopes = settings.allOffScopes ?? [];
    const selected = scopes.length === 0 ? rooms.map((r: { id: string; name: string; icon: string }) => r.id) : scopes;
    const next = selected.includes(roomId) ? selected.filter((id: string) => id !== roomId) : [...selected, roomId];
    void save({ allOffScopes: next.length === rooms.length ? [] : next }, setAllOffMessage,
      next.length === rooms.length ? '一键关闭：全部区域' : `一键关闭：${next.length} 个区域`);
  }

  /** “一键关闭”添加实体 ID。 */
  function addAllOffEntity(id: string) {
    if (!settings) return;
    const current = settings.allOffEntities ?? [];
    const trimmed = id.trim();
    if (!trimmed || current.includes(trimmed)) return;
    void save({ allOffEntities: [...current, trimmed] }, setAllOffMessage, `已添加实体：${trimmed}`);
    setEntityInput('');
  }

  /** “一键关闭”移除实体 ID。 */
  function removeAllOffEntity(id: string) {
    if (!settings) return;
    void save({ allOffEntities: (settings.allOffEntities ?? []).filter((entity) => entity !== id) }, setAllOffMessage, `已移除实体：${id}`);
  }

  /** “一键关闭”排除实体勾选：候选来自已加入所选区域且设备类别符合的实体。 */
  function toggleAllOffExclude(id: string) {
    if (!settings) return;
    const current = settings.allOffExcludes ?? [];
    const next = current.includes(id) ? current.filter((entity) => entity !== id) : [...current, id];
    void save({ allOffExcludes: next }, setAllOffMessage,
      next.length ? `一键关闭将排除 ${next.length} 个实体` : '已清空一键关闭排除实体');
  }

  /** 查实体的显示名称：先查自定义名，再查已发现实体名，都没有就显示 ID。 */
  function entityDisplayName(id: string): string {
    const customName = custom?.entities?.[id]?.name;
    if (customName) return customName;
    const found = discovered?.entities.find((item) => item.id === id);
    return found?.name ?? id;
  }

  /** 切换标签；打开「记录」时按当前过滤重新拉取，保证看到最新记录。 */
  function selectTab(next: Tab) {
    setTab(next);
    if (next === 'audit') refreshAudit();
  }

  /** 标签栏方向键切换（WAI-ARIA 标签页模式）。 */
  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === tab);
    const next = tabs[(index + step + tabs.length) % tabs.length].id;
    selectTab(next);
    document.getElementById(`${formId}-tab-${next}`)?.focus();
  }

  if (!isAdmin) {
    // 非管理员：直接渲染「登录」板块，不依赖 settings 数据。
    return (
      <div className="settings">
        <LoginSection user={user} onLogout={onLogout} />
      </div>
    );
  }
  if (!settings) return <div className="settings"><p className="settings-message">正在读取设置…</p></div>;

  const live = settings.dataSource === 'live';
  const [liveTone, liveText] = connectionText(status?.ha ?? null);
  const connected = live && status?.ha.kind === 'connected';

  // “一键关闭”排除候选：已加入所选区域（区域为空=全部房间）且类别属于所选设备类别的实体，按房间分组。
  const KIND_DOMAINS: Record<string, string[]> = {
    light: ['light'], climate: ['climate'], fan: ['fan'], cover: ['cover'], switch: ['switch', 'input_boolean'],
  };
  const allOffKindDomains = new Set((settings.allOffKinds ?? ['light']).flatMap((kind) => KIND_DOMAINS[kind] ?? []));
  const allOffScopeSet = new Set(settings.allOffScopes ?? []);
  const excludeCandidates = (discovered?.entities ?? [])
    .filter((entity) => allOffKindDomains.has(entity.domain))
    .map((entity) => ({ entity, roomId: custom?.assignments?.[entity.id] ?? '' }))
    .filter(({ roomId }) => roomId && (allOffScopeSet.size === 0 || allOffScopeSet.has(roomId)));
  const excludeGroups = custom
    ? custom.rooms
        .map((room) => ({ room, items: excludeCandidates.filter((item) => item.roomId === room.id) }))
        .filter((group) => group.items.length > 0)
    : [];

  return (
    <div className="settings">
      <div className="settings-tabs-bar">
        <div className="settings-tabs" role="tablist" aria-label="设置分组" onKeyDown={handleTabKey}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} id={`${formId}-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`${formId}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => selectTab(id)}>
              <Icon size={16} />{label}
            </button>
          ))}
        </div>
      </div>

      <div id={`${formId}-panel`} className="settings-panel" role="tabpanel" aria-labelledby={`${formId}-tab-${tab}`}>
        {tab === 'connection' && <>
          <form className="settings-card" onSubmit={saveConnection}>
            <div className="settings-card__heading"><span className="tile__chip"><Server size={20} /></span><div><h3>Home Assistant 连接</h3><p>地址和令牌保存在控制台服务，令牌加密存储且不会发给浏览器；由服务统一连接 HA。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-source`}>数据来源</span>
              <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-source`}>
                {([['demo', '演示数据'], ['live', 'Home Assistant']] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={settings.dataSource === value} onClick={() => { if (value !== settings.dataSource) void save({ dataSource: value }, setConnectionMessage, value === 'live' ? '已切换到 Home Assistant' : '已切换到演示数据'); }}>{label}</button>
                ))}
              </div>
            </div>
            {live && <p className={`settings-status settings-status--${liveTone}`} role="status">{liveText}</p>}
            <label className="settings-field">
              <span>HA 地址</span>
              <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://192.168.1.10:8123" value={haUrl} onChange={(event) => setHaUrl(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>长期访问令牌</span>
              <input type="password" autoComplete="off" spellCheck={false} placeholder={settings.hasToken ? '已保存，留空则保持不变' : '在 HA 个人资料 → 安全 中创建'} value={haToken} onChange={(event) => setHaToken(event.target.value)} />
            </label>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存连接设置</button>
              {settings.hasToken && <button type="button" className="small-button" onClick={() => save({ clearToken: true }, setConnectionMessage, '已清除令牌并切回演示数据')}>清除令牌</button>}
              <FormMessage message={connectionMessage} />
            </div>
          </form>
          <form className="settings-card" onSubmit={saveGo2rtc}>
            <div className="settings-card__heading"><span className="tile__chip"><Cctv size={20} /></span><div><h3>摄像头低延迟流媒体（go2rtc）</h3><p>可选。启用后摄像头走 WebRTC（亚秒延迟、有声音、多设备同看不增加负担），自动回退 MSE / MJPEG；留空则由本机 ffmpeg 转码。</p></div></div>
            <label className="settings-field">
              <span>go2rtc 服务地址</span>
              <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://192.168.1.10:1984（留空表示不启用）" value={go2rtcUrl} onChange={(event) => setGo2rtcUrl(event.target.value)} />
            </label>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存</button>
              <button type="button" className="small-button" disabled={go2rtcBusy} onClick={detectGo2rtc}>{go2rtcBusy ? '检测中…' : '自动发现 / 测试地址'}</button>
              <FormMessage message={go2rtcMessage} />
            </div>
          </form>
        </>}

        {tab === 'connection' && <PeopleSettings settings={settings} onSettings={setSettings} onExpired={onExpired} discovered={discovered} />}

        {tab === 'rooms' && <CustomizeSettings connected={Boolean(connected)} onExpired={onExpired} />}

        {tab === 'devices' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><ShieldCheck size={20} /></span><div><h3>设备控制</h3><p>关闭后所有屏幕只能查看状态：设备按钮点击无效，编辑布局与常用设备隐藏，控制台服务也会拒绝控制请求。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-control`}>允许控制设备</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={settings.controlEnabled} aria-labelledby={`${formId}-control`} onClick={() => save({ controlEnabled: !settings.controlEnabled }, setControlMessage, settings.controlEnabled ? '已切换为只读模式' : '已允许控制设备')}><span /></button>
            </div>
            <FormMessage message={controlMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Cctv size={20} /></span><div><h3>运动检测截图</h3><p>开启后持续监测摄像头画面（优先 ONVIF 事件，不支持的摄像头用帧差兜底），检测到运动时自动截图，可在摄像头弹窗中回看。截图保留 3 天后自动删除。关闭可显著降低 CPU 占用。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-motion`}>启用截图监测</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={settings.motionCapture} aria-labelledby={`${formId}-motion`} onClick={() => save({ motionCapture: !settings.motionCapture }, setMotionMessage, settings.motionCapture ? '已停止截图监测' : '已开启截图监测')}><span /></button>
            </div>
            <FormMessage message={motionMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Power size={20} /></span><div><h3>一键关闭</h3><p>首页"正在运行"的一键关闭按钮默认只关闭灯（含常用设备中的灯）；可以在这里勾选额外的设备类别、限制区域，并排除个别实体。不选区域表示全部房间。</p></div></div>
            <div className="settings-row settings-row--wrap">
              <span id={`${formId}-allOffKinds`}>设备类别</span>
              <div className="settings-chips" role="group" aria-labelledby={`${formId}-allOffKinds`}>
                {KIND_OPTIONS.map(({ value, label }) => {
                  const current = settings.allOffKinds ?? ['light'];
                  const selected = current.includes(value);
                  return <button key={value} type="button" className={`small-button${selected ? ' small-button--selected' : ''}`} aria-pressed={selected} onClick={() => toggleAllOffKind(value)}>{label}</button>;
                })}
              </div>
            </div>
            {custom && custom.rooms.length > 0 && (
              <div className="settings-row settings-row--wrap">
                <span id={`${formId}-allOffScopes`}>区域</span>
                <div className="settings-chips" role="group" aria-labelledby={`${formId}-allOffScopes`}>
                  {custom.rooms.map((room) => {
                    const scopes = settings.allOffScopes ?? [];
                    const selected = scopes.length === 0 || scopes.includes(room.id);
                    return <button key={room.id} type="button" className={`small-button${selected ? ' small-button--selected' : ''}`} aria-pressed={selected} onClick={() => toggleAllOffScope(room.id)}>{room.name}</button>;
                  })}
                </div>
              </div>
            )}
            <div className="settings-row settings-row--wrap">
              <span id={`${formId}-allOffEntities`}>额外实体</span>
              <div className="all-off-entities">
                <div className="all-off-entities__input-row">
                  <input type="text" placeholder="输入实体 ID（如 switch.xxx）" value={entityInput} onChange={(event) => setEntityInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAllOffEntity(entityInput); } }} aria-labelledby={`${formId}-allOffEntities`} />
                  <button type="button" className="small-button" onClick={() => addAllOffEntity(entityInput)} disabled={!entityInput.trim()}><Plus size={14} />添加</button>
                </div>
                {discovered && (
                  <select className="all-off-entities__select" value="" onChange={(event) => { if (event.target.value) addAllOffEntity(event.target.value); event.target.value = ''; }} aria-label="从已发现的实体中选择">
                    <option value="">从已发现实体中选择…</option>
                    {discovered.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}（{entity.id}）</option>)}
                  </select>
                )}
                {(settings.allOffEntities ?? []).length > 0 && (
                  <ul className="all-off-entities__list">
                    {(settings.allOffEntities ?? []).map((id) => (
                      <li key={id}>
                        <span className="all-off-entities__name">{entityDisplayName(id)}</span>
                        <code className="all-off-entities__id">{id}</code>
                        <button type="button" className="icon-button" onClick={() => removeAllOffEntity(id)} aria-label={`移除 ${entityDisplayName(id)}`}><X size={14} /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="settings-row settings-row--wrap">
              <span id={`${formId}-allOffExcludes`}>排除实体</span>
              <div className="all-off-excludes">
                <p className="all-off-excludes__hint">勾选的实体即使正在运行、符合上面的类别与区域，也不会被一键关闭。候选来自已加入所选区域、且属于所选类别的设备。</p>
                {excludeGroups.length > 0 ? excludeGroups.map((group) => (
                  <div key={group.room.id} className="all-off-excludes__group">
                    <span className="all-off-excludes__room">{group.room.name}</span>
                    <div className="settings-chips" role="group" aria-label={`${group.room.name} 可排除的实体`}>
                      {group.items.map(({ entity }) => {
                        const selected = (settings.allOffExcludes ?? []).includes(entity.id);
                        return (
                          <button key={entity.id} type="button" className={`small-button${selected ? ' small-button--selected' : ''}`} aria-pressed={selected} title={entity.id} onClick={() => toggleAllOffExclude(entity.id)}>
                            {selected ? <X size={13} /> : <Plus size={13} />}{entityDisplayName(entity.id)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )) : (
                  <p className="settings-message">所选区域和类别下暂没有已加入房间的设备。</p>
                )}
                {(settings.allOffExcludes ?? []).filter((id) => !excludeCandidates.some((item) => item.entity.id === id)).length > 0 && (
                  <div className="all-off-excludes__group">
                    <span className="all-off-excludes__room">已不在候选中</span>
                    <div className="settings-chips">
                      {(settings.allOffExcludes ?? [])
                        .filter((id) => !excludeCandidates.some((item) => item.entity.id === id))
                        .map((id) => (
                          <button key={id} type="button" className="small-button small-button--selected" title={id} onClick={() => toggleAllOffExclude(id)}>
                            <X size={13} />{entityDisplayName(id)}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <FormMessage message={allOffMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><ListChecks size={20} /></span><div><h3>设备筛选</h3><p>控制台自动发现 HA 中的灯、温控、播放器、人员和常用传感器；这里按 HA 标签分组，决定哪些设备参与显示（再到“房间”标签把它们加入房间）。未显示的设备控制台服务也不允许控制；场景和脚本不在这里，由“房间”标签的情景按钮管理。在 HA 中隐藏或禁用的实体不参与发现。</p></div></div>
            <EntityFilter connected={Boolean(connected)} onExpired={onExpired} />
          </section>
        </>}

        {tab === 'music' && (
          <form className="settings-card" onSubmit={saveMusic}>
            <div className="settings-card__heading"><span className="tile__chip"><Music size={20} /></span><div><h3>音乐界面</h3></div></div>
            <label className="settings-field">
              <span>音乐界面地址</span>
              <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://192.168.1.10:4533 或 https://music.example.com" value={musicUrl} onChange={(event) => setMusicUrl(event.target.value)} />
            </label>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">保存音乐设置</button>
              {settings.musicUrl && <button type="button" className="small-button" onClick={() => { setMusicUrl(''); void save({ musicUrl: '' }, setMusicMessage, '已清空音乐界面，侧栏入口已隐藏'); }}>清空并隐藏入口</button>}
              <FormMessage message={musicMessage} />
            </div>
          </form>
        )}

        {tab === 'automations' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Sun size={20} /></span><div><h3>季节规则</h3><p>启用后，控制台用 HA 令牌在 HA 中创建并维护“控制台-季节”辅助元素和三条自动化：夏季制热一打开就关闭；夏季空调从关闭开成制热时改为制冷；冬季空调从关闭开成制冷时改为制热。送风、除湿等模式不处理。关闭后删除这三条自动化（保留季节辅助元素）。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-season-rules`}>启用季节规则</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={settings.seasonRules} aria-labelledby={`${formId}-season-rules`} onClick={() => { setSeasonMessage(null); void save({ seasonRules: !settings.seasonRules }, (message) => { if (message?.tone === 'error') setSeasonMessage(message); }, ''); }}><span /></button>
            </div>
            {settings.seasonRules && (
              <div className="settings-row">
                <span id={`${formId}-season`}>当前季节</span>
                <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-season`}>
                  {([['summer', '夏季'], ['winter', '冬季']] as const).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={settings.season === value} disabled={!settings.season && settings.dataSource === 'live'} onClick={() => { if (value !== settings.season) void save({ season: value }, setSeasonMessage, `已切换为${label}`); }}>{label}</button>
                  ))}
                </div>
              </div>
            )}
            {settings.seasonSync.message && <p className={`automation-list__note${settings.seasonSync.state === 'error' ? ' automation-list__note--error' : settings.seasonSync.state === 'ok' ? ' automation-list__note--good' : ''}`} role="status">{settings.seasonSync.state === 'error' ? '同步失败：' : ''}{settings.seasonSync.message}</p>}
            <FormMessage message={seasonMessage} />
          </section>

          <CollapsibleCard icon={Workflow} title="自动化" description={<p className="settings-message">同步 Home Assistant 中的自动化，可逐个开启或关闭；这里只切换开关，不修改自动化内容。每次切换都会写入操作记录。</p>}>
            <AutomationList canControl={settings.controlEnabled} onExpired={onExpired} />
          </CollapsibleCard>
        </>}

        {tab === 'display' && <>
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><House size={20} /></span><div><h3>名称</h3></div></div>
            <label className="settings-field"><span>家庭名称</span><input type="text" value={settings.brandTitle ?? '家庭控制'} maxLength={7} onChange={(e) => { const value = e.target.value; setSettings({ ...settings, brandTitle: value }); void save({ brandTitle: value }, setThemeMessage, '家庭名称已保存'); }} placeholder="家庭控制" /><small>显示在导航栏顶部与网页标题，最长 7 个中文字</small></label>
            <label className="settings-field"><span>首页标题</span><input type="text" value={settings.homeTitle} maxLength={12} onChange={(e) => { const value = e.target.value; setSettings({ ...settings, homeTitle: value }); void save({ homeTitle: value }, setThemeMessage, '首页标题已保存'); }} placeholder="我的家庭" /></label>
            <FormMessage message={themeMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Palette size={20} /></span><div><h3>主题</h3><p>所有屏幕共用。强调色用于选中状态、主按钮和导航高亮；灯光光晕、冷暖色和告警色按含义保持不变。自动：日出到日落使用浅色，其余时间深色；日出、日落取自该屏幕所选位置的天气，没有天气时按 06:00 与 18:00。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-theme`}>主题</span>
              <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-theme`}>
                {([['light', '浅色'], ['dark', '深色'], ['auto', '自动']] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={settings.theme === value} onClick={() => { if (value !== settings.theme) void save({ theme: value }, setThemeMessage, `已切换为${label}`); }}>{label}</button>
                ))}
              </div>
            </div>
            <div className="settings-row settings-row--accent">
              <span id={`${formId}-accent`}>强调色</span>
              <div className="settings-accents" role="radiogroup" aria-labelledby={`${formId}-accent`}>
                {ACCENTS.map(({ value, label, swatch }) => {
                  const current = (settings.accent ?? 'amber') === value;
                  return (
                    <button key={value} type="button" role="radio" aria-checked={current} aria-label={label} title={label} style={{ '--swatch': swatch } as CSSProperties} onClick={() => { if (!current) void save({ accent: value }, setThemeMessage, `强调色已切换为${label}`); }}>
                      <span aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
            <FormMessage message={themeMessage} />
          </section>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><Grid2x2 size={20} /></span><div><h3>格子大小</h3><p>所有屏幕共用。设备卡片连同文字、按钮一起按比例缩放；格子变小后同一行能放下更多卡片。</p></div></div>
            <div className="settings-scale">
              <label htmlFor={`${formId}-scale`}>缩放</label>
              <div className="settings-scale__control">
                <button type="button" className="icon-button" onClick={() => changeTileScale(-1)} disabled={(tileScale ?? 100) <= 80} aria-label="缩小 1%"><Minus size={16} /></button>
                <input id={`${formId}-scale`} type="range" min="80" max="120" step="1" value={tileScale ?? 100} onChange={(event) => { setTileScale(Number(event.target.value)); setScaleMessage(null); }} />
                <button type="button" className="icon-button" onClick={() => changeTileScale(1)} disabled={(tileScale ?? 100) >= 120} aria-label="放大 1%"><Plus size={16} /></button>
              </div>
              <output htmlFor={`${formId}-scale`}>{tileScale ?? 100}%</output>
              <button type="button" className="text-button" onClick={() => { setTileScale(100); setScaleMessage(null); }} disabled={(tileScale ?? 100) === 100}><RotateCcw size={14} />100%</button>
            </div>
            <FormMessage message={scaleMessage} />
          </section>

        </>}

        {tab === 'security' && <>
          {firstRun && (
            <section className="settings-card settings-card--warn">
              <div className="settings-card__heading"><span className="tile__chip"><ShieldCheck size={20} /></span><div><h3>管理员修改</h3><p>当前仍使用默认管理员账号 admin/admin，建议立即修改账号名与密码。</p></div></div>
              <div className="settings-actions">
                <button type="button" className="small-button small-button--selected" onClick={onOpenSetup}>立即修改管理员账号</button>
              </div>
            </section>
          )}

          <form className="settings-card" onSubmit={savePassword}>
            <div className="settings-card__heading"><span className="tile__chip"><KeyRound size={20} /></span><div><h3>管理员修改</h3><p>管理员账户名首次设置后不再可改，仅可在此修改密码；密码以 scrypt 哈希存储，连续输错会暂时锁定。</p></div></div>
            <div className="settings-field-row">
              <label className="settings-field">
                <span>当前密码</span>
                <input type="password" autoComplete="current-password" value={oldPassword} onChange={(event) => { setOldPassword(event.target.value); setPasswordMessage(null); }} />
              </label>
              <label className="settings-field">
                <span>新密码</span>
                <input type="password" autoComplete="new-password" maxLength={128} value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setPasswordMessage(null); }} />
              </label>
              <label className="settings-field">
                <span>再次输入</span>
                <input type="password" autoComplete="new-password" maxLength={128} value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setPasswordMessage(null); }} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="submit" className="small-button small-button--selected">修改密码</button>
              <FormMessage message={passwordMessage} />
            </div>
          </form>

          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><UserPlus size={20} /></span><div><h3>子账户</h3><p>子账户可登录控制台并操控设备，但不能进入除「登录」外的设置板块；任何账户操作设备的记录都会写入「记录」板块。</p></div></div>
            {accounts.filter((a) => !a.isAdmin).length > 0 && (
              <ul className="settings-audit">
                {accounts.filter((a) => !a.isAdmin).map((account) => (
                  <li key={account.id}>
                    <strong>{account.username}</strong>
                    <small>创建于 {account.createdAt.replace('T', ' ').slice(0, 16)}</small>
                    <button type="button" className="icon-button" onClick={() => removeAccount(account)} aria-label={`删除子账户 ${account.username}`}><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
            <form className="settings-field-row" onSubmit={saveNewAccount}>
              <label className="settings-field">
                <span>账户名</span>
                <input type="text" autoComplete="username" maxLength={32} placeholder="如 kid" value={newAccountName} onChange={(event) => { setNewAccountName(event.target.value); setAccountMessage(null); }} />
              </label>
              <label className="settings-field">
                <span>密码</span>
                <input type="password" autoComplete="new-password" maxLength={128} value={newAccountPassword} onChange={(event) => { setNewAccountPassword(event.target.value); setAccountMessage(null); }} />
              </label>
              <div className="settings-actions">
                <button type="submit" className="small-button"><Plus size={14} />添加子账户</button>
                <FormMessage message={accountMessage} />
              </div>
            </form>
          </section>
        </>}

        {tab === 'login' && <LoginSection user={user} onLogout={onLogout} />}

        {tab === 'audit' && (
          <section className="settings-card">
            <div className="settings-card__heading"><span className="tile__chip"><History size={20} /></span><div><h3>操作记录</h3><p>最近 50 条登录、设置、布局与设备控制记录；按账户区分，标明是谁操作了什么；不含令牌和密码。</p></div></div>
            <div className="settings-row">
              <span id={`${formId}-audit-filter`}>范围</span>
              <div className="settings-segmented" role="radiogroup" aria-labelledby={`${formId}-audit-filter`}>
                {([['all', '全部记录'], ['service_call', '仅操控设备记录']] as const).map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={auditFilter === value} onClick={() => { setAuditFilter(value); refreshAudit(value); }}>{label}</button>
                ))}
              </div>
            </div>
            {audit.length === 0 ? <p className="settings-message">暂无记录</p> : (
              <ul className="settings-audit settings-audit--with-user">
                {audit.map((entry, index) => (
                  <li key={`${entry.time}-${index}`} className={entry.event === 'login_failed' || entry.ok === false ? 'settings-audit__row--warn' : undefined}>
                    <time>{entry.time.replace('T', ' ').slice(5, 19)}</time>
                    <strong>{auditLabels[entry.event] ?? entry.event}</strong>
                    <span className="settings-audit__user">{entry.user || '—'}</span>
                    <span>{auditDetail(entry)}</span>
                    <small>{entry.ip}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** 「登录」板块：显示当前登录账户与退出登录按钮；非管理员仅可见此板块。 */
function LoginSection({ user, onLogout }: { user?: { username: string; isAdmin: boolean }; onLogout: () => void }) {
  return (
    <section className="settings-card">
      <div className="settings-card__heading"><span className="tile__chip"><LogOut size={20} /></span><div><h3>登录</h3><p>当前已登录账户；点「退出登录」后回到登录页，下次进入需重新输入账号密码。</p></div></div>
      <div className="settings-row">
        <span>账户</span>
        <strong>{user?.username ?? '—'}</strong>
        <small>{user?.isAdmin ? '管理员' : '子账户'}</small>
      </div>
      <div className="settings-actions">
        <button type="button" className="small-button small-button--danger" onClick={onLogout}><LogOut size={15} />退出登录</button>
      </div>
    </section>
  );
}

/** 人员在家设置板块：配置人员名称、实体 ID、头像图片与判定状态。 */
function PeopleSettings({ settings, onSettings, onExpired, discovered }: {
  settings: AdminSettings;
  onSettings: (settings: AdminSettings) => void;
  onExpired: (message: string) => void;
  discovered: DiscoveredEntities | null;
}) {
  const [people, setPeople] = useState<PersonConfig[]>(settings.people ?? []);
  const [name, setName] = useState('');
  const [entityId, setEntityId] = useState('');
  const [homeStates, setHomeStates] = useState('on,home');
  const [message, setMessage] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [addImage, setAddImage] = useState<File | null>(null);

  // 同步外部 settings 变化
  useEffect(() => { setPeople(settings.people ?? []); }, [settings.people]);

  // 所有可选实体（device_tracker / person / input_boolean / binary_sensor 等）
  const allEntities = discovered?.entities ?? [];
  const peopleEntities = allEntities.filter((e) =>
    ['device_tracker', 'person', 'input_boolean', 'binary_sensor', 'sensor', 'zone', 'device'].includes(e.domain)
  );

  function savePeople(updated: PersonConfig[]) {
    updateSettings({ people: updated })
      .then((result) => { onSettings(result); setPeople(result.people ?? []); setMessage({ tone: 'good', text: '已保存人员配置' }); })
      .catch((error: Error) => { if (error instanceof ApiError && error.status === 401) onExpired(error.message); else setMessage({ tone: 'error', text: error.message }); });
  }

  async function addPerson() {
    if (people.length >= 12) { setMessage({ tone: 'error', text: '最多 12 名人员' }); return; }
    const trimmedEntity = entityId.trim();
    if (!trimmedEntity) { setMessage({ tone: 'error', text: '请填写实体 ID' }); return; }
    const states = homeStates.split(',').map((s) => s.trim()).filter(Boolean);
    if (!states.length) { setMessage({ tone: 'error', text: '请至少填写一个判定在家的状态值' }); return; }
    const trimmedName = name.trim();
    const id = `p_${Date.now()}`;
    let imageFilename: string | null = null;
    if (addImage) {
      setUploading(true);
      try {
        const result = await uploadPeopleImage(addImage);
        imageFilename = result.image;
      } catch (error) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : '上传失败' });
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    const newPerson: PersonConfig = { id, name: trimmedName || '人员', entityId: trimmedEntity, image: imageFilename, homeStates: states };
    const updated = [...people, newPerson];
    setPeople(updated);
    savePeople(updated);
    setName(''); setEntityId(''); setHomeStates('on,home'); setAddImage(null);
  }

  function removePerson(id: string) {
    const updated = people.filter((p) => p.id !== id);
    setPeople(updated);
    savePeople(updated);
  }

  function updatePerson(id: string, patch: Partial<PersonConfig>) {
    const updated = people.map((p) => p.id === id ? { ...p, ...patch } : p);
    setPeople(updated);
    savePeople(updated);
  }

  async function handleUpload(id: string, file: File) {
    setUploading(true);
    try {
      const result = await uploadPeopleImage(file);
      updatePerson(id, { image: result.image });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '上传失败' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card__heading"><span className="tile__chip"><House size={20} /></span><div><h3>人员在家</h3></div></div>

      {people.length > 0 && (
        <div className="people-config-list">
          {people.map((person) => (
            <div key={person.id} className="people-config-item">
              <div className="people-config-item__avatar">
                <img src={apiPath(person.image ? `/api/people-images/${person.image}` : `/api/people-images/default_${people.indexOf(person) % 2}.jpg`)} alt={person.name} />
                <label className="people-config-item__upload" title="更换头像">
                  <Upload size={12} />
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleUpload(person.id, file); }} disabled={uploading} />
                </label>
              </div>
              <div className="people-config-item__fields">
                <span className="people-config-item__label">{person.name}</span>
                <span className="people-config-item__label">{person.entityId}</span>
                <span className="people-config-item__label">在家状态：{person.homeStates.join(', ')}</span>
              </div>
              <button type="button" className="small-button" onClick={() => removePerson(person.id)} title="删除"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="people-config-add">
        <h4>添加人员</h4>
        <div className="settings-field-row">
          <label className="settings-field"><span>名称（选填）</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 张三" /></label>
          <label className="settings-field"><span>实体 ID</span>
            <input type="text" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="device_tracker.xxx" list="people-entity-list" />
          </label>
          <label className="settings-field"><span>头像（选填）</span>
            <div className="people-config-add__upload">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif" onChange={(e) => setAddImage(e.target.files?.[0] ?? null)} />
              {addImage && <button type="button" className="small-button" onClick={() => setAddImage(null)} title="取消"><X size={12} /></button>}
            </div>
          </label>
        </div>
        <datalist id="people-entity-list">
          {peopleEntities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </datalist>
        <label className="settings-field"><span>判定在家的状态值</span><input type="text" value={homeStates} onChange={(e) => setHomeStates(e.target.value)} placeholder="on,home" /><small>实体状态等于这些值时判定为在家，用英文逗号分隔。默认 on,home</small></label>
        <div className="settings-actions">
          <button type="button" className="small-button small-button--selected" onClick={addPerson} disabled={people.length >= 12 || uploading}><Plus size={15} />{uploading ? '上传中…' : '添加人员'}</button>
          {message && <span className={`settings-message settings-message--${message.tone}`}>{message.text}</span>}
        </div>
      </div>
    </section>
  );
}
