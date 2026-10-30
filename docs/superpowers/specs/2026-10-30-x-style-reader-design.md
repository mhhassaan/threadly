# X-style reader and account-level AI defaults

Date: 2026-10-30
Status: Approved by user (Approve and implement), 2026-10-30.
Working checkout: D:/projects/threadly-source/.worktrees/ai-discussions
Current feature base:982507b62e435efc084bef4281e0071dad203394

## Goal
Make Threadly's thread and reply experience closely match the Twitter/X reference supplied by the user. The reader should be a reading/conversation surface rather than an editor or settings dashboard. User explicitly wants AI enabled by default, with preferences on the account page and no enable-AI step in the thread.

Use the existing TanStack/React/Cloudflare stack. Apply Emil Design and Mobile Native. Keep private account ownership, existing themes, article avatars/media, extractive summaries, guest reading, saved drafts, exports and accessibility. This change concerns thread/reply interactions within Threadly's private library; it does not introduce a public social network or Twitter publishing.

## One coherent approach
Use a shared post presentation for article posts and human/AI comments, with a focused post-and-replies view. Repeated settings panels or a chat layout do not fit the requested reference.

| Before | After | Why |
| --- | --- | --- |
| Private account/discussion/status banners | Clean Post header and timeline | Match the reference's hierarchy |
| Mark read through / Read through here | Quiet automatic progress | Reading needs no management action |
| Editable text and character counters everywhere | Read-only text; Edit in the more menu | Preserve editing without editor chrome |
| Discussion panels, Expand/Collapse, text Reply links | Normal post/reply rows and icon actions | Comments feel like part of the same product |
| Delete conversation, source/memory detail controls inline | Account management; contextual details in more menus | Preserve capabilities without clutter |
| Per-thread enable/start AI controls | Account-level preferences and automatic bounded discussion | No setup step in the reader |

## Reader appearance
- Preserve the prominent first post and compact author continuation rows, with circular avatars and a continuous thread connector.
- Use Chirp within the reader, an approximately600px desktop column, mobile-width layout, appropriate15px reply text and larger primary-post text, muted handles/timestamps, subtle separators and familiar icon spacing. Brand typography remains on dashboard/navigation/footer.
- Remove Private account thread, Private discussion, AI enabled/paused, Start discussion, read-through labels and character counts from ordinary reading.
- Remove always-on contentEditable styling. Editing is an explicit more-menu action with Save/Cancel and draft/conflict recovery.
- Keep media intact. Source attribution remains accessible without an extra management block.
- Display real available metadata and actual interaction counts; do not manufacture public engagement or timestamps.
- Keep AI participants identifiable through a small AI label beside their identity, without an AI settings banner.

## Post and comment interactions
- The thread view prioritizes the author continuation chain. Human/AI replies use the same avatar/name/handle/time/text/action vocabulary, not inset chat cards.
- Selecting a post opens its focused post-and-replies view in the same reader. Back restores the prior thread position. Reply actions preserve the selected post/comment target.
- A focused post shows its normal reply composer and replies. Replies to comments retain their parent relationships; deeper replies stay readable on narrow screens rather than indenting indefinitely.
- Provide functional reply, like, repost/bookmark and share/copy-link actions where shown. Persist account comment reactions with ownership checks; no decorative dead buttons or fake counts. Guest behavior remains device-local.
- Keep useful context/source inspection under contextual menus. Move full conversation deletion and privacy controls to account management with the existing confirmations. Individual actions should use familiar menus instead of inline management links.
- Loading, retry, offline and failed-send feedback appears where the interaction occurred. Preserve drafts and the human comment when AI fails; no separate enable-AI panel.
- All keyboard/focus, touch targets, contrast and reduced-motion behavior remain accessible. Use short, purposeful transitions; no simulated typing or artificial delay.

## AI default and account settings
- AI participation becomes the normal default for new verified accounts, with a concise source/comment-processing disclosure in signup/account onboarding. A separate enable-AI question is not part of reading.
- Account page owns AI pause/resume, memory preferences, processing information, stored-memory inspection/reset, and conversation deletion. Existing deliberate opt-outs remain respected; default-on does not silently overwrite a user's saved Pause choice.
- Existing accounts without a recorded processing acknowledgement receive that information in account onboarding/account settings, not inside each thread. Do not silently invent a consent receipt for pre-existing private content.
- New owned threads receive the existing bounded opening comments automatically when account/operator settings allow it. Existing/imported threads do not generate just because opened; user comments can trigger the existing bounded replies. This prevents revisits and imports from unexpectedly consuming budget or starting conversations.
- Keep four recurring personalities and scoped guests, at most3comments/two speakers for a human turn, opening limits/quiet posts, no activity while away, no unbounded retries, memory privacy and all server spend/concurrency controls.
- Operator global availability/budget remains separate from user preferences. No secret change, paid API evaluation, backfill of old conversations or broad automatic generation is included in this UI implementation approval. Actual live quality remains separately qualified.

## Progress and data integrity
Automatic reading progress must not invalidate unchanged memories, cancel an in-flight reply, conflict with source edits or create generation. Use a metadata-only save path (or equivalent correctly fenced behavior), not repeated content-edit saves on every scroll event. Persist at meaningful reading boundaries with bounded/debounced activity.

Keep existing ownership, trusted-origin/no-store, account-switch/expiry/deletion fences, same-owner offline drafts, source revisions, and terminal404 deletion behavior. New comment reaction storage, if needed, follows the existing composite-owner foreign keys and additive local migrations. Source/AI identity remain truthful. No auth-verification bypass.

## Verification and completion
- Behavioral tests for hidden reader-management chrome; read versus edit modes; focused post/back/reply targeting; actual comment actions; quiet automatic progress; default account preference/processing acknowledgement; preserved opt-outs; no automatic work on revisit/import; and draft/owner/deletion safety.
- Exercise guest and signed-in flows, source media, themes, PNG selection/export, keyboard/focus and390px/desktop browser layouts. Use synthetic fixtures and fake provider responses for development; no new paid calls.
- Run appropriate type/core/test/build/smoke checks with isolated test bindings. Current local spend override2 differs from the old default-config test; report that honestly rather than changing user secrets/settings.
- Use Sol medium implementers/reviewers. Independently review each completed task and push the reviewed feature branch per standing authorization. Update local devlog/context/handoff after changes. No merge/PR/deployment implied.

## Suggested implementation sequence after approval
1. Account-level AI defaults/disclosure and settings/management placement, retaining saved opt-outs and external-processing guards.
2. Unified read-mode post/reply presentation, focused navigation and functional comment interactions.
3. Quiet progress persistence and lifecycle integration without generation invalidation.
4. Browser polish, regression verification, independent review and feature push.

## Explicit qualification
A close match to the supplied X thread reference is the visual/interaction target. Real model obedience/naturalness, production domain email, deployed CPU and physical-phone behavior are not established by a UI redesign or offline tests. The existing inherited CSS source-map warning remains separate diagnostic debt.
