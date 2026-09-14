# Build fix checkpoint — 2026-09-14

Owner: Gradle/CMake/workflows and standalone build/ELF scripts only.
Status: bounded A05/A12 implementation complete, UNEXECUTED; artifact acceptance PENDING.

Final step saved: [2026-09-14-BUILD-A05-A12-HANDOFF.md](2026-09-14-BUILD-A05-A12-HANDOFF.md) contains exact file inventory, configured-JDK release build and separate verification commands, source-inspection evidence, and unresolved host/device gates. No new APK/hash/report generated. Synthetic tests and all validation remain NOT RUN. Earlier in-progress next-step notes below are historical checkpoints, superseded by this final status.

Step 2 saved: synthetic ELF/APK positive and negative regressions plus workflow source contracts in frontend/scripts/on-device-ai/test-standalone-apk.py. No tests executed. Source review moved signing override to AGP finalizeDsl (before variant creation), required a writable LOAD for RELRO, added an opt-in missing-Needle build failure and quoted CMake static-library paths. Existing conditional Kotlin configuration retained. Next: final source review and operator handoff.

Saved in this step:
- Existing 16 KB CMake linker flags, NDK27 flexible-page flag and conditional Kotlin 2.4.0/KSP 2.3.10 configuration preserved.
- frontend/scripts/on-device-ai/build-standalone.ps1: scoped full JDK17/21 selection, cached Gradle8.14.3, offline build, unique per-run artifacts and baseline comparison.
- frontend/scripts/on-device-ai/audit-testsigning.init.gradle: explicit audit-only release signing with local debug keystore, R8 disabled for class inspection.
- frontend/scripts/on-device-ai/verify-standalone-apk.py: packaged bundle/Needle/LiteRT/ABI/ELF/RELRO/ZIP/metadata and hashes.
- .github/workflows/gemma-standalone.yml and both caller workflows: manual lab opt-in runs default/Gemma matrix without release-secret inheritance. Default product jobs remain off for Gemma requests.

Next: source review, meaningful negative/positive verifier fixtures and workflow source contracts, operator commands and final checkpoint. No scripts, tests, builds, probes, validators, downloads, installs, commits or pushes executed. Branch/status and source/config file reads only.

Read-only JDK evidence: Android Studio jbr/release says JAVA_VERSION="25.0.3"; wrappers pin Gradle8.14.3. JDK selection must avoid that JBR. No usable local full JDK17/21 has been established; driver requires a supplied full JDK and fails without one. Native acknowledgment work for gemmaFinish/gemmaRecover belongs to the native owner, not this scope.
