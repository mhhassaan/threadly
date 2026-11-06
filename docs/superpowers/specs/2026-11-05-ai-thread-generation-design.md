# DeepSeek-written threads with article-fetch recovery

Date: 2026-11-05
Status: approved with guest-generation and quota amendments on 2026-11-05. Guests: 2 total; verified accounts: 10 per UTC day. Implementation underway.

## Goal
Replace deterministic thread creation with deepseek-flash for pasted text, uploaded text/Markdown and article URLs. Produce a concise but detailed reading sequence with complete thoughts and deliberate transitions, retaining source fidelity. User explicitly enabled local AI and selected existing extraction first with DeepSeek Fetch fallback.

## Approaches
Selected by user: keep the existing article extractor first; when it fails or produces insufficient usable article content, request that same public URL through DeepSeek Fetch. Every resulting source is written into a thread by deepseek-flash.
Alternative considered: DeepSeek Fetch first for every URL. Simpler retrieval path but an extra provider fetch on every article and less reuse of current media extraction. Not selected.

## Proposed user flow
Existing input modes, depth and length controls remain. Create my thread starts a server generation operation with clear preparing-source/writing feedback and cancellation. Open the reader only with a complete valid result; preserve input/draft and allow explicit retry after failure. No silent deterministic fallback.

User-approved amendment: guests may create up to 2 AI threads. Registration must carry their consumed guest allowance into the verified account allowance, rather than starting from zero. The user used an account total of 10 as an example: guest use of 1 becomes 1/10, and use of 2 becomes 2/10. User subsequently confirmed: 2 total guest generations and 10 verified-account generations per UTC day. At first verified sign-in/claim after registration, completed guest use is debited to that UTC day once: 2 guest uses leave 8 that day; later days reset the account allowance to 10. Existing local threads, imports and exports remain usable.

Generation uses server-enforced guest identity and allowance records, not a client-supplied usage number. Account creation/sign-in claims usage from that browser identity exactly once, with atomic admission/claim handling for concurrent requests and in-flight guest generations. Do not allow repeat claims, multiple tabs or registration timing to create extra allowance. A guest identity is browser-scoped; clearing storage or changing devices is not provably the same anonymous person, so the plan must bound anonymous cost without pretending a cookie enforces a global per-person limit. Keep provider keys server-only, server spending/concurrency limits shared with signed-in activity, and provide an AI-processing notice before a guest sends source content. Preserve saved account opt-outs; the exact-account consent/memory safeguards remain for discussions. Guest thread creation does not imply anonymous AI-discussion access.

## Retrieval and source preservation
URL inputs first use the existing public-article fetch/extraction path. Only extraction/content failure or insufficient article body may invoke DeepSeek Fetch; invalid/private URLs are rejected, not sent to a fallback. Fetch recovers content for the requested article, not unrelated search results. Do not treat a search snippet, login page or paywall notice as the full article. If both methods fail, show an actionable error and preserve the input so the user can paste the source.
Preserve attribution, canonical source URL, source avatar and available media. Store the actual retrieved or pasted source alongside the generated posts so discussion grounding still uses source evidence. Keep Markdown structure useful to generation; never publish raw HTML or execute model/source instructions. Retain existing input limits; reject oversize input clearly rather than silently truncating it.

## Thread writing
Use a separate generation prompt and output budget from the short discussion-reply prompt. Treat source text as untrusted data. Ask for a self-contained opening, a logical sequence of connected ideas, useful detail appropriate to chosen depth, and a natural ending. Preserve names, dates, numbers, qualifiers, attribution and uncertainty. Do not invent facts, quotations or conclusions or add unrelated web knowledge.
Return structured title and ordered post texts. Target readable Twitter-sized posts while finishing ideas and sentences; do not cut strings at a character boundary. Thread length is constrained by available source substance, not padding or repetition. Validate the entire result and reject empty, malformed or provider-truncated output before publication. Existing editing, media assignment, themes, focused replies, PNG exports and account saving remain.

## Server, cost and lifecycle
Keep API credentials server-only. Use a protected, bounded, idempotent generation operation with captured owner, cancellation and terminal-state handling. Refresh, focus, retries of the same request and duplicate clicks must not duplicate paid generation or create duplicate saved threads. Account switch, sign-out, source cancellation and deletion must fence late responses and private exports.
Reserve cost atomically before provider work against the existing operator daily ceiling. Include possible Fetch and generation/retry costs in the reservation using documented current pricing and conservative byte/output bounds. Account per-day generation limits and concurrency must be explicit in the implementation plan; keep existing discussion allowances and publication guards intact. Do not reuse the short discussion token/cost estimate for long article generation. No unbounded agent browsing or tool loops.
Use simulated provider/fetch responses for implementation tests. A separately bounded live public-source check can qualify actual provider behavior after the code works; do not send private user sources as test data.

## Verification
Real API and component tests must prove all source modes call the server generator, good extraction skips provider Fetch, insufficient/failed extraction invokes Fetch once, unsafe URLs never reach either paid endpoint, both-fetch failure preserves input, malformed/truncated output is not saved, and duplicate/cancel/owner/expiry races cannot publish or charge twice. Test daily budget/concurrency including concurrent discussions. Browser-check loading/error/retry, existing source/media, account/guest policy, depth/length behavior and PNG exports at desktop and 390px.

## References
DeepSeek Search and Fetch guide: https://api-docs.deepseek.com/guides/search/
Current local source: src/components/Threadly.tsx, src/lib/summary.js, src/server/article.js, src/server/discussion/deepseek.ts and server discussion admission/budget code.

## Approval needed
The user approved the design, guest creation, two-total guest quota, ten-per-UTC-day verified quota and guest-usage carryover. Continue with a concrete implementation plan using the standing Sol-medium subagent/review workflow.


## Planning calls to make explicit
- A credit counts a completed, validated AI thread result. Pending work reserves a slot; failed/cancelled work releases that user slot, but any potential provider spend remains conservatively reserved. Deleting an existing thread does not restore a credit.
- Carryover is claimed on the first verified sign-in in the originating browser. Completed guest uses transfer once to the claim day's account allowance. To avoid publishing a guest result across an identity change, atomically cancel any still-pending guest generation during claim, retain its provider cost reservation and preserve the browser input for an account retry. If completion wins the race, count that completed result instead. These race/refund rules are implementation recommendations for review in the plan.
- Guest identity is an opaque, random HttpOnly same-site cookie backed by server records. It persists across visits but cannot establish the same person after cookie deletion or on another device. Do not add fingerprinting or external challenge services in this change; the shared operator spend ceiling bounds anonymous exposure.
