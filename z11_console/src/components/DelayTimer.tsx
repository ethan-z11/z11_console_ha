import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Hourglass } from 'lucide-react';
import type { Device } from '../types';

interface DelayTimerBlockProps {
  device: Device;
  /** 设备处于开启状态（灯 / 开关 / 风扇的 on，窗帘的 open / opening）才允许开启计时。 */
  armed: boolean;
  onSet: (id: string, seconds: number) => void;
  onClear: (id: string) => void;
}

const wheelItemHeight = 34;
const hourValues = Array.from({ length: 24 }, (_, index) => String(index));
const minuteValues = Array.from({ length: 60 }, (_, index) => String(index));
/** 常用倒计时（对齐米家）：10 分钟 / 30 分钟 / 1 小时 / 2 小时 30 分。 */
const quickPresets: [string, number][] = [['10分钟', 600], ['30分钟', 1800], ['1小时', 3600], ['2小时30分', 9000]];

/** 每秒跳动的当前时间；仅在倒计时进行时启用，用于刷新剩余时间显示。 */
function useNowTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分 ${seconds}秒`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
}

interface WheelProps {
  values: string[];
  index: number;
  onIndexChange: (next: number) => void;
  label: string;
}

/** 时 / 分滚轮：竖向 scroll-snap 选择（米家倒计时风格），容器三行可见、上下渐隐。 */
function Wheel({ values, index, onIndexChange, label }: WheelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);
  // 打开选择面板时定位到当前选中项（仅挂载时，用户滚动后不回跳）。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = index * wheelItemHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const next = Math.min(values.length - 1, Math.max(0, Math.round(el.scrollTop / wheelItemHeight)));
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => onIndexChange(next), 120);
  }
  return (
    <div className="timer-wheel">
      <span className="timer-wheel__label">{label}</span>
      <div className="timer-wheel__list" ref={listRef} onScroll={handleScroll}>
        <div className="timer-wheel__spacer" aria-hidden="true" />
        {values.map((value, position) => (
          <span key={value} className={`timer-wheel__item${position === index ? ' is-active' : ''}`} aria-hidden="true">{value}</span>
        ))}
        <div className="timer-wheel__spacer" aria-hidden="true" />
      </div>
      <select className="timer-wheel__a11y" value={index} onChange={(event) => onIndexChange(Number(event.target.value))} aria-label={label}>
        {values.map((value, position) => <option key={value} value={position}>{value}</option>)}
      </select>
    </div>
  );
}

/**
 * 延时关闭区块（设备设置弹窗内）：开关 + 延迟时间行 + 紧凑滚轮选择面板（米家风格）。
 * 只有设备开启时可操作；倒计时进行中显示剩余时间，点开关即提前取消；
 * 设备被其它方式关闭时服务端立即作废计时，本组件随 timerEndsAt 消失自动复位。
 */
export function DelayTimerBlock({ device, armed, onSet, onClear }: DelayTimerBlockProps) {
  const timerEndsAt = device.timerEndsAt;
  const timerActive = Boolean(timerEndsAt && timerEndsAt > 0);
  const now = useNowTick(timerActive);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hour, setHour] = useState(1);
  const [minute, setMinute] = useState(0);
  // 设备关闭 / 计时被服务端作废时收起选择面板。
  useEffect(() => {
    if (!armed || !timerActive) setPickerOpen(false);
  }, [armed, timerActive]);
  const remaining = timerActive ? Math.max(0, (timerEndsAt as number) - now) : 0;
  const pickedSeconds = hour * 3600 + minute * 60;
  const pickedLabel = pickedSeconds >= 60 ? `${hour > 0 ? `${hour}小时` : ''}${minute > 0 ? `${minute}分钟` : hour > 0 ? '' : '1小时'}` : '1小时';

  return (
    <section className={`timer-block${armed ? '' : ' timer-block--disabled'}`} aria-label={`延时关闭${device.name}`}>
      <div className="timer-block__row">
        <Hourglass size={18} />
        <span className="timer-block__title">延时关闭</span>
        <button
          type="button"
          className={`timer-switch${timerActive ? ' is-on' : ''}`}
          disabled={!armed}
          role="switch"
          aria-checked={timerActive}
          aria-label={`延时关闭${device.name}`}
          onClick={() => (timerActive ? onClear(device.id) : setPickerOpen((open) => !open))}
        >
          <span className="timer-switch__thumb" />
        </button>
      </div>
      {timerActive ? (
        <div className="timer-block__row timer-block__meta">
          <span>剩余时间</span>
          <output>{formatRemaining(remaining)}</output>
        </div>
      ) : (
        <button type="button" className="timer-block__row timer-block__meta timer-block__link" disabled={!armed} onClick={() => setPickerOpen(true)}>
          <span>延迟时间</span>
          <span className="timer-block__value">{pickedLabel}</span>
          <ChevronRight size={15} />
        </button>
      )}
      {pickerOpen && !timerActive && armed && (
        <div className="timer-block__picker">
          <div className="timer-block__wheels">
            <Wheel values={hourValues} index={hour} onIndexChange={setHour} label="时" />
            <Wheel values={minuteValues} index={minute} onIndexChange={setMinute} label="分" />
          </div>
          <div className="timer-block__presets">
            {quickPresets.map(([label, seconds]) => (
              <button key={label} type="button" onClick={() => { onSet(device.id, seconds); setPickerOpen(false); }}>{label}</button>
            ))}
          </div>
          <button type="button" className="timer-block__start" disabled={pickedSeconds < 60} onClick={() => { onSet(device.id, pickedSeconds); setPickerOpen(false); }}>启动</button>
        </div>
      )}
    </section>
  );
}
