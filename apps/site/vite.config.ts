import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { renderReleaseHighlights } from './src/release-highlights.mjs';

const highlights = new URL('./src/release-highlights.json', import.meta.url);

export default defineConfig({
  plugins: [{
    name: 'release-highlights',
    transformIndexHtml(html, { path }) {
      if (path !== '/release-notes.html') return;
      return renderReleaseHighlights(html, JSON.parse(readFileSync(highlights, 'utf8')));
    },
  }],
  build: {
    rollupOptions: {
      input: ['index.html', 'release-notes.html'],
    },
  },
});
