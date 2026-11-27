import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: ['index.html', 'release-notes.html', 'privacy/index.html', 'terms/index.html'],
    },
  },
});
