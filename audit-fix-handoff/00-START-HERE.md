# Manus repair handoff

Prepared 2026-09-12. This is documentation only; no repair is applied by this package.

Read the complete shared handoff at:

[Master handoff](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-lab/audit-fix-handoff/00-START-HERE.md>)

That folder contains five implementation phases, TypeScript/Kotlin/CMake/workflow reference code, regression requirements and build/acceptance commands. Read all phases before implementation, then work in small validated batches.

For this lab, verify `codex/manus-gemma4-p0-p3` at `C:\Users\just2\Downloads\Ledger AI Codex\gemma4-manus-lab`. Preserve dirty implementation files and never copy the Codex tree over them. Main and the non-downloadable AI product remain untouched. No commit/push, phone, weights or publication.

Apply shared A01/A02/A03/A04/A05/A10/A11/A12, plus Manus-specific A07 and A13. Do not apply Codex A06/A08/A09 mechanically. The two agent APIs, paging contracts, party role handling and capital semantics differ. A shared cash journal-line uniqueness regression may reveal an additional Manus issue; verify independently and record it.

Create this folder's `REPAIR_STATUS.md` with Manus-only command results and applicable finding statuses. The master handoff's final table provides the acceptance checklist. Fixes remain pending until executed and verified; device acceptance remains pending afterwards.
