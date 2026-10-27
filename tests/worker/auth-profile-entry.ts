import { hashPassword, verifyPassword } from 'better-auth/crypto'

// Profiling-only Worker. Never registered in app routes or deployed configuration.
let fixture: { password: string; hash: string } | undefined
export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname
    if (path === '/health') return Response.json({ ok: true })
    if (path === '/hash') {
      await hashPassword(crypto.randomUUID() + crypto.randomUUID())
      return Response.json({ ok: true })
    }
    if (path === '/verify') {
      if (!fixture) {
        const password = crypto.randomUUID() + crypto.randomUUID()
        fixture = { password, hash: await hashPassword(password) }
      }
      return Response.json({ ok: await verifyPassword(fixture) })
    }
    return new Response(null, { status: 404 })
  },
}
