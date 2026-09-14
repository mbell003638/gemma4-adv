package ledgr.gemma.spike

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException

/**
 * P2 verified model store.
 *
 * Pure JVM on purpose: no `android.*` and no `expo.*`, so the download, resume,
 * verify and install rules can be executed against a real HTTP server in a
 * desktop test instead of only being read. The Android wrapper -- no-backup
 * storage, a foreground/managed worker, progress reconnection after process
 * death -- goes around this core, not inside it.
 *
 * The current shipping downloader in LedgrOnDeviceLlmModule treats a checksum
 * as optional, accepts any 2xx, deletes the partial file when cancelled and
 * falls back from rename to copy. Each of those turns a broken transfer into a
 * file that looks installed. None of them survive here.
 */

data class GemmaPackSpec(
  val id: String,
  val filename: String,
  val url: String,
  val bytes: Long,
  val sha256: String,
  val revision: String,
)

/** What the store will say about a pack. `exists()` is deliberately not one. */
enum class PackState { NOT_INSTALLED, PARTIAL, READY, CORRUPT }

/**
 * Which hosts an artifact may be fetched from.
 *
 * Production pins this to Hugging Face. It is an interface only so the JVM
 * contract check can point the store at a loopback server; loosening it in a
 * shipped build would defeat the allowlist entirely, so the production value is
 * the default and the test seam has to be passed in explicitly.
 */
fun interface HostPolicy {
  fun allows(url: URL): Boolean
}

val HUGGING_FACE_ONLY = HostPolicy { url ->
  val host = url.host.lowercase()
  url.protocol == "https" && url.userInfo == null &&
    (url.port == -1 || url.port == 443) &&
    (host == "huggingface.co" || host == "hf.co" || host.endsWith(".hf.co"))
}

class GemmaPackStore(
  private val root: File,
  approved: List<GemmaPackSpec>,
  private val hostPolicy: HostPolicy = HUGGING_FACE_ONLY,
) {
  private val packs = approved.associateBy { it.id }

  init {
    require(packs.size == approved.size) { "DUPLICATE_PACK_ID" }
    require(approved.map { it.filename }.toSet().size == approved.size) { "DUPLICATE_PACK_FILENAME" }
    require(root.exists() || root.mkdirs()) { "MODEL_ROOT_UNAVAILABLE" }
    approved.forEach { spec ->
      require(spec.bytes > 0 && spec.bytes < 16L * 1024 * 1024 * 1024) { "MODEL_SIZE_UNREASONABLE" }
      require(spec.sha256.matches(Regex("[0-9a-f]{64}"))) { "MODEL_HASH_MALFORMED" }
      require(spec.revision.matches(Regex("[0-9a-f]{40}"))) { "MODEL_REVISION_MALFORMED" }
      // Anchored and separator-free: a filename becomes a path under `root`.
      require(spec.filename.matches(Regex("[A-Za-z0-9_-]+\\.litertlm"))) { "MODEL_FILENAME_UNSAFE" }
      require(hostPolicy.allows(URL(spec.url))) { "MODEL_HOST_NOT_ALLOWED" }
    }
  }

  private fun spec(id: String) = packs[id] ?: error("UNKNOWN_MODEL")

  /**
   * Resolves a pack's file and proves it stayed inside the model directory.
   *
   * The regex above already rejects separators, so this is the second of two
   * independent checks: a symlinked model directory or a future change to the
   * naming rule must not become a write outside app storage.
   */
  private fun file(spec: GemmaPackSpec) = File(root, spec.filename).also {
    require(it.canonicalFile.parentFile == root.canonicalFile) { "MODEL_PATH_ESCAPED" }
  }

  private fun partFile(spec: GemmaPackSpec) = File(root, spec.filename + ".part")

  private fun checkStop(stopped: () -> Boolean) {
    if (stopped()) throw CancellationException("DOWNLOAD_PAUSED")
  }

  private fun digestOf(target: File, stopped: () -> Boolean): String {
    val digest = MessageDigest.getInstance("SHA-256")
    target.inputStream().buffered().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        checkStop(stopped)
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun verify(target: File, spec: GemmaPackSpec, stopped: () -> Boolean = { false }) {
    // Size first: it is free, and it catches the truncated-transfer case before
    // spending a minute hashing two and a half gigabytes.
    check(target.isFile && target.length() == spec.bytes) { "MODEL_SIZE_MISMATCH" }
    check(digestOf(target, stopped) == spec.sha256) { "MODEL_HASH_MISMATCH" }
  }

  fun verifiedFile(id: String): File = file(spec(id)).also { verify(it, spec(id)) }

  /**
   * What the UI may claim about this pack.
   *
   * A final file that fails its hash is reported CORRUPT rather than READY;
   * nothing here promotes a file to usable on the strength of its name.
   */
  fun state(id: String): PackState {
    val spec = spec(id)
    val target = file(spec)
    if (target.isFile) {
      return if (runCatching { verify(target, spec) }.isSuccess) PackState.READY else PackState.CORRUPT
    }
    return if (partFile(spec).isFile) PackState.PARTIAL else PackState.NOT_INSTALLED
  }

  fun partialBytes(id: String): Long = partFile(spec(id)).let { if (it.isFile) it.length() else 0L }

  /**
   * Follows redirects by hand.
   *
   * `instanceFollowRedirects` would let the JDK walk to any host it is sent to,
   * which is the whole point of having an allowlist. Every hop is re-checked,
   * so a 302 from an allowed host to an arbitrary one is refused rather than
   * silently downloaded.
   */
  private fun connect(raw: String, offset: Long): HttpURLConnection {
    var url = URL(raw)
    repeat(6) {
      require(hostPolicy.allows(url)) { "MODEL_HOST_NOT_ALLOWED" }
      val connection = url.openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      // Identity encoding keeps Content-Range and byte offsets meaningful.
      connection.setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
      try {
        val status = connection.responseCode
        if (status in listOf(301, 302, 303, 307, 308)) {
          val location = connection.getHeaderField("Location") ?: error("BAD_REDIRECT")
          url = URL(url, location)
          connection.disconnect()
        } else {
          return connection
        }
      } catch (error: Exception) {
        connection.disconnect()
        throw error
      }
    }
    error("TOO_MANY_REDIRECTS")
  }

  /**
   * Downloads and installs one pack, resuming an interrupted transfer.
   *
   * Run on a worker; one active download at a time in the first release.
   * Pausing leaves the `.part` file in place -- discarding two gigabytes
   * because someone locked their phone is the behaviour this replaces.
   */
  @Synchronized
  fun download(
    id: String,
    stopped: () -> Boolean,
    progress: (received: Long, total: Long, phase: String) -> Unit,
  ): File {
    val spec = spec(id)
    val dest = file(spec)
    if (dest.exists()) {
      verify(dest, spec, stopped)
      return dest
    }

    val part = partFile(spec)
    var offset = if (part.exists()) part.length() else 0L
    check(offset <= spec.bytes) { "PART_TOO_LARGE_REMOVE_AND_RETRY" }

    // The runtime builds a weight cache of roughly the model's own size, so
    // budget headroom beyond the transfer rather than only what is left to pull.
    val required = (spec.bytes - offset) + 512L * 1024 * 1024
    check(root.usableSpace >= required) { "INSUFFICIENT_STORAGE" }
    checkStop(stopped)

    if (offset < spec.bytes) {
      val connection = connect(spec.url, offset)
      try {
        when (val status = connection.responseCode) {
          206 -> {
            val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)")
              .matchEntire(connection.getHeaderField("Content-Range") ?: "")
              ?: error("INVALID_CONTENT_RANGE")
            val start = match.groupValues[1].toLong()
            val end = match.groupValues[2].toLong()
            val total = match.groupValues[3].toLong()
            check(start == offset && end >= start && end < total && total == spec.bytes) { "INVALID_CONTENT_RANGE" }
            check(end == spec.bytes - 1) { "PARTIAL_RANGE_RETRY_REQUIRED" }
          }
          200 -> {
            // The server ignored Range. Appending a whole body onto a partial
            // file produces a plausible size and a garbage model, so restart.
            offset = 0
          }
          401, 403 -> error("MODEL_ACCESS_UNAVAILABLE")
          404 -> error("MODEL_NOT_FOUND")
          416 -> error("RANGE_REJECTED_REMOVE_PARTIAL_AND_RETRY")
          429 -> error("MODEL_HOST_RATE_LIMITED")
          else -> error("MODEL_HTTP_$status")
        }

        var received = offset
        var lastEvent = 0L
        connection.inputStream.use { input ->
          FileOutputStream(part, offset > 0).use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
              checkStop(stopped)
              val read = input.read(buffer)
              if (read < 0) break
              check(received + read <= spec.bytes) { "MODEL_TOO_LARGE" }
              output.write(buffer, 0, read)
              received += read
              val now = System.currentTimeMillis()
              if (now - lastEvent >= 500) {
                progress(received, spec.bytes, "downloading")
                lastEvent = now
              }
            }
            output.fd.sync()
          }
        }
        check(received == spec.bytes) { "INCOMPLETE_DOWNLOAD_RETRY" }
      } finally {
        connection.disconnect()
      }
    }

    progress(spec.bytes, spec.bytes, "verifying")
    // A hash failure keeps the .part for diagnostics and produces no ready
    // marker. The caller offers Remove and retry; it is never loaded.
    verify(part, spec, stopped)
    checkStop(stopped)

    // Same-directory rename, and no copy fallback. A half-copied file carrying
    // the final name is indistinguishable from an installed model.
    check(!dest.exists() && part.renameTo(dest)) { "ATOMIC_INSTALL_FAILED" }
    progress(spec.bytes, spec.bytes, "ready")
    return dest
  }

  /**
   * Deletes exactly this pack's files.
   *
   * Scoped to the two names this spec owns so removing one pack can never take
   * another pack's weights with it. The caller must have released any live
   * engine first; freeing a file the runtime has mapped is a crash, not a
   * cleanup.
   */
  fun remove(id: String): Long {
    val spec = spec(id)
    var reclaimed = 0L
    for (target in listOf(file(spec), partFile(spec))) {
      if (target.isFile) {
        val size = target.length()
        if (target.delete()) reclaimed += size
      }
    }
    return reclaimed
  }
}
