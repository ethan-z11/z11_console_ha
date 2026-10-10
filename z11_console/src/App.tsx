import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Eye, Pencil, PersonStanding, Snowflake, Sun, Power, RotateCcw, Settings, Star } from 'lucide-react';
import { AdaptiveGrid } from './components/AdaptiveGrid';
import { ActiveDevicesDialog } from './components/ActiveDevicesDialog';
import type { ActiveListRequest } from './components/ActiveDevicesDialog';
import { BatteryDialog } from './components/BatteryDialog';
import { ClimateDialog } from './components/ClimateDialog';
import { ConnectionBadge } from './components/ConnectionBadge';
import { DeviceCard, EmptyRoomCard } from './components/DeviceCards';
import type { TilePlacement } from './components/DeviceCards';
import { CameraBoard } from './components/CameraBoard';
import { HomeStatusSummary } from './components/HomeStatusSummary';
import { LoginPage, SetupPage } from './components/AuthPages';
import { MusicPage } from './components/MusicPage';
import { RoomOrderDialog } from './components/RoomOrderDialog';
import { RoomScene } from './components/RoomScene';
import { RoomStatusSummary } from './components/RoomStatusSummary';
import { SceneBoard } from './components/SceneBoard';
import { SettingsPage } from './components/SettingsPage';
import { SideNav } from './components/SideNav';
import { WeatherCompact, WeatherDialog, WeatherHero } from './components/Weather';
import { getMe, logout, putLayout } from './consoleApi';
import { allowedSizesForDevice, favoriteIds, favoriteSizeKey, fromServerLayout, layoutKey, orderedDevices, orderedRooms, readLayout, saveLayout, tileSizeForDevice, toServerLayout, toggleFavorite } from './layout';
import { getRoomDevices, isClimate, isLit, isRunning, sortRunning } from './selectors';
import { sceneDisplayName, sceneTargetService } from './haAdapter';
import { formatDateParts, formatTime, homeGreeting, useNow } from './time';
import type { Device, DeviceActions, LayoutState, Room, TileSize } from './types';
import { useConsole } from './useConsole';
import { readOnlyActions, useHome } from './useHome';
import { useTileDrag } from './useTileDrag';
import { useWeather } from './useWeather';
import { useAlmanac } from './useAlmanac';
import { AlmanacDialog } from './components/AlmanacDialog';
import { weatherIcon } from './weather';
import { applyAccent, applyTheme, resolveTheme } from './theme';

type Page = 'home' | 'room' | 'settings' | 'music';

/** 拖动与键盘排序的作用域：常用设备，或某个房间 id。 */
const favoritesScope = 'favorites';

function presentDevices(devices: Device[], ids: string[]): Device[] {
  // hidden 子设备不在常用 / 正在运行等任何页面显示，只出现在宿主设置弹窗里。
  return ids.map((id) => devices.find((device) => device.id === id)).filter((device): device is Device => Boolean(device) && device!.hidden !== true);
}

/** 区域有人 / 无人徽标：仅在该区域配置了传感器时显示。 */
function OccupancyBadge({ occupied }: { occupied: boolean }) {
  return (
    <span className={`occupancy-badge occupancy-badge--${occupied ? 'on' : 'off'}`} title={occupied ? '传感器显示当前有人' : '传感器显示当前无人'}>
      <PersonStanding size={13} />{occupied ? '有人' : '无人'}
    </span>
  );
}

function App() {
  // 账户系统：未登录显示登录页，已登录显示主界面；firstRun=true 时管理员需到设置改账号密码。
  // HA 侧边栏 Ingress 访客（me.ingress=true 且无会话）免登录，以非管理员身份直接进主界面。
  const [auth, setAuth] = useState<{ loading: boolean; authenticated: boolean; ingress: boolean; user?: { username: string; isAdmin: boolean }; firstRun: boolean }>(
    { loading: true, authenticated: false, ingress: false, firstRun: false },
  );
  // 首跑管理员登录后直接进入「管理员修改」；用户取消后才进入主界面，仍可从 设置→安全 再次调起。
  const [setupDismissed, setSetupDismissed] = useState(false);
  useEffect(() => {
    let active = true;
    getMe()
      .then((me) => {
        if (!active) return;
        if (!me.authenticated && me.ingress) {
          // 侧边栏访客：HA 已做过登录认证，直接进入主界面（非管理员）。
          setAuth({ loading: false, authenticated: true, ingress: true, user: { username: '侧边栏访客', isAdmin: false }, firstRun: false });
          return;
        }
        setAuth({ loading: false, authenticated: me.authenticated, ingress: Boolean(me.ingress), user: me.user, firstRun: Boolean(me.firstRun) });
      })
      .catch(() => { if (active) setAuth({ loading: false, authenticated: false, ingress: false, firstRun: false }); });
    return () => { active = false; };
  }, []);
  function refreshAuth() {
    getMe().then((me) => {
      if (!me.authenticated && me.ingress) {
        setAuth({ loading: false, authenticated: true, ingress: true, user: { username: '侧边栏访客', isAdmin: false }, firstRun: false });
        return;
      }
      setAuth({ loading: false, authenticated: me.authenticated, ingress: Boolean(me.ingress), user: me.user, firstRun: Boolean(me.firstRun) });
    }).catch(() => undefined);
  }
  /** 退出登录：先调后端清除会话与 Cookie，再刷新本地鉴权状态（Ingress 下回到访客态，否则回登录页）。 */
  function handleLogout() {
    logout().finally(refreshAuth);
  }
  if (auth.loading) return <div className="auth-screen"><p className="settings-message">正在加载…</p></div>;
  if (!auth.authenticated) return <LoginPage onAuthenticated={refreshAuth} />;
  if (auth.user?.isAdmin && auth.firstRun && !setupDismissed) {
    return <SetupPage currentUsername={auth.user.username} onCompleted={refreshAuth} onCancel={() => setSetupDismissed(true)} />;
  }
  return <Console authenticated={auth} onLogout={handleLogout} onAuthenticated={refreshAuth} onOpenSetup={() => setSetupDismissed(false)} />;
}

interface ConsoleProps {
  authenticated: { loading: boolean; authenticated: boolean; ingress: boolean; user?: { username: string; isAdmin: boolean }; firstRun: boolean };
  onLogout: () => void;
  onAuthenticated: () => void;
  onOpenSetup: () => void;
}

/** 主控制台：已登录后显示。 */
function Console({ authenticated, onLogout, onAuthenticated, onOpenSetup }: ConsoleProps) {
  const server = useConsole();
  const live = server.status?.dataSource === 'live';
  const { home: sourceHome, runningIds, actions: deviceActions, refreshRunning, reset, notice, clearNotice } = useHome(
    live ? { entityStates: server.entityStates, catalogue: server.catalogue, custom: server.custom, callService: server.callService } : null,
  );
  const [page, setPage] = useState<Page>('home');
  const [selectedRoomId, setSelectedRoomId] = useState('living');
  const [selectedClimateId, setSelectedClimateId] = useState<string | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const [roomOrderOpen, setRoomOrderOpen] = useState(false);
  // 房间按共用布局排序；导航、默认房间和“正在运行”的同类排序都使用这个顺序。
  const home = useMemo(() => ({ ...sourceHome, rooms: orderedRooms(sourceHome.rooms, layout.rooms) }), [sourceHome, layout.rooms]);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  // 最近一次与后端一致的布局；为 null 表示还没收到后端布局，此前不上传本地缓存，避免旧缓存覆盖共用布局。
  const syncedLayoutRef = useRef<string | null>(null);
  const drag = useTileDrag(reorder);
  const now = useNow();
  const weather = useWeather(server.status?.weatherPlace ?? null);
  const { almanac } = useAlmanac();
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [almanacOpen, setAlmanacOpen] = useState(false);
  const [activeList, setActiveList] = useState<ActiveListRequest | null>(null);
  const [batteryOpen, setBatteryOpen] = useState(false);
  // “正在运行”的全部关闭需要二次确认：第一次点击进入确认状态，3 秒内再点才执行。
  const [confirmAllOff, setConfirmAllOff] = useState(false);
  useEffect(() => {
    if (!confirmAllOff) return;
    const timer = window.setTimeout(() => setConfirmAllOff(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmAllOff]);
  /** 页面切换方向：1 从下方进入（导航中往下），-1 从上方进入，0 淡入。 */
  const [enterDirection, setEnterDirection] = useState<-1 | 0 | 1>(0);
  // 主题：服务端设置的模式 + 本屏的日出日落（自动模式），每 15 秒随时钟重新计算，变化时才应用。
  const themeMode = server.status?.theme;
  const theme = themeMode ? resolveTheme(themeMode, now, weather.forecast) : null;
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  const accent = server.status?.accent;
  useEffect(() => { if (accent) applyAccent(accent); }, [accent]);

  // 主页时间 / 天气卡片缩放：每块屏幕各自保存在本机（localStorage），设置 → 自定义 → 主页显示里调整。
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--time-scale', localStorage.getItem('z11.scale.time') ?? '1');
    root.style.setProperty('--weather-scale', localStorage.getItem('z11.scale.weather') ?? '1');
  }, []);

  // 紧凑桌面分辨率（如 1000×595）：页头操作组移到时间与药丸之间，避免被天气卡遮挡。
  const compactQuery = '(min-width: 900px) and (max-width: 1100px) and (min-height: 520px) and (max-height: 680px)';
  const [compactHome, setCompactHome] = useState(() => typeof window !== 'undefined' && window.matchMedia(compactQuery).matches);
  useEffect(() => {
    const mq = window.matchMedia(compactQuery);
    const handler = (e: MediaQueryListEvent) => setCompactHome(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 后端推来的共用布局（首次连接或其他屏幕修改后）直接采用。
  useEffect(() => {
    if (!server.layout) return;
    const next = fromServerLayout(server.layout);
    syncedLayoutRef.current = layoutKey(next);
    setLayout(next);
  }, [server.layout]);

  // 本地修改：先写缓存，再合并 400ms 后保存到后端；与后端一致时不重复上传。
  useEffect(() => {
    saveLayout(layout);
    if (!server.connected || syncedLayoutRef.current === null || layoutKey(layout) === syncedLayoutRef.current) return;
    const timer = window.setTimeout(() => {
      putLayout(toServerLayout(layout))
        .then((saved) => { syncedLayoutRef.current = layoutKey(fromServerLayout(saved)); })
        .catch((error: Error) => setAppNotice(`布局未保存：${error.message}`));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [layout, server.connected]);

  const toast = notice ?? appNotice;
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => { clearNotice(); setAppNotice(null); }, 6000);
    return () => window.clearTimeout(timer);
  }, [toast, clearNotice]);

  const settingsExpired = useCallback((message: string) => {
    setAppNotice(message);
    setPage('home');
  }, []);

  // 只读模式下设备按钮仍可点，但操作被替换为空操作；编辑布局入口一并隐藏。后端同样会拒绝控制与布局修改。
  const canControl = server.status?.controlEnabled ?? true;
  // 情景模式按钮（设置 → 房间中自定义）：点击触发目标一键执行实体（scene/script 用 turn_on，button/input_button 用 press，automation 用 trigger）；执行期间按钮转圈。
  const [pendingSceneId, setPendingSceneId] = useState<string | null>(null);
  const runScene = (scene: { id: string; name: string; entity: string }) => {
    if (!canControl) { setAppNotice('只读模式，情景模式不会执行'); return; }
    setPendingSceneId(scene.id);
    const label = sceneDisplayName(scene, server.catalogue?.entities ?? []);
    server.callService(scene.entity, sceneTargetService(scene.entity), {})
      .catch((error: Error) => setAppNotice(`“${label}”执行失败：${error.message}`))
      .finally(() => setPendingSceneId((current) => (current === scene.id ? null : current)));
  };
  const baseActions = canControl ? deviceActions : readOnlyActions;
  // 季节规则（设置 → 自动化）：夏季不打开地暖；打开空调时直接用当季的模式，免得先开成相反模式再被 HA 自动化改回来。
  const season = server.status?.season ?? null;
  const actions: DeviceActions = canControl && season ? {
    ...baseActions,
    toggle: (id) => {
      const device = home.devices.find((item) => item.id === id);
      if (device && isClimate(device) && device.available && !device.on) {
        if (device.kind === 'heating' && season === 'summer') {
          setAppNotice(`${device.name}：夏季不能打开制热，可在 设置 → 自动化 切换季节`);
          return;
        }
        const wrong = season === 'summer' ? 'heat' : 'cool';
        const right = season === 'summer' ? 'cool' : 'heat';
        if (device.kind === 'climate' && device.mode === wrong && device.hvacModes.includes(right)) {
          baseActions.changeClimateMode(id, right);
          return;
        }
      }
      baseActions.toggle(id);
    },
    changeClimateMode: (id, mode) => {
      const device = home.devices.find((item) => item.id === id);
      if (device?.kind === 'heating' && season === 'summer' && mode !== 'off') {
        setAppNotice(`${device.name}：夏季不能打开制热，可在 设置 → 自动化 切换季节`);
        return;
      }
      baseActions.changeClimateMode(id, mode);
    },
  } : baseActions;

  // HA 模式下房间来自手动房间配置，配置加载前可能一个房间都没有。
  const selectedRoom: Room = home.rooms.find((room) => room.id === selectedRoomId) ?? home.rooms[0] ?? { id: '', name: '房间', category: 'main' };
  // 情景模式：首页板块只取指向“我的家庭”的按钮，房间板块只取指向当前房间的按钮；没有按钮时板块隐藏。
  const allScenes = server.custom?.scenes ?? [];
  const homeScenes = allScenes.filter((scene) => scene.scope === 'home');
  const roomScenes = allScenes.filter((scene) => scene.scope === selectedRoom.id);
  // 自定义 RTSP 摄像头：与情景按钮同样按作用域分首页 / 房间，显示在情景板块上一行。
  const allCameras = server.custom?.cameras ?? [];
  const homeCameras = allCameras.filter((camera) => camera.scope === 'home');
  const roomCameras = allCameras.filter((camera) => camera.scope === selectedRoom.id);
  const selectedRoomDevices = useMemo(() => orderedDevices(getRoomDevices(home, selectedRoom.id), layout.order[selectedRoom.id]), [home, selectedRoom.id, layout.order]);
  const selectedRoomLitCount = selectedRoomDevices.filter(isLit).length;
  // 区域有人传感器状态（后端按“或”计算后下发）；只给配置过传感器的区域显示徽标。
  const occupancy = server.status?.occupancy;
  const occupancyScope = page === 'room' ? selectedRoom.id : page === 'home' ? 'home' : null;
  const occupancyKnown = Boolean(occupancy && occupancyScope && occupancyScope in occupancy);
  const selectedClimate = home.devices.filter(isClimate).find((device) => device.id === selectedClimateId);
  const roomOf = (device: Device): Room => home.rooms.find((room) => room.id === device.roomId) ?? selectedRoom;
  const favorites = favoriteIds(layout);
  const favoriteDevices = presentDevices(home.devices, favorites);
  const runningDevices = sortRunning(home, presentDevices(home.devices, runningIds));
  const runningNow = runningDevices.filter(isRunning).length;
  // 常用卡片本身显示开关状态，“正在运行”只列常用里没有的设备，避免同一设备出现两次；标题仍计全屋运行总数。
  const runningOthers = runningDevices.filter((device) => !favorites.includes(device.id));
  const runningInFavorites = runningDevices.filter((device) => isRunning(device) && favorites.includes(device.id)).length;
  // “一键关闭”按设置里选的类别与区域过滤；默认只关灯，可选空调/地暖、风扇、窗帘等；额外实体 ID 也纳入。
  // 目标集合取全屋所有运行中设备（含常用设备——常用只是展示位置，不应影响能否被一键关闭），
  // 再剔除设置里勾选的排除实体。
  const allOffKinds = server.status?.allOffKinds ?? ['light'];
  const allOffScopes = server.status?.allOffScopes ?? [];
  const allOffEntities = server.status?.allOffEntities ?? [];
  const allOffExcludes = server.status?.allOffExcludes ?? [];
  const allOffTargets = runningDevices.filter((device) =>
    (allOffKinds.includes(device.kind) || (device.kind === 'heating' && allOffKinds.includes('climate'))
      || allOffEntities.includes(device.id)) &&
    !allOffExcludes.includes(device.id) &&
    device.available && isRunning(device) &&
    (allOffScopes.length === 0 || allOffScopes.includes(device.roomId)),
  );
  const homeTitle = server.status?.homeTitle || '我的家庭';
  // 音乐页内嵌地址（设置 → 音乐）；未配置时侧栏不显示入口。
  const musicUrl = (server.status?.musicUrl ?? '').trim();
  const tileScale = (server.status?.tileScale ?? 100) / 100;
  const brandTitle = server.status?.brandTitle ?? '家庭控制';
  // 农历副标题：后端内置历法计算（中国时区），点击打开黄历详情；未加载好时不显示。
  const homeSubline = almanac?.text ?? '';
  // 同步网页标题为家庭名称
  useEffect(() => { document.title = brandTitle; }, [brandTitle]);
  // 我的家庭页大标题就是当前时间：19:49 9月28日 周一（侧栏导航仍用首页名称）。
  // 时间/日期/星期三个片段各自不可拆行，换行只能发生在片段之间。
  const homeClockParts = formatDateParts(now);
  // 全屋页页头按当前天气着色，其他页面保持中性。
  const heroTone = page === 'home' && weather.forecast ? weatherIcon(weather.forecast.now.icon).tone : null;

  function reorder(scope: string, order: string[]) {
    setLayout((previous) => scope === favoritesScope ? { ...previous, favorites: order } : { ...previous, order: { ...previous.order, [scope]: order } });
  }

  function changeRoomOrder(ids: string[]) {
    setLayout((previous) => ({ ...previous, rooms: ids }));
  }

  function leaveLayoutEditing() {
    setEditingLayout(false);
    drag.cancel();
  }

  /** 按导航顺序判断切换方向：往导航下方走，新页面从下方进入。 */
  function directionTo(key: string): -1 | 0 | 1 {
    const target = navTargets.findIndex((item) => item.key === key);
    if (currentNavIndex < 0 || target < 0) return 0;
    return Math.sign(target - currentNavIndex) as -1 | 0 | 1;
  }

  function openRoom(id: string) {
    setEnterDirection(directionTo(id));
    setSelectedRoomId(id);
    leaveLayoutEditing();
    setPage('room');
  }

  function openHome() {
    setEnterDirection(directionTo('home'));
    refreshRunning();
    leaveLayoutEditing();
    setPage('home');
  }

  /** 齿轮进入设置：账户系统下任何已登录用户都可进入，权限由 SettingsPage 内按角色控制。 */
  function requestSettings() {
    if (page !== 'settings') openSettings();
  }

  function openSettings() {
    setEnterDirection(0);
    leaveLayoutEditing();
    setSelectedClimateId(null);
    setPage('settings');
  }

  /** 音乐页（侧栏入口，仅在设置里配置了内嵌地址时出现）。 */
  function openMusic() {
    if (!musicUrl) return;
    setEnterDirection(0);
    leaveLayoutEditing();
    setPage('music');
  }

  function changeSize(id: string, size: TileSize) {
    setLayout((previous) => ({ ...previous, sizes: { ...previous.sizes, [id]: size } }));
  }

  function changeFavorite(id: string) {
    setLayout((previous) => toggleFavorite(previous, id));
  }

  /** 当前页可排序的设备：全屋页为常用设备，房间页为该房间设备。 */
  function sortable(): { scope: string; ids: string[] } {
    const devices = page === 'home' ? favoriteDevices : selectedRoomDevices;
    return { scope: page === 'home' ? favoritesScope : selectedRoom.id, ids: devices.map((device) => device.id) };
  }

  function moveDevice(id: string, direction: -1 | 1) {
    const { scope, ids } = sortable();
    const index = ids.indexOf(id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    reorder(scope, ids);
  }

  function startDrag(id: string, event: PointerEvent<HTMLElement>) {
    if (!editingLayout) return;
    const { scope, ids } = sortable();
    drag.start(id, scope, ids, event);
  }

  /** 编辑布局时共用的排序属性。 */
  function editingTile(device: Device, index: number, total: number): Omit<TilePlacement, 'size'> {
    return {
      editing: editingLayout,
      index,
      total,
      onMove: moveDevice,
      onDragStart: startDrag,
      onFavoriteToggle: changeFavorite,
      favorite: favorites.includes(device.id),
      dragging: drag.view?.id === device.id,
      dropTarget: drag.view?.overId === device.id,
      dragOffset: drag.view?.id === device.id ? drag.view : undefined,
    };
  }

  function resetDemo() {
    reset();
    setSelectedClimateId(null);
  }

  // 子设备绑定：宿主设备 id → 子设备列表（hidden），供灯 / 窗帘设置弹窗渲染大卡片。
  const childDevicesByHost = useMemo(() => {
    const map = new Map<string, Device[]>();
    for (const [hostId, childIds] of Object.entries(server.custom?.children ?? {})) {
      const list = childIds
        .map((id) => home.devices.find((device) => device.id === id))
        .filter((device): device is Device => Boolean(device));
      if (list.length > 0) map.set(hostId, list);
    }
    return map;
  }, [home.devices, server.custom]);

  function card(device: Device, room: Room, tile: TilePlacement) {
    return <DeviceCard key={device.id} device={device} room={room} tile={tile} actions={actions} onOpenClimate={setSelectedClimateId} seasonLock={season === 'summer' && device.kind === 'heating' ? '夏季停用' : undefined} childDevices={childDevicesByHost.get(device.id)} />;
  }

  /** 常用区卡片可在“编辑”里切换 1×1／2×1，尺寸单独保存，不影响房间里的同一设备。 */
  function favoriteCard(device: Device, index: number) {
    return card(device, roomOf(device), {
      size: tileSizeForDevice(device, layout.sizes[favoriteSizeKey(device.id)]),
      onSizeChange: (id, size) => changeSize(favoriteSizeKey(id), size),
      ...editingTile(device, index, favoriteDevices.length),
    });
  }

  /** “正在运行”用于查看和顺手关掉，统一用单格；只能双格的（播放器）保持默认。 */
  function runningCard(device: Device) {
    return card(device, roomOf(device), { size: allowedSizesForDevice(device).includes('1x1') ? '1x1' : tileSizeForDevice(device) });
  }

  function turnOffRunning() {
    if (!confirmAllOff) {
      setConfirmAllOff(true);
      return;
    }
    setConfirmAllOff(false);
    allOffTargets.forEach((device) => actions.turnOff(device.id));
  }

  function roomCard(device: Device, index: number) {
    return card(device, selectedRoom, {
      size: tileSizeForDevice(device, layout.sizes[device.id]),
      onSizeChange: changeSize,
      ...editingTile(device, index, selectedRoomDevices.length),
    });
  }

  // 右侧内容区页面切换动画的方向基准：顺序与导航一致（首页、房间、其他空间）。
  const navTargets = [
    { key: 'home', label: homeTitle },
    ...[...home.rooms.filter((room) => room.category === 'main'), ...home.rooms.filter((room) => room.category === 'other')].map((room) => ({ key: room.id, label: room.name })),
  ];
  const currentNavIndex = page === 'home' ? 0 : page === 'room' ? navTargets.findIndex((target) => target.key === selectedRoom.id) : -1;

  // 页面切换动画：页头文字与内容按方向进入。
  const pageKey = page === 'room' ? `room-${selectedRoom.id}` : page;
  const enterClass = `page-enter page-enter--${enterDirection === 1 ? 'up' : enterDirection === -1 ? 'down' : 'fade'}`;

  const editButton = (
    <button type="button" className={`small-button${editingLayout ? ' small-button--selected' : ''}`} onClick={() => editingLayout ? leaveLayoutEditing() : setEditingLayout(true)}>
      <Pencil size={15} />{editingLayout ? '完成' : page === 'home' ? '编辑' : '编辑布局'}
    </button>
  );

  /** 页头右侧操作组：紧凑桌面分辨率下移到时间与药丸之间，避免被天气卡遮挡。 */
  const heroActions = (
    <div className="hero__actions">
      {!canControl && <span className="demo-flag demo-flag--readonly"><Eye size={14} />只读模式</span>}
      <ConnectionBadge quiet={page !== 'home'} connected={server.connected} status={server.status} staleSince={server.staleSince} offlineSince={server.offlineSince} now={now} />
      {!live && <button type="button" className="text-button" onClick={resetDemo} aria-label="重置演示设备状态"><RotateCcw size={15} />重置演示</button>}
      <button type="button" className="icon-button hero__settings" onClick={requestSettings} aria-current={page === 'settings' ? 'page' : undefined} aria-label="设置" title="设置"><Settings size={18} /></button>
    </div>
  );

  return (
    <div className="app-shell">
      <SideNav home={home} homeTitle={homeTitle} current={page === 'room' ? { roomId: selectedRoom.id } : page} now={now} onHome={openHome} onOpenRoom={openRoom} onSettings={requestSettings} onEditRooms={canControl ? () => setRoomOrderOpen(true) : undefined} onOpenMusic={musicUrl ? openMusic : undefined} people={server.status?.people} occupancy={occupancy} brandTitle={server.status?.brandTitle} />
      <header className={`hero${page === 'home' ? ' hero--home' : ''}${page === 'settings' ? ' hero--settings' : ''}${heroTone ? ` hero--weather weather--${heroTone}` : ''}`}>
        {page === 'room' && <RoomScene key={selectedRoom.id} room={selectedRoom} lit={selectedRoomLitCount > 0} />}
        <div className="hero__top">
          <span className="hero__brand">{homeGreeting(now)}</span>
          {(!compactHome || page !== 'home') && heroActions}
        </div>
        <div className={`hero__body ${enterClass}`} key={pageKey}>
          <div className="hero__main">
            <div className="hero__title">
              <div>
                <h1>{page === 'room' ? selectedRoom.name : page === 'settings' ? '设置' : page === 'music' ? '音乐' : <span className="datetime"><span className="datetime__time">{formatTime(now)}</span> <span className="datetime__part">{homeClockParts.monthDay}</span> <span className="datetime__part">{homeClockParts.weekday}</span></span>}{page === 'home' && season && <span className={`season-badge season-badge--${season}`} title="季节规则（设置 → 自动化）">{season === 'summer' ? <Sun size={14} /> : <Snowflake size={14} />}{season === 'summer' ? '夏季' : '冬季'}</span>}{occupancyKnown && occupancyScope && <OccupancyBadge occupied={occupancy?.[occupancyScope] === true} />}</h1>
                {page === 'home'
                  ? (homeSubline
                    ? <p><button type="button" className="hero__subline-button" onClick={() => setAlmanacOpen(true)} title="点击查看农历详情">{homeSubline}</button></p>
                    : null)
                  : <p>{page === 'room' ? '房间状态与设备控制' : page === 'settings' ? '管理密码、Home Assistant 连接与控制权限' : '内嵌音乐界面'}</p>}
              </div>
              {page === 'home' && <WeatherCompact weather={weather} onOpen={() => setWeatherOpen(true)} />}
            </div>
            {compactHome && page === 'home' ? (
              <div className="hero__pills-row">
                {heroActions}
                <HomeStatusSummary home={home} onOpen={setActiveList} onOpenBattery={() => setBatteryOpen(true)} batteryEnabled={server.custom?.battery?.enabled !== false} />
              </div>
            ) : (
              <>
                {page === 'room' && <RoomStatusSummary home={home} roomId={selectedRoom.id} onOpen={setActiveList} />}
                {page === 'home' && <HomeStatusSummary home={home} onOpen={setActiveList} onOpenBattery={() => setBatteryOpen(true)} batteryEnabled={server.custom?.battery?.enabled !== false} />}
              </>
            )}
          </div>
        </div>
        {page === 'home' && <WeatherHero weather={weather} now={now} onOpen={() => setWeatherOpen(true)} />}
      </header>

      <main className={`main-content ${enterClass}`} key={pageKey}>
        {page === 'home' && (
          <>
            <div className="home-date-card" aria-hidden="true">
              <span className="home-date-card__day">{homeClockParts.monthDay}</span>
              <span className="home-date-card__weekday">{homeClockParts.weekday}</span>
            </div>
            {homeCameras.length > 0 && <CameraBoard title="摄像头" cameras={homeCameras} scale={tileScale} go2rtcEnabled={server.status?.go2rtc?.enabled ?? false} />}
            {homeScenes.length > 0 && <SceneBoard title="常用情景" scenes={homeScenes} entities={server.catalogue?.entities ?? []} pendingId={pendingSceneId} onRun={runScene} />}
            <div className="section-heading">
              <h2>常用设备</h2>
              <div className="section-heading__actions">
                <span>{!canControl ? '只读模式，设备操作不会执行' : editingLayout ? '拖动调整顺序，右下角切换尺寸，点 ★ 移出常用' : '在房间“编辑布局”里点 ☆ 加入常用'}</span>
                {canControl && (favoriteDevices.length > 0 || editingLayout) && editButton}
              </div>
            </div>
            {favoriteDevices.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--quick" scale={tileScale}>{favoriteDevices.map(favoriteCard)}</AdaptiveGrid>
              : <div className="empty-room"><span className="tile__chip"><Star size={20} /></span><p>还没有常用设备。进入房间点“编辑布局”，给设备点 ☆ 即可加入。</p></div>}
            <div className="section-heading section-heading--spaced">
              <h2>正在运行</h2>
              <div className="section-heading__actions">
                {runningInFavorites > 0 && <span>{runningOthers.length > 0 ? `其中 ${runningInFavorites} 个在常用设备中` : `都在上方常用设备中`}</span>}
                {canControl && allOffTargets.length > 0 && (
                  <button type="button" className={`small-button${confirmAllOff ? ' small-button--danger' : ''}`} onClick={turnOffRunning} title="一键关闭正在运行的设备（在设置 → 设备里配置类别与区域）">
                    <Power size={15} />{confirmAllOff ? `确认关闭 ${allOffTargets.length} 个` : '一键关闭'}
                  </button>
                )}
              </div>
            </div>
            {runningOthers.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--running" scale={tileScale}>{runningOthers.map(runningCard)}</AdaptiveGrid>
              : runningNow === 0 && <div className="empty-room"><span className="tile__chip"><Power size={20} /></span><p>目前没有打开的设备。</p></div>}
          </>
        )}
        {page === 'room' && (
          <>
            {roomCameras.length > 0 && <CameraBoard title="摄像头" cameras={roomCameras} scale={tileScale} go2rtcEnabled={server.status?.go2rtc?.enabled ?? false} />}
            {roomScenes.length > 0 && <SceneBoard title="情景模式" scenes={roomScenes} entities={server.catalogue?.entities ?? []} pendingId={pendingSceneId} onRun={runScene} />}
            <div className="section-heading">
              <h2>设备与状态</h2>
              <div className="section-heading__actions">
                {selectedRoomLitCount > 0 && <span className="section-heading__lit">{selectedRoomLitCount} 盏灯亮</span>}
                {canControl && editButton}
              </div>
            </div>
            {selectedRoomDevices.length > 0
              ? <AdaptiveGrid className="tile-grid tile-grid--room" scale={tileScale}>{selectedRoomDevices.map(roomCard)}</AdaptiveGrid>
              : <EmptyRoomCard name={selectedRoom.name} />}
          </>
        )}
        {page === 'settings' && <SettingsPage status={server.status} user={authenticated.user} ingress={authenticated.ingress} firstRun={authenticated.firstRun} onLogout={onLogout} onAuthenticated={onAuthenticated} onOpenSetup={onOpenSetup} onExpired={settingsExpired} />}
        {page === 'music' && (musicUrl ? <MusicPage url={musicUrl} /> : <div className="empty-room"><p>还没有配置音乐界面，请到 设置 → 音乐 中填写地址。</p></div>)}
      </main>

      <RoomOrderDialog open={roomOrderOpen && canControl} rooms={home.rooms} onChange={changeRoomOrder} onClose={() => setRoomOrderOpen(false)} />
      {toast && <div className="toast" role="alert" onClick={() => { clearNotice(); setAppNotice(null); }}>{toast}</div>}
      <ActiveDevicesDialog request={activeList} home={home} actions={actions} canControl={canControl} onClose={() => setActiveList(null)} />
      {batteryOpen && <BatteryDialog batteries={home.batteries} home={home} onClose={() => setBatteryOpen(false)} />}
      <WeatherDialog open={weatherOpen} weather={weather} now={now} onClose={() => setWeatherOpen(false)} />
      <AlmanacDialog open={almanacOpen} almanac={almanac} onClose={() => setAlmanacOpen(false)} />
      <ClimateDialog climate={selectedClimate} room={selectedClimate && roomOf(selectedClimate)} actions={actions} onClose={() => setSelectedClimateId(null)} />
    </div>
  );
}

export default App;
