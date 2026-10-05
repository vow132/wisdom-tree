import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(['/api', '/v1', '/responses', '/health'].map(path => [path, { target: 'http://127.0.0.1:3000', changeOrigin: false }])),
  },
});
