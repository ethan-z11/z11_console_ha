import { AirVent, Droplet, Fan, Flame, Minus, Plus, Snowflake, Sparkles, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { climateTone } from '../appearance';
import type { ClimateTone } from '../appearance';
import { fanModeLabel, hvacModeLabel } from '../climate';
import type { ClimateDevice, Room } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

const climateIcons: Partial<Record<ClimateTone, LucideIcon>> = { cool: Snowflake, heat: Flame, dry: Droplet, fan: Fan, auto: Sparkles };

interface ClimateCardProps {
  layout: TileLayoutProps;
  climate: ClimateDevice;
  room: Room;
  onToggle: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
  onOpenDetails: (id: string) => void;
  /** 季节规则下不能打开时的说明（夏季的地暖）；关闭状态下代替“已关闭”显示。 */
  seasonLock?: string;
}

export function ClimateCard({ layout, climate, room, onToggle, onAdjust, onOpenDetails, seasonLock }: ClimateCardProps) {
  const { editing } = layout;
  const tone = climateTone(climate);
  const Icon = climateIcons[tone] ?? (climate.kind === 'heating' ? Waves : AirVent);
  const label = `${room.name}${climate.name}`;
  const mode = `${climate.on ? hvacModeLabel(climate.mode) : '已关闭 · ' + hvacModeLabel(climate.mode)}${climate.fanMode ? ` · ${fanModeLabel(climate.fanMode)}` : ''}`;
  const locked = Boolean(seasonLock) && climate.available && !climate.on;
  const status = !climate.available ? '设备不可用' : locked ? `${climate.current !== undefined ? `室温 ${climate.current}° · ` : ''}${seasonLock}` : `${climate.current !== undefined ? `室温 ${climate.current}° · ` : ''}${mode}`;
  const shortStatus = !climate.available ? '不可用' : climate.on ? hvacModeLabel(climate.mode) : locked ? seasonLock! : '已关闭';
  // 2×1 时名称和简短状态放在图标右侧（与灯一致），温度下方只补充室温和风速。
  const detail = !climate.available ? '设备不可用' : [climate.current !== undefined ? `室温 ${climate.current}°` : '', climate.fanMode ? fanModeLabel(climate.fanMode) : ''].filter(Boolean).join(' · ');
  const adjustDisabled = !climate.available || !climate.on || editing;

  return (
    <TileFrame {...layout} active={climate.on} className={`climate-card climate-card--${tone}${locked ? ' climate-card--locked' : ''}`} onOpen={() => onOpenDetails(climate.id)}>
      <div className="tile__top">
        {/* 模式图标就是电源开关（与灯一致）：关闭为灰色，打开时按模式着色；右上角留给房间名。 */}
        <button type="button" className="climate-card__power" onClick={() => onToggle(climate.id)} disabled={!climate.available || editing} aria-label={`${climate.on ? '关闭' : '打开'}${label}`} aria-pressed={climate.on}>
          <Icon size={20} />
        </button>
        <div className="climate-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{climate.name}</span><span className="tile__note">{shortStatus}</span></div>
        <span className="tile__room">{room.name}</span>
      </div>
      <div className="climate-card__bottom">
        <button type="button" className="climate-card__summary" onClick={() => onOpenDetails(climate.id)} disabled={editing} aria-label={`设置${label}${climate.fanModes?.length ? '模式与风速' : '模式'}`}>
          <span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span>
          <span className="tile__name">{climate.name}</span>
          <strong className="climate-card__target">{climate.available ? climate.target : '--'}<small>°</small></strong>
          <span className="tile__note climate-card__note climate-card__note--full">{status}</span>
          {detail && <span className="tile__note climate-card__note climate-card__note--detail">{detail}</span>}
          <span className="tile__note climate-card__note--short">{shortStatus}</span>
        </button>
        <div className="climate-card__actions">
          <button type="button" onClick={() => onAdjust(climate.id, climate.step)} disabled={adjustDisabled} aria-label={`升高${label}设定温度`}><Plus size={18} /></button>
          <button type="button" onClick={() => onAdjust(climate.id, -climate.step)} disabled={adjustDisabled} aria-label={`降低${label}设定温度`}><Minus size={18} /></button>
        </div>
      </div>
    </TileFrame>
  );
}
