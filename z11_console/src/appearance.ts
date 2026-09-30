import {
  AirVent, Baby, Bath, BedDouble, BedSingle, BookOpen, PlugZap, Power,
  CookingPot, Flame, House, Lamp, ShowerHead, Sofa, UtensilsCrossed, Wind,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClimateDevice, Device, LightDevice } from './types';
import { brandIcons, VacuumDeviceIcon } from './brandIcons';
import { findAnyIcon, findRoomIcon } from './icons';

const roomIcons: Record<string, LucideIcon> = {
  living: Sofa,
  dining: UtensilsCrossed,
  master: BedDouble,
  child: Baby,
  second: BedSingle,
  mainbath: Bath,
  bath: ShowerHead,
  kitchen: CookingPot,
  study: BookOpen,
};

/** HA 区域没有固定 id，按区域名称里的关键词选图标。 */
const roomKeywords: [string, LucideIcon][] = [
  ['客厅', Sofa],
  ['餐厅', UtensilsCrossed],
  ['主卧', BedDouble],
  ['儿童', Baby],
  ['次卧', BedSingle],
  ['卧', BedSingle],
  ['主卫', Bath],
  ['卫', ShowerHead],
  ['浴', ShowerHead],
  ['厨', CookingPot],
  ['书房', BookOpen],
];

export function roomIcon(room: { id: string; name: string; icon?: string }): LucideIcon {
  // 手动房间的自定义图标优先；空键或未知键再按演示房间 id / 名称关键词回退。
  return findRoomIcon(room.icon) ?? roomIcons[room.id] ?? roomKeywords.find(([keyword]) => room.name.includes(keyword))?.[1] ?? House;
}

export type RoomSceneKind = 'living' | 'dining' | 'bedroom' | 'kids' | 'bath' | 'kitchen' | 'study' | 'home';

const roomScenes: Record<string, RoomSceneKind> = {
  living: 'living', dining: 'dining', master: 'bedroom', second: 'bedroom', child: 'kids',
  mainbath: 'bath', bath: 'bath', kitchen: 'kitchen', study: 'study',
};

/** 房间页页头的线描场景：演示数据按房间 id，HA 区域按名称关键词（儿童优先于卧室）。 */
const sceneKeywords: [string, RoomSceneKind][] = [
  ['客厅', 'living'], ['起居', 'living'],
  ['餐', 'dining'],
  ['儿童', 'kids'], ['孩子', 'kids'], ['宝宝', 'kids'],
  ['卧', 'bedroom'],
  ['卫', 'bath'], ['浴', 'bath'], ['洗手间', 'bath'],
  ['厨', 'kitchen'],
  ['书房', 'study'], ['办公', 'study'], ['工作', 'study'],
];

export function roomScene(room: { id: string; name: string }): RoomSceneKind {
  return roomScenes[room.id] ?? sceneKeywords.find(([keyword]) => room.name.includes(keyword))?.[1] ?? 'home';
}

const kelvinStops: [number, [number, number, number]][] = [
  [2700, [255, 172, 92]],
  [3500, [255, 204, 140]],
  [4500, [255, 232, 200]],
  [5500, [236, 240, 255]],
  [6500, [196, 220, 255]],
];

function kelvinToRgb(kelvin: number): [number, number, number] {
  if (kelvin <= kelvinStops[0][0]) return kelvinStops[0][1];
  for (let index = 1; index < kelvinStops.length; index += 1) {
    const [upper, upperColor] = kelvinStops[index];
    const [lower, lowerColor] = kelvinStops[index - 1];
    if (kelvin <= upper) {
      const ratio = (kelvin - lower) / (upper - lower);
      return lowerColor.map((part, channel) => Math.round(part + (upperColor[channel] - part) * ratio)) as [number, number, number];
    }
  }
  return kelvinStops[kelvinStops.length - 1][1];
}

/**
 * 灯按名称里的安装形态选专属图标（顺序敏感：更具体的词放前面）。
 * 优先用 phu 品牌图标（实心灯具造型，见 brandIcons.tsx），少数无对应的仍用 lucide。
 */
const lightIconKeywords: [string, LucideIcon][] = [
  ['格栅', brandIcons['ceiling-square']],
  ['面板', brandIcons['ceiling-square']],
  ['灯带', brandIcons['light-strip']],
  ['灯条', brandIcons['light-strip']],
  ['吊灯', brandIcons['pendant-devote-solid']],
  ['吸顶', brandIcons['ceiling-round']],
  ['射灯', brandIcons['double-spot']],
  ['筒灯', brandIcons['bulbs-spot']],
  ['壁灯', brandIcons['wall-inara']],
  ['台灯', brandIcons['desk-lamp']],
  ['落地', brandIcons['floor-shade']],
  ['氛围', brandIcons['bloom']],
  ['柜灯', Lamp],
  ['橱柜', Lamp],
];

/** fan 域里混有新风机、浴霸换气 / 暖风、吊扇，按名称区分图标。 */
const fanIconKeywords: [string, LucideIcon][] = [
  ['吊扇', brandIcons['ceiling-fan']],
  ['暖风', Flame],
  ['取暖', Flame],
  ['换气', AirVent],
  ['新风', Wind],
  ['进风', Wind],
  ['排风', Wind],
  ['凉风', Wind],
  ['吹风', Wind],
];

/** 设备卡图标：设置里自定义的图标优先，否则按设备类型与名称关键词自动匹配；窗帘类随开合状态 / 位置换图标。 */
export function deviceIcon(device: Device): LucideIcon {
  const customIcon = findAnyIcon(device.icon);
  if (customIcon) return customIcon;
  if (device.kind === 'light') {
    return lightIconKeywords.find(([keyword]) => device.name.includes(keyword))?.[1] ?? brandIcons['bulbs-classic'];
  }
  if (device.kind === 'fan') {
    return fanIconKeywords.find(([keyword]) => device.name.includes(keyword))?.[1] ?? brandIcons['pedastal-fan'];
  }
  if (device.kind === 'cover') {
    const open = device.state !== 'closed';
    if (device.name.includes('百叶')) return brandIcons[open ? 'vert-blind-open' : 'vert-blind-close'];
    if (device.name.includes('卷帘')) return brandIcons[open ? 'ikea-blind-open' : 'ikea-blind-closed'];
    // 窗帘等：按当前开合度选卷帘档位图标。图标 shutter-N 的 N 表示帘布垂下比例
    //（shutter-0 收到顶=全开，shutter-100 铺满=全关），与 HA 位置语义相反，要取 100-position。
    const position = device.position ?? (device.state === 'open' ? 100 : device.state === 'closed' ? 0 : undefined);
    if (position !== undefined) {
      const extent = Math.min(100, Math.max(0, 100 - position));
      return brandIcons[`shutter-${Math.round(extent / 10) * 10}`];
    }
    return brandIcons['aqara-curtain'];
  }
  if (device.kind === 'vacuum') {
    return VacuumDeviceIcon;
  }
  if (device.kind === 'switch') {
    // 名字像插座 / 插排时用电源插座图标，其余普通开关用电源键。
    return /插座|插排|插线板|排插/.test(device.name) ? PlugZap : Power;
  }
  return brandIcons['bulbs-classic'];
}

/** 灯卡开启时的光晕色：彩色模式用当前颜色，色温模式按开尔文近似，仅开关灯用默认暖光。 */
export function lightGlow(light: LightDevice): string {
  const mode = light.activeColorMode ?? (light.color ? 'color' : 'color_temp');
  if (mode === 'color' && light.color) return light.color;
  if (light.colorTemp !== undefined && light.supportedColorModes.includes('color_temp')) {
    const [red, green, blue] = kelvinToRgb(light.colorTemp);
    return `rgb(${red} ${green} ${blue})`;
  }
  return '#ffc27a';
}

export type ClimateTone = 'off' | 'cool' | 'heat' | 'dry' | 'fan' | 'auto' | 'unavailable';

export function climateTone(device: ClimateDevice): ClimateTone {
  if (!device.available) return 'unavailable';
  if (!device.on) return 'off';
  if (device.kind === 'heating' || device.mode === 'heat') return 'heat';
  if (device.mode === 'cool') return 'cool';
  if (device.mode === 'dry') return 'dry';
  if (device.mode === 'fan_only') return 'fan';
  return 'auto';
}
