# Native fix checkpoint — 2026-09-14

IN PROGRESS — resumed native implementation, source reads/edits only. No tests, typechecks, lint, compiles, builds, probes, downloads, commits or pushes executed.

Both existing dirty labs preserved: Codex `codex/gemma4-p0-p3`; Manus `codex/manus-gemma4-p0-p3`.

## Concrete source saved in both labs

- Production native `GemmaLifecycle.kt`: admission, shared management queue, request-local terminal acknowledgements, restart verification and failure cleanup.
- `LedgrOnDeviceLlmModule.kt`: delegates begin admission and management to that coordinator; shutdown stops downloads and retains uncertain teardown ownership.
- `GemmaSessionHost.kt`: saved real-runtime seam plus cancellation/close serialization.
- `GemmaAttachmentStore.kt`: deletion failure is no longer swallowed before a terminal acknowledgement.
- Existing `GemmaRuntime.kt`, `GemmaPackStore.kt` saved by the previous agent remain part of this implementation.
- `spikes/gemma4/check-production.mjs` and `check-native.mjs`, `check-host.mjs`, `check-downloads.mjs`: compile actual production sources, including Runtime/Lifecycle for host/native; all test dependencies explicitly listed; installed tools only; fresh class directory; source/dependency absolute paths and SHA-256 evidence. Every invocation invalidates all three prior report names before checking dependencies.
- `spikes/gemma4/tests/ProductionLifecycleContractCheck.kt`: new production coordinator admission, management exclusion/rejection/shutdown/staleness, queued acknowledgements, cleanup failure/poison, stale finish/recover and removal scenarios.
- `ProductionFixtures.kt`, `ProductionHostContractCheck.kt`: use production admission and live host state; corrected unknown-model expectation. Existing `ProductionPackContractCheck.kt` retained.

Protocol: gemmaFinish/gemmaRecover resolve JSON strings `{requestId,finished:true}` only after cleanup. A stale finish releases only its own request media and never closes another request; stale recovery rejects. Failed/unconfirmed native close requires restart.

## Remaining bounded implementation steps

Finish source review of the new driver dependency lists and fixture assertions; add real-host cancellation-close/private-attachment regressions; preserve useful existing Codex production guard coverage; update the permitted media source assertion if needed. Then replace this checkpoint with complete implementation inventory and explicitly deferred acceptance.

## Acceptance deferred

All execution, Kotlin/Android/Expo compilation, regression runs, intentional guard-mutation checks, Gradle/APK acceptance, real SDK/JNI/model/device behavior remain unverified. Historical reports are not evidence for these changed sources. No generated report was produced or executed during this turn.
