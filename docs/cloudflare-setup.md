# Cloudflare setup and operating limits

The implementation is local-first and has not been deployed or qualified for a free production plan. Do not create resources, enable billing, redeem a domain or deploy as part of ordinary setup or checks. Preserve the existing local hosting identity. Remote D1 binding access is disabled in the checked-in local configuration.

## Local setup

Install the package.json Node/pnpm versions, run `pnpm install --frozen-lockfile`, then `pnpm db:migrate`. Wrangler applies only pending local migrations from `drizzle/migrations` into `.wrangler`; it does not create remote resources. Current migrations are `0001_auth`, `0002_auth_fence`, `0003_reading`, `0004_import`, `0005_discussion`, `0006_turns`, `0007_discussion_ui`, `0008_opening_admissions`, `0009_memory` and `0010_privacy`. Do not skip privacy/auth triggers or copy an earlier partial schema. Back up local persisted data before intentional destructive maintenance.

Run `pnpm dev:mail` and `pnpm dev` in separate terminals. The app is [loopback 4173](http://127.0.0.1:4173), capture is loopback 4187, and captured mail files are ignored under `work/dev-mail`. Capture has no HTTP message-reading API. Open the latest file locally; do not copy tokens/recipients into logs or reports. Signup is not proof of email delivery or verification. Sign-in and protected APIs require verified email. A forgotten password uses the account dialog's reset request and captured link; links expire after one hour and reset tokens are single use. Reset revokes all older sessions; failed later writes may require a new reset link.

Use ignored `.dev.vars` for local Wrangler secret bindings; `.env.example` lists placeholders but is not a credential store. Never commit `.env`, `.dev.vars`, capture files or production credentials. The development fallback auth secret is ephemeral; set a stable random secret for persistent sessions. Use the same hostname for auth URL and browser. Browser cookies ignore ports: use a separate localhost hostname/profile and database for automated QA, never a second 127.0.0.1 port against a user's active cookie jar.

## Configuration names

| Name                                   | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `DB`                                   | D1 binding; checked-in all-zero ID is a local placeholder                          |
| `BETTER_AUTH_URL`                      | Canonical app origin; HTTPS in production                                          |
| `BETTER_AUTH_SECRET`                   | Server-only random signing secret, at least 32 characters in production            |
| `EMAIL_TRANSPORT`                      | `capture` in loopback development; `resend` in production                          |
| `RESEND_FROM`                          | Sender address on a verified owned domain                                          |
| `RESEND_API_KEY`                       | Server-only Resend credential                                                      |
| `DEEPSEEK_API_KEY`                     | Server-only DeepSeek credential; absent means AI unavailable                       |
| `AI_ENABLED`                           | Global generation switch; default false                                            |
| `AI_DAILY_SPEND_LIMIT_USD`             | Operator UTC-day ceiling; default zero                                             |
| `AI_WORST_CASE_COST_MICROS`            | Conservative total cost reservation per generation, including its permitted retry  |
| `AI_EVALUATION_WORST_CASE_COST_MICROS` | Separate reservation for the explicit evaluation script, which performs no retries |

Micros mean millionths of USD. An operator must choose a valid conservative cost estimate against current provider terms; an arbitrary small reservation cannot guarantee actual billing. Token usage is recorded from provider responses where available, and spend remains reserved conservatively even when output fails, is cancelled or data is deleted. Anonymous spend records survive account deletion so deletion cannot refund global budget. No raw prompts, private source or secrets are included in owner usage status. `/api/usage` is verified-owner-only, readonly, private/no-store and returns that owner's daily counts plus generic availability. Counts are advisory; atomic admission rechecks quotas, thread/account concurrency and operator ceiling.

## Production prerequisites (deferred)

Before a separately authorized launch, choose a public HTTPS origin, provision the intended D1 resource and apply all migrations there, set server secrets through the hosting platform, and configure a verified Resend sending domain/address with correct DNS. A public domain and valid sending credentials are required for real email acceptance. Development capture is rejected outside loopback development; production auth fails closed without valid secret/email settings. No live sending or model evaluation is authorized merely by finding credentials on disk.

Test delivery only with an explicitly authorized public test recipient and a capped check; never private user content. Separately authorize the capped [AI evaluation](ai-evaluation.md). Check deployed billed CPU through actual platform observability before choosing free hosting. No paid plan is enabled automatically.

## Import, sync and recovery

Guest records remain device-local unless the owner chooses import from Saved threads. Imports are owner-scoped, resumable and deduplicated using the local identity/migration marker; an older record without source remains source-missing. Do not invent source or treat guest data as already consented for AI processing. Imported local replies become human comments. New signed-in threads are owned saves; discussion creation uses an explicit one-shot handoff only when AI consent/settings permit it. Revisit, focus and status reads do not create another opening.

A second device loads D1 snapshots. Post edits use expected revisions; a conflict keeps the local draft for review instead of overwriting a newer edit. In-flight generation is fenced by source/settings/memory revisions. Offline unsent edits/comments remain local drafts; deliberately retry after reconnection. Reauthentication with the same owner can recover a draft; signout/account switching clears account-private caches/drafts and cancels work. Guest saved data stays separate.

AI pauses and unavailable keys/budgets do not prevent reading or storing human comments. AI failures do not erase the triggering human comment. The provider operation has a 45 second total deadline with at most 1 retry on 429, 5xx or network failure; no retry on authentication errors or invalid output. Each retry is inside the existing reservation. Outputs must pass schema, ownership, parent/citation and count checks before atomic publication.

Memory is bounded whole human quotes, one evidence ID and up to 600 characters per item; at most 2 updates per turn. Retrieval considers at most 200 valid candidates and supplies at most 4 relevant items. A maximum 200-item management window is not a promise that all historical memory is shown at once. Pausing memory prevents model retrieval/writes while explicit owner inspection remains available. Item suppression, persona/global reset cutoffs and epochs prevent old-history resurrection. Conversation/thread deletion invalidates dependent memories; account deletion requires current-password verification, throttle and credential/session fencing, removes owned rows/sessions and preserves anonymous spend. Provider/backups may retain data under their separate policies.

## Local validation and CPU qualification

`pnpm typecheck`, `pnpm check`, `pnpm test`, `pnpm build` and `pnpm smoke` use no real DeepSeek or Resend requests. Tests use disposable local D1 and actual auth handlers with fake HTTP. Smoke owns a temporary 4185 preview and cleans up its own process tree. `pnpm evaluate:ai` is dry-run by default and is not included in CI/smoke. Windows requires a compatible Microsoft Visual C++ x64 runtime for workerd; this machine required a separately approved runtime update to 14.44.35211.0. Do not silently modify host settings to make tests pass.

Earlier local process-CPU measurements (2026-10-27, Windows x64, Node 24.22.1, workerd 2026-10-23) recorded warm batch means of 11.406 ms for dashboard SSR and 19.375 ms for synthetic 999552 byte HTML extraction. Secure default scrypt hash/verify measured 75.781/74.219 ms mean process CPU with N=16384, r=16, p=1, 64-byte output. `scripts/profile-worker.mjs` and `scripts/profile-auth.mjs` are bounded local probes; local wall time and process CPU include runtime/GC overhead and are not production billed CPU or free-tier evidence. Keep secure hashing intact. Production CPU, cold-start distribution and real upstream extraction remain unverified until an authorized deployed measurement exists.

An inherited `[vite:css-post] SOURCEMAP_BROKEN` build warning has no established cause within this integration task. Build success does not remove that warning or establish production qualification; framework upgrades or warning suppression are outside this narrow verification work.
