// Compatibility entry point for older local workflows.
import { spawn } from 'node:child_process'
const child = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'build'],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
