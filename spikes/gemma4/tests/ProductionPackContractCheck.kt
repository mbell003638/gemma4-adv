package ledgr.gemma.productionchecks

import expo.modules.ledgrnativeai.*
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

private class Reply(url: URL, private val status: Int, private val bytes: ByteArray, private val range: String? = null) :
  HttpURLConnection(url) {
  var disconnected = false
  override fun connect() {}
  override fun disconnect() { disconnected = true }
  override fun usingProxy() = false
  override fun getResponseCode() = status
  override fun getHeaderField(name: String): String? = if (name == "Content-Range") range else null
  override fun getInputStream() = ByteArrayInputStream(bytes)
}

fun main() {
  PackFixture().use { f ->
    f.install("a"); f.install("b")
    var network = 0
    val first = f.store(listOf("a", "b")) { network++; error("network forbidden") }
    first.verifiedFile("a"); first.verifiedFile("b")
    val restarted = f.store(listOf("a", "b")) { network++; error("network forbidden") }
    check(restarted.state("a") == GemmaPackState.VERIFYING)
    val host = LifecycleFixture(restarted)
    val pollers = List(12) { Thread { host.lifecycle.scheduleInstalledVerification() } }
    pollers.forEach { it.start() }; pollers.forEach { it.join() }
    check(host.queue.size() == 1)
    check(host.admitted.get() == "verify:a")
    expectCode("MODEL_IN_USE") { host.lifecycle.removeModel("a") }
    host.queue.drain()
    check(restarted.state("a") == GemmaPackState.READY)
    check(restarted.state("b") == GemmaPackState.READY)
    check(network == 0 && host.admitted.get() == null)
  }
  PackFixture().use { f ->
    f.install().writeBytes(byteArrayOf(5, 4, 3, 2, 1))
    val h = LifecycleFixture(f.store())
    h.lifecycle.scheduleInstalledVerification(); h.queue.drain()
    check(h.store.state("fixture") == GemmaPackState.ERROR)
    repeat(10) { h.lifecycle.scheduleInstalledVerification() }
    check(h.queue.size() == 0)
    h.admitted.set("remove:fixture")
    check(h.lifecycle.removeModel("fixture") == "{\"removed\":true}")
    check(h.store.state("fixture") == GemmaPackState.NOT_INSTALLED)
  }
  PackFixture().use { f ->
    File(f.root, "fixture.litertlm.part").writeBytes(byteArrayOf(1, 2))
    val h = LifecycleFixture(f.store())
    h.lifecycle.scheduleInstalledVerification()
    check(h.queue.size() == 0 && h.store.state("fixture") == GemmaPackState.PAUSED)
    check(h.store.discardPartial("fixture"))
  }
  PackFixture().use { f ->
    f.install()
    val h = LifecycleFixture(f.store())
    h.queue.reject = true
    h.lifecycle.scheduleInstalledVerification()
    check(h.admitted.get() == null)
    h.queue.reject = false
    h.lifecycle.scheduleInstalledVerification()
    h.shutdown.set(true)
    h.queue.drain()
    check(h.admitted.get() == null && h.store.state("fixture") == GemmaPackState.VERIFYING)
    h.shutdown.set(false)
    h.lifecycle.scheduleInstalledVerification(); h.queue.drain()
    check(h.store.state("fixture") == GemmaPackState.READY)
  }
  PackFixture().use { f ->
    val file = f.install()
    val store = f.store()
    val failure = runCatching { store.verifiedFile("fixture") { true } }.exceptionOrNull()
    check(failure is java.util.concurrent.CancellationException)
    check(store.state("fixture") == GemmaPackState.ERROR)
    store.verifiedFile("fixture")
    var changed = false
    // The stop callback is invoked during the actual production hash read.
    val fresh = f.store()
    expectCode("MODEL_CHANGED_DURING_VERIFICATION") {
      fresh.verifiedFile("fixture") {
        if (!changed) {
          changed = true
          check(file.setLastModified(file.lastModified() + 2000))
        }
        false
      }
    }
    check(fresh.state("fixture") == GemmaPackState.ERROR)
  }
  // Production transport seam retains HTTPS allowlist/range logic.
  PackFixture().use { f ->
    val replies = mutableListOf<Reply>()
    val store = f.store { url ->
      Reply(url, 200, f.bytes).also { replies.add(it) }
    }
    store.download("fixture", { false }) { _, _, _ -> }
    check(store.state("fixture") == GemmaPackState.READY)
    check(replies.single().disconnected)
  }
  PackFixture().use { f ->
    File(f.root, "fixture.litertlm.part").writeBytes(f.bytes.take(2).toByteArray())
    lateinit var reply: Reply
    val store = f.store { url ->
      Reply(url, 206, f.bytes.drop(2).toByteArray(), "bytes 2-4/5").also { reply = it }
    }
    store.download("fixture", { false }) { _, _, _ -> }
    check(reply.getRequestProperty("Range") == "bytes=2-")
    check(store.state("fixture") == GemmaPackState.READY)
  }
  PackFixture().use { f ->
    File(f.root, "fixture.litertlm.part").writeBytes(f.bytes.take(2).toByteArray())
    val store = f.store { url -> Reply(url, 206, f.bytes, "bytes 0-4/5") }
    expectCode("INVALID_CONTENT_RANGE") { store.download("fixture", { false }) { _, _, _ -> } }
    check(!File(f.root, "fixture.litertlm").exists())
  }
  PackFixture().use { f ->
    f.install().writeBytes(byteArrayOf(5, 4, 3, 2, 1))
    val store = f.store()
    expectCode("MODEL_HASH_MISMATCH") { store.download("fixture", { false }) { _, _, _ -> } }
    check(store.state("fixture") == GemmaPackState.ERROR)
  }
  println("Production pack/restart/transport regression groups passed (synthetic bytes; no JNI).")
}
