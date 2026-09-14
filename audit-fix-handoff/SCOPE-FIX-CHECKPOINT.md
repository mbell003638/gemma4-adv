# Scope owner checkpoint — 2026-09-14

Implementation only. NO tests, typecheck, lint, builds, probes, downloads,
validation scripts, commits or pushes executed by this owner.
Existing dirty changes preserved. Only this lab's assigned scope files changed.

## Step 1 saved

- agentCore.ts: readonly host origin metadata, frozen origin scope on drafts,
  cancellation observed after native cleanup without overriding cleanup failure.
- liveProposalController.ts: clone all draft fields before awaiting scope;
  preserve original request ID; reuse the same store for cancellation; stale
  staging remains terminal even when cancellation fails.
- liveGemmaAsk.ts: capture trusted scope before runtime discovery and enforce it
  when discovery completes and when the agent reads current scope.
- confirmationIntent.ts and app/ask.tsx: one exact-message dispatcher used by
  both pending proposal paths; corrections preserve input and request clarification;
  token checked after asynchronous scope lookup as well as before it.

## Step 2 saved

Screen scope watcher invalidates the epoch and pending proposals when the trusted
scope changes; cancellation/unmount/new asks also invalidate requests. Legacy
Apply checks the proposal's held scope; receipt proposal admission captures the
same scope. Consent completion is rechecked, and stale completion cannot clear a
new request's loading flag. Both pending paths now clarify ambiguous text without
invoking domain handlers. Removed unreachable legacy revision routing.
No commands executing application/test code were run.

## Step 3 saved

Regression code added (NOT EXECUTED):
gemmaScopeBoundaryRegression.test.ts, gemmaConfirmationIntent.test.ts,
gemmaProposalStagingRegression.test.ts, gemmaTerminalFallbackRegression.test.ts.
Cases cover origin retention, changed scope across agent boundaries, stopped
answers, lock/sign-out, cancellation, cleanup failure, staging snapshots,
cancel failure, exact confirms, zero apply calls on ambiguous messages, late
screen epochs and terminal versus unavailable fallback routing.
onDeviceAskProse.test.ts now explicitly mocks unavailable Gemma for its
legacy-only prose cases.

## Resume checkpoint saved

- Source-read both checkpoints, Codex PRE_PHONE_AUDIT and scope handoff.
- Confirmed expected lab branches; preserved other owners' dirty edits.
- Changed agent/staging/onDeviceAsk to the required nested
  proposal: { draft, scope, requestId } contract, with no unscoped fallback.
- Added epoch checks at Apply admission and durable completion; receipt
  processing now rejects stale OCR/analysis/navigation/error/loading updates.
- Added fail-closed requestIsCurrent and revision-aware post-write scope checks.
- Remaining: finish Apply/cancel completion guards, update envelope fixtures,
  add bounded integration regressions, source-review and save final file list.
- No application/test/validation code executed. Main reports bridge/media/build
  integration complete; those files remain outside this owner's edits.

## Remaining in this owner scope

Finish screen invalidation and regression code. Then document source review
and unexecuted verification work here. All changes remain UNVERIFIED.
Native finish/recover request-local {requestId,finished:true} acknowledgment is
owned by the native agent; this owner does not edit native/media/build files.
