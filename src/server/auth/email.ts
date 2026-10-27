import type { Platform } from '../platform'

export type AccountEmail = {
  to: string
  subject: string
  html: string
  text: string
  idempotencyKey: string
}

export function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

export async function sendAccountEmail(
  platform: Platform,
  input: AccountEmail,
): Promise<void> {
  const { env } = platform
  let url: string
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': input.idempotencyKey,
  }
  let body: unknown
  if (env.emailTransport === 'capture') {
    if (!env.dev || !isLoopback(env.authUrl) || !isLoopback(env.devMailUrl))
      throw new Error('Local email capture is unavailable')
    url = `${env.devMailUrl}/messages`
    body = input
  } else {
    if (env.emailTransport !== 'resend' || !env.resendApiKey || !env.resendFrom)
      throw new Error('Email delivery is not configured')
    url = 'https://api.resend.com/emails'
    headers = { ...headers, Authorization: `Bearer ${env.resendApiKey}` }
    body = {
      from: env.resendFrom,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }
  }
  const delivery = (async () => {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      throw new Error('Email delivery unavailable')
    }
    if (!response.ok)
      throw new Error(`Email delivery failed (${response.status})`)
    await response.body?.cancel()
  })()
  platform.waitUntil(delivery.catch(() => {}))
  await delivery
}
