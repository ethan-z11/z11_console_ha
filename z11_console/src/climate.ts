const hvacLabels: Record<string, string> = {
  heat: '制热',
  cool: '制冷',
  dry: '除湿',
  fan_only: '送风',
  auto: '自动',
  heat_cool: '自动冷热',
  off: '关闭',
  // water_heater 的 operation_list（热水器运行模式）。
  eco: '节能',
  electric: '电加热',
  gas: '燃气',
  heat_pump: '热泵',
  high_demand: '高需求',
  performance: '高效',
};

const fanLabels: Record<string, string> = {
  low: '低风',
  medium: '中风',
  high: '高风',
  auto: '自动风',
};

export function hvacModeLabel(mode: string): string {
  return hvacLabels[mode] ?? mode;
}

export function fanModeLabel(mode: string): string {
  return fanLabels[mode] ?? mode;
}

export function autoFirst(options: string[]): string[] {
  return options.includes('auto') ? ['auto', ...options.filter((option) => option !== 'auto')] : options;
}
