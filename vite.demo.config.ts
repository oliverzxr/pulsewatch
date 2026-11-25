import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  publicDir: '../public',
  base: './',
  appType: 'mpa',
  plugins: [react()],
  build: { outDir: '../dist/demo', emptyOutDir: true, assetsInlineLimit: 0 },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
