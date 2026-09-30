/**
 * 用户 HA 里的 phu 自定义品牌图标（custom-brand-icons.js）全集，
 * 由 scripts/generate-brand-icons.cjs 从原图标集解析为 icon-defs.json（纯数据），
 * 运行时加载并转成内联 SVG 组件；实心填充风格，与 lucide 线性图标混用。
 * 键名保持原图标集命名，方便对照增补；shutter-0..100 为卷帘开合度档位（0 全关 - 100 全开）。
 */
// icon-defs.json 由构建脚本生成，体积较大，按 Record 类型断言加载避免逐字段推导。
import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import defsData from './icon-defs.json';

const defs = defsData as unknown as Record<string, [viewBox: string, d: string]>;

function makeBrandIcon(viewBox: string, d: string): LucideIcon {
  return forwardRef<SVGSVGElement, LucideProps>(function BrandIcon({ size = 24, className, style, ...rest }, ref) {
    return (
      <svg ref={ref} viewBox={viewBox} width={size} height={size} fill="currentColor" stroke="none" className={className} style={style} aria-hidden="true" {...rest}>
        <path d={d} />
      </svg>
    );
  });
}

/** 按原图标集键名取用，如 brandIcons['ceiling-fan']。 */
export const brandIcons: Record<string, LucideIcon> = Object.fromEntries(
  Object.entries(defs).map(([key, [viewBox, d]]) => [key, makeBrandIcon(viewBox, d)]),
) as Record<string, LucideIcon>;

/** 全部 phu 图标键名列表（供图标选择器生成选项）。 */
export const brandIconKeys: string[] = Object.keys(defs);

/** 扫地机器人俯视图图标（lucide 0.468 尚无 vacuum 图标，自制线描款与其他设备图标风格一致）。 */
export const VacuumDeviceIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(function VacuumDeviceIcon({ size = 24, className, style, ...rest }, ref) {
  return (
    <svg ref={ref} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true" {...rest}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="8.2" cy="8.6" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15.8" cy="8.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
});
