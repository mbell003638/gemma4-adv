package expo.modules.ledgrnativeai

import java.io.File
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Issues and resolves short-lived attachment handles for Gemma turns.
 *
 * The model never sees a path. It sees an opaque handle that the app issued,
 * bound to one request and one media kind, and this store is the only thing
 * that can turn one back into a file. That is what stops a model -- or a
 * document instructing a model -- from naming `/data/data/.../databases` or an
 * `https://` URL and having native code dutifully read it.
 *
 * SCOPE BOUNDARY: this class owns handle issuance, binding, lifetime and path
 * safety. It does NOT decode, rotate, downscale, render or transcode anything.
 * Forwarding an un-normalized camera URI or a renamed `.m4a` into the SDK is
 * unsafe. A file becomes stageable only after `GemmaMediaNormalizer` has
 * produced a bounded private image, rendered PDF page, or PCM WAV file.
 */
class GemmaAttachmentStore(
  private val root: File,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  /** One staged file. `kind` is checked on resolve so an image cannot arrive as audio. */
  private class Entry(
    val file: File,
    val kind: String,
    val requestId: String,
    val expiresAt: Long,
  ) { var used = false }

  private val entries = ConcurrentHashMap<String, Entry>()
  private val random = SecureRandom()

  init {
    require(root.exists() || root.mkdirs()) { "ATTACHMENT_ROOT_UNAVAILABLE" }
  }

  /**
   * Registers a normalized file and returns its handle.
   *
   * The file must already live inside this store's root, which is app-private
   * and excluded from backup. Accepting a path from anywhere else would make
   * every later check decorative: a symlink or a `..` segment is refused here
   * rather than at read time.
   */
  fun stage(prepared: File, kind: String, requestId: String, ttlMs: Long = DEFAULT_TTL_MS): String {
    require(kind in KINDS) { "UNSUPPORTED_ATTACHMENT_KIND" }
    require(ttlMs in 1..DEFAULT_TTL_MS) { "INVALID_ATTACHMENT_TTL" }
    require(requestId.matches(REQUEST_ID)) { "INVALID_REQUEST_ID" }

    val canonical = prepared.canonicalFile
    // canonicalFile resolves symlinks, so comparing the resolved parent chain
    // is what actually confines the file rather than trusting its spelling.
    require(canonical.isFile) { "ATTACHMENT_NOT_A_FILE" }
    require(isInsideRoot(canonical)) { "ATTACHMENT_OUTSIDE_ROOT" }
    require(canonical.length() in 1..MAX_ATTACHMENT_BYTES) { "ATTACHMENT_SIZE_REJECTED" }

    purgeExpired()
    val handle = newHandle()
    entries[handle] = Entry(canonical, kind, requestId, nowMs() + ttlMs)
    return handle
  }

  /**
   * Resolves a handle for one request and kind, or throws.
   *
   * Every one of these checks has a specific failure it prevents: reuse across
   * turns, one request reading another's media, an audio handle being fed to
   * the vision encoder, and a stale handle outliving the book it belonged to.
   */
  @Synchronized
  fun resolve(handle: String, kind: String, requestId: String): File {
    val entry = entries[handle] ?: throw IllegalStateException("ATTACHMENT_NOT_FOUND")
    if (nowMs() >= entry.expiresAt) {
      discard(handle)
      throw IllegalStateException("ATTACHMENT_EXPIRED")
    }
    check(entry.requestId == requestId) { "ATTACHMENT_WRONG_REQUEST" }
    check(entry.kind == kind) { "ATTACHMENT_WRONG_KIND" }
    check(!entry.used) { "ATTACHMENT_ALREADY_USED" }
    val canonical = entry.file.canonicalFile
    // Re-checked on the way out: the file could have been replaced by a
    // symlink between staging and use.
    check(canonical.isFile && isInsideRoot(canonical)) { "ATTACHMENT_UNAVAILABLE" }
    check(canonical.length() in 1..MAX_ATTACHMENT_BYTES) { "ATTACHMENT_SIZE_REJECTED" }
    entry.used = true
    return canonical
  }

  /**
   * Releases everything a request staged.
   *
   * Called on success, cancellation, lock, book change and process recovery.
   * A receipt photograph is the user's financial data; it does not linger in a
   * cache directory because the turn happened to fail.
   */
  fun release(requestId: String): Int {
    var removed = 0
    for ((handle, entry) in entries) {
      if (entry.requestId == requestId) {
        discard(handle)
        removed += 1
      }
    }
    return removed
  }

  /** Drops every staged file, for logout, lock and module teardown. */
  fun releaseAll(): Int {
    var removed = 0
    for (handle in entries.keys.toList()) {
      discard(handle)
      removed += 1
    }
    return removed
  }

  fun purgeExpired(): Int {
    val now = nowMs()
    var removed = 0
    for ((handle, entry) in entries) {
      if (now >= entry.expiresAt) {
        discard(handle)
        removed += 1
      }
    }
    return removed
  }

  fun stagedCount(): Int = entries.size

  /** A private destination for a P6 normalizer to write into. */
  fun newWorkFile(kind: String, extension: String): File {
    require(kind in KINDS) { "UNSUPPORTED_ATTACHMENT_KIND" }
    require(extension.matches(EXTENSION)) { "UNSUPPORTED_ATTACHMENT_EXTENSION" }
    return File(root, "$kind-${newHandle()}.$extension")
  }

  private fun discard(handle: String) {
    val entry = entries[handle] ?: return
    // Keep the entry until deletion succeeds so terminal cleanup cannot lie.
    // A failed deletion also makes the handle unusable for inference.
    entry.used = true
    if (entry.file.exists() && (!entry.file.isFile || !entry.file.delete())) {
      throw GemmaSessionException("ATTACHMENT_REMOVE_FAILED")
    }
    entries.remove(handle, entry)
  }

  private fun isInsideRoot(canonical: File): Boolean {
    val base = root.canonicalFile
    var parent = canonical.parentFile
    while (parent != null) {
      if (parent == base) return true
      parent = parent.parentFile
    }
    return false
  }

  private fun newHandle(): String {
    val bytes = ByteArray(16)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
  }

  // GemmaMediaNormalizer writes into newWorkFile() and then calls stage():
  //  - Image: bounds-check before decode, correct EXIF rotation, downscale to a
  //    1,280px longest side, strip metadata, re-encode privately. Cap source
  //    bytes and pixel dimensions so a crafted image cannot exhaust memory.
  //  - PDF: PdfRenderer over a bounded copy, one page per extraction session,
  //    at most 5 pages per reviewed batch, excluded pages reported explicitly.
  //    A PDF URI is not an image.
  //  - Audio: MediaExtractor/MediaCodec to the SDK-tested mono PCM WAV rate,
  //    downmixed and resampled. Renaming .m4a to .wav is not a conversion.
  // Raw picker URIs are never staged directly.

  companion object {
    private val KINDS = setOf("image", "audio")
    private val REQUEST_ID = Regex("[A-Za-z0-9_-]{1,80}")
    private val EXTENSION = Regex("[a-z0-9]{1,8}")

    /** Bounded so a staged file cannot itself become a memory problem. */
    const val MAX_ATTACHMENT_BYTES = 24L * 1024 * 1024
    const val DEFAULT_TTL_MS = 5L * 60 * 1000
  }
}
