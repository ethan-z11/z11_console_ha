import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalogue, CustomConfig, EntityState } from './consoleClient';
import { applyCommand } from './deviceCommands';
import type { DeviceCommand } from './deviceCommands';
import { liveHome, serviceCall } from './haAdapter';
import { mockHome } from './mockHome';
import { isRunning, runningDeviceIds } from './selectors';
import type { Device, DeviceActions, HomeState } from './types';

/** 滑杆和连续点击合并后再发送，避免拖动时每一帧都调用服务。 */
const debounceMs = 300;
const debouncedCommands = new Set<DeviceCommand['type']>(['light', 'mediaVolume', 'adjust', 'fanSpeed', 'coverPosition']);
/** 操作后等 HA 确认的最长时间：确认前 HA 推来的旧状态不覆盖页面，超时后以 HA 的实际状态为准。 */
const confirmTimeoutMs = 10_000;

export type Expectation = { expected: Record<string, unknown>; until: number };

/** HA 回写的数值可能有取整差异（亮度百分比、色温换算），在容差内算一致。 */
function sameValue(key: string, actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= (key === 'colorTemp' ? 50 : 1);
  if (typeof actual === 'string' && typeof expected === 'string') return actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

/** 本次操作改变了哪些字段（只比较简单值），作为等待 HA 确认的目标。 */
function changedFields(before: Device, after: Device): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (value !== null && typeof value === 'object') continue;
    if ((before as unknown as Record<string, unknown>)[key] !== value) changed[key] = value;
  }
  return changed;
}

/**
 * 在 HA 生成的页面数据上叠加尚未确认的操作目标值：确认一致、超时或设备不可用时删除该期望并以 HA 为准。
 * 会直接修改 expectations（删除已结束的期望）。
 */
export function overlayExpectations(next: HomeState, expectations: Map<string, Expectation>, now: number): HomeState {
  if (expectations.size === 0) return next;
  return {
    ...next,
    devices: next.devices.map((device) => {
      const expectation = expectations.get(device.id);
      if (!expectation) return device;
      const fields = device as unknown as Record<string, unknown>;
      const confirmed = Object.entries(expectation.expected).every(([key, value]) => sameValue(key, fields[key], value));
      if (confirmed || now >= expectation.until || !device.available) {
        expectations.delete(device.id);
        return device;
      }
      return { ...device, ...expectation.expected } as Device;
    }),
  };
}

/** “正在运行”里关掉的设备保留这么久再移出，期间可原地重新打开（防误触）。 */
const stoppedLingerMs = 3000;

interface LiveSource {
  entityStates: Map<string, EntityState>;
  catalogue: Catalogue | null;
  /** 手动房间、设备归属与情景按钮配置。 */
  custom: CustomConfig | null;
  callService: (entity: string, service: string, data: Record<string, unknown>) => Promise<void>;
}

/**
 * 家庭状态与设备操作。
 * 演示模式（live 为 null）：操作只改内存中的演示数据。
 * HA 模式：房间与设备来自后端自动发现的目录，状态以 HA 为准；操作先乐观更新页面，再经后端调用 HA，失败时回退并提示。
 */
export function useHome(live: LiveSource | null) {
  const [home, setHome] = useState<HomeState>(() => structuredClone(mockHome));
  // “正在运行”的设备；刚关闭的保留 3 秒（可原地重新打开），之后自动移出。
  const [runningIds, setRunningIds] = useState<string[]>(() => runningDeviceIds(mockHome));
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const homeRef = useRef(home);
  const liveRef = useRef(live);
  const pendingRef = useRef(new Map<string, { timer: number; data: Record<string, unknown> }>());
  // 每台设备最近一次操作的目标值；HA 确认（或超时、设备不可用）后删除。
  const expectRef = useRef(new Map<string, Expectation>());

  /** 用 HA 状态生成页面数据，但尚未确认的操作仍显示目标值，避免开关先跳回旧状态再跳到新状态的闪烁。 */
  const mergeLive = useCallback((catalogueValue: Catalogue | null, states: Map<string, EntityState>, previous: HomeState, customValue: CustomConfig | null): HomeState =>
    overlayExpectations(liveHome(catalogueValue, states, previous, customValue), expectRef.current, Date.now()), []);
  const isLive = live !== null;
  const entityStates = live?.entityStates;
  const catalogue = live?.catalogue;
  const custom = live?.custom ?? null;

  useEffect(() => { homeRef.current = home; }, [home]);
  useEffect(() => { liveRef.current = live; });

  useEffect(() => {
    const current = runningDeviceIds(home);
    setRunningIds((previous) => {
      const added = current.filter((id) => !previous.includes(id));
      return added.length > 0 ? [...previous, ...added] : previous;
    });
  }, [home]);

  // 记录每个已停止设备的停止时间，到期后移出；期间重新打开则取消。按绝对时间计时，状态频繁推送也不会一直推迟。
  const stoppedAtRef = useRef(new Map<string, number>());
  useEffect(() => {
    const stoppedAt = stoppedAtRef.current;
    const now = Date.now();
    const running = new Set(runningDeviceIds(home));
    for (const id of [...stoppedAt.keys()]) if (!runningIds.includes(id) || running.has(id)) stoppedAt.delete(id);
    for (const id of runningIds) if (!running.has(id) && !stoppedAt.has(id)) stoppedAt.set(id, now);
    if (stoppedAt.size === 0) return;
    const due = Math.min(...stoppedAt.values()) + stoppedLingerMs;
    const timer = window.setTimeout(() => {
      const expired = new Set([...stoppedAt].filter(([, time]) => Date.now() - time >= stoppedLingerMs).map(([id]) => id));
      setRunningIds((previous) => previous.filter((id) => {
        if (!expired.has(id)) return true;
        const device = homeRef.current.devices.find((item) => item.id === id);
        return Boolean(device && isRunning(device));
      }));
    }, Math.max(0, due - now));
    return () => window.clearTimeout(timer);
  }, [home, runningIds]);

  // 切换数据来源：演示数据复位；进入 HA 模式时不沿用演示数值，避免把假状态当成 HA 状态显示。
  useEffect(() => {
    const pending = pendingRef.current;
    expectRef.current.clear();
    if (!isLive) {
      setHome(structuredClone(mockHome));
      setRunningIds(runningDeviceIds(mockHome));
      return;
    }
    setHome(liveHome(null, new Map(), null, live.custom ?? null));
    setRunningIds([]);
    return () => {
      for (const { timer } of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, [isLive]);

  useEffect(() => {
    if (!isLive || !entityStates) return;
    setHome((previous) => mergeLive(catalogue ?? null, entityStates, previous, custom));
  }, [isLive, entityStates, catalogue, custom, mergeLive]);

  function callHa(device: Device, command: DeviceCommand) {
    const call = serviceCall(device, command);
    if (!call) return;
    const send = (data: Record<string, unknown>) => {
      const source = liveRef.current;
      if (!source) return;
      source.callService(device.id, call.service, data).catch((error: Error) => {
        setNotice(`${device.name}操作失败：${error.message}`);
        expectRef.current.delete(device.id);
        const latest = liveRef.current;
        if (latest) setHome((previous) => mergeLive(latest.catalogue, latest.entityStates, previous, latest.custom ?? null));
      });
    };

    if (!debouncedCommands.has(command.type)) { send(call.data); return; }
    const key = `${device.id}:${call.service}`;
    const pending = pendingRef.current.get(key);
    if (pending) window.clearTimeout(pending.timer);
    const data = { ...pending?.data, ...call.data };
    pendingRef.current.set(key, { data, timer: window.setTimeout(() => { pendingRef.current.delete(key); send(data); }, debounceMs) });
  }

  function dispatch(id: string, command: DeviceCommand) {
    const current = homeRef.current;
    const before = current.devices.find((device) => device.id === id);
    if (!before) return;
    const after = applyCommand(before, command);
    if (after === before) {
      // 无状态变化但仍需下发的指令（如扫地机“寻找”只发声）：HA 模式照常调用，演示模式无动作。
      if (isLive && command.type === 'vacuumLocate') callHa(before, command);
      return;
    }
    homeRef.current = { ...current, devices: current.devices.map((device) => device.id === id ? after : device) };
    if (isLive) {
      // 记录目标值；超时后按 HA 实际状态重新生成（没确认的操作不会一直“假装成功”）。
      const previous = expectRef.current.get(id);
      expectRef.current.set(id, { expected: { ...previous?.expected, ...changedFields(before, after) }, until: Date.now() + confirmTimeoutMs });
      window.setTimeout(() => {
        const latest = liveRef.current;
        if (latest) setHome((state) => mergeLive(latest.catalogue, latest.entityStates, state, latest.custom ?? null));
      }, confirmTimeoutMs + 50);
    }
    setHome((previous) => ({ ...previous, devices: previous.devices.map((device) => device.id === id ? applyCommand(device, command) : device) }));
    if (isLive) callHa(after, command);
  }

  const actions: DeviceActions = {
    toggle: (id) => dispatch(id, { type: 'toggle' }),
    turnOff: (id) => dispatch(id, { type: 'turnOff' }),
    adjust: (id, delta) => dispatch(id, { type: 'adjust', delta }),
    changeLight: (id, patch) => dispatch(id, { type: 'light', patch }),
    changeClimateMode: (id, mode) => dispatch(id, { type: 'hvacMode', mode }),
    changeFanMode: (id, fanMode) => dispatch(id, { type: 'fanMode', fanMode }),
    setSwingMode: (id, swingMode) => dispatch(id, { type: 'swingMode', swingMode }),
    mediaPower: (id) => dispatch(id, { type: 'mediaPower' }),
    mediaPlayPause: (id) => dispatch(id, { type: 'mediaPlayPause' }),
    mediaVolume: (id, volume) => dispatch(id, { type: 'mediaVolume', volume }),
    changeFanSpeed: (id, percentage) => dispatch(id, { type: 'fanSpeed', percentage }),
    changeFanPreset: (id, preset) => dispatch(id, { type: 'fanPreset', preset }),
    setFanOscillate: (id, oscillating) => dispatch(id, { type: 'fanOscillate', oscillating }),
    coverOpen: (id) => dispatch(id, { type: 'coverOpen' }),
    coverClose: (id) => dispatch(id, { type: 'coverClose' }),
    coverStop: (id) => dispatch(id, { type: 'coverStop' }),
    coverPosition: (id, position) => dispatch(id, { type: 'coverPosition', position }),
    vacuumStart: (id) => dispatch(id, { type: 'vacuumStart' }),
    vacuumPause: (id) => dispatch(id, { type: 'vacuumPause' }),
    vacuumReturn: (id) => dispatch(id, { type: 'vacuumReturn' }),
    vacuumLocate: (id) => dispatch(id, { type: 'vacuumLocate' }),
    vacuumFanSpeed: (id, fanSpeed) => dispatch(id, { type: 'vacuumFanSpeed', fanSpeed }),
  };

  /** 进入全屋时调用：移出已关闭的设备，只保留当前正在运行的。 */
  function refreshRunning() {
    setRunningIds(runningDeviceIds(home));
  }

  /** 仅演示模式：恢复初始演示数据。 */
  function reset() {
    if (isLive) return;
    setHome(structuredClone(mockHome));
    setRunningIds(runningDeviceIds(mockHome));
  }

  return { home, runningIds, actions, refreshRunning, reset, notice, clearNotice };
}

const ignore = () => {};

/** 关闭“允许控制设备”时替换真实操作：按钮仍可点，但不改变任何状态，也不发送请求（后端同样会拒绝）。 */
export const readOnlyActions: DeviceActions = {
  toggle: ignore,
  turnOff: ignore,
  adjust: ignore,
  changeLight: ignore,
  changeClimateMode: ignore,
  changeFanMode: ignore,
  setSwingMode: ignore,
  mediaPower: ignore,
  mediaPlayPause: ignore,
  mediaVolume: ignore,
  changeFanSpeed: ignore,
  changeFanPreset: ignore,
  setFanOscillate: ignore,
  coverOpen: ignore,
  coverClose: ignore,
  coverStop: ignore,
  coverPosition: ignore,
  vacuumStart: ignore,
  vacuumPause: ignore,
  vacuumReturn: ignore,
  vacuumLocate: ignore,
  vacuumFanSpeed: ignore,
};
