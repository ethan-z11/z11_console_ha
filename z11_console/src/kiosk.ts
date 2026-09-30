/**
 * HAOS Ingress「沉浸模式」：隐藏 Home Assistant 自身的侧边栏与顶栏，让控制台铺满整个浏览区域。
 * Ingress iframe 与 HA 前端同源，可直接向父页面 home-assistant-main 的 ShadowRoot 注入样式。
 * HA 重新渲染后 ShadowRoot 里的 style 可能被清掉，用轮询兜底重新注入。
 */
const STYLE_ID = 'z11-kiosk';
const STORE_KEY = 'z11-kiosk';

/** 仅在 HA Ingress 子路径下可用。 */
export const isIngress = location.pathname.startsWith('/api/hassio_ingress/');

const CSS = `
.header { display: none !important; }
ha-sidebar { display: none !important; }
:host { --header-height: 0px !important; --mdc-drawer-width: 0px !important; }
`;

function mainShadowRoot(): ShadowRoot | null {
  try {
    const ha = parent.document.querySelector('home-assistant');
    return (ha?.shadowRoot?.querySelector('home-assistant-main') as Element | undefined)?.shadowRoot ?? null;
  } catch {
    return null;
  }
}

function apply(on: boolean): void {
  try {
    const root = mainShadowRoot();
    if (!root) return;
    const style = root.getElementById(STYLE_ID);
    if (on && !style) {
      const el = parent.document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      root.appendChild(el);
    } else if (!on && style) {
      style.remove();
    }
    parent.dispatchEvent(new Event('resize'));
  } catch {
    /* HA 结构变化或非同源时静默失败 */
  }
}

let timer: number | undefined;

/** 切换沉浸模式并持久化；开启时定时校验注入是否还在。 */
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
