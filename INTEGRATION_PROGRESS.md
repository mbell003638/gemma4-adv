# Integration progress — 2026-09-12

This is the current state of the isolated Manus lab. No commit, push,
model-weight download, or Android-device run was performed. Both the default
MediaPipe/Needle variant and the opt-in Gemma variant were compiled and
packaged as arm64 debug APKs.

## Completed without a phone

- Manus keeps MediaPipe/Needle as its default source set and has a separate
  default-off LiteRT-LM Gemma source set, so variants cannot include both host
  classes accidentally.
- The E2B/E4B catalog, verified resumable downloader, session host, manual tool
  bridge, cancellation/cleanup, and source-set wiring are implemented. Desktop
  JVM checks compile the host against real LiteRT-LM 0.17.0 classes.
- Ask resolves only a bridge-verified installed pack with tested text/tools.
  Gemma uses question-specific live scoped tools for reports, cash, parties,
  invoices, entries, inventory, Business Accounts, and capabilities. It gets no
  broad serialized book snapshot.
- Trusted context is rechecked between tool steps and binds persisted book,
  app-lock/feature epochs, local owner, locations, currency, basis,
  date/timezone, journal revision, and sync entity revision. Synced identities
  fail closed until their grants can be persisted locally.
- Ten transaction-safe proposal operations are live behind durable ID-only
  confirmation. Write tools are selected by question family, and supplier or
  customer references resolve exactly within the current book with revision
  binding. Exact-role debtor/customer and supplier creation are also live, with
  duplicate-party refusal. Credit sales, taxed invoices, receipts, quotes,
  mutations, and Manus-only advanced operations remain guided or on the
  existing reviewed path where their current adapters cannot preserve every
  semantic safely.
- Advanced Settings includes separate E2B/E4B lifecycle controls. Offline-only
  TTS selection, locale, chunking, stop, and voice-data install handling preserve
  existing Manus voice/OCR behavior.
- Native image/PDF preparation enforces bounded private copies, EXIF rotation,
  downsizing/re-encoding, five-page review limits, request-bound handles, and
  cleanup. Audio now uses Android MediaExtractor/MediaCodec, a 60-second cap,
  mono 16 kHz resampling, and a real PCM WAV writer. Vision and audio remain
  unadvertised until the compiled Android path passes phone inference.
- JavaScript exposes those native media methods through bounded parsers and
  refuses calls until native reports the modality as device-verified.
- The real scan/import and transcription API routes now call those bounded
  Gemma media tasks in explicit Android-device mode. Voice UI can use the Gemma
  fallback only when native reports a ready pack with verified audio support.
- The coverage register is constrained to the same live proposal allowlist used
  by Ask. Marketplace, projects, creator, manufacturing, and trade remain
  explicitly guided instead of being falsely advertised as automated.

## Current verification

- TypeScript: pass.
- ESLint with zero warnings: pass.
- Full Jest suite: **148 suites / 1,271 tests**, all pass.
- SDK check: pass.
- Downloader: **35 host checks**, pass against a loopback HTTP server.
- Session host: **54 host checks**, pass with real SDK types and a fake runtime.
- Android API 36, NDK 27.1.12297006, CMake 3.22.1, command-line tools, and
  licenses: installed and accepted.
- Expo prebuild: pass with the tracked, idempotent Gemma toolchain plugin.
- Default arm64 APK (Kotlin 2.1.20): **145,072,709 bytes (138.35 MiB)**,
  SHA-256 `DAC4425F70614F941D33B0727D5B6B5EE49CCA7D81E5DAA908083F7260B15E94`.
- Gemma arm64 APK (Kotlin 2.4.0 / KSP 2.3.10): **167,471,245 bytes
  (159.71 MiB)**, SHA-256
  `2502F9E961D72FD0C517DFC9025DD855053DDE8BA7D70E30B3F95C6DE548A68B`.
- Matched Gemma dependency overhead: **22,398,536 bytes (21.36 MiB)**.
- APK archive check: both variants contain `lib/arm64-v8a/libneedle_jni.so`,
  `assets/needle2.cact`, and `assets/model-packs-v2.json`; Gemma additionally
  contains `lib/arm64-v8a/liblitertlm_jni.so`. Neither APK contains
  downloadable `.litertlm` or `.task` model weights.
- Needle2 SHA-256 remains
  24982abc3ed97b36192a16b0ea2758698c1a300853c01ab69e9decb3852d140f.
- No .litertlm model file exists in this lab.

## Remaining device gates

The SDK, license, Kotlin metadata, Gradle compilation, and APK packaging gates
are closed. The solution keeps Kotlin 2.1.20/KSP 2.1.20-1.0.29 for ordinary
builds and conditionally selects Kotlin 2.4.0/KSP 2.3.10 only when
`ledgrGemmaEnabled=true`; it does not use
`-Xskip-metadata-version-check`. The tracked Expo config plugin reapplies that
selection after prebuild, while the source-set flag keeps LiteRT-LM out of the
default MediaPipe/Needle variant.

A phone and real weights are still required for model load/tool-template
round-trip, RAM/thermal/latency, Android download lifecycle, vision, audio
conversion/transcription, airplane-mode TTS, microphone feedback, and
process-death cleanup. Until those runtime gates pass, device-verified
capability advertisement remains correctly disabled.

Preserved APKs are under `artifacts/android/`; use the matched arm64 pair for
size comparisons.
