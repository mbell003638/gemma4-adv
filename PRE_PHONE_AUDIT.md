# Manus pre-phone audit — 12 September 2026

**Not all clear. Findings are not fixed.** This remains the separate `codex/manus-gemma4-p0-p3` lab. No commits or pushes were made.

The full cross-branch audit, evidence, reproduction commands, and repair acceptance criteria are in [the detailed audit](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-lab/PRE_PHONE_AUDIT.md>). The probe scripts also live in that lab and accept this lab's absolute path; they load this branch's production sources rather than assuming Codex behavior.

## Manus-specific result

- Current full suite: 148 suites, 1,271 tests passed.
- TypeScript and standard Expo lint passed.
- Android JavaScript export passed, 1,981 modules; output is under this lab's `artifacts/audit-2026-09-12/android-export` and is not yet packaged into the saved APK.
- Broader whole-directory lint failed with 23 errors and 76 warnings; errors were in unchanged configuration/vendor files.
- Production-source probes reproduced wrong-book draft staging (A01), unsafe confirmation matching (A02), name/ID cursor mismatch (A07), media cleanup omission (A10), and silent document truncation (A11).
- Actual production Kotlin store probe reproduced restart-stuck VERIFYING (A03).
- Source/artifact inspection found incomplete removal/recovery (A04), 4 KB Needle ELF alignment (A05), Metro-dependent saved APK and default-off Gemma CI coverage (A12), and native scripts testing spike copies rather than shipped Kotlin (A13).
- Codex-only A06/A08/A09 were **not** assigned to Manus. Its role handling and capital date bounds differ; preserve those distinctions when fixing.

No fresh Gradle build, actual model inference, model download, or phone test was run in this audit. Six specialist agents stopped at usage limits without reports; the coordinating agent performed the reported checks directly. Existing passing tests do not cover the reproduced failures adequately.

Repair A01/A02 first, then Manus paging and the shared lifecycle/media defects; establish production native coverage and rebuild a standalone Gemma-enabled APK before phone acceptance. Follow the detailed report's acceptance tests. Do not copy Codex accounting adapters wholesale into this branch.
