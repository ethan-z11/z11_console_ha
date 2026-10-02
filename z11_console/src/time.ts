import { useEffect, useState } from 'react';

/** 当前时间，每 15 秒刷新一次，供时钟和问候语使用。 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** 页头的一句话：按时段挑选，同一天同一时段固定不变（时钟每 15 秒刷新也不会跳）。 */
const greetingLines: { from: number; lines: string[]; weekend?: string[] }[] = [
  { from: 0, lines: ['夜深了，灯都想睡了', '星星值班，你去休息吧', '这么晚还没睡？记得关灯', '夜里安静，适合做个好梦'] },
  { from: 5, lines: ['早安，今天也要元气满满', '天亮了，先喝杯温水吧', '早上好，阳光正在路上', '新的一天，从伸个懒腰开始'], weekend: ['周末早晨，多睡一会儿也没关系', '周末愉快，今天慢慢来'] },
  { from: 9, lines: ['上午好，专心做点喜欢的事', '忙碌的上午，也别忘了喝水', '窗外天气怎么样？', '效率满满的上午'], weekend: ['周末上午，适合晒晒太阳', '今天不上班，家里就是度假村'] },
  { from: 11, lines: ['午饭想好吃什么了吗', '中午好，吃饱才有力气', '饭后小憩一下吧', '午间时光，放松一下'] },
  { from: 13, lines: ['下午好，来杯茶歇一歇', '犯困了吗？起来走两步', '午后时光，慢一点也很好', '下午也要记得喝水'], weekend: ['周末午后，懒洋洋刚刚好', '周末下午，约个朋友喝杯茶'] },
  { from: 18, lines: ['欢迎回家，今天辛苦了', '晚饭香不香？', '傍晚好，家里的灯为你亮着', '忙了一天，先歇口气'] },
  { from: 20, lines: ['晚上好，放松一下吧', '今晚适合看部电影', '洗个热水澡，早点休息', '夜色温柔，家里正好'], weekend: ['周末夜晚，晚睡一点也行', '周末夜晚，窝在沙发里刚刚好'] },
];

export function homeGreeting(date: Date): string {
  const hour = date.getHours();
  const slot = [...greetingLines].reverse().find((item) => hour >= item.from) ?? greetingLines[0];
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const lines = weekend && slot.weekend ? [...slot.weekend, ...slot.lines] : slot.lines;
  // 用日期和时段做种子，同一天同一时段结果相同，换时段或换天才变化。
  const seed = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${slot.from}`;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return lines[hash % lines.length];
}

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatDate(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
}

/** 日期拆成两个不可分割的片段：「10月3日」和「周六」各自必须整体换行，不能拆成单字。 */
export function formatDateParts(date: Date): { monthDay: string; weekday: string } {
  return { monthDay: `${date.getMonth() + 1}月${date.getDate()}日`, weekday: weekdays[date.getDay()] };
}

export function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
