import { ArrowDown, ArrowUp, Cctv, DoorOpen, Droplets, House, Pencil, PersonStanding, Plus, Search, Sparkles, Thermometer, Trash2, X } from 'lucide-react';
import { CollapsibleCard } from './CollapsibleCard';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ApiError, getCustom, getEntities, putCustom } from '../consoleApi';
import type { DiscoveredEntities } from '../consoleApi';
import type { CameraType, CatalogueEntity, CustomConfig, LabelInfo, MetricName } from '../consoleClient';
import { cameraType } from '../consoleClient';
import { entityKindLabel, isSceneTarget, sceneDisplayName } from '../haAdapter';
import { findAnyIcon, findSceneIcon, DEVICE_ICONS, PHU_ICONS, ROOM_ICONS, SCENE_ICONS } from '../icons';
import type { IconChoice } from '../icons';
import { roomIcon } from '../appearance';

/** 设置列表中回显摄像头接入信息时隐藏账号密码：RTSP 只留主机端口路径，ONVIF 显示 onvif://主机:端口。 */
function describeCamera(camera: CustomConfig['cameras'][number]): string {
  if (cameraType(camera) === 'onvif') return `onvif://${camera.host ?? ''}:${camera.port ?? 8000}`;
  const url = camera.rtspUrl ?? '';
  try {
    const parsed = new URL(url);
    return `rtsp://${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

const ONVIF_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

interface CustomizeSettingsProps {
  /** HA 已连接时才能读取发现结果与保存配置。 */
  connected: boolean;
  onExpired: (message: string) => void;
}

const ROOM_NAME_MAX = 12;
const SCENE_NAME_MAX = 12;
const NO_LABEL = '__no_label__';

/** 前端生成的 id 与后端校验保持一致：字母数字下划线短横线，1–48 位。 */
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 可加入房间的设备类实体；人员与农历是全局信息，一键执行类实体只属于情景按钮。 */
function isRoomDevice(entity: CatalogueEntity): boolean {
  // 规则：unavailable 的实体不能进入可选范围（已在房间里的设备仍以离线卡片显示，不在这里移除）。
  if (entity.available === false) return false;
  if (entity.domain === 'light' || entity.domain === 'climate' || entity.domain === 'media_player' || entity.domain === 'fan' || entity.domain === 'cover' || entity.domain === 'vacuum' || entity.domain === 'switch' || entity.domain === 'input_boolean') return true;
  if (entity.domain === 'binary_sensor') return Boolean(entity.deviceClass);
  if (entity.domain === 'sensor') return entity.deviceClass === 'temperature' || entity.deviceClass === 'humidity' || entity.deviceClass === 'battery';
  return false;
}

const validManualTarget = (id: string) => /^(scene|script|button|input_button|automation)\.[A-Za-z0-9_]{1,64}$/.test(id.trim());

const METRIC_ROWS: { metric: MetricName; label: string }[] = [
  { metric: 'temperature', label: '温度' },
  { metric: 'humidity', label: '湿度' },
];

/** 可作“有人”判断的实体：名称（设备名或实体名）含“人”的在线 binary_sensor / sensor（人体 / 人在传感器）。 */
function isOccupancyCandidate(entity: CatalogueEntity): boolean {
  return entity.available !== false
    && (entity.domain === 'binary_sensor' || entity.domain === 'sensor')
    && Boolean(entity.deviceName?.includes('人') || entity.name.includes('人'));
}

/** 存在 / 占用 / 人体移动类设备在选择列表中排最前。 */
const OCCUPANCY_PRIORITY_CLASSES = new Set(['presence', 'occupancy', 'motion']);
const occupancyRank = (entity: CatalogueEntity) => (entity.deviceClass && OCCUPANCY_PRIORITY_CLASSES.has(entity.deviceClass) ? 0 : 1);

/** 区域有人传感器一行：按钮打开多选弹窗；已选时显示数量与名称，可清空。 */
function OccupancyRow({ scopeName, entityIds, candidates, onSave, onClear }: {
  entityIds: string[];
  candidates: CatalogueEntity[];
  scopeName: string;
  onSave: (entityIds: string[]) => void;
  onClear: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const names = entityIds.map((id) => candidates.find((entity) => entity.id === id)?.name ?? id);
  return (
    <div className="metric-source-row">
      <span className="metric-source-row__label"><PersonStanding size={14} />有人传感器</span>
      {entityIds.length > 0
        ? <button type="button" className="metric-source-row__current" onClick={() => setPickerOpen(true)} title="点击重新选择"><span className="metric-source-row__entity">{names.slice(0, 3).join('、')}{names.length > 3 ? ` 等 ${names.length} 个` : `（${names.length}）`}</span><em>任一有人即显示有人</em></button>
        : <button type="button" className="small-button" onClick={() => setPickerOpen(true)}><Plus size={15} />选择传感器</button>}
      {entityIds.length > 0 && <button type="button" className="icon-button" onClick={onClear} aria-label="清空有人传感器"><Trash2 size={16} /></button>}
      {pickerOpen && (
        <OccupancyPicker
          scopeName={scopeName}
          candidates={candidates}
          current={entityIds}
          onClose={() => setPickerOpen(false)}
          onSave={(ids) => { onSave(ids); setPickerOpen(false); }}
        />
      )}
    </div>
  );
}

/** 有人传感器多选弹窗：勾选 binary_sensor / sensor（可多选，或关系）；带搜索，存在类排最前。 */
function OccupancyPicker({ scopeName, candidates, current, onSave, onClose }: {
  scopeName: string;
  candidates: CatalogueEntity[];
  current: string[];
  onSave: (entityIds: string[]) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pickerSearchId = useId();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(current));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const close = () => dialogRef.current?.close();
  const handleKey = (event: KeyboardEvent<HTMLDialogElement>) => { if (event.key === 'Escape') event.preventDefault(); };

  const keyword = query.trim().toLowerCase();
  const matches = candidates
    .filter((entity) => !keyword || entity.name.toLowerCase().includes(keyword) || entity.id.toLowerCase().includes(keyword))
    .sort((a, b) => occupancyRank(a) - occupancyRank(b));
  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <dialog ref={dialogRef} className="device-dialog customize-dialog" aria-labelledby={`${pickerSearchId}-title`} onKeyDown={handleKey} onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>{scopeName}</small><h2 id={`${pickerSearchId}-title`}>选择有人传感器</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="完成"><X size={20} /></button>
      </div>
      <div className="customize-dialog__body">
        <p className="settings-message">可多选：只要其中一个实体显示“有人”（binary_sensor 为“开”，sensor 状态为 on / home / true / 1 / present 等），该区域就显示有人。</p>
        <div className="entity-filter__tools">
          <label className="entity-filter__search" htmlFor={`${pickerSearchId}-q`}>
            <Search size={16} />
            <input id={`${pickerSearchId}-q`} type="search" placeholder="搜索名称或实体 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        {matches.length === 0 ? <p className="settings-message">没有匹配的实体</p> : (
          <section className="entity-filter__group">
            <h4>二进制传感器 / 传感器<em>{matches.length}</em></h4>
            <ul>
              {matches.map((entity) => (
                <li key={entity.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(entity.id)} onChange={() => toggle(entity.id)} />
                    <span className="entity-filter__name">{entity.name}{entity.deviceClass && <em className="entity-filter__class">{entityKindLabel(entity)}</em>}</span>
                    <code>{entity.id}</code>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="customize-dialog__footer">
        <span className="settings-message">已选 {picked.size} 个（或关系）</span>
        <button type="button" className="small-button small-button--selected" onClick={() => onSave(candidates.filter((entity) => picked.has(entity.id)).map((entity) => entity.id))}>完成</button>
      </div>
    </dialog>
  );
}

/** 温湿度来源一行：按钮打开勾选弹窗；已选时显示实体与参数，可更换或删除。 */
function MetricSourceRow({ metric, label, icon, source, candidates, scopeName, onPick, onClear }: {
  metric: MetricName;
  label: string;
  icon: ReactNode;
  source?: { entity: string; attribute: string };
  candidates: CatalogueEntity[];
  scopeName: string;
  onPick: (entityId: string, attribute: string) => void;
  onClear: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = source ? candidates.find((entity) => entity.id === source.entity) : undefined;
  const attributeLabel = selected?.metrics?.find((item) => item.metric === metric && item.key === source?.attribute)?.label ?? source?.attribute;
  return (
    <div className="metric-source-row">
      <span className="metric-source-row__label">{icon}{label}</span>
      {source
        ? <button type="button" className="metric-source-row__current" onClick={() => setPickerOpen(true)} title="点击更换来源"><span className="metric-source-row__entity">{selected?.name ?? source.entity}</span><em>{attributeLabel}</em></button>
        : <button type="button" className="small-button" onClick={() => setPickerOpen(true)}><Plus size={15} />选择{label}实体</button>}
      {source && <button type="button" className="icon-button" onClick={onClear} aria-label={`删除${label}来源`}><Trash2 size={16} /></button>}
      {pickerOpen && (
        <MetricPicker
          metric={metric}
          label={label}
          scopeName={scopeName}
          candidates={candidates}
          current={source}
          onClose={() => setPickerOpen(false)}
          onSave={(entityId, attribute) => { onPick(entityId, attribute); setPickerOpen(false); }}
        />
      )}
    </div>
  );
}

/** 温湿度来源勾选弹窗：先勾选实体（单选），再勾选用它的哪个数值参数（单选），完成后保存。 */
function MetricPicker({ metric, label, scopeName, candidates, current, onSave, onClose }: {
  metric: MetricName;
  label: string;
  scopeName: string;
  candidates: CatalogueEntity[];
  current?: { entity: string; attribute: string };
  onSave: (entityId: string, attribute: string) => void;
  onClose: () => void;
}
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pickerSearchId = useId();
  const [query, setQuery] = useState('');
  const [entityId, setEntityId] = useState(current?.entity ?? '');
  const currentEntity = candidates.find((entity) => entity.id === entityId);
  const options = currentEntity?.metrics?.filter((item) => item.metric === metric) ?? [];
  const [attribute, setAttribute] = useState(current?.attribute && options.some((item) => item.key === current.attribute) ? current.attribute : options[0]?.key ?? '');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const close = () => dialogRef.current?.close();
  const handleKey = (event: KeyboardEvent<HTMLDialogElement>) => { if (event.key === 'Escape') event.preventDefault(); };

  const keyword = query.trim().toLowerCase();
  const matches = candidates.filter((entity) => !keyword || entity.name.toLowerCase().includes(keyword) || entity.id.toLowerCase().includes(keyword));
  const chooseEntity = (id: string) => {
    setEntityId(id);
    const first = candidates.find((entity) => entity.id === id)?.metrics?.find((item) => item.metric === metric)?.key ?? '';
    setAttribute(first);
  };

  return (
    <dialog ref={dialogRef} className="device-dialog customize-dialog" aria-labelledby={`${pickerSearchId}-title`} onKeyDown={handleKey} onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>{scopeName}</small><h2 id={`${pickerSearchId}-title`}>选择{label}来源</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="完成"><X size={20} /></button>
      </div>
      <div className="customize-dialog__body">
        <div className="entity-filter__tools">
          <label className="entity-filter__search" htmlFor={`${pickerSearchId}-q`}>
            <Search size={16} />
            <input id={`${pickerSearchId}-q`} type="search" placeholder="搜索名称或实体 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        {matches.length === 0 ? <p className="settings-message">没有匹配的实体</p> : (
          <section className="entity-filter__group">
            <h4>提供{label}的实体<em>{matches.length}</em></h4>
            <ul>
              {matches.map((entity) => (
                <li key={entity.id}>
                  <label>
                    <input type="radio" name={`${pickerSearchId}-entity`} checked={entityId === entity.id} onChange={() => chooseEntity(entity.id)} />
                    <span className="entity-filter__name">{entity.name}</span>
                    <code>{entity.id}</code>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
        {currentEntity && options.length > 0 && (
          <section className="entity-filter__group metric-param-group">
            <h4>选择{label}参数<em>{options.length}</em></h4>
            <ul>
              {options.map((option) => (
                <li key={option.key}>
                  <label>
                    <input type="radio" name={`${pickerSearchId}-attr`} checked={attribute === option.key} onChange={() => setAttribute(option.key)} />
                    <span className="entity-filter__name">{option.label}</span>
                    <code>{option.key === 'state' ? '状态值' : option.key}</code>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="customize-dialog__footer">
        <button type="button" className="small-button small-button--selected" disabled={!entityId || !attribute} onClick={() => entityId && attribute && onSave(entityId, attribute)}>完成</button>
      </div>
    </dialog>
  );
}

/** 图标选择弹窗状态：给房间、新建情景共用；编辑情景的图标弹窗在其组件内部自持。 */
type IconPickerState =
  | { kind: 'room'; roomId: string }
  | { kind: 'scene-add' }
  | null;

/** 设置 → 房间：完全手动维护房间、设备归属和情景模式按钮；配置整份保存在控制台后端，所有屏幕共用。 */
export function CustomizeSettings({ connected, onExpired }: CustomizeSettingsProps) {
  const searchId = useId();
  const [data, setData] = useState<DiscoveredEntities | null>(null);
  const [custom, setCustom] = useState<CustomConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [confirmRoomId, setConfirmRoomId] = useState<string | null>(null);
  const [pickerRoomId, setPickerRoomId] = useState<string | null>(null);
  const [sceneName, setSceneName] = useState('');
  const [sceneScope, setSceneScope] = useState('home');
  const [cameraName, setCameraName] = useState('');
  const [cameraKind, setCameraKind] = useState<CameraType>('rtsp');
  const [cameraUrl, setCameraUrl] = useState('');
  const [cameraHost, setCameraHost] = useState('');
  const [cameraPort, setCameraPort] = useState('8000');
  const [cameraUser, setCameraUser] = useState('');
  const [cameraPassword, setCameraPassword] = useState('');
  const [cameraScope, setCameraScope] = useState('home');
  const [cameraError, setCameraError] = useState<string | null>(null);
  // 非 null 表示表单正用于编辑这台摄像头（复用添加表单，按类型显示不同字段）。
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null);
  const cameraFormRef = useRef<HTMLDivElement | null>(null);
  const [sceneTarget, setSceneTarget] = useState('');
  const [manualTarget, setManualTarget] = useState('');
  const [sceneIcon, setSceneIcon] = useState('');
  const [iconPicker, setIconPicker] = useState<IconPickerState>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editingEntity, setEditingEntity] = useState<CatalogueEntity | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    Promise.all([getEntities(), getCustom()])
      .then(([entities, config]) => { if (active) { setData(entities); setCustom(config); } })
      .catch((reason: Error) => { if (!active) return; if (reason instanceof ApiError && reason.status === 401) onExpired(reason.message); else setError(reason.message); });
    return () => { active = false; };
  }, [connected, onExpired]);

  /** 整份乐观保存；失败回滚并提示。保存成功以后端清洗后的版本为准。 */
  async function mutate(next: CustomConfig, success: string) {
    if (!custom) return;
    const previous = custom;
    setCustom(next);
    setError(null);
    setMessage(null);
    try {
      setCustom(await putCustom(next));
      setMessage(success);
    } catch (reason) {
      setCustom(previous);
      if (reason instanceof ApiError && reason.status === 401) onExpired(reason.message);
      else setError(reason instanceof Error ? reason.message : '保存失败');
    }
  }

  function addRoom() {
    if (!custom) return;
    const name = newRoomName.trim();
    if (!name) return;
    if (name.length > ROOM_NAME_MAX) { setError(`房间名称最多 ${ROOM_NAME_MAX} 个字`); return; }
    if (custom.rooms.some((room) => room.name === name)) { setError('已有同名房间'); return; }
    setNewRoomName('');
    void mutate({ ...custom, rooms: [...custom.rooms, { id: newId('r'), name, icon: '' }] }, `已新建房间“${name}”`);
  }

  function moveRoom(index: number, delta: number) {
    if (!custom) return;
    const target = index + delta;
    if (target < 0 || target >= custom.rooms.length) return;
    const rooms = [...custom.rooms];
    [rooms[index], rooms[target]] = [rooms[target], rooms[index]];
    void mutate({ ...custom, rooms }, '房间顺序已保存');
  }

  function setRoomIcon(roomId: string, icon: string) {
    if (!custom) return;
    const rooms = custom.rooms.map((room) => (room.id === roomId ? { ...room, icon } : room));
    setIconPicker(null);
    void mutate({ ...custom, rooms }, '房间图标已更换');
  }

  function deleteRoom(roomId: string) {
    if (!custom) return;
    // 关键：同时从 rooms 移除房间本身，否则设备清掉了房间区域仍会保留。
    const rooms = custom.rooms.filter((room) => room.id !== roomId);
    const assignments = Object.fromEntries(Object.entries(custom.assignments).filter(([, id]) => id !== roomId));
    const scenes = custom.scenes.filter((scene) => scene.scope !== roomId);
    const cameras = custom.cameras.filter((camera) => camera.scope !== roomId);
    const occupancy = Object.fromEntries(Object.entries(custom.occupancy ?? {}).filter(([scope]) => scope !== roomId));
    setConfirmRoomId(null);
    void mutate({ ...custom, rooms, assignments, scenes, cameras, occupancy }, '房间已删除，其中的设备改为未加入任何房间');
  }

  /** 在选择器中勾选 / 取消设备：勾选即移动到该房间（一个设备只能属于一个房间），取消则变为未加入。 */
  function toggleAssignment(entityId: string, roomId: string, checked: boolean) {
    if (!custom) return;
    const assignments = { ...custom.assignments };
    if (checked) assignments[entityId] = roomId;
    else delete assignments[entityId];
    void mutate({ ...custom, assignments }, checked ? '已加入房间' : '已移出房间');
  }

  /** 保存单个设备的显示覆盖（改名 / 自定义图标）。 */
  function saveEntityOverride(entityId: string, draft: { name: string; icon: string }) {
    if (!custom) return;
    const entities = { ...custom.entities };
    if (!draft.name && !draft.icon) {
      delete entities[entityId];
    } else {
      entities[entityId] = { name: draft.name, icon: draft.icon };
    }
    void mutate({ ...custom, entities }, '设备显示已保存');
  }

  function addScene() {
    if (!custom) return;
    const name = sceneName.trim();
    const target = manualTarget.trim() || sceneTarget;
    if (name.length > SCENE_NAME_MAX) { setError(`按钮名称最多 ${SCENE_NAME_MAX} 个字`); return; }
    if (!target || (!validManualTarget(target))) { setError('请选择情景实体：场景、脚本、按钮、虚拟按钮或自动化'); return; }
    if (sceneScope !== 'home' && !custom.rooms.some((room) => room.id === sceneScope)) { setError('请选择放置位置'); return; }
    setSceneName('');
    setSceneTarget('');
    setManualTarget('');
    setSceneIcon('');
    void mutate({ ...custom, scenes: [...custom.scenes, { id: newId('s'), name, entity: target, scope: sceneScope, icon: sceneIcon }] }, `已添加情景“${name || target}”`);
  }

  function deleteScene(sceneId: string) {
    if (!custom) return;
    void mutate({ ...custom, scenes: custom.scenes.filter((scene) => scene.id !== sceneId) }, '情景按钮已删除');
  }

  /** 同一放置位置内上移 / 下移情景按钮（数组顺序即展示顺序）。 */
  function moveScene(sceneId: string, delta: -1 | 1) {
    if (!custom) return;
    const current = custom.scenes.find((scene) => scene.id === sceneId);
    if (!current) return;
    const sameScope = custom.scenes.filter((scene) => scene.scope === current.scope);
    const index = sameScope.indexOf(current);
    const other = sameScope[index + delta];
    if (!other) return;
    const scenes = [...custom.scenes];
    const a = scenes.indexOf(current);
    const b = scenes.indexOf(other);
    [scenes[a], scenes[b]] = [scenes[b], scenes[a]];
    void mutate({ ...custom, scenes }, '情景顺序已保存');
  }

  /** 编辑已有情景：改名（可空，回退实体名）、改目标实体、改图标；位置不可改（删除后在新位置重建即可）。 */
  function saveSceneEdit(sceneId: string, draft: { name: string; target: string; icon: string }) {
    if (!custom) return;
    const name = draft.name.trim();
    if (name.length > SCENE_NAME_MAX) { setError(`按钮名称最多 ${SCENE_NAME_MAX} 个字`); return; }
    if (!draft.target || !validManualTarget(draft.target)) { setError('请选择情景实体：场景、脚本、按钮、虚拟按钮或自动化'); return; }
    const scenes = custom.scenes.map((scene) => (scene.id === sceneId ? { ...scene, name, entity: draft.target, icon: draft.icon } : scene));
    setEditingSceneId(null);
    void mutate({ ...custom, scenes }, '情景按钮已更新');
  }

  function resetCameraForm() {
    setEditingCameraId(null);
    setCameraName('');
    setCameraKind('rtsp');
    setCameraUrl('');
    setCameraHost('');
    setCameraPort('8000');
    setCameraUser('');
    setCameraPassword('');
    setCameraScope('home');
    setCameraError(null);
  }

  function startEditCamera(camera: CustomConfig['cameras'][number]) {
    const kind = cameraType(camera);
    setEditingCameraId(camera.id);
    setCameraName(camera.name);
    setCameraKind(kind);
    setCameraScope(camera.scope ?? 'home');
    setCameraError(null);
    if (kind === 'rtsp') {
      setCameraUrl(camera.rtspUrl ?? '');
      setCameraHost('');
      setCameraPort('8000');
      setCameraUser('');
      setCameraPassword('');
    } else {
      setCameraUrl(camera.rtspUrl ?? '');
      setCameraHost(camera.host ?? '');
      setCameraPort(String(camera.port ?? 8000));
      setCameraUser(camera.username ?? '');
      setCameraPassword(camera.password ?? '');
    }
    cameraFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function submitCamera() {
    if (!custom) return;
    const name = cameraName.trim();
    if (!name) { setCameraError('请填写摄像头名称'); return; }
    if (name.length > 12) { setCameraError('摄像头名称最多 12 个字'); return; }
    if (cameraScope !== 'home' && !custom.rooms.some((room) => room.id === cameraScope)) { setCameraError('请选择放置位置'); return; }
    let entry: CustomConfig['cameras'][number];
    if (cameraKind === 'rtsp') {
      const url = cameraUrl.trim();
      if (!/^rtsp:\/\//i.test(url) || url.length > 300 || /\s/.test(url)) { setCameraError('请填写以 rtsp:// 开头的完整地址（不含空格），可含账号密码'); return; }
      entry = { id: editingCameraId ?? newId('c'), name, type: 'rtsp', rtspUrl: url, scope: cameraScope };
    } else {
      const host = cameraHost.trim();
      const port = cameraPort.trim() === '' ? 8000 : Number(cameraPort);
      const username = cameraUser.trim();
      const password = cameraPassword;
      if (!ONVIF_HOST_RE.test(host) || host.length > 128) { setCameraError('请填写摄像头主机地址（IP 或域名，不含 http://、端口和斜杠）'); return; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { setCameraError('端口需为 1–65535 的数字（ONVIF 常见为 8000）'); return; }
      if (!username || username.length > 64) { setCameraError('请填写 ONVIF 登录用户名'); return; }
      if (password.length > 128) { setCameraError('登录密码最多 128 个字'); return; }
      const url = cameraUrl.trim();
      if (url && (!/^rtsp:\/\//i.test(url) || url.length > 300 || /\s/.test(url))) { setCameraError('画面地址需以 rtsp:// 开头（不含空格），或留空由 ONVIF 自动探测'); return; }
      entry = { id: editingCameraId ?? newId('c'), name, type: 'onvif', host, port, username, password, scope: cameraScope, ...(url ? { rtspUrl: url } : {}) };
      // 编辑参数时保留原来的单台运动检测开关。
      const previous = editingCameraId ? custom.cameras.find((camera) => camera.id === editingCameraId) : undefined;
      if (previous?.motionEnabled === false) entry.motionEnabled = false;
    }
    const cameras = editingCameraId
      ? custom.cameras.map((camera) => (camera.id === editingCameraId ? entry : camera))
      : [...custom.cameras, entry];
    void mutate({ ...custom, cameras }, editingCameraId ? `摄像头“${name}”的参数已更新` : `已添加摄像头“${name}”`);
    resetCameraForm();
  }

  function deleteCamera(cameraId: string) {
    if (!custom) return;
    if (editingCameraId === cameraId) resetCameraForm();
    void mutate({ ...custom, cameras: custom.cameras.filter((camera) => camera.id !== cameraId) }, '摄像头已删除');
  }

  /** 单台摄像头的运动检测开关（仅 ONVIF 参与监测）；缺省视为开启，关掉时写入 false。 */
  function toggleCameraMotion(cameraId: string) {
    if (!custom) return;
    const target = custom.cameras.find((camera) => camera.id === cameraId);
    if (!target) return;
    const enabled = target.motionEnabled !== false;
    const cameras = custom.cameras.map((camera) => {
      if (camera.id !== cameraId) return camera;
      if (enabled) return { ...camera, motionEnabled: false };
      const { motionEnabled: _removed, ...rest } = camera;
      return rest;
    });
    void mutate({ ...custom, cameras }, enabled ? `已停止「${target.name}」的截图监测` : `已开启「${target.name}」的截图监测`);
  }

  /** 保存某作用域（主页 / 房间）某指标的温湿度来源；同槽位再次保存即自动替代原条目。 */
  function saveMetricSource(scope: string, metric: MetricName, entityId: string, attribute: string) {
    if (!custom || !data) return;
    const existing = custom.metricSources?.find((item) => item.scope === scope && item.metric === metric);
    const others = (custom.metricSources ?? []).filter((item) => !(item.scope === scope && item.metric === metric));
    const next = [...others, { id: existing?.id ?? newId('m'), scope, metric, entity: entityId, attribute }];
    void mutate({ ...custom, metricSources: next }, metric === 'temperature' ? '温度来源已保存' : '湿度来源已保存');
  }

  function clearMetricSource(scope: string, metric: MetricName) {
    if (!custom) return;
    const metricSources = (custom.metricSources ?? []).filter((item) => !(item.scope === scope && item.metric === metric));
    void mutate({ ...custom, metricSources }, metric === 'temperature' ? '温度来源已删除' : '湿度来源已删除');
  }

  /** 保存某区域的有人传感器（多选，或关系）；空数组表示清空。 */
  function saveOccupancy(scope: string, entityIds: string[]) {
    if (!custom) return;
    const occupancy = { ...(custom.occupancy ?? {}) };
    if (entityIds.length > 0) occupancy[scope] = entityIds;
    else delete occupancy[scope];
    void mutate({ ...custom, occupancy }, '有人传感器已保存');
  }

  if (!connected) return <section className="settings-card"><p className="settings-message">连接 Home Assistant 后，可在这里手动创建房间、添加设备和设置情景模式按钮。</p></section>;
  if (!data || !custom) return <section className="settings-card"><p className="settings-message">{error ?? '正在读取房间配置与已发现的设备…'}</p></section>;

  const pickerRoom = custom.rooms.find((room) => room.id === pickerRoomId) ?? null;
  const assignedCount = (roomId: string) => Object.values(custom.assignments).filter((id) => id === roomId).length;
  const sceneTargets = data.entities.filter(isSceneTarget);
  // 情景目标下拉按标签分组；没有标签的实体归到“未标签”。
  const targetGroups = data.labels
    .map((label) => ({ label, members: sceneTargets.filter((entity) => entity.labels.some((item) => item.id === label.id)) }))
    .filter((group) => group.members.length > 0);
  const unlabeledTargets = sceneTargets.filter((entity) => entity.labels.length === 0);
  const entityNameById = new Map(data.entities.map((entity) => [entity.id, entity.name]));
  // 可作为温湿度来源的实体（在线且带对应数值参数）。
  const metricCandidates: Record<MetricName, CatalogueEntity[]> = {
    temperature: data.entities.filter((entity) => entity.available !== false && entity.metrics?.some((item) => item.metric === 'temperature')),
    humidity: data.entities.filter((entity) => entity.available !== false && entity.metrics?.some((item) => item.metric === 'humidity')),
  };
  // 可作区域“有人”判断的实体（在线 binary_sensor / sensor）。
  const occupancyCandidates = data.entities.filter(isOccupancyCandidate);
  const metricSourceOf = (scope: string, metric: MetricName) => custom.metricSources?.find((item) => item.scope === scope && item.metric === metric);
  const editingScene = editingSceneId ? custom.scenes.find((scene) => scene.id === editingSceneId) ?? null : null;
  const iconPickerChoices: IconChoice[] | null = iconPicker ? (iconPicker.kind === 'room' ? ROOM_ICONS : SCENE_ICONS) : null;
  const iconPickerValue = iconPicker
    ? iconPicker.kind === 'room'
      ? custom.rooms.find((room) => room.id === iconPicker.roomId)?.icon ?? ''
      : sceneIcon
    : '';

  return (
    <>
      <CollapsibleCard icon={DoorOpen} title="房间与设备">
        <div className="custom-add-row">
          <input type="text" maxLength={ROOM_NAME_MAX} placeholder="新房间名称，如：客厅" value={newRoomName} onChange={(event) => { setNewRoomName(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} aria-label="新房间名称" />
          <button type="button" className="small-button small-button--selected" onClick={addRoom} disabled={!newRoomName.trim()}><Plus size={15} />新建房间</button>
        </div>

        {custom.rooms.length === 0 ? (
          <p className="settings-message">还没有房间。先新建一个房间，再往里面添加设备。</p>
        ) : (
          <ul className="room-manage-list">
            {custom.rooms.map((room, index) => {
              const RoomIcon = roomIcon(room);
              return (
                <li key={room.id} className="room-manage-row">
                  <div className="room-manage-row__name">
                    <button type="button" className="room-icon-button" onClick={() => setIconPicker({ kind: 'room', roomId: room.id })} aria-label={`更换“${room.name}”的图标`} title="点按更换图标">
                      <RoomIcon size={17} />
                    </button>
                    <strong>{room.name}</strong><em>{assignedCount(room.id)} 个设备</em>
                  </div>
                  <div className="room-manage-row__actions">
                    <button type="button" className="small-button" onClick={() => setPickerRoomId(room.id)}>添加设备</button>
                    <button type="button" className="icon-button" onClick={() => moveRoom(index, -1)} disabled={index === 0} aria-label="上移房间"><ArrowUp size={16} /></button>
                    <button type="button" className="icon-button" onClick={() => moveRoom(index, 1)} disabled={index === custom.rooms.length - 1} aria-label="下移房间"><ArrowDown size={16} /></button>
                    {confirmRoomId === room.id
                      ? <button type="button" className="small-button small-button--danger" onClick={() => deleteRoom(room.id)}>确认删除</button>
                      : <button type="button" className="icon-button" onClick={() => { setConfirmRoomId(room.id); window.setTimeout(() => setConfirmRoomId((current) => (current === room.id ? null : current)), 3000); }} aria-label={`删除房间 ${room.name}`}><Trash2 size={16} /></button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="settings-message settings-message--error" role="alert">{error}</p>}
        {message && <p className="settings-message settings-message--good" role="status">{message}</p>}
      </CollapsibleCard>

      <CollapsibleCard icon={Thermometer} title="温湿度来源">
        {metricCandidates.temperature.length + metricCandidates.humidity.length === 0
          ? <p className="settings-message">当前没有发现带温度 / 湿度数值的在线实体（空调、温湿度传感器等）。</p>
          : (
            <ul className="metric-source-list">
              {[{ id: 'home', name: '我的家庭（主页）' }, ...custom.rooms.map((room) => ({ id: room.id, name: room.name }))].map((scope) => (
                <li key={scope.id} className="metric-source-scope">
                  <strong>{scope.name}</strong>
                  {METRIC_ROWS.map(({ metric, label }) => (
                    <MetricSourceRow
                      key={metric}
                      metric={metric}
                      label={label}
                      icon={metric === 'temperature' ? <Thermometer size={14} /> : <Droplets size={14} />}
                      source={metricSourceOf(scope.id, metric)}
                      candidates={metricCandidates[metric]}
                      scopeName={scope.name}
                      onPick={(entityId, attribute) => saveMetricSource(scope.id, metric, entityId, attribute)}
                      onClear={() => clearMetricSource(scope.id, metric)}
                    />
                  ))}
                </li>
              ))}
            </ul>
          )}
      </CollapsibleCard>

      <CollapsibleCard icon={PersonStanding} title="区域有人传感器">
        <p className="settings-message">为每个区域选择人在 / 存在 / 移动传感器，仅列出名称含“人”的在线 binary_sensor / sensor。可多选，只要其中一个显示有人，该区域就显示有人。</p>
        {occupancyCandidates.length === 0
          ? <p className="settings-message">当前没有发现名称含“人”的在线 binary_sensor / sensor 实体（可在 HA 中把传感器设备或实体改名为带“人”字）。</p>
          : (
            <ul className="metric-source-list">
              {[{ id: 'home', name: '我的家庭（主页）' }, ...custom.rooms.map((room) => ({ id: room.id, name: room.name }))].map((scope) => (
                <li key={scope.id} className="metric-source-scope">
                  <strong>{scope.name}</strong>
                  <OccupancyRow
                    scopeName={scope.name}
                    entityIds={custom.occupancy?.[scope.id] ?? []}
                    candidates={occupancyCandidates}
                    onSave={(entityIds) => saveOccupancy(scope.id, entityIds)}
                    onClear={() => saveOccupancy(scope.id, [])}
                  />
                </li>
              ))}
            </ul>
          )}
      </CollapsibleCard>

      <CollapsibleCard icon={Sparkles} title="情景模式按钮">
        <div className="scene-edit-list">
          <ScopeGroup label="我的家庭" scenes={custom.scenes.filter((scene) => scene.scope === 'home')} entityNameById={entityNameById} onMove={moveScene} onEdit={setEditingSceneId} onDelete={deleteScene} />
          {custom.rooms.map((room) => (
            <ScopeGroup key={room.id} label={room.name} scenes={custom.scenes.filter((scene) => scene.scope === room.id)} entityNameById={entityNameById} onMove={moveScene} onEdit={setEditingSceneId} onDelete={deleteScene} />
          ))}
          {custom.scenes.length === 0 && <p className="settings-message">还没有情景按钮，在下方添加。</p>}
        </div>

        <div className="scene-add">
          <label className="settings-field">
            <span>按钮名称（可空，用实体名称）</span>
            <input type="text" maxLength={SCENE_NAME_MAX} placeholder="留空则直接显示实体名称" value={sceneName} onChange={(event) => { setSceneName(event.target.value); setError(null); }} />
          </label>
          <label className="settings-field">
            <span>放在哪里</span>
            <select value={sceneScope} onChange={(event) => setSceneScope(event.target.value)}>
              <option value="home">我的家庭（首页）</option>
              {custom.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </select>
          </label>
          <label className="settings-field">
            <span>指向的情景实体</span>
            <select value={sceneTarget} onChange={(event) => { setSceneTarget(event.target.value); setManualTarget(''); }} disabled={manualTarget.trim() !== ''}>
              <option value="">{sceneTargets.length > 0 ? '从已发现的实体中选择（按标签分组）' : '没有已发现的情景实体，可在下方手输实体 ID'}</option>
              {targetGroups.map(({ label, members }) => (
                <optgroup key={label.id} label={label.name}>{members.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}（{entity.id}）</option>)}</optgroup>
              ))}
              {unlabeledTargets.length > 0 && (
                <optgroup label="未标签">{unlabeledTargets.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}（{entity.id}）</option>)}</optgroup>
              )}
            </select>
          </label>
          <label className="settings-field">
            <span>手输实体 ID</span>
            <input type="text" placeholder="如 button.xxx / scene.xxx / automation.xxx" value={manualTarget} onChange={(event) => setManualTarget(event.target.value)} spellCheck={false} />
          </label>
          <div className="settings-field">
            <span>按钮图标</span>
            <button type="button" className="icon-pick-button" onClick={() => setIconPicker({ kind: 'scene-add' })}>
              <span className="room-icon-button"><SceneIconPreview icon={sceneIcon} /></span>
              点按更换图标
            </button>
          </div>
          <button type="button" className="small-button small-button--selected" onClick={addScene}><Plus size={15} />添加按钮</button>
        </div>
      </CollapsibleCard>

      <CollapsibleCard icon={Cctv} title="摄像头（RTSP / ONVIF）">
        <div className="scene-edit-list">
          {[
            { scope: 'home', label: '我的家庭' },
            ...custom.rooms.map((room) => ({ scope: room.id, label: room.name })),
          ].map((group) => {
            const cameras = custom.cameras.filter((camera) => camera.scope === group.scope);
            if (cameras.length === 0) return null;
            return (
              <div key={group.scope} className="scope-group">
                <h4>{group.label}</h4>
                <ul className="camera-manage-list">
                  {cameras.map((camera) => (
                    <li key={camera.id} className={editingCameraId === camera.id ? 'camera-manage-list__row camera-manage-list__row--editing' : 'camera-manage-list__row'}>
                      <span className="camera-manage-list__name"><Cctv size={15} /><strong>{camera.name}</strong><em className={`camera-type-tag camera-type-tag--${cameraType(camera)}`}>{cameraType(camera) === 'onvif' ? 'ONVIF' : 'RTSP'}</em></span>
                      <code>{describeCamera(camera)}</code>
                      <span className="camera-manage-list__actions">
                        {cameraType(camera) === 'onvif' && (
                          <button type="button" role="switch" className="settings-switch settings-switch--small" aria-checked={camera.motionEnabled !== false} aria-label={`${camera.name} 运动检测截图`} title="运动检测截图" onClick={() => toggleCameraMotion(camera.id)}><span /></button>
                        )}
                        <button type="button" className="icon-button" onClick={() => startEditCamera(camera)} aria-label={`编辑摄像头 ${camera.name}`}><Pencil size={16} /></button>
                        <button type="button" className="icon-button" onClick={() => deleteCamera(camera.id)} aria-label={`删除摄像头 ${camera.name}`}><Trash2 size={16} /></button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {custom.cameras.length === 0 && <p className="settings-message">还没有摄像头，在下方添加。</p>}
        </div>

        <div className="scene-add" ref={cameraFormRef}>
          {editingCameraId && (
            <p className="camera-edit-banner">
              <Pencil size={14} />正在编辑摄像头参数，保存后立即生效
              <button type="button" className="text-button" onClick={resetCameraForm}>取消编辑</button>
            </p>
          )}
          <div className="settings-field">
            <span>接入方式</span>
            <div className="label-chips" role="group" aria-label="摄像头接入方式">
              <button type="button" disabled={editingCameraId !== null} className={cameraKind === 'rtsp' ? 'label-chip label-chip--active' : 'label-chip'} aria-pressed={cameraKind === 'rtsp'} onClick={() => { setCameraKind('rtsp'); setCameraError(null); }}>RTSP</button>
              <button type="button" disabled={editingCameraId !== null} className={cameraKind === 'onvif' ? 'label-chip label-chip--active' : 'label-chip'} aria-pressed={cameraKind === 'onvif'} onClick={() => { setCameraKind('onvif'); setCameraError(null); }}>ONVIF（支持云台）</button>
            </div>
          </div>
          <label className="settings-field">
            <span>摄像头名称</span>
            <input type="text" maxLength={12} placeholder="如：门口 / 客厅 / 阳台" value={cameraName} onChange={(event) => { setCameraName(event.target.value); setCameraError(null); }} />
          </label>
          <label className="settings-field">
            <span>放在哪里</span>
            <select value={cameraScope} onChange={(event) => setCameraScope(event.target.value)}>
              <option value="home">我的家庭（首页）</option>
              {custom.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
            </select>
          </label>
          {cameraKind === 'rtsp' ? (
            <label className="settings-field settings-field--wide">
              <span>RTSP 地址（含账号密码也只存在服务器）</span>
              <input type="text" spellCheck={false} placeholder="rtsp://用户名:密码@192.168.1.20:554/stream1" value={cameraUrl} onChange={(event) => { setCameraUrl(event.target.value); setCameraError(null); }} />
            </label>
          ) : (
            <>
              <label className="settings-field">
                <span>主机地址（IP 或域名）</span>
                <input type="text" spellCheck={false} placeholder="192.168.1.20" value={cameraHost} onChange={(event) => { setCameraHost(event.target.value); setCameraError(null); }} />
              </label>
              <label className="settings-field">
                <span>ONVIF 端口</span>
                <input type="number" min={1} max={65535} inputMode="numeric" placeholder="8000" value={cameraPort} onChange={(event) => { setCameraPort(event.target.value); setCameraError(null); }} />
              </label>
              <label className="settings-field">
                <span>用户名</span>
                <input type="text" autoComplete="off" placeholder="ONVIF 登录用户名" value={cameraUser} onChange={(event) => { setCameraUser(event.target.value); setCameraError(null); }} />
              </label>
              <label className="settings-field">
                <span>密码（只存在服务器）</span>
                <input type="password" autoComplete="new-password" placeholder="ONVIF 登录密码" value={cameraPassword} onChange={(event) => { setCameraPassword(event.target.value); setCameraError(null); }} />
              </label>
              <label className="settings-field settings-field--wide">
                <span>画面地址（可选；探测的地址不可用或只能单路播放时手动指定）</span>
                <input type="text" spellCheck={false} placeholder="rtsp://用户名:密码@192.168.1.20:554/stream1，留空自动探测" value={cameraUrl} onChange={(event) => { setCameraUrl(event.target.value); setCameraError(null); }} />
              </label>
            </>
          )}
          <div className="form-actions">
            <button type="button" className="small-button small-button--selected" onClick={submitCamera}>{editingCameraId ? <Pencil size={15} /> : <Plus size={15} />}{editingCameraId ? '保存修改' : '添加摄像头'}</button>
            {editingCameraId && <button type="button" className="small-button" onClick={resetCameraForm}>取消</button>}
          </div>
        </div>
        {cameraError && <p className="settings-message settings-message--error" role="alert">{cameraError}</p>}
      </CollapsibleCard>

      {pickerRoom && (
        <DevicePicker
          room={pickerRoom}
          data={data}
          custom={custom}
          searchId={searchId}
          onToggle={(entityId, checked) => toggleAssignment(entityId, pickerRoom.id, checked)}
          onEdit={setEditingEntity}
          onClose={() => setPickerRoomId(null)}
        />
      )}

      {iconPicker && iconPickerChoices && (
        <IconPicker
          title={iconPicker.kind === 'room' ? '房间图标' : '情景按钮图标'}
          choices={iconPickerChoices}
          includeAuto={iconPicker.kind === 'room'}
          value={iconPickerValue}
          pages={[{ label: '更多图标', choices: PHU_ICONS }]}
          onClose={() => setIconPicker(null)}
          onPick={(icon) => {
            if (iconPicker.kind === 'room') setRoomIcon(iconPicker.roomId, icon);
            else { setSceneIcon(icon); setIconPicker(null); }
          }}
        />
      )}

      {editingEntity && (
        <DeviceEditDialog
          entity={editingEntity}
          override={custom.entities?.[editingEntity.id]}
          onClose={() => setEditingEntity(null)}
          onSave={(draft) => saveEntityOverride(editingEntity.id, draft)}
        />
      )}

      {editingScene && (
        <SceneEditDialog
          scene={editingScene}
          data={data}
          targetGroups={targetGroups}
          unlabeledTargets={unlabeledTargets}
          entityName={entityNameById.get(editingScene.entity) ?? editingScene.entity}
          onClose={() => setEditingSceneId(null)}
          onSave={(draft) => saveSceneEdit(editingScene.id, draft)}
        />
      )}
    </>
  );
}

/** 仅供添加表单包装 findSceneIcon 成大写 JSX 组件名。 */
function SceneIconPreview({ icon }: { icon: string }) {
  const Icon = findSceneIcon(icon);
  return <Icon size={16} aria-hidden="true" />;
}

function ScopeGroup({ label, scenes, entityNameById, onMove, onEdit, onDelete }: {
  label: string;
  scenes: CustomConfig['scenes'];
  entityNameById: Map<string, string>;
  onMove: (id: string, delta: -1 | 1) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (scenes.length === 0) return null;
  const entityList = [...entityNameById].map(([id, name]) => ({ id, name }));
  return (
    <div className="scope-group">
      <h4>{label}<em>{scenes.length}</em></h4>
      <ul>
        {scenes.map((scene, index) => {
          const Icon = findSceneIcon(scene.icon);
          const displayName = sceneDisplayName(scene, entityList);
          return (
            <li key={scene.id} className="scene-manage-row">
              <Icon size={15} aria-hidden="true" />
              <strong>{displayName}</strong>
              <code>{scene.entity}</code>
              <button type="button" className="icon-button" onClick={() => onMove(scene.id, -1)} disabled={index === 0} aria-label={`${displayName} 前移`}><ArrowUp size={14} /></button>
              <button type="button" className="icon-button" onClick={() => onMove(scene.id, 1)} disabled={index === scenes.length - 1} aria-label={`${displayName} 后移`}><ArrowDown size={14} /></button>
              <button type="button" className="icon-button" onClick={() => onEdit(scene.id)} aria-label={`编辑情景 ${displayName}`}><Pencil size={14} /></button>
              <button type="button" className="icon-button" onClick={() => onDelete(scene.id)} aria-label={`删除情景 ${displayName}`}><X size={15} /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 图标选择弹窗：网格点选，支持多页（如“默认 / 更多图标”标签页）；includeAuto 时首页第一项为“自动”（空键）。 */
function IconPicker({ title, choices, includeAuto, value, onPick, onClose, pages }: {
  title: string;
  choices: IconChoice[];
  includeAuto?: boolean;
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
  /** 附加图标页，以标签页切换；第一页始终是 choices。 */
  pages?: { label: string; choices: IconChoice[] }[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const autoChoice: IconChoice = includeAuto ? { key: '', label: '自动', Icon: House } : { key: '', label: '默认', Icon: Sparkles };
  const firstPage = [autoChoice, ...choices.filter((choice) => choice.key !== '')];
  const shown = page === 0 ? firstPage : pages?.[page - 1]?.choices ?? firstPage;
  return (
    <dialog ref={dialogRef} className="device-dialog icon-picker-dialog" onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>自定义</small><h2>{title}</h2></div>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="关闭"><X size={20} /></button>
      </div>
      {pages && pages.length > 0 && (
        <div className="label-chips" role="tablist" aria-label="图标来源">
          <button type="button" role="tab" aria-selected={page === 0} className={page === 0 ? 'label-chip label-chip--active' : 'label-chip'} onClick={() => setPage(0)}>默认</button>
          {pages.map((item, index) => (
            <button key={item.label} type="button" role="tab" aria-selected={page === index + 1} className={page === index + 1 ? 'label-chip label-chip--active' : 'label-chip'} onClick={() => setPage(index + 1)}>{item.label}</button>
          ))}
        </div>
      )}
      <div className="icon-picker-grid" role="radiogroup" aria-label={title}>
        {shown.map(({ key, label: choiceLabel, Icon }) => (
          <button key={key || '__auto'} type="button" role="radio" aria-checked={value === key} className={value === key ? 'icon-pick icon-pick--active' : 'icon-pick'} title={choiceLabel} onClick={() => { onPick(key); dialogRef.current?.close(); }}>
            <Icon size={20} aria-hidden="true" /><span>{choiceLabel}</span>
          </button>
        ))}
      </div>
    </dialog>
  );
}

interface SceneEditDialogProps {
  scene: CustomConfig['scenes'][number];
  data: DiscoveredEntities;
  targetGroups: { label: LabelInfo; members: CatalogueEntity[] }[];
  unlabeledTargets: CatalogueEntity[];
  entityName: string;
  onClose: () => void;
  onSave: (draft: { name: string; target: string; icon: string }) => void;
}

/** 编辑已有情景：改名（可空）、改目标实体、改图标。图标弹窗在本组件内部自持。 */
function SceneEditDialog({ scene, data, targetGroups, unlabeledTargets, entityName, onClose, onSave }: SceneEditDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(scene.name);
  const [target, setTarget] = useState(scene.entity);
  const [manual, setManual] = useState('');
  const [icon, setIcon] = useState(scene.icon);
  const [iconOpen, setIconOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const effectiveTarget = manual.trim() || target;
  const Icon = findSceneIcon(icon);
  // 已保存的实体若不在当前发现列表（如手输或暂时不可用），在下拉中补一项，保证回显。
  const known = new Set(data.entities.map((entity) => entity.id));

  return (
    <dialog ref={dialogRef} className="device-dialog customize-dialog scene-edit-dialog" onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>情景按钮</small><h2>编辑情景</h2></div>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="取消"><X size={20} /></button>
      </div>
      <div className="customize-dialog__body">
        <label className="settings-field">
          <span>按钮名称（可空，用实体名称）</span>
          <input type="text" maxLength={12} placeholder={entityName} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="settings-field">
          <span>指向的情景实体</span>
          <select value={manual.trim() ? '' : target} onChange={(event) => { setTarget(event.target.value); setManual(''); }} disabled={manual.trim() !== ''}>
            {!known.has(target) && <option value={target}>{target}（当前未发现）</option>}
            {targetGroups.map(({ label, members }) => (
              <optgroup key={label.id} label={label.name}>{members.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}（{entity.id}）</option>)}</optgroup>
            ))}
            {unlabeledTargets.length > 0 && (
              <optgroup label="未标签">{unlabeledTargets.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}（{entity.id}）</option>)}</optgroup>
            )}
          </select>
        </label>
        <label className="settings-field">
          <span>或手输实体 ID</span>
          <input type="text" placeholder="如 button.xxx / scene.xxx / automation.xxx" value={manual} onChange={(event) => setManual(event.target.value)} spellCheck={false} />
        </label>
        <div className="settings-field">
          <span>按钮图标</span>
          <button type="button" className="icon-pick-button" onClick={() => setIconOpen(true)}>
            <span className="room-icon-button"><Icon size={16} aria-hidden="true" /></span>
            点按更换图标
          </button>
        </div>
        <div className="settings-actions">
          <button type="button" className="small-button small-button--selected" onClick={() => onSave({ name, target: effectiveTarget, icon })}>保存</button>
          <button type="button" className="small-button" onClick={() => dialogRef.current?.close()}>取消</button>
        </div>
      </div>
      {iconOpen && (
        <IconPicker
          title="情景按钮图标"
          choices={SCENE_ICONS}
          value={icon}
          pages={[{ label: '更多图标', choices: PHU_ICONS }]}
          onPick={(key) => { setIcon(key); setIconOpen(false); }}
          onClose={() => setIconOpen(false)}
        />
      )}
    </dialog>
  );
}

/** 单个设备的显示自定义：改名（可空 = 用原名称）、换图标（可空 = 自动匹配）。只改控制台显示，不动 HA。 */
function DeviceEditDialog({ entity, override, onClose, onSave }: {
  entity: CatalogueEntity;
  override: { name: string; icon: string } | undefined;
  onClose: () => void;
  onSave: (draft: { name: string; icon: string }) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(override?.name ?? '');
  const [icon, setIcon] = useState(override?.icon ?? '');
  const [iconOpen, setIconOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const Icon = findAnyIcon(icon);
  return (
    <dialog ref={dialogRef} className="device-dialog customize-dialog scene-edit-dialog" onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>{entityKindLabel(entity)} · {entity.id}</small><h2>自定义设备</h2></div>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="取消"><X size={20} /></button>
      </div>
      <div className="customize-dialog__body">
        <label className="settings-field">
          <span>显示名称（可空，用原名称）</span>
          <input type="text" maxLength={24} placeholder={entity.name} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="settings-field">
          <span>设备图标</span>
          <button type="button" className="icon-pick-button" onClick={() => setIconOpen(true)}>
            <span className="room-icon-button">{Icon ? <Icon size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}</span>
            {Icon ? '点按更换图标' : '自动匹配 · 点按更换'}
          </button>
        </div>
        <div className="settings-actions">
          <button type="button" className="small-button small-button--selected" onClick={() => onSave({ name: name.trim(), icon })}>保存</button>
          <button type="button" className="small-button" onClick={() => dialogRef.current?.close()}>取消</button>
        </div>
      </div>
      {iconOpen && (
        <IconPicker
          title="设备图标"
          choices={DEVICE_ICONS}
          includeAuto
          value={icon}
          pages={[{ label: '更多图标', choices: PHU_ICONS }]}
          onPick={(key) => { setIcon(key); setIconOpen(false); }}
          onClose={() => setIconOpen(false)}
        />
      )}
    </dialog>
  );
}

interface DevicePickerProps {
  room: { id: string; name: string };
  data: DiscoveredEntities;
  custom: CustomConfig;
  searchId: string;
  onToggle: (entityId: string, checked: boolean) => void;
  onEdit: (entity: CatalogueEntity) => void;
  onClose: () => void;
}

/** 房间设备选择器：搜索 + 标签筛选 chips，实体按标签名称分组（可重复出现在多个标签组），无标签的单独一组。 */
function DevicePicker({ room, data, custom, searchId, onToggle, onEdit, onClose }: DevicePickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [activeLabel, setActiveLabel] = useState<string>('all');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const close = () => dialogRef.current?.close();
  const handleKey = (event: KeyboardEvent<HTMLDialogElement>) => { if (event.key === 'Escape') event.preventDefault(); };

  const devices = useMemo(() => data.entities.filter(isRoomDevice), [data.entities]);
  const keyword = query.trim().toLowerCase();
  const matches = devices.filter((entity) => !keyword || entity.name.toLowerCase().includes(keyword) || entity.id.toLowerCase().includes(keyword) || entityKindLabel(entity).includes(keyword));
  // 已加入当前房间的实体排在最顶，方便调整；其余保持原顺序（sort 稳定）。
  const ordered = [...matches].sort((a, b) => Number(custom.assignments[b.id] === room.id) - Number(custom.assignments[a.id] === room.id));

  const groups: { label: LabelInfo | null; entities: CatalogueEntity[] }[] = [];
  if (activeLabel === 'all') {
    // 已加入当前房间的实体单独一组置顶，方便更改；下方标签组不再重复出现。
    const added = ordered.filter((entity) => custom.assignments[entity.id] === room.id);
    if (added.length > 0) groups.push({ label: { id: '__added__', name: '已添加' }, entities: added });
    for (const label of data.labels) {
      const members = ordered.filter((entity) => custom.assignments[entity.id] !== room.id && entity.labels.some((item) => item.id === label.id));
      if (members.length > 0) groups.push({ label, entities: members });
    }
    const unlabeled = ordered.filter((entity) => custom.assignments[entity.id] !== room.id && entity.labels.length === 0);
    if (unlabeled.length > 0) groups.push({ label: null, entities: unlabeled });
  } else if (activeLabel === NO_LABEL) {
    groups.push({ label: null, entities: ordered.filter((entity) => entity.labels.length === 0) });
  } else {
    const label = data.labels.find((item) => item.id === activeLabel) ?? null;
    groups.push({ label, entities: ordered.filter((entity) => entity.labels.some((item) => item.id === activeLabel)) });
  }

  return (
    <dialog ref={dialogRef} className="device-dialog customize-dialog" aria-labelledby="device-picker-title" onKeyDown={handleKey} onClose={onClose}>
      <div className="device-dialog__heading">
        <div><small>{room.name}</small><h2 id="device-picker-title">添加设备</h2></div>
        <button type="button" className="icon-button" onClick={close} aria-label="完成"><X size={20} /></button>
      </div>
      <div className="customize-dialog__body">
        <p className="settings-message">勾选即加入“{room.name}”；设备已在其他房间时会直接移动过来，取消勾选则移出房间。共 {devices.length} 个可选设备。</p>
        <div className="entity-filter__tools">
          <label className="entity-filter__search" htmlFor={`${searchId}-picker`}>
            <Search size={16} />
            <input id={`${searchId}-picker`} type="search" placeholder="搜索名称、实体 ID 或类型" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        <div className="label-chips" role="group" aria-label="按标签筛选">
          <button type="button" className={activeLabel === 'all' ? 'label-chip label-chip--active' : 'label-chip'} onClick={() => setActiveLabel('all')}>全部</button>
          {data.labels.map((label) => (
            <button key={label.id} type="button" className={activeLabel === label.id ? 'label-chip label-chip--active' : 'label-chip'} onClick={() => setActiveLabel(label.id)}>{label.name}</button>
          ))}
          <button type="button" className={activeLabel === NO_LABEL ? 'label-chip label-chip--active' : 'label-chip'} onClick={() => setActiveLabel(NO_LABEL)}>无标签</button>
        </div>
        {groups.length === 0 ? <p className="settings-message">没有匹配的设备</p> : groups.map(({ label, entities }, index) => (
          <section key={label?.id ?? NO_LABEL} className="entity-filter__group">
            <h4>{label?.name ?? '无标签'}<em>{entities.length}</em></h4>
            <ul>
              {entities.map((entity) => {
                const currentRoom = custom.assignments[entity.id];
                const inThisRoom = currentRoom === room.id;
                const elsewhere = currentRoom && currentRoom !== room.id ? custom.rooms.find((item) => item.id === currentRoom)?.name : undefined;
                const displayName = custom.entities?.[entity.id]?.name || entity.name;
                return (
                  <li key={`${entity.id}-${index}`}>
                    <label>
                      <input type="checkbox" checked={inThisRoom} onChange={(event) => onToggle(entity.id, event.target.checked)} />
                      <span className="entity-filter__name">{displayName}</span>
                      <button type="button" className="icon-button entity-filter__edit" title="自定义名称与图标" aria-label={`自定义“${displayName}”的名称与图标`} onClick={(event) => { event.preventDefault(); onEdit(entity); }}><Pencil size={14} /></button>
                      <span className="entity-filter__kind">{entityKindLabel(entity)}</span>
                      {elsewhere && <span className="entity-filter__tag">在「{elsewhere}」</span>}
                      <code>{entity.id}</code>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  );
}
