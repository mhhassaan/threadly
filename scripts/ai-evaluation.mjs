import { pathToFileURL, fileURLToPath } from 'node:url'

// Public synthetic fixtures only. No application data, email or database access.
let production
async function loadProductionFixtures() {
  if (!production)
    production = (async () => {
      // Reuse the installed TS module runner without app plugins, D1 or a listener.
      const { createServer } = await import('vite')
      const server = await createServer({
        root: fileURLToPath(new URL('..', import.meta.url)),
        configFile: false,
        envDir: false,
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      })
      try {
        return await server.ssrLoadModule('/tests/fixtures/ai-evaluation.ts')
      } finally {
        await server.close()
      }
    })()
  return production
}

export async function evaluate({
  live = false,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  requestCap = 8,
  spendCapMicros = 100_000,
  worstCaseCostMicros,
} = {}) {
  if (
    !Number.isSafeInteger(requestCap) ||
    requestCap < 1 ||
    requestCap > 8 ||
    !Number.isSafeInteger(spendCapMicros) ||
    spendCapMicros < 1 ||
    spendCapMicros > 100_000
  )
    throw Error(
      'Evaluation cap is invalid (maximum 8 requests / 100000 micros)',
    )
  if (!live)
    return {
      mode: 'dry-run',
      fixtures: 8,
      requestCap,
      spendCapMicros,
      note: 'No requests sent. Live evaluation requires explicit --live, a key and a conservative per-request cost reservation.',
    }
  if (
    !Number.isSafeInteger(worstCaseCostMicros) ||
    worstCaseCostMicros < 1 ||
    worstCaseCostMicros > spendCapMicros
  )
    throw Error('Conservative worst-case cost must fit the spend cap')
  if (!apiKey)
    throw Error('DEEPSEEK_API_KEY is required for explicit live evaluation')
  const { publicFixtures, validateExchange } = await loadProductionFixtures()
  const results = []
  let reservedMicros = 0
  for (const { rubric, context } of publicFixtures()) {
    if (
      results.length >= requestCap ||
      reservedMicros + worstCaseCostMicros > spendCapMicros
    )
      break
    const body = JSON.stringify({
      model: 'deepseek-flash',
      stream: false,
      thinking: { type: 'disabled' },
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: context.messages,
    })
    if (Buffer.byteLength(body) + 2048 > 12000)
      throw Error('Synthetic input exceeds cap')
    // Never release a reservation after a failure; no automatic retries.
    reservedMicros += worstCaseCostMicros
    try {
      const response = await fetchImpl(
        'https://api.deepseek.com/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(45_000),
        },
      )
      if (!response.ok) throw Error('Provider request failed')
      const reader = response.body?.getReader()
      if (!reader) throw Error('Missing response')
      let text = '',
        bytes = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 65536) {
            await reader.cancel()
            throw Error('Response exceeds cap')
          }
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        reader.releaseLock()
      }
      const payload = JSON.parse(text)
      const choice = payload?.choices?.[0]
      if (
        choice?.finish_reason !== 'stop' ||
        typeof choice?.message?.content !== 'string' ||
        Buffer.byteLength(choice.message.content) > 24000 ||
        payload?.usage?.completion_tokens > 1200
      )
        throw Error('Invalid provider output')
      const exchange = validateExchange(
        JSON.parse(choice.message.content),
        context,
      )
      results.push({
        rubric,
        status: 'review-required',
        output: exchange,
        inputTokens: payload?.usage?.prompt_tokens ?? null,
        outputTokens: payload?.usage?.completion_tokens ?? null,
      })
    } catch {
      results.push({ rubric, status: 'failed' })
      break
    }
  }
  return { mode: 'live', requests: results.length, reservedMicros, results }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2)
    if (args.some((arg) => arg !== '--live') || args.length > 1)
      throw Error('Usage: pnpm evaluate:ai [--live]')
    console.log(
      JSON.stringify(
        await evaluate({
          live: args.includes('--live'),
          apiKey: process.env.DEEPSEEK_API_KEY ?? '',
          worstCaseCostMicros: Number(
            process.env.AI_EVALUATION_WORST_CASE_COST_MICROS,
          ),
        }),
        null,
        2,
      ),
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
