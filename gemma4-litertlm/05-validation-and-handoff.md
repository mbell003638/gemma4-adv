# Validation, release gates, and lower-cost executor handoff

## 1. Rules for the implementing agent

This document is a handoff, not authorization to implement right now. Once the owner explicitly authorizes application changes:

1. Confirm exact branch and worktree; implement only in `codex-sol-on-device-ai` and/or `Manus-on-device-ai` as authorized. `main` and `Ledger-Ai` application code are out of scope.
2. Read README and architecture first. Work one stage at a time. Reuse tested existing accounting code.
3. Before an edit, read that file's current version and relevant tests. Do not assume these baseline refs remain current.
4. Run a cheap relevant test after each bounded change; keep native spike ahead of broad UI changes.
5. Preserve Needle's asset hash, JNI behavior and training schema. Never rerun a training/download script casually; it can overwrite bundled assets or download large files.
6. No full model downloads without the owner's approval for size/network/device use. Tiny anonymous probe commands in this plan do not imply approval for multi-gigabyte downloads.
7. No commit, push, merge, PR, catalog hosting or publication unless separately authorized.
8. Every report must distinguish tested code, reference code, mocks and physical-device evidence. “TypeScript passes” does not mean a model runs on Android.
9. A failed native API or uncertain domain mapping is a narrow investigation task, not permission to delete safety checks, substitute a different model family, or modify the protected products.

## 2. Ready-to-use executor request

Copy this request with the package attached after deciding to implement:

> Implement the Gemma 4 + LiteRT-LM handoff in `docs/plans/gemma4-litertlm`, starting with P0 and P1 only. The permitted target is the existing `codex-sol-on-device-ai` worktree; preserve all unrelated changes. Do not modify application code in `main` or `Ledger-Ai`, and do not port to Manus until this stage's evidence is reviewed. Preserve locally trained Needle2 and its training/tool contract. The code fences are reference drafts: verify actual SDK methods and current branch APIs. Do not claim model support from a mocked test. Do not download full model files, commit, push, merge or publish without approval. Produce a small changed-file list, commands/results, remaining blockers and the next bounded task. Follow the explicit acceptance gates; do not implement later stages to distract from a failing native spike.

After P1 succeeds, replace the stage restriction with the next specific stage. For Manus use its own worktree and document 04 adapters. Keep a short `IMPLEMENTATION_STATUS.md` in the authorized target branch documenting completed gates and exact evidence; do not rewrite the architectural design every turn.

## 3. Proposed unit test file

Destination after implementation: `frontend/__tests__/gemmaAgentCore.test.ts`.

```typescript
import {
  createAgent, validate, parseFrame, type Engine, type Frame, type Scope,
  type ReadTool, type ProposalTool, type Schema,
} from '../src/accountingV2/gemma/agentCore';

const scope: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};
const noArgs: Schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const frame = (calls: Frame['calls'], text = ''): Frame => ({ requestId: 'request-1', calls, text });
function engineWith(first: Frame, next = frame([], 'The total is 125.')): Engine {
  return {
    begin: jest.fn(async () => first), resume: jest.fn(async () => next),
    cancel: jest.fn(async () => undefined), finish: jest.fn(async () => undefined),
  };
}
function readTool(): ReadTool {
  return {
    name: 'read_total', description: 'Read a fixture total.', feature: 'reports',
    access: 'read', parameters: noArgs, authorize: jest.fn(async () => true),
    read: jest.fn(async () => ({
      source: 'fixture-ledger', scope, asOf: '2026-09-08T10:00:00Z',
      data: { total: 125 }, truncated: false, nextCursor: null,
    })),
  };
}
function options(tools: (ReadTool | ProposalTool)[]) {
  return {
    requestId: 'request-1', modelId: 'gemma4-e2b', question: 'What is the total?',
    glossary: 'A bookkeeping application.', tools, canPropose: false,
    currentScope: async () => scope,
  };
}

test('strict schemas reject unknown fields, arrays as objects and nonfinite amounts', () => {
  expect(validate(noArgs, { sql: 'not allowed' })).not.toHaveLength(0);
  expect(validate(noArgs, [])).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, Infinity)).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, '125')).not.toHaveLength(0);
});

test('frame parser rejects malformed and duplicate call ids', () => {
  expect(() => parseFrame('not JSON')).toThrow();
  const call = { id: '1', name: 'read_total', arguments: {} };
  expect(() => parseFrame(JSON.stringify(frame([call, call])))).toThrow();
});

test('reads are returned to the model as structured evidence', async () => {
  const tool = readTool();
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  const result = await createAgent(engine)(options([tool]));
  expect(result.kind).toBe('answer');
  expect(tool.read).toHaveBeenCalledTimes(1);
  expect(engine.resume).toHaveBeenCalledWith('request-1', [expect.objectContaining({
    callId: '1', name: 'read_total', result: expect.objectContaining({ source: 'fixture-ledger' }),
  })]);
  expect(engine.finish).toHaveBeenCalledWith('request-1');
});

test('unadvertised tool is not executed', async () => {
  const tool = readTool();
  const engine = engineWith(frame([{ id: '1', name: 'factory_reset', arguments: {} }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('book switch after generation blocks all reads', async () => {
  const tool = readTool();
  let current = scope;
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  engine.begin = jest.fn(async () => {
    current = { ...scope, bookId: 'book-b' };
    return frame([{ id: '1', name: tool.name, arguments: {} }]);
  });
  const result = await createAgent(engine)({ ...options([tool]), currentScope: async () => current });
  expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('repeated tool request stops instead of looping', async () => {
  const tool = readTool();
  const call = frame([{ id: '1', name: tool.name, arguments: {} }]);
  const result = await createAgent(engineWith(call, call))(options([tool]));
  expect(result).toEqual({ kind: 'stopped', code: 'REPEATED_TOOL_LOOP' });
  expect(tool.read).toHaveBeenCalledTimes(1);
});

test('proposal preparation does not execute a domain write', async () => {
  const post = jest.fn();
  const tool: ProposalTool = {
    name: 'add_expense', access: 'proposal', feature: 'expenses', description: 'Prepare expense',
    parameters: { type: 'object', properties: { amount: { type: 'number', minimum: 0.01, maximum: 1e9 } },
      required: ['amount'], additionalProperties: false },
    authorize: async () => true,
    prepare: async args => ({ operation: 'add_expense', normalized: args, preview: 'Review INR 125', destructive: false, entityVersions: {} }),
  };
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: { amount: 125 } }]));
  const result = await createAgent(engine)({ ...options([tool]), canPropose: true });
  expect(result.kind).toBe('proposal');
  expect(post).not.toHaveBeenCalled();
  expect(engine.resume).not.toHaveBeenCalled();
});

test('mixed read/write batch executes neither', async () => {
  const read = readTool();
  const prepare = jest.fn(async () => ({ operation: 'write_fixture', normalized: {}, preview: 'Review', destructive: false, entityVersions: {} }));
  const write: ProposalTool = { name: 'write_fixture', description: 'Test proposal', feature: 'expenses',
    access: 'proposal', parameters: noArgs, authorize: async () => true, prepare };
  const engine = engineWith(frame([
    { id: '1', name: read.name, arguments: {} }, { id: '2', name: write.name, arguments: {} },
  ]));
  expect((await createAgent(engine)({ ...options([read, write]), canPropose: true })).kind).toBe('clarification');
  expect(read.read).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
```

The standalone `post` mock above illustrates separation but is not sufficient proof of no writes. Add integration spies on every relevant domain method/SQL write/outbox path during preparation. Run fixtures against real repository/domain code, not only disconnected mocks.

## 4. Mandatory test matrix

### Native and delivery

| ID | Scenario | Required outcome |
|---|---|---|
| N1 | SDK compile, E2B text/image/audio/tool round-trip | Physical Android execution with pinned model/runtime, no stub |
| N2 | Cancel queued begin, initialization, generation and tool wait | No late tool execution; proper cleanup; next request safe |
| N3 | Concurrent requests/model switch/delete | Serialized engine lifecycle; no use-after-free |
| N4 | SDK automatic tool execution attempted | Callback throws; no domain writes |
| N5 | Background/lock/process death | Session gone, sensitive media cleaned, resumable verified download state |
| N6 | GPU unsupported/OOM/context full | Correct user error, no fake corruption diagnosis, Needle still available |
| D1 | Anonymous pinned download | No auth/token; correct redirects and bytes |
| D2 | Interrupted network then HTTP 206 | Correct range start/end/total; exact final hash |
| D3 | Server ignores Range (200) | Restart file, no concatenation |
| D4 | Invalid Content-Range/416/401/403/404/429 | Safe explicit error/retry policy, no ready file |
| D5 | Short body/oversized body/checksum mismatch | Never installed/loaded; clear recovery |
| D6 | Pause vs Remove | Pause retains partial; Remove affects only selected exact files |
| D7 | Crash during install/failed rename | No partially copied file represented as ready |
| D8 | Legacy schema/cache/Qwen pin | No old model offered to new runtime; no silent deletion |
| D9 | Remote/cached manifest tampering | Reject changed fingerprint/runtime/path/host and duplicates |
| D10 | Airplane-mode restart after install | Verified model runs, no catalog fetch dependency |
| D11 | Low disk/full disk during download/hash/cache creation | No loss of prior good model; actionable error |

### Context and tool safety

| ID | Scenario | Required outcome |
|---|---|---|
| A1 | Unknown tool, extra keys, NaN/Infinity, malformed JSON | Rejected before access |
| A2 | User asks a read-only question, model proposes write | No posting; clarification/proposal authorization boundary |
| A3 | Scope/book/location/role changes mid-turn | Cancel/discard; no cross-scope result or confirmation |
| A4 | Duplicate names across customers/suppliers | Correct role and explicit clarification, no nearest-name guess |
| A5 | Model invents invoice/source/member ID | Ownership/existence lookup rejects |
| A6 | Repeated calls, many calls, huge results, timeout | Bounded stop/narrowing; no silent truncation of facts |
| A7 | Invoice notes/OCR contain instructions | Treated as data; cannot expand tool/permission scope |
| A8 | Feature disabled or actor unauthorized | Tool unadvertised and execution independently denied |
| A9 | Payroll/secrets/location restrictions | Only permitted minimum DTO returned; keys never in prompts |
| A10 | Tool error | No fabricated zero/profit/“done”; clear unavailable state |
| A11 | Old history or sync-updated records | Fresh reads and invalidated proposal revisions |
| A12 | Multi-call output includes proposal + reads | No partial action; reviewed single-change route |

### Accounting and workflow correctness

| ID | Scenario | Required outcome |
|---|---|---|
| B1 | Known postings, date range and cash/accrual basis | P&L exactly reconciles with authoritative reports |
| B2 | Trial balance and balance sheet | Actual V2 totals, no DTO coercion or missing-fields-as-zero |
| B3 | Opening balance/as-of vs period movements | Correct report semantics and labels |
| B4 | Partial receipt, supplier advance, duplicate invoice | Correct allocation/outstanding amounts and role |
| B5 | No user confirmation | Zero domain writes, party creates and outbox entries |
| B6 | Confirmation repeated/process crash/retry | Exactly one accounting effect, same result returned |
| B7 | Posting fails after prospective party creation | Whole transaction rolls back or proven durable recovery |
| B8 | Stale/expired/cancelled/modified proposal | Rejected, require a fresh reviewed proposal |
| B9 | Reversal/update/closed period | Existing audit/reversal and period rules preserved |
| B10 | Inventory counts and periodic COGS | No count overwrite/delete; no purchases-as-COGS shortcut |
| B11 | Existing capital/commission/location regression cases | Branch tests preserved; member/location context correct |
| B12 | Batch scan retry and duplicate image/page | No duplicate posting; partial status explicit if supported |

### Media and user experience

| ID | Scenario | Required outcome |
|---|---|---|
| M1 | Camera image vs content URI vs rotated image | Actual image reaches encoder, orientation/legibility correct |
| M2 | Huge image, invalid URI, another request's handle | Bounded decode and access rejection |
| M3 | PDF with more than page cap | Bounded rendering; user informed of excluded pages |
| M4 | M4A/AAC recording to WAV | Real conversion; amounts/names transcribed accurately |
| M5 | Audio/image extraction tries tools | No tools executed; extraction-only failure |
| M6 | Blurry receipt/missing total/invalid date | Flagged/clarified, not invented |
| M7 | TTS network-only voice/missing locale | No cloud speech in device-only mode; text fallback |
| M8 | TTS interruption/microphone feedback | Speech stops on recording; no self-transcription loop |
| M9 | Cancel/lock/book switch | Stop inference/audio, discard draft, clear media |
| M10 | Both packs installed, pinned/ineligible/missing pack | Honest tested selection, no surprise download |
| M11 | Device-only mode with valid cloud keys configured | Zero business-data network requests during all flows |

### Branch preservation

| ID | Scenario | Required outcome |
|---|---|---|
| R1 | Needle golden set and asset hashes | No unapproved weight change, no contract regression |
| R2 | Codex baseline tests | All existing relevant tests still pass |
| R3 | Manus baseline tests and added modules | Independently validated, not inferred from Codex result |
| R4 | `main` and `Ledger-Ai` | Application tree/SDK/catalog/UI unchanged |
| R5 | Coverage vs enabled feature registry | Every enabled feature explicitly mapped and tested |

## 5. Commands after implementation authorization

Run from the selected on-device checkout, not root `main`. Do not run every command automatically in the planning task.

```powershell
git status --short --branch
git rev-parse HEAD
git diff --check
```

From its `frontend` directory (use installed dependencies; `npm ci` requires network and may invoke native preparation scripts, so inspect before installing):

```powershell
npx tsc --noEmit
npm run lint:ci
npm test -- --runInBand gemmaAgentCore
npm test -- --runInBand onDeviceTools onDeviceToolContract onDeviceAgentLoop onDevicePackManifest onDeviceModelSelection
npm test -- --runInBand scanImport voicePartyResolution deviceSpeechRecognizer localOcr
npm run qa:release
```

Inspect actual test names and Jest matching; a “no tests found” result is not success. Add separate names for the new download, native, proposal and device tests. Run the branch's full test suite at integration milestones.

Native build commands depend on whether that branch tracks generated Android output. After reviewing its existing build workflow, run the same prebuild/native preparation and Gradle release pipeline used by CI. Verify the Needle asset/library preparation, Expo autolinking, target SDK/minSdk and signing constraints. A successful prebuild is not an APK compilation. Use a local test-signed build if release keys are owner-controlled; never print or copy signing secrets into the handoff.

## 6. Device evaluation and size measurement

Use at least one representative lower-memory supported device and one higher-memory device intended for E4B. Record OS, chipset, physical RAM, free RAM, free storage, thermal state, selected backend, artifact hash, runtime version and build identifier.

For each build, measure:

- App download/install footprint before vs after replacing MediaPipe; compare like-for-like release/ABI splits, not debug APK versus Play AAB.
- Native library contribution, bundled Needle contribution, model file size, inference cache size and total installed storage after E2B/E4B.
- Cold/warm time to first visible response, full answer latency, tokens/sec where exposed, peak PSS/RSS including GPU accounting caveats, battery/thermal behavior.
- Cancellation latency and recovery, model switch time, download pause/resume/verification time.
- Receipt field accuracy (amount/date/party/type), transcription amount/name accuracy, correct tool selection, clarification rate, numeric report faithfulness.
- Safety invariants: zero unauthorized writes, zero cross-book/location leaks, no false “posted” claims, no silent cloud fallback.

Proposed acceptance thresholds to review with the owner after P1: zero safety invariant failures in deterministic tests; all golden accounting fixtures exact; p95 cold/warm latency and memory budgets set from real device results. Do not invent an attractive fixed performance target then report it as measured. Neither E2B nor E4B must ship as “supported” on an untested profile solely from advertised RAM.

## 7. Recovery and rollout

Keep the old branch baseline recoverable through normal Git history; do not commit unless authorized. In each target product, gate the Gemma UI behind a local experimental setting until native/media/accounting gates pass. If Gemma fails, keep Needle, local OCR, manual screens and configured permitted cloud options intact; device-only never silently switches to cloud.

If a downloaded artifact is withdrawn or hosting changes, installed verified models should continue working offline. A catalog outage should show last-known bundled/verified options. A controlled mirror may restore future downloads, but hosting/bandwidth/costs and license notices require owner approval. No service can promise permanent third-party availability.

After validation, remove the MediaPipe optional inference dependency from the two target branches and remeasure. Never erase the user's old Qwen/Phi downloads without confirmation. Do not delete Needle assets as “unused” just because Gemma answers most questions.

## 8. Final implementation report template

```markdown
# Gemma integration stage report

- Target branch/worktree:
- Baseline and current HEAD (local evidence):
- Stage completed:
- Files changed:
- Protected application branches unchanged:
- Needle hash/contract evidence:
- SDK/model versions and hashes:
- Tests run, exact outcomes:
- Physical-device evidence (or explicitly not run):
- App size / model storage / peak RAM / latency:
- Coverage rows complete, guided, blocked:
- Known defects / unresolved SDK or domain assumptions:
- Next bounded stage:
- Commits/pushes/publication: none unless explicitly authorized.
```

## 9. Review checklist for the owner

- Does the APK truly run an image and an audio file through Gemma, not just OCR/Android recognition with a Gemma label?
- Does a read-tool response demonstrably affect the next model answer?
- Does Needle still execute the trained intent flow with Gemma removed?
- Are totals sourced from actual V2 reports, with dates/basis/location visible?
- Can duplicate confirmations, ambiguous parties, stale invoices or malicious receipt notes cause wrong postings?
- Are both downloadable branches tested separately, and are the other two products untouched?
- Is “all features” backed by the coverage register rather than unrestricted access?

Only after those answers have evidence should the integration be considered ready for release review.
