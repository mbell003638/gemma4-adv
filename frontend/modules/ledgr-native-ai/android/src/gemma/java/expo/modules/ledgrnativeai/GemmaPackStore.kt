package expo.modules.ledgrnativeai

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap

/**
 * Verified store for the optional Gemma 4 model packs.
 *
 * Deliberately free of `android.*` and Expo imports. The weights are the one
 * artefact in this app where a wrong byte is indistinguishable from a working
 * one until inference quietly produces nonsense, so the rules that protect them
 * are worth being able to compile and unit-test on a plain JVM, away from a
 * device. The module supplies the root directory and the approved specs; this
 * class supplies nothing but distrust.
 *
 * What it does differently from the old Qwen/Phi downloader, on purpose:
 *
 *  - The checksum is required, not optional, and it is checked before the file
 *    is ever given a name that means "ready".
 *  - Installation is a same-directory `renameTo` with no copy fallback. The old
 *    fallback could leave a half-written file under the final name if the
 *    process died mid-copy, and that file would then load as a model.
 *  - Pause keeps the `.part` file. The old code deleted partial data on cancel,
 *    which turned a tapped-by-accident Stop into another 2.5 GB of mobile data.
 *  - Readiness is a state machine, not `File.exists()`.
 *  - Redirects are followed by hand so every hop is re-checked against the host
 *    allowlist; `instanceFollowRedirects` would happily walk off it.
 */

/** One approved pack, parsed from the bundled catalog asset -- never from JS. */
data class GemmaPackSpec(
  val id: String,
  val filename: String,
  val url: String,
  val bytes: Long,
  val sha256: String,
  val revision: String,
)

/** Lifecycle of a pack on disk. `File.exists()` cannot express most of these. */
enum class GemmaPackState {
  NOT_INSTALLED,
  DOWNLOADING,
  PAUSED,
  VERIFYING,
  READY,
  UNSUPPORTED,
  ERROR,
}

/**
 * A failure with a stable machine code and no user data in it.
 *
 * The code is the whole message on purpose: this exception travels towards a
 * promise rejection, and a signed CDN URL or an internal path in a user-facing
 * string is a leak that no one notices until it is in a support screenshot.
 */
class GemmaPackException(
  val code: String,
  val retryAfterSeconds: Long? = null,
  cause: Throwable? = null,
) : Exception(code, cause)

class GemmaPackStore(
  private val root: File,
  approved: List<GemmaPackSpec>,
  private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
  private val packs = approved.associateBy { it.id }

  /**
   * Verification is expensive (a full SHA-256 over gigabytes), so a success is
   * remembered against the file's identity -- length plus last-modified. Any
   * replacement of the file changes at least one of those, which invalidates
   * the entry. The cache is in-memory only, so a fresh process revalidates a
   * ready file before its first load, which is exactly what stage 2 asks for.
   */
  private data class VerifiedStamp(val length: Long, val modifiedAt: Long)

  private val verified = ConcurrentHashMap<String, VerifiedStamp>()
  private val states = ConcurrentHashMap<String, GemmaPackState>()
  private val unsupported = ConcurrentHashMap<String, String>()

  init {
    require(packs.size == approved.size) { "DUPLICATE_PACK_ID" }
    require(approved.isNotEmpty()) { "EMPTY_PACK_CATALOG" }
    require(root.isDirectory || root.mkdirs()) { "PACK_ROOT_UNAVAILABLE" }
    approved.forEach {
      require(it.id.matches(ID_PATTERN)) { "INVALID_PACK_ID" }
      require(it.bytes > 0 && it.bytes < MAX_PACK_BYTES) { "INVALID_PACK_SIZE" }
      require(it.sha256.matches(SHA256_PATTERN)) { "INVALID_PACK_HASH" }
      require(it.revision.matches(REVISION_PATTERN)) { "INVALID_PACK_REVISION" }
      require(it.filename.matches(FILENAME_PATTERN)) { "INVALID_PACK_FILENAME" }
      require(it.url.startsWith("https://huggingface.co/")) { "INVALID_PACK_URL" }
      // The revision is pinned in the URL as well as the manifest, so a mirror
      // that swaps in a different commit cannot claim the same fingerprint.
      require(it.url.contains("/resolve/${it.revision}/")) { "URL_REVISION_MISMATCH" }
    }
  }

  fun approvedIds(): List<String> = packs.keys.sorted()

  fun specOrNull(id: String): GemmaPackSpec? = packs[id]

  private fun spec(id: String): GemmaPackSpec =
    packs[id] ?: throw GemmaPackException("UNKNOWN_MODEL")

  /**
   * Resolves a pack file, refusing anything that escapes the pack root.
   *
   * The filename is already constrained by the init check, so this is defence
   * in depth against a future caller that constructs a spec some other way.
   */
  private fun file(p: GemmaPackSpec): File = File(root, p.filename).also {
    if (it.canonicalFile.parentFile != root.canonicalFile) {
      throw GemmaPackException("PACK_PATH_ESCAPE")
    }
  }

  private fun partFile(p: GemmaPackSpec): File = File(root, p.filename + PART_SUFFIX)

  private fun checkStop(stopped: () -> Boolean) {
    if (stopped()) throw CancellationException("DOWNLOAD_PAUSED")
  }

  /**
   * The device profile decided this pack cannot run here (backend, ABI, memory).
   *
   * Kept as a store-level mark rather than inferred from a file, because an
   * initialization failure is not proof of a corrupt download and the two must
   * not be shown to the user as the same problem.
   */
  fun markUnsupported(id: String, reason: String) {
    spec(id)
    unsupported[id] = reason
  }

  fun clearUnsupported(id: String) {
    unsupported.remove(id)
  }

  fun unsupportedReason(id: String): String? = unsupported[id]

  /**
   * The current state of one pack.
   *
   * Reports READY only for a file of the exact expected length whose hash has
   * been confirmed in this process. A ready-looking file that has never been
   * verified here reports VERIFYING, which is the truth: the app still has to
   * read it end to end before it may be loaded.
   */
  fun state(id: String): GemmaPackState {
    val p = packs[id] ?: return GemmaPackState.NOT_INSTALLED
    unsupported[id]?.let { return GemmaPackState.UNSUPPORTED }
    states[id]?.let { if (it == GemmaPackState.DOWNLOADING || it == GemmaPackState.ERROR) return it }
    val dest = file(p)
    if (dest.isFile) {
      if (dest.length() != p.bytes) return GemmaPackState.ERROR
      val stamp = verified[id]
      return if (stamp != null && stamp == stampOf(dest)) GemmaPackState.READY else GemmaPackState.VERIFYING
    }
    val part = partFile(p)
    if (part.isFile && part.length() > 0) return GemmaPackState.PAUSED
    return GemmaPackState.NOT_INSTALLED
  }

  fun partialBytes(id: String): Long {
    val p = packs[id] ?: return 0L
    val part = partFile(p)
    return if (part.isFile) part.length() else 0L
  }

  fun installedBytes(id: String): Long {
    val p = packs[id] ?: return 0L
    val dest = file(p)
    return if (dest.isFile) dest.length() else 0L
  }

  private fun stampOf(f: File) = VerifiedStamp(f.length(), f.lastModified())

  @Synchronized
  fun recordVerificationFailure(id: String) {
    spec(id)
    verified.remove(id)
    states[id] = GemmaPackState.ERROR
  }

  private fun verify(f: File, p: GemmaPackSpec, stopped: () -> Boolean = { false }) {
    if (!f.isFile || f.length() != p.bytes) throw GemmaPackException("MODEL_SIZE_MISMATCH")
    val digest = MessageDigest.getInstance("SHA-256")
    f.inputStream().buffered().use { input ->
      val buffer = ByteArray(BUFFER_BYTES)
      while (true) {
        checkStop(stopped)
        val n = input.read(buffer)
        if (n < 0) break
        digest.update(buffer, 0, n)
      }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    if (actual != p.sha256) throw GemmaPackException("MODEL_HASH_MISMATCH")
  }

  /**
   * Returns the pack file only once its contents are proven.
   *
   * Callers get a `File` from here or they get an exception; there is no path
   * on which an unverified blob reaches the engine. Loading is serialized by
   * the caller against install/delete for the same fingerprint.
   */
  @Synchronized
  fun verifiedFile(id: String, stopped: () -> Boolean = { false }): File {
    val p = spec(id)
    val dest = file(p)
    if (!dest.isFile) throw GemmaPackException("MODEL_NOT_INSTALLED")
    val stamp = stampOf(dest)
    if (verified[id] == stamp) return dest
    states[id] = GemmaPackState.VERIFYING
    try {
      verify(dest, p, stopped)
      if (stampOf(dest) != stamp) throw GemmaPackException("MODEL_CHANGED_DURING_VERIFICATION")
    } catch (e: Throwable) {
      verified.remove(id)
      states[id] = GemmaPackState.ERROR
      throw e
    }
    // Cache precisely the identity that was hashed, never a later replacement.
    verified[id] = stamp
    states.remove(id)
    return dest
  }

  private fun allowed(url: URL): Boolean {
    val host = url.host.lowercase()
    return url.protocol == "https" && url.userInfo == null &&
      (url.port == -1 || url.port == 443) &&
      (host == "huggingface.co" || host == "hf.co" || host.endsWith(".hf.co"))
  }

  /**
   * Opens a connection, following redirects by hand.
   *
   * Every hop is re-checked against the allowlist before it is opened, which is
   * the reason not to let `HttpURLConnection` follow them: it would follow a
   * 302 to an arbitrary host, and it also drops the `Range` header on some
   * platform versions, which silently turns a resume into a restart.
   *
   * Note for the device gate: Hugging Face serves weights via an LFS CDN
   * redirect. If that target is not `huggingface.co`, `hf.co` or a `*.hf.co`
   * host, this fails closed with MODEL_HOST_NOT_ALLOWED rather than widening
   * the allowlist. Confirm the real redirect chain on device and get the host
   * approved explicitly; do not relax this from a stack trace.
   */
  private fun connect(raw: String, offset: Long): HttpURLConnection {
    // URI first: the URL(String) constructor is deprecated on modern JDKs, and
    // URI parsing is the stricter of the two about what it will accept at all.
    var url = URI.create(raw).toURL()
    repeat(MAX_REDIRECTS) {
      if (!allowed(url)) throw GemmaPackException("MODEL_HOST_NOT_ALLOWED")
      val c = openConnection(url)
      c.instanceFollowRedirects = false
      c.connectTimeout = CONNECT_TIMEOUT_MS
      c.readTimeout = READ_TIMEOUT_MS
      // Identity encoding keeps Content-Range/Content-Length meaningful; a
      // gzipped body would make the resume offset arithmetic a lie.
      c.setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) c.setRequestProperty("Range", "bytes=$offset-")
      try {
        val status = c.responseCode
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
          val location = c.getHeaderField("Location") ?: throw GemmaPackException("BAD_REDIRECT")
          // RFC 3986 resolution, so a relative Location header still lands on a
          // host the allowlist check above will see.
          url = url.toURI().resolve(location).toURL()
          c.disconnect()
        } else {
          return c
        }
      } catch (e: GemmaPackException) {
        c.disconnect(); throw e
      } catch (e: IOException) {
        c.disconnect(); throw GemmaPackException("MODEL_NETWORK_ERROR", cause = e)
      } catch (e: Throwable) {
        c.disconnect(); throw e
      }
    }
    throw GemmaPackException("TOO_MANY_REDIRECTS")
  }

  private fun retryAfterSeconds(c: HttpURLConnection): Long? =
    c.getHeaderField("Retry-After")?.trim()?.toLongOrNull()?.coerceIn(0L, 3600L)

  /**
   * Downloads and installs one pack.
   *
   * Runs on a worker with one active download globally in the first release.
   * `stopped` is polled between reads: a pause therefore takes effect within
   * one read or one read-timeout, not instantly, and the caller should also
   * disconnect the socket if it wants to stop sooner. Saying "instant cancel"
   * in the UI would be a claim this cannot keep.
   */
  @Synchronized
  fun download(
    id: String,
    stopped: () -> Boolean,
    progress: (received: Long, total: Long, phase: String) -> Unit,
  ): File {
    val p = spec(id)
    val dest = file(p)
    // An already-installed pack is proven again rather than trusted, because
    // "the file is there" is precisely the assumption this class exists to drop.
    if (dest.exists()) {
      states[id] = GemmaPackState.VERIFYING
      progress(p.bytes, p.bytes, PHASE_VERIFYING)
      // Use the same pre/post-stamp and failure-state rules as restart verification.
      verified.remove(id)
      verifiedFile(id, stopped)
      progress(p.bytes, p.bytes, PHASE_READY)
      return dest
    }
    val part = partFile(p)
    var offset = if (part.exists()) part.length() else 0L
    // A partial larger than the finished file cannot be a prefix of it. Refuse
    // rather than guess which bytes are junk.
    if (offset > p.bytes) throw GemmaPackException("PART_TOO_LARGE_REMOVE_AND_RETRY")
    // Conservative initial reserve; the runtime's own cache needs are measured
    // separately and are not covered by this number.
    val required = (p.bytes - offset) + STORAGE_HEADROOM_BYTES
    if (root.usableSpace < required) throw GemmaPackException("INSUFFICIENT_STORAGE")
    checkStop(stopped)

    states[id] = GemmaPackState.DOWNLOADING
    try {
      var attempt = 0
      while (offset < p.bytes) {
        checkStop(stopped)
        try {
          offset = transfer(p, part, offset, stopped, progress)
        } catch (e: CancellationException) {
          throw e
        } catch (e: GemmaPackException) {
          // 401/403/404/416 are decisions, not weather. Retrying them just
          // burns battery and, for 401/403, invites someone to add a token.
          if (!RETRYABLE_CODES.contains(e.code) || attempt >= MAX_TRANSFER_ATTEMPTS - 1) throw e
          attempt += 1
          val backoffMs = e.retryAfterSeconds?.times(1000L)
            ?: (BASE_BACKOFF_MS shl (attempt - 1)).coerceAtMost(MAX_BACKOFF_MS)
          sleepInterruptibly(backoffMs, stopped)
          offset = if (part.exists()) part.length() else 0L
        }
      }

      states[id] = GemmaPackState.VERIFYING
      progress(p.bytes, p.bytes, PHASE_VERIFYING)
      // Verified while still named `.part`. On a hash failure the partial file
      // survives for diagnostics and manual removal, and no name that implies
      // "ready" is ever created -- there is nothing for a later boot to load.
      verify(part, p, stopped)
      checkStop(stopped)
      // Same directory, so this is a real atomic rename on the app's own
      // filesystem. There is no copy fallback: a copy that dies halfway leaves
      // a truncated file under the final name, which is the failure mode this
      // whole class is built to make impossible.
      if (dest.exists() || !part.renameTo(dest)) throw GemmaPackException("ATOMIC_INSTALL_FAILED")
      verified[id] = stampOf(dest)
      states.remove(id)
      progress(p.bytes, p.bytes, PHASE_READY)
      return dest
    } catch (e: CancellationException) {
      states[id] = GemmaPackState.PAUSED
      throw e
    } catch (e: Throwable) {
      states[id] = GemmaPackState.ERROR
      throw e
    }
  }

  /**
   * One HTTP attempt. Returns the new offset so a retry can resume from it.
   *
   * Split out from `download` so the retry loop has exactly one place where a
   * connection is opened and exactly one place where bytes reach the disk.
   */
  private fun transfer(
    p: GemmaPackSpec,
    part: File,
    requestedOffset: Long,
    stopped: () -> Boolean,
    progress: (received: Long, total: Long, phase: String) -> Unit,
  ): Long {
    var offset = requestedOffset
    val c = connect(p.url, offset)
    try {
      when (val status = c.responseCode) {
        206 -> {
          // A 206 is only useful if the server means the same range we do, so
          // parse it exactly rather than trusting Content-Length arithmetic.
          val m = CONTENT_RANGE_PATTERN.matchEntire(c.getHeaderField("Content-Range")?.trim().orEmpty())
            ?: throw GemmaPackException("INVALID_CONTENT_RANGE")
          val start = m.groupValues[1].toLong()
          val end = m.groupValues[2].toLong()
          val total = m.groupValues[3].toLong()
          if (start != offset || end < start || end >= total || total != p.bytes) {
            throw GemmaPackException("INVALID_CONTENT_RANGE")
          }
          // A short range would need a second request to finish the file; the
          // loop can do that, but only if we stop and re-ask rather than treat
          // a partial body as the whole remainder.
          if (end != p.bytes - 1) throw GemmaPackException("PARTIAL_RANGE_RETRY_REQUIRED")
        }
        200 -> {
          // The server ignored Range. Appending a whole file to a partial file
          // produces a large, plausible, corrupt blob -- restart at zero.
          offset = 0
        }
        401, 403 -> throw GemmaPackException("MODEL_ACCESS_UNAVAILABLE")
        404 -> throw GemmaPackException("MODEL_NOT_FOUND")
        416 -> throw GemmaPackException("RANGE_REJECTED_REMOVE_PARTIAL_AND_RETRY")
        429 -> throw GemmaPackException("MODEL_HOST_RATE_LIMITED", retryAfterSeconds(c))
        in 500..599 -> throw GemmaPackException("MODEL_HOST_UNAVAILABLE", retryAfterSeconds(c))
        else -> throw GemmaPackException("MODEL_HTTP_$status")
      }

      var received = offset
      var lastEvent = 0L
      c.inputStream.use { input ->
        FileOutputStream(part, offset > 0).use { output ->
          val buffer = ByteArray(BUFFER_BYTES)
          while (true) {
            checkStop(stopped)
            val n = try {
              input.read(buffer)
            } catch (e: IOException) {
              // Flush what we have so a resume starts from real bytes on disk.
              output.flush(); output.fd.sync()
              throw GemmaPackException("MODEL_NETWORK_ERROR", cause = e)
            }
            if (n < 0) break
            if (received + n > p.bytes) throw GemmaPackException("MODEL_TOO_LARGE")
            output.write(buffer, 0, n)
            received += n
            val now = System.currentTimeMillis()
            if (now - lastEvent >= PROGRESS_INTERVAL_MS) {
              progress(received, p.bytes, PHASE_DOWNLOADING)
              lastEvent = now
            }
          }
          output.fd.sync()
        }
      }
      if (received != p.bytes) throw GemmaPackException("INCOMPLETE_DOWNLOAD_RETRY")
      progress(received, p.bytes, PHASE_DOWNLOADING)
      return received
    } finally {
      c.disconnect()
    }
  }

  private fun sleepInterruptibly(totalMs: Long, stopped: () -> Boolean) {
    var slept = 0L
    while (slept < totalMs) {
      checkStop(stopped)
      val slice = minOf(250L, totalMs - slept)
      try {
        Thread.sleep(slice)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        throw CancellationException("DOWNLOAD_PAUSED")
      }
      slept += slice
    }
  }

  /**
   * Deletes exactly this pack's two files and nothing else.
   *
   * The caller must have cancelled generation and released the engine first;
   * this class cannot see the native handle and will not pretend to. Removal
   * is not offered as a repair for a failed load until integrity is checked,
   * because deleting the last verified copy to fix an unsupported backend is
   * another 2.5 GB for no reason.
   */
  @Synchronized
  fun remove(id: String): Boolean {
    val p = spec(id)
    val dest = file(p)
    val part = partFile(p)
    var removed = false
    for (target in listOf(dest, part)) {
      if (target.exists()) {
        if (!target.isFile || !target.delete()) throw GemmaPackException("MODEL_REMOVE_FAILED")
        removed = true
      }
    }
    verified.remove(id)
    states.remove(id)
    unsupported.remove(id)
    return removed
  }

  /** Pause keeps the partial file; only the final artefact is discarded. */
  @Synchronized
  fun discardPartial(id: String): Boolean {
    val part = partFile(spec(id))
    verified.remove(id)
    states.remove(id)
    if (!part.exists()) return false
    if (!part.isFile || !part.delete()) throw GemmaPackException("MODEL_REMOVE_FAILED")
    return true
  }

  companion object {
    private const val PART_SUFFIX = ".part"
    private const val BUFFER_BYTES = 128 * 1024
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val PROGRESS_INTERVAL_MS = 500L
    private const val MAX_REDIRECTS = 6
    private const val MAX_TRANSFER_ATTEMPTS = 3
    private const val BASE_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 30_000L
    private const val MAX_PACK_BYTES = 16L * 1024 * 1024 * 1024
    private const val STORAGE_HEADROOM_BYTES = 512L * 1024 * 1024

    const val PHASE_DOWNLOADING = "downloading"
    const val PHASE_VERIFYING = "verifying"
    const val PHASE_READY = "ready"

    private val ID_PATTERN = Regex("[a-z0-9][a-z0-9-]{0,39}")
    private val SHA256_PATTERN = Regex("[0-9a-f]{64}")
    private val REVISION_PATTERN = Regex("[0-9a-f]{40}")
    private val FILENAME_PATTERN = Regex("[A-Za-z0-9_-]+\\.litertlm")
    private val CONTENT_RANGE_PATTERN = Regex("bytes (\\d+)-(\\d+)/(\\d+)")

    private val RETRYABLE_CODES = setOf(
      "MODEL_NETWORK_ERROR",
      "MODEL_HOST_UNAVAILABLE",
      "MODEL_HOST_RATE_LIMITED",
      "INCOMPLETE_DOWNLOAD_RETRY",
      "PARTIAL_RANGE_RETRY_REQUIRED",
    )

    /** Maps a store state onto the string the JS layer and UI understand. */
    fun stateName(state: GemmaPackState): String = when (state) {
      GemmaPackState.NOT_INSTALLED -> "not-installed"
      GemmaPackState.DOWNLOADING -> "downloading"
      GemmaPackState.PAUSED -> "paused"
      GemmaPackState.VERIFYING -> "verifying"
      GemmaPackState.READY -> "ready"
      GemmaPackState.UNSUPPORTED -> "unsupported"
      GemmaPackState.ERROR -> "error"
    }
  }
}
