# AI evaluation and qualification

Ordinary checks are deterministic and make no real DeepSeek/Resend requests. `pnpm evaluate:ai` is an explicitly invoked evaluation utility and defaults to dry-run. It uses eight public synthetic solar/storage scenarios: sarcasm, factual correction, anger, ambiguous humor, agreement and disagreement, concession, source misinformation and historical memory accuracy. It never reads application databases, source records, private comments or email.

```sh
pnpm evaluate:ai
```

Dry-run reports fixture count and fixed caps, needs no key and sends zero requests. It runs separately from CI/smoke; tests exercise its safeguards through injected fake HTTP only.

## Live evaluation (requires future authorization)

No live evaluation was performed during implementation. Only after the user explicitly authorizes it, set server-shell `DEEPSEEK_API_KEY` and `AI_EVALUATION_WORST_CASE_COST_MICROS` locally, then run:

```sh
pnpm evaluate:ai --live
```

The script permits at most 8 requests and 100000 reserved cost micros ($0.10). One request is reserved before each call, failures retain reservations, the run stops on the first failure, and there are no retries. Invalid/raised caps and a missing/invalid conservative per-request reservation fail closed. A request uses `deepseek-flash`, JSON mode, no streaming/thinking, max 1200 output tokens, bounded input bytes, a 45 second timeout,65536 response bytes and 24000 content bytes. These are operational safeguards, not proof of quality. Choose a conservative cost reservation against current provider terms; a configured estimate cannot guarantee actual billed cost if it understates provider pricing. Do not log credentials.

The output is validated public synthetic exchanges and token counts for human review. Public `ThreadSnapshot` fixtures reuse production `buildContext`, `getCast` and `validateExchange`, including the actual system instructions, schema, recurring personalities, source passages and historical memory context. An existing pluginless Vite TypeScript runner loads these helpers without app plugins, environment files, D1 or a server listener, then closes. Evaluation retains its separate capped HTTP transport without retries. Local Workers tests additionally exercise persistence and admission. This does not qualify real private-article retrieval or production behavior. Do not add private content to fixtures to make it more realistic.

## Human rubric

Score each criterion 0 (failed), 1 (mixed), or 2 (clear pass), retain brief public-fixture evidence and inspect every returned comment:

| Criterion       | What to assess                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Wit and tone    | Gentle situational wit; ambiguity receives tentative interpretation; natural writing without forced slang            |
| Factual honesty | Article claims attributed; synthetic misinformation challenged carefully; absent external verification acknowledged  |
| Non-escalation  | Anger receives calm reasoning; no insults, manufactured controversy or invented lived experience                     |
| Distinct voices | Flint, Prism, Ripple and Orbit follow their configured voices without forced opposition; concessions follow evidence |
| Memory accuracy | Historical quote preserved as uncertain past speech; no permanent preference/inferred trait or guest inheritance     |

Any unsupported citation, personal-profile inference, invented action/experience or escalating abuse blocks a quality pass regardless of aggregate score. Record model/date, caps, actual request count, reported token usage and public response evidence. A response can pass JSON/shape validation and still fail the rubric. Local fixtures only prove prompt inclusion, bounded outputs and rejection rules, not actual entailment or tone.

## Local acceptance evidence

`tests/worker/journey.test.ts` uses separately authenticated actual Better Auth sessions and local D1, with fake provider/email fetches. It covers explicit legacy import, new source-owned threads, opening quiet posts, bounded human follow-ups, second-device edit/load, recurring memory in a new thread, clear/delete/reset/logout, owner-only allowance status and manual operation under exhausted budget. Focused authenticated Request/Response tests cover collection POST/item GET/DELETE ownership, trusted Origin, private/no-store and GET-no-generation. Existing collection logical GET/DELETE coverage is retained.

`tests/unit/deepseek.test.ts` covers actual 503/network retry paths and persistent failures, 401/invalid-output non-retry, output/byte caps, abort and shared 45 second deadline. Source-misinformation fixtures place the claim in actual `sourceText` and assert its untrusted source passage and attribution guidance. Memory/turn/privacy tests cover atomic fences, idempotency, cancellation, consent and deletion. `tests/unit/ai-evaluation.test.mjs` verifies dry-run, request/spend caps, failed-call charging, production prompt/cast/source/memory construction and actual validator rejection of an invented speaker without external HTTP.

Browser qualification is recorded in the local Task 12 report; desktop and 390 px emulation establish browser geometry only, not physical phone behavior. Reduced-motion behavior may only be called browser-tested when the actual browser preference/emulation supports it. No OS preference changes are part of qualification.

## Unverified production checks

Production Resend delivery and sending-domain/DNS acceptance, actual DeepSeek tone/factual grounding/memory behavior, real upstream latency and deployed billed Workers CPU/free-tier feasibility remain unverified. Earlier local secure-hash/process-CPU measurements warrant an actual platform check; wall clock and local process totals are not production CPU evidence. No domain purchase, resource provisioning, deployment, live billing or paid-plan activation is implied by these tests. Optional sharing with other real users remains deferred.
