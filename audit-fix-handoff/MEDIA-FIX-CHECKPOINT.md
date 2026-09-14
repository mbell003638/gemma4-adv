# Media fix checkpoint — 2026-09-14

Scope: gemma4-manus-lab, branch codex/manus-gemma4-p0-p3. A10/A11 media files only; existing dirty work retained. Read Codex 04-MEDIA.md and both PRE_PHONE_AUDIT.md files. No tests, typechecks, lint, builds, probes, downloads, commits or pushes executed. Evidence below is source review and written, unexecuted regression assertions.

## Step 1 — implementation saved

- mediaTasks.ts: required injectable markRecoveryRequired(requestId), production shared latch; cancel/finish attempted for owned requests even after preparation/begin failure; separate five-second cleanup allowances.
- Preparation starts inside bounded admission, preventing work after an expired deadline or pre-abort. One 60-second deadline covers lookup, preparation and every page/audio turn; result acceptance checks abort/deadline again after cleanup.
- Abort listener installed before preparation, removed in finally; immediate request-local cancel plus mandatory finish.
- No discard after uncertain finish. Pending preparation retains ownership, then repeats cancel/finish before late discard; late rejection is handled too. Background cleanup failures latch recovery.
- mediaDeadline.ts: finite positive duration, microtask-time expiry/abort recheck, timer/listener removal and handled late settlement.
- documentOutput.ts: exported MAX_DOCUMENT_PAGES=5. Page/excluded counts must be safe integers with pageCount>=1 and excludedPages>=0. Excess/excluded PDF pages reject before inference; no combined row slicing; changing counts/multiple setups reject.
- Codex parser now emits GEMMA_DOCUMENT_TOO_MANY_ENTRIES for oversized rows. Manus preserves DocumentOutputError, TOO_MANY_DOCUMENT_ENTRIES, recursive validation, prompts and exports.

## Step 2 — deferred regressions saved

New frontend/__tests__/gemmaMediaLifecycleRegression.test.ts covers expired admission, runtime consuming deadline, pre-abort, rejected/hung begin, failed cancel/finish/discard, recovery latch denying next lookup, mid-begin abort, finish-before-discard, late preparation resolution/rejection, retention after uncertain finish, abort during cleanup, A/B request isolation, mismatched frames, PDF 1/5/6/8, rows 49/50/51/150, aggregate overflow, malformed counts, changed pages and multiple setups.
Existing gemmaMediaTasks.test.ts injects the latch; existing no-tools/transcription checks retained. Codex gemmaDocumentOutput.test.ts matches its specific oversized-row error. These are deferred assertions, not passing evidence.

## Coordination required outside this ownership

Main owns gemmaNative.ts/runtimeHealth.ts. Per September 14 owner update, bridge finish/recover validate {requestId, finished:true}. Media relies on engine.finish resolving ONLY after that validation. Keep recovery denied across wrapper recreation; clear each latch only after matching explicit recovery acknowledgment. Production recovery-clear/invalid-ack regressions belong to main; the media fake proves injection/denial only.
Native owner must emit matching request-local finish/recover acknowledgments, keep rejected B harmless to A, queue release behind JNI ownership, handle late preparation/request tombstones, and reject >5 PDF pages before staging/inference. A JavaScript fake cannot certify native attachment safety. Native A13/production coordinator evidence is deferred.
Main/UI owner must propagate media limit/recovery errors as terminal review failures without fallback truncation or accounting writes, and use MAX_DOCUMENT_PAGES in bridge limits where appropriate. Preserve disabled vision/audio gates until acceptance.
Existing gemmaMediaSource.test.ts asserts historical native exclusion text and exact deletion counts; native source-contract updates should follow the native owner's final implementation, not speculative edits here.

## Changed files in this lab

- frontend/src/accountingV2/gemma/mediaTasks.ts
- frontend/src/accountingV2/gemma/mediaDeadline.ts
- frontend/src/accountingV2/gemma/documentOutput.ts
- frontend/__tests__/gemmaMediaTasks.test.ts
- frontend/__tests__/gemmaMediaLifecycleRegression.test.ts
- audit-fix-handoff/MEDIA-FIX-CHECKPOINT.md

## Step 3 — final source review

Added deferred cases for hung runtime lookup, a shared two-page deadline, aborted audio with late preparation, and failed late finish retaining attachments and denying the next lookup. Frame validation also rejects non-string text before document/audio parsing.

Status: assigned implementation and deferred regressions complete; source reviewed only. All execution remains deferred to the owner's cheaper-model validation pass. Cross-owner native acknowledgment, JNI release ordering, production recovery-clear and terminal UI routing evidence remain required before integrated A10/A11 acceptance.
