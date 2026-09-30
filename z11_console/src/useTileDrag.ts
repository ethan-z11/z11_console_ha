import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export type DragView = { id: string; overId: string | null; x: number; y: number };
type DragSession = DragView & { pointerId: number; startX: number; startY: number; scope: string; order: string[]; grid: Element | null };

/** 只在拖动开始时所在的网格里找落点，避免拖到其他分区。 */
function targetAt(grid: Element | null, x: number, y: number, sourceId: string): string | null {
  if (!grid) return null;
  return Array.from(grid.querySelectorAll<HTMLElement>('[data-tile-id]')).find((tile) => {
    if (tile.dataset.tileId === sourceId) return false;
    const rect = tile.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  })?.dataset.tileId ?? null;
}

/** 编辑布局时的指针拖动排序；scope 区分房间、常用设备或房间分组，松手落在另一项上时回调新的顺序。 */
export function useTileDrag(onReorder: (scope: string, order: string[]) => void) {
  const [view, setView] = useState<DragView | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const onReorderRef = useRef(onReorder);

  useEffect(() => { onReorderRef.current = onReorder; });

  useEffect(() => {
    function move(event: PointerEvent) {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (event.cancelable) event.preventDefault();
      session.overId = targetAt(session.grid, event.clientX, event.clientY, session.id);
      setView({ id: session.id, overId: session.overId, x: event.clientX - session.startX, y: event.clientY - session.startY });
    }

    function end(event: PointerEvent) {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const overId = event.type === 'pointerup' ? targetAt(session.grid, event.clientX, event.clientY, session.id) : null;
      if (overId) {
        const order = [...session.order];
        const source = order.indexOf(session.id);
        if (source >= 0) {
          order.splice(source, 1);
          const target = order.indexOf(overId);
          if (target >= 0) {
            const insertAt = source < session.order.indexOf(overId) ? target + 1 : target;
            order.splice(insertAt, 0, session.id);
            onReorderRef.current(session.scope, order);
          }
        }
      }
      sessionRef.current = null;
      setView(null);
    }

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  function start(id: string, scope: string, order: string[], event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const grid = event.currentTarget.closest('.adaptive-grid, [data-sort-list]');
    sessionRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, scope, order, grid, overId: null, x: 0, y: 0 };
    setView({ id, overId: null, x: 0, y: 0 });
  }

  function cancel() {
    sessionRef.current = null;
    setView(null);
  }

  return { view, start, cancel };
}
