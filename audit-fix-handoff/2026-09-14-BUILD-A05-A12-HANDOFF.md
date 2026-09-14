# A05/A12 build handoff — manus — 2026-09-14

Implementation is prepared and source-reviewed only. No test, typecheck, lint, build, probe, parser/validation command, model/tool download, install, commit, push, or workflow dispatch was executed in this assignment. No new APK or verification report was generated. Existing audit APKs have not been replaced or reverified. A05/A12 artifact acceptance remains PENDING; device acceptance is NOT RUN.

Scope: [gemma4-manus-lab](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab>) on local branch `codex/manus-gemma4-p0-p3`, read at assignment start. Existing dirty changes and other owners' scopes preserved. No remote branch existence is claimed.

## Saved implementation

- Preserved prior 16 KB Needle max/common-page linker flags, NDK27 flexible-page configuration and conditional Kotlin plugin. Added `-PledgrRequireNeedle=true` to audit builds so a missing static library fails explicitly instead of silently dropping Needle. Quoted CMake library paths for the workspace path containing spaces.
- Local driver accepts only full JDK17/21 from explicit `-JdkHome`, or explicitly configured `GEMMA_JDK` / `JAVA_HOME`. Reads the JDK release file and requires java plus javac; does not search installers, run version probes or download a JDK. Changes Java/PATH only within its process and restores them in finally.
- Requires an already extracted Gradle8.14.3 directory, calls its executable directly, uses `--offline`, disables SDK auto-download and configuration cache. No wrapper bootstrap/download fallback. Missing cached dependencies stop the future build.
- Produces arm64 release variants with embedded JS and an audit-only signing init script applied at AGP finalizeDsl. Uses local Android debug signing, disables R8/resource shrinking for observable runtime classes, requires uncompressed native libraries. This is test signing, not publication signing.
- Each local run creates a timestamp/UUID artifact directory. Gemma is copied before the default build can overwrite app-release.apk. Each successful variant has a JSON report with APK size/SHA256, bundle hashes, Needle hash, all ELF segments and ZIP offsets, catalog/assets and application metadata; request details/build logs are saved too.
- Read-only APK verifier uses Python's standard library; no native extraction. Checks nonempty bundled JS/Hermes, arm64-only JNI, required Needle/catalog/LiteRT assets, LiteRT descriptors in DEX with R8 disabled, absent LiteRT in default, byte-for-byte Needle preservation against the supplied historical APK, every LOAD alignment/congruence, writable LOAD containment and aligned end of GNU_RELRO, uncompressed 16 KB native ZIP offsets, external zipalign and aapt2 exit status. minSdk24, targetSdk36, package `com.ahem.ledgrai` are asserted.
- Manual `gemma_runtime=true` on either existing workflow routes this exact lab branch to the new secret-free reusable default/Gemma matrix. Gemma requests skip the existing secret-aware APK/AAB publication job; normal default jobs retain their previous behavior. No secrets inheritance or AAB publishing in the new job. Its future CI run uses normal dependency setup/network resolution; it is NOT the offline local driver.
- Synthetic regression code covers original 4 KB LOAD rejection, congruence, missing/misaligned RELRO, wrong architecture, valid 16/64 KB alignment, Metro-only/missing bundle, required assets, modified Needle bytes, default LiteRT leakage, every vendor library, compression/ZIP offset errors, duplicate entries, package/SDK mismatch, and external zipalign failure. Source contracts cover branch opt-in, matrix flags, default-off behavior, and preserved Kotlin/Needle flags. These tests have NOT RUN.

## JDK evidence and boundaries

Source/config reads found Gradle8.14.3 in both wrapper properties; installed React Native catalogs declare AGP8.11.0, NDK27.1.12297006, minSdk24 and targetSdk36. Android Studio's `C:/Program Files/Android/Android Studio/jbr/release` declares Java25.0.3. The earlier `Unsupported class file major version 69` is a recorded Gradle/build-process failure, not an unresolved LiteRT Kotlin metadata problem. The existing plugin already conditionally selects Kotlin2.4.0/KSP2.3.10 for Gemma and retains the default Kotlin2.1.20 path. No metadata bypass was added and no global toolchain changed.

A compatible installed full JDK17/21 path has not been established here. Configure an existing one explicitly for future execution; do not infer that the Android Studio JBR is suitable. A listed Adoptium JRE21 is not a full JDK. No JDK install/download was attempted.

## Future commands — DO NOT RUN under the current instruction

After execution is separately authorized, run one lab at a time. Replace the three configured tool-path placeholders with existing local paths. Keep the historical APK baseline shown here.

```powershell
$buildArgs = @{
    Runtime = 'both'
    JdkHome = '<existing full JDK 17 or 21 directory>'
    GradleHome = '<existing extracted gradle-8.14.3 directory>'
    BuildTools = '<existing Android SDK build-tools/36.0.0 directory>'
    BaselineApk = 'C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/artifacts/android/manus-gemma-arm64-debug.apk'
}
& 'C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/build-standalone.ps1' @buildArgs
```

`-Runtime gemma` or `-Runtime default` prepares only the selected release artifact. Use `-Prebuild` only when authorized to regenerate this lab's Android config; it runs offline non-clean prebuild with --no-install. It preserves generated configuration edits unless Expo regeneration itself changes them; review such changes before subsequent work. The driver rejects changed release signing configuration.

Run the standalone regression suite after test execution is authorized:

```powershell
python -B 'C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/test-standalone-apk.py'
```

Reinspect a newly produced artifact separately, only after verification is authorized:

```powershell
python -B 'C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/verify-standalone-apk.py' --apk '<new Gemma standalone APK>' --runtime gemma --package com.ahem.ledgrai --min-sdk 24 --target-sdk 36 --baseline-apk 'C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/artifacts/android/manus-gemma-arm64-debug.apk' --zipalign '<installed zipalign.exe>' --aapt2 '<installed aapt2.exe>'
```

For default, change `--runtime` and the APK path together. JSON is stdout; preserve it in a new evidence path. An exception/nonzero exit is a failed gate, never success. In CI the reference is the tracked tuned Needle asset; that proves source-asset preservation, not comparison against an unavailable historical APK. Local baseline mode supplies that historical comparison.

## Remaining acceptance

- Run the new synthetic tests and workflow/config checks when authorized; no syntax or runtime validation has occurred.
- Supply a compatible full JDK and cached Gradle/Android dependencies. Run both standalone variants independently in each lab. Generated APK paths/hashes: NONE from this assignment.
- Inspect actual newly packaged binaries/ZIP/metadata and keep the emitted evidence. Existing vendor libraries may still fail the all-library/RELRO gate. Alignment flags do not establish that vendor code supports 16 KB pages at runtime.
- No apksigner signature/certificate audit is implemented in this verifier; signing is constrained by the audit init script. Installation and signing acceptance still need future Android tool/device checks.
- Phone gates from PRE_PHONE_AUDIT remain: installation/restart; downloads/resume/tamper; model load and inference; scoped reads and confirmation writes; Needle coexistence; vision/audio; cancellation; offline TTS; RAM/heat/latency; 16 KB runtime behavior. No model performance, media readiness or Play-readiness claim.
- Native owner must complete request-local `gemmaFinish` / `gemmaRecover` acknowledgment matching JS `{requestId, finished:true}`. Not edited or assessed by this build owner.

## Exact files changed by this owner

- [.github/workflows/android-native-validation.yml](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/.github/workflows/android-native-validation.yml>)
- [.github/workflows/build-apk.yml](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/.github/workflows/build-apk.yml>)
- [.github/workflows/gemma-standalone.yml](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/.github/workflows/gemma-standalone.yml>)
- [frontend/modules/ledgr-native-ai/android/build.gradle](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/modules/ledgr-native-ai/android/build.gradle>)
- [frontend/modules/ledgr-native-ai/android/src/main/cpp/CMakeLists.txt](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/modules/ledgr-native-ai/android/src/main/cpp/CMakeLists.txt>)
- [frontend/scripts/on-device-ai/audit-testsigning.init.gradle](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/audit-testsigning.init.gradle>)
- [frontend/scripts/on-device-ai/build-standalone.ps1](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/build-standalone.ps1>)
- [frontend/scripts/on-device-ai/verify-standalone-apk.py](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/verify-standalone-apk.py>)
- [frontend/scripts/on-device-ai/test-standalone-apk.py](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/frontend/scripts/on-device-ai/test-standalone-apk.py>)
- [audit-fix-handoff/BUILD-FIX-CHECKPOINT.md](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/audit-fix-handoff/BUILD-FIX-CHECKPOINT.md>)
- [audit-fix-handoff/2026-09-14-BUILD-A05-A12-HANDOFF.md](<C:/Users/just2/Downloads/Ledger AI Codex/gemma4-manus-lab/audit-fix-handoff/2026-09-14-BUILD-A05-A12-HANDOFF.md>)

The conditional Kotlin plugin and its existing test file were read and preserved, not edited. Shared REPAIR_STATUS and other agents' checkpoint files were not overwritten.

