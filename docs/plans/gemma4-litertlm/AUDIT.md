# Audit of the Gemma 4 + LiteRT-LM plan

Reviewed: 2026-09-08. Reviewer: implementation agent working in the isolated
`gemma4-manus-lab` clone (`codex/manus-gemma4-p0-p3`, baseline `5b00321`).

Scope of this audit: the six documents in `docs/plans/gemma4-litertlm/`, checked
against the actual `Manus-on-device-ai` source in this clone. Every claim below
was verified by reading the named file, not inferred from the plan.

## Verdict

The plan is **sound and unusually careful**. Its architecture, its security
boundaries and its stage gates are correct, and its defect findings about the
existing code are accurate. I found **no design error that would need the plan
rewritten**. I did find **six factual drifts** where the plan describes the
`codex-sol-on-device-ai` branch but this clone is `Manus-on-device-ai`, plus
**four defects in its own reference code fences**. All are listed below with the
correction applied during implementation.

The plan's central design decision is right and worth stating plainly: the model
never gets an execution channel. It emits typed tool *requests*; TypeScript
decides whether they run; writes become immutable drafts that only a user
confirmation can post through the existing accounting services. That is the
correct shape for this problem, and it is what makes the rest auditable.

## Confirmed correct: the plan's defect findings

Document 01 section 3 lists defects in `onDeviceReadTools.ts` that must not
become Gemma's evidence. I verified each against this clone. **All are real, and
all are worse than the plan implies, because every one of them fails silently.**

| Plan claim | Verified against | Actual behaviour |
|---|---|---|
| Reads `dashboard.sales/purchases/expenses` but the dashboard uses `totalSales/totalPurchases/netProfit` | `src/accountingV2/onDeviceReadTools.ts:63` vs `src/accountingV2/v2Dashboard.ts:115` and `src/api.ts:1449` | `board.sales` is `undefined`; `money(undefined)` returns `"0.00"`. Every P&L and cash-flow answer reports zero. |
| Balance-sheet helper treats nested objects as numbers | `onDeviceReadTools.ts:55` vs `src/api.ts:1474` | `api.balanceSheet()` returns `assets`/`liabilities` as objects. `Number({...})` is `NaN`, which `money()` also renders `"0.00"`. |
| Trial-balance helper expects `debit/credit/balanced`, facade returns arrays | `onDeviceReadTools.ts:59` vs `src/api.ts:1491` | Facade returns `{debits:[{account,amount}], credits:[...]}`. No `balanced` field, so the tool prints **"OUT OF BALANCE" unconditionally**. |
| Cash-flow answer relabels a dashboard summary | `onDeviceReadTools.ts:64` | Confirmed: same dashboard object, only the label changes. |
| Date arguments are ignored | `onDeviceReadTools.ts:52` | Confirmed: `reportQuery` reads only `args.report`. |

The downloader criticisms in the same section are also confirmed against
`modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt`:
optional checksum (`if (!expectedSha256.isNullOrBlank())`), installation implied
by `file.exists()`, broad `responseCode in 200..299` acceptance, a
`renameTo`-then-`copyTo` fallback that can leave a file whose name implies
"ready", and a cancel path that deletes the partial download.

The Needle2 preservation constraint holds: `scripts/on-device-ai/needle2-ledgr.cact`
still hashes to `24982abc3ed97b36192a16b0ea2758698c1a300853c01ab69e9decb3852d140f`,
matching `lab-baseline.json`.

## Drift: plan describes the other branch

These are not design errors. The plan was written against
`codex-sol-on-device-ai` and says so; they matter only because this clone is the
Manus product.

1. **Proposal-type count is wrong for this branch.** Document 03 section 5 says
   "All sixteen existing `AssistantProposalType` names need explicit
   descriptors" and its table lists 16 rows. `src/accountingV2/aiActions.ts:144`
   defines **31**: the 16 core types plus 15 domain types (marketplace x4,
   projects/creators x5, manufacturing x3, trade/FX x3). `DOMAIN_ASSISTANT_TYPES`
   at line 180 is the set the plan's table omits entirely. A registry built to
   the plan's table would silently leave 15 supported operations unadvertised —
   exactly the "coverage row unimplemented" failure the plan's own README warns
   against.

2. **`onDeviceReadTools.ts` defects are on this branch too.** Document 01
   attributes them to the Codex branch. They are present verbatim here, so the
   correction is required in both products, not ported as a Codex-only fix.

3. **Read-tool name mismatch.** The plan's document 03 table specifies eleven
   new Gemma read tools (`read_profit_and_loss`, `search_parties`, ...). This
   branch's Needle training surface (`onDeviceTools.ts:41`) has only four
   (`report_query`, `party_lookup`, `inventory_profit`,
   `describe_capabilities`). The plan is right that these must be separate
   registries — Needle's compact `name/parameters` training format cannot absorb
   JSON Schema — but an implementer skimming the table could mistake the eleven
   for a rename of the four. They are additive and independent.

4. **`documentInterpretationRouter.ts` correctly noted as absent.** Verified: no
   router file exists under `src/accountingV2/`; `api.analyzeDocument`
   (`src/api.ts:1838`) holds the routing inline. Document 04 section 3 states
   this accurately.

5. **`api.pnlRange` field names.** Document 03's `PnlNumbers` type expects
   `expenses`, and the adapter maps it to `operatingExpenses`. The real
   `api.pnlRange` (`src/api.ts:1974`) returns `expenses` sourced from
   `partnershipDisplayFromReports(...).operatingExpenses`. The plan's mapping is
   correct, but it also returns `purchases` as a duplicate of `cogs`, which the
   plan does not mention; an adapter must not treat those as two figures.

6. **`api.v2BookVersion()` caveat is correct and load-bearing.** Document 04
   section 2 warns it is an accounting *schema* version, not a journal revision,
   and must not be used as stale-data protection. Confirmed. `getDataVersion()`
   (`src/utils/dataVersion.ts:30`) is an in-process counter — also not durable
   idempotency, as the plan says.

## Defects in the plan's own reference code

These are in the Markdown fences, which the plan explicitly labels as drafts.
Each was fixed during implementation of `src/accountingV2/gemma/agentCore.ts`.

1. **`return` inside `finally` (document 03 section 2).** The draft's cleanup
   block ends with `if (!successfulCleanup) return {...}` inside `finally`.
   That is `no-unsafe-finally`, part of `eslint:recommended`, which this project
   enforces via `npm run lint:ci` (`expo lint --no-cache --max-warnings 0`). It
   would have failed CI. Restructured: the turn body is a separate function and
   cleanup runs after it, so no control flow escapes a `finally`.

2. **Cancel is issued on the success path.** The draft calls `engine.cancel()`
   unconditionally in cleanup, including after the model returned a finished
   answer and the native host already closed the conversation. Harmless but it
   reports a completed turn to native as an interruption, which will confuse the
   N2 cancellation evidence. Now cancel is issued only when the turn stopped or
   was aborted; there is a regression test for it.

3. **`busy` is cleared by assignment, with no recovery path.** The draft sets
   `busy = !successfulCleanup`, leaving the coordinator permanently wedged after
   a failed native `finish()` with no way back except reloading the app. The
   plan's prose asks for an explicit `recoverEngine()` UI path, but the fence
   provides no hook. Added `isBusy()` and `recover()` to the returned agent, so
   the UI can reopen admission *after* actually recovering the engine — and
   cannot reopen it by accident.

4. **Unbounded recursion in `stable()`.** The draft's argument-signature helper
   recurses over model-supplied JSON with no depth limit. `parseFrame` caps total
   frame size, so this is not exploitable for a stack overflow in practice, but
   it is one validation change away from being so. Added a depth cap that
   reports `INVALID_ARGUMENTS`.

Two smaller notes, left as the plan had them because the behaviour is correct:
the post-loop `return { kind: 'stopped', code: 'TOOL_LIMIT' }` is unreachable
(the final round always throws or returns first) and is kept as a total-function
guard; and `abortable()` rejects on abort without cancelling the underlying
promise, which the plan already acknowledges and handles at the native layer.

## Gate status, stated honestly

The plan's own gates are the right ones and I did not weaken any of them. Their
real status in this clone:

- **P0 complete.** `ISOLATION.md`, `lab-baseline.json`, Needle hash pinned,
  `verify-isolation.mjs` passing (no commits, no remotes, weights unchanged).
- **P1 partially complete, gate NOT passed.** `spikes/gemma4/` compiles against
  the real `litertlm-android:0.17.0` classes on a desktop JVM.
  `build/sdk-check.json` records `androidBuild: not-run`,
  `modelInference: not-run`. The gate requires physical-Android execution with
  the pinned 2.6 GB E2B model. No device and no model are available here, so
  **P1 remains open**.
- **A blocker the plan flagged and the spike confirmed.** The SDK's published
  classes carry Kotlin metadata 2.4.0; this app's React Native build catalog
  pins Kotlin 2.1.20 / AGP 8.11.0. Adding the dependency to
  `modules/ledgr-native-ai/android/build.gradle` today would break the whole
  Android build. This must be resolved (compatible toolchain, or an earlier
  LiteRT-LM release that still has Gemma modalities plus manual tools) before
  any native wiring is applied. It is not fixable in TypeScript.

Because P1 is open, everything implemented for P2 onward is **code behind the
gate**: unit-tested and compile-checked where possible, but never presented as
device-proven. `IMPLEMENTATION_STATUS.md` records what was actually executed
versus what was not.
