import { Palette, SlidersHorizontal, Sun, Thermometer, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { deviceIcon, lightGlow } from '../appearance';
import { releasePointerFocus } from '../focus';
import { getLightVariant, supportsColor, supportsColorTemperature } from '../light';
import type { LightDevice, LightPatch, Room } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

const whitePresets = [
  { id: 'white', label: '白色', kelvin: 4000, brightness: 100 },
  { id: 'warm', label: '暖白', kelvin: 3000, brightness: 70 },
  { id: 'cool', label: '冷白', kelvin: 6000, brightness: 100 },
] as const;

const commonColors = [
  { label: '白色', value: '#ffffff' },
  { label: '暖黄', value: '#ffd477' },
  { label: '橙色', value: '#ffab61' },
  { label: '红色', value: '#fa5f66' },
  { label: '粉色', value: '#ee8dca' },
  { label: '紫色', value: '#bd83ec' },
  { label: '蓝色', value: '#6b9bff' },
  { label: '青色', value: '#5bd3dc' },
  { label: '绿色', value: '#78d187' },
] as const;

function hsvToHex(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation;
  const section = hue / 60;
  const second = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, second, 0] : section < 2 ? [second, chroma, 0] : section < 3 ? [0, chroma, second] : section < 4 ? [0, second, chroma] : section < 5 ? [second, 0, chroma] : [chroma, 0, second];
  const offset = value - chroma;
  return `#${[red, green, blue].map((part) => Math.round((part + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function ColorChoices({ light, room, brightness, colorTemp, activeColorMode, boardPoint, onChoose, onBoardChoose }: {
  light: LightDevice;
  room: Room;
  brightness: number;
  colorTemp: number;
  activeColorMode: 'color' | 'color_temp';
  boardPoint: { x: number; y: number; color: string } | null;
  onChoose: (patch: LightPatch) => void;
  onBoardChoose: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const clampKelvin = (kelvin: number) => Math.min(light.maxColorTempKelvin ?? 6500, Math.max(light.minColorTempKelvin ?? 2700, kelvin));
  return <>
    {supportsColorTemperature(light) && <div className="light-palette__group"><span>白光预设</span><div className="light-palette__options">
      {whitePresets.map((preset) => {
        const kelvin = clampKelvin(preset.kelvin);
        return <button key={preset.id} type="button" className={`light-card__preset light-card__preset--${preset.id}`} onClick={() => onChoose({ brightness: preset.brightness, colorTemp: kelvin })} aria-label={`${room.name}${light.name}使用${preset.label}预设`} aria-pressed={activeColorMode === 'color_temp' && brightness === preset.brightness && colorTemp === kelvin}>{preset.label}</button>;
      })}
    </div></div>}
    {supportsColor(light) && <div className="light-palette__group"><span>常用颜色 · 点选即生效</span><div className="light-palette__options light-palette__options--colors">
      {commonColors.map((color) => <button key={color.value} type="button" className={`light-card__swatch${color.label === '白色' ? ' light-card__swatch--white' : ''}`} style={{ '--swatch-color': color.value } as CSSProperties} onClick={() => onChoose({ color: color.value })} aria-label={`${room.name}${light.name}设为${color.label}`} aria-pressed={activeColorMode === 'color' && light.color?.toLowerCase() === color.value} title={color.label} />)}
    </div></div>}
    {supportsColor(light) && <div className="light-palette__group"><span>自选色板 · 点击一次即设置</span><button type="button" className="light-palette__board" onClick={onBoardChoose} aria-label={`${room.name}${light.name}自选色板，点击位置设置颜色`}>
      {boardPoint && activeColorMode === 'color' && light.color?.toLowerCase() === boardPoint.color && <span className="light-palette__board-marker" style={{ left: `${boardPoint.x * 100}%`, top: `${boardPoint.y * 100}%` }} />}
    </button></div>}
  </>;
}

interface LightCardProps {
  layout: TileLayoutProps;
  light: LightDevice;
  room: Room;
  onToggle: (id: string) => void;
  onChange: (id: string, patch: LightPatch) => void;
}

export function LightCard({ layout, light, room, onToggle, onChange }: LightCardProps) {
  const { size, editing } = layout;
  const DeviceIcon = deviceIcon(light);
  const variant = getLightVariant(light);
  const adjustable = variant !== 'switch';
  const compact = adjustable && size === '1x1';
  const disabled = !light.available || Boolean(editing);
  const status = !light.available ? '设备不可用' : light.on ? '已打开' : '已关闭';
  const brightness = light.brightness ?? 100;
  const minColorTemp = light.minColorTempKelvin ?? 2700;
  const maxColorTemp = light.maxColorTempKelvin ?? 6500;
  const colorTemp = light.colorTemp ?? 4000;
  const activeColorMode = light.activeColorMode ?? (light.color ? 'color' : 'color_temp');
  const brightnessStyle = { '--range-progress': `${brightness}%` } as CSSProperties;
  const glowStyle = { '--light-glow': lightGlow(light), '--light-level': adjustable ? .45 + brightness / 180 : 1 } as CSSProperties;
  const hasPalette = supportsColorTemperature(light) || supportsColor(light);
  const paletteId = useId();
  const detailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDialogElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [palettePosition, setPalettePosition] = useState({ top: 0, left: 0 });
  const [boardPoint, setBoardPoint] = useState<{ x: number; y: number; color: string } | null>(null);

  useEffect(() => {
    if (!paletteOpen) return;
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node) || triggerRef.current?.contains(event.target as Node)) return;
      setPaletteOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPaletteOpen(false); };
    const closeOnMove = () => setPaletteOpen(false);
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnMove, true);
    window.addEventListener('resize', closeOnMove);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnMove, true);
      window.removeEventListener('resize', closeOnMove);
    };
  }, [paletteOpen]);

  useEffect(() => { if (disabled) { setPaletteOpen(false); setDetailOpen(false); } }, [disabled]);
  useEffect(() => { if (detailOpen && detailRef.current && !detailRef.current.open) detailRef.current.showModal(); }, [detailOpen]);

  function togglePalette() {
    if (paletteOpen) { setPaletteOpen(false); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = Math.min(304, window.innerWidth - 24);
    const panelHeight = Math.min(410, window.innerHeight - 24);
    const left = Math.max(12, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 12));
    const top = rect.bottom + panelHeight + 8 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - panelHeight - 8);
    setPalettePosition({ top, left });
    setPaletteOpen(true);
  }

  function chooseColor(patch: LightPatch) {
    setBoardPoint(null);
    onChange(light.id, patch);
    setPaletteOpen(false);
  }

  function chooseBoardColor(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, ((event.detail === 0 ? rect.left + rect.width / 2 : event.clientX) - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, ((event.detail === 0 ? rect.top + rect.height / 2 : event.clientY) - rect.top) / rect.height));
    const saturation = Math.min(1, y * 2);
    const value = y <= .5 ? 1 : Math.max(0, 2 - y * 2);
    const color = hsvToHex(x * 359.999, saturation, value);
    setBoardPoint({ x, y, color });
    onChange(light.id, { color });
    setPaletteOpen(false);
  }

  return (
    <>
    <TileFrame {...layout} style={glowStyle} className={`light-card light-card--${variant}${compact ? ' light-card--compact' : ''}`} active={light.on} onOpen={compact && light.available ? () => onToggle(light.id) : undefined}>
      <div className="tile__top">
        <button type="button" className="tile__power" onClick={() => onToggle(light.id)} disabled={disabled} aria-label={`${light.on ? '关闭' : '打开'}${room.name}${light.name}`} aria-pressed={light.on}><DeviceIcon size={21} /></button>
        {adjustable && !compact && <div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{light.name}</span><span className="tile__note">{status}</span></div>}
        <span className="tile__room">{room.name}</span>
        {hasPalette && !compact && <button ref={triggerRef} type="button" className="light-card__palette-trigger" style={{ '--light-selected-color': activeColorMode === 'color' ? light.color ?? '#ffffff' : '#fff3dd' } as CSSProperties} onClick={togglePalette} disabled={disabled} aria-label={`选择${room.name}${light.name}灯光颜色`} aria-haspopup="dialog" aria-expanded={paletteOpen} aria-controls={paletteOpen ? paletteId : undefined}><Palette size={19} /></button>}
      </div>
      {adjustable && !compact ? (
        <div className="light-card__controls">
          <div className="light-card__range light-card__range--brightness">
            <span className="light-card__control-icon light-card__control-icon--brightness" aria-hidden="true"><Sun size={16} /></span>
            <input type="range" min="1" max="100" value={brightness} style={brightnessStyle} onChange={(event) => onChange(light.id, { brightness: Number(event.target.value) })} disabled={disabled} aria-label={`调整${room.name}${light.name}亮度`} />
            <output>{brightness}%</output>
          </div>
          {supportsColorTemperature(light) && <div className="light-card__range light-card__range--temperature">
            <span className="light-card__control-icon light-card__control-icon--temperature" aria-hidden="true"><Thermometer size={16} /></span>
            <input type="range" min={minColorTemp} max={maxColorTemp} step="1" value={colorTemp} onChange={(event) => onChange(light.id, { colorTemp: Number(event.target.value) })} disabled={disabled} aria-label={`调整${room.name}${light.name}色温`} />
            <output>{colorTemp}K</output>
          </div>}
        </div>
      ) : <div className="light-card__compact-bottom"><div className="light-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{light.name}</span><span className="tile__note">{status}</span></div>
        {compact && !editing && <button type="button" className="light-card__settings" onClick={() => setDetailOpen(true)} disabled={!light.available} aria-label={`设置${room.name}${light.name}亮度、色温和颜色`} aria-haspopup="dialog" aria-controls={detailOpen ? detailId : undefined}><SlidersHorizontal size={18} /></button>}
      </div>}
    </TileFrame>
    {paletteOpen && createPortal(<div ref={panelRef} id={paletteId} className="light-palette" role="dialog" aria-label={`${room.name}${light.name}灯光颜色`} style={palettePosition}>
      <div className="light-palette__heading"><strong>灯光颜色</strong><button type="button" onClick={() => setPaletteOpen(false)} aria-label="关闭灯光颜色"><X size={17} /></button></div>
      <ColorChoices light={light} room={room} brightness={brightness} colorTemp={colorTemp} activeColorMode={activeColorMode} boardPoint={boardPoint} onChoose={chooseColor} onBoardChoose={chooseBoardColor} />
    </div>, document.body)}
    {detailOpen && createPortal(<dialog ref={detailRef} id={detailId} className="light-detail-dialog" aria-labelledby={`${detailId}-title`} onClose={() => { setDetailOpen(false); releasePointerFocus(); }} onCancel={() => setDetailOpen(false)} onClick={(e) => { if (e.target === e.currentTarget) setDetailOpen(false); }}>
      <div className="light-detail-dialog__heading"><div><small>{room.name}</small><h2 id={`${detailId}-title`}>{light.name}</h2></div><button type="button" onClick={() => setDetailOpen(false)} autoFocus aria-label="关闭灯光设置"><X size={20} /></button></div>
      <div className="light-detail-dialog__control"><div><label htmlFor={`${detailId}-brightness`}>亮度</label><output>{brightness}%</output></div><input id={`${detailId}-brightness`} type="range" min="1" max="100" value={brightness} onChange={(event) => onChange(light.id, { brightness: Number(event.target.value) })} disabled={!light.available} /></div>
      {supportsColorTemperature(light) && <div className="light-detail-dialog__control"><div><label htmlFor={`${detailId}-temperature`}>色温</label><output>{colorTemp}K</output></div><input id={`${detailId}-temperature`} type="range" min={minColorTemp} max={maxColorTemp} step="1" value={colorTemp} onChange={(event) => onChange(light.id, { colorTemp: Number(event.target.value) })} disabled={!light.available} /></div>}
      {hasPalette && <div className="light-detail-dialog__colors"><ColorChoices light={light} room={room} brightness={brightness} colorTemp={colorTemp} activeColorMode={activeColorMode} boardPoint={boardPoint} onChoose={chooseColor} onBoardChoose={chooseBoardColor} /></div>}
    </dialog>, document.body)}
    </>
  );
}
