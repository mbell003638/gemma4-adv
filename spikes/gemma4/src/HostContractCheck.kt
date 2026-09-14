package ledgr.gemma.spike

import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.ToolCall
import java.io.File
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject

/**
 * Executes the P3 host and attachment rules on a desktop JVM.
 *
 * No JNI, no model, no device. The SDK's own data types (Contents, Message,
 * ToolCall, Content.*) are the real ones -- they need no native library -- but
 * Engine and Conversation do, so the host is driven through its engine seam
 * with a scripted fake. That fake stands in for the RUNTIME, never for the
 * SDK's types.
 *
 * What this therefore proves: admission, tombstones, idle expiry, request
 * validation, frame shape, and resume ordering. What it cannot prove: that
 * Gemma runs, that a tool template round-trips through real weights, or that
 * the Android build compiles. Gate N1 still needs a phone.
 */

private val checks = mutableListOf<String>()

private fun pass(id: String, detail: String) {
  checks += id
  println("PASS $id -- $detail")
}

private fun expectCode(id: String, expected: String, detail: String, block: () -> Unit) {
  val outcome = runCatching(block)
  check(outcome.isFailure) { "$id should have failed ($detail)" }
  val error = outcome.exceptionOrNull()
  val code = (error as? GemmaHostException)?.code ?: error?.message
  check(code == expected) { "$id expected $expected, got $code" }
  pass(id, "$detail -> $expected")
}

private fun expectFailure(id: String, detail: String, block: () -> Unit) {
  val outcome = runCatching(block)
  check(outcome.isFailure) { "$id should have failed ($detail)" }
  pass(id, "$detail -> ${outcome.exceptionOrNull()?.message}")
}

private fun tempDir(name: String): File =
  Files.createTempDirectory("gemma-host-$name").toFile().also { it.deleteOnExit() }

// --- Scripted runtime ----------------------------------------------------

/** A turn the fake runtime should return next. */
private class Script(val turns: MutableList<Message> = mutableListOf()) {
  var sent = 0
  var cancelCount = 0
  var closedConversations = 0
  var openedEngines = 0
  var closedEngines = 0
  var failOpenWith: Throwable? = null
  var onOpen: (() -> Unit)? = null
}

private fun modelTurn(text: String, calls: List<ToolCall> = emptyList()): Message =
  Message.model(Contents.of(Content.Text(text)), calls, emptyMap())

private fun fakeFactory(script: Script) = GemmaEngineFactory { _: EngineConfig ->
  script.failOpenWith?.let { throw it }
  script.openedEngines += 1
  script.onOpen?.invoke()
  object : GemmaEngineHandle {
    override fun createConversation(config: ConversationConfig): GemmaConversationHandle {
      // The host must never enable automatic tool calling.
      check(!config.automaticToolCalling) { "automaticToolCalling must stay false" }
      return object : GemmaConversationHandle {
        private fun next(): Message {
          val turn = script.turns.getOrNull(script.sent) ?: error("SCRIPT_EXHAUSTED")
          script.sent += 1
          return turn
        }
        override fun send(contents: Contents): Message = next()
        override fun sendTool(message: Message): Message = next()
        override fun cancel() { script.cancelCount += 1 }
        override fun close() { script.closedConversations += 1 }
      }
    }
    override fun close() { script.closedEngines += 1 }
  }
}

private fun host(
  script: Script,
  clock: () -> Long = System::currentTimeMillis,
  idleMs: Long = 15_000,
  model: File = File(tempDir("model"), "gemma4-e2b.litertlm").apply { writeText("weights") },
  attachment: (String, String) -> File = { _, _ -> model },
) = GemmaSessionHost(
  resolveModel = { id -> if (id == "gemma4-e2b") model else error("MODEL_INTEGRITY") },
  cacheRoot = tempDir("cache"),
  resolveAttachment = attachment,
  factory = fakeFactory(script),
  now = clock,
  idleTimeoutMs = idleMs,
)

private fun beginJson(
  requestId: String = "request-1",
  modelId: String = "gemma4-e2b",
  mode: String = "agent",
  tools: List<String> = emptyList(),
  imageHandle: String? = null,
  audioHandle: String? = null,
  input: String = "What is the total?",
): String {
  val payload = JSONObject()
    .put("requestId", requestId)
    .put("modelId", modelId)
    .put("mode", mode)
    .put("system", "You are the local Ledgr assistant.")
    .put("input", input)
  val array = JSONArray()
  tools.forEach { name ->
    array.put(
      JSONObject()
        .put("name", name)
        .put("description", "Read a fixture total.")
        .put(
          "parameters",
          JSONObject().put("type", "object").put("properties", JSONObject())
            .put("required", JSONArray()).put("additionalProperties", false),
        ),
    )
  }
  payload.put("tools", array)
  imageHandle?.let { payload.put("imageHandle", it) }
  audioHandle?.let { payload.put("audioHandle", it) }
  return payload.toString()
}

// --- Request validation --------------------------------------------------

private fun checkRequestValidation() {
  expectCode("H1", GemmaError.REQUEST_TOO_LARGE, "oversized begin payload") {
    host(Script()).begin("x".repeat(40_001))
  }
  expectCode("H2", GemmaError.BAD_REQUEST, "malformed JSON") { host(Script()).begin("not json") }
  expectCode("H3", GemmaError.BAD_REQUEST, "missing requestId") {
    host(Script()).begin(JSONObject().put("modelId", "gemma4-e2b").toString())
  }
  expectCode("H4", GemmaError.BAD_REQUEST, "requestId with illegal characters") {
    host(Script()).begin(beginJson(requestId = "request 1; drop"))
  }
  expectCode("H5", GemmaError.BAD_REQUEST, "unknown mode") {
    host(Script()).begin(beginJson(mode = "sql"))
  }
  expectCode("H6", GemmaError.TOOLS_NOT_ALLOWED, "tools offered in extract mode") {
    host(Script()).begin(beginJson(mode = "extract", tools = listOf("read_total")))
  }
  expectCode("H7", GemmaError.TOOLS_NOT_ALLOWED, "tools offered in transcribe mode") {
    host(Script()).begin(beginJson(mode = "transcribe", tools = listOf("read_total")))
  }
  expectCode("H8", GemmaError.BAD_REQUEST, "more than eight tools") {
    host(Script()).begin(beginJson(tools = (1..9).map { "read_$it" }))
  }
  expectCode("H9", GemmaError.ONE_MEDIA_KIND, "image and audio in one turn") {
    host(Script()).begin(beginJson(imageHandle = "a", audioHandle = "b"))
  }
  expectCode("H10", GemmaError.MODEL_INTEGRITY, "unverified model id") {
    host(Script()).begin(beginJson(modelId = "gemma4-unknown"))
  }
  pass("H11", "every begin rejection happened before any engine was opened")
}

private fun checkAutomaticToolingRefused() {
  expectCode(
    "H12", GemmaError.AUTOMATIC_TOOL_FORBIDDEN, "SchemaOnlyTool.execute invoked directly",
  ) { SchemaOnlyTool("{}").execute("{}") }
  val schema = """{"name":"read_total"}"""
  check(SchemaOnlyTool(schema).getToolDescriptionJsonString() == schema) { "schema not passed through" }
  pass("H13", "the advertised schema is exposed but the callback only ever throws")
}

// --- Frame shape ---------------------------------------------------------

private fun checkFrameShape() {
  val script = Script()
  script.turns += modelTurn("The total is 125.")
  val subject = host(script)
  val raw = subject.begin(beginJson(tools = listOf("read_total")))
  val frame = JSONObject(raw)

  // These field names are the contract agentCore.parseFrame enforces.
  check(frame.getString("requestId") == "request-1") { "requestId missing" }
  check(frame.getString("text") == "The total is 125.") { "text missing" }
  check(frame.getJSONArray("calls").length() == 0) { "a final answer must carry no calls" }
  check(frame.keys().asSequence().toSet() == setOf("requestId", "text", "calls")) {
    "frame carries unexpected fields: ${frame.keys().asSequence().toList()}"
  }
  check(script.closedConversations == 1) { "a finished turn must close its conversation" }
  check(!subject.isBusy()) { "a finished turn must release admission" }
  pass("H14", "a final answer frame matches the agentCore contract and closes the session")

  val withCalls = Script()
  withCalls.turns += modelTurn(
    "",
    listOf(
      ToolCall("read_total", mapOf("from" to "2026-01-01", "nested" to mapOf("deep" to listOf(1, 2)))),
      ToolCall("read_total", mapOf("from" to "2026-02-01")),
    ),
  )
  val callFrame = JSONObject(host(withCalls).begin(beginJson(tools = listOf("read_total"))))
  val calls = callFrame.getJSONArray("calls")
  check(calls.length() == 2) { "both calls must survive" }
  val ids = (0 until calls.length()).map { calls.getJSONObject(it).getString("id") }
  check(ids.toSet().size == 2) { "call ids must be unique: $ids" }
  check(ids == listOf("1-0", "1-1")) { "positional ids keep repeated names matchable: $ids" }
  for (index in 0 until calls.length()) {
    val call = calls.getJSONObject(index)
    check(call.getString("name") == "read_total") { "name missing" }
    // parseFrame requires arguments to be a JSON object, always.
    check(call.get("arguments") is JSONObject) { "arguments must serialise as an object" }
  }
  val nested = calls.getJSONObject(0).getJSONObject("arguments").getJSONObject("nested")
  check(nested.getJSONArray("deep").getInt(1) == 2) { "nested arguments must survive conversion" }
  pass("H15", "repeated tool names keep distinct positional ids and nested arguments convert cleanly")

  val tooMany = Script()
  tooMany.turns += modelTurn("", (1..7).map { ToolCall("read_total", mapOf("i" to it)) })
  expectCode("H16", GemmaError.TOO_MANY_TOOL_CALLS, "seven tool calls in one turn") {
    host(tooMany).begin(beginJson(tools = listOf("read_total")))
  }

  val huge = Script()
  huge.turns += modelTurn("x".repeat(30_000))
  expectCode("H17", GemmaError.RESPONSE_TOO_LARGE, "oversized model output") {
    host(huge).begin(beginJson(tools = listOf("read_total")))
  }
}

// --- Resume ordering -----------------------------------------------------

private fun resultRow(callId: String, name: String, result: Any) =
  JSONObject().put("callId", callId).put("name", name).put("result", result)

private fun resumeJson(requestId: String, rows: List<JSONObject>): String {
  val array = JSONArray()
  rows.forEach { array.put(it) }
  return JSONObject().put("requestId", requestId).put("results", array).toString()
}

private fun startedTurn(script: Script): GemmaSessionHost {
  script.turns.add(0, modelTurn("", listOf(ToolCall("read_total", emptyMap()))))
  val subject = host(script)
  subject.begin(beginJson(tools = listOf("read_total")))
  return subject
}

private fun checkResumeOrdering() {
  run {
    val script = Script()
    script.turns += modelTurn("The total is 125.")
    val subject = startedTurn(script)
    val frame = JSONObject(
      subject.resume(resumeJson("request-1", listOf(resultRow("1-0", "read_total", JSONObject().put("total", 125))))),
    )
    check(frame.getString("text") == "The total is 125.") { "resume answer lost" }
    check(frame.getJSONArray("calls").length() == 0) { "resume should finish the turn" }
    pass("H18", "a matching tool result advances the turn to an answer")
  }

  expectCode("H19", GemmaError.BAD_REQUEST, "wrong callId") {
    val script = Script()
    script.turns += modelTurn("unused")
    startedTurn(script).resume(resumeJson("request-1", listOf(resultRow("9-9", "read_total", JSONObject()))))
  }
  expectCode("H20", GemmaError.BAD_REQUEST, "wrong tool name") {
    val script = Script()
    script.turns += modelTurn("unused")
    startedTurn(script).resume(resumeJson("request-1", listOf(resultRow("1-0", "read_other", JSONObject()))))
  }
  expectCode("H21", GemmaError.BAD_REQUEST, "too few results") {
    val script = Script()
    script.turns += modelTurn("unused")
    startedTurn(script).resume(resumeJson("request-1", emptyList()))
  }
  expectCode("H22", GemmaError.STALE_SESSION, "results for another request") {
    val script = Script()
    script.turns += modelTurn("unused")
    startedTurn(script).resume(resumeJson("request-2", listOf(resultRow("1-0", "read_total", JSONObject()))))
  }
  expectCode("H23", GemmaError.IDLE_EXPIRED, "resume with no live session") {
    host(Script()).resume(resumeJson("request-1", listOf(resultRow("1-0", "read_total", JSONObject()))))
  }

  run {
    // Two calls to the same tool: the answers must stay attached to the right
    // question, so order is enforced rather than matched by name.
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", mapOf("i" to 1)), ToolCall("read_total", mapOf("i" to 2))))
    script.turns += modelTurn("Both read.")
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    expectCode("H24", GemmaError.BAD_REQUEST, "repeated names supplied out of order") {
      subject.resume(
        resumeJson(
          "request-1",
          listOf(resultRow("1-1", "read_total", JSONObject()), resultRow("1-0", "read_total", JSONObject())),
        ),
      )
    }
  }

  run {
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", mapOf("i" to 1)), ToolCall("read_total", mapOf("i" to 2))))
    script.turns += modelTurn("Both read.")
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    val frame = JSONObject(
      subject.resume(
        resumeJson(
          "request-1",
          listOf(resultRow("1-0", "read_total", JSONObject().put("i", 1)), resultRow("1-1", "read_total", JSONObject().put("i", 2))),
        ),
      ),
    )
    check(frame.getString("text") == "Both read.") { "ordered results should be accepted" }
    pass("H25", "repeated tool names in the correct order are accepted")
  }
}

// --- Admission, tombstone, idle expiry -----------------------------------

private fun checkLifecycle() {
  run {
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", emptyMap())))
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    check(subject.isBusy()) { "a session awaiting tools is busy" }
    expectCode("H26", GemmaError.BUSY, "second begin while a session is live") {
      subject.begin(beginJson(requestId = "request-2", tools = listOf("read_total")))
    }
  }

  run {
    // Cancel arrives first; the queued begin must never start the engine.
    val script = Script()
    script.turns += modelTurn("should never run")
    val subject = host(script)
    subject.cancel("request-1")
    expectCode("H27", GemmaError.CANCELLED, "queued begin for a cancelled request") {
      subject.begin(beginJson(tools = listOf("read_total")))
    }
    check(script.openedEngines == 0) { "a cancelled request must not open an engine" }
    check(script.sent == 0) { "a cancelled request must not generate" }
  }

  run {
    // Cancel lands while the engine is initialising. The host must notice on
    // the way out of open() rather than after a full generation.
    val script = Script()
    script.turns += modelTurn("should never run")
    var subject: GemmaSessionHost? = null
    script.onOpen = { subject?.cancel("request-1") }
    subject = host(script)
    expectCode("H28", GemmaError.CANCELLED, "cancel during engine initialization") {
      subject.begin(beginJson(tools = listOf("read_total")))
    }
    check(script.sent == 0) { "generation ran despite a cancel during initialization" }
    check(script.closedEngines >= 1) { "the engine opened during a cancel must be closed" }
  }

  run {
    // A live generation is asked to stop through the SDK.
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", emptyMap())))
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    subject.cancel("request-1")
    check(script.cancelCount == 0) { "nothing is generating, so no SDK cancel is needed" }
    expectCode("H29", GemmaError.CANCELLED, "resume after cancel") {
      subject.resume(resumeJson("request-1", listOf(resultRow("1-0", "read_total", JSONObject()))))
    }
  }

  run {
    // An idle session waiting on JS tool work expires instead of pinning the
    // engine forever after a JS crash.
    var clock = 1_000L
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", emptyMap())))
    script.turns += modelTurn("fresh turn")
    val subject = host(script, clock = { clock }, idleMs = 10_000)
    subject.begin(beginJson(tools = listOf("read_total")))
    check(subject.isBusy()) { "session should be waiting" }
    clock += 11_000
    expectCode("H30", GemmaError.IDLE_EXPIRED, "resume after the idle window") {
      subject.resume(resumeJson("request-1", listOf(resultRow("1-0", "read_total", JSONObject()))))
    }
    check(!subject.isBusy()) { "an expired session must release admission" }
    check(script.closedConversations >= 1) { "an expired session must close its conversation" }
  }

  run {
    val script = Script()
    script.turns += modelTurn("done")
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    // finish() for a request that is not current must not tear down anything.
    val before = script.closedConversations
    subject.finish("request-99")
    check(script.closedConversations == before) { "finish on a stale id must be a no-op" }
    pass("H31", "finish on a non-current request id changes nothing")
  }

  run {
    val script = Script()
    script.turns += modelTurn("", listOf(ToolCall("read_total", emptyMap())))
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    subject.close()
    check(script.closedConversations >= 1 && script.closedEngines >= 1) { "close must release both" }
    check(!subject.isBusy()) { "close must release admission" }
    pass("H32", "close releases the conversation, the engine and admission")
  }

  run {
    val script = Script()
    script.failOpenWith = OutOfMemoryError("simulated")
    expectCode("H33", GemmaError.OUT_OF_MEMORY, "engine open runs out of memory") {
      host(script).begin(beginJson(tools = listOf("read_total")))
    }
    val unsupported = Script()
    unsupported.failOpenWith = IllegalStateException("no GPU delegate")
    expectCode("H34", GemmaError.UNSUPPORTED_BACKEND, "engine open fails for an unsupported backend") {
      host(unsupported).begin(beginJson(tools = listOf("read_total")))
    }
  }

  run {
    val script = Script()
    script.turns += modelTurn("first")
    script.turns += modelTurn("second")
    val subject = host(script)
    subject.begin(beginJson(tools = listOf("read_total")))
    // Same model and modality profile: the engine is reused rather than
    // reloaded, but a fresh conversation is created per turn.
    subject.begin(beginJson(requestId = "request-2", tools = listOf("read_total")))
    check(script.openedEngines == 1) { "the engine should be reused for the same profile" }
    check(script.closedConversations == 2) { "each turn needs its own conversation" }
    pass("H35", "a warm engine is reused across turns while conversation state is not")
  }
}

// --- Attachments ---------------------------------------------------------

private fun checkAttachments() {
  val approved = tempDir("approved")
  val work = tempDir("work")
  val source = File(approved, "receipt.jpg").apply { writeBytes(ByteArray(2048) { 7 }) }
  var clock = 1_000L
  val store = GemmaAttachmentStore(work, listOf(approved), now = { clock }, ttlMs = 10_000)

  val handle = store.stage(source.path, "image", "request-1")
  check(handle.matches(Regex("[0-9a-f]{48}"))) { "handle should be 24 random bytes in hex" }
  check(store.resolve(handle, "image", "request-1").isFile) { "a valid handle should resolve" }
  pass("A1", "a staged attachment resolves once for its own request and kind")

  expectFailure("A2", "the same handle used twice") { store.resolve(handle, "image", "request-1") }

  val second = store.stage(source.path, "image", "request-1")
  expectFailure("A3", "handle replayed by another request") { store.resolve(second, "image", "request-2") }
  expectFailure("A4", "handle used as the wrong kind") { store.resolve(second, "audio", "request-1") }
  expectFailure("A5", "unknown handle") { store.resolve("0".repeat(48), "image", "request-1") }
  expectFailure("A6", "unknown kind") { store.stage(source.path, "video", "request-1") }
  expectFailure("A7", "remote source") { store.stage("https://example.com/a.jpg", "image", "request-1") }
  expectFailure("A7b", "content uri") { store.stage("content://media/external/images/1", "image", "request-1") }
  expectFailure("A8", "traversal in the source path") {
    store.stage(File(approved, "../outside.jpg").path, "image", "request-1")
  }
  expectFailure("A9", "source outside the approved root") {
    val stray = File(tempDir("stray"), "x.jpg").apply { writeBytes(ByteArray(16)) }
    store.stage(stray.path, "image", "request-1")
  }
  expectFailure("A10", "empty source") {
    store.stage(File(approved, "empty.jpg").apply { createNewFile() }.path, "image", "request-1")
  }
  expectFailure("A11", "oversized source") {
    val big = File(approved, "big.wav").apply { writeBytes(ByteArray(9 * 1024 * 1024)) }
    store.stage(big.path, "audio", "request-1")
  }
  expectFailure("A12", "bad request id") { store.stage(source.path, "image", "req 1; rm -rf") }

  run {
    val third = store.stage(source.path, "image", "request-3")
    clock += 11_000
    expectFailure("A13", "handle used after its TTL") { store.resolve(third, "image", "request-3") }
  }

  run {
    val before = store.stagedCount()
    store.stage(source.path, "image", "request-4")
    store.stage(source.path, "audio", "request-4")
    check(store.stagedCount() == before + 2) { "staging should be counted" }
    check(store.release("request-4") == 2) { "release should drop both handles" }
    pass("A14", "release drops every handle staged for one request")
  }

  run {
    val sweeper = GemmaAttachmentStore(tempDir("sweep"), listOf(approved), now = { clock }, ttlMs = 1)
    sweeper.stage(source.path, "image", "request-5")
    clock += 100
    check(sweeper.sweepExpired() == 1) { "expired handles should be swept" }
    check(sweeper.stagedCount() == 0) { "sweep should leave nothing behind" }
    pass("A15", "expired handles are swept even when no request completed cleanly")
  }

  // A symlink escaping the approved root must be refused, not followed.
  val linkTarget = File(tempDir("secret"), "private.jpg").apply { writeBytes(ByteArray(64)) }
  val link = File(approved, "link.jpg")
  val created = runCatching {
    Files.createSymbolicLink(link.toPath(), linkTarget.toPath())
  }.isSuccess
  if (created) {
    expectFailure("A16", "symlink escaping the approved root") { store.stage(link.path, "image", "request-6") }
  } else {
    println("SKIP A16 -- this filesystem/account cannot create symlinks; rerun elevated to cover it.")
  }

  // The seam must actually be consulted, or "normalised" would mean nothing.
  var normalizerCalls = 0
  val counting = object : MediaNormalizer {
    override fun normalize(source: File, kind: AttachmentKind, destination: File): File {
      normalizerCalls += 1
      return PassThroughNormalizer().normalize(source, kind, destination)
    }
  }
  val counted = GemmaAttachmentStore(tempDir("normalize"), listOf(approved), counting, { clock }, 10_000)
  val normalizedHandle = counted.stage(source.path, "image", "request-7")
  check(normalizerCalls == 1) { "staging must run the media normalizer" }
  check(counted.resolve(normalizedHandle, "image", "request-7").isFile) { "normalized file missing" }
  expectFailure("A17a", "a normalizer that produces nothing") {
    val broken = object : MediaNormalizer {
      override fun normalize(source: File, kind: AttachmentKind, destination: File): File = destination
    }
    GemmaAttachmentStore(tempDir("broken"), listOf(approved), broken, { clock }, 10_000)
      .stage(source.path, "image", "request-8")
  }
  pass("A17", "staging runs the normalizer seam and refuses a normalizer that produced no file")
}

fun main() {
  println("P3 host contract check -- no JNI, no model, no device.")
  checkRequestValidation()
  checkAutomaticToolingRefused()
  checkFrameShape()
  checkResumeOrdering()
  checkLifecycle()
  checkAttachments()

  println()
  println("PASS: ${checks.size} host checks (${checks.joinToString(", ")}).")
  println("NOT TESTED: Android compilation, JNI inference, real Gemma weights, tool-template round-trip on device.")
}
