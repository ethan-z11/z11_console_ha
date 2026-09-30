import type { ServerLayout } from './consoleClient';
import type { Device, LayoutState, Room, TileSize } from './types';
import { defaultFavoriteIds } from './mockHome';

export const tileSizes: TileSize[] = ['1x1', '2x1'];

/**
 * 所有新加入区域的实体默认使用紧凑 1×1 卡片（用户手动展开过的尺寸保存在布局里，不受影响）；
 * 播放器控件较多，固定为 2×1（allowedSizesForDevice 也只给 2×1）。
 */
const defaultTileSize: Record<Device['kind'], TileSize> = {
  light: '1x1',
  climate: '1x1',
  heating: '1x1',
  sensor: '1x1',
  safety: '1x1',
  media: '2x1',
  fan: '1x1',
  cover: '1x1',
  vacuum: '2x1',
  switch: '1x1',
};

/** 播放器控件较多，固定为 2×1；其他设备可在 1×1 与 2×1 间切换。 */
export function allowedSizesForDevice(device: Device): TileSize[] {
  return device.kind === 'media' ? ['2x1'] : tileSizes;
}

/** 已保存的尺寸不再被允许时（例如旧版 localStorage）回退到默认尺寸。 */
export function tileSizeForDevice(device: Device, saved?: TileSize): TileSize {
  if (saved && allowedSizesForDevice(device).includes(saved)) return saved;
  return defaultTileSize[device.kind];
}

/** 本地只是缓存：页面打开时先用上次的布局避免闪动，连上后端后以后端的共用布局为准。 */
const storageKey = 'hass-home-console-layout-v1';

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');

export function readLayout(): LayoutState {
  const empty: LayoutState = { sizes: {}, order: {} };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const data = parsed as Partial<LayoutState>;
    const sizes = Object.fromEntries(
      Object.entries(data.sizes ?? {}).filter((entry): entry is [string, TileSize] => tileSizes.includes(entry[1])),
    );
    const order = Object.fromEntries(
      Object.entries(data.order ?? {}).filter((entry): entry is [string, string[]] => isIdList(entry[1])),
    );
    return { sizes, order, ...(isIdList(data.favorites) ? { favorites: data.favorites } : {}), ...(isIdList(data.rooms) ? { rooms: data.rooms } : {}) };
  } catch {
    return empty;
  }
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Browser storage may be disabled; the in-memory layout still works.
  }
}

export function orderedDevices(devices: Device[], ids: string[] | undefined): Device[] {
  if (!ids) return devices;
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...devices].sort((a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

/** 按保存的房间顺序排列；未保存过的房间保持原有相对顺序，排在已排序房间之后。 */
export function orderedRooms(rooms: Room[], ids: string[] | undefined): Room[] {
  if (!ids?.length) return rooms;
  const position = new Map(ids.map((id, index) => [id, index]));
  return rooms
    .map((room, index) => ({ room, rank: position.get(room.id) ?? ids.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ room }) => room);
}

/**
 * 常用区卡片尺寸与房间内尺寸分开保存：存在 sizes 里，键加 favorites/ 前缀（后端 sizes 只校验键长与取值，无需改结构）。
 * 未设置过时使用设备默认尺寸。
 */
export function favoriteSizeKey(id: string): string {
  return `favorites/${id}`;
}

export function favoriteIds(layout: LayoutState): string[] {
  return layout.favorites ?? defaultFavoriteIds;
}

/** 加星追加到常用末尾，取消则移出。 */
export function toggleFavorite(layout: LayoutState, id: string): LayoutState {
  const current = favoriteIds(layout);
  return { ...layout, favorites: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] };
}

export function fromServerLayout(layout: ServerLayout): LayoutState {
  return { sizes: layout.sizes, order: layout.order, ...(layout.favorites ? { favorites: layout.favorites } : {}), ...(layout.rooms?.length ? { rooms: layout.rooms } : {}) };
}

export function toServerLayout(layout: LayoutState): ServerLayout {
  return { sizes: layout.sizes, order: layout.order, favorites: layout.favorites ?? null, rooms: layout.rooms ?? [] };
}

const sortedEntries = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

/** 与键顺序无关的比较键，用来判断本地布局是否已与后端一致。 */
export function layoutKey(layout: LayoutState): string {
  return JSON.stringify([sortedEntries(layout.sizes), sortedEntries(layout.order), layout.favorites ?? null, layout.rooms ?? []]);
}
