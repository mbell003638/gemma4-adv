# Gemma 4 + LiteRT-LM — implementation status

> **2026-09-12 Android build closure:** Android SDK 36 and licenses are
> configured. Expo prebuild succeeds. Both the default Kotlin 2.1.20
> MediaPipe/Needle arm64 APK and the opt-in Kotlin 2.4.0/KSP 2.3.10 Gemma arm64
> APK build successfully. Both APKs contain the Needle JNI engine and tuned
> asset. The Gemma APK also contains LiteRT-LM but no downloadable model weights
> and adds 21.36 MiB over the matched legacy build. See
> [INTEGRATION_PROGRESS.md](INTEGRATION_PROGRESS.md) for hashes and current
> evidence. Statements below that say Gradle, bridge compilation, media wiring,
> UI wiring, or APK generation are incomplete are retained only as historical
> checkpoints and are superseded by that record. The remaining gates require a
> phone and downloaded model weights.

> Current source of truth: [2026-09-10 integration progress](INTEGRATION_PROGRESS.md).
> Host-side implementation now includes a separate default-off Gemma source
> set, live scoped Ask reads, ten durable ID-confirmed write types, model UI,
> offline TTS hardening, and bounded image/PDF/audio normalization plus typed
> bridge wrappers wired into scan, transcription, and voice fallback routes.
> Current validation is 148 suites / 1,271 tests with
> TypeScript and zero-warning ESLint passing. Only phone/model runtime and
> audio/vision inference gates remain open; older stage
> tables below are retained as history.

> Superseded in part by the 2026-09-08 independent [audit and fixes](AUDIT_REVIEW.md).
> Current validation: 136 suites / 1154 tests pass; TypeScript and scoped ESLint pass.
> P5 now includes a durable store and tested confirmation executor (schema 16),
> plus proposal cleanup during resets. Its real domain adapter is still missing.
> Read/proposal validation, accounting semantics and agent cleanup were repaired.
> The report below is historical; its statements that no existing source file
> changed and that no commit executor exists no longer describe this lab.

Product: **Manus on-device** (isolated clone, see `ISOLATION.md`)
Branch: `codex/manus-gemma4-p0-p3` · Baseline: `5b00321e6a90e9016d59c0179bec16cdc6a7a33c`
Plan: [`docs/plans/gemma4-litertlm/`](docs/plans/gemma4-litertlm/) · Audit: [`docs/plans/gemma4-litertlm/AUDIT.md`](docs/plans/gemma4-litertlm/AUDIT.md)
Last updated: 2026-09-08

No commits. No remotes. No pushes. Needle2 weights unchanged.

## Read this first

Everything below distinguishes three things, because conflating them is how a
project like this ends up claiming support it does not have:

- **Executed** — a command was run in this session and its output observed.
- **Compile-verified** — it compiles against the real SDK classes on a desktop
  JVM. Not Android, not a device.
- **Not run** — exactly that. No inference of any kind happened. No model file
  was downloaded. No APK was built.

**No Gemma model has ever been loaded or executed in this work.** Every native
check drives either a loopback HTTP server or a scripted fake runtime.

## Stage status

| Stage | Deliverable | Status |
|---|---|---|
| P0 | Branch audit, hashes, isolation | **Complete.** `verify-isolation.mjs` passes: right branch, no commits since baseline, no remotes, Needle hash unchanged. |
| P1 | SDK feasibility spike | **Host/build complete; device gate open.** Compiles against real `litertlm-android:0.17.0` classes and packages both Android variants. Model inference needs a physical device and verified weights. |
| P2 | Verified resumable downloads | **Implemented and executed on JVM.** 35 checks against a real loopback HTTP server. Android/WorkManager/real-model transfer not run. |
| P3 | Native host, JS bridge, lifecycle | **Implemented and Android-compiled; device gate open.** 54 host checks pass and the bridge packages. JNI inference is not run. |
| P4 | Scoped context, schemas, read adapters | **Implemented, wired into live APIs, and tested** against real V2 report shapes. |
| P5 | Proposals and confirmation | **Implemented and wired.** Durable ID-only confirmation and transaction action ports are tested against the shipped schema. |
| P6 | Scan, transcription, TTS | **Implemented and Android-compiled; device gate open.** Bounded media normalization, app routes, capability guards, and TTS hardening are wired. |
| P7 | Per-branch feature coverage | **Register implemented, self-asserting.** Every capability has exactly one honest row. |
| P8 | UI, cleanup, release QA | **UI/build complete; device release QA open.** Advanced Settings, Ask, and voice screens are wired and matched arm64 APKs are preserved. |

## Historical blocker — resolved by the conditional build variant

The published SDK's classes carry Kotlin metadata **2.4.0**; its POM wants
kotlin-reflect 2.4.0 and kotlinx-coroutines-android 1.11.0. This app's React
Native build catalog pins **Kotlin 2.1.20** and **AGP 8.11.0**.

Adding `com.google.ai.edge.litertlm:litertlm-android:0.17.0` to
`modules/ledgr-native-ai/android/build.gradle` today would break the whole
Android build, Needle included. That is why no Gradle change was applied and
why the native code lives in `spikes/gemma4/` behind a documented, unapplied
wiring plan ([`spikes/gemma4/GRADLE-WIRING.md`](spikes/gemma4/GRADLE-WIRING.md)).

This cannot be solved in TypeScript. It needs either a validated
Kotlin/AGP/D8/R8 combination that works with Expo, React Native and Needle
together, or an earlier LiteRT-LM release that still has Gemma's modalities and
manual tool calling.

## SDK findings from the real jar

The plan's code fences were drafts. Checking them against
`.local-tools/sdk/classes.jar` with `javap` produced four corrections:

1. **`Conversation.cancelProcess()` exists.** The plan listed this as an open
   question. It is public and is what the host uses to stop a live generation.
2. **`Message`'s constructor is `internal`.** A model turn must be built with
   the public `Message.model(contents, toolCalls, channels)` factory.
   `Message.tool(contents)` is public and is what carries tool responses.
3. **`Conversation.getTokenCount()` is JVM-public but not resolvable from
   Kotlin.** The plan hoped to "measure actual token use when SDK support
   permits". On this version it does not permit it, so the character budgets in
   `agentCore.ts` remain the only bound. This is a backstop, not token
   accounting, and it is labelled as such.
4. **`ToolCall.arguments` is a `Map<String, Any>`**, not a JSON string, and
   `Content.ToolResponse(name, response)` takes `Any?`. The host converts both
   directions by hand rather than relying on `JSONObject(Map)`, because Android
   and Maven ship different `org.json` implementations.

## What was executed

### JVM native checks

```
node spikes/gemma4/verify-isolation.mjs        -> isolation passed, needle unchanged, 0 commits
GEMMA_JDK=... node spikes/gemma4/check-sdk.mjs        -> compilation passed, contract checks passed
GEMMA_JDK=... node spikes/gemma4/check-downloads.mjs  -> 35 checks passed
GEMMA_JDK=... node spikes/gemma4/check-host.mjs       -> 54 checks passed
```

**Downloads (35).** Spec validation S1–S13: malformed/uppercase hash, bad
revision, path-traversal and nested filenames, non-https, foreign host,
credentials in URL, duplicate id, duplicate filename, unknown model, and proof
the production host policy still refuses loopback. Delivery D1–D10 against a
real `com.sun.net.httpserver` origin: anonymous download with no
`Authorization` header ever sent; an interrupted transfer resumed at the exact
retained byte offset via HTTP 206 with the whole-payload hash matching; a
server that ignores `Range` restarting the file instead of concatenating;
distinct errors for 401/403/404/416/429/500 and a malformed `Content-Range`;
short body, oversized body and checksum mismatch never installed, with the
partial retained for diagnostics on a hash failure; pause keeping the partial
while remove touched only the targeted pack; a pre-existing destination refused
rather than overwritten; redirects re-checked per hop and bounded at six; a
cancelled request never starting; and a swapped model file failing
re-verification before use.

**Host (54).** H1–H11 request validation, H12–H13 the automatic-tool callback
throwing, H14–H17 frame shape against the `parseFrame` contract, H18–H25 resume
ordering and cardinality including repeated tool names, H26–H35 admission,
cancel-before-begin, cancel-during-initialization, idle expiry, OOM and
unsupported-backend mapping, and warm-engine reuse with per-turn conversations.
A1–A17 the attachment store: single-use handles bound to request and kind, TTL
expiry, remote/content-URI refusal, traversal refusal, a real symlink escape
refused, size caps, and the normalizer seam being consulted.

### TypeScript

```
cd frontend
npx tsc --noEmit                 -> clean
npx eslint <all new files>       -> clean, --max-warnings 0
npx jest --runInBand gemma*      -> 251 tests passed
```

| Suite | Tests | Covers |
|---|---:|---|
| `gemmaAgentCore.test.ts` | 38 | Schema rejection, frame parsing, read loop, scope changes, proposals, admission and recovery |
| `gemmaPackCatalogV2.test.ts` | 54 | Schema-2 parsing, fingerprint reconciliation, capability gating, pack selection, legacy packs |
| `gemmaNativeBridge.test.ts` | 11 | Protocol wrapper, frame validation, size guards, off-Android behaviour |
| `gemmaReadTools.test.ts` | 48 | The four confirmed DTO defects as regressions, cursors, location authority, redaction |
| `gemmaProposalTools.test.ts` | 34 | Amount strictness, entity rules, no-write preparation, all 31 operations through the real validator |
| `gemmaCoverage.test.ts` | 24 | The register against real tools, real routes and real test files |
| `gemmaDocumentOutput.test.ts` | 23 | Envelope strictness, per-row flagging, schema mirror, documents-as-data |
| `gemmaBranchPorts.test.ts` | 19 | Scope construction, report mapping, composition, two end-to-end turns |

Existing suites were re-run and are unaffected; no existing file was modified.

## What is NOT done

Stated plainly, because the plan's own README forbids claiming a coverage row
that is not implemented.

1. **No device evidence at all.** Gate N1 is open. Nothing here proves Gemma
   runs, that a tool template round-trips through real weights, or that image
   and audio reach the encoder.
2. **No Gradle change, no APK.** Blocked on the Kotlin version conflict.
3. **No app screen touched.** `api.ts`, `ask.tsx`, `advanced-settings.tsx`,
   `onDeviceLlm.ts`, `onDevicePackManifest.ts`, `onDeviceTools.ts` and
   `onDeviceReadTools.ts` are unchanged. The Qwen/Phi schema-1 path and the
   MediaPipe dependency still ship exactly as before.
4. **The exactly-once commit executor is not built.** Plan document 03 section 6
   needs an `assistant_proposals` table through the real migration framework and
   a transaction-scoped executor threading one `SqlRunner` through proposal
   state, entity writes and the sync outbox. `prepare()` is side-effect free and
   tested as such, but the commit half does not exist. **P5 is therefore not
   complete**, and a proposal cannot yet be applied.
5. **`api.ts` has no public reconciled ranged report.** `api.pnlRange` returns
   only P&L numbers; `api.trialBalance()` and `api.balanceSheet()` return the
   dashboard-derived UI shapes that caused the original defects; `v2Report` is
   module-private. `branchPorts.ts` therefore takes the report as an injected
   dependency, and wiring it needs a small reviewable addition to `api.ts`
   exposing the reconciled `V2Reports` for a range. This was left as a
   documented gap rather than approximated from the defective DTOs.
6. **Android media normalisation is an interface, not an implementation.** EXIF
   rotation, bounds-before-decode, downscaling, `PdfRenderer` page caps and
   M4A→mono-PCM-WAV conversion are specified in `GemmaAttachmentStore.kt` and
   deliberately unimplemented. `PassThroughNormalizer` is test-only and must not
   ship.
7. **No background download workflow.** `GemmaPackStore` is the verified core;
   the managed worker or foreground service around it does not exist. Until it
   does, the product may advertise foreground download with resumable restart —
   not uninterrupted background downloading.
8. **TTS hardening not started.** `LedgrTtsModule` still initialises
   `Locale.getDefault()` and truncates at 600 characters. The offline-voice
   selection helper from plan document 04 section 8 is not implemented.
9. **Proposal port implementations are declared, not connected.** The tool
   schemas, previews and validator handover are real and tested; the
   `BranchDeps` implementations that would talk to marketplace, projects,
   manufacturing and trade domain services are not written. The coverage
   register's `proposal` rows describe tested tools, not a wired end-to-end
   posting path — see gap 4.
10. **Remote catalogue refresh is disabled by design.** `reconcileWithApproved`
    accepts only a URL change for a build-approved fingerprint. No hosting
    location has been chosen and none should be until the owner picks one.

## Files added

Nothing was modified. Every path below is new, except `.gitignore`
(two ignore lines) which the P0 work had already changed.

```
docs/plans/gemma4-litertlm/AUDIT.md
IMPLEMENTATION_STATUS.md

spikes/gemma4/GRADLE-WIRING.md
spikes/gemma4/check-downloads.mjs
spikes/gemma4/check-host.mjs
spikes/gemma4/src/GemmaPackStore.kt
spikes/gemma4/src/DownloadContractCheck.kt
spikes/gemma4/src/GemmaSessionHost.kt
spikes/gemma4/src/GemmaAttachmentStore.kt
spikes/gemma4/src/HostContractCheck.kt

frontend/src/accountingV2/gemma/agentCore.ts
frontend/src/accountingV2/gemma/branchPorts.ts
frontend/src/accountingV2/gemma/coreReadTools.ts
frontend/src/accountingV2/gemma/coverage.ts
frontend/src/accountingV2/gemma/documentOutput.ts
frontend/src/accountingV2/gemma/model-packs-v2.json
frontend/src/accountingV2/gemma/packCatalogV2.ts
frontend/src/accountingV2/gemma/proposalTools.ts
frontend/src/utils/gemmaNative.ts

frontend/__tests__/gemmaAgentCore.test.ts
frontend/__tests__/gemmaBranchPorts.test.ts
frontend/__tests__/gemmaCoverage.test.ts
frontend/__tests__/gemmaDocumentOutput.test.ts
frontend/__tests__/gemmaNativeBridge.test.ts
frontend/__tests__/gemmaPackCatalogV2.test.ts
frontend/__tests__/gemmaProposalTools.test.ts
frontend/__tests__/gemmaReadTools.test.ts
```

## Model artifacts

Transcribed from plan document 02 section 2 and **not re-verified against
Hugging Face in this session**. Revalidate before any release.

| Pack | Bytes | SHA-256 |
|---|---:|---|
| E2B | 2588147712 | `181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c` |
| E4B | 3659530240 | `0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0` |

## Next bounded stage

Resolve the Kotlin/AGP conflict. It gates everything native, and until it is
answered no amount of further TypeScript moves the product closer to shipping.
Once answered: apply `GRADLE-WIRING.md` behind its default-off flag, build a
test-signed APK, and run gate N1 on a physical device with verified E2B
weights, recording real device evidence.

Do not start P8 UI work before N1 passes.
