import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const target = `http://127.0.0.1:${process.env.PORT || env.PORT || 3456}`;
  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      port: 5173,
      // Generated subscription URLs must retain the address used by the client.
      proxy: {
        '/api': {
          target,
          changeOrigin: false,
        },
        '^/s/': {
          target,
          changeOrigin: false,
        },
      },
    },
  };
});
