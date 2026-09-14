# Bridge and integration checkpoint — 2026-09-14

Source edits only; no tests, typecheck, lint, builds or verification scripts executed.

- runtimeHealth.ts retains multiple failed request IDs. Explicit acknowledgement removes only its own ID.
- gemmaLifecycleReply.ts requires a bounded JSON reply with the exact requestId and finished:true.
- gemmaNative.ts uses that reply for finish/recover, blocks new wrappers during recovery, requires a native acknowledgement even when a status snapshot is idle, and bounds recovery waits.
- Runtime/media availability denies poisoned or managed state; native admission remains authoritative for races.
- JS PDF page bounds use MAX_DOCUMENT_PAGES from documentOutput.
- Codex recovery UI no longer embeds a Pressable inside Text.
- Deferred regression files: gemmaRecoveryAudit.test.ts, gemmaExplicitRecoveryAudit.test.ts. Manus gemmaNativeBridge.test.ts now refuses malformed cleanup acknowledgements and cleans its test-only latch afterward.

Native owner must emit matching acknowledgements through the serial production coordinator. No new acceptance claim follows from historical test counts.

Integration review: added a narrow .gitignore exception for the authored build-standalone.ps1 driver (the existing general *.ps1 rule hid it). This saves it as reviewable source without staging or committing anything.

Final source-review additions: missing attachment cleanup throws instead of silently returning zero; Codex preparation refuses active management. Deferred tests include late recovery replies after timeout. Updated the old on-device README to describe .litertlm Gemma packs correctly and preserve Needle. No scripts or tests executed.
