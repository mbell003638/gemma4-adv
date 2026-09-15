package expo.modules.ledgrnativeai

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import com.google.mediapipe.tasks.genai.llminference.LlmInference.LlmInferenceOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray

/**
 * Bundled Needle 2 (libneedle.a + needle2.cact) for tool calling, plus optional
 * downloadable model packs run through MediaPipe. Needle stays the default for
 * transactions -- its decoding is grammar-constrained, so it is the reliable one
 * for structured output; the packs answer open questions.
 */
class LedgrOnDeviceLlmModule : Module() {
  @Volatile private var engineLoaded = false
  @Volatile private var lastToolsJson = ""

  private class ActiveDownload(
    val modelId: String,
    val tmpFile: File,
    @Volatile var connection: HttpURLConnection? = null,
    @Volatile var isCancelled: Boolean = false
  ) {
    fun cancel() {
      isCancelled = true
      try {
        connection?.disconnect()
      } catch (_: Throwable) {}
      try {
        if (tmpFile.exists()) {
          tmpFile.delete()
        }
      } catch (_: Throwable) {}
    }
  }

  private val activeDownloads = ConcurrentHashMap<String, ActiveDownload>()

  /** Guards load/generate/close so two calls cannot hold two multi-GB engines. */
  private val engineLock = Any()
  @Volatile private var loadedPack: LlmInference? = null
  @Volatile private var loadedPackId: String? = null

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  // --- Gemma (LiteRT-LM) optional runtime -----------------------------------
  //
  // Deliberately separate from everything above. Needle is the grammar-
  // constrained path the app depends on for structured output, and it has to
  // keep working with no Gemma pack installed, a failed engine, or the pack
  // deleted. Nothing in this section touches `engineLoaded`, `NeedleJni` or
  // the bundled `.cact` asset.

  /**
   * One inference thread for the whole module.
   *
   * Loading and running a multi-gigabyte engine is not something to do on the
   * UI thread, and a single thread is also how `GemmaSessionHost`'s
   * single-threaded contract is kept: begin, resume and finish are queued here
   * in order and can never overlap.
   */
  private val gemmaExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "LedgrGemmaInference").apply { isDaemon = true }
  }

  /** Admitted request id. A second concurrent turn is refused, not queued behind. */
  private val gemmaAdmitted = AtomicReference<String?>(null)
  private val gemmaCancelled = AtomicReference<String?>(null)
  private val gemmaShutdown = AtomicBoolean(false)
  private val gemmaPoisoned = AtomicBoolean(false)
  private val gemmaDownloadStops = ConcurrentHashMap<String, AtomicBoolean>()

  @Volatile private var gemmaHostRef: GemmaSessionHost? = null
  @Volatile private var gemmaStoreRef: GemmaPackStore? = null
  @Volatile private var gemmaAttachmentsRef: GemmaAttachmentStore? = null
  @Volatile private var gemmaMediaRef: GemmaMediaNormalizer? = null

  /**
   * Model packs live in no-backup storage.
   *
   * Several gigabytes of weights have no business in a cloud backup or on a
   * new device restore, and they are re-downloadable by definition.
   */
  private fun gemmaRoot(): File = File(context.noBackupFilesDir, "gemma-packs").apply { mkdirs() }

  private fun gemmaCacheRoot(): File = File(context.cacheDir, "gemma-runtime").apply { mkdirs() }

  private fun gemmaAttachmentRoot(): File = File(context.cacheDir, "gemma-attachments").apply { mkdirs() }

  private fun approvedPacksJson(): String =
    context.assets.open(GemmaCatalogAsset.ASSET_NAME).use { it.readBytes().decodeToString() }

  @Synchronized
  private fun gemmaStore(): GemmaPackStore {
    gemmaStoreRef?.let { return it }
    // Specs come from the packaged asset, never from a JS descriptor: a
    // reviewed build decided the hash, the size and the commit.
    val created = GemmaPackStore(gemmaRoot(), GemmaCatalogAsset.parse(approvedPacksJson()))
    gemmaStoreRef = created
    return created
  }

  @Synchronized
  private fun gemmaAttachments(): GemmaAttachmentStore {
    gemmaAttachmentsRef?.let { return it }
    val created = GemmaAttachmentStore(gemmaAttachmentRoot())
    gemmaAttachmentsRef = created
    return created
  }

  @Synchronized
  private fun gemmaMedia(): GemmaMediaNormalizer {
    gemmaMediaRef?.let { return it }
    val created = GemmaMediaNormalizer(context.contentResolver, gemmaAttachments())
    gemmaMediaRef = created
    return created
  }

  @Synchronized
  private fun gemmaHost(): GemmaSessionHost {
    gemmaHostRef?.let { return it }
    // Built lazily: `context` does not exist until React is up, so a field
    // initialiser here would throw during module construction.
    val created = GemmaSessionHost(gemmaStore(), gemmaCacheRoot()) { handle, kind, requestId ->
      gemmaAttachments().resolve(handle, kind, requestId)
    }
    gemmaHostRef = created
    gemmaCancelled.get()?.let { created.requestCancel(it) }
    return created
  }

  /**
   * Runs one bridge call on the inference thread and maps failures to codes.
   *
   * User-facing messages here are deliberately generic. A JNI stack trace, a
   * filesystem path or a signed CDN URL in a rejection ends up in a support
   * screenshot, and the typed code is what the JS layer branches on anyway.
   */
  private fun gemmaWork(promise: Promise, requestId: String?, work: () -> String) {
    gemmaLifecycle.work(requestId, work) { outcome ->
      outcome.fold(
        onSuccess = { promise.resolve(it) },
        onFailure = {
          val code = when (it) {
            is GemmaPackException -> it.code
            is GemmaSessionException -> it.code
            else -> "GEMMA_FAILED"
          }
          promise.reject(code, gemmaMessageFor(code), null)
        },
      )
    }
  }

  private val gemmaLifecycle by lazy {
    GemmaLifecycle(
      gemmaExecutor, gemmaAdmitted, gemmaShutdown, gemmaPoisoned,
      store = { gemmaStore() },
      finish = { gemmaHostRef?.finish(it) },
      unload = { gemmaHostRef?.unloadEngine() },
      activeId = { gemmaHostRef?.activeRequestId() },
      loadedModel = { gemmaHostRef?.loadedModelId() },
      release = { gemmaRelease(it) },
    )
  }

  private fun scheduleInstalledVerification() = gemmaLifecycle.scheduleInstalledVerification()

  private fun gemmaTerminal(promise: Promise, requestId: String, recover: Boolean) {
    if (recover && gemmaAdmitted.get() == requestId) {
      gemmaCancelled.set(requestId)
      runCatching { gemmaHostRef?.requestCancel(requestId) }
    }
    gemmaLifecycle.terminal(requestId, recover) { outcome ->
      outcome.fold(
        onSuccess = { promise.resolve(it) },
        onFailure = {
          val code = (it as? GemmaPackException)?.code ?: "NATIVE_RECOVERY_REQUIRED"
          promise.reject(code, gemmaMessageFor(code), null)
        },
      )
    }
  }

  private fun gemmaManagement(promise: Promise, token: String, work: () -> String) {
    gemmaLifecycle.management(token, work) { outcome ->
      outcome.fold(
        onSuccess = { promise.resolve(it) },
        onFailure = {
          val code = when (it) {
            is GemmaPackException -> it.code
            is GemmaSessionException -> it.code
            else -> "GEMMA_FAILED"
          }
          promise.reject(code, gemmaMessageFor(code), null)
        },
      )
    }
  }

  private fun gemmaRelease(requestId: String) {
    // Retain ownership if private-media cleanup fails; never acknowledge early.
    gemmaAttachmentsRef?.release(requestId)
    gemmaCancelled.compareAndSet(requestId, null)
    gemmaAdmitted.compareAndSet(requestId, null)
  }

  private fun gemmaMessageFor(code: String): String = when (code) {
    "GEMMA_PDF_TOO_MANY_PAGES" -> "Split this PDF into files of at most five pages. Nothing was imported."
    "NATIVE_RECOVERY_REQUIRED" -> "Restart the app to recover the local runtime."
    "GEMMA_CANCELLED" -> "That request was cancelled."
    "GEMMA_BUSY" -> "The local model is already answering something else."
    "MODEL_HASH_MISMATCH", "MODEL_SIZE_MISMATCH" ->
      "This model file failed its integrity check. Remove it and download it again."
    "MODEL_NOT_INSTALLED", "UNKNOWN_MODEL" -> "Download this on-device model in Advanced Settings first."
    "INSUFFICIENT_STORAGE" -> "There is not enough free storage for this model."
    "STEP_LIMIT", "TOO_MANY_TOOL_CALLS" -> "That request needed too many steps. Try asking something narrower."
    "RESPONSE_TOO_LARGE" -> "The answer was too long to return. Try a narrower question."
    else -> "The local model could not complete that request."
  }

  override fun definition() = ModuleDefinition {
    Name("LedgrOnDeviceLlm")
    Events("downloadProgress")

    AsyncFunction("isAvailable") { needleReady() }

    AsyncFunction("getStatus") {
      scheduleInstalledVerification()
      val ram = totalRamBytes()
      // Needle availability and Gemma availability are reported separately on
      // purpose. An APK built before this bridge existed still exposes this
      // module for Needle, so the module being present proves nothing about
      // Gemma: JS must check gemmaBridgeVersion, not Platform.OS.
      val gemmaPacks = runCatching {
        val store = gemmaStore()
        store.approvedIds().associateWith { id ->
          mapOf(
            "state" to store.state(id).name.lowercase().replace('_', '-'),
            "bytesOnDisk" to store.installedBytes(id),
            "partialBytes" to store.partialBytes(id),
            "unsupportedReason" to store.unsupportedReason(id),
          )
        }
      }.getOrDefault(emptyMap())

      mapOf(
        "supported" to true,
        "needleAvailable" to needleReady(),
        "engineLoaded" to engineLoaded,
        "reason" to if (needleReady()) null else missingEngineReason(),
        "totalRamBytes" to ram,
        "gemmaBridgeVersion" to GemmaSessionHost.BRIDGE_VERSION,
        "gemmaBridgeAvailable" to true,
        "gemmaRecoveryRequired" to gemmaPoisoned.get(),
        "gemmaManagementOperation" to gemmaAdmitted.get()?.takeIf { it.contains(':') },
        "bridgeVersion" to GemmaSessionHost.BRIDGE_VERSION,
        // Modalities this bridge actually implements. A catalogue row claiming
        // more must be intersected with this, not trusted.
        // Media is implemented but remains unadvertised until the physical-device
        // validation gate proves the SDK/model paths on supported hardware.
        "gemmaCapabilities" to listOf("text", "tools"),
        "verifiedCapabilities" to listOf("text", "tools"),
        "verifiedModelIds" to gemmaPacks.filterValues { it["state"] == "ready" }.keys.toList(),
        "gemmaBackends" to mapOf("text" to "cpu", "vision" to "gpu", "audio" to "cpu"),
        "gemmaEngineLoaded" to (gemmaHostRef?.isEngineLoaded() ?: false),
        "gemmaLoadedModelId" to gemmaHostRef?.loadedModelId(),
        "gemmaActiveRequestId" to gemmaHostRef?.activeRequestId(),
        "runningRequestId" to gemmaHostRef?.activeRequestId(),
        "gemmaAdmittedRequestId" to gemmaAdmitted.get(),
        "gemmaPacks" to gemmaPacks,
      )
    }

    /**
     * Starts one Gemma turn.
     *
     * Admission is first-come and exclusive: a second turn is refused rather
     * than queued, because queueing behind a 60-second inference would mean a
     * user waiting on a request they can no longer see.
     */
    AsyncFunction("gemmaBegin") { raw: String, promise: Promise ->
      val requestId = runCatching { org.json.JSONObject(raw).getString("requestId") }.getOrNull()
      if (requestId == null || !requestId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) {
        promise.reject("INVALID_REQUEST_ID", "That local model request was malformed.", null)
      } else {
        try {
          gemmaLifecycle.admitRequest(requestId)
          gemmaWork(promise, requestId) { gemmaHost().begin(raw) }
        } catch (error: GemmaPackException) {
          promise.reject(error.code, gemmaMessageFor(error.code), null)
        }
      }
    }

    AsyncFunction("gemmaResume") { raw: String, promise: Promise ->
      val requestId = runCatching { org.json.JSONObject(raw).getString("requestId") }.getOrNull()
      if (requestId == null || gemmaAdmitted.get() != requestId) {
        // A late reply from an abandoned turn must not reach a live session.
        promise.reject("STALE_SESSION", "That request is no longer active.", null)
      } else {
        gemmaWork(promise, requestId) { gemmaHost().resume(raw) }
      }
    }

    /**
     * Marks a turn cancelled.
     *
     * Runs on the calling thread, not the inference thread: the whole point is
     * to be heard while that thread is busy inside `sendMessage` or a model
     * load. It only sets a flag and calls `cancelProcess()`; nothing here frees
     * a live JNI object.
     */
    AsyncFunction("gemmaCancel") { requestId: String ->
      if (gemmaAdmitted.get() == requestId) {
        gemmaCancelled.set(requestId)
        gemmaHostRef?.requestCancel(requestId)
      }
      // Queued-but-not-started work checks this mark before doing anything, so
      // a cancel that arrives first stops the turn from ever beginning.
      true
    }

    AsyncFunction("gemmaFinish") { requestId: String, promise: Promise ->
      gemmaTerminal(promise, requestId, recover = false)
    }

    AsyncFunction("gemmaRecover") { requestId: String, promise: Promise ->
      gemmaTerminal(promise, requestId, recover = true)
    }

    /** Prepare bounded app-private media before opening a Gemma session. */
    AsyncFunction("gemmaPrepareImage") { uri: String, requestId: String, promise: Promise ->
      gemmaWork(promise, null) {
        val prepared = gemmaMedia().prepareImage(uri, requestId)
        org.json.JSONObject(mapOf("handle" to prepared.handle, "pageCount" to 1, "excludedPages" to 0)).toString()
      }
    }

    AsyncFunction("gemmaPreparePdfPage") { uri: String, pageIndex: Int, requestId: String, promise: Promise ->
      gemmaWork(promise, null) {
        val prepared = gemmaMedia().preparePdfPage(uri, pageIndex, requestId)
        org.json.JSONObject(mapOf("handle" to prepared.handle, "pageCount" to prepared.pageCount,
          "excludedPages" to prepared.excludedPages)).toString()
      }
    }

    AsyncFunction("gemmaPrepareAudio") { uri: String, requestId: String, promise: Promise ->
      gemmaWork(promise, null) {
        val prepared = gemmaMedia().prepareAudio(uri, requestId)
        org.json.JSONObject(mapOf("handle" to prepared.handle, "durationMs" to prepared.durationMs,
          "sampleRate" to prepared.sampleRate)).toString()
      }
    }

    AsyncFunction("gemmaDiscardAttachments") { requestId: String, promise: Promise ->
      gemmaWork(promise, null) {
        if (gemmaAdmitted.get() == requestId || gemmaHostRef?.activeRequestId() == requestId) throw GemmaSessionException("GEMMA_BUSY")
        org.json.JSONObject().put("removed", gemmaAttachmentsRef?.release(requestId) ?: 0).toString()
      }
    }

    AsyncFunction("gemmaDownload") { modelId: String, promise: Promise ->
      gemmaManagement(promise, "download:$modelId") {
        checkWifiOrUnmetered()
        val stop = AtomicBoolean(false)
        if (gemmaDownloadStops.putIfAbsent(modelId, stop) != null) throw GemmaPackException("MODEL_DOWNLOAD_BUSY")
            try {
              withWakeLock("download-$modelId") {
                gemmaStore().download(modelId, { stop.get() }) { received, total, phase ->
                  sendEvent("downloadProgress", mapOf("modelId" to modelId, "received" to received, "total" to total, "phase" to phase))
                }
              }
              "{\"modelId\":${org.json.JSONObject.quote(modelId)},\"state\":\"ready\"}"
            } finally {
              gemmaDownloadStops.remove(modelId, stop)
            }
      }
    }

    AsyncFunction("gemmaPauseDownload") { modelId: String ->
      val active = gemmaDownloadStops[modelId]
      if (active == null) false else { active.set(true); true }
    }

    AsyncFunction("gemmaDiscardPartial") { modelId: String, promise: Promise ->
      gemmaManagement(promise, "discard:$modelId") {
        if (gemmaDownloadStops.containsKey(modelId)) throw GemmaPackException("MODEL_DOWNLOAD_BUSY")
        org.json.JSONObject().put("removed", gemmaStore().discardPartial(modelId)).toString()
      }
    }

    AsyncFunction("gemmaRemove") { modelId: String, promise: Promise ->
      gemmaManagement(promise, "remove:$modelId") {
        if (gemmaDownloadStops.containsKey(modelId)) throw GemmaPackException("MODEL_DOWNLOAD_BUSY")
        gemmaLifecycle.removeModel(modelId)
      }
    }

    AsyncFunction("runNeedle") { transcript: String, toolsJson: String ->
      ensureNeedle(toolsJson)
      NeedleJni.complete(transcript, 128)
    }

    AsyncFunction("runOptional") { modelId: String, filename: String, prompt: String, _imageUri: String?, _audioUri: String? ->
      val file = optionalFile(filename)
      if (!file.exists()) throw IllegalStateException("Download this on-device model in Advanced Settings first.")
      runPack(modelId, file, prompt)
    }

    AsyncFunction("listOptional") { packsJson: String ->
      val ram = advertisedRamBytes()
      parsePacks(packsJson).map { pack ->
        val file = optionalFile(pack.filename)
        val tmp = File(optionalDir(), "${file.name}.part")
        mapOf(
          "id" to pack.id,
          "installed" to file.exists(),
          "eligible" to (ram <= 0L || pack.minRamBytes <= 0L || ram >= pack.minRamBytes),
          "bytesOnDisk" to if (file.exists()) file.length() else 0L,
          "partialBytes" to if (tmp.exists()) tmp.length() else 0L,
        )
      }
    }

    AsyncFunction("downloadOptional") { modelId: String, url: String, filename: String, sha256: String?, expectedBytes: Double?, minRamBytes: Double? ->
      if (url.isBlank()) throw IllegalStateException("This model pack has no download URL configured.")
      val dest = optionalFile(filename)
      val needRam = (minRamBytes ?: 0.0).toLong()
      val ram = advertisedRamBytes()
      if (needRam > 0 && ram > 0 && ram < needRam) {
        throw IllegalStateException("This phone does not have enough RAM for $modelId.")
      }

      checkWifiOrUnmetered()

      // The .part file and the finished file exist together for a moment, and the
      // runtime's weight cache needs roughly another copy again, so budget twice
      // the download plus headroom rather than just its size.
      val expected = (expectedBytes ?: 0.0).toLong()
      if (expected > 0) {
        val usableSpace = optionalDir().usableSpace
        val requiredSpace = (expected * 2) + (200L * 1024L * 1024L)
        if (usableSpace < requiredSpace) {
          val freeMb = usableSpace / (1024L * 1024L)
          val reqMb = requiredSpace / (1024L * 1024L)
          val shortMb = (requiredSpace - usableSpace) / (1024L * 1024L)
          throw IllegalStateException(
            "Not enough storage to download $modelId. Requires at least ${reqMb}MB free (${shortMb}MB shortfall, phone has ${freeMb}MB usable)."
          )
        }
      }

      withWakeLock("download-$modelId") { downloadTo(url, dest, modelId, sha256) }
      true
    }

    AsyncFunction("cancelDownload") { modelId: String ->
      cancelDownload(modelId)
      true
    }

    AsyncFunction("deleteOptional") { modelId: String, filename: String ->
      cancelDownload(modelId)
      synchronized(engineLock) { if (loadedPackId == modelId) closeLoadedPack() }
      val targetFile = optionalFile(filename)
      val tmpFile = File(optionalDir(), "${targetFile.name}.part")
      if (targetFile.exists()) targetFile.delete()
      if (tmpFile.exists()) tmpFile.delete()
      true
    }

    OnDestroy {
      synchronized(engineLock) { closeLoadedPack() }
      activeDownloads.values.forEach { it.cancel() }
      activeDownloads.clear()

      // Gemma teardown, in this order for a reason: refuse new work, ask the
      // running turn to stop, then queue the close BEHIND whatever is still on
      // the inference thread. Closing the engine from here would free JNI
      // objects a live sendMessage is still using.
      gemmaShutdown.set(true)
      gemmaDownloadStops.values.forEach { it.set(true) }
      gemmaAdmitted.get()?.let {
        gemmaCancelled.set(it)
        runCatching { gemmaHostRef?.requestCancel(it) }
      }
      runCatching {
        gemmaExecutor.execute {
          try {
            gemmaHostRef?.close()
            gemmaAttachmentsRef?.releaseAll()
            gemmaHostRef = null
            gemmaStoreRef = null
            gemmaAttachmentsRef = null
          } catch (_: Throwable) {
            // Keep uncertain native ownership and media reachable; never claim teardown.
            gemmaPoisoned.set(true)
          }
        }
      }
      gemmaExecutor.shutdown()

      if (engineLoaded) {
        try { NeedleJni.reset() } catch (_: Throwable) {}
      }
      engineLoaded = false
    }
  }

  /**
   * Runs a downloaded pack through MediaPipe's LLM inference.
   *
   * Only one engine is held at a time: these models are 1.5-3 GB and a second
   * live engine is the quickest way to be killed for memory. Switching packs
   * closes the previous one first.
   *
   * Loading can fail for memory even when the RAM check passed, because
   * eligibility is a static estimate and the engine expands weights while it
   * builds. That surfaces as OutOfMemoryError rather than an exception, so it is
   * caught explicitly and reported as something the user can act on.
   */
  private fun runPack(modelId: String, file: File, prompt: String): String {
    synchronized(engineLock) {
      if (loadedPackId != modelId) {
        closeLoadedPack()
        val options = LlmInferenceOptions.builder()
          .setModelPath(file.absolutePath)
          .setMaxTokens(MAX_PACK_TOKENS)
          .build()
        loadedPack = try {
          LlmInference.createFromOptions(context, options)
        } catch (error: OutOfMemoryError) {
          throw IllegalStateException(
            "This phone ran out of memory loading $modelId. Close other apps and try again, or use a smaller pack.",
            error,
          )
        } catch (error: Throwable) {
          throw IllegalStateException(
            "Could not load $modelId. The pack may be incomplete -- delete and download it again. (${error.message})",
            error,
          )
        }
        loadedPackId = modelId
      }
      val engine = loadedPack ?: throw IllegalStateException("The on-device model pack is not loaded.")
      return try {
        engine.generateResponse(prompt).orEmpty().trim()
      } catch (error: OutOfMemoryError) {
        closeLoadedPack()
        throw IllegalStateException("This phone ran out of memory answering with $modelId. Try a shorter question or a smaller pack.", error)
      }
    }
  }

  private fun closeLoadedPack() {
    try { loadedPack?.close() } catch (_: Throwable) {}
    loadedPack = null
    loadedPackId = null
  }

  private fun needleReady(): Boolean {
    return engineLoaded || bundledNeedleBytes() != null
  }

  private fun missingEngineReason(): String {
    return if (bundledNeedleBytes() == null) {
      "Needle weights are missing. Run frontend/scripts/on-device-ai/fetch-native.mjs then rebuild the Android APK."
    } else {
      "Needle is in the project, but this JS bundle is not a native APK. Run npx expo run:android or EAS."
    }
  }

  private fun ensureNeedle(toolsJson: String) {
    if (!engineLoaded) {
      val cact = bundledNeedleBytes() ?: throw IllegalStateException(missingEngineReason())
      try {
        if (NeedleJni.load(cact) != 0) throw IllegalStateException("Needle could not load needle2.cact.")
      } catch (error: UnsatisfiedLinkError) {
        throw IllegalStateException("Needle native library is missing. Rebuild the Android APK after fetch-native.mjs.", error)
      }
      engineLoaded = true
      lastToolsJson = ""
    }
    if (toolsJson != lastToolsJson) {
      if (NeedleJni.init("You convert shop bookkeeping speech into one Ledgr tool call. Never invent IDs. Return JSON only.", toolsJson) != 0) {
        throw IllegalStateException("Needle could not load the Ledgr tool list.")
      }
      lastToolsJson = toolsJson
    }
  }

  private fun bundledNeedleBytes(): ByteArray? {
    return try {
      context.assets.open("needle2.cact").use { it.readBytes() }.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
      null
    }
  }

  private fun modelsDir(): File = File(context.filesDir, "on-device-models").apply { mkdirs() }
  private fun optionalDir(): File = File(modelsDir(), "optional").apply { mkdirs() }
  /**
   * Resolves a pack file inside the models directory.
   *
   * The name now arrives from a remote manifest rather than a compiled-in list,
   * so it is reduced to a bare filename first: anything with a path separator or
   * a parent reference could otherwise be used to write outside filesDir.
   */
  private fun optionalFile(filename: String): File {
    return File(optionalDir(), safePackFilename(filename))
  }

  private fun safePackFilename(filename: String): String {
    val bare = filename.substringAfterLast('/').substringAfterLast('\\').trim()
    val cleaned = bare.replace(Regex("[^A-Za-z0-9._-]"), "_")
    if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") {
      throw IllegalArgumentException("That model pack has an unusable filename.")
    }
    return cleaned
  }

  private data class PackRef(val id: String, val filename: String, val minRamBytes: Long)

  /** Packs are described by JS so a manifest can add one without a new APK. */
  private fun parsePacks(json: String): List<PackRef> {
    val array = try { JSONArray(json) } catch (_: Exception) { return emptyList() }
    val packs = mutableListOf<PackRef>()
    for (i in 0 until array.length()) {
      val row = array.optJSONObject(i) ?: continue
      val id = row.optString("id").trim()
      val filename = row.optString("filename").trim()
      if (id.isEmpty() || filename.isEmpty()) continue
      packs.add(PackRef(id, filename, row.optLong("minRamBytes", 0L)))
    }
    return packs
  }

  private fun cancelDownload(modelId: String) {
    activeDownloads.remove(modelId)?.cancel()
  }

  private fun checkWifiOrUnmetered() {
    val connManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val network = connManager.activeNetwork
      val caps = connManager.getNetworkCapabilities(network)
      val isUnmetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
      val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true ||
                   caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true
      if (!isWifi && !isUnmetered) {
        throw IllegalStateException("Wi-Fi connection required for model pack downloads. Switch to Wi-Fi to download.")
      }
    } else {
      @Suppress("DEPRECATION")
      val activeInfo = connManager.activeNetworkInfo
      @Suppress("DEPRECATION")
      val isWifi = activeInfo?.type == ConnectivityManager.TYPE_WIFI ||
                   activeInfo?.type == ConnectivityManager.TYPE_ETHERNET
      if (activeInfo != null && !isWifi) {
        throw IllegalStateException("Wi-Fi connection required for model pack downloads. Switch to Wi-Fi to download.")
      }
    }
  }

  private fun <T> withWakeLock(tag: String, block: () -> T): T {
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LedgrAI:$tag")?.apply {
      setReferenceCounted(false)
      acquire(60 * 60 * 1000L) // 60 minutes max
    }
    return try {
      block()
    } finally {
      try {
        if (wakeLock?.isHeld == true) {
          wakeLock.release()
        }
      } catch (_: Throwable) {}
    }
  }

  private fun totalRamBytes(): Long {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val info = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(info)
    return if (Build.VERSION.SDK_INT >= 16) info.totalMem else 0L
  }

  /**
   * Android reports less memory than the phone is sold with, because the kernel
   * and firmware reserve some before userspace ever sees it: a 12 GB phone
   * commonly reports around 11.2 GB. Comparing that raw figure against a 12 GB
   * requirement hid packs from phones that meet the spec, so round up to the
   * nearest size phones are actually sold in before deciding eligibility.
   */
  private fun advertisedRamBytes(): Long {
    val reported = totalRamBytes()
    if (reported <= 0L) return 0L
    val gib = 1024L * 1024L * 1024L
    for (tier in longArrayOf(2, 3, 4, 6, 8, 12, 16, 24, 32)) {
      if (reported <= tier * gib) return tier * gib
    }
    return reported
  }

  private fun downloadTo(url: String, dest: File, id: String, expectedSha256: String?) {
    dest.parentFile?.mkdirs()
    val tmp = File(dest.parentFile, dest.name + ".part")
    val downloadTask = ActiveDownload(id, tmp)
    activeDownloads[id] = downloadTask

    try {
      val existingBytes = if (tmp.exists()) tmp.length() else 0L
      val connection = URL(url).openConnection() as HttpURLConnection
      downloadTask.connection = connection
      connection.instanceFollowRedirects = true
      connection.connectTimeout = 15000
      connection.readTimeout = 30000

      var isResuming = false
      if (existingBytes > 0L) {
        connection.setRequestProperty("Range", "bytes=$existingBytes-")
        isResuming = true
      }

      connection.connect()
      if (downloadTask.isCancelled) {
        if (tmp.exists()) tmp.delete()
        throw IllegalStateException("Download of $id was cancelled.")
      }

      val responseCode = connection.responseCode
      val appendMode: Boolean
      var received: Long
      val total: Long

      if (isResuming && responseCode == 206) {
        // 206 Partial Content: HTTP Range was honored
        appendMode = true
        received = existingBytes
        val cl = connection.contentLengthLong
        total = if (cl > 0L) existingBytes + cl else 0L
      } else if (responseCode in 200..299) {
        // 200 OK: Range was ignored or not requested, restart from offset 0
        appendMode = false
        received = 0L
        total = connection.contentLengthLong.let { if (it > 0) it else 0L }
        if (tmp.exists()) tmp.delete()
      } else {
        throw IllegalStateException("Download failed ($responseCode). Check the connection and try again.")
      }

      // Initial progress notification
      sendEvent("downloadProgress", mapOf("id" to id, "received" to received, "total" to total))
      // One event per 64KB read is ~32k bridge round-trips for a 2GB pack, which
      // is enough JS work on a low-end phone to stall the very UI showing the
      // percentage. Twice a second is finer than a progress bar can display.
      var lastProgressAt = System.currentTimeMillis()
      var lastProgressBytes = received

      connection.inputStream.use { input ->
        FileOutputStream(tmp, appendMode).use { output ->
          val buffer = ByteArray(1024 * 64)
          while (true) {
            if (downloadTask.isCancelled) {
              if (tmp.exists()) tmp.delete()
              throw IllegalStateException("Download of $id was cancelled.")
            }
            val read = input.read(buffer)
            if (read <= 0) break
            output.write(buffer, 0, read)
            received += read
            val now = System.currentTimeMillis()
            if (now - lastProgressAt >= 500L) {
              lastProgressAt = now
              lastProgressBytes = received
              sendEvent("downloadProgress", mapOf("id" to id, "received" to received, "total" to total))
            }
          }
        }
      }

      if (received != lastProgressBytes) {
        sendEvent("downloadProgress", mapOf("id" to id, "received" to received, "total" to total))
      }

      if (downloadTask.isCancelled) {
        if (tmp.exists()) tmp.delete()
        throw IllegalStateException("Download of $id was cancelled.")
      }

      // Checksum verification before renaming:
      if (!expectedSha256.isNullOrBlank()) {
        val digest = MessageDigest.getInstance("SHA-256")
        tmp.inputStream().use { input ->
          val buffer = ByteArray(1024 * 64)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            digest.update(buffer, 0, read)
          }
        }
        val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
        if (!actualHash.equals(expectedSha256.trim(), ignoreCase = true)) {
          if (tmp.exists()) tmp.delete()
          throw IllegalStateException(
            "Checksum verification failed for $id. Expected $expectedSha256, got $actualHash. Corrupt download deleted."
          )
        }
      }

      // Atomic rename: .part -> final file
      if (dest.exists()) dest.delete()
      if (!tmp.renameTo(dest)) {
        try {
          tmp.copyTo(dest, overwrite = true)
          tmp.delete()
        } catch (e: Exception) {
          throw IllegalStateException("Could not save the downloaded model: ${e.message}")
        }
      }
    } finally {
      activeDownloads.remove(id)
    }
  }

  companion object {
    private const val MAX_PACK_TOKENS = 512
  }
}
