import { Battery, BatteryFull, BatteryMedium, BatteryWarning, DoorOpen, Droplets, Fan, Lightbulb, ShieldAlert, Thermometer, UsersRound, Waves, Wind } from 'lucide-react';
import { isActiveAlert, isLit, isOpenDoor } from '../selectors';
import type { HomeState } from '../types';
import type { ActiveListRequest } from './ActiveDevicesDialog';

const lowBatteryThreshold = 20;

function highlightPillVisual(level: number | null, available: boolean) {
  if (!available || level === null) return { icon: <BatteryWarning size={15} />, tone: ' status-pill--alert', label: '未知' };
  if (level <= 20) return { icon: <BatteryWarning size={15} />, tone: ' status-pill--alert', label: `${level}%` };
  if (level <= 40) return { icon: <Battery size={15} />, tone: ' status-pill--warning', label: `${level}%` };
  if (level <= 70) return { icon: <BatteryMedium size={15} />, tone: '', label: `${level}%` };
  return { icon: <BatteryFull size={15} />, tone: '', label: `${level}%` };
}

/** onOpen：点亮灯、空调、地暖标签打开对应列表（可一键关闭）。onOpenBattery：打开电池状态列表。batteryEnabled：主页电池总药丸是否显示。 */
export function HomeStatusSummary({ home, onOpen, onOpenBattery, batteryEnabled }: { home: HomeState; onOpen: (request: ActiveListRequest) => void; onOpenBattery: () => void; batteryEnabled: boolean }) {
  const alerts = home.devices.filter(isActiveAlert).length;
  const openDoors = home.devices.filter(isOpenDoor);
  const peopleHome = home.people.filter((person) => person.status === 'home');
  const lit = home.devices.filter(isLit).length;
  const runningAirConditioners = home.devices.filter((device) => device.kind === 'climate' && device.available && device.on).length;
  const runningFloorHeatings = home.devices.filter((device) => device.kind === 'heating' && device.available && device.on).length;
  const runningFans = home.devices.filter((device) => device.kind === 'fan' && device.available && device.on).length;
  // 设置里“指向主页”的温湿度来源（scope = home），与房间状态摘要同样的药丸样式。
  const temperature = home.devices.find((device) => device.roomId === 'home' && device.kind === 'sensor' && device.metric === 'temperature');
  const humidity = home.devices.find((device) => device.roomId === 'home' && device.kind === 'sensor' && device.metric === 'humidity');

  // 电量提醒：所有 battery 实体（含未分配房间的），低电/未知时警示色，否则正常色。
  const batteries = home.batteries;
  const lowCount = batteries.filter((b) => b.available && b.level !== null && b.level <= lowBatteryThreshold).length;
  const unknownCount = batteries.filter((b) => !b.available || b.level === null).length;
  const batteryTone = lowCount > 0 || unknownCount > 0 ? ' status-pill--warning' : '';
  // 首页常驻显示的单个电池实体（设置里手动指定 highlightEntity）。
  const highlight = batteries.find((b) => b.highlight);

  return (
    <div className="status-row" aria-label="家庭状态">
      {alerts > 0 && <span className="status-pill status-pill--alert"><ShieldAlert size={15} />{alerts} 项安全告警</span>}
      {peopleHome.length > 0 && <span className="status-pill status-pill--home"><UsersRound size={15} />{peopleHome.map((person) => person.name).join('、')}在家</span>}
      {temperature?.kind === 'sensor' && <span className={`status-pill${temperature.available ? '' : ' status-pill--warning'}`}><Thermometer size={15} />温度 {temperature.available ? `${temperature.value}${temperature.unit}` : '暂无数据'}</span>}
      {humidity?.kind === 'sensor' && <span className={`status-pill${humidity.available ? '' : ' status-pill--warning'}`}><Droplets size={15} />湿度 {humidity.available ? `${humidity.value}${humidity.unit}` : '暂无数据'}</span>}
      {lit > 0 && <button type="button" className="status-pill status-pill--light status-pill--button" onClick={() => onOpen({ kind: 'light' })}><Lightbulb size={15} />{lit} 盏灯亮</button>}
      {runningAirConditioners > 0 && <button type="button" className="status-pill status-pill--cool status-pill--button" onClick={() => onOpen({ kind: 'climate' })}><Wind size={15} />{runningAirConditioners} 台空调开启</button>}
      {openDoors.length > 0 && <span className="status-pill"><DoorOpen size={15} />{openDoors.length <= 2 ? `${openDoors.map((device) => device.name).join('、')}已打开` : `${openDoors.length} 处门窗打开`}</span>}
      {runningFloorHeatings > 0 && <button type="button" className="status-pill status-pill--heat status-pill--button" onClick={() => onOpen({ kind: 'heating' })}><Waves size={15} />{runningFloorHeatings} 处制热已开启</button>}
      {runningFans > 0 && <button type="button" className="status-pill status-pill--cool status-pill--button" onClick={() => onOpen({ kind: 'fan' })}><Fan size={15} />{runningFans} 台风扇开启</button>}
      {highlight && (() => {
        const v = highlightPillVisual(highlight.level, highlight.available);
        return <button type="button" className={`status-pill status-pill--button${v.tone}`} onClick={onOpenBattery} title={highlight.name}>{v.icon}{highlight.name} {v.label}</button>;
      })()}
      {batteryEnabled && batteries.length > 0 && (
        <button type="button" className={`status-pill status-pill--button${batteryTone}`} onClick={onOpenBattery}>
          <BatteryWarning size={15} />电池 {batteries.length} 个{lowCount > 0 ? `（${lowCount} 低电）` : unknownCount > 0 ? `（${unknownCount} 未知）` : ''}
        </button>
      )}
    </div>
  );
}
