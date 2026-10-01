/**
 * HAOS Ingress「沉浸模式」：隐藏 Home Assistant 自身的侧边栏与顶栏，让控制台铺满整个浏览区域。
 *
 * 思路：我们的 UI 全部在 Ingress iframe 内部，父页面 DOM 里的任何 header / 侧边栏都属于 HA，
 * 因此直接递归遍历父页面所有 ShadowRoot，把 header 类元素整体 display:none（含 HA 不同版本、
 * 桌面/移动端结构差异，不依赖具体选择器路径），同时在每层注入布局变量、把 Ingress iframe
 * 拉满高度回收占位（ha-panel-iframe 在自身 :host 上定义了 --header-height，只注入上层会被覆盖，
 * header 隐藏后 iframe 高度收不回来，底部留下黑边）。
 * HA 重渲染可能重建元素，开启时用轮询兜底重新隐藏。
 */
const STORE_KEY = 'z11-kiosk';
const STYLE_ID = 'z11-kiosk';

/** 仅在 HA Ingress 子路径下可用。 */
export const isIngress = location.pathname.startsWith('/api/hassio_ingress/');

/** HA 自身的顶栏 / 工具栏 / 侧边栏（iframe 内部内容不受 parent DOM 遍历影响，不会误伤我们的页面）。 */
const CHROME_SELECTOR = 'header, .header, .toolbar, ha-top-app-bar-fixed, mwc-top-app-bar-fixed, app-toolbar, ha-sidebar';

/** 回收顶栏 / 侧边栏占位的布局变量：ShadowRoot 内用 :host，文档根用 :root。 */
const HOST_CSS = `:host { --header-height: 0px !important; --mdc-drawer-width: 0px !important; }`;
const ROOT_CSS = `:root { --header-height: 0px !important; --mdc-drawer-width: 0px !important; }`;

/** 已被我们隐藏的元素（记录原 display 以便恢复）。 */
const hidden = new Map<HTMLElement, string>();

/** 被我们强制拉满高度的 Ingress iframe（关闭时恢复原样）。 */
const stretched: HTMLIFrameElement[] = [];

function* walkRoots(root: Document | ShadowRoot): Generator<Document | ShadowRoot> {
  yield root;
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) yield* walkRoots(el.shadowRoot);
  }
}

function ensureStyle(root: Document | ShadowRoot): void {
  if (root.getElementById(STYLE_ID)) return;
  const style = parent.document.createElement('style');
  style.id = STYLE_ID;
  if ((root as ShadowRoot).host) {
    style.textContent = HOST_CSS;
    root.appendChild(style);
  } else {
    style.textContent = ROOT_CSS;
    parent.document.head.appendChild(style);
  }
}

function hideChrome(): void {
  for (const root of walkRoots(parent.document)) {
    ensureStyle(root);
    for (const el of root.querySelectorAll<HTMLElement>(CHROME_SELECTOR)) {
      if (hidden.has(el)) continue;
      hidden.set(el, el.style.display);
      el.style.setProperty('display', 'none', 'important');
    }
    // 承载本页面的 Ingress iframe 拉满整个面板（header 隐藏后回收其高度）。
    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
      if (!frame.src.includes('/api/hassio_ingress/')) continue;
      frame.style.setProperty('height', '100%', 'important');
      frame.style.setProperty('top', '0', 'important');
      if (!stretched.includes(frame)) stretched.push(frame);
    }
  }
}

function showChrome(): void {
  for (const [el, prev] of hidden) el.style.display = prev;
  hidden.clear();
  for (const frame of stretched) {
    frame.style.removeProperty('height');
    frame.style.removeProperty('top');
  }
  stretched.length = 0;
  for (const root of walkRoots(parent.document)) root.getElementById(STYLE_ID)?.remove();
}

function apply(on: boolean): void {
  try {
    // 给我们自己的页面打标记，CSS 据此去掉底部导航的 iPhone 手势条留白。
    document.documentElement.classList.toggle('z11-kiosk', on);
    if (on) hideChrome(); else showChrome();
    parent.dispatchEvent(new Event('resize'));
  } catch {
    /* HA 结构变化或非同源时静默失败 */
  }
}

let timer: number | undefined;

/** 切换沉浸模式并持久化；开启时定时校验（HA 重渲染后自动补隐藏）。 */
export function setKiosk(on: boolean): void {
  localStorage.setItem(STORE_KEY, on ? '1' : '0');
  apply(on);
  window.clearInterval(timer);
  if (on) timer = window.setInterval(() => apply(true), 3000);
}

/** 页面加载时按上次状态恢复。 */
export function restoreKiosk(): void {
  if (isIngress && kioskOn()) setKiosk(true);
}

export function kioskOn(): boolean {
  return isIngress && localStorage.getItem(STORE_KEY) === '1';
}
