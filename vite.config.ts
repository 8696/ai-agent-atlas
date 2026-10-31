import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  preview: {
    // ⚠️ **preview 也要代理** —— `vite preview` 不吃 `server.proxy`，
    //    e2e 跑的是 preview 产物（见 `playwright.config.ts`），
    //    不代理的话前端调不到后端的 `/api/*`
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist-web',
    sourcemap: true,
  },
});
