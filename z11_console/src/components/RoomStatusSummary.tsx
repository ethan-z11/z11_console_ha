import { BatteryWarning, DoorOpen, Droplets, Lightbulb, PersonStanding, Radar, ShieldAlert, Thermometer, Waves, Wind } from 'lucide-react';
import { climateSummaryTone, isActiveAlert, isClimate, isLit, isOpenDoor } from '../selectors';
import type { HomeState, SafetyDevice } from '../types';
import type { ActiveListRequest } from './ActiveDevicesDialog';

const lowBatteryThreshold = 20;

export function RoomStatusSummary({ home, roomId, onOpen }: { home: HomeState; roomId: string; onOpen: (request: ActiveListRequest) => void }) {
  const devices = home.devices.filter((device) => device.roomId === roomId);
  const alerts = devices.filter(isActiveAlert);
  const lit = devices.filter(isLit).length;
  const openDoors = devices.filter(isOpenDoor);
  const temperature = devices.find((device) => device.kind === 'sensor' && device.metric === 'temperature');
  const humidity = devices.find((device) => device.kind === 'sensor' && device.metric === 'humidity');
  const motions = devices.filter((device): device is SafetyDevice => device.kind === 'safety' && device.sensorType === 'motion');
  // 同一房间的人体移动 / 存在传感器合并：任意一个检测到即为有人；无人时不显示，全部状态未知时提示。
  const motionKnown = motions.filter((device) => device.available && device.status !== 'unknown');
  const occupied = motionKnown.some((device) => device.status === 'alert');
  // 只显示正在运行或不可用的空调 / 地暖；关闭的不占位。
  const activeClimate = devices.filter(isClimate).filter((device) => !device.available || device.on);
  const batteries = home.batteries.filter((battery) => battery.roomId === roomId);
  const lowBatteries = batteries.filter((battery) => battery.available && battery.level !== null && battery.level <= lowBatteryThreshold);
  const unknownBatteries = batteries.filter((battery) => !battery.available || battery.level === null);

  return (
    <div className="status-row" aria-label="房间状态概览">
      {alerts.map((device) => <span key={device.id} className="status-pill status-pill--alert"><ShieldAlert size={15} />{device.name}报警</span>)}
      {lit > 0 && <button type="button" className="status-pill status-pill--light status-pill--button" onClick={() => onOpen({ kind: 'light', roomId })}><Lightbulb size={15} />{lit} 盏灯亮</button>}
      {temperature?.kind === 'sensor' && <span className={`status-pill${temperature.available ? '' : ' status-pill--warning'}`}><Thermometer size={15} />温度 {temperature.available ? `${temperature.value}${temperature.unit}` : '暂无数据'}</span>}
      {humidity?.kind === 'sensor' && <span className={`status-pill${humidity.available ? '' : ' status-pill--warning'}`}><Droplets size={15} />湿度 {humidity.available ? `${humidity.value}${humidity.unit}` : '暂无数据'}</span>}
      {occupied && <span className="status-pill status-pill--home status-pill--occupied" title={`人体感应：${motions.map((device) => device.name).join('、')}`}><PersonStanding size={15} className="presence-blink" />有人</span>}
      {!occupied && motions.length > 0 && motionKnown.length === 0 && <span className="status-pill status-pill--warning" title={`人体感应：${motions.map((device) => device.name).join('、')}`}><Radar size={15} />人体感应状态未知</span>}
      {openDoors.map((device) => <span key={device.id} className="status-pill"><DoorOpen size={15} />{device.name}已打开</span>)}
      {activeClimate.map((device) => device.available
        ? <button key={device.id} type="button" className={`status-pill status-pill--${climateSummaryTone(device)} status-pill--button`} onClick={() => onOpen({ kind: device.kind, roomId })}>{device.kind === 'heating' ? <Waves size={15} /> : <Wind size={15} />}{device.name}打开</button>
        : <span key={device.id} className="status-pill status-pill--warning">{device.kind === 'heating' ? <Waves size={15} /> : <Wind size={15} />}{device.name}不可用</span>)}
      {lowBatteries.length > 0 && <span className="status-pill status-pill--warning"><BatteryWarning size={15} />低电量 {lowBatteries.length} 个设备</span>}
      {unknownBatteries.length > 0 && <span className="status-pill status-pill--warning"><BatteryWarning size={15} />电池状态未知 {unknownBatteries.length} 个设备</span>}
    </div>
  );
}
