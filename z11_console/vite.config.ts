import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api（含 WebSocket）转发给 Python 控制台服务，页面与接口同源，管理会话 Cookie 才能生效。
const consoleServer = { target: 'http://127.0.0.1:8765', ws: true, xfwd: true };

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 53113, strictPort: true, proxy: { '/api': consoleServer } },
  preview: { host: '127.0.0.1', port: 53114, strictPort: true, proxy: { '/api': consoleServer } },
});
