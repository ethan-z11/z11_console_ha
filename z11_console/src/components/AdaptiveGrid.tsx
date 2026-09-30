import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

interface AdaptiveGridProps {
  children: ReactNode;
  className?: string;
  /** 格子缩放（设置 → 显示，0.8–1.2）：格子与间距按比例缩放，卡片内容由 .tile 的 scale 同步缩放。 */
  scale?: number;
}

// 100% 时的格子与间距：原 168px 格子按 87% 定为新基准，卡片内文字保持正常大小。
const baseGap = 10;
const baseCellSize = 146;

export function AdaptiveGrid({ children, className = '', scale = 1 }: AdaptiveGridProps) {
  const gap = baseGap * scale;
  const cellSize = baseCellSize * scale;
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const measure = () => setWidth(grid.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    measure();
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + gap) / (cellSize + gap)));
  const style = {
    '--grid-columns': columns,
    '--cell-size': `${cellSize}px`,
    '--grid-gap': `${gap}px`,
    '--tile-scale': scale,
  } as CSSProperties;

  return <div ref={gridRef} className={`adaptive-grid ${className}`.trim()} data-columns={columns} style={style}>{children}</div>;
}
