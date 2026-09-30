let lastInputWasPointer = false;

window.addEventListener('pointerdown', () => {
  lastInputWasPointer = true;
  // 鼠标 / 触屏操作时不显示任何焦点框（样式见 styles.css 的 html:not(.keyboard-nav)）。
  document.documentElement.classList.remove('keyboard-nav');
}, true);
window.addEventListener('keydown', (event) => {
  lastInputWasPointer = false;
  // 只有用 Tab 在控件之间移动时才显示焦点框；Esc 关闭弹窗等不算。
  if (event.key === 'Tab') document.documentElement.classList.add('keyboard-nav');
}, true);

/** 打开模态弹窗；用鼠标/触屏打开时不让右上角关闭按钮显示键盘焦点框。 */
export function openModalQuietly(dialog: HTMLDialogElement): void {
  dialog.showModal();
  // showModal 会自动聚焦第一个按钮（通常是右上角关闭），并显示键盘焦点框；用鼠标/触屏打开时改为聚焦弹窗本身。
  if (lastInputWasPointer) {
    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }
}

/**
 * 弹窗关闭时浏览器会把焦点还给触发按钮，并按键盘焦点画出焦点框。
 * 用鼠标/触屏关闭时去掉这个焦点，避免卡片上残留方框；键盘操作仍保留焦点位置。
 */
export function releasePointerFocus(): void {
  if (lastInputWasPointer && document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
