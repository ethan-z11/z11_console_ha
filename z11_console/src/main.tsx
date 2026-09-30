import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyAccent, applyTheme, cachedAccent, cachedTheme } from './theme';

// 连接控制台服务之前先用上次的主题和强调色，避免首帧闪成默认配色。
applyTheme(cachedTheme());
applyAccent(cachedAccent());

// 离线缓存与安装为应用：Service Worker 只能在 HTTPS 或本机地址下注册，HTTP 局域网地址下跳过；HAOS Ingress 子路径下不注册（没有意义且作用域受限）。
const underIngress = location.pathname.startsWith('/api/hassio_ingress/');
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD && !underIngress) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
