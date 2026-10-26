import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
const port = 4185
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
let output = ''
server.stdout.on('data', (chunk) => (output += chunk))
server.stderr.on('data', (chunk) => (output += chunk))
const base = `http://127.0.0.1:${port}`
try {
  let started = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error('Preview exited: ' + output)
    try {
      const response = await fetch(base)
      if (response.ok) {
        started = true
        break
      }
    } catch {}
    await delay(100)
  }
  assert(started, 'Production preview starts')
  const home = await fetch(base)
  assert.equal(home.status, 200)
  const html = await home.text()
  assert(
    html.includes('Create my thread'),
    'React dashboard is server-rendered',
  )
  assert(html.includes('/assets/'), 'Bundled client assets are referenced')
  const reader = await fetch(base + '/?reader=smoke-test&motion=none')
  assert(
    (await reader.text()).includes('Getting your thread ready'),
    'Validated reader search renders the reader route',
  )
  for (const path of [
    '/appearance.js',
    '/brand/threadly-mark.svg',
    '/fonts/chirp-regular.woff',
  ])
    assert.equal((await fetch(base + path)).status, 200, path)
  assert.equal(
    (
      await fetch(base + '/api/article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
      })
    ).status,
    400,
  )
  assert.equal(
    (await fetch(base + '/api/media?url=http%3A%2F%2F127.0.0.1%2Fprivate'))
      .status,
    404,
  )
  assert.equal((await fetch(base + '/not-a-route')).status, 404)
  console.log(
    'Passed: production SSR, reader routing, bundled assets, static fonts/brand, API address rejection and not-found handling.',
  )
} finally {
  if (server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
}
