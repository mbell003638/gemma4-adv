# Ledgr: Gemma 4 + LiteRT-LM implementation handoff

Status: original reference design, now partly implemented in this isolated lab.
Prepared: 2026-09-08. The owner subsequently authorized implementation and audit fixes.
Read the current [audit and remaining work](../../../AUDIT_REVIEW.md) and
[implementation status](../../../IMPLEMENTATION_STATUS.md) before applying draft code.
Those records supersede outdated implementation claims in this reference package.

## Start here

This package is intended for a human developer or a lower-cost coding agent. Read the files in this order:

1. [Architecture, branch boundaries, and execution order](01-architecture.md)
2. [Model delivery and native runtime reference code](02-native-and-downloads.md)
3. [Context, tool schemas, and bounded agent reference code](03-agent-and-tools.md)
4. [Branch adapters, feature coverage, scan, voice, and UI](04-app-integration.md)
5. [Tests, acceptance gates, and executor instructions](05-validation-and-handoff.md)

The proposed target is **Gemma 4 E2B/E4B with LiteRT-LM**, not Gemini's hosted API, LiDAR, or a new cloud provider. Preserve the locally fine-tuned **Needle2** engine and weights. Qwen and Phi are not required by the owner.

## Four-branch contract — mandatory

| Existing branch | Local checkout at review | Application changes under this plan |
|---|---|---|
| `main` | repository root | NONE; no Gemma SDK, download catalog, or download UI |
| `Ledger-Ai` | `ledger-ai-wt` | NONE; retain its non-downloadable-model product |
| `codex-sol-on-device-ai` | `codex-sol-ai-fix` | Gemma runtime, downloads, context/tools, multimodal routing |
| `Manus-on-device-ai` | `manus-branch` | Same product objective, adapted to its own APIs/UI |

These Markdown documents happen to live under root `main`; that does **not** authorize modifying its application. No commits, pushes, merges, publishing, full model downloads, or app implementation were performed while writing this package. `packs/kotlin-download` is an additional worktree found locally, not one of the owner's four product targets; leave it alone.

## What this package can and cannot promise

It provides an end-to-end implementation specification, substantial proposed Kotlin/TypeScript code, integration anchors, branch-specific differences, coverage requirements, and test cases. Code fences are **reference implementation drafts**, not a compiled APK or certified production patch. The native SDK and domain adapters must pass the explicit compile/device/accounting gates before shipping.

There is no honest guarantee that a small model will understand every request perfectly. The enforceable goal is: every enabled supported feature has a typed tool or a truthful guided-screen fallback; book facts come from authoritative reads; ambiguity leads to clarification; all writes are validated, reviewed, scoped, and recoverable through existing accounting rules. A model is not a replacement for accounting invariants.

Do not claim “all features supported” while a coverage row is unimplemented. Do not give the model unrestricted database, filesystem, settings, network, credentials, or code-execution access to make that claim appear true.

## Verified baseline

Local refs, not a fresh remote synchronization:

| Branch | Reviewed HEAD |
|---|---|
| `main` | `fa0e2d715985443e7e3fd614875fe5b506852960` |
| `codex-sol-on-device-ai` | `badb3c738abda0ac70c875c44ccdbe078dcf02c2` |
| `Manus-on-device-ai` | `5b00321e6a90e9016d59c0179bec16cdc6a7a33c` |
| `Ledger-Ai` | abbreviated local ref `6301f26` |

Reinspect the active checkout and diff before implementation. Preserve untracked conversation exports and unrelated work. Do not copy an entire `api.ts`, Ask screen, or accounting directory between these branches.

### Download evidence

On 2026-09-08, unauthenticated Hugging Face metadata reported both repositories public, `gated: false`, `license: apache-2.0`. A 1,024-byte anonymous ranged GET to each pinned standard model returned HTTP 206 with the expected total size. This verifies current reachability and Range support, not a full Android download or model execution.

| Pack | Revision | Filename | Bytes | SHA-256 |
|---|---|---|---:|---|
| E2B | `b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1` | `gemma-4-E2B-it.litertlm` | 2588147712 | `181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c` |
| E4B | `2eee7ac325f20eb8c9ac1d0e972f7c84663062da` | `gemma-4-E4B-it.litertlm` | 3659530240 | `0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0` |

Revalidate hashes/metadata before release. Do not substitute similarly named GPU/web/NPU files without modality and device testing. File suffix alone does not prove runtime or modality compatibility.

### SDK evidence and deliberate uncertainty

Google Maven metadata returned `0.17.0` as its release version. Current public Kotlin documentation/source includes `Engine`, `EngineConfig`, `ConversationConfig`, `OpenApiTool`, manual tool calling, `Content.ImageFile`, `Content.AudioFile`, and `Conversation.cancelProcess()`.

The attempted `v0.17.0` GitHub tag and Maven sources archive were not available at the tested URLs. Consequently **the draft APIs were inspected in current upstream source, not compiled against that exact binary**. Gate N1 must resolve this before broad integration. If a property differs, adapt at the native host boundary and record the actual dependency version; do not spread version workarounds across the application.

## Documentation validation performed

The Markdown package was checked for balanced code fences and valid local document links. Its JSON catalog parsed successfully. All nine TypeScript fences passed syntax transpilation; the dependency-free agent core also passed an in-memory strict TypeScript check. In-memory smoke checks covered schema rejection, malformed-frame rejection, a read/tool-result/answer cycle, an unadvertised tool, and a book switch. These checks wrote no application files.

Not performed: Android/Kotlin compilation, SDK binary API verification, full model download, physical-device inference, Jest integration of the proposed files, or full accounting/security regression execution. Those remain mandatory implementation gates. The proposed code is not represented as fully production-tested.

## Sources and further verification

- [Google Gemma 4 mobile deployment](https://developers.google.com/edge/litert-lm/models/gemma-4)
- [Gemma 4 model card and modalities](https://ai.google.dev/gemma/docs/core/model_card_4)
- [LiteRT-LM Android guide](https://developers.google.com/edge/litert-lm/android)
- [Kotlin API, including manual tool calling](https://github.com/google-ai-edge/LiteRT-LM/blob/main/docs/api/kotlin/getting_started.md)
- [Current Kotlin configuration source](https://github.com/google-ai-edge/LiteRT-LM/blob/main/kotlin/java/com/google/ai/edge/litertlm/Config.kt)
- [Published Maven version metadata](https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/maven-metadata.xml)
- [E2B repository](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
- [E4B repository](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
- [Apache 2.0 conditions](https://www.apache.org/licenses/LICENSE-2.0)

Keep a copy of applicable model/runtime licenses and notices in the distribution. Apache licensing permits redistribution subject to its conditions; it does not guarantee indefinite free hosting or waive third-party hosting policies. A controlled mirror is an operational option, not something created by this plan.
