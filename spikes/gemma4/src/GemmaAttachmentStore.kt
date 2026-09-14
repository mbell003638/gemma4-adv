package ledgr.gemma.spike

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom

/**
 * Scoped, short-lived handles for the one image or recording a turn may use.
 *
 * The model never sees a path. It receives an opaque handle that the app issued
 * for this request and this kind, and the host exchanges it for a file only
 * while that request is the live one. Passing paths through the model would
 * make "read this file" a capability the model could ask for.
 *
 * Android-specific normalisation is deliberately NOT here -- see
 * `MediaNormalizer` -- so that the path, kind, size and lifetime rules can be
 * executed on a desktop JVM.
 */

enum class AttachmentKind(val id: String, val maxBytes: Long) {
  IMAGE("image", 12L * 1024 * 1024),
  AUDIO("audio", 8L * 1024 * 1024),
  DOCUMENT("document", 32L * 1024 * 1024);

  companion object {
    fun of(id: String): AttachmentKind =
      entries.firstOrNull { it.id == id } ?: error("UNKNOWN_ATTACHMENT_KIND")
  }
}

/**
 * The platform work this store refuses to fake.
 *
 * An implementation must:
 *  - IMAGE: read the bounds before decoding (a 20000x20000 JPEG will exhaust
 *    memory otherwise), apply the EXIF rotation, downscale to a 1280px longest
 *    side, strip metadata, and re-encode to a private JPEG. Legibility must be
 *    re-checked after resizing; a receipt total that survived the camera can
 *    still be destroyed by a downscale.
 *  - DOCUMENT: render bounded pages with Android's PdfRenderer from a copied
 *    file, at most five per reviewed batch and one per extraction session,
 *    reporting excluded pages. A PDF URI is not an image.
 *  - AUDIO: decode the recorder's M4A/AAC with MediaExtractor/MediaCodec and
 *    resample to the mono PCM WAV the verified SDK pair accepts. Renaming
 *    `.m4a` to `.wav` is NOT a conversion; it produces a file the encoder
 *    cannot read, and shipping it would fail gate M4.
 */
interface MediaNormalizer {
  fun normalize(source: File, kind: AttachmentKind, destination: File): File
}

/**
 * Copies bytes through unchanged. Present so the path and lifetime rules can be
 * tested; shipping this as the Android implementation would mean handing the
 * encoder an un-normalised camera file and calling P6 complete.
 */
class PassThroughNormalizer : MediaNormalizer {
  override fun normalize(source: File, kind: AttachmentKind, destination: File): File {
    source.copyTo(destination, overwrite = true)
    return destination
  }
}

private class Staged(
  val requestId: String,
  val kind: AttachmentKind,
  val file: File,
  val expiresAt: Long,
  var consumed: Boolean = false,
)

class GemmaAttachmentStore(
  private val workRoot: File,
  private val approvedSourceRoots: List<File>,
  private val normalizer: MediaNormalizer = PassThroughNormalizer(),
  private val now: () -> Long = System::currentTimeMillis,
  private val ttlMs: Long = 5 * 60 * 1000,
) {
  private val random = SecureRandom()
  private val staged = mutableMapOf<String, Staged>()
  private val lock = Any()

  init {
    require(workRoot.exists() || workRoot.mkdirs()) { "ATTACHMENT_ROOT_UNAVAILABLE" }
    require(approvedSourceRoots.isNotEmpty()) { "NO_APPROVED_SOURCE_ROOT" }
  }

  private fun realPath(target: File): Path =
    if (target.exists()) target.toPath().toRealPath() else target.canonicalFile.toPath()

  /**
   * Confirms a source really lives under an approved root.
   *
   * Resolved through the real path, so a symlink pointing out of the cache is
   * rejected rather than followed. A prefix comparison on the raw string would
   * accept `/approved/../etc/passwd` and any link planted inside the cache.
   */
  private fun assertApproved(raw: String, source: File) {
    // Tested against the raw string, because File() rewrites separators: a
    // URL loses its recognisable scheme prefix once it has been through a
    // File, so a check against File.path quietly stops matching.
    if (raw.startsWith("http://", true) || raw.startsWith("https://", true) ||
      raw.startsWith("content://", true) || raw.startsWith("file://", true)
    ) {
      error("REMOTE_ATTACHMENT_REFUSED")
    }
    if (raw.contains("..")) error("ATTACHMENT_PATH_TRAVERSAL")
    if (!source.isFile) error("ATTACHMENT_NOT_FOUND")

    val resolved = realPath(source)
    val allowed = approvedSourceRoots.any { root ->
      runCatching { resolved.startsWith(realPath(root)) }.getOrDefault(false)
    }
    if (!allowed) error("ATTACHMENT_OUTSIDE_APPROVED_ROOT")
  }

  /**
   * Stages one attachment for one request and returns its handle.
   *
   * The handle is random rather than derived from the filename: a predictable
   * handle would let one turn's output name another turn's media.
   */
  fun stage(sourcePath: String, kindId: String, requestId: String): String {
    val kind = AttachmentKind.of(kindId)
    require(requestId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) { "BAD_REQUEST_ID" }

    val source = File(sourcePath)
    assertApproved(sourcePath, source)
    if (source.length() <= 0 || source.length() > kind.maxBytes) error("ATTACHMENT_TOO_LARGE")

    val handle = ByteArray(24).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    val destination = File(workRoot, "$requestId-$handle.${kind.id}")
    val prepared = normalizer.normalize(source, kind, destination)
    if (!prepared.isFile || prepared.length() <= 0) error("ATTACHMENT_NORMALIZE_FAILED")

    synchronized(lock) {
      staged[handle] = Staged(requestId, kind, prepared, now() + ttlMs)
    }
    return handle
  }

  /**
   * Exchanges a handle for a file.
   *
   * Bound to the request and the kind, single-use, and TTL-checked. Reuse is
   * refused so a handle overheard from one turn cannot be replayed into the
   * next one.
   */
  fun resolve(handle: String, kindId: String, requestId: String): File {
    val kind = AttachmentKind.of(kindId)
    synchronized(lock) {
      val entry = staged[handle] ?: error("UNKNOWN_ATTACHMENT_HANDLE")
      if (entry.requestId != requestId) error("ATTACHMENT_WRONG_REQUEST")
      if (entry.kind != kind) error("ATTACHMENT_WRONG_KIND")
      if (entry.consumed) error("ATTACHMENT_ALREADY_USED")
      if (now() > entry.expiresAt) {
        delete(entry)
        staged.remove(handle)
        error("ATTACHMENT_EXPIRED")
      }
      if (!entry.file.isFile) error("ATTACHMENT_MISSING")
      entry.consumed = true
      return entry.file
    }
  }

  /**
   * Drops everything staged for a request.
   *
   * Called on success, cancellation, lock, book change and process recovery. A
   * receipt photo or a voice recording left in a cache directory is exactly the
   * kind of residue a device-only product must not accumulate.
   */
  fun release(requestId: String): Int {
    synchronized(lock) {
      val handles = staged.filterValues { it.requestId == requestId }.keys.toList()
      handles.forEach { handle ->
        staged.remove(handle)?.let { delete(it) }
      }
      return handles.size
    }
  }

  /** Sweeps expired handles even when no request completed cleanly. */
  fun sweepExpired(): Int {
    synchronized(lock) {
      val stale = staged.filterValues { now() > it.expiresAt }.keys.toList()
      stale.forEach { handle -> staged.remove(handle)?.let { delete(it) } }
      return stale.size
    }
  }

  fun stagedCount(): Int = synchronized(lock) { staged.size }

  private fun delete(entry: Staged) {
    runCatching { Files.deleteIfExists(entry.file.toPath()) }
  }
}
