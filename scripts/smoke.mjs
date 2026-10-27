import assert from 'node:assert/strict'
import { startPreview, stopPreview } from './preview.mjs'
import { setTimeout as delay } from 'node:timers/promises'
const port = 4185
const server = startPreview(port, { stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
server.stdout.on('data', (chunk) => (output += chunk))
server.stderr.on('data', (chunk) => (output += chunk))
const base = `http://127.0.0.1:${port}`
try {
  let started = false
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) throw Error('Preview exited: ' + output)
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        started = true
        break
      }
    } catch {}
    await delay(100)
  }
  assert(started, 'Production preview starts')
  const home = await fetch(base, { signal: AbortSignal.timeout(2000) })
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
  for (const [path, method] of [
    ['/api/library', 'GET'],
    ['/api/library', 'POST'],
    ['/api/threads/00000000-0000-4000-8000-000000000001', 'GET'],
    ['/api/threads/00000000-0000-4000-8000-000000000001', 'PATCH'],
    ['/api/threads/00000000-0000-4000-8000-000000000001', 'DELETE'],
    ['/api/comments', 'POST'],
  ]) {
    const response = await fetch(base + path, { method })
    // Local production preview intentionally has no production email credentials.
    assert(
      [401, 503].includes(response.status),
      `${method} ${path} fails closed`,
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  }
  console.log(
    'Passed: production SSR, reader routing, bundled assets, static fonts/brand, API address rejection, private API authentication and not-found handling.',
  )
} finally {
  await stopPreview(server)
}
