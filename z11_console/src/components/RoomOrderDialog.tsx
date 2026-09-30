import { ChevronDown, ChevronUp, GripVertical, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { roomIcon } from '../appearance';
import { releasePointerFocus } from '../focus';
import type { Room } from '../types';
import { useTileDrag } from '../useTileDrag';

interface RoomOrderDialogProps {
  open: boolean;
  /** 当前（已排序的）房间列表。 */
  rooms: Room[];
  /** 新的完整房间顺序；空数组表示恢复默认顺序。 */
  onChange: (ids: string[]) => void;
  onClose: () => void;
}

const groupLabels: Record<Room['category'], string> = { main: '房间', other: '其他空间' };

/** 调整导航中的房间顺序：分组内拖动把手或点上移 / 下移，改动立即生效并保存为全家共用布局。 */
export function RoomOrderDialog({ open, rooms, onChange, onClose }: RoomOrderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const groups = (['main', 'other'] as const)
    .map((category) => ({ category, rooms: rooms.filter((room) => room.category === category) }))
    .filter((group) => group.rooms.length > 0);
  const drag = useTileDrag((scope, order) => replaceGroup(scope as Room['category'], order));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) { drag.cancel(); dialog.close(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在开关弹窗时同步 <dialog> 状态
  }, [open]);

  /** 用某个分组的新顺序替换，其余分组保持不变；分组按房间在前、其他空间在后拼成完整顺序。 */
  function replaceGroup(category: Room['category'], order: string[]) {
    onChange(groups.flatMap((group) => group.category === category ? order : group.rooms.map((room) => room.id)));
  }

  function move(category: Room['category'], ids: string[], index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= ids.length) return;
    const order = [...ids];
    [order[index], order[next]] = [order[next], order[index]];
    replaceGroup(category, order);
  }

  return (
    <dialog ref={dialogRef} className="device-dialog room-order-dialog" aria-labelledby="room-order-title" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose}>
      {open && <>
        <div className="device-dialog__heading">
          <div><small>导航</small><h2 id="room-order-title">房间排序</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭房间排序"><X size={20} /></button>
        </div>
        <div className="room-order">
          {groups.map((group) => {
            const ids = group.rooms.map((room) => room.id);
            return (
              <section key={group.category} className="room-order__group" aria-label={groupLabels[group.category]}>
                {groups.length > 1 && <h3>{groupLabels[group.category]}</h3>}
                <ol className="room-order__list" data-sort-list>
                  {group.rooms.map((room, index) => {
                    const Icon = roomIcon(room);
                    const dragging = drag.view?.id === room.id;
                    const style = dragging ? { transform: `translate3d(${drag.view!.x}px, ${drag.view!.y}px, 0)` } as CSSProperties : undefined;
                    return (
                      <li key={room.id} data-tile-id={room.id} style={style} className={`room-order__item${dragging ? ' room-order__item--dragging' : ''}${drag.view?.overId === room.id ? ' room-order__item--drop-target' : ''}`}>
                        <button type="button" className="room-order__handle" onPointerDown={(event) => drag.start(room.id, group.category, ids, event)} onKeyDown={(event) => {
                          const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                          if (!direction) return;
                          event.preventDefault();
                          move(group.category, ids, index, direction);
                        }} aria-label={`拖动${room.name}调整顺序，上下方向键也可移动`} title="拖动调整顺序"><GripVertical size={18} /></button>
                        <Icon size={18} />
                        <span>{room.name}</span>
                        <button type="button" onClick={() => move(group.category, ids, index, -1)} disabled={index === 0} aria-label={`上移${room.name}`} title="上移"><ChevronUp size={18} /></button>
                        <button type="button" onClick={() => move(group.category, ids, index, 1)} disabled={index === ids.length - 1} aria-label={`下移${room.name}`} title="下移"><ChevronDown size={18} /></button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
        <div className="room-order__footer">
          <button type="button" className="text-button" onClick={() => onChange([])}><RotateCcw size={15} />恢复默认</button>
          <button type="button" className="small-button small-button--selected" onClick={onClose}>完成</button>
        </div>
      </>}
    </dialog>
  );
}
