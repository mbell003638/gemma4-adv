# Luna: verification handoff after untested implementation

September 14 update: read FINAL-IMPLEMENTATION-HANDOFF.md, IMPLEMENTATION-ONLY-CHECKPOINT.md and each
*-FIX-CHECKPOINT.md first. They supersede the earlier task allocation below.
Production regression drivers and build/artifact verification tooling are
being implemented in this pass, with no execution authorized. Earlier suite
counts predate these changes. Keep code completion distinct from acceptance.

2026-09-13. Owner asked the implementing agent to make code edits but leave all testing to Luna. **Nothing in this implementation turn was tested, typechecked, linted, built or exported. No fresh APK exists.** Prior audit passing counts are not results for these edits.

Read REPAIR_STATUS.md, PRE_PHONE_AUDIT.md and the master five-phase handoff before running anything. Preserve this branch's dirty worktree. Do not commit/push/publish, download weights, modify other branches or connect a phone.

## What changed

- Both labs: agent-generated ScopedDraft extends Draft with REQUIRED originScope/requestId. AgentResult keeps its existing draft property instead of the handoff's proposed proposal property. Preparation still returns Draft; only trusted agent code attaches scope. Staging rejects unscoped inputs. This intentionally changes direct staging fixtures.
- Scope capture is frozen at run start and checked after native cleanup. Staging uses the original request ID/book and cancels on a subsequent scope mismatch. Screen response guards compare trusted scope and request sequence; stopped/failed Gemma requests no longer fall through to unrelated model inference.
- Exact confirmation classifier replaces durable and legacy prefix regexes.
- Codex: cash IDs now journal-line IDs; customer/supplier statement account sets are separate and include own-role advances. Statement grouping now uses journal ID/date with LEFT JOIN sources, preserving source-less/reversal journals. Capital is period-bounded and follows service rounding, commission/profit and legacy member-name matching.
- Manus: parties/inventory/members page by unique identity in the SQL-sorted list. Internal cursor version 2 invalidates old cursor shapes; dual-role party identity includes role.
- Native both: protocol 3; getStatus queues local verification; model download/removal/discard uses exclusive management ownership; verifiedFile rejects a changed stamp; close failures poison native runtime instead of reopening unsafe admission; failed begin/resume attempts cleanup; recovery is request-aware; attachment release is queued.
- JS management returns now parse JSON strings for remove/discardPartial/discardAttachments. Runtime health latch blocks reuse after failed cleanup. Settings polls verification and exposes removal for final bytes/error states and explicit recovery.
- Media uses one overall deadline and optional third-argument AbortSignal, mandatory request cleanup even on failed begin/preparation, late-preparation disposal, and rejects oversized PDF/combined rows. Device-only document routing propagates failure. Media capabilities remain OFF.
- Needle linker/flexible page options and workflow lab-only opt-in property are saved. Workflows were NOT dispatched. Default runtime remains off, Gemma must be selected explicitly.

## Historical assignment (superseded by FINAL-IMPLEMENTATION-HANDOFF.md)

1. Update fixtures for REQUIRED ScopedDraft envelope, original requestId, protocol 3 JSON management replies, and Manus v2 cursors. Do not make production fields optional to preserve obsolete test mocks.
2. Add the expected-correctness regressions in phases 1–4. The historical audit probes assert incorrect behavior and should NOT be repurposed by merely changing expected errors to accept failures.
3. A13 remains: migrate Manus check-host/check-downloads away from spike copies to actual production source seams; create runtime/coordinator injection seams if needed for genuine production lifecycle testing. Do not report the existing duplicate-based contracts as production coverage. This work was left with the test part, per owner's request.
4. Run types first and repair real errors; run focused regression suites, all Jest, standard Expo lint, and production Kotlin compile/contracts. Preserve tests of permissions, zero writes, rollback, confirmation/replay and book isolation.
5. Build both default and Gemma release variants; produce standalone test-signed APKs containing bundled JS. Check Needle asset preservation, every ELF LOAD/RELRO and APK ZIP alignment. CMake flags alone are NOT proof. Use new artifact paths rather than overwriting audit baseline APKs.
6. Update every A01–A13 row with actual evidence. Do not close A05/A12 without new artifacts. No phone/model performance/vision/audio/TTS gate can pass on host evidence alone.

## Focused edge cases needing particular attention

- Book/permission/location changes during native cleanup, staging create and screen delivery; no stale speech, preview, cloud fallback or wrong-book write.
- Dual-role statements, supplier/customer advances, source-less journals and reversals; capital close/reopen/commission/rounding/name matching. Compare ordinary authoritative screens/services, not just duplicated adapter SQL.
- Named cursor with reversed ID/name sort, duplicate names, dual roles, deleted anchor. Check Manus cash movement multi-line identity independently; the audited composite-ID bug was Codex-only.
- Failed/hung begin and finish, cancel-before-native-start, stale recovery A versus active B, status polling during download/remove and verification, fatal close/OOM. No native resource deletion while still in use.
- Late media preparation after timeout/cancel, PDF 5/6/8 pages and 50/51/150 combined rows; zero partial import.
- Old protocol 2 APK must be treated as requiring a rebuilt app, never re-downloading weights as a protocol upgrade.
- Workflow opt-in currently permits only this lab's exact codex/* repair branch. When owner later chooses real integration refs, update the explicit allowlist deliberately; never infer main is eligible.

Save REPAIR_STATUS.md after every coherent step with files, commands, actual results, and next action. Final report must distinguish code edits, executed checks, generated artifacts and phone-only pending work.
