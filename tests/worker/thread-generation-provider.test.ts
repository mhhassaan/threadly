import { afterEach, expect, test, vi } from 'vitest'
import { retrieveGenerationSource } from '../../src/server/thread-generation/source'
import {
  prepareGenerationThread,
  writeGenerationThread,
} from '../../src/server/thread-generation/provider'
import type { GenerationInput } from '../../src/lib/thread-generation'
import type { Platform } from '../../src/server/platform'
const p = { env: { deepseekApiKey: 'test-key' } } as Platform
const input = {
  requestId: crypto.randomUUID(),
  mode: 'url',
  source: 'https://example.com/article',
  depth: 'balanced',
  length: 'auto',
  noticeVersion: 'test',
} as GenerationInput
const text =
  'About 12% of 40 participants improved in 2024; the small observational study cannot establish causation. Researchers reported uncertainty and requested larger studies before drawing conclusions.'
const source = {
  text,
  title: 'Study',
  sourceUrl: input.source,
  source: null,
  media: [],
}
const signal = () => new AbortController().signal
const html = (body = text) =>
  new Response(
    '<html><title>Study</title><meta property="og:site_name" content="Journal"><meta property="og:image" content="/chart.png"><link rel="icon" href="/journal.png"><article>' +
      body +
      '</article></html>',
    { headers: { 'content-type': 'text/html' } },
  )
const good = (posts = [text], finish = 'stop') =>
  Response.json({
    choices: [
      {
        finish_reason: finish,
        message: { content: JSON.stringify({ title: 'Study', posts }) },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 40 },
  })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
test('extraction_good_skips_fetch preserving source avatar and media', async () => {
  const f = vi.fn().mockResolvedValue(html())
  vi.stubGlobal('fetch', f)
  const result = await retrieveGenerationSource(p, input, signal())
  expect(f).toHaveBeenCalledTimes(1)
  expect(result.text).toBe(text)
  expect(result.source).toMatchObject({
    name: 'Journal',
    icon: 'https://example.com/journal.png',
  })
  expect(result.media[0].url).toBe('https://example.com/chart.png')
})
test.each(['failed', 'boilerplate'])(
  'failed_or_boilerplate200_fetch_once %s preserves metadata',
  async (kind) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        kind === 'failed'
          ? new Response('', { status: 403 })
          : html(
              'Sign in to continue. Subscribe to read this article. '.repeat(6),
            ),
      )
      .mockResolvedValueOnce(
        Response.json({ title: 'Recovered', content: text }),
      )
    vi.stubGlobal('fetch', f)
    const result = await retrieveGenerationSource(p, input, signal())
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1][0]).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(f.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: input.source }),
    })
    expect(result.text).toBe(text)
    if (kind === 'failed')
      expect(result.source).toMatchObject({
        handle: 'example.com',
        icon: 'https://example.com/favicon.ico',
      })
    if (kind === 'boilerplate') {
      expect(result.source?.name).toBe('Journal')
      expect(result.media).toHaveLength(1)
    }
  },
)
test.each([
  'http://127.0.0.1/x',
  'http://[::1]/x',
  'https://name:pass@example.com/x',
  'file:///x',
  'https://example.internal/x',
])('unsafeURL_never_fallback %s', async (url) => {
  const f = vi.fn()
  vi.stubGlobal('fetch', f)
  await expect(
    retrieveGenerationSource(p, { ...input, source: url }, signal()),
  ).rejects.toMatchObject({ code: 'INVALID_SOURCE_URL' })
  expect(f).not.toHaveBeenCalled()
})
test('unsafe redirected URL never reaches paid fallback', async () => {
  const f = vi.fn().mockResolvedValue(
    new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    }),
  )
  vi.stubGlobal('fetch', f)
  await expect(
    retrieveGenerationSource(p, input, signal()),
  ).rejects.toMatchObject({ code: 'INVALID_SOURCE_URL' })
  expect(f).toHaveBeenCalledTimes(1)
})
test.each([404, 'empty', 'placeholder', 'search', 'oversize'])(
  'fetch404_or_empty_actionable_failure %s',
  async (kind) => {
    const fallback =
      kind === 404
        ? new Response('', { status: 404 })
        : Response.json(
            kind === 'search'
              ? { results: [{ content: text }] }
              : {
                  title: 't',
                  content:
                    kind === 'empty'
                      ? ''
                      : kind === 'placeholder'
                        ? 'Subscribe to read more. '.repeat(20)
                        : 'x'.repeat(1048577),
                },
          )
    const f = vi
      .fn()
      .mockResolvedValueOnce(html('short'))
      .mockResolvedValueOnce(fallback)
    vi.stubGlobal('fetch', f)
    await expect(
      retrieveGenerationSource(p, input, signal()),
    ).rejects.toMatchObject({
      code: kind === 'oversize' ? 'SOURCE_TOO_LARGE' : 'SOURCE_UNAVAILABLE',
      message: expect.stringMatching(
        kind === 'oversize' ? /shorter/i : /paste/i,
      ),
    })
    expect(f).toHaveBeenCalledTimes(2)
  },
)
test.each(['text', 'file'] as const)(
  'pasted/file_no_fetch %s',
  async (mode) => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const result = await retrieveGenerationSource(
      p,
      {
        ...input,
        mode,
        source: text + '\n![Chart](https://example.com/chart.png)',
      },
      signal(),
    )
    expect(result.text).toContain(text)
    expect(result.media).toHaveLength(1)
    expect(f).not.toHaveBeenCalled()
  },
)
test('source_over_limit_not_truncated nor fetched again', async () => {
  const f = vi.fn().mockResolvedValue(html('x'.repeat(100001)))
  vi.stubGlobal('fetch', f)
  await expect(
    retrieveGenerationSource(p, input, signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
  expect(f).toHaveBeenCalledTimes(1)
})
test('provider sends exact prepared bytes across only one transient retry and preserves qualifiers', async () => {
  const prepared = prepareGenerationThread(input, source)
  const f = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(good())
  vi.stubGlobal('fetch', f)
  const result = await writeGenerationThread(p, prepared, signal())
  expect(result).toMatchObject({
    posts: [text],
    attempts: 2,
    usage: { inputTokens: 100, outputTokens: 40 },
  })
  for (const call of f.mock.calls) {
    expect(call[0]).toBe('https://api.deepseek.com/chat/completions')
    expect(call[1].body).toBe(prepared.body)
    expect(call[1].redirect).toBe('error')
  }
})
test.each([401, 402, 400])('permanent %s never retries', async (status) => {
  const f = vi.fn().mockResolvedValue(new Response('', { status }))
  vi.stubGlobal('fetch', f)
  await expect(
    writeGenerationThread(p, prepareGenerationThread(input, source), signal()),
  ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
  expect(f).toHaveBeenCalledTimes(1)
})
test('network transient retries at most twice', async () => {
  const f = vi.fn().mockRejectedValue(new TypeError('offline'))
  vi.stubGlobal('fetch', f)
  await expect(
    writeGenerationThread(p, prepareGenerationThread(input, source), signal()),
  ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
  expect(f).toHaveBeenCalledTimes(2)
})
test.each(['length', 'badjson', 'tooMany', 'extra'])(
  'invalid result %s never repairs or retries',
  async (kind) => {
    const response =
      kind === 'badjson'
        ? Response.json({
            choices: [{ finish_reason: 'stop', message: { content: '{' } }],
          })
        : kind === 'extra'
          ? Response.json({
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      title: 't',
                      posts: [text],
                      extra: true,
                    }),
                  },
                },
              ],
            })
          : good(
              kind === 'tooMany' ? [text, 'Another thought.'] : [text],
              kind === 'length' ? 'length' : 'stop',
            )
    const f = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', f)
    await expect(
      writeGenerationThread(
        p,
        prepareGenerationThread({ ...input, length: 1 }, source),
        signal(),
      ),
    ).rejects.toMatchObject({
      code:
        kind === 'length' || kind === 'extra'
          ? 'INVALID_GENERATED_THREAD'
          : 'AI_PROVIDER_FAILED',
    })
    expect(f).toHaveBeenCalledTimes(1)
  },
)
test('caller abort prevents work and late provider response publication', async () => {
  const c = new AbortController()
  c.abort()
  const f = vi.fn().mockResolvedValue(good())
  vi.stubGlobal('fetch', f)
  await expect(
    writeGenerationThread(p, prepareGenerationThread(input, source), c.signal),
  ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
  expect(f).not.toHaveBeenCalled()
  const next = new AbortController()
  f.mockImplementation(async () => {
    next.abort()
    return good()
  })
  await expect(
    writeGenerationThread(
      p,
      prepareGenerationThread(input, source),
      next.signal,
    ),
  ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
  expect(f).toHaveBeenCalledTimes(1)
})
test('45s attempt deadline aborts even noncooperative fetch without retry', async () => {
  vi.useFakeTimers()
  const f = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', f)
  const result = writeGenerationThread(
    p,
    prepareGenerationThread(input, source),
    signal(),
  )
  const rejected = expect(result).rejects.toMatchObject({
    code: 'AI_PROVIDER_FAILED',
  })
  await vi.advanceTimersByTimeAsync(45000)
  await rejected
  expect(f).toHaveBeenCalledTimes(1)
})
test('10s Fetch deadline aborts even noncooperative fetch', async () => {
  vi.useFakeTimers()
  const f = vi
    .fn()
    .mockResolvedValueOnce(html('short'))
    .mockImplementation(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', f)
  const result = retrieveGenerationSource(p, input, signal())
  const rejected = expect(result).rejects.toMatchObject({
    code: 'SOURCE_UNAVAILABLE',
  })
  await vi.advanceTimersByTimeAsync(10000)
  await rejected
  expect(f).toHaveBeenCalledTimes(2)
})

test('fallback keeps extracted media and adds recovered Markdown media without duplicates', async () => {
  const f = vi
    .fn()
    .mockResolvedValueOnce(html('short'))
    .mockResolvedValueOnce(
      Response.json({
        title: 'Recovered',
        content:
          text +
          '\n![Extra](https://example.com/extra.png)\n![Same](https://example.com/chart.png)',
      }),
    )
  vi.stubGlobal('fetch', f)
  const result = await retrieveGenerationSource(p, input, signal())
  expect(result.media.map((m) => m.url)).toEqual([
    'https://example.com/chart.png',
    'https://example.com/extra.png',
  ])
})
test('caller cancellation in progress aborts noncooperative provider and source without retry', async () => {
  for (const operation of ['source', 'writer']) {
    const c = new AbortController()
    const f = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', f)
    const result =
      operation === 'writer'
        ? writeGenerationThread(
            p,
            prepareGenerationThread(input, source),
            c.signal,
          )
        : retrieveGenerationSource(p, input, c.signal)
    const rejected = expect(result).rejects.toMatchObject({
      code:
        operation === 'writer' ? 'AI_PROVIDER_FAILED' : 'SOURCE_UNAVAILABLE',
    })
    c.abort()
    await rejected
    expect(f).toHaveBeenCalledTimes(1)
  }
})

test.each([429, 408])(
  'transient HTTP %s retries once with the same bounded payload',
  async (status) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(good())
    vi.stubGlobal('fetch', f)
    const prepared = prepareGenerationThread(input, source)
    expect((await writeGenerationThread(p, prepared, signal())).attempts).toBe(
      2,
    )
    expect(f.mock.calls.map((call) => call[1].body)).toEqual([
      prepared.body,
      prepared.body,
    ])
  },
)
test('failed Fetch is never retried and public article endpoint never uses paid recovery', async () => {
  const articleWorker = (await import('../../src/server/article.js')).default
  const f = vi.fn().mockResolvedValueOnce(html('short'))
  vi.stubGlobal('fetch', f)
  const result = await articleWorker.fetch(
    new Request('http://localhost/api/article', {
      method: 'POST',
      body: JSON.stringify({ url: input.source }),
    }),
  )
  expect(result.status).toBe(400)
  expect(f).toHaveBeenCalledTimes(1)
  f.mockReset()
    .mockResolvedValueOnce(html('short'))
    .mockRejectedValueOnce(new TypeError('offline'))
  await expect(
    retrieveGenerationSource(p, input, signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  expect(f).toHaveBeenCalledTimes(2)
})
test('Fetch over source limit but under byte bound rejects without truncating', async () => {
  const f = vi
    .fn()
    .mockResolvedValueOnce(html('short'))
    .mockResolvedValueOnce(
      Response.json({ title: 'Long', content: 'word '.repeat(21000) }),
    )
  vi.stubGlobal('fetch', f)
  await expect(
    retrieveGenerationSource(p, input, signal()),
  ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
  expect(f).toHaveBeenCalledTimes(2)
})
test('provider bounded streaming body rejects oversized response without retry', async () => {
  const f = vi.fn().mockResolvedValue(new Response('x'.repeat(1048577)))
  vi.stubGlobal('fetch', f)
  await expect(
    writeGenerationThread(p, prepareGenerationThread(input, source), signal()),
  ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
  expect(f).toHaveBeenCalledTimes(1)
})
test('deadline cancels a stalled provider response stream', async () => {
  vi.useFakeTimers()
  const cancelled = vi.fn()
  const f = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{'))
        },
        cancel: cancelled,
      }),
    ),
  )
  vi.stubGlobal('fetch', f)
  const result = writeGenerationThread(
    p,
    prepareGenerationThread(input, source),
    signal(),
  )
  const rejected = expect(result).rejects.toMatchObject({
    code: 'AI_PROVIDER_FAILED',
  })
  await vi.advanceTimersByTimeAsync(45000)
  await rejected
  expect(f).toHaveBeenCalledTimes(1)
  expect(cancelled).toHaveBeenCalledOnce()
})

const monthlyWall =
  'You have reached your monthly article limit. Create an account to continue reading. Become a member to unlock unlimited articles and support independent journalism. Choose a plan to get full access.'
const consentWall =
  'We use cookies and similar technologies to improve your browsing experience and provide personalized advertising. Accept all cookies or manage your preferences to continue to this website.'
const navigationOnly =
  'Home | News | World | Politics | Business | Technology | Science | Health | Culture | Sports | Opinion | About us | Contact us | Privacy policy | Terms of service | Help | Careers | Newsletters'
test.each([monthlyWall, consentWall, navigationOnly])(
  'access consent and navigation-only local200 recover exactly once: %s',
  async (wall) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(html(wall))
      .mockResolvedValueOnce(
        Response.json({ title: 'Recovered', content: text }),
      )
    vi.stubGlobal('fetch', f)
    const result = await retrieveGenerationSource(p, input, signal())
    expect(result.text).toBe(text)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1][0]).toBe('https://api.deepseek.com/v1/tools/fetch')
  },
)
test.each([monthlyWall, consentWall, navigationOnly])(
  'Fetch access consent and navigation-only content never becomes model evidence: %s',
  async (wall) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(html('short'))
      .mockResolvedValueOnce(Response.json({ title: 'Blocked', content: wall }))
    vi.stubGlobal('fetch', f)
    await expect(
      (async () => {
        const evidence = await retrieveGenerationSource(p, input, signal())
        return writeGenerationThread(
          p,
          prepareGenerationThread(input, evidence),
          signal(),
        )
      })(),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(f).toHaveBeenCalledTimes(2)
    expect(
      f.mock.calls.some(
        (call) => call[0] === 'https://api.deepseek.com/chat/completions',
      ),
    ).toBe(false)
  },
)
test.each(['local', 'fetch'])(
  'mixed %s content strips access wall and preserves narrative qualifiers before preparation',
  async (mode) => {
    const content =
      monthlyWall +
      '\n\n' +
      text +
      '\n\nSubscribe to read the full article and get unlimited access to all our reporting.'
    const f =
      mode === 'local'
        ? vi
            .fn()
            .mockResolvedValueOnce(
              html(
                '<p>' +
                  monthlyWall +
                  '</p><p>' +
                  text +
                  '</p><p>Subscribe to read the full article and get unlimited access to all our reporting.</p>',
              ),
            )
        : vi
            .fn()
            .mockResolvedValueOnce(html('short'))
            .mockResolvedValueOnce(Response.json({ title: 'Study', content }))
    vi.stubGlobal('fetch', f)
    const evidence = await retrieveGenerationSource(p, input, signal())
    expect(evidence.text).toBe(text)
    const sent = JSON.parse(
      JSON.parse(prepareGenerationThread(input, evidence).body).messages[1]
        .content,
    )
    expect(sent.source.text).toBe(text)
    expect(evidence.source?.name).toBe('Journal')
    expect(evidence.media[0].url).toBe('https://example.com/chart.png')
    expect(f).toHaveBeenCalledTimes(mode === 'local' ? 1 : 2)
  },
)
test.each(['local', 'fetch'])(
  'real %s reporting about subscriptions cookies and access policies stays intact',
  async (mode) => {
    const narrative =
      'Researchers found that subscriptions funded about 12% of the project in 2024, although the sample of 40 participants cannot establish causation. The report explains why people subscribe to journals, how cookies affect measurement, and why a paywall can limit research access.'
    const f =
      mode === 'local'
        ? vi.fn().mockResolvedValueOnce(html(narrative))
        : vi
            .fn()
            .mockResolvedValueOnce(html('short'))
            .mockResolvedValueOnce(
              Response.json({ title: 'Research', content: narrative }),
            )
    vi.stubGlobal('fetch', f)
    expect((await retrieveGenerationSource(p, input, signal())).text).toBe(
      narrative,
    )
    expect(f).toHaveBeenCalledTimes(mode === 'local' ? 1 : 2)
  },
)

test.each(['text', 'file'] as const)(
  'pasted %s attribution is metadata only and retains original text',
  async (mode) => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const original = 'Source: https://www.example.org/article\n\n' + text
    const result = await retrieveGenerationSource(
      p,
      { ...input, mode, source: original },
      signal(),
    )
    expect(result.text).toBe(original)
    expect(result.sourceUrl).toBe('https://www.example.org/article')
    expect(result.source).toMatchObject({
      name: 'example.org',
      handle: 'example.org',
      icon: 'https://www.example.org/favicon.ico',
    })
    expect(f).not.toHaveBeenCalled()
  },
)
test.each([
  'javascript:alert(1)',
  'https://user:pass@example.org/a',
  'http://127.0.0.1/private',
  'https://example.internal/a',
  'not-a-url',
])('unsafe attribution stays plain text: %s', async (url) => {
  const f = vi.fn()
  vi.stubGlobal('fetch', f)
  const original = 'Source: ' + url + '\n' + text
  const result = await retrieveGenerationSource(
    p,
    { ...input, mode: 'text', source: original },
    signal(),
  )
  expect(result.text).toBe(original)
  expect(result.sourceUrl).toBe('')
  expect(result.source).toBeNull()
  expect(f).not.toHaveBeenCalled()
})
