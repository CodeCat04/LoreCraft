import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: 'es2022',
    // Otherwise CSS is rewritten for older browsers, and right-to-left rules such as `:dir()`
    // become guesses from language codes. The web views here are all newer than these.
    cssTarget: ['chrome120', 'safari16.4'],
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // print.html is the hidden window PDFs are laid out in. See src-tauri/src/rpc/print.rs.
      input: { main: 'index.html', print: 'print.html' },
    },
  },
  // Module workers, so exporters can load their heavy libraries only when used.
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Otherwise CSS reads as empty in tests, and the exported site's styles are content.
    css: { include: [/exporters\/wiki\/site\.css/] },
  },
});
