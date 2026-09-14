# Moving the Gemma native code into the app — NOT YET APPLIED

> **Open blocker.** The published SDK's classes carry Kotlin metadata **2.4.0**
> (its POM depends on kotlin-reflect 2.4.0 and kotlinx-coroutines-android
> 1.11.0). This app's React Native build-plugin catalog pins **Kotlin 2.1.20**
> and **AGP 8.11.0**. Adding the dependency today breaks the entire Android
> build, Needle included. Nothing in this document may be applied until that is
> resolved — either a compatible Kotlin/AGP/D8/R8 configuration validated with
> Expo, React Native and Needle together, or an earlier LiteRT-LM release that
> still implements Gemma's modalities and manual tool calling.
>
> Do **not** reach for `-Xskip-metadata-version-check`, and do not upgrade the
> whole product's Kotlin version to make one dependency resolve.

Everything below is the reviewed target state. It is written down so the
decision is visible, not so it can be pasted in.

## 1. Where the files go

| Spike file | Destination |
|---|---|
| `spikes/gemma4/src/GemmaPackStore.kt` | `frontend/modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai/GemmaPackStore.kt` |
| `spikes/gemma4/src/GemmaSessionHost.kt` | `.../src/gemma/java/expo/modules/ledgrnativeai/GemmaSessionHost.kt` |
| `spikes/gemma4/src/GemmaAttachmentStore.kt` | `.../src/gemma/java/expo/modules/ledgrnativeai/GemmaAttachmentStore.kt` |

The package changes from `ledgr.gemma.spike` to `expo.modules.ledgrnativeai`.
`LiteRtEngineFactory` is the only class that touches `Engine`/`Conversation`;
everything else already talks to the seam, so the JVM checks keep working.

`GemmaPackStore.kt` and `GemmaAttachmentStore.kt` have no Android imports today
and must gain only these: app-private **no-backup** storage for the model root
(`context.noBackupFilesDir`), and `MediaNormalizer` implemented with
`BitmapFactory`/`ExifInterface`, `PdfRenderer` and `MediaExtractor`/`MediaCodec`.
`PassThroughNormalizer` must not ship.

## 2. A flag-gated source set, default off

So the app build is byte-identical until the toolchain question is settled:

```groovy
// frontend/modules/ledgr-native-ai/android/build.gradle
def gemmaEnabled = project.findProperty('ledgrGemmaEnabled') == 'true'

android {
  sourceSets {
    main {
      if (gemmaEnabled) {
        java.srcDirs += 'src/gemma/java'
      }
    }
  }
}

dependencies {
  implementation 'com.google.mlkit:text-recognition:16.0.1'
  // MediaPipe stays until the Gemma gates pass; it is the runtime that ships.
  implementation 'com.google.mediapipe:tasks-genai:0.10.35'

  if (gemmaEnabled) {
    // Pinned. Never latest.release. Resolve the real POM and minSdk with
    // Gradle rather than suppressing a manifest or duplicate-so conflict.
    implementation 'com.google.ai.edge.litertlm:litertlm-android:0.17.0'
  }
}
```

Repositories must include `google()`. Keep the existing `arm64-v8a`
`abiFilters` and the Needle CMake block exactly as they are.

Removing MediaPipe is a separate, later change, made only after the device
gates pass and the size is re-measured. A JavaScript feature flag does not
remove a native library from an APK; both runtimes present at once is a real
size and memory cost, which is why the flag defaults off.

## 3. Manifest additions for the tested GPU path

Under `<application>` in the module (and the app manifest if Expo prebuild
regenerates it):

```xml
<uses-native-library android:name="libvndksupport.so" android:required="false" />
<uses-native-library android:name="libOpenCL.so" android:required="false" />
```

`INTERNET` stays for setup downloads. No credentials are ever attached to a
model request. Existing camera and microphone permissions stay
request-on-user-action.

Check the Expo prebuild and config plugins before relying on any of this: a
change that lives only in a generated `frontend/android` folder is lost on the
next prebuild.

## 4. Bridge additions to `LedgrOnDeviceLlmModule.kt`

Preserve `runNeedle`, `NeedleJni`, the trained-tool serializers, OCR, the
recognizer and TTS exports. The module's `Name("LedgrOnDeviceLlm")` does not
change, so Needle's identity on the JS side is untouched.

```kotlin
// Fields. Built lazily: the React context does not exist at construction.
private val gemmaExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
private val gemmaControl = java.util.concurrent.Executors.newSingleThreadExecutor()

@Volatile private var gemmaHost: GemmaSessionHost? = null

private fun host(): GemmaSessionHost = gemmaHost ?: synchronized(this) {
  gemmaHost ?: GemmaSessionHost(
    resolveModel = { id -> packStore().verifiedFile(id) },
    cacheRoot = File(context.noBackupFilesDir, "gemma-cache"),
    resolveAttachment = { handle, kind -> attachments().resolve(handle, kind, currentRequestId()) },
    factory = LiteRtEngineFactory(),
  ).also { gemmaHost = it }
}

private fun gemmaWork(promise: expo.modules.kotlin.Promise, work: () -> String) {
  gemmaExecutor.execute {
    try {
      promise.resolve(work())
    } catch (e: GemmaHostException) {
      // Typed code only. No path, URL, prompt or JNI stack trace reaches JS.
      promise.reject(e.code, userMessageFor(e.code), null)
    } catch (e: OutOfMemoryError) {
      promise.reject(GemmaError.OUT_OF_MEMORY, "Not enough memory for this model.", null)
    } catch (e: Exception) {
      promise.reject("GEMMA_FAILED", "The local model request failed.", null)
    }
  }
}
```

In `ModuleDefinition`:

```kotlin
AsyncFunction("gemmaBegin") { raw: String, p: Promise -> gemmaWork(p) { host().begin(raw) } }
AsyncFunction("gemmaResume") { raw: String, p: Promise -> gemmaWork(p) { host().resume(raw) } }
// Control path, NOT the inference executor: a cancel must not queue behind the
// generation it is trying to stop.
AsyncFunction("gemmaCancel") { id: String -> gemmaControl.execute { host().cancel(id) } }
AsyncFunction("gemmaFinish") { id: String, p: Promise -> gemmaWork(p) { host().finish(id); "{}" } }
```

`getStatus()` must be extended to report, separately: Needle availability, the
Gemma bridge availability, `bridgeVersion` (2), which model ids have actually
been integrity-verified, which modalities this build has been tested to run,
the selected backend, and the currently running request id. `frontend/src/utils/gemmaNative.ts`
already consumes exactly those fields.

Two executors are required, not one. The single inference thread serialises
`begin`/`resume`/`finish` so two JNI calls can never overlap; the control thread
carries `cancel` so it can mark the tombstone while inference is busy.

`OnDestroy` order: request cancel for any live request, queue `host.close()` on
the inference executor, then shut both executors down and reject anything new.
Never free a live JNI object from another thread.

Nothing here may run on the UI thread — not inference, not hashing, not image
decoding, not engine close.

## 5. What still has no implementation

These are work items, not oversights:

- The Android media normalisation named in section 1.
- A managed background/foreground download workflow around `GemmaPackStore`
  (persisted unique work by pack fingerprint, progress reconnect after process
  death). Until that exists, the product must advertise foreground download
  with resumable restart, not uninterrupted background downloading.
- The SQLite `assistant_proposals` table and the transaction-scoped
  exactly-once commit executor from plan document 03 section 6.

## 6. Verifying the move

Run the JVM checks first — they are cheap and they still apply after the
package rename:

```powershell
node spikes/gemma4/verify-isolation.mjs
$env:GEMMA_JDK = 'C:/Program Files/Android/Android Studio/jbr'
node spikes/gemma4/check-sdk.mjs
node spikes/gemma4/check-downloads.mjs
node spikes/gemma4/check-host.mjs
```

Then, and only after the Kotlin/AGP question is answered, the real gate: build
the APK, run all four `LiteRtFeasibility.run` modes on a physical device with
verified E2B weights, and record device, chipset, RAM, backend, runtime
version, artifact hash, output and latency. A successful Expo prebuild is not
an APK, and a JVM check is not a device.
