import { GripVertical, Maximize2, Minimize2, Star } from 'lucide-react';
import { useRef } from 'react';
import type { CSSProperties, PointerEvent, ReactNode, Ref } from 'react';
import { tileSizes } from '../layout';
import type { TileSize } from '../types';

/** 网格与编辑布局相关的卡片属性，由各设备卡原样转给 TileFrame。 */
export interface TileLayoutProps {
  id: string;
  label: string;
  size: TileSize;
  allowedSizes?: TileSize[];
  editing?: boolean;
  index?: number;
  total?: number;
  onSizeChange?: (id: string, size: TileSize) => void;
  onMove?: (id: string, direction: -1 | 1) => void;
  onDragStart?: (id: string, event: PointerEvent<HTMLElement>) => void;
  dragging?: boolean;
  dropTarget?: boolean;
  dragOffset?: { x: number; y: number };
  /** 编辑时显示星标按钮；favorite 表示已在全屋“常用设备”中。 */
  favorite?: boolean;
  onFavoriteToggle?: (id: string) => void;
}

interface TileFrameProps extends TileLayoutProps {
  className?: string;
  style?: CSSProperties;
  active?: boolean;
  /** 有二级弹窗的卡片：点卡片上按钮、滑杆、输入框以外的任意位置即打开（编辑布局时不响应）。 */
  onOpen?: () => void;
  /** HomeKit 风格卡片：长按 500ms 弹出设置（替代卡上的齿轮按钮）；编辑布局时不响应。 */
  onLongPress?: () => void;
  /** HomeKit 卡片比例（本机开关）：小卡约 2.4:1 宽扁、大卡同宽两倍高，由网格与卡片配合使用。 */
  hkTiles?: boolean;
  /** 需要直接拿到卡片 DOM 的场景（如可见性观察）。 */
  frameRef?: Ref<HTMLElement>;
  children: ReactNode;
}

/** 这些元素自己处理点击，不触发卡片的 onOpen；按钮的触摸范围另外向外扩大，按钮附近都算按钮。 */
const ownClickTargets = 'button, input, select, textarea, a, [role="slider"]';

export function TileFrame({ id, label, size, className = '', style, active, editing, index = 0, total = 1, allowedSizes = tileSizes, onSizeChange, onMove, onDragStart, dragging, dropTarget, dragOffset, favorite, onFavoriteToggle, onOpen, onLongPress, hkTiles, frameRef, children }: TileFrameProps) {
  const nextSize = onSizeChange && allowedSizes.find((option) => option !== size);
  const dragStyle = dragging && dragOffset ? { ...style, translate: `${dragOffset.x}px ${dragOffset.y}px` } as CSSProperties : style;
  // 长按弹设置：按下 500ms 触发；期间移动、抬起、取消都作废；触发后吞掉紧随的 click，避免又执行开/关。
  const pressTimer = useRef(0);
  const longPressFired = useRef(false);
  function clearPress() {
    if (pressTimer.current) { window.clearTimeout(pressTimer.current); pressTimer.current = 0; }
  }

  return (
    <article ref={frameRef} className={`tile tile--${size}${active ? ' tile--active' : ''}${editing ? ' tile--editing' : ''}${dragging ? ' tile--dragging' : ''}${dropTarget ? ' tile--drop-target' : ''}${onOpen && !editing ? ' tile--openable' : ''}${hkTiles ? ' tile--hk' : ''}${className ? ` ${className}` : ''}`} data-size={size} data-tile-id={id} style={dragStyle} onPointerDown={(event) => {
      const onOwnControl = event.target instanceof Element && event.target.closest('.tile__drag-handle, .tile__size-toggle, .tile__favorite');
      if (!editing || event.pointerType !== 'mouse' || onOwnControl) return;
      onDragStart?.(id, event);
    }} onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={clearPress} onContextMenu={(event) => {
      if (onLongPress && !editing) event.preventDefault();
    }} onClick={(event) => {
      // 弹窗经 portal 渲染在 body 下，React 事件仍会冒泡到卡片：只处理真正点在卡片 DOM 内的点击。
      if (longPressFired.current) { longPressFired.current = false; return; }
      if (!onOpen || editing || !(event.target instanceof Element) || !event.currentTarget.contains(event.target) || event.target.closest(ownClickTargets)) return;
      onOpen();
    }} onPointerDownCapture={(event) => {
      if (!onLongPress || editing) return;
      if (event.target instanceof Element && event.target.closest(ownClickTargets)) return;
      longPressFired.current = false;
      clearPress();
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = 0;
        longPressFired.current = true;
        onLongPress();
      }, 500);
    }}>
      {children}
      {editing && (
        <>
          <button type="button" className="tile__drag-handle" onPointerDown={(event) => onDragStart?.(id, event)} onKeyDown={(event) => {
            const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0;
            if (!direction || index + direction < 0 || index + direction >= total) return;
            event.preventDefault();
            onMove?.(id, direction);
          }} aria-label={`拖动${label}调整位置，方向键也可移动`} title="拖动调整位置"><GripVertical size={18} /></button>
          {onFavoriteToggle && <button type="button" className={`tile__favorite${favorite ? ' tile__favorite--on' : ''}`} onClick={() => onFavoriteToggle(id)} aria-pressed={Boolean(favorite)} aria-label={favorite ? `将${label}移出常用设备` : `将${label}加入常用设备`} title={favorite ? '移出常用' : '加入常用'}>
            <Star size={17} fill={favorite ? 'currentColor' : 'none'} />
          </button>}
          {nextSize && <button type="button" className="tile__size-toggle" onClick={() => onSizeChange(id, nextSize)} aria-label={`将${label}改为${nextSize.replace('x', '×')}`} title={`切换为 ${nextSize.replace('x', '×')}`}>
            {size === '1x1' ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
          </button>}
        </>
      )}
    </article>
  );
}
