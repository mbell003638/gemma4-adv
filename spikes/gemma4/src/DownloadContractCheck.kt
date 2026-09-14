package ledgr.gemma.spike

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CancellationException

/**
 * Executes the P2 download rules against a real HTTP server on loopback.
 *
 * This is not an Android test and not a model download: the payloads are a few
 * kilobytes of synthetic bytes. What it does prove is that the range, restart,
 * verification and install code paths behave as specified when a server
 * actually replies -- including the cases a mocked downloader would pass by
 * construction, like a server that ignores Range or sends one byte too many.
 */

private const val PAYLOAD_BYTES = 8_192

private fun payload(seed: Int, size: Int = PAYLOAD_BYTES): ByteArray =
  ByteArray(size) { index -> ((index * 31 + seed) and 0xFF).toByte() }

private fun sha256(data: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

/** Behaviour the fake origin should apply to the next request. */
private sealed interface Behaviour {
  /** A clean, complete response, honouring Range unless told not to. */
  data class Serve(val body: ByteArray, val honourRange: Boolean = true) : Behaviour

  /**
   * A connection that dies mid-transfer.
   *
   * Chunked encoding with no terminating chunk, so the client sees a prompt
   * premature EOF. Declaring a Content-Length and simply writing less leaves
   * the socket open and the client blocked until its read timeout, which is a
   * hang rather than the dropped transfer this is meant to simulate.
   */
  data class Drop(val body: ByteArray, val after: Int) : Behaviour

  /** A complete, well-formed response that is shorter than the spec says. */
  data class Truncated(val body: ByteArray, val size: Int) : Behaviour

  data class Status(val code: Int) : Behaviour
  data class BadContentRange(val body: ByteArray, val header: String) : Behaviour
  data class Redirect(val code: Int, val location: String) : Behaviour
  data class Overlong(val body: ByteArray, val extra: Int) : Behaviour
}

private class FakeOrigin {
  private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  val seenRangeHeaders = mutableListOf<String?>()
  val seenAuthHeaders = mutableListOf<String?>()
  var behaviour: Behaviour = Behaviour.Status(404)

  val port: Int get() = server.address.port

  init {
    server.createContext("/model") { exchange -> handle(exchange) }
    server.createContext("/hop") { exchange -> handle(exchange) }
    server.executor = null
    server.start()
  }

  fun url(path: String = "/model") = "http://127.0.0.1:$port$path"

  private fun handle(exchange: HttpExchange) {
    seenRangeHeaders += exchange.requestHeaders.getFirst("Range")
    seenAuthHeaders += exchange.requestHeaders.getFirst("Authorization")
    when (val current = behaviour) {
      is Behaviour.Status -> {
        exchange.sendResponseHeaders(current.code, -1)
        exchange.close()
      }
      is Behaviour.Redirect -> {
        exchange.responseHeaders.add("Location", current.location)
        exchange.sendResponseHeaders(current.code, -1)
        exchange.close()
      }
      is Behaviour.BadContentRange -> {
        exchange.responseHeaders.add("Content-Range", current.header)
        exchange.sendResponseHeaders(206, current.body.size.toLong())
        exchange.responseBody.use { it.write(current.body) }
      }
      is Behaviour.Overlong -> {
        val body = current.body + ByteArray(current.extra) { 0 }
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
      }
      is Behaviour.Truncated -> {
        val body = current.body.copyOfRange(0, current.size)
        exchange.sendResponseHeaders(200, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
      }
      is Behaviour.Drop -> drop(exchange, current)
      is Behaviour.Serve -> serve(exchange, current)
    }
  }

  private fun requestedOffset(exchange: HttpExchange): Int {
    val range = exchange.requestHeaders.getFirst("Range") ?: return 0
    return Regex("bytes=(\\d+)-").find(range)?.groupValues?.get(1)?.toInt() ?: 0
  }

  private fun serve(exchange: HttpExchange, plan: Behaviour.Serve) {
    val offset = if (plan.honourRange) requestedOffset(exchange) else 0
    val slice = plan.body.copyOfRange(offset, plan.body.size)

    if (offset > 0 && plan.honourRange) {
      exchange.responseHeaders.add(
        "Content-Range",
        "bytes $offset-${plan.body.size - 1}/${plan.body.size}",
      )
      exchange.sendResponseHeaders(206, slice.size.toLong())
    } else {
      exchange.sendResponseHeaders(200, slice.size.toLong())
    }
    exchange.responseBody.use { it.write(slice) }
    exchange.close()
  }

  private fun drop(exchange: HttpExchange, plan: Behaviour.Drop) {
    val offset = requestedOffset(exchange)
    val slice = plan.body.copyOfRange(offset, plan.body.size)
    val sent = minOf(plan.after, slice.size)

    if (offset > 0) {
      exchange.responseHeaders.add(
        "Content-Range",
        "bytes $offset-${plan.body.size - 1}/${plan.body.size}",
      )
    }
    // Zero means chunked: the client learns the length only from the stream,
    // so an abrupt close is an immediate error rather than a stall.
    exchange.sendResponseHeaders(if (offset > 0) 206 else 200, 0)
    val body = exchange.responseBody
    runCatching {
      body.write(slice, 0, sent)
      body.flush()
    }
    // Close the exchange without terminating the chunked stream.
    runCatching { exchange.close() }
  }

  fun stop() = server.stop(0)
}

/** Loopback policy used ONLY here. Production keeps HUGGING_FACE_ONLY. */
private val LOOPBACK_ONLY = HostPolicy { url: URL ->
  url.protocol == "http" && url.host == "127.0.0.1" && url.userInfo == null
}

private val checks = mutableListOf<String>()

private fun pass(id: String, detail: String) {
  checks += id
  println("PASS $id -- $detail")
}

private fun expectFailure(id: String, detail: String, block: () -> Unit) {
  val outcome = runCatching(block)
  check(outcome.isFailure) { "$id should have failed: $detail" }
  pass(id, "$detail -> ${outcome.exceptionOrNull()?.message}")
}

private fun tempRoot(name: String): File =
  Files.createTempDirectory("gemma-$name").toFile().also { it.deleteOnExit() }

private fun spec(url: String, body: ByteArray, filename: String = "gemma4-test.litertlm") = GemmaPackSpec(
  id = "gemma4-test",
  filename = filename,
  url = url,
  bytes = body.size.toLong(),
  sha256 = sha256(body),
  revision = "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1",
)

private fun store(root: File, vararg specs: GemmaPackSpec) =
  GemmaPackStore(root, specs.toList(), LOOPBACK_ONLY)

private val noProgress: (Long, Long, String) -> Unit = { _, _, _ -> }

// --- Spec validation, which needs no server ------------------------------

private fun checkSpecValidation() {
  val body = payload(1)
  val root = tempRoot("spec")
  val good = spec("https://huggingface.co/x/resolve/main/a.litertlm", body)

  expectFailure("S1", "malformed sha256") {
    GemmaPackStore(root, listOf(good.copy(sha256 = "abc")))
  }
  expectFailure("S2", "uppercase sha256") {
    GemmaPackStore(root, listOf(good.copy(sha256 = good.sha256.uppercase())))
  }
  expectFailure("S3", "malformed revision") {
    GemmaPackStore(root, listOf(good.copy(revision = "main")))
  }
  expectFailure("S4", "path traversal filename") {
    GemmaPackStore(root, listOf(good.copy(filename = "../escape.litertlm")))
  }
  expectFailure("S5", "nested filename") {
    GemmaPackStore(root, listOf(good.copy(filename = "sub/dir.litertlm")))
  }
  expectFailure("S6", "non-https url") {
    GemmaPackStore(root, listOf(good.copy(url = "http://huggingface.co/a.litertlm")))
  }
  expectFailure("S7", "foreign host") {
    GemmaPackStore(root, listOf(good.copy(url = "https://example.com/a.litertlm")))
  }
  expectFailure("S8", "credentials in url") {
    GemmaPackStore(root, listOf(good.copy(url = "https://u:p@huggingface.co/a.litertlm")))
  }
  expectFailure("S9", "duplicate pack id") {
    GemmaPackStore(root, listOf(good, good.copy(filename = "other.litertlm")))
  }
  expectFailure("S10", "duplicate filename") {
    GemmaPackStore(root, listOf(good, good.copy(id = "gemma4-other")))
  }
  expectFailure("S11", "unknown model id") {
    GemmaPackStore(root, listOf(good)).download("gemma4-nope", { false }, noProgress)
  }
  // The production policy must still be the default.
  expectFailure("S12", "default policy refuses loopback") {
    GemmaPackStore(root, listOf(good.copy(url = "http://127.0.0.1:1/a.litertlm")))
  }
  pass("S13", "production default is HUGGING_FACE_ONLY, loosened only in this check")
}

// --- Server-backed scenarios ---------------------------------------------

private fun checkHappyPath(origin: FakeOrigin) {
  val body = payload(2)
  val root = tempRoot("d1")
  origin.behaviour = Behaviour.Serve(body)
  origin.seenAuthHeaders.clear()

  val target = store(root, spec(origin.url(), body))
  val installed = target.download("gemma4-test", { false }, noProgress)

  check(installed.length() == body.size.toLong()) { "D1 wrong size" }
  check(sha256(installed.readBytes()) == sha256(body)) { "D1 wrong content" }
  check(target.state("gemma4-test") == PackState.READY) { "D1 not reported ready" }
  check(!File(root, "gemma4-test.litertlm.part").exists()) { "D1 left a partial file" }
  check(origin.seenAuthHeaders.all { it == null }) { "D1 sent an Authorization header" }
  pass("D1", "anonymous pinned download installed and verified, no credentials sent")
}

private fun checkResume(origin: FakeOrigin) {
  val body = payload(3)
  val root = tempRoot("d2")
  val target = store(root, spec(origin.url(), body))

  // First attempt dies part way through.
  origin.behaviour = Behaviour.Drop(body, after = 3_000)
  expectFailure("D2a", "interrupted transfer is not installed") {
    target.download("gemma4-test", { false }, noProgress)
  }
  val part = File(root, "gemma4-test.litertlm.part")
  // A dropped transfer can leave any prefix behind, so the retained length is
  // read rather than assumed. What must hold is that something WAS kept and
  // that the resume then asks for exactly that offset.
  check(part.isFile) { "D2 partial download was discarded" }
  val retained = part.length()
  check(retained in 1 until body.size.toLong()) { "D2 retained $retained of ${body.size} bytes" }
  check(target.state("gemma4-test") == PackState.PARTIAL) { "D2 state should be PARTIAL" }

  // Second attempt resumes from exactly where it stopped.
  origin.seenRangeHeaders.clear()
  origin.behaviour = Behaviour.Serve(body)
  val installed = target.download("gemma4-test", { false }, noProgress)

  check(origin.seenRangeHeaders.contains("bytes=$retained-")) {
    "D2 expected Range bytes=$retained-, saw ${origin.seenRangeHeaders}"
  }
  check(sha256(installed.readBytes()) == sha256(body)) { "D2 resumed file does not match" }
  pass("D2", "resumed at byte $retained via HTTP 206 and the final hash matched the whole payload")
}

private fun checkRangeIgnored(origin: FakeOrigin) {
  val body = payload(4)
  val root = tempRoot("d3")
  val target = store(root, spec(origin.url(), body))

  origin.behaviour = Behaviour.Drop(body, after = 2_048)
  expectFailure("D3a", "first attempt interrupted") { target.download("gemma4-test", { false }, noProgress) }
  check(File(root, "gemma4-test.litertlm.part").length() in 1..2_048L) { "D3 setup wrong" }

  // Server replies 200 and ignores Range: the partial must be discarded.
  origin.behaviour = Behaviour.Serve(body, honourRange = false)
  val installed = target.download("gemma4-test", { false }, noProgress)

  check(installed.length() == body.size.toLong()) {
    "D3 concatenated instead of restarting: ${installed.length()} bytes"
  }
  check(sha256(installed.readBytes()) == sha256(body)) { "D3 content wrong after restart" }
  pass("D3", "server ignoring Range restarted the file instead of appending")
}

private fun checkErrorStatuses(origin: FakeOrigin) {
  val body = payload(5)
  for (code in listOf(401, 403, 404, 416, 429, 500)) {
    val root = tempRoot("d4-$code")
    val target = store(root, spec(origin.url(), body))
    origin.behaviour = Behaviour.Status(code)
    val outcome = runCatching { target.download("gemma4-test", { false }, noProgress) }
    check(outcome.isFailure) { "D4 HTTP $code should fail" }
    check(!File(root, "gemma4-test.litertlm").exists()) { "D4 HTTP $code left a ready file" }
    check(target.state("gemma4-test") == PackState.NOT_INSTALLED) { "D4 HTTP $code wrong state" }
    println("     HTTP $code -> ${outcome.exceptionOrNull()?.message}")
  }

  val root = tempRoot("d4-range")
  val target = store(root, spec(origin.url(), body))
  origin.behaviour = Behaviour.Drop(body, after = 1_024)
  runCatching { target.download("gemma4-test", { false }, noProgress) }
  origin.behaviour = Behaviour.BadContentRange(body.copyOfRange(1_024, body.size), "bytes 999-1/7")
  expectFailure("D4a", "malformed Content-Range") { target.download("gemma4-test", { false }, noProgress) }
  check(!File(root, "gemma4-test.litertlm").exists()) { "D4 bad range left a ready file" }
  pass("D4", "each error status and a malformed Content-Range produced a distinct error and no ready file")
}

private fun checkBadBodies(origin: FakeOrigin) {
  val body = payload(6)

  // Short body: declared length is honoured but fewer bytes arrive.
  val shortRoot = tempRoot("d5-short")
  val shortStore = store(shortRoot, spec(origin.url(), body))
  origin.behaviour = Behaviour.Truncated(body, size = body.size - 10)
  expectFailure("D5a", "short body") { shortStore.download("gemma4-test", { false }, noProgress) }
  check(!File(shortRoot, "gemma4-test.litertlm").exists()) { "D5 short body installed" }

  // Oversized body: refused while streaming, before any hashing.
  val bigRoot = tempRoot("d5-big")
  val bigStore = store(bigRoot, spec(origin.url(), body))
  origin.behaviour = Behaviour.Overlong(body, extra = 64)
  expectFailure("D5b", "oversized body") { bigStore.download("gemma4-test", { false }, noProgress) }
  check(!File(bigRoot, "gemma4-test.litertlm").exists()) { "D5 oversized body installed" }

  // Checksum mismatch: right length, wrong content.
  val hashRoot = tempRoot("d5-hash")
  val wrong = payload(99)
  val hashStore = store(hashRoot, spec(origin.url(), body))
  origin.behaviour = Behaviour.Serve(wrong)
  expectFailure("D5c", "checksum mismatch") { hashStore.download("gemma4-test", { false }, noProgress) }
  check(!File(hashRoot, "gemma4-test.litertlm").exists()) { "D5 hash mismatch installed" }
  check(File(hashRoot, "gemma4-test.litertlm.part").isFile) { "D5 should retain the part for diagnostics" }
  pass("D5", "short, oversized and mismatched bodies were never installed; mismatch kept the part file")
}

private fun checkPauseVersusRemove(origin: FakeOrigin) {
  val first = payload(7)
  val second = payload(8)
  val root = tempRoot("d6")
  val target = GemmaPackStore(
    root,
    listOf(
      spec(origin.url(), first, "gemma4-first.litertlm").copy(id = "gemma4-first"),
      spec(origin.url(), second, "gemma4-second.litertlm").copy(id = "gemma4-second"),
    ),
    LOOPBACK_ONLY,
  )

  // Pause mid-transfer: the partial file survives.
  origin.behaviour = Behaviour.Serve(first)
  var seen = 0L
  expectFailure("D6a", "pause during transfer") {
    target.download("gemma4-first", { seen > 0 }) { received, _, _ -> seen = received }
  }
  val firstPart = File(root, "gemma4-first.litertlm.part")
  check(firstPart.isFile) { "D6 pause discarded the partial download" }

  // Install the second pack, then remove the first: only its files go.
  origin.behaviour = Behaviour.Serve(second)
  target.download("gemma4-second", { false }, noProgress)
  check(target.state("gemma4-second") == PackState.READY) { "D6 second pack not ready" }

  val reclaimed = target.remove("gemma4-first")
  check(reclaimed > 0) { "D6 remove reclaimed nothing" }
  check(!firstPart.exists()) { "D6 remove left the first pack's partial" }
  check(File(root, "gemma4-second.litertlm").isFile) { "D6 remove deleted another pack's model" }
  check(target.state("gemma4-second") == PackState.READY) { "D6 second pack disturbed by remove" }
  pass("D6", "pause retained the partial; remove touched only the targeted pack")
}

private fun checkInstallCollision(origin: FakeOrigin) {
  val body = payload(9)
  val root = tempRoot("d7")
  val target = store(root, spec(origin.url(), body))

  // A pre-existing destination file that is NOT the approved model: the
  // install must refuse rather than overwrite or copy over it.
  File(root, "gemma4-test.litertlm").writeBytes(payload(123, 16))
  check(target.state("gemma4-test") == PackState.CORRUPT) { "D7 a bad final file must read as CORRUPT" }

  origin.behaviour = Behaviour.Serve(body)
  expectFailure("D7a", "existing destination is not silently replaced") {
    target.download("gemma4-test", { false }, noProgress)
  }
  check(File(root, "gemma4-test.litertlm").length() == 16L) { "D7 overwrote the existing file" }
  pass("D7", "a corrupt existing file is reported, not overwritten, and never installed over")
}

private fun checkRedirectPolicy(origin: FakeOrigin) {
  val body = payload(10)
  val root = tempRoot("d8")
  val target = store(root, spec(origin.url("/hop"), body))

  origin.behaviour = Behaviour.Redirect(302, "https://example.com/evil.litertlm")
  expectFailure("D8a", "redirect to a disallowed host") {
    target.download("gemma4-test", { false }, noProgress)
  }
  check(!File(root, "gemma4-test.litertlm").exists()) { "D8 installed after a bad redirect" }

  origin.behaviour = Behaviour.Redirect(302, origin.url("/hop"))
  expectFailure("D8b", "redirect loop is bounded") {
    target.download("gemma4-test", { false }, noProgress)
  }
  pass("D8", "redirects are re-checked against the allowlist and bounded at six hops")
}

private fun checkCancellation(origin: FakeOrigin) {
  val body = payload(11)
  val root = tempRoot("d9")
  val target = store(root, spec(origin.url(), body))

  origin.behaviour = Behaviour.Serve(body)
  val outcome = runCatching { target.download("gemma4-test", { true }, noProgress) }
  check(outcome.exceptionOrNull() is CancellationException) {
    "D9 expected CancellationException, got ${outcome.exceptionOrNull()}"
  }
  check(!File(root, "gemma4-test.litertlm").exists()) { "D9 installed a cancelled download" }
  pass("D9", "a request cancelled before the first read never started and installed nothing")
}

private fun checkVerifiedFileGate(origin: FakeOrigin) {
  val body = payload(12)
  val root = tempRoot("d10")
  val target = store(root, spec(origin.url(), body))

  expectFailure("D10a", "verifiedFile before install") { target.verifiedFile("gemma4-test") }

  origin.behaviour = Behaviour.Serve(body)
  target.download("gemma4-test", { false }, noProgress)
  check(target.verifiedFile("gemma4-test").isFile) { "D10 verified file missing after install" }

  // Replacement on disk must invalidate the ready claim on the next check.
  File(root, "gemma4-test.litertlm").writeBytes(payload(200, body.size))
  expectFailure("D10b", "swapped file fails verification") { target.verifiedFile("gemma4-test") }
  check(target.state("gemma4-test") == PackState.CORRUPT) { "D10 swapped file should read CORRUPT" }
  pass("D10", "a model is re-verified before use, so a swapped file cannot be loaded")
}

fun main() {
  println("P2 download contract check -- loopback HTTP only, no model weights, no Android.")
  checkSpecValidation()

  val origin = FakeOrigin()
  try {
    checkHappyPath(origin)
    checkResume(origin)
    checkRangeIgnored(origin)
    checkErrorStatuses(origin)
    checkBadBodies(origin)
    checkPauseVersusRemove(origin)
    checkInstallCollision(origin)
    checkRedirectPolicy(origin)
    checkCancellation(origin)
    checkVerifiedFileGate(origin)
  } finally {
    origin.stop()
  }

  println()
  println("PASS: ${checks.size} download checks (${checks.joinToString(", ")}).")
  println("NOT TESTED: Android runtime, WorkManager/foreground survival, a real model download.")
}
