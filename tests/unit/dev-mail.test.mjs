import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { request as httpRequest } from 'node:http'

test('mail capture binds loopback, rejects browser origins and writes only ignored local files', async () => {
  const port = 4192
  const child = spawn(process.execPath, ['scripts/dev-mail.mjs'], {
    env: { ...process.env, DEV_MAIL_PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (part) => (logs += part))
  child.stderr.on('data', (part) => (logs += part))
  try {
    const base = `http://127.0.0.1:${port}`
    let ready = false
    let health = ''
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) throw new Error(`Capture exited: ${logs}`)
      try {
        const r = await fetch(`${base}/health`)
        health = `${r.status}: ${await r.text()}`
        if (r.ok) {
          ready = true
          break
        }
      } catch (error) {
        health = String(error)
      }
      await delay(100)
    }
    assert(ready, `loopback service starts: ${logs}; ${health}`)
    const message = {
      to: 'capture@example.invalid',
      subject: 'Test',
      html: '<p>Local only</p>',
      text: 'Local only',
      idempotencyKey: crypto.randomUUID(),
    }
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    }
    assert.equal(
      (
        await fetch(`${base}/messages`, {
          ...options,
          headers: {
            ...options.headers,
            origin: 'https://external.example.invalid',
          },
        })
      ).status,
      403,
    )
    assert.equal((await fetch(`${base}/messages`)).status, 404)
    const hostileHost = await new Promise((done, reject) => {
      const req = httpRequest(
        `${base}/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            host: 'external.example.invalid',
          },
        },
        (res) => {
          res.resume()
          done(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end(options.body)
    })
    assert.equal(hostileHost, 403)
    const response = await fetch(`${base}/messages`, options)
    assert.equal(response.status, 201)
    const { id } = await response.json()
    assert.match(id, /^[0-9a-f-]+$/)
    const directory = resolve('work/dev-mail')
    assert((await readdir(directory)).includes(`${id}.json`))
    assert.deepEqual(
      JSON.parse(await readFile(resolve(directory, `${id}.json`), 'utf8')),
      message,
    )
    assert(!logs.includes(message.to), 'no recipient or payload in stdout')
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await new Promise((done) => child.once('exit', done))
    }
  }
})
