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

/**
 * 单排网格：所有卡片强制排成一行（主页「摄像头 + 常用设备」同排版面用），按容器宽度整体缩放——
 * 卡片仍按 146px 基准排版，再统一 scale 到可用宽度，列跨度（spans：1 或 2）与间隔一起缩放，永不换行。
 */
export function SingleRowGrid({ children, spans, className = '' }: { children: ReactNode; spans: number[]; className?: string }) {
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

  const units = spans.reduce((sum, span) => sum + (span === 2 ? 2 : 1), 0);
  const natural = units * baseCellSize + (spans.length - 1) * baseGap;
  // 上限 1.5：常用设备很少时不至于放大得离谱。
  const scale = width > 0 && natural > 0 ? Math.min(1.5, width / natural) : 1;
  const style = {
    '--grid-columns': units,
    '--cell-size': `${baseCellSize * scale}px`,
    '--grid-gap': `${baseGap * scale}px`,
    '--tile-scale': scale,
  } as CSSProperties;

  return <div ref={gridRef} className={`adaptive-grid adaptive-grid--single-row ${className}`.trim()} data-columns={units > 1 ? 2 : 1} style={style}>{children}</div>;
}
