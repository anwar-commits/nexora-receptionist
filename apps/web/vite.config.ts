import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the browser talks to /v1 on the same origin; Vite forwards it to the API.
    proxy: { '/v1': 'http://localhost:4000' },
  },
});
