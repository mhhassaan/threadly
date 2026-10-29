// Run the built Cloudflare Worker and its generated asset/binding configuration locally.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function startPreview(
  port = 4173,
  { stdio = 'inherit', inspectorPort = 0, workerEntry } = {},
) {
  return spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      ...(workerEntry ? [workerEntry, '--bundle'] : []),
      '--config',
      'dist/server/wrangler.json',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
    ],
    {
      stdio,
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  )
}

export async function stopPreview(child) {
  if (child.exitCode !== null || !child.pid) return
  const exited = once(child, 'exit')
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else child.kill('SIGTERM')
  await exited
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const child = startPreview(Number(process.env.PORT || 4173))
  child.on('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => void stopPreview(child))
}
