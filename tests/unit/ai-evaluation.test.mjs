import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from '../../scripts/ai-evaluation.mjs'

test('default dry run makes no provider request or credential requirement', async () => {
  let calls = 0
  const result = await evaluate({
    fetchImpl: async () => {
      calls++
      throw Error('Network forbidden')
    },
  })
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.fixtures, 8)
  assert.equal(calls, 0)
})
const payload = (init) => {
  const request = JSON.parse(init.body)
  const data = JSON.parse(request.messages[1].content)
  return Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            memoryUpdates: [],
            comments: [
              {
                id: 'reply',
                speakerId: '10000000-0000-4000-8000-000000000001',
                postId: data.posts?.[0]?.id ?? 'post',
                parentId: data.triggerCommentId ?? null,
                batchParentId: null,
                text: 'Synthetic reply with a qualified claim.',
                passageIds: [],
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  })
}
test('public evaluation uses production cast, schema, source and memory context', async () => {
  const messages = []
  const result = await evaluate({
    live: true,
    apiKey: 'fake',
    worstCaseCostMicros: 1000,
    fetchImpl: async (_url, init) => {
      messages.push(JSON.parse(init.body).messages)
      return payload(init)
    },
  })
  assert.equal(result.requests, 8)
  assert.equal(
    result.results.every((x) => x.status === 'review-required'),
    true,
  )
  for (const value of messages) {
    assert.match(value[0].content, /JSON schema:/)
    for (const name of ['Flint', 'Prism', 'Ripple', 'Orbit'])
      assert.ok(value[0].content.includes(name))
    const data = JSON.parse(value[1].content)
    assert.equal(data.kind, 'reply')
    assert.ok(data.passages.length > 0)
  }
  const data = messages.map((value) => JSON.parse(value[1].content))
  assert.ok(data.some((value) => value.comments[0].text.includes('I disagree')))
  assert.ok(
    data.some((value) =>
      value.passages.some((p) => p.text.includes('entire planet')),
    ),
  )
  const memory = data.find((value) => value.memories.length)
  assert.equal(
    memory.memories[0].text,
    'I prefer evidence about solar storage.',
  )
  assert.ok(
    !messages[data.indexOf(memory)][0].content.includes('echo_guest_ai'),
  )
})
test('production output validator rejects invented speakers without another request', async () => {
  let calls = 0
  const result = await evaluate({
    live: true,
    apiKey: 'fake',
    worstCaseCostMicros: 1000,
    fetchImpl: async (_url, init) => {
      calls++
      const response = await payload(init).json()
      const exchange = JSON.parse(response.choices[0].message.content)
      exchange.comments[0].speakerId = 'invented-person'
      response.choices[0].message.content = JSON.stringify(exchange)
      return Response.json(response)
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.results[0].status, 'failed')
})
test('live evaluation enforces request and reserved spend caps with fake HTTP', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return payload(init)
  }
  const requests = await evaluate({
    live: true,
    apiKey: 'fake',
    fetchImpl,
    requestCap: 2,
    worstCaseCostMicros: 1000,
  })
  assert.equal(requests.requests, 2)
  assert.equal(requests.reservedMicros, 2000)
  assert.equal(bodies.length, 2)
  const spend = await evaluate({
    live: true,
    apiKey: 'fake',
    fetchImpl,
    spendCapMicros: 2000,
    worstCaseCostMicros: 1000,
  })
  assert.equal(spend.requests, 2)
  assert.equal(spend.reservedMicros, 2000)
  assert.equal(bodies[0].model, 'deepseek-flash')
  assert.equal(bodies[0].max_tokens, 1200)
})
test('invalid or raised caps fail closed before HTTP', async () => {
  for (const options of [
    { requestCap: 9 },
    { spendCapMicros: 100001 },
    { worstCaseCostMicros: 0 },
    { worstCaseCostMicros: NaN },
  ]) {
    await assert.rejects(
      evaluate({
        live: true,
        apiKey: 'fake',
        fetchImpl: () => {
          throw Error('Unexpected HTTP')
        },
        worstCaseCostMicros: 1000,
        ...options,
      }),
      /cap|cost/i,
    )
  }
})
test('HTTP failures are charged conservatively and never retried', async () => {
  let calls = 0
  const result = await evaluate({
    live: true,
    apiKey: 'fake',
    worstCaseCostMicros: 1000,
    fetchImpl: async () => {
      calls++
      return new Response('', { status: 503 })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.requests, 1)
  assert.equal(result.reservedMicros, 1000)
  assert.equal(result.results[0].status, 'failed')
})
