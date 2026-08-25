import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy /api to the daemon so the UI can call it same-origin.
//
// The target is overridable because 7777 is where a *real* Hypergate runs: to
// develop or capture screenshots against a throwaway daemon (its own port, its
// own HYPERGATE_DIR) you have to be able to point the UI somewhere else without
// editing this file.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.HYPERGATE_DEV_PORT ?? 5180),
    proxy: { '/api': process.env.HYPERGATE_DEV_API ?? 'http://localhost:7777' },
  },
});
