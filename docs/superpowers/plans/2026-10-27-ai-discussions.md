# Private AI Discussions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verified accounts, private cross-device reading data, and source-grounded multi-personality AI discussions with persistent user-controlled memory.

**Architecture:** Keep existing React/TanStack screens and deterministic summarization. Run server routes on Cloudflare Workers, persist owned records in D1, authenticate with Better Auth, deliver account email with Resend HTTPS, and generate bounded structured exchanges with DeepSeek. Separate guest browser storage from authenticated Query caches; all private operations authorize on the server.

**Tech Stack:** Existing TanStack Start/Router/Query, React, TypeScript, Vite and pnpm; Cloudflare Vite plugin/Wrangler/D1; Better Auth with Drizzle's SQLite/D1 adapter; Resend HTTPS API; DeepSeek Chat Completions; Vitest with Workers integration pool for D1 tests.

**Spec:** `docs/superpowers/specs/2026-10-27-ai-discussions-design.md` (user approved 2026-10-27).

## Global Constraints

- Model: `deepseek-flash`. No provider credentials, private source text, auth tokens or passwords in code, Git, logs or test snapshots.
- Preserve existing typography, X-style reader, themes, article/media import, guest data, editable posts and PNG/text exports. No AI dependency for extractive summaries.
- Verified accounts required for sync and AI. Every synthetic participant visibly labeled AI. No public discussion access or real-user collaboration yet.
- Four recurring personalities; thread-specific guests; no real-person impersonation. Human-sounding style follows context without mandatory slang.
- Human turn: one to three AI comments and at most two speakers. Opening pass: at most three posts/four comments, at least one quiet post when multiple posts exist; single-post thread: zero or one comment.
- Five openings and 30 human AI turns per verified user per UTC day. One active turn per thread, three per account. Server reservations enforce concurrency/quotas.
- Per-call maximum: 12,000 input tokens and 1,200 output tokens, including any memory update output. Configurable operator spend ceiling and global AI-off switch. No unbounded loops/retries.
- Memory deletion/reset cannot resurrect earlier material. No activity while user is away; no polling that triggers new generation.
- Preserve `.openai/hosting.json`. Domain/student offer redemption, production email credentials, resource provisioning, paid plans, push and deployment are deferred.
- Keep `.gitignore`, `devlog.md`, `.agents`, `AGENTS.md` and `project-context` local-only. Update local devlog/context after each task. Commit only explicit task files, never `git add .`.
- Node >=22.12; pnpm pinned by package.json. Do not hand-edit `src/routeTree.gen.ts`. Pin compatible new dependency versions after Task 1 compatibility check; do not blindly upgrade existing framework versions.

## Review Focus

1. A second account or stale browser tab must not see previous-account records, drafts or in-flight replies (Tasks 2, 4, 5, 9).
2. Double-clicks, two devices and worker interruption must not duplicate comments, exceed budgets or leave generation locked forever (Tasks 7, 8).
3. Prompt instructions inside an article, fake citation IDs and reply parents from another thread must not become trusted data (Tasks 6, 8).
4. Memory clear/deletion racing with generation must prevent stale memory use or recreation (Tasks 8, 10, 11).
5. Legacy missing source, offline drafts, email delivery failure and edit conflicts must leave reading and human text recoverable (Tasks 2-6, 9).

## File structure and shared contracts

New directories are feature-sized: `src/server/auth/`, `src/server/data/`, `src/server/discussion/`, `src/features/account/`, `src/features/discussion/`, `tests/worker/`, `tests/unit/`. Do not restructure unrelated dashboard code.

`src/lib/account-thread.ts` defines shared serializable DTOs:

- `UserContext = { userId: string; verified: boolean }` is produced only from server session verification, never client JSON.
- `OwnedThread = { id: string; ownerId: string; revision: number; sourceRevision: number; record: ThreadRecord; posts: OwnedPost[] }`; `OwnedPost = { id: string; text: string; position: number; revision: number }`.
- `Comment = { id: string; threadId: string; postId: string; parentId: string | null; authorKind: 'human' | 'ai'; authorId: string; text: string; sequence: number; createdAt: string; turnId: string | null; passageIds: string[] }`.
- `AppendCommentInput = { id: string; threadId: string; postId: string; parentId: string | null; text: string }`. Max 2,000 characters; only server writes authorKind/authorId.
- `ThreadSnapshot = { thread: OwnedThread; comments: Comment[]; readPostId: string | null; readAt: string | null }`.
- `AccountSettings = { aiEnabled: boolean; memoryEnabled: boolean; consentAt: string | null; memoryEpoch: number }`.
- `TurnInput = { requestId: string; threadId: string; kind: 'opening' | 'reply'; triggerCommentId: string | null }`.
- `TurnState = { id: string; status: 'reserved' | 'running' | 'complete' | 'failed' | 'cancelled' | 'stale'; commentIds: string[]; errorCode?: string }`.
- `ApiError = { code: string; message: string }`; use 401 unauthenticated, 403 unverified, 404 absent/not-owned, 409 revision/busy, 429 quota, 503 provider/configuration unavailable.

Use opaque UUIDs, server timestamps and safe DTO serialization; never expose auth tables or raw provider errors. Every new API response with private content sends `Cache-Control: private, no-store`.

## Phase A: accounts and owned data

### Task 1: Establish a tested Workers runtime and local D1

**Files:** Modify `vite.config.ts`, `package.json`, `pnpm-lock.yaml`, `scripts/smoke.mjs`, `scripts/preview.mjs`, `README.md`; create `wrangler.jsonc`, `src/server/platform.ts`, `vitest.config.ts`, `tests/worker/platform.test.ts`, `worker-configuration.d.ts` (generated), `.env.example` (placeholders).

**Interfaces:** Export `Platform = { db: D1Database; env: ServerConfig; waitUntil: (work: Promise<unknown>) => void }`, `getPlatform(): Platform` and `ServerConfig` for auth URL/secret, email transport, Resend sender/key, DeepSeek key, AI switch and spend ceiling. Access platform only in server modules. Local binding name is `DB`.

- [ ] Write the Workers test `platform_database_and_guest_routes`: `expect(await readTestRow(platform.db)).toBe('local'); expect((await fetchApp('/')).status).toBe(200); expect((await fetchApp('/api/article', privateUrlInput)).status).toBe(400)`. Fixture helpers live in `tests/worker/helpers.ts`.
- [ ] Run `pnpm exec vitest run tests/worker/platform.test.ts`; expect failure before runtime/binding implementation.
- [ ] Add compatible Cloudflare plugin/runtime types, Wrangler and test dependencies. Use official current TanStack Workers configuration and Drizzle D1 support; configure loopback local development and local migrations, never remote binding access. Provide a local preview entry appropriate to the adapter instead of assuming existing Node preview still works. Preserve existing smoke assertions for HTML/assets/reader/API.
- [ ] Run `pnpm typecheck`, `pnpm check`, the platform test, `pnpm build`, `pnpm smoke`; expect all pass. Record local Workers CPU measurements for representative SSR and large-article extraction; do not enable billing. Record selected dependency versions/commands in README.
- [ ] Commit explicit files as `build: support local Cloudflare Workers and D1`.

### Task 2: Implement server authentication and email delivery

**Files:** Create `src/server/data/db.ts`, `src/server/auth/auth.ts`, `src/server/auth/email.ts`, `src/server/auth/schema.ts`, `src/server/auth/session.ts`, `src/routes/api.auth.$.ts`, `migrations/0001_auth.sql`, `tests/worker/auth.test.ts`, `tests/unit/email.test.ts`, `scripts/dev-mail.mjs`; modify configuration/package scripts from Task 1.

**Interfaces:** `createDb(db: D1Database)` returns the Drizzle D1 instance; `createAuth(platform: Platform)` returns a configured Better Auth instance. `requireUser(request: Request, platform: Platform, verified = true): Promise<UserContext>` throws mapped API errors. `sendAccountEmail(platform: Platform, input: { to: string; subject: string; html: string; text: string; idempotencyKey: string }): Promise<void>`; transport is Resend in production or localhost capture in development.

- [ ] Write tests named `verification_required`, `reset_token_single_use`, `resend_failure_not_verified`, `auth_trusted_origin`, `expired_session`: assert unverified sync returns 403, verification then allows access, expired/reused reset links fail, cross-origin mutation fails, and delivery failure never marks an email verified. Unit test Resend request headers/body using a fake fetch and no real recipients.
- [ ] Run `pnpm exec vitest run tests/worker/auth.test.ts tests/unit/email.test.ts`; expect red.
- [ ] Configure Better Auth email/password, verified-email gate, secure sessions, allowed callback origins and supported request limits. Generate auth schema for the pinned adapter; migrate local D1. Deliver through Resend HTTPS with waitUntil/error status handling. Dev capture service writes only under ignored `work/dev-mail`, binds loopback and is never routed from production. Revoke existing sessions after password reset. Never log links or tokens in app logs.
- [ ] Run the task tests; verify signup -> captured link -> verification -> login -> reset -> old session rejected, using two isolated cookie jars. Benchmark secure hash/verify in Workers; if free-tier CPU is insufficient, record the blocker without lowering hashing strength or activating a paid plan.
- [ ] Commit as `feat: add verified email accounts and password recovery`.

### Task 3: Add account screens and session boundaries

**Files:** Create `src/features/account/auth-client.ts`, `AccountPanel.tsx`, `AuthForms.tsx`, `src/routes/account.tsx`, `tests/unit/auth-state.test.ts`; modify `src/components/Threadly.tsx`, `src/style.css`, `src/router.tsx` only as needed.

**Interfaces:** Export `useAccount(): { user: { id: string; name: string; verified: boolean } | null; pending: boolean; signOut: () => Promise<void> }` and `clearAccountCache(queryClient: QueryClient, userId: string): void`. Private Query keys start `['account', userId]`. Browser drafts are namespaced by account, kept only for that account's session, and cleared on explicit logout.

- [ ] Write `account_switch_drops_private_cache`: `expect(cacheFor('alice')).toBeUndefined()` after logout; retain `threadly-library` guest entries. Add form tests for password mismatch, invalid email and expired-session retry retaining the current draft until explicit logout.
- [ ] Run `pnpm exec vitest run tests/unit/auth-state.test.ts`; expect red.
- [ ] Implement signup/name, login, verification status/resend, forgot/reset forms and logout with Better Auth client. Read local UI skills `emil-design-eng` and `mobile-native` before editing screens. Use existing styling/dialogs; no dashboard redesign. Keep server credentials and email capture URLs out of client bundles.
- [ ] Run tests/typecheck; browser-check keyboard focus, password-manager autocomplete, 390px layout, delivery failure/retry and account-switch isolation. Guest source inputs and Create my thread still work.
- [ ] Commit as `feat: add account access and session-aware UI`.

### Task 4: Persist owned threads, source, comments and reading progress

**Files:** Create `src/lib/account-thread.ts`, `src/server/data/schema.ts`, `src/server/data/threads.ts`, `comments.ts`, `src/routes/api.library.ts`, `api.threads.$threadId.ts`, `api.comments.ts`, `migrations/0002_reading.sql`, `tests/worker/owned-data.test.ts`.

**Interfaces:** DTOs are defined above. Functions consume authenticated `UserContext` and local platform: `saveThread(p,u,record: ThreadRecord,expectedRevision: number | null): Promise<OwnedThread>`; `getSnapshot(p,u,threadId: string): Promise<ThreadSnapshot>`; `appendHumanComment(p,u,input: AppendCommentInput): Promise<Comment>`; `saveReadProgress(p,u,threadId: string,postId: string): Promise<void>`; `deleteThread(p,u,threadId: string): Promise<void>` (dependency cleanup extended in Task 11).

- [ ] Write `owner_isolation`, `stale_edit_preserves_server`, `parent_must_share_post`, `comment_idempotency`, `read_progress_roundtrip`: assert Bob gets 404 for Alice's IDs; stale revision returns 409; foreign parent/post is rejected; same ID/same payload returns same comment; same ID/different payload returns 409. Preserve original source text when a post is edited.
- [ ] Run `pnpm exec vitest run tests/worker/owned-data.test.ts`; expect red.
- [ ] Add owner-scoped schema and APIs: library GET/list, POST/create/import; thread GET/PATCH/DELETE; comments POST human-only. Thread PATCH carries expectedRevision and post edits or reading/reaction updates. Use separate mutation DTO validation, stable post IDs and composite ownership constraints. Atomic conditional writes, bounded body sizes and paginated lists (50/page). Preserve media/reactions. No arbitrary user/author fields accepted from JSON. Validate parent stays on target post, not merely thread.
- [ ] Run task tests against D1; repeat create/get/edit/comment/read with two cookie jars. Confirm unverified access fails and private responses have no-store headers.
- [ ] Commit as `feat: persist private threads and discussion records`.

### Task 5: Connect cloud library and explicit legacy import

**Files:** Create `src/features/account/library.ts`, `ImportLocalThreads.tsx`, `src/lib/legacy-import.ts`, `src/server/data/import.ts`, `tests/unit/legacy-import.test.ts`, `tests/worker/import.test.ts`; modify `src/components/Threadly.tsx`, `src/routes/index.tsx`, `src/routes/api.library.ts`.

**Interfaces:** `importLocalThread(p,u,input: { migrationId: string; record: ThreadRecord }): Promise<OwnedThread>`; `toLegacyRecord(snapshot: ThreadSnapshot): ThreadRecord`; `useCloudLibrary(userId: string)` wraps owner-keyed Query and paginated library. Add validated `thread` search parameter for server-owned reader IDs; keep existing `reader` token transfer working for guests.

- [ ] Write `import_resume_deduplicates`, `missing_source_stays_missing`, `guest_data_not_uploaded`, `two_devices_read_same_thread`, `stale_edit_retains_draft`: assert account/local-ID uniqueness, legacy reply text/date migration with stable IDs, no network import before explicit action, repeated import leaves one thread, 409 preserves editable draft.
- [ ] Run `pnpm exec vitest run tests/unit/legacy-import.test.ts tests/worker/import.test.ts`; expect red.
- [ ] Wire account library/load/save/edit/progress/reactions to Task 4. Add opt-in resumable import using a durable per-account migration key. Do not mutate guest records or generate opening comments on imported records. Refetch private queries on focus and invalidate after writes. Signed-in owned readers load on a fresh device without opener/sessionStorage; guest readers retain their existing handshake.
- [ ] Run tests/core checks; browser-test two sessions, legacy import twice, refresh, offline cached reading, failed save and logout. No account content may be persisted in unscoped local reader caches. Offline writes remain drafts with deliberate retry, not a hidden sync queue.
- [ ] Commit as `feat: sync reading library and import existing local threads`.

## Phase B: bounded source-grounded discussion

### Task 6: Define cast, source retrieval and generation contract

**Files:** Create `src/server/discussion/cast.ts`, `source.ts`, `context.ts`, `contracts.ts`, `tests/unit/discussion-context.test.ts`; extend `src/server/data/schema.ts` with source passages/guest identities through `migrations/0003_discussion.sql`.

**Interfaces:** `Passage = { id: string; text: string; start: number; end: number }`; `Persona = { id: string; name: string; handle: string; kind: 'regular' | 'guest'; voice: string; version: number }`; `getCast(threadId: string): Persona[]`; `splitSource(text: string): Passage[]`. `buildContext(snapshot: ThreadSnapshot, input: TurnInput, memories: MemoryContext[], personas: Persona[]): GenerationContext`; define `MemoryContext = { id: string; personaId: string; text: string; evidenceIds: string[]; epoch: number }`. GenerationContext includes bounded messages, allowed speaker/parent/passage IDs, revision snapshot and memory epoch. `validateExchange(raw: unknown, context: GenerationContext): Exchange` rejects unsafe shape/citations/parents; Exchange comments use temporary batch IDs to reference earlier comments only.

- [ ] Write `stable_cast_varied_speakers`, `quiet_posts_required`, `source_injection_is_context`, `fake_citation_rejected`, `legacy_no_source`, `oversize_context_honest`. Assert four regular IDs stable, guests scoped to thread, source offsets roundtrip, unknown passage IDs reject, later-parent cycles reject and no available-source claim for missing text.
- [ ] Run `pnpm exec vitest run tests/unit/discussion-context.test.ts`; expect red.
- [ ] Implement versioned archetypes from spec. Define JSON exchange schema with speakerId, postId, parentId/batchParentId, text, passageIds; input bounds include system/persona/context text. Conservatively estimate tokens with a compatible tokenizer or safe UTF-8 byte upper bound; never silently truncate the target comment. Select relevant paragraphs and limited ancestry/recent comments; explicitly flag incomplete source context. Prompts distinguish tone from agreement and article claims from established facts. Do not rely on prompt instructions alone for authorization.
- [ ] Run tests; add offline reviewed prompt fixtures for sarcasm, anger, factual errors, ambiguous humor, concessions and misinformation in the source. Structural validation cannot prove factual entailment: document human review of actual model samples in Task 12.
- [ ] Commit as `feat: define source-grounded AI participant contracts`.

### Task 7: Reserve AI turns and enforce budgets atomically

**Files:** Create `src/server/discussion/turns.ts`, `budget.ts`, `src/server/data/settings.ts`, `src/routes/api.settings.ts`, `tests/worker/turn-budget.test.ts`, `migrations/0004_turns.sql`; extend data schema with turns, usage and account AI/consent settings.

**Interfaces:** `reserveTurn(p,u,input: TurnInput): Promise<TurnState>`; `cancelTurn(p,u,id: string): Promise<TurnState>`; `getTurn(p,u,id: string): Promise<TurnState>`; `settleTurn(p,u,id: string,usage: ProviderUsage, outcome: 'complete' | 'failed' | 'stale'): Promise<void>`. `ProviderUsage = { inputTokens: number; outputTokens: number; estimatedCostMicros: number }`. Reserve the configured worst-case spend before calling provider; pricing configuration belongs on server.

Also export `getSettings(p,u): Promise<AccountSettings>` and `updateSettings(p,u,patch: { aiEnabled?: boolean; memoryEnabled?: boolean; acknowledgeConsent?: boolean }): Promise<AccountSettings>`. GET/PATCH `/api/settings` is owner-scoped; consent timestamp is generated by the server after acknowledgement. Defaults are AI off, memory off and no consent. Tasks 8-9 consume these interfaces; Task 11 extends privacy controls.

- [ ] Write `thirty_turn_daily_cap`, `five_openings_cap`, `three_account_one_thread_active`, `duplicate_request_single_reservation`, `utc_rollover`, `crash_lease_expires`. Concurrent Promise.all reservations must never exceed caps; duplicate opening for same source revision returns existing turn even from a new device. When pricing/ceiling is missing, AI fails closed with an actionable configuration status.
- [ ] Run `pnpm exec vitest run tests/worker/turn-budget.test.ts`; expect red.
- [ ] Implement conditional SQL/batched D1 writes and uniqueness for account/request and thread/opening/source revision. Leases expire after 90 seconds; stale completion cannot write after lease reclaim. Provider timeout is 45 seconds, at most one retry for transient 429/5xx/network failures within that deadline; no retry for auth/invalid output. Retrying the same failed request does not consume a second daily allowance but does reserve/record any new provider spend. Cancellation/timeout with unknown provider usage retains conservative spend accounting; do not falsely refund money.
- [ ] Run tests with concurrent requests, controlled clock and UTC boundary. Cancellation releases active slots and prevents late writes; AI-off/consent checks happen before reservation and at finalization.
- [ ] Commit as `feat: bound AI activity and reserve generation usage`.

### Task 8: Generate, validate and persist bounded DeepSeek exchanges

**Files:** Create `src/server/discussion/deepseek.ts`, `generate.ts`, `src/routes/api.ai.turns.ts`, `api.ai.turns.$turnId.ts`, `tests/worker/generation.test.ts`, `tests/unit/deepseek.test.ts`.

**Interfaces:** `callDeepSeek(p: Platform, context: GenerationContext, signal: AbortSignal): Promise<{ exchange: unknown; usage: ProviderUsage }>`; `runTurn(p,u,input: TurnInput,signal: AbortSignal): Promise<TurnState>`. POST `/api/ai/turns` runs one bounded turn; GET `/api/ai/turns/$turnId` retrieves status, DELETE cancels. GET never generates. POST rechecks trigger ownership and persists no human comment itself (Task 4 does that first).

- [ ] Write `human_comment_survives_provider_failure`, `three_replies_max`, `opening_leaves_quiet_post`, `reload_no_regeneration`, `edited_source_stales_result`, `cancel_blocks_late_result`, `invalid_json_no_comments`. Assert returned comments and parent links persist exactly once; reject guest attempts to acquire regular memory and untrusted AI authorship. Empty/truncated provider content is a recoverable generation failure, not an empty success.
- [ ] Run `pnpm exec vitest run tests/worker/generation.test.ts tests/unit/deepseek.test.ts`; expect red.
- [ ] Implement server-only fetch to official DeepSeek Chat Completions, model `deepseek-flash`, JSON response format, max output 1,200, no tools/search, and bounded input from Task 6. Use JSON schema runtime validation before storage. Finalization rechecks revision, lease, cancellation, account AI settings and memory epoch inside guarded database writes; all batch comments commit atomically before response. Failures settle Task 7 accounting without revealing private provider payloads. Request abortion on browser departure stops provider work where possible and guarantees no unobserved continuation beyond the lease/timeout; no detached generation loop.
- [ ] Run tests with injected fake HTTP provider (no charge/keys), including 429 retry, 401 no retry, timeout and a second device editing during response. Explicitly verify reading and manual comments still work when keys/budget are missing.
- [ ] Commit as `feat: generate bounded private DeepSeek discussions`.

### Task 9: Integrate per-post discussions and consent into the reader

**Files:** Create `src/features/discussion/Discussion.tsx`, `CommentItem.tsx`, `CommentComposer.tsx`, `useDiscussion.ts`, `ConsentNotice.tsx`, `tests/unit/discussion-state.test.ts`; modify `src/components/Post.tsx`, `Threadly.tsx`, `src/style.css`.

**Interfaces:** `Discussion({ threadId, postId }: { threadId: string; postId: string })` uses owner-keyed snapshots and turns. `useDiscussion(threadId: string, postId: string)` exposes comments, submit(input: AppendCommentInput), replyToId, generate(input: TurnInput), cancel(turnId), retry(requestId), pending/error. Consume Task 7 settings GET/PATCH for explicit consent and AI/memory opt-in; Task 11 extends the privacy interface.

- [ ] Write `comment_saved_before_ai`, `reply_to_ai_keeps_parent`, `ai_label_always_visible`, `expired_session_preserves_draft`, `account_switch_aborts_display`, `no_consent_no_provider`: assert no generation before successful comment storage; first consent is required before any opening/provider call; signout clears private caches and invalidates stale async responses.
- [ ] Run `pnpm exec vitest run tests/unit/discussion-state.test.ts`; expect red.
- [ ] Reuse existing lead composer and later-post reply affordances, replacing only signed-in owned-thread reply persistence. Keep guest local replies unchanged. Render previews/expandable connected comments with shallow indentation, human names, AI labels and source references. New synced thread creation requests opening once after consent; imported threads use explicit Start discussion. React Query retries for generation mutations must be disabled; reuse server request IDs for deliberate retry. Provide keyboard-accessible cancel/retry/error states and pause AI entry; no fake counts/typing delays. Keep source author and exports intact.
- [ ] Run tests/typecheck; browser-check first/later-post and AI-to-AI replies, three/four-comment bounds, one quiet post, cancellation, 390px reading, keyboard focus, reduced motion, missing keys, and return from another tab. Never show another account's pending result. No token streaming is required.
- [ ] Commit as `feat: add per-post AI conversations to the reader`.

## Phase C: memory, privacy and end-to-end verification

### Task 10: Persist relevant recurring-participant memory

**Files:** Create `src/server/discussion/memory.ts`, `tests/worker/memory.test.ts`, `migrations/0005_memory.sql`; modify `context.ts`, `contracts.ts`, `generate.ts`, data schema and `CommentItem.tsx`.

**Interfaces:** `getRelevantMemories(p,u,input: { personaIds: string[]; text: string; limit: number }): Promise<MemoryContext[]>`; `applyMemoryUpdates(p,u,turnId: string,epoch: number,updates: MemoryUpdate[]): Promise<void>`. `MemoryUpdate = { personaId: string; text: string; evidenceIds: string[] }`; extend Exchange with `memoryUpdates: MemoryUpdate[]` (max two, max 600 characters each). Task 9 comment DTO gains `usedMemoryIds: string[]` through explicit schema migration/DTO update.

- [ ] Write `regular_recalls_cross_thread`, `guest_has_no_cross_thread_memory`, `different_owner_no_memory`, `clear_epoch_blocks_inflight_update`, `memory_disabled_no_read_or_write`, `deleted_evidence_not_retrieved`. Assert each item links to owned existing evidence, uses current epoch and is excluded once its evidence/reset cutoff invalidates it.
- [ ] Run `pnpm exec vitest run tests/worker/memory.test.ts`; expect red.
- [ ] Use simple bounded lexical retrieval (max four relevant items total, not vector infrastructure) filtered by owner/persona/epoch. Keep memory extraction in the same bounded structured model response and token budget, generated only for participating regulars. Validate evidence IDs and reject unsupported sensitive inferred profiles. Pass only selected memory; attach used IDs to comments so the user can inspect context. Account history remains distinct from derived memory. Commit valid memory updates with the finalized turn only; stale/cancelled generations write neither comments nor memory.
- [ ] Run tests and generation tests; demonstrate a corrected earlier argument recalled in a new thread, no memory for guests, and a memory reset during a delayed provider response. Human-review samples for false autobiographical claims or confident unsupported remembered facts.
- [ ] Commit as `feat: add inspectable recurring AI memory`.

### Task 11: Add memory, AI and deletion controls

**Files:** Create `src/routes/api.memory.ts`, `api.account.ts`, `src/features/account/PrivacyPanel.tsx`, `tests/worker/privacy.test.ts`; modify `src/server/data/settings.ts`, `src/routes/api.settings.ts`, `threads.ts`, `auth.ts`, schema/migrations as needed, `AccountPanel.tsx` and discussion UI.

**Interfaces:** Reuse Task 7 settings signatures. Add `clearMemory(p,u,personaId?: string): Promise<void>`; `deleteConversation(p,u,threadId: string,postId: string): Promise<void>`; `deleteAccount(p,u,request: Request): Promise<void>`. GET/PATCH settings, GET/DELETE memory, DELETE account require Task 2 session checks; account deletion requires recent reauthentication. The memory route also supports DELETE by item ID and conversation deletion uses an owned post ID; never accept arbitrary owner IDs.

- [ ] Write `memory_clear_not_rebuilt_from_old_history`, `conversation_delete_cleans_evidence`, `ai_pause_cancels_pending`, `account_delete_removes_owned_rows_sessions`, `guest_survives_account_delete`: assert affected epochs increment, old provider results rejected, dependent memory/used references invalidated, and no browser account cache survives logout/deletion. Reset one regular's memory without clearing another's.
- [ ] Run `pnpm exec vitest run tests/worker/privacy.test.ts`; expect red.
- [ ] Implement pause AI, pause cross-thread memory, inspect/delete memory item, reset one/all regulars, delete conversation/thread and account flows. Add reset cutoffs per participant plus account epoch for in-flight invalidation; deletion suppresses new automatic opening generation unless explicitly restarted. Clean dependent turn payloads/import mappings/read states and memory evidence. Do not erase unimported guest data. Keep concise disclosure of DeepSeek/Cloudflare processing and provider/backup retention. Account source/history deletion must not leave private excerpts in derived tables.
- [ ] Run privacy/generation/memory tests; browser-check confirmation focus, cancellation and readable errors, then two-account access after deletion. Confirm clearing memory does not delete saved threads and disabling memory does not stop ordinary history sync.
- [ ] Commit as `feat: add discussion privacy and memory controls`.

### Task 12: Verify the integrated feature and document operating limits

**Files:** Create `tests/worker/journey.test.ts`, `scripts/ai-evaluation.mjs`, `docs/ai-evaluation.md`, `docs/cloudflare-setup.md`; modify `scripts/smoke.mjs`, `README.md`, package test scripts. Add no real source text or credentials to fixtures.

**Interfaces:** `pnpm test` runs all deterministic unit and local-Workers tests. `pnpm evaluate:ai` is an explicitly invoked opt-in live evaluation, defaults to dry-run and enforces a fixed request/spend cap. It must not run in ordinary CI/smoke. Evaluation uses public synthetic fixtures only.

- [ ] Write journey assertions for two independent sessions: signup/verify, explicit legacy import, new owned thread, mixed opening comments, human reply -> bounded exchange, second-device load/edit, recurring memory in a new thread, memory clear, deletion and logout. Add old guest generation/media/export smoke assertions. Run `pnpm exec vitest run tests/worker/journey.test.ts` and verify the incomplete journey fails before final wiring fixes.
- [ ] Complete only integration gaps exposed by those assertions; do not add future sharing, billing or a provider framework. Expose safe usage/remaining-quota status to the owner without raw prompts or private logs. Document local setup, migrations, secret names, account import, recovery, limits and the public-domain/email prerequisites in README/setup notes.
- [ ] Run `pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm build`, `pnpm smoke`; expect all pass with no real external requests. Exercise signup/reset, AI missing-key/failure, offline drafts, themes, edits, PNG all/individual/selected, and 390px/desktop with browser tools. Test Worker CPU using platform observability before declaring free hosting feasible; local wall-clock timings alone are not CPU-limit evidence.
- [ ] When credentials/domain are available and the user authorizes live verification, run a capped public-email delivery check and live DeepSeek tone/factual-grounding rubric; assess wit, factual honesty, non-escalation, distinct voices and memory accuracy. Until then label production email delivery, model quality and free-tier CPU qualification as unverified, not passed. No automatic provisioning, billing or deployment.
- [ ] Save evidence and known limits in docs/local devlog. Commit as `test: verify private AI discussion and account journeys`. Follow applicable review/branch-finishing skills before integration; do not push without user request.

## Execution order, checks and boundaries

Tasks 1-5 form a working accounts/synced-library milestone, Tasks 6-9 add bounded AI discussions, and Tasks 10-12 complete memory/privacy and qualification. These are dependent parts of the approved design, so one plan keeps their shared contracts visible; do not dispatch incompatible schema tasks simultaneously. A milestone may be stopped/reviewed independently without pretending the whole feature is finished.

At execution start invoke the chosen execution skill and follow its worktree/isolation instructions. Preserve ignored local skills/context in the canonical checkout; a new worktree may not contain them. Resolve canonical read-only instruction paths explicitly rather than copying secrets, dependencies or guest data. Current main has the local design commit `f543ee7`, which is part of the execution base. Recheck branch/status before any worktree action.

For each task: write meaningful failing tests, confirm red for the intended reason, implement, confirm green, and update local context. No app tests were run while writing this plan; test names, files and commands above describe future work, not existing passes. Dependency setup belongs to execution, not this planning turn.

## Self-review and approval

Coverage checked: account/email -> 1-3; owned persistence/import/sync -> 4-5; cast/source/tone -> 6; quotas/concurrency -> 7; bounded provider flow -> 8; reader/consent -> 9; cross-thread memory -> 10; privacy/deletion -> 11; end-to-end/runtime quality -> 12. Every Review Focus item has a named test in its owning task. Interfaces share DTOs rather than redefining records. Production prerequisites remain explicit without blocking local mocked development.

Design approval is recorded. Plan review and execution method are still pending. No product source, dependencies, cloud resources or hosted deployment have been changed by writing this plan.

## References checked while planning

- Cloudflare TanStack Start guide: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
- Better Auth Drizzle adapter (SQLite provider): https://better-auth.com/docs/adapters/drizzle
- DeepSeek JSON output requirements and empty-output caveat: https://api-docs.deepseek.com/guides/json_mode/

Recheck exact package compatibility at Task 1; documented APIs are not substitutes for runtime tests.
