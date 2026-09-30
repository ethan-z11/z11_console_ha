/**
 * 解析用户 HA 的 custom-brand-icons.js，提取 var icons = { ... } 对象，
 * 生成 src/icon-defs.json（纯数据）供 brandIcons.tsx 运行时加载。
 * 用法：node scripts/generate-brand-icons.cjs [input.js] [output.json]
 */
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || path.join(__dirname, '..', 'server', 'data', 'custom-brand-icons.js');
const outputPath = process.argv[3] || path.join(__dirname, '..', 'src', 'icon-defs.json');

const raw = fs.readFileSync(inputPath, 'utf-8');

// 用括号深度计数精确定位 var icons = { ... } 的对象边界。
const startMatch = raw.match(/var\s+icons\s*=\s*\{/);
if (!startMatch) {
  console.error('未找到 var icons = {...}');
  process.exit(1);
}
let depth = 0, inStr = false, strCh = '', esc = false, end = -1;
const start = startMatch.index + startMatch[0].length - 1; // 指向 '{'
for (let i = start; i < raw.length; i++) {
  const c = raw[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) {
    if (c === strCh) inStr = false;
    continue;
  }
  if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('未找到对象结束括号'); process.exit(1); }
const objText = raw.slice(start, end + 1);
// eslint-disable-next-line no-eval
const icons = eval('(' + objText + ')');

const defs = {};
let count = 0;
for (const [name, arr] of Object.entries(icons)) {
  if (!Array.isArray(arr) || arr.length < 5) continue;
  const [x, y, w, h, d] = arr;
  if (typeof d !== 'string' || !d) continue;
  defs[name] = [`${x} ${y} ${w} ${h}`, d];
  count++;
}

fs.writeFileSync(outputPath, JSON.stringify(defs), 'utf-8');
console.log(`已生成 ${count} 个图标到 ${outputPath}（${(fs.statSync(outputPath).size / 1024).toFixed(0)} KB）`);
