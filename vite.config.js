import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' assert { type: 'json' };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
        // Detached recording-control window (level meters + pause/stop
        // + duration). Opened by the SW via chrome.windows.create; a
        // rollup input so its module script is bundled/rewritten.
        control: 'src/control/control.html',
        // Mic-permission page loaded as an <iframe> by the content
        // script (MV3 offscreen/popup can't prompt for mic). Must be a
        // rollup input or its module script isn't bundled/rewritten.
        permissionMic: 'src/permission/mic.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
});
