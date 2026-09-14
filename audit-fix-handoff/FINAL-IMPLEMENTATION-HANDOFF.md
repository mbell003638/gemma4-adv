# Manus audit implementation handoff

Branch: codex/manus-gemma4-p0-p3. Work remains local, uncommitted and unpushed.

Integration status: final native and scope review in progress.
All execution is deferred by the owner: no tests, typecheck, lint, Kotlin compile,
Gradle build, model download, artifact validator or device probe in this pass.
Historical successful checks predate the current changes.

## Finding map

| Finding | Applicability | Code / authored regression |
|---|---|---|
| A01 originating scope | Both | agentCore, liveGemmaAsk, liveProposalController, Ask screen; scope-boundary and proposal-staging regressions |
| A02 exact confirmation | Both | confirmationIntent and both pending Ask paths; confirmation/terminal-fallback regressions |
| A03 startup verification | Both | production GemmaLifecycle, GemmaPackStore and bridge; production native regression driver |
| A04 removal and recovery | Both | serialized native lifecycle, matching finish/recover acknowledgements, shared JS recovery state and Settings; explicit-recovery regressions |
| A05 Needle 16 KB | Both | CMake/linker/NDK flags and standalone APK all-library/ZIP verifier; synthetic negative/positive fixtures |
| A06 cash cursor | Codex | liveDataPorts journal-line identity and ordering; gemmaLiveDataPorts tests |
| A07 named cursors | Manus | liveDataPorts scoped versioned cursor identity and matching ordering; gemmaLiveDataPorts tests |
| A08 party role statements | Codex | role-specific journal projections including manual/reversal histories; SQLite regression fixtures |
| A09 carried capital | Codex | current-period capital projection matching authoritative rounding/profit helpers; closing/current-period fixtures |
| A10 media lifecycle | Both | bounded preparation/inference, cancel/finish ownership, deferred late cleanup, poison latch; media lifecycle and native coordinator regressions |
| A11 document bounds | Both | reject oversized pages/rows and changed counts, no partial return; media/document boundary regressions |
| A12 standalone packaging | Both | manual lab-only default/Gemma matrix, scoped full-JDK driver and bundled APK verifier |
| A13 shipped-source coverage | Manus (also strengthens Codex) | production native seams and drivers; final native checkpoint names the sources compiled |

Every row needs execution evidence before acceptance. A05/A12 specifically require
new APK artifacts and actual ELF/ZIP inspection; flags and script files do not close them.
Vision/audio remain disabled pending device acceptance.

## Cheaper-model validation order (future execution only)

1. Read the six checkpoint files: SCOPE, ACCOUNTING, NATIVE, MEDIA, BUILD and BRIDGE.
2. Verify this exact lab/branch and preserve all dirty edits.
3. From frontend run TypeScript, then focused Gemma regression suites, then the full
   suite and lint. Do not weaken assertions to match an implementation failure.
4. Run the production-source Kotlin drivers described in NATIVE-FIX-CHECKPOINT.md.
   Record source fingerprints from this checkout; archived prototype results do not count.
5. Follow 2026-09-14-BUILD-A05-A12-HANDOFF.md for configured full JDK17/21,
   cached Gradle/SDK, standalone default/Gemma build and real package verification.
   Java25 Android Studio JBR caused the previous major-version69 failure. Do not
   bypass Kotlin metadata or change other products' toolchains.
6. Record commands, exit status and new artifact paths/hashes in REPAIR_STATUS.md.
   Then perform separately authorized phone acceptance; never count fake runtime
   tests as inference, download, memory, heat, voice, vision or offline-TTS evidence.

Suggested JS commands from this lab's frontend (not run here):

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/jest/bin/jest.js --runInBand --watchman=false --testPathPattern=gemma
npm run lint
node node_modules/jest/bin/jest.js --ci --watchman=false --maxWorkers=2
```

## Interpretation limits preserved

The ordinary party screen filters some source histories and does not provide the
same bounded manual/reversal journal projection. Accounting regressions distinguish
agreement on supported histories from that pre-existing difference. The authored
reopened-period fixture restores persisted state because there is no reopen method
on closeBooksRepository. Neither limitation is hidden as passing end-to-end evidence.

No compatible full local JDK path or fresh standalone APK is claimed. Tool installation,
signing/device acceptance and test results require the later execution pass.
