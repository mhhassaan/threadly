import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' }, remoteBindings: false }),
    tanstackStart(),
    react(),
  ],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
