import { useId } from 'react';
import type { ReactNode } from 'react';
import { roomScene } from '../appearance';
import type { RoomSceneKind } from '../appearance';
import type { Room } from '../types';

/** 五角星顶点，用于儿童房的星星挂饰。 */
function star(cx: number, cy: number, outer: number, inner = outer * 0.45): string {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    return `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');
}

/**
 * 每种房间一幅线描小场景（viewBox 320×180，地面在 y=160）。
 * light：灯开时显示的暖光（填充）；lamp：灯具本身（灯开时描边变暖色）；其余为家具线条。
 */
const scenes: Record<RoomSceneKind, { light: ReactNode; lamp: ReactNode; body: ReactNode }> = {
  living: {
    light: <><path d="M234 70 L212 156 H288 L266 70 Z" /><circle cx="250" cy="58" r="26" /></>,
    lamp: <><path d="M232 70h36l-8-26h-20z" /><path d="M250 70v90M238 160h24" /></>,
    body: <>
      <path d="M52 118V98a10 10 0 0 1 10-10h126a10 10 0 0 1 10 10v20" />
      <path d="M40 150v-32a8 8 0 0 1 16 0v32M194 150v-32a8 8 0 0 1 16 0v32" />
      <path d="M56 126h138M40 150h170M125 90v36M50 150v10M200 150v10" />
      <path d="M96 26h64v42H96zM102 62l16-16 11 11 9-9 16 14" />
      <path d="M282 160l3-18h20l3 18M295 142c-10-9-13-23-5-33M295 142c8-8 12-20 6-31M295 142c-1-14 3-26 11-32" />
    </>,
  },
  dining: {
    light: <><path d="M140 56 L108 116 H212 L180 56 Z" /><circle cx="160" cy="46" r="24" /></>,
    lamp: <><path d="M160 0v34M136 56a24 22 0 0 1 48 0z" /></>,
    body: <>
      <path d="M66 118h188M82 118v42M238 118v42" />
      <path d="M148 118v-8a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v8M160 104c0-9-6-15-13-17M160 104c0-10 6-16 13-18" />
      <path d="M188 116a13 3 0 0 0 26 0M100 116a13 3 0 0 0 26 0" />
      <path d="M40 160V88M40 126h26v34M280 160V88M280 126h-26v34" />
    </>,
  },
  bedroom: {
    light: <><circle cx="36" cy="96" r="26" /><path d="M28 104 L18 120 H54 L44 104 Z" /></>,
    lamp: <><path d="M26 104h20l-4-14h-12zM36 104v16" /></>,
    body: <>
      <path d="M60 160V86a10 10 0 0 1 10-10h16a10 10 0 0 1 10 10v40" />
      <path d="M60 126h172a8 8 0 0 1 8 8v10H60zM60 144h180v8M66 152v8M234 152v8" />
      <path d="M72 126v-9a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v9M122 126c14-10 38-10 52 0s38 10 58 0" />
      <path d="M18 160v-40h36v40M18 138h36" />
      <path d="M232 22h66v58h-66zM265 22v58M232 51h66" />
      <path d="M290 36a8 8 0 1 1-9-9 6 6 0 0 0 9 9z" />
    </>,
  },
  kids: {
    light: <><circle cx="250" cy="58" r="30" /></>,
    lamp: <>
      <path d="M250 0v28M224 28h52M224 28v16M250 28v24M276 28v12" />
      <polygon points={star(224, 50, 7)} /><polygon points={star(250, 60, 8)} /><polygon points={star(276, 46, 6)} />
    </>,
    body: <>
      <path d="M70 160V100M70 124h140M210 160V112M70 144h140M90 124v20M110 124v20M130 124v20M150 124v20M170 124v20M190 124v20" />
      <path d="M78 124v-8a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v8" />
      <path d="M30 160v-20h22v20zM41 140l-6 14h12z" />
      <circle cx="298" cy="148" r="12" /><path d="M286 148h24M298 136c6 6 6 18 0 24" />
      <path d="M116 42a12 12 0 1 1-13-13 9 9 0 0 0 13 13z" />
    </>,
  },
  bath: {
    light: <><ellipse cx="278" cy="64" rx="34" ry="42" /></>,
    lamp: <><ellipse cx="278" cy="64" rx="20" ry="28" /><path d="M262 30h32" /></>,
    body: <>
      <path d="M36 116h196M44 116v10a26 26 0 0 0 26 26h128a26 26 0 0 0 26-26v-10M76 152l-5 8M196 152l5 8" />
      <path d="M216 116V92h16" />
      <path d="M56 18v36h22M78 54h18l-4 8h-10zM82 70v6M88 70v9M94 70v6" />
      <circle cx="100" cy="106" r="5" /><circle cx="114" cy="100" r="7" /><circle cx="128" cy="108" r="4" />
      <path d="M248 160v-18h60v18" />
    </>,
  },
  kitchen: {
    light: <><path d="M132 52 L112 116 H208 L188 52 Z" /></>,
    lamp: <><path d="M136 8h48v20l24 24H112l24-24z" /></>,
    body: <>
      <path d="M20 118h280M20 118v42M300 118v42M110 118v42M210 118v42M58 136h14M152 136h14M248 136h14" />
      <path d="M136 118v-18h48v18M128 100h64M150 90c-6-8 6-12 0-20M170 90c-6-8 6-12 0-20" />
      <path d="M26 40h64M36 40v22M58 40v28M80 40v18M36 62a5 5 0 1 0 0 10M58 68h-4v10h8V68z" />
      <path d="M236 118v-26h36v26M242 92v-8h24v8" />
    </>,
  },
  study: {
    light: <><path d="M222 64 L188 110 H252 Z" /><circle cx="228" cy="60" r="22" /></>,
    lamp: <><path d="M204 110h26M216 110l-14-32 22-20M224 58l12 6-8 12z" /></>,
    body: <>
      <path d="M60 110h184M72 110v50M232 110v50M168 110v24h64" />
      <path d="M84 110V80h10v30M96 110V72h10v38M108 110l6-26 9 2-6 24" />
      <path d="M40 38h96M48 38V20h8v18M58 38V16h8v22M68 38l4-18 7 2-4 16M100 38v-14h22v14" />
      <path d="M270 160v-44h26M270 132h26v28M296 116v44" />
    </>,
  },
  home: {
    light: <><rect x="138" y="96" width="24" height="24" /></>,
    lamp: <><path d="M138 96h24v24h-24zM150 96v24M138 108h24" /></>,
    body: <>
      <path d="M90 160V92l70-54 70 54v68M76 102l84-66 84 66M186 160v-38h24v38M100 160h120" />
      <path d="M262 160l3-16h18l3 16M274 144c-9-8-11-20-4-29M274 144c7-7 10-17 5-27" />
    </>,
  },
};

/** 房间页页头右侧的线描场景：按房间类型选择，房间有灯亮时灯具发出暖光。 */
export function RoomScene({ room, lit }: { room: Room; lit: boolean }) {
  const scene = scenes[roomScene(room)];
  // 光晕用 SVG 自带的高斯模糊：iPad / Safari 对 SVG 内元素的 CSS filter: blur() 支持不稳定，会显示成边缘生硬的光柱。
  const glowId = `room-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={`room-scene${lit ? ' room-scene--lit' : ''}`} viewBox="0 0 320 180" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
      <defs>
        <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>
      <g className="room-scene__light" filter={`url(#${glowId})`}>{scene.light}</g>
      <g className="room-scene__lines">
        <path d="M4 160H316" className="room-scene__floor" />
        {scene.body}
      </g>
      <g className="room-scene__lamp">{scene.lamp}</g>
    </svg>
  );
}
