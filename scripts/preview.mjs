// Preview the production TanStack build on the established local port.
import { spawn } from 'node:child_process'
const child = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
  ],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
