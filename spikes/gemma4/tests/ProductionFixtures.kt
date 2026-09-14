package ledgr.gemma.productionchecks

import expo.modules.ledgrnativeai.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class ManualExecutor : Executor {
  private val tasks = ArrayDeque<Runnable>()
  var reject = false
  override fun execute(command: Runnable) = synchronized(tasks) {
    if (reject) throw RejectedExecutionException("test queue closed")
    tasks.addLast(command)
    Unit
  }
  fun size(): Int = synchronized(tasks) { tasks.size }
  fun next() { synchronized(tasks) { tasks.removeFirst() }.run() }
  fun drain() {
    var count = 0
    while (size() > 0) {
      check(++count < 100) { "unbounded scheduling loop" }
      next()
    }
  }
}

internal fun expectCode(expected: String, block: () -> Unit) {
  val error = runCatching(block).exceptionOrNull() ?: error("Expected $expected")
  val actual = when (error) {
    is GemmaPackException -> error.code
    else -> error.message
  }
  check(actual == expected) { "Expected $expected; got $actual" }
}

internal class PackFixture : AutoCloseable {
  val root: File = Files.createTempDirectory("ledgr-production-pack-").toFile()
  val bytes = byteArrayOf(1, 2, 3, 4, 5)
  val revision = "a".repeat(40)
  fun spec(id: String = "fixture") = GemmaPackSpec(
    id, "$id.litertlm", "https://huggingface.co/approved/resolve/$revision/$id.litertlm",
    bytes.size.toLong(),
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
    revision,
  )
  fun install(id: String = "fixture"): File = File(root, spec(id).filename).apply { writeBytes(bytes) }
  fun store(
    ids: List<String> = listOf("fixture"),
    connect: (URL) -> HttpURLConnection = { error("UNEXPECTED_NETWORK") },
  ) = GemmaPackStore(root, ids.map { spec(it) }, connect)
  override fun close() { check(root.deleteRecursively()) }
}

internal class LifecycleFixture(
  val store: GemmaPackStore,
  val queue: ManualExecutor = ManualExecutor(),
) {
  val admitted = AtomicReference<String?>(null)
  val shutdown = AtomicBoolean(false)
  val poisoned = AtomicBoolean(false)
  var active: String? = null
  var loaded: String? = null
  var activeHook: () -> String? = { active }
  var loadedHook: () -> String? = { loaded }
  var closed = 0
  var failClose = false
  var finishHook: (String) -> Unit = { id -> if (active == id) active = null }
  var unloadHook: () -> Unit = {}
  var releaseHook: (String) -> Unit = {}
  val released = mutableListOf<String>()
  val lifecycle = GemmaLifecycle(
    queue, admitted, shutdown, poisoned, { store },
    finish = { id -> if (failClose) error("close failed"); finishHook(id) },
    unload = {
      if (failClose) error("close failed")
      unloadHook()
      closed++
      loaded = null
    },
    activeId = { activeHook() },
    loadedModel = { loadedHook() },
    release = {
      releaseHook(it)
      released.add(it)
      admitted.compareAndSet(it, null)
    },
  )
  fun terminal(id: String, recover: Boolean): Result<String> {
    var result: Result<String>? = null
    lifecycle.terminal(id, recover) { result = it }
    queue.drain()
    return checkNotNull(result)
  }
  fun ack(id: String, recover: Boolean = false) {
    check(terminal(id, recover).getOrThrow() == "{\"requestId\":\"$id\",\"finished\":true}")
  }

  fun manage(token: String, action: () -> String): Result<String> {
    var result: Result<String>? = null
    lifecycle.management(token, action) { result = it }
    queue.drain()
    return checkNotNull(result)
  }
}
