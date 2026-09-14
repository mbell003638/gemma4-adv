package ledgr.gemma.productionchecks

import expo.modules.ledgrnativeai.*
import java.io.File

/** Drives the exact admission/management/terminal coordinator used by Expo. */
fun main() {
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    for (id in listOf("", "verify:fixture", "remove:fixture", "a".repeat(81), "bad id")) {
      expectCode("INVALID_REQUEST_ID") { f.lifecycle.admitRequest(id) }
      check(f.admitted.get() == null)
    }
    f.lifecycle.admitRequest("A")
    expectCode("GEMMA_BUSY") { f.lifecycle.admitRequest("B") }
    check(f.admitted.get() == "A")
    expectCode("MODEL_IN_USE") { f.manage("remove:fixture") { error("must not run") }.getOrThrow() }
    f.ack("B")
    check(f.admitted.get() == "A")
    f.ack("A")
    f.ack("A")
    f.ack("never_started")
    check(f.admitted.get() == null && !f.poisoned.get())
  }
  PackFixture().use { packs ->
    packs.install()
    val f = LifecycleFixture(packs.store())
    var result: Result<String>? = null
    f.lifecycle.management("remove:fixture", { f.lifecycle.removeModel("fixture") }) { result = it }
    check(f.admitted.get() == "remove:fixture" && result == null)
    expectCode("GEMMA_BUSY") { f.lifecycle.admitRequest("B") }
    expectCode("MODEL_IN_USE") { f.manage("download:fixture") { error("must not run") }.getOrThrow() }
    check(checkNotNull(result).getOrThrow() == "{\"removed\":true}")
    check(f.admitted.get() == null && f.store.state("fixture") == GemmaPackState.NOT_INSTALLED)
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.queue.reject = true
    expectCode("GEMMA_SHUTDOWN") { f.manage("remove:fixture") { error("must not run") }.getOrThrow() }
    check(f.admitted.get() == null)
    f.queue.reject = false
    var result: Result<String>? = null
    f.lifecycle.management("download:fixture", { error("must not run after shutdown") }) { result = it }
    f.shutdown.set(true)
    f.queue.drain()
    expectCode("GEMMA_SHUTDOWN") { checkNotNull(result).getOrThrow() }
    check(f.admitted.get() == null && !f.poisoned.get())
    expectCode("GEMMA_SHUTDOWN") { f.lifecycle.admitRequest("B") }
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    var result: Result<String>? = null
    f.lifecycle.management("remove:fixture", { error("stale management must not run") }) { result = it }
    // Simulates ownership replacement before a queued operation executes.
    f.admitted.set("B")
    f.queue.drain()
    expectCode("STALE_SESSION") { checkNotNull(result).getOrThrow() }
    check(f.admitted.get() == "B" && f.released.isEmpty())
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    expectCode("MODEL_NETWORK_ERROR") {
      f.manage("download:fixture") { throw GemmaPackException("MODEL_NETWORK_ERROR") }.getOrThrow()
    }
    check(f.admitted.get() == null && !f.poisoned.get())
    f.lifecycle.admitRequest("B"); f.ack("B")
    expectCode("NATIVE_RECOVERY_REQUIRED") {
      f.manage("remove:fixture") { throw LinkageError("uncertain native state") }.getOrThrow()
    }
    check(f.poisoned.get())
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.lifecycle.admitRequest("C") }
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.manage("download:fixture") { "wrong" }.getOrThrow() }
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.terminal("B", true).getOrThrow() }
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.lifecycle.admitRequest("A")
    var work: Result<String>? = null
    var terminal: Result<String>? = null
    val events = mutableListOf<String>()
    f.finishHook = { events.add("finish") }
    f.releaseHook = { events.add("release") }
    f.lifecycle.work("A", { events.add("work"); "answer" }) { work = it }
    f.lifecycle.terminal("A", false) { terminal = it; events.add("ack") }
    check(work == null && terminal == null && f.released.isEmpty())
    f.queue.next()
    check(checkNotNull(work).getOrThrow() == "answer" && terminal == null)
    check(f.admitted.get() == "A")
    f.queue.drain()
    check(checkNotNull(terminal).getOrThrow() == "{\"requestId\":\"A\",\"finished\":true}")
    check(events == listOf("work", "finish", "release", "ack"))
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.lifecycle.admitRequest("A")
    f.active = "A"
    f.failClose = true
    var result: Result<String>? = null
    f.lifecycle.work("A", { throw GemmaPackException("MODEL_HASH_MISMATCH") }) { result = it }
    f.queue.drain()
    expectCode("NATIVE_RECOVERY_REQUIRED") { checkNotNull(result).getOrThrow() }
    check(f.admitted.get() == "A" && f.active == "A" && f.released.isEmpty() && f.poisoned.get())
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.lifecycle.admitRequest("A")
    f.releaseHook = { error("private media deletion failed") }
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.terminal("A", false).getOrThrow() }
    check(f.admitted.get() == "A" && f.poisoned.get() && f.released.isEmpty())
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.lifecycle.admitRequest("B"); f.active = "B"; f.loaded = "fixture"
    f.finishHook = { error("stale finish must not touch B's runtime") }
    f.unloadHook = { error("stale recovery must not unload B") }
    var result: Result<String>? = null
    f.lifecycle.work("A", { error("stale resume must not run") }) { result = it }
    f.queue.drain()
    expectCode("STALE_SESSION") { checkNotNull(result).getOrThrow() }
    f.ack("A")
    expectCode("STALE_SESSION") { f.terminal("A", true).getOrThrow() }
    check(f.admitted.get() == "B" && f.active == "B" && f.loaded == "fixture" && !f.poisoned.get())
    check(f.released == listOf("A"))
  }
  PackFixture().use { packs ->
    packs.install()
    val f = LifecycleFixture(packs.store())
    f.loaded = "other-model"
    check(f.manage("remove:fixture") { f.lifecycle.removeModel("fixture") }.getOrThrow() == "{\"removed\":true}")
    check(f.loaded == "other-model" && f.closed == 0)
    File(packs.root, "fixture.litertlm.part").writeBytes(byteArrayOf(1))
    check(f.manage("remove:fixture") { f.lifecycle.removeModel("fixture") }.getOrThrow() == "{\"removed\":true}")
    check(f.manage("remove:fixture") { f.lifecycle.removeModel("fixture") }.getOrThrow() == "{\"removed\":false}")
    // Deterministic deletion failure without relying on platform permission behavior.
    check(File(packs.root, "fixture.litertlm").mkdir())
    expectCode("MODEL_REMOVE_FAILED") {
      f.manage("remove:fixture") { f.lifecycle.removeModel("fixture") }.getOrThrow()
    }
    check(f.admitted.get() == null && !f.poisoned.get())
  }
  println("Production coordinator ownership/management/terminal regressions passed (no JNI).")
}
