import { useEffect, useRef, useState } from 'react';

/** 超过这个距离松手即切换（不显示文字提示，只有内容跟随手指的位移作为反馈）。 */
const THRESHOLD = 60;
/** 手指移动超过这个距离才认定为拖动，之前不产生位移。 */
const DEAD_ZONE = 8;
/** 判断“已在底部”的容差：iOS 回弹时滚动位置可能差几个像素。 */
const BOTTOM_TOLERANCE = 6;
/** 从这些元素上开始的手势不处理：输入控件、滑杆、弹窗、浮层、编辑中的卡片。 */
const IGNORE = 'input, textarea, select, [role="slider"], dialog, .light-palette, .weather-results, .tile--editing';

export interface SwipeTarget {
  key: string;
  label: string;
}

export interface SwipeHint {
  /** -1：下拉回到上一个；1：上滑进入下一个。 */
  direction: -1 | 1;
  label: string;
  progress: number;
  ready: boolean;
  /** 内容跟随手指的位移（px，已加阻尼）：下拉为正，上滑为负。 */
  offset: number;
}

interface Gesture {
  x: number;
  y: number;
  atTop: boolean;
  atBottom: boolean;
  active: boolean;
}

/**
 * 在右侧内容区上下滑动切换左侧导航：页面已在顶部时继续下拉进入上一个，已在底部时继续上滑进入下一个；
 * 内容不足一屏时两个方向都可以。未达到距离松手则不切换。
 */
export function usePageSwipe(enabled: boolean, previous: SwipeTarget | null, next: SwipeTarget | null, onNavigate: (key: string) => void): SwipeHint | null {
  const [hint, setHint] = useState<SwipeHint | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ enabled, previous, next, onNavigate, hint });
  latest.current = { enabled, previous, next, onNavigate, hint };

  useEffect(() => {
    const scroller = document.scrollingElement ?? document.documentElement;

    function start(event: TouchEvent) {
      gesture.current = null;
      const target = event.target as Element | null;
      if (!latest.current.enabled || event.touches.length !== 1 || !target?.closest('.hero, .main-content') || target.closest(IGNORE)) return;
      const touch = event.touches[0];
      gesture.current = {
        x: touch.clientX,
        y: touch.clientY,
        atTop: scroller.scrollTop <= 1,
        atBottom: scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - BOTTOM_TOLERANCE,
        active: true,
      };
    }

    function move(event: TouchEvent) {
      const current = gesture.current;
      if (!current?.active || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - current.x;
      const dy = touch.clientY - current.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DEAD_ZONE) {
        current.active = false;
        setHint(null);
        return;
      }
      const { previous: before, next: after } = latest.current;
      const direction: -1 | 1 = dy > 0 ? -1 : 1;
      const target = direction === -1 ? (current.atTop ? before : null) : (current.atBottom ? after : null);
      if (!target || Math.abs(dy) < DEAD_ZONE) {
        setHint(null);
        return;
      }
      const pull = Math.abs(dy) - DEAD_ZONE;
      const progress = Math.min(1, pull / THRESHOLD);
      // 跟随手指但有阻尼：越拉越“重”，最多约 70px。
      const offset = (70 * (1 - Math.exp(-pull / 160))) * (direction === -1 ? 1 : -1);
      setHint({ direction, label: target.label, progress, ready: progress >= 1, offset });
    }

    function end() {
      const { hint: shown, previous: before, next: after, onNavigate: navigate } = latest.current;
      if (gesture.current?.active && shown?.ready) {
        const target = shown.direction === -1 ? before : after;
        if (target) navigate(target.key);
      }
      gesture.current = null;
      setHint(null);
    }

    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
    };
  }, []);

  useEffect(() => { if (!enabled) setHint(null); }, [enabled]);

  return hint;
}
