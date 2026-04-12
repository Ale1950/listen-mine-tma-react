import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Mirrors the official miner-react example from gosh-sh/bee-engine
// with GitHub Pages base path added.
export default defineConfig({
  plugins: [react()],
  base: '/listen-mine-tma-react/',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  // bee-sdk ships its WASM as bee_sdk_bg.wasm — we serve it from public/
  // and load it via init({ module_or_path: `${import.meta.env.BASE_URL}bee_sdk_bg.wasm` })
  // in services/bee-sdk.ts (so base path is always in sync with this config).
});
