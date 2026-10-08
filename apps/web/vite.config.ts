import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DEV_WEB_PORT ?? 5173),
    strictPort: true,
    watch: { ignored: ['**/test-results/**', '**/ui-test-results/**', '**/playwright-report/**'] },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 3000}`,
        changeOrigin: false,
      },
    },
  },
});
