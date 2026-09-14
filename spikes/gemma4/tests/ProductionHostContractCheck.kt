package ledgr.gemma.productionchecks

import expo.modules.ledgrnativeai.*
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.ToolCall
import org.json.JSONArray
import org.json.JSONObject

private class Script : GemmaEngineFactory {
  var initializeHook: () -> Unit = {}
  var sendHook: () -> Unit = {}
  var conversationCloseHook: () -> Unit = {}
  var failConversationClose = false
  var failEngineClose = false
  var automatic = false
  var opened = 0
  var sent = 0
  var closed = 0
  var enginesClosed = 0
  var cancelled = 0
  val turns = mutableListOf<Message>()
  override fun create(config: EngineConfig): GemmaEngineHandle {
    opened++
    return object : GemmaEngineHandle {
      override fun initialize() { initializeHook() }
      override fun createConversation(config: ConversationConfig): GemmaConversationHandle {
        check(!config.automaticToolCalling)
        return object : GemmaConversationHandle {
          override val automaticToolCalling get() = automatic
          private fun next(): Message {
            sendHook()
            sent++
            return if (turns.isEmpty()) answer("answer") else turns.removeAt(0)
          }
          override fun sendMessage(contents: Contents) = next()
          override fun sendMessage(message: Message) = next()
          override fun cancelProcess() { cancelled++ }
          override fun close() {
            conversationCloseHook()
            if (failConversationClose) error("conversation close failed")
            closed++
          }
        }
      }
      override fun close() {
        if (failEngineClose) error("engine close failed")
        enginesClosed++
      }
    }
  }
}

private fun answer(text: String, calls: List<ToolCall> = emptyList()): Message =
  Message.model(Contents.of(Content.Text(text)), calls, emptyMap())

private fun request(id: String = "A", model: String = "fixture", mode: String = "agent"): String =
  JSONObject().put("requestId", id).put("modelId", model).put("mode", mode)
    .put("system", "No writes").put("input", "Read a total").put("tools", JSONArray()).toString()

private fun resume(id: String, calls: JSONArray): String = JSONObject().put("requestId", id)
  .put("results", JSONArray().also { out ->
    for (i in 0 until calls.length()) {
      val c = calls.getJSONObject(i)
      out.put(JSONObject().put("callId", c.getString("id")).put("name", c.getString("name"))
        .put("result", JSONObject().put("total", i)))
    }
  }).toString()

private class HostFixture : AutoCloseable {
  val packs = PackFixture()
  val script = Script()
  val store = packs.store()
  val control = LifecycleFixture(store)
  val attachments = GemmaAttachmentStore(java.io.File(packs.root, "private-media"))
  val host = GemmaSessionHost(store, packs.root, script) { handle, kind, id ->
    attachments.resolve(handle, kind, id)
  }
  init {
    packs.install()
    control.activeHook = { host.activeRequestId() }
    control.loadedHook = { host.loadedModelId() }
    control.finishHook = { id -> host.finish(id); control.active = host.activeRequestId() }
    control.unloadHook = { host.unloadEngine(); control.active = null }
    control.releaseHook = { id -> attachments.release(id); Unit }
  }
  fun begin(id: String = "A", raw: String = request(id)): Result<String> {
    control.lifecycle.admitRequest(id)
    var result: Result<String>? = null
    control.lifecycle.work(id, {
      host.begin(raw).also {
        control.active = host.activeRequestId()
        control.loaded = host.loadedModelId()
      }
    }) { result = it }
    control.queue.drain()
    return checkNotNull(result)
  }
  fun resume(id: String, raw: String): Result<String> {
    var result: Result<String>? = null
    control.lifecycle.work(id, {
      host.resume(raw).also { control.active = host.activeRequestId() }
    }) { result = it }
    control.queue.drain()
    return checkNotNull(result)
  }
  override fun close() {
    script.failConversationClose = false
    script.failEngineClose = false
    host.close()
    packs.close()
  }
}

fun main() {
  HostFixture().use { f ->
    // Cancellation arriving during final close must neither call freed JNI nor
    // let a late answer cross the bridge.
    f.script.conversationCloseHook = { f.host.requestCancel("A") }
    expectCode("GEMMA_CANCELLED") { f.begin().getOrThrow() }
    check(f.script.cancelled == 0 && f.script.closed == 1)
    check(f.control.admitted.get() == null)
  }
  HostFixture().use { f ->
    val privateImage = f.attachments.newWorkFile("image", "jpg").also { it.writeText("private receipt") }
    val handle = f.attachments.stage(privateImage, "image", "A")
    f.script.turns.add(answer("", listOf(ToolCall("read_total", emptyMap()))))
    val raw = JSONObject(request()).put("imageHandle", handle).toString()
    f.begin(raw = raw).getOrThrow()
    f.control.ack("B")
    check(privateImage.isFile && f.host.activeRequestId() == "A")
    f.control.ack("A")
    check(!privateImage.exists() && f.attachments.stagedCount() == 0)
  }
  HostFixture().use { f ->
    val privateImage = f.attachments.newWorkFile("image", "jpg").also { it.writeText("private receipt") }
    val handle = f.attachments.stage(privateImage, "image", "A")
    f.script.initializeHook = { error("load failed") }
    expectCode("load failed") {
      f.begin(raw = JSONObject(request()).put("imageHandle", handle).toString()).getOrThrow()
    }
    check(!privateImage.exists() && f.attachments.stagedCount() == 0)
    check(f.control.admitted.get() == null)
  }
  HostFixture().use { f ->
    check(JSONObject(f.begin().getOrThrow()).getString("requestId") == "A")
    check(f.host.activeRequestId() == null && f.host.isEngineLoaded())
    f.control.ack("A")
    check(f.control.admitted.get() == null)
    f.control.admitted.set("remove:fixture")
    check(f.control.lifecycle.removeModel("fixture") == "{\"removed\":true}")
    check(!f.host.isEngineLoaded() && f.script.enginesClosed == 1)
  }
  HostFixture().use { f ->
    expectCode("UNKNOWN_MODEL") {
      f.begin(raw = request(model = "missing")).getOrThrow()
    }
  }
  HostFixture().use { f ->
    // Actual approved model is absent: failed begin must release admission itself.
    check(java.io.File(f.packs.root, "fixture.litertlm").delete())
    expectCode("MODEL_NOT_INSTALLED") { f.begin().getOrThrow() }
    check(f.control.admitted.get() == null && f.control.released == listOf("A"))
    f.packs.install()
    f.begin("B").getOrThrow()
    f.control.ack("B")
  }
  HostFixture().use { f ->
    f.script.initializeHook = { error("load failed") }
    expectCode("load failed") { f.begin().getOrThrow() }
    check(f.control.admitted.get() == null && f.script.enginesClosed == 1)
    f.script.initializeHook = {}
    f.begin("B").getOrThrow(); f.control.ack("B")
  }
  HostFixture().use { f ->
    f.host.requestCancel("A")
    expectCode("GEMMA_CANCELLED") { f.begin().getOrThrow() }
    check(f.script.opened == 0 && f.control.admitted.get() == null)
    f.control.ack("A")
    f.begin("B").getOrThrow(); f.control.ack("B")
  }
  HostFixture().use { f ->
    f.script.initializeHook = { f.host.requestCancel("A") }
    expectCode("GEMMA_CANCELLED") { f.begin().getOrThrow() }
    check(f.script.sent == 0 && f.script.enginesClosed == 1)
  }
  HostFixture().use { f ->
    // A backend that ignores cancel and returns a late answer must not publish it.
    f.script.sendHook = { f.host.requestCancel("A") }
    expectCode("GEMMA_CANCELLED") { f.begin().getOrThrow() }
    check(f.control.admitted.get() == null && f.script.cancelled == 1)
  }
  HostFixture().use { f ->
    f.script.automatic = true
    expectCode("AUTOMATIC_TOOL_CALLING_ENABLED") { f.begin().getOrThrow() }
    check(f.script.closed == 1 && f.host.activeRequestId() == null)
    check(f.control.admitted.get() == null && f.script.sent == 0)
  }
  expectCode("AUTOMATIC_TOOL_EXECUTION_FORBIDDEN") { SchemaOnlyTool("{}").execute("{}") }
  HostFixture().use { f ->
    f.script.turns.add(answer("", listOf(ToolCall("read_total", emptyMap()), ToolCall("read_total", emptyMap()))))
    val calls = JSONObject(f.begin().getOrThrow()).getJSONArray("calls")
    check(calls.getJSONObject(0).getString("id") != calls.getJSONObject(1).getString("id"))
    f.resume("A", resume("A", calls)).getOrThrow()
    f.control.ack("A")
  }
  HostFixture().use { f ->
    f.script.turns.add(answer("", listOf(ToolCall("read_total", emptyMap()))))
    f.begin().getOrThrow()
    expectCode("TOOL_RESULT_COUNT_MISMATCH") {
      f.resume("A", "{\"requestId\":\"A\",\"results\":[]}").getOrThrow()
    }
    check(f.host.activeRequestId() == null && f.control.admitted.get() == null)
    f.begin("B").getOrThrow(); f.control.ack("B")
  }
  HostFixture().use { f ->
    f.script.turns.add(answer("", listOf(ToolCall("read_total", emptyMap()))))
    f.begin().getOrThrow()
    f.control.ack("B") // rejected B's cleanup must leave A's conversation alive
    check(f.control.admitted.get() == "A" && f.host.activeRequestId() == "A")
    check(f.script.closed == 0)
    expectCode("STALE_SESSION") { f.control.terminal("B", true).getOrThrow() }
    check(f.script.enginesClosed == 0)
    f.control.ack("A", true)
    check(f.host.activeRequestId() == null && !f.host.isEngineLoaded())
  }
  HostFixture().use { f ->
    f.begin().getOrThrow(); f.control.ack("A")
    // Failed begin or retired IDs may recover even when status says idle.
    f.control.ack("A", true)
    f.control.ack("never_started")
    check(!f.host.isEngineLoaded())
  }
  HostFixture().use { f ->
    f.begin().getOrThrow(); f.control.ack("A")
    f.script.failEngineClose = true
    f.control.admitted.set("remove:fixture")
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.control.lifecycle.removeModel("fixture") }
    check(f.control.poisoned.get() && f.host.isEngineLoaded())
    check(java.io.File(f.packs.root, "fixture.litertlm").isFile)
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.control.terminal("A", true).getOrThrow() }
  }
  HostFixture().use { f ->
    f.script.turns.add(answer("", listOf(ToolCall("read_total", emptyMap()))))
    f.begin().getOrThrow()
    f.script.failConversationClose = true
    expectCode("NATIVE_RECOVERY_REQUIRED") { f.control.terminal("A", false).getOrThrow() }
    check(f.control.poisoned.get() && f.control.admitted.get() == "A")
  }
  HostFixture().use { f ->
    f.script.initializeHook = { throw OutOfMemoryError("synthetic") }
    expectCode("GEMMA_MEMORY") { f.begin().getOrThrow() }
    check(f.control.admitted.get() == null && !f.control.poisoned.get())
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.admitted.set("A")
    var ran = false
    var result: Result<String>? = null
    f.lifecycle.work("A", { ran = true; "unexpected" }) { result = it }
    f.shutdown.set(true); f.queue.drain()
    expectCode("GEMMA_SHUTDOWN") { checkNotNull(result).getOrThrow() }
    check(!ran && f.admitted.get() == null)
    f.shutdown.set(false); f.queue.reject = true; f.admitted.set("B")
    f.lifecycle.work("B", { error("must not run") }) { result = it }
    expectCode("GEMMA_SHUTDOWN") { checkNotNull(result).getOrThrow() }
    check(f.admitted.get() == null)
    expectCode("GEMMA_SHUTDOWN") { f.terminal("retired", true).getOrThrow() }
    check(f.admitted.get() == null)
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    f.admitted.set("A")
    var ack: Result<String>? = null
    // Queue recovery after work. Before it runs, A retires and B is admitted.
    f.queue.execute { f.admitted.set("B"); f.active = "B"; f.loaded = "fixture" }
    f.lifecycle.terminal("A", true) { ack = it }
    check(ack == null)
    f.queue.drain()
    expectCode("STALE_SESSION") { checkNotNull(ack).getOrThrow() }
    check(f.admitted.get() == "B" && f.closed == 0 && f.released.isEmpty())
  }
  PackFixture().use { packs ->
    val f = LifecycleFixture(packs.store())
    var ack: Result<String>? = null
    f.queue.execute { check(ack == null) } // represents native work still ahead
    f.lifecycle.terminal("A", true) { ack = it }
    check(f.admitted.get() == "terminal:A" && ack == null)
    f.queue.next()
    check(ack == null) // queued cleanup has not run; no false terminal ack
    f.queue.drain()
    check(checkNotNull(ack).getOrThrow() == "{\"requestId\":\"A\",\"finished\":true}")
  }
  println("Production host/lifecycle regressions passed with real SDK types and fake JNI runtime.")
}
