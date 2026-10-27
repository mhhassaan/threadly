// Deliberately separate from the app: loopback only, ignored local output, no mail provider.
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.DEV_MAIL_PORT || 4187)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid capture port')
const directory = fileURLToPath(new URL('../work/dev-mail/', import.meta.url))
await mkdir(directory, { recursive: true })
const server = createServer(async (request, response) => {
  const respond = (status, body = {}) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }
  if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`)
    return respond(403)
  if (request.method === 'GET' && request.url === '/health')
    return respond(200, { ok: true })
  if (request.method !== 'POST' || request.url !== '/messages')
    return respond(404)
  if (request.headers['content-type'] !== 'application/json')
    return respond(415)
  try {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 65536) {
        respond(413)
        return
      }
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      !input ||
      ['to', 'subject', 'html', 'text', 'idempotencyKey'].some(
        (key) => typeof input[key] !== 'string' || !input[key],
      )
    )
      return respond(400)
    const id = randomUUID()
    await writeFile(
      resolve(directory, `${id}.json`),
      JSON.stringify(input, null, 2),
      { mode: 0o600, flag: 'wx' },
    )
    respond(201, { id })
  } catch {
    respond(400)
  }
})
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Local mail capture listening on 127.0.0.1:${port}; messages saved under ignored work/dev-mail`,
  ),
)
