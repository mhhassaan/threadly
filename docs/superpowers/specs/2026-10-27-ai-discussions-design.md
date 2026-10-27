# Threadly: private AI discussions and account sync

Date: 2026-10-27
Status: Draft for user approval. No product implementation authorized by this document yet.

## Intent

Make reading a summarized article feel like entering a thoughtful, sometimes playful discussion. People can comment on any post and receive replies from distinct AI participants. Those participants can challenge arguments, support the reader or one another, and remember relevant conversations across threads and devices.

This is a private reading experience. Human-sounding writing must not imply real people are participating: every synthetic participant remains visibly labeled AI.

## Decisions made by the user

- Keep the existing TanStack Start/Router/Query, React and TypeScript app.
- Use DeepSeek, initially model `deepseek-flash`.
- Use Cloudflare Workers for hosting/server execution, D1 for storage, and Better Auth for accounts.
- Start with email/password authentication. Use Resend for verification/reset delivery.
- Defer buying/redeeming a domain. The user has GitHub Student Developer Pack access and can claim an eligible domain later.
- AI replies respond to the comment's meaning and tone: playful sarcasm for sarcasm, evidence for factual arguments, calm reasoning for anger. The examples are guidance, not a rigid classifier.
- Participants can disagree with the human or each other, concede points and change position.
- Writing can include contractions, slang, abbreviations, lowercase sentences and varied punctuation when natural.
- Have 3-4 recognizable recurring personalities, appearing selectively, plus occasional fresh participants.
- Some posts begin with AI comments; other posts remain quiet.
- Sometimes participants exchange replies among themselves; sometimes they wait for the human.
- Preserve past conversations and recurring participants' memory across threads.
- Accounts sync saved threads, reading history, discussions and AI memory across devices.
- Discussions are private for now. Future sharing may allow other real users to participate; do not implement it in this version.

## Current project and change boundaries

`src/components/Threadly.tsx` owns generation, browser persistence, reader interactions and reply dialogs. `Post.tsx` renders the existing X-style post detail layout and lead-post reply composer. `src/lib/thread.ts` stores posts as strings and replies as local text/date entries under positional interactions. New thread records contain original `sourceText`; older records may lack it.

Current saving uses `threadly-library` localStorage and reader sessionStorage. There is no auth, database or AI integration. Preserve this data, article/media extraction, source identity, text editing, themes, fonts and PNG/text exports. Keep extractive thread generation working without DeepSeek; AI discussion is a separate feature.

The existing app runs locally with Node/Vite. Cloudflare deployment requires adapter/binding/configuration changes and runtime validation; it is not already deployment-ready. Preserve `.openai/hosting.json` without attempting to reuse its old deployment configuration as a Workers adapter.

## Approaches considered

| Approach | Benefit | Tradeoff | Outcome |
| --- | --- | --- | --- |
| Supabase Auth + PostgreSQL | Integrated managed auth/storage | Another managed service and its quotas | Considered, not chosen |
| Better Auth + PostgreSQL, e.g. Neon | Flexible TypeScript auth with relational storage | Separate hosting/database setup | Considered, not chosen |
| Cloudflare Workers + D1 + Better Auth | App execution and storage on Cloudflare; reusable auth library | Worker runtime/CPU constraints; implement authorization and sync ourselves | Chosen by user |

DeepSeek remains a remote API called by the server, not a model hosted on Cloudflare. Better Auth identifies the account; application authorization restricts every private read/write to the account owner. D1 uses SQLite semantics, not PostgreSQL RLS.

## Proposed defaults for approval

The following are design proposals, not earlier user commitments.

### Reading, accounts and email

- Preserve guest article/text/file generation and reading locally. Account sync and AI discussions require a verified account.
- Signup collects display name, email and password; verification link establishes email ownership. Provide login, logout, resend verification and forgot/reset-password flows.
- Use Resend's HTTPS API from Better Auth callbacks rather than SMTP sockets. Keep delivery work alive with supported Workers request-lifetime handling. Failure must be visible and retryable; never claim delivery merely because signup succeeded.
- Keep Resend, DeepSeek and auth signing secrets server-side. Never log passwords, tokens, raw private source text or full model prompts.
- Use local email capture/mocks and a local D1 database for development until public sending is configured. Real public signup acceptance requires a verified sending domain and production secrets later; the domain purchase does not block local implementation.
- Offer to import existing local threads into the signed-in account; do not silently upload guest text. Signing out removes account-private browser caches and stops pending generation. Keep unimported guest records separate.

### AI cast and voice

Propose four regulars with stable IDs and versioned persona descriptions:

| Working archetype | Voice and habits |
| --- | --- |
| Skeptic | Concise, dry humor, challenges unsupported leaps |
| Analyst | Evidence-minded, precise, explains uncertainty |
| Conversationalist | Informal, relatable examples, playful when appropriate |
| Thoughtful challenger | Alternative interpretations, patient disagreement |

Names, handles and original avatars are implementation choices to review in the interface. Do not imitate real authors or identifiable people. These are voice tendencies, not permanent political positions or predetermined teams. All identities show an AI label wherever their comments appear, including reply notifications or future discussion exports.

Guest identities are unique to a thread, remain consistent inside that thread, and do not inherit the reader's private cross-thread memory. Avoid generating a new guest on every reply. The recurring roster is global product configuration; each user's relationships and memories are private to that user.

Match the situation, not every surface feature of the user's text. Do not force slang, deliberately degrade spelling, repeat canned phrases, or mock a serious concern. A factual answer may be longer and more structured than a joke. No invented lived experiences, credentials or real-world actions. Angry comments receive reasoned engagement; sarcasm should not become personal harassment. Do not manufacture controversy merely to make the thread look busy.

### Sources and reasoning

Each generation receives the relevant original-source passages, the target post, the reply ancestry, recent local discussion and only relevant participant memory. Store source paragraph IDs/offsets and retain original text separately from editable summaries.

Factual claims attributed to the article must point to valid source passages. Display a small source reference when a reply relies on a passage. The article itself can be wrong: distinguish "the article claims" from independently established fact. No browsing/tool retrieval in the initial version; fresh external claims cannot be presented as verified. If source text is missing on a legacy thread, explain the limitation and restrict replies to the available posts unless the user explicitly reimports the source. Do not silently fetch an old URL.

Source text, comments and memories are untrusted context, never instructions that can override the system/persona or access another user's data. Validate model output, parent references, selected identity and cited passage IDs on the server. Do not store or expose hidden chain-of-thought.

### Opening comments and conversation turns

- After a verified user creates a synced thread, one bounded opening pass may select interesting posts. Initial default: at most three posts and four comments in total, leaving at least one post quiet where there are multiple posts. A one-post thread can have zero or one opening comment. Some threads may have no opening comments.
- Run opening generation once per thread/source revision. Reloading, revisiting or signing in on another device must not regenerate it. Do not backfill every imported old thread automatically; offer an explicit start-discussion action.
- Posting a human comment first persists that comment. AI is supplementary: failures do not remove or duplicate it.
- Each human turn permits one to three AI comments, including AI-to-AI exchanges. Use no more than two speakers per turn by default. Speakers respond to content, do not always agree, and may stop after one substantive answer.
- An AI comment alone never starts another independent generation loop. All AI-to-AI exchanges belong to the bounded human turn or opening pass. No activity while the user is away.
- Propose one structured DeepSeek response containing a short ordered exchange, with explicit parents/speakers, rather than independent model calls for every personality. This reduces overhead and keeps a turn bounded. A validated batch is saved before being displayed; token-by-token streaming is deferred. Render promptly without fake human typing delays.
- Show a lightweight generating state, cancellation and retry. Cancellation keeps already-persisted comments. Retrying a failed turn uses the same request identity and cannot duplicate successful comments.

### Reader interaction

Retain the existing post column, source author identity and action rows. The lead composer starts a discussion on post one; every later post has its own reply entry. Expand a post's discussion on demand, with a small initial comment preview where opening comments exist. Replying to a comment preserves its parent rather than flattening everything onto the original post.

Use connected chronological replies with limited visual indentation on narrow screens. Attribute each comment to the human display name or named AI participant and label AI explicitly. Provide a reply action for follow-ups. Do not replace the article author's profile with an AI persona or fabricate engagement counts.

Keep original thread PNG/text exports behaving as before; exporting the entire discussion is deferred. Existing copy/share actions do not grant access to private discussions. No public discussion URLs in this version. Preserve keyboard operation, focus, readable statuses, reduced motion and stable controls. Visual styling will be checked against existing local Emil/mobile skills during implementation; this design does not approve a wholesale redesign.

### Memory and privacy

Store the full conversation history as user data, but do not send all past conversations to DeepSeek on every turn. Store compact recurring-participant memories with supporting comment IDs and timestamps: explicit preferences, earlier arguments and agreed corrections. Retrieve a bounded relevant set; preserve uncertainty and distinguish a user's stated view from an AI inference. Do not build inferred sensitive personal profiles.

When memory is used, provide a way to inspect the remembered item. Allow deletion of a conversation, clearing one participant's memory, clearing all AI memory, and account deletion. Clearing memory must not immediately recreate it from old conversations: maintain a reset cutoff and retrieve only eligible later material. Deleting comments/conversations removes or invalidates dependent memories and excerpts. Account deletion removes owned application data and auth sessions; disclose any provider/backup retention separately rather than claiming instant erasure everywhere.

Before the first AI interaction, disclose that relevant source text, comments and selected remembered context are sent to DeepSeek. Account sync stores that content on Cloudflare. Private means other app users cannot access it; it does not mean processing remains on-device. Offer an AI/memory pause control. Initial behavior: disabling AI prevents generation; disabling memory prevents reading/updating cross-thread memories while retaining ordinary saved history.

### Data and cross-device sync

Use stable IDs for threads, individual posts, comments and participants. Keep original local IDs as migration keys. Suggested entities:

- Better Auth-managed users, accounts, sessions and verification records, following the chosen adapter's schema.
- Owned threads and source text, individually identified posts, media references and revisions.
- Comments with thread/post ID, parent comment ID, human or AI author ID, text, server ordering, and generation-turn ID.
- Per-account read progress, reactions/bookmarks and saved-library state.
- Participant memories linked to their supporting comments and a memory-reset cutoff.
- Generation turns with request IDs, status, cancellation, revision snapshot and reserved usage.

Only the account owner can read or mutate a discussion. Server-generated AI authorship cannot be supplied by an untrusted client. Validate that a parent and target post belong to the same owned thread.

D1 is authoritative for signed-in data; TanStack Query handles client caching/refetching. Use server revisions/conditional updates for editable posts: reject stale overwrites and preserve the local draft for recovery. Comments append with idempotent IDs. Read progress can merge by most recent server-accepted update. Sync on focus and after mutations; live sockets are not required initially. A second-device edit during generation invalidates the result's source/post revision instead of publishing a reply to stale content. Signout/account switching must never reveal a previous account's cached data.

Import is explicit, resumable and deduplicated by account plus local record ID. Assign stable post/comment IDs to legacy positional data, preserve existing replies as human comments, and retain existing themes/media/edits. Never synthesize missing source text. A browser cache is not an offline sync engine: offline reading of cached records is supported; unsent comment/edit drafts stay local and require a deliberate retry after reconnection.

### Cost and execution boundaries

Proposed configurable starting limits: five new discussion openings and 30 human-triggered AI turns per verified account per UTC day; one active generation per thread; up to three simultaneous turns per account. Opening comments and follow-ups share a provider-spend budget. Use server-side atomic reservations so multiple devices cannot bypass quotas. Failure can release an unused reservation; retries must not double-charge the app quota.

Initial per-request ceiling: 12,000 total input tokens and 1,200 output tokens, with a maximum of three generated comments (four for the opening pass). Prefer brief replies, but allow enough space for a complete explanation. Source retrieval must include useful context; if necessary context exceeds the budget, acknowledge the limitation instead of pretending the entire source was read. Persona-memory updates are bounded and included in measured AI usage.

Measure actual provider token usage and expose remaining app allowance. Add an operator-configured daily spend ceiling and a global AI-off switch; monetary values are operational configuration, not hardcoded claims about DeepSeek prices. When limits are reached, keep reading and human commenting functional. These defaults require user approval as part of this draft.

Workers' free CPU allowance is a feasibility checkpoint, not a promise. Test password hashing/verification, SSR and large-article extraction in the actual runtime. Network wait for DeepSeek is different from CPU execution. Keep password hashing secure; do not weaken it to fit a free tier. If required, present measured results and the Workers Paid option before enabling billing. No paid plan, cloud resource provisioning, domain purchase or deployment is authorized by this design approval alone.

## Failure handling and verification

A missing AI key disables AI with an honest message; deterministic summaries still work. Expired sessions require sign-in without discarding a composed draft. Resend errors support resend and do not falsely verify an account. AI timeouts, invalid structured output and cancellation never lose human comments. Bound provider retries and duration; never retry indefinitely. Reject invalid citations/parents; display no unvalidated model HTML.

Acceptance evidence for implementation:

- Email signup/verification/login/logout/reset work; expired and reused links are rejected; server validates ownership across two test accounts.
- Cross-device retrieval includes thread edits, read progress, comments and participant memory without duplicate imports/turns.
- A thread has some quiet posts; recurring cast appear selectively; guests do not inherit personal memory.
- Tone fixtures cover playful sarcasm, factual correction, anger, ambiguity, agreement, disagreement and conceding a point. Human review checks that writing is varied and readable, not forced slang.
- Factual/source fixtures reject unsupported citations and context instructions; legacy missing-source cases remain honest.
- AI exchanges stop within the turn budget; retry, concurrency, cancellation and refresh do not produce duplicate or unbounded activity.
- Memory reset/deletion prevents reuse or accidental resurrection; account switching isolates caches.
- Existing typecheck, core/legacy checks, build and smoke pass, with additional auth/D1/runtime integration tests and desktop/narrow-screen accessibility checks.

## Scope, future goals and sequence

This is a substantial feature, delivered in stages within one approved design: account/runtime/storage foundation; explicit legacy import and sync; bounded source-grounded AI discussion; recurring memory; UI/cost/privacy verification. The implementation plan will define independently testable steps after design approval.

Out of scope now: public feeds, real-user multiplayer comments, sharing permissions/invitations, author impersonation mode, web browsing by AI, autonomous background discussions, multi-provider routing, semantic vector infrastructure, mobile native apps, and paid subscriptions.

Future goal: optional thread sharing where other real users can contribute. Stable owners, author IDs and reply relationships keep that possible. Do not create collaboration memberships, public access rules or realtime infrastructure prematurely. Any future sharing must explicitly address existing private memories and what a recipient can see.

## Builder discretion and approval

Implementation may choose the maintained D1 adapter/ORM, schema indexes, token estimation method, test tools and component boundaries, provided the selected stack and behaviors are preserved. Use the simplest reliable implementation; no microservices or general multi-agent framework is required for four voices from one model.

User review should particularly consider the proposed guest/verified-account boundary, four personality archetypes, one-to-three reply budget, opening frequency, daily quotas, memory controls, and Resend API transport. This document is not an implementation plan. After user approval, create that plan; do not begin product implementation or deployment before then.

## Technical references

- [TanStack Start on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
- [Workers runtime limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Better Auth TanStack integration](https://better-auth.com/docs/integrations/tanstack)
- [Better Auth database adapters](https://better-auth.com/docs/adapters/other-relational-databases)
- [Better Auth email callbacks](https://better-auth.com/docs/concepts/email)
- [Resend on Workers](https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

References were consulted during the preceding design discussion. Recheck versions, compatibility and current quotas during implementation planning. Promotional student benefits and domain redemption are deferred and are not architectural dependencies.
