import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    appUrl: string
  }
}

export default async function setup(project: TestProject) {
  const appUrl = 'http://127.0.0.1:4176'
  const server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      '4176',
      '--strictPort',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let output = ''
  server.stdout.on('data', (chunk) => (output += chunk))
  server.stderr.on('data', (chunk) => (output += chunk))
  const stop = () => {
    if (server.exitCode !== null) return
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    else server.kill('SIGTERM')
  }
  try {
    for (let i = 0; i < 300; i++) {
      if (server.exitCode !== null)
        throw new Error(`Test app exited: ${output}`)
      try {
        if ((await fetch(appUrl, { signal: AbortSignal.timeout(2000) })).ok) {
          project.provide('appUrl', appUrl)
          return stop
        }
      } catch {}
      await delay(200)
    }
    throw new Error(`Test app did not start: ${output}`)
  } catch (error) {
    stop()
    throw error
  }
}
