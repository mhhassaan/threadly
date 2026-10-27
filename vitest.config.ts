import { cloudflareTest } from '@cloudflare/vitest-plugin'
import {
  unstable_getMiniflareWorkerOptions,
  unstable_readConfig,
} from 'wrangler'
import { defineConfig } from 'vitest/config'

// Reuse the app's actual binding/compatibility configuration without its Vite-only entry.
// Guest routes run in the real Vite Workers server started by globalSetup.
const config = unstable_readConfig({ config: './wrangler.jsonc' })
const { workerOptions } = unstable_getMiniflareWorkerOptions(config)

export default defineConfig({
  plugins: [
    cloudflareTest({ remoteBindings: false, miniflare: workerOptions }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    globalSetup: ['tests/worker/setup.ts'],
    testTimeout: 30000,
  },
})
