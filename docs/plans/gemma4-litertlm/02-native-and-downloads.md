# Model delivery and native runtime

Applies ONLY inside `codex-sol-ai-fix` and `manus-branch`. Paths below are relative to the selected target checkout. Code is proposed, not compiled. First implement P1 as a small native spike; resolve SDK differences before wiring the app.

## 1. Dependencies and packaging

In `frontend/modules/ledgr-native-ai/android/build.gradle`, retain Needle CMake/ABI configuration and ML Kit. Replace the MediaPipe optional-LLM dependency after P1 passes:

```groovy
dependencies {
  implementation 'com.google.mlkit:text-recognition:16.0.1'
  implementation 'com.google.ai.edge.litertlm:litertlm-android:0.17.0'
}
```

Use `google()` in dependency repositories. Do not ship `latest.release`. Resolve the actual POM/transitive libraries and minSdk with Gradle; do not suppress manifest conflicts or pick arbitrary duplicate native libraries. Preserve arm64 targeting already present. Check Expo prebuild/config plugins so generated Android manifests do not erase configuration. Do not put changes only in an ephemeral generated `frontend/android` folder.

For the tested GPU path, add the SDK-documented optional native-library declarations under the module/app `<application>` as appropriate:

```xml
<uses-native-library android:name="libvndksupport.so" android:required="false" />
<uses-native-library android:name="libOpenCL.so" android:required="false" />
```

Keep INTERNET for model downloads, but no credentials in requests. Keep existing microphone/camera permissions requested at user action. Downloads must never occur automatically in device-only inference mode. “Offline inference” permits a separately initiated setup download, not silent network fallback.

## 2. Catalog schema 2

The old schema 1 must not cause an older MediaPipe APK to offer Gemma. Publish a distinct `model-packs-v2.json` only when deployment is authorized; ship a bundled fallback in the meantime. `main` must NOT receive that catalog as part of this plan. Choose an owner-approved catalog hosting location before enabling remote refresh; until then remote refresh is disabled.

Example full bundled catalog, proposed as `frontend/src/accountingV2/gemma/model-packs-v2.json`:

```json
{
  "schema": 2,
  "catalogVersion": 1,
  "packs": [
    {
      "id": "gemma4-e2b",
      "label": "Gemma 4 E2B",
      "runtime": "litert-lm",
      "minBridgeVersion": 2,
      "license": "Apache-2.0",
      "revision": "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1",
      "filename": "gemma4-e2b-181938105e0eefd1.litertlm",
      "bytes": 2588147712,
      "sha256": "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
      "downloadUrl": "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1/gemma-4-E2B-it.litertlm",
      "capabilities": ["text", "tools", "vision", "audio"],
      "rank": 10,
      "experimental": true
    },
    {
      "id": "gemma4-e4b",
      "label": "Gemma 4 E4B",
      "runtime": "litert-lm",
      "minBridgeVersion": 2,
      "license": "Apache-2.0",
      "revision": "2eee7ac325f20eb8c9ac1d0e972f7c84663062da",
      "filename": "gemma4-e4b-0b2a8980ce155fd9.litertlm",
      "bytes": 3659530240,
      "sha256": "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
      "downloadUrl": "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/2eee7ac325f20eb8c9ac1d0e972f7c84663062da/gemma-4-E4B-it.litertlm",
      "capabilities": ["text", "tools", "vision", "audio"],
      "rank": 20,
      "experimental": true
    }
  ]
}
```

`experimental` stays true until device gates pass. Model-declared capabilities are intersected with the verified bridge/device profile. They must not alone enable an unimplemented modality. Device RAM eligibility is a separate measured profile, not an invented manifest threshold.

Use one source catalog to generate native packaged assets and TypeScript types during implementation. For the first release, remote data can only select URLs for the **same compiled-approved hash/bytes/runtime/revision tuple**. A new model fingerprint requires a new reviewed build. A later signed-catalog design may allow new approved models without an APK; that needs signature verification, key rotation and rollback protection, not merely HTTPS plus a hash from the same untrusted manifest.

Validate network AND cached catalogs with the same parser. Version cache/storage keys (`ledgr_pack_manifest_cache_v2`, `ledgr_preferred_on_device_model_v2`). Do not cast cached JSON to trusted types. Old Qwen/Phi files remain inert legacy data; offer user-approved deletion, never load them in LiteRT-LM or delete them silently.

## 3. Verified model store — proposed Kotlin core

New `android/src/main/java/expo/modules/ledgrnativeai/GemmaPackStore.kt`. The constructor receives specs parsed from the **bundled native asset**, not arbitrary JS descriptors. Port JSON parsing using `JSONObject` and require every field shown in the catalog; require exactly the approved runtime and canonical filenames. A remote mirror can override the URL only after host policy checks; it cannot override the trusted hash/size.

```kotlin
package expo.modules.ledgrnativeai

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException

data class GemmaPackSpec(
  val id: String,
  val filename: String,
  val url: String,
  val bytes: Long,
  val sha256: String,
  val revision: String,
)

class GemmaPackStore(
  private val root: File,
  approved: List<GemmaPackSpec>,
) {
  private val packs = approved.associateBy { it.id }
  init {
    require(packs.size == approved.size)
    require(root.exists() || root.mkdirs())
    approved.forEach {
      require(it.bytes > 0 && it.bytes < 16L * 1024 * 1024 * 1024)
      require(it.sha256.matches(Regex("[0-9a-f]{64}")))
      require(it.revision.matches(Regex("[0-9a-f]{40}")))
      require(it.filename.matches(Regex("[A-Za-z0-9_-]+\\.litertlm")))
      require(it.url.startsWith("https://huggingface.co/"))
    }
  }
  private fun spec(id: String) = packs[id] ?: error("UNKNOWN_MODEL")
  private fun file(p: GemmaPackSpec) = File(root, p.filename).also {
    require(it.canonicalFile.parentFile == root.canonicalFile)
  }
  private fun checkStop(stopped: () -> Boolean) {
    if (stopped()) throw CancellationException("DOWNLOAD_PAUSED")
  }
  private fun verify(f: File, p: GemmaPackSpec, stopped: () -> Boolean = { false }) {
    check(f.isFile && f.length() == p.bytes) { "MODEL_SIZE_MISMATCH" }
    val digest = MessageDigest.getInstance("SHA-256")
    f.inputStream().buffered().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        checkStop(stopped)
        val n = input.read(buffer)
        if (n < 0) break
        digest.update(buffer, 0, n)
      }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    check(actual == p.sha256) { "MODEL_HASH_MISMATCH" }
  }
  fun verifiedFile(id: String): File = file(spec(id)).also { verify(it, spec(id)) }

  private fun allowed(url: URL): Boolean {
    val host = url.host.lowercase()
    return url.protocol == "https" && url.userInfo == null &&
      (url.port == -1 || url.port == 443) &&
      (host == "huggingface.co" || host == "hf.co" || host.endsWith(".hf.co"))
  }
  private fun connect(raw: String, offset: Long): HttpURLConnection {
    var url = URL(raw)
    repeat(6) {
      require(allowed(url)) { "MODEL_HOST_NOT_ALLOWED" }
      val c = url.openConnection() as HttpURLConnection
      c.instanceFollowRedirects = false
      c.connectTimeout = 15_000
      c.readTimeout = 30_000
      c.setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) c.setRequestProperty("Range", "bytes=$offset-")
      try {
        val status = c.responseCode
        if (status in listOf(301, 302, 303, 307, 308)) {
          val location = c.getHeaderField("Location") ?: error("BAD_REDIRECT")
          url = URL(url, location)
          c.disconnect()
        } else return c
      } catch (e: Exception) { c.disconnect(); throw e }
    }
    error("TOO_MANY_REDIRECTS")
  }

  // Execute on a worker, with one active download globally in the first release.
  // Pause leaves .part; explicit Remove deletes only this pack's exact files.
  @Synchronized
  fun download(
    id: String,
    stopped: () -> Boolean,
    progress: (received: Long, total: Long, phase: String) -> Unit,
  ): File {
    val p = spec(id)
    val dest = file(p)
    if (dest.exists()) { verify(dest, p, stopped); return dest }
    val part = File(root, p.filename + ".part")
    var offset = if (part.exists()) part.length() else 0L
    check(offset <= p.bytes) { "PART_TOO_LARGE_REMOVE_AND_RETRY" }
    // Conservative initial reserve; measure runtime cache needs separately.
    val required = (p.bytes - offset) + 512L * 1024 * 1024
    check(root.usableSpace >= required) { "INSUFFICIENT_STORAGE" }
    checkStop(stopped)
    if (offset < p.bytes) {
      val c = connect(p.url, offset)
      try {
        when (c.responseCode) {
          206 -> {
            val m = Regex("bytes (\\d+)-(\\d+)/(\\d+)")
              .matchEntire(c.getHeaderField("Content-Range") ?: "")
              ?: error("INVALID_CONTENT_RANGE")
            val start = m.groupValues[1].toLong()
            val end = m.groupValues[2].toLong()
            val total = m.groupValues[3].toLong()
            check(start == offset && end >= start && end < total && total == p.bytes)
            check(end == p.bytes - 1) { "PARTIAL_RANGE_RETRY_REQUIRED" }
          }
          200 -> {
            // Server ignored Range. Never append a whole file to a partial file.
            offset = 0
          }
          401, 403 -> error("MODEL_ACCESS_UNAVAILABLE")
          404 -> error("MODEL_NOT_FOUND")
          429 -> error("MODEL_HOST_RATE_LIMITED")
          416 -> error("RANGE_REJECTED_REMOVE_PARTIAL_AND_RETRY")
          else -> error("MODEL_HTTP_${c.responseCode}")
        }
        var received = offset
        var lastEvent = 0L
        c.inputStream.use { input ->
          FileOutputStream(part, offset > 0).use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              checkStop(stopped)
              val n = input.read(buffer)
              if (n < 0) break
              check(received + n <= p.bytes) { "MODEL_TOO_LARGE" }
              output.write(buffer, 0, n)
              received += n
              val now = System.currentTimeMillis()
              if (now - lastEvent >= 500) {
                progress(received, p.bytes, "downloading")
                lastEvent = now
              }
            }
            output.fd.sync()
          }
        }
        check(received == p.bytes) { "INCOMPLETE_DOWNLOAD_RETRY" }
      } finally { c.disconnect() }
    }
    progress(p.bytes, p.bytes, "verifying")
    verify(part, p, stopped)
    checkStop(stopped)
    // Same-directory rename. No copying into a filename that implies ready.
    check(!dest.exists() && part.renameTo(dest)) { "ATOMIC_INSTALL_FAILED" }
    progress(p.bytes, p.bytes, "ready")
    return dest
  }
}
```

Necessary integration around this core:

1. Use app-private **no-backup storage** for model packs; do not include gigabytes of weights in cloud backup or sync. Migrate old optional files only with explicit compatible-model checks; Qwen/Phi cannot be migrated into Gemma format.
2. Surface `not-installed/downloading/paused/verifying/ready/unsupported/error`, not just `File.exists()`. On restart revalidate a ready file before first load. Optimizations may cache verification against immutable file metadata but must be invalidated on replacement.
3. On hash failure retain no ready marker; present Remove/retry. The reference keeps the partial file for diagnostics/manual removal, never uses it as a model.
4. For production background downloads, wrap the core in an Android managed worker/foreground workflow selected for the target SDK. Persist unique work by pack fingerprint, network policy, progress and cancellation; reconnect UI on restart. Check current Android background-work restrictions before choosing WorkManager/foreground service. A wakelock alone does not guarantee background survival. It is acceptable for the initial release to explicitly support foreground download + resumable restart, but then do not advertise uninterrupted background downloading.
5. Supply a cancellation signal that can disconnect the active connection for prompt pause; the reference polls between reads and otherwise stops within the read timeout. Differentiate Pause (retain part), Remove (delete exact part/final after unload), and network error (retain resumable part).
6. Retry transient errors with bounded backoff and `Retry-After`; never loop on 401/403 or bypass a gate with embedded credentials. Download setup can explain unavailable hosting; inference remains offline.
7. Serialize install/delete/load operations per fingerprint. Reject delete while generating or cancel then await native release before deleting. The reference downloader's lock is not by itself a global lifecycle coordinator.
8. Do not automatically delete the last verified version before a new version is fully verified. Revision-specific filenames avoid in-place updates. Clean old versions only with the owner-approved retention policy.

## 4. Native manual-tool host — proposed Kotlin

New `GemmaSessionHost.kt`, same package. Expose through the existing `LedgrOnDeviceLlmModule` so Needle's module identity does not change. `resolveAttachment` accepts only app-issued short-lived attachment handles; see section 6. Do not accept arbitrary model paths, tool code, image URLs or raw filesystem paths from model output.

```kotlin
package expo.modules.ledgrnativeai

import com.google.ai.edge.litertlm.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicReference

private class SchemaOnlyTool(private val schema: String) : OpenApiTool {
  override fun getToolDescriptionJsonString(): String = schema
  override fun execute(paramsJsonString: String): String =
    error("AUTOMATIC_TOOL_EXECUTION_FORBIDDEN")
}

private fun jsonValue(value: Any?): Any? = when (value) {
  null, JSONObject.NULL -> null
  is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
  is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
  else -> value
}

class GemmaSessionHost(
  private val store: GemmaPackStore,
  private val cacheRoot: File,
  private val resolveAttachment: (String, String) -> File,
) : AutoCloseable {
  private var engine: Engine? = null
  private var engineKey: String? = null
  private var conversation: Conversation? = null
  private var sessionId: String? = null
  private var expectedCalls: List<Pair<String, String>> = emptyList()
  private var round = 0
  // Only cancellation touches this reference off the inference executor.
  private val running = AtomicReference<Pair<String, Conversation>?>(null)

  private fun closeConversation() {
    conversation?.close()
    conversation = null
    sessionId = null
    expectedCalls = emptyList()
  }
  fun begin(raw: String): String {
    check(sessionId == null) { "GEMMA_BUSY" }
    require(raw.length <= 40_000) { "REQUEST_TOO_LARGE" }
    val q = JSONObject(raw)
    val id = q.getString("requestId")
    require(id.matches(Regex("[A-Za-z0-9_-]{1,80}")))
    val model = q.getString("modelId")
    val hasImage = q.has("imageHandle")
    val hasAudio = q.has("audioHandle")
    require(!(hasImage && hasAudio)) { "ONE_MEDIA_KIND_PER_TURN" }
    val mode = q.getString("mode")
    require(mode in listOf("agent", "extract", "transcribe"))
    val definitions = q.getJSONArray("tools")
    require(definitions.length() <= 8)
    require(mode == "agent" || definitions.length() == 0)
    // Host backend profile is compiled/tested policy, not an arbitrary prompt option.
    val key = "$model:$hasImage:$hasAudio"
    if (engineKey != key) {
      engine?.close(); engine = null; engineKey = null
      val modelFile = store.verifiedFile(model)
      val candidate = Engine(EngineConfig(
        modelPath = modelFile.absolutePath,
        backend = Backend.CPU(),
        visionBackend = if (hasImage) Backend.GPU() else null,
        audioBackend = if (hasAudio) Backend.CPU() else null,
        maxNumTokens = 4096,
        maxNumImages = 1,
        cacheDir = File(cacheRoot, model).apply { mkdirs() }.absolutePath,
      ))
      try { candidate.initialize() } catch (e: Throwable) { candidate.close(); throw e }
      engine = candidate; engineKey = key
    }
    val tools = (0 until definitions.length()).map {
      tool(SchemaOnlyTool(definitions.getJSONObject(it).toString()))
    }
    val conv = checkNotNull(engine).createConversation(ConversationConfig(
      systemInstruction = Contents.of(q.getString("system")),
      tools = tools,
      automaticToolCalling = false,
      samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0),
      maxOutputToken = 768,
    ))
    conversation = conv; sessionId = id; round = 0
    return try {
      val content = mutableListOf<Content>(Content.Text(q.getString("input")))
      if (hasImage) content.add(Content.ImageFile(resolveAttachment(q.getString("imageHandle"), "image").absolutePath))
      if (hasAudio) content.add(Content.AudioFile(resolveAttachment(q.getString("audioHandle"), "audio").absolutePath))
      running.set(id to conv)
      frame(conv.sendMessage(Contents.of(content)))
    } catch (e: Throwable) { closeConversation(); throw e }
      finally { running.set(null) }
  }
  fun resume(raw: String): String {
    require(raw.length <= 20_000)
    val q = JSONObject(raw)
    check(q.getString("requestId") == sessionId) { "STALE_SESSION" }
    val responses = q.getJSONArray("results")
    check(expectedCalls.isNotEmpty() && responses.length() == expectedCalls.size)
    val content = expectedCalls.mapIndexed { index, expected ->
      val row = responses.getJSONObject(index)
      check(row.getString("callId") == expected.first && row.getString("name") == expected.second)
      Content.ToolResponse(expected.second, jsonValue(row.get("result")))
    }
    val conv = checkNotNull(conversation)
    return try {
      running.set(checkNotNull(sessionId) to conv)
      frame(conv.sendMessage(Message.tool(Contents.of(content))))
    } catch (e: Throwable) { closeConversation(); throw e }
      finally { running.set(null) }
  }
  private fun frame(message: Message): String {
    val request = checkNotNull(sessionId)
    round += 1
    check(round <= 5) { "STEP_LIMIT" }
    check(message.toolCalls.size <= 6) { "TOO_MANY_TOOL_CALLS" }
    expectedCalls = message.toolCalls.mapIndexed { i, c -> "$round-$i" to c.name }
    val calls = JSONArray()
    message.toolCalls.forEachIndexed { i, c ->
      calls.put(JSONObject().put("id", expectedCalls[i].first)
        .put("name", c.name).put("arguments", JSONObject(c.arguments)))
    }
    val text = message.contents.contents.filterIsInstance<Content.Text>()
      .joinToString("") { it.text }
    val result = JSONObject().put("requestId", request).put("text", text)
      .put("calls", calls).toString()
    check(result.length <= 24_000) { "RESPONSE_TOO_LARGE" }
    if (calls.length() == 0) closeConversation()
    return result
  }
  // Control executor only: request cancellation, never free a live engine here.
  fun cancel(requestId: String) {
    running.get()?.let { if (it.first == requestId) it.second.cancelProcess() }
  }
  // Inference executor only: also closes an idle session waiting for JS tool data.
  fun finish(requestId: String) { if (sessionId == requestId) closeConversation() }
  override fun close() {
    closeConversation(); engine?.close(); engine = null; engineKey = null
  }
}
```

This host intentionally uses typed SDK tool messages, not substring JSON extraction or arbitrary model prose as a command. It generates stable bridge call IDs because the inspected SDK represents calls by name/arguments. Responses must preserve order and cardinality, including repeated names. A turn containing any mutation ends the native session before user review; never leave it alive awaiting confirmation.

### Module bridge integration

Preserve `runNeedle`, `NeedleJni`, trained-tool serializers, OCR, recognizer and TTS exports. Remove only the old optional `LlmInference` fields, imports, `runPack()` and final MediaPipe dependency. Add a single inference executor, a control path and the new bridge methods. Example bridge pattern (inside the existing module, not a replacement file):

```kotlin
// Fields: initialize host/store lazily after appContext is available.
private val gemmaExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
private fun gemmaWork(promise: expo.modules.kotlin.Promise, work: () -> String) {
  gemmaExecutor.execute {
    try { promise.resolve(work()) }
    catch (e: OutOfMemoryError) { promise.reject("GEMMA_MEMORY", "Not enough memory for this model.", e) }
    catch (e: Exception) { promise.reject("GEMMA_FAILED", "The local model request failed.", e) }
  }
}
// In ModuleDefinition, after host is created:
// AsyncFunction("gemmaBegin") { raw: String, p: Promise -> gemmaWork(p) { host.begin(raw) } }
// AsyncFunction("gemmaResume") { raw: String, p: Promise -> gemmaWork(p) { host.resume(raw) } }
// AsyncFunction("gemmaCancel") { id: String -> host.cancel(id) }
// AsyncFunction("gemmaFinish") { id: String, p: Promise -> gemmaWork(p) { host.finish(id); "{}" } }
```

Resolve the actual lazy `host` property against this module's `context`, `noBackupFilesDir`, and attachment store. The code deliberately does not construct it before React context exists. Keep the executor alive until queued cancellation/close completes; OnDestroy requests cancel, queues `host.close()`, then shuts it down. Reject new requests after shutdown. Do not run JNI inference, hashing, file decoding or engine close on the UI thread.

Add a native FIFO admission coordinator with one accepted request ID, cancellation tombstone, and 60-second deadline. A request cancelled before its queued begin must never start. `gemmaCancel` must mark cancellation even during engine initialization; once initialization returns, check the mark before generating and close the session. The draft host's `cancel()` alone cannot interrupt initialization or queued begins. On timeout/lock, suppress all late responses in JS AND native. If the SDK cannot interrupt initialization, show “stopping” until cleanup finishes; never concurrently free live JNI objects.

Idle waiting-for-tools sessions expire after 15 seconds unless renewed by active local tool work. Session teardown must not race `sendMessage`. Gate N2 includes queued cancellation, in-flight cancellation, idle cancellation and stale callbacks. Do not advertise instantaneous cancellation based only on a JS timeout.

Use typed error codes for memory, unsupported backend, context full, invalid model, cancellation, stale scope and integrity. Do not show filesystem paths, signed CDN URLs, prompts or JNI stack traces in user messages/telemetry. A persistent native error unloads the engine; ordinary input validation errors need not invalidate known-good weights.

## 5. Build spike obligations

The reference uses `maxOutputToken` and `cancelProcess()` from inspected current Kotlin source. Compile against the chosen Maven binary before relying on them. If unavailable, choose a compatible published version or implement a supported bounded generation/cancellation strategy; do not remove limits to make compilation pass. Confirm model tool-template compatibility by requesting a real read tool, returning `Message.tool`, and obtaining an answer based on the returned value. Test vision/audio independently of text.

No `OpenApiTool.execute` callback may enter a domain service. Unit test that it throws even if accidentally invoked. Test that `automaticToolCalling` remains false after upgrades.

## 6. Attachment and audio preparation contract

Implement a native `GemmaAttachmentStore` with `stage(uri, kind, requestId) -> handle`, `resolve(handle, kind, requestId)` and `release(requestId)`. Handles are random opaque IDs issued by the app, bound to request/book lifetime. Restrict inputs to user-selected content URIs or the app's recording/camera cache. Reject HTTP(S), arbitrary file paths, symlinks outside approved roots and handle reuse across turns.

- Image: inspect bounds before decode, correct EXIF rotation, downscale to an initial 1,280-pixel longest side, strip metadata, encode private temporary JPEG/PNG. Cap source bytes and pixel dimensions to prevent decompression exhaustion. Recheck receipt legibility after resizing. Never read a giant original into JS base64 just for native inference.
- PDF: use Android `PdfRenderer` on a bounded copied file; render at most 5 pages per reviewed batch, one page per extraction session. A PDF URI is not an image. Report excluded pages explicitly and preserve document/page provenance in drafts. Existing OCR remains useful.
- Audio: decode the app's M4A/AAC recording with `MediaExtractor`/`MediaCodec`, downmix and resample to the SDK-tested mono PCM WAV format. Do not rename `.m4a` to `.wav`. Start with a 30-second UI recording limit; reject oversized/unsupported recordings. Use the exact sample rate accepted by the verified Gemma/SDK pair and document it in the device profile (16 kHz is a candidate, not assumed universal support).
- Release handles and temporary copies on success, cancellation, lock, book change, process recovery and TTL expiry. Exclude them from backup and prompt logs.

This media normalization is platform-specific implementation work, not an existing helper in the inspected app. Do not mark P6 complete by forwarding an unnormalized URI into the SDK. Unit-test orientation/size/duration/path checks and instrument actual camera, document-picker and recorder outputs.
