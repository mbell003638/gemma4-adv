# Manus on-device — independent audit and fixes

> **Current build update (2026-09-12):** the Android SDK/Kotlin/Gradle/APK items
> described below as pending have since been completed in this isolated lab.
> See [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md) for current build
> evidence. Phone/model runtime validation remains pending; the original audit
> text is retained as historical evidence of the gaps found at audit time.

> Historical audit snapshot. The current source of truth is
> [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md); the live domain adapter,
> media routes, and coverage allowlist described as missing below have since
> been implemented and verified.

Branch: `codex/manus-gemma4-p0-p3`
Baseline: `5b00321e6a90e9016d59c0179bec16cdc6a7a33c`

## Result

Manus is a different implementation with thirty-one proposal operations and its
own feature registry. Its native code was correctly kept in spikes, but its
direct read and prepare methods trusted outer-loop checks. The reported P5 gap
was real: there was no durable confirmation executor.

## Repairs in this audit

- Wrapped all twelve direct read factories with independent schema and
  authorization checks. Direct proposal preparation now validates and authorizes
  before resolving parties or calculating amounts.
- Checked trial-balance row totals, declared difference and balanced verdict.
  Checked balance-sheet components, difference and verdict.
- Corrected cash-basis P&L expense semantics: cash report expenses exclude
  cash-paid purchases, whereas accrual expenses include COGS. Operating and
  total expenses now use the actual basis; gross/net figures must reconcile.
  Commission is passed as separate evidence, not silently subtracted again.
- Corrected old fixtures that contained contradictory balance-sheet components,
  trial-balance rows and net profit. Added cash-basis and inconsistent-report
  regressions against the formulas in reports.ts.
- Implemented proposalStore.ts and proposalExecutor.ts in this lab with this
  branch's schema migration **15 -> 16**. Its thirty-one-operation registry
  stays separate from Codex's sixteen-operation registry.
- Integrated proposal deletion into this branch's book/accounting/factory resets,
  preserving its additional marketplace, projects, manufacturing and trade paths.
- Bounded the whole agent turn and native cleanup, and prevented recover()
  from reopening admission while a normal turn is still active.

## Current validation

- Full Jest: **136 suites / 1154 tests passed** (audit-entry baseline: 135/1134).
- TypeScript and scoped ESLint with zero warnings: passed.
- Isolation checks and tracked git diff --check: passed.

Native check-host.mjs passed 54 checks; check-downloads.mjs passed 35 checks
against small loopback HTTP payloads. These do not execute JNI or download real
weights. The downloads compiler emitted host-JDK URL constructor deprecation
warnings; that script does not use -Werror.

## Branch-specific outstanding items

The native files remain under spikes/gemma4/src; the Android bridge/source set
described in GRADLE-WIRING.md is not installed. branchPorts.ts is a dependency
composition layer, not live api.* wiring. It still needs a reconciled ranged
report accessor, scoped query implementations and the actual feature/permission
adapter. P5 now has tested persistence/confirmation machinery, but its real
thirty-one-operation apply adapter and screen wiring are still missing.
Coverage rows must continue to be described as component coverage.

## Scope and evidence

Reviewed the two independent lab clones separately on 2026-09-08. Shared
confirmation infrastructure was adapted into separate files; neither source
branch was merged into the other. Main, Ledger-Ai and the original on-device
checkouts received no edits from this audit. No commit or push was made.
The isolation checks passed in both labs: separate Git repositories, no remotes,
zero commits since their baselines, and unchanged Needle model SHA-256
`24982abc3ed97b36192a16b0ea2758698c1a300853c01ab69e9decb3852d140f`.

The device/model test was deferred by the owner. No full model was downloaded,
no APK was built, and no Gemma inference was run. A standard Android SDK was
not found and adb was unavailable on PATH. Published-model license/download
claims in the previous reports were not independently rechecked online in this
audit; the native download check described below uses small loopback fixtures.

## Confirmation boundary now implemented

Both labs have a durable proposal store and confirmation executor. They serialize
confirmation transactions with the existing global sync mutation lock, reload
state after admission, pass the same SqlRunner to the apply port, and use a
savepoint for the domain effect and applied receipt. The preview digest now uses
SHA-256. Confirmation rechecks scope, permissions, entity revisions, period and
expiry; a replay stays within the same book/actor/location/permission boundary
but tolerates the data revision advanced by the original post.

Tests cover simultaneous confirmations, a concurrent sync mutation, rollback,
tampering, replay isolation, and proposal deletion during book deletion,
accounting reset and factory reset. Reset tests use temporary SQLite databases,
not the owner's accounting data.

This proves infrastructure, not the complete live posting path. The real apply
adapter must use the supplied runner and lock-aware sync helpers such as
withSyncOperationLocked/enqueueSyncOperation. Calling a public api.* method that
reacquires the global lock can deadlock. Domain changes and the sync outbox must
remain inside the same outer savepoint. The screen's current applyAction switch
has not been extracted or connected. Before doing so, characterize each branch's
actual cases, entity resolution, idempotency and rollback behavior.

## Remaining work shared by both products

1. Validate a Kotlin/AGP/D8/R8 combination with Expo, React Native and Needle.
   The current SDK metadata/compiler mismatch is still unresolved for an
   enabled Gemma Android build. Host compilation does not validate the Expo
   bridge, Android org.json behavior, R8, ABI packaging or GPU loading.
2. Connect the download core to real native operations, persisted progress and
   foreground/background lifecycle. Run interruption, redirect, disk-full and
   process-death checks on Android. A passing catalog test is not a working
   in-app download button.
3. Run P1 on a physical phone with the approved E2B weights: text, a manual
   tool-result round trip, image input and audio input. Record device/RAM,
   backend, timing and artifact hash. This remains explicitly deferred.
4. Finish scoped live read/query and action adapters, including actual fixture
   books and the branch-specific permission source. Add book-switch, lock,
   logout, restore and settings/model-switch lifecycle hooks before wiring UI.
5. Implement image/PDF/audio normalization, reviewed scan/transcription flows
   and offline TTS selection. Test media reaches the real encoder. The current
   parser and attachment helpers do not constitute complete multimodal support.
6. Connect Ask and Settings behind the experimental gate and complete P8.
   Prevent Gemma and the legacy multi-GB engine from being resident together,
   schedule idle expiry/recovery, and validate all teardown paths on device.
   Do not retire existing downloads or claim complete feature automation yet.

## Reproduction

From this lab's frontend directory:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/accountingV2/gemma src/accountingV2/resetBook.ts src/utils/gemmaNative.ts "__tests__/gemma*.test.ts" --no-cache --max-warnings 0
node node_modules/jest/bin/jest.js --runInBand --no-cache --json --outputFile ../spikes/gemma4/build/audit-tests.json
```

The word gemma alone matches every test's absolute path because this checkout
itself is named gemma4-lab/gemma4-manus-lab. For focused runs use
`--runTestsByPath __tests__/gemmaConfirmationPersistence.test.ts`, not a bare
`gemma` pattern.

From this lab's root, set GEMMA_JDK to the full JDK and run the native scripts.
verify-isolation.mjs may need permission to spawn Git outside the sandbox;
its checks are read-only.
