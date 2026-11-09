<img src="public/brand/threadly-mark.svg" alt="Threadly logo" width="80" height="80">

# Threadly

Threadly turns articles, pasted text, and TXT or Markdown files into editable reading threads written by DeepSeek `deepseek-flash`. Guests can create two threads total in the same browser; verified accounts receive ten generation credits per UTC day. Accounts also add private saved-thread sync and optional AI discussions.

## Features

- Import a public article URL, paste text, or upload TXT/Markdown up to 1 MB; the generation source must fit 100000 UTF-16 code units. Choose depth and a maximum thread length. Existing article extraction runs first; DeepSeek Fetch recovers insufficient article content before AI writing.
- Read source posts in a separate tab/window, open a post and its replies, edit through the post menu, copy or download text, and export all, individual, or selected posts as themed PNGs. Long exports become numbered PNG pages in a ZIP.
- Keep a guest library on this device, or explicitly import chosen device copies into a verified account. Login never silently imports guest text.
- Sync private account threads, source, edits, reading progress, reactions and discussions across devices. Reading progress advances quietly after sustained post visibility; it does not edit source or start AI work. Revision conflicts preserve drafts for deliberate recovery.
- New accounts acknowledge AI processing at signup and start with AI discussion on and memory off. Account owns pause/resume and processing acknowledgement for existing accounts; saved Pause choices stay paused. Clearly labeled fictional AI participants include four recurring voices and thread-specific guests; some posts remain quiet.
- Inspect remembered quotes and supporting conversations, delete individual memories, reset a regular or all memory, pause AI/memory, delete conversations or remove the account using the current password.
- Choose White, Gray, Dim, Dark or Paper, custom colors, keyboard controls and reduced-motion support. The X-style reader and local fonts remain intact.

## Run locally

Requires Node.js 22.12+ and pnpm 11 (pinned version in package.json). No cloud resources or AI credentials are required for existing guest reading, exports and synthetic checks. Creating new threads requires a server-side DeepSeek key, AI enabled and a sufficient operator budget.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev:mail
# In another terminal:
pnpm dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The local Workers server uses persisted local D1; remote bindings are disabled. Local email capture listens on loopback 4187 and writes ignored JSON files under `work/dev-mail`; open the captured file locally for its verification/reset link. It does not send email or expose a message-reading endpoint. Use a stable random `BETTER_AUTH_SECRET` in ignored `.dev.vars` to retain local sessions across restarts. See [setup and operating limits](docs/cloudflare-setup.md) for binding names, all migrations, recovery and production prerequisites.

```sh
pnpm build
pnpm preview
```

Preview uses loopback 4173 too; stop your own development server first. Rebuild after source changes. These commands neither deploy nor provision resources. Windows workerd requires a current Microsoft Visual C++ x64 runtime.

## Checks

```sh
pnpm typecheck
pnpm check
pnpm test
pnpm build
pnpm smoke
pnpm evaluate:ai
```

Normal checks use synthetic fixtures, local D1 and fake provider/email responses. `pnpm test` includes actual Better Auth sessions and local Workers journeys; its temporary app is independent of your development server. Smoke starts an owned production preview on 4185 and tests SSR, reader routing, static assets, private APIs and private-address rejection. Build before smoke.

`pnpm evaluate:ai` defaults to a network-free dry run. Live evaluation requires a separate explicit `--live`, credentials, a conservative cost reservation and user authorization; never run it in ordinary CI/smoke. [Evaluation instructions and qualification](docs/ai-evaluation.md) explain the caps, human rubric and unverified checks.

## Architecture

TanStack Start/Router/Query, React and TypeScript run on Cloudflare Workers with local/production D1 bindings and Better Auth 1.7.14. Article extraction/media proxy and generation are server routes; canvas export remains framework-independent. Drizzle migrations in `drizzle/migrations` define auth, ownership, turns, memory and deletion fences.

`src/server/auth` owns email/password identity; `src/server/data` owns verified owner authorization and persistence; `src/server/discussion` owns bounded context, turns, provider validation and memory. `src/server/thread-generation` owns browser identity, generation quota, source recovery, provider validation and job lifecycle; `src/features/generation` captures identity for creation and recovery. `src/features/account` and `src/features/discussion` provide the account and discussion interface. `src/routeTree.gen.ts` is generated by TanStack Router; edit authored routes instead. `pnpm cf-typegen` regenerates Workers binding declarations after configuration changes.

## Privacy and processing

Creating any new thread sends the source through the server to DeepSeek for AI writing after the visible processing notice. URL import first retrieves the public article on the server; insufficient retrieval can send that URL to DeepSeek Fetch. The retained source and attribution identify the original material, while the thread is AI written. Source images can use the media proxy. Fonts are served locally. Guest saved threads/appearance use local storage and active guest readers use session storage.

Verified account saves store source, posts, comments and settings in Cloudflare D1. AI is separate and requires consent: relevant source passages, posts, comments and selected remembered quotes are sent by the server to DeepSeek. Private means other app users cannot access your content; processing is not exclusively on-device. Keys/passwords/full prompts are never browser configuration or application logs. Provider and backup retention are separate from application deletion.

Signout clears account browser caches/drafts and stops pending work, while guest records remain. Offline cached reading and local unsent drafts are supported; reconnect and deliberately retry. Drafts are not a background synchronization queue. Memory contains whole human quotes of at most 600 characters, linked to one supporting comment, rather than inferred personal profiles. Disabling model memory prevents its retrieval/writes; owner inspection and deletion remain available while paused. Reset cutoffs and evidence suppression prevent older history immediately recreating erased memories.

## Generation allowance and recovery

A credit counts one complete, validated generated thread. Guests receive two total successes for the server-held browser identity; their allowance never resets daily. On the first verified sign-in from that browser, completed guest usage is claimed once against that UTC day: one guest result leaves nine account credits, and two leave eight. Later UTC days start with ten account credits. Repeated sign-in, tabs and explicit imports do not charge the same guest result again. Deleting a thread never refunds a completed generation.

Pending creation reserves a credit. Failure or cancellation releases that user credit while retaining a conservative provider-spend reservation. Claiming the guest identity cancels its pending work and keeps the source for an explicit account retry. A browser cookie identifies an installation, not a person: deleting cookies or using another device can establish a new guest identity. The shared operator budget bounds exposure; there is no fingerprinting.

Create first obtains an identity and admits a job without paid work, then explicitly executes the known job. Status checks and reload recovery never start provider work. Cancel, signout, expired sessions and identity changes fence late publication. Retained result/source payloads expire after 24 hours; failed or cancelled private payloads are cleared immediately. Keep a saved copy of a completed thread.

## Limits and qualification

- One active generation per identity and three combined AI operations per account. Generation has a 120 second overall execution deadline, a 180 second lease, one transient model retry and at most one successful Fetch. Invalid output never becomes a partial thread or a deterministic substitute.
- Five discussion openings and 30 human-triggered AI turns per account per UTC day; one active turn per thread and three per account. Account shows remaining allowances. Status reads never generate. Failed attempts retain conservative spend reservations; retry does not repeatedly consume the same logical allowance.
- Openings contain 0-4 comments on at most 3 posts and leave a quiet post when multiple exist; replies contain 1-3 comments with at most 2 speakers. No unattended or polling-triggered generation.
- Context has a conservative 12000 input-token upper bound; provider output is capped at 1200 tokens, including at most 2 memory updates. Byte limits are conservative bounds, not measured token counts. Provider calls have one shared 45 second deadline and at most 1 transient retry.
- Global AI-off, missing configuration, quotas and operator budget failures block new AI creation while existing reading, exports and manual account comments remain available. Server-side atomic admission is authoritative; displayed status is advisory.
- Summaries may omit context, and article claims are not independent verification. AI quality, wit, factual honesty and memory accuracy need authorized real-model review.
- Paywalled/protected/JavaScript-dependent articles may need pasted text. Media playback and remote image exports depend on source availability; PNG uses static representations.
- Popup blocking may require Open thread. Real phone behavior remains unverified.
- Production Resend delivery, actual DeepSeek quality and deployed billed Workers CPU/free-tier feasibility remain unverified. Local CPU measurements are described in setup notes; secure password hashing was not weakened. An inherited Vite CSS source-map warning remains documented.

Optional sharing with other real users is deferred; there are no public discussion permissions, invitations or multiplayer comments. Domain purchase, student offers, cloud provisioning, paid plans and deployment require a separate decision. Preserve the existing local `.openai/hosting.json` identity; prior hosting has not been redeployed by this work.

## Fonts, assets and local files

Jersey 25 is used for interface headings and Chirp for reading content. See [font sources and notices](public/fonts/FONT-SOURCES.md) and [brand provenance](public/brand/README.md). Chirp provenance does not grant redistribution rights. No project-wide software license is currently declared.

Dependencies, builds, secrets, hosting identity, devlog, local project context and agent instructions remain local-only. Review explicit staged files before publishing; excluding a file does not remove it from earlier history.
