# Architecture and implementation sequence

## 1. Desired product

In the two on-device branches only, the user can install E2B or E4B from Advanced Settings, use it without an account/token, and ask questions about the active book, scan documents, dictate transactions, and hear answers. Needle2 continues to handle specialized bookkeeping intent. No new training is required merely to integrate Gemma; tool schemas, current context, and validated retrieval are the primary connection to the app.

Target behavior:

```text
Typed request / reviewed transcript / selected document
  -> application routing and consent
  -> active-book, location, role, date, currency, enabled-feature context
  -> Needle2 fast path OR Gemma manual tool conversation
  -> typed read tools -> authoritative domain/reports -> bounded observations
  -> answer OR clarification OR immutable proposed change
  -> user review -> fresh authorization + domain validation
  -> existing transaction/reversal/sync-outbox machinery
  -> verified result -> optional local Android TTS
```

Gemma outputs text and tool requests, not synthesized voice. Reuse and harden `LedgrTtsModule` / `deviceTts.ts`. Do not advertise a full-duplex real-time voice assistant until latency, interruption, recognition, and audio-feedback behavior pass device tests.

## 2. Explicit non-goals

- No implementation in `main` or `Ledger-Ai`; no release/publication work.
- No cloud upload in device-only mode, including error recovery, telemetry, OCR, transcription, or TTS network voices.
- No Qwen/Phi retention requirement, automatic model conversion, or silent replacement of downloaded files.
- No native function that directly invokes arbitrary `api[name]`, raw SQL, filesystem access, external messages, shell commands, reset, credential export, or permissions changes.
- No initial NPU-specific builds, on-phone fine-tuning, automatic financial optimization, or unattended bulk posting.
- No promise that all enabled features fit into one prompt or that self-reported model confidence is reliable.

## 3. What exists and what must change

| Area | Current state in downloadable branches | Planned change |
|---|---|---|
| Needle2 | Bundled `.cact`, `libneedle.a`, JNI bridge | Preserve asset/engine/tool-training contract and run golden tests |
| Optional runtime | MediaPipe `tasks-genai:0.10.35` | Replace optional runtime with verified LiteRT-LM version |
| Catalog | Qwen/Phi, schema 1, optional checksums | Gemma-only schema 2, pinned artifacts, required integrity and runtime fields |
| Native optional call | Prompt -> string; image/audio parameters ignored | Session begin/resume, multimodal contents, typed tool requests, cancel/close |
| Ask | Needle 3-step reads then a 4,000-character snapshot/prose fallback | Bounded Gemma tool loop with selected capabilities, fresh context and citations |
| Reads | Four helpers, mostly rendered prose | Structured results, stable IDs, paging, date/location/basis correctness |
| Writes | `validateAssistantProposal` + Ask `applyAction` | Reuse domain actions, add scope/revision/idempotency checks and extract execution adapter |
| Scan | Local OCR/parser and branch-specific routing | Explicit Gemma vision choice, validated document extraction, review before import |
| Voice | Android recognizer + Needle | Preserve; add Gemma audio transcription mode and transcript review |
| TTS | Android default voice, 600-character truncation | Enforce installed offline voice, chunking, stop/cancel, locale and privacy |

### Verified defects not to copy into the new agent

`onDeviceReadTools.ts` in the Codex on-device branch reads `dashboard.sales/purchases/expenses` although the dashboard uses fields such as `totalSales/totalPurchases/netProfit`. Its balance-sheet helper treats nested objects as numbers. Its trial-balance helper expects `debit/credit/balanced`, whereas that facade returns arrays. Its cash-flow answer relabels a dashboard summary. Date arguments are ignored. These are integration correctness issues; they must not become Gemma's evidence.

Use `buildPersistentV2Reports` and existing reconciled report paths, not repaired guesses about UI DTOs. Test against known postings and actual report screens. Missing data must be explicit, never converted to zero.

The downloader currently accepts an optional checksum, checks installation by file existence, accepts broad HTTP success codes, and falls back from rename to copy. A cancelled download currently deletes partial data. It is not yet a durable verified model-package system. Preserve useful UI/progress code, not these assumptions.

## 4. Branch execution strategy

Implement the portable native host and pure TypeScript modules on `codex-sol-on-device-ai` first after the owner authorizes implementation. Port those isolated files to `Manus-on-device-ai`; separately adapt its API, features, scan router, Ask UI, permissions and proposal validator. Both must pass their own tests.

`Manus-on-device-ai` has additional workflows and different parser/feature APIs. `documentInterpretationRouter.ts` exists on the Codex branch but not Manus; Manus implements the route inside `api.analyzeDocument`. This is a concrete reason not to copy whole files.

Future merging into the two non-download branches is outside scope. If a later owner asks to share generic correctness fixes, isolate those changes from Gemma dependencies/catalog/UI. A JavaScript feature flag alone does not remove a native SDK from an APK.

## 5. Security and accounting boundaries

### Model access is bounded application access

The context owner captures book ID, location scope, accounting basis, currency, local date/timezone, actor/permission epoch, feature epoch, and data revision. The model cannot choose or expand that scope. Every read and proposal checks it. On lock, logout, book switch, role change or model switch: cancel, discard pending observations/proposals, clear native conversation, stop TTS.

Allow unconfirmed reads only when the current authenticated user is permitted to read those records. Payroll and personal information are not globally readable just because a tool is marked read-only. Strip keys, tokens, sync credentials, encrypted payloads and unrelated personal fields.

Only typed, curated tools execute. Validate shape, bounds, enum values, unknown keys and entity ownership outside the model. SQL parameters and fixed query templates are internal implementation details, never a model tool.

### Writes are proposals, not runtime side effects

1. Parse model tool call; reject unadvertised tool or invalid arguments.
2. Resolve entity references using scoped real records; clarify duplicates.
3. Build a normalized immutable proposal; calculate totals using accounting code.
4. Show counterparty, date, currency, lines/allocations, before/after values, tax, location, and reversal implications.
5. Require explicit current-user confirmation tied to that proposal ID.
6. Recheck scope, permission, entity revisions, open period, balances, allocations, limits, and duplicate/idempotency key in the transaction boundary.
7. Commit through domain services, including the existing sync outbox exactly once.
8. Return an actual committed identifier/result. Only then say “recorded.”

`executeAssistantProposal({confirmed:true})` by itself does not prove freshness, atomicity or idempotency. Extract the screen's `applyAction` into a shared adapter without changing semantics, then add the additional protections. Party creation and accounting posting must be atomic or have explicit recovery; the existing pre-confirm-handler materialization pattern must not leave orphan parties on later failure.

Never let an SDK automatic tool callback post records. Use `automaticToolCalling=false`; even an accidental callback must throw. Native code owns inference, TypeScript owns tool policy, domain services own accounting.

### Untrusted documents and observations

OCR text, invoice notes, audio transcriptions, imported data and retrieved record text can contain instruction-like content. Treat them as data, not authority. No tool exposure in extraction-only conversations. Never follow a document instruction to change settings, send data, create records outside the reviewed extraction, or bypass confirmation. Prompt wording is defense in depth, not the authorization system.

## 6. Context and retrieval design

Supply a small trusted context object, not the entire database and not the repository source. Use a static app glossary, active capabilities, dates/basis/currency, user-selected entities, and task-relevant schemas. Fetch records through tools as needed. Stable IDs are returned alongside human labels and never guessed.

Initial proposed budgets (tune from measurement, not claims of device capability):

- 4,096 native context tokens; reserve at least 768 for output and tool overhead.
- At most 8 advertised tools per turn, 4 read rounds, 6 total tool calls.
- At most 25 returned rows per list page; continuation cursor is opaque, scope-bound and not an arbitrary offset over changing data.
- At most 6,000 characters per observation, 16,000 across tool observations; overflow returns an explicit narrower-query request, not sliced invalid JSON.
- At most one mutation proposal per turn initially. Multi-step workflows use a dedicated reviewed batch transaction, not a model for-loop of writes.
- 60-second turn deadline as an initial UX budget, cancellation, one repair of malformed model output at most. An SDK token-limit error must lead to narrowing or a fresh smaller session.

Character budgets are backstops, not token accounting. Measure actual token use when SDK support permits. Track rendered tools/history/media overhead too. When exact counting is unavailable, conservatively bound input and handle context-exhausted errors honestly. Do not silently drop instructions, entity IDs, monetary lines or earlier tool results mid-conversation.

History is book-scoped and small. Do not feed old conversation summaries as fresh ledger evidence. Re-read facts after any data-version change. Model hidden reasoning is not evidence and should not be displayed/logged.

## 7. Model policy

Keep Needle2 available even when Gemma is not installed, fails, or is removed. Its tuned asset in the inspected Codex branch is 13,737,807 bytes (uncompressed file), independent of the Gemma runtime. Check and record the hash in each target branch before implementation and after builds; do not overwrite one branch's trained file with the other's.

Use E2B as initial default; offer E4B only for validated device profiles or a clearly marked experimental opt-in after memory checks. Do not invent a universal minimum-RAM guarantee from the previous Qwen/Phi thresholds. One Gemma engine at a time; Needle memory coexistence must be measured. Warm reuse is allowed only for the same verified model/backend profile; conversation state is isolated per user turn/book.

Do not automatically fall back from E4B to E2B if that requires a new download. Offer installed alternatives and identify the selected model. An initialization failure is not proof of corrupt download; check integrity and distinguish unsupported backend, insufficient memory, runtime error and damaged file.

## 8. Stages and stop gates

| Stage | Deliverable | Gate before next stage |
|---|---|---|
| P0 | Branch audit, hashes, baseline release sizes/tests, fixture book | Refs and untracked work preserved; two protected products untouched |
| P1 | SDK feasibility spike: E2B text + image + audio + manual tool response | Actual Android compilation and physical-device evidence; no stub pass |
| P2 | Verified resumable Gemma downloads and cache migration | Interrupted transfer, checksum mismatch, low storage, offline restart tests |
| P3 | Native host + JS bridge + lifecycle | Cancel, book switch, lock, engine failure and concurrent requests tested |
| P4 | Scoped context, schemas, reliable read adapters | Reconciled P&L/TB/BS fixtures; names/IDs/dates/permissions tests |
| P5 | Core proposals and confirmation executor | No pre-confirm side effects; atomicity/idempotency/reversal tests |
| P6 | Scan, transcription, local TTS | Modalities genuinely wired; no cloud packets in device-only mode |
| P7 | Per-branch feature coverage | Every enabled feature mapped to tested tool or explicitly guided screen |
| P8 | UI, legacy pack cleanup controls, size/performance/release QA | Both target branches pass independently; owner reviews release evidence |

No stage authorizes merging, committing or publishing. Test-only feature flags may be introduced in the two target branches; release dependency removal happens after Gemma gates pass. Implementations may temporarily retain MediaPipe during the spike but the desired final optional engine is LiteRT-LM only.

## 9. Definition of done

The two on-device products can download verified pinned models without credentials, run all advertised modalities offline, answer from correct scoped data, propose supported actions through existing accounting safeguards, and retain Needle2 behavior. Unsupported workflows are clearly identified. `main` and `Ledger-Ai` application trees are unchanged. Measured size, RAM, latency, correctness failures and device limitations are recorded, not hidden behind “seamless” or “perfect.”
