package expo.modules.ledgrnativeai

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manual tool-calling host for the optional Gemma runtime.
 *
 * The division of responsibility matters more than any single line here:
 * native code owns inference, TypeScript owns tool policy, and the domain
 * services own accounting. This class therefore never executes a tool. It
 * reports what the model asked for and waits to be handed results.
 *
 * Every tool reaches the SDK as a description with no body. If the SDK ever
 * decided to invoke one directly -- an upgrade flipping a default, a bug, a
 * config we misread -- the call throws instead of reaching a domain service.
 * `automaticToolCalling = false` is the intended protection; this is the one
 * that holds when the intended protection is wrong.
 */
internal class SchemaOnlyTool(private val schema: String) : OpenApiTool {
  override fun getToolDescriptionJsonString(): String = schema

  override fun execute(paramsJsonString: String): String =
    error("AUTOMATIC_TOOL_EXECUTION_FORBIDDEN")
}

/**
 * Converts parsed JSON into the plain Kotlin values the SDK's `ToolResponse`
 * accepts, so a tool result crosses the boundary as data rather than as a
 * string the model has to re-parse.
 */
private fun jsonValue(value: Any?): Any? = when (value) {
  null, JSONObject.NULL -> null
  is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
  is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
  else -> value
}

/**
 * Converts the SDK's tool-call arguments back into JSON for the bridge.
 *
 * `ToolCall.arguments` is a `Map<String, Any?>`, not a JSON string -- verified
 * with javap against litertlm-android 0.17.0, and different from what the
 * handoff draft assumed. Nested containers are rebuilt explicitly rather than
 * relying on JSONObject's reflective handling of arbitrary values, because a
 * silently stringified map would reach the JS schema validator as a type it
 * always rejects.
 */
private fun argumentsToJson(arguments: Map<String, Any?>): JSONObject {
  val out = JSONObject()
  for ((key, value) in arguments) out.put(key, kotlinToJson(value))
  return out
}

private fun kotlinToJson(value: Any?): Any = when (value) {
  null -> JSONObject.NULL
  is Map<*, *> -> JSONObject().also { out ->
    for ((k, v) in value) out.put(k?.toString() ?: continue, kotlinToJson(v))
  }
  is Iterable<*> -> JSONArray().also { out -> for (item in value) out.put(kotlinToJson(item)) }
  is Number, is Boolean, is String -> value
  else -> value.toString()
}

/**
 * Owns one Gemma engine and at most one live conversation.
 *
 * Single-threaded by contract: `begin`, `resume` and `finish` run on the
 * module's inference executor. Only `cancel` is called from elsewhere, and it
 * touches nothing but the two atomics -- freeing a live JNI object from a
 * second thread is the failure mode this arrangement exists to prevent.
 */
class GemmaSessionHost(
  private val store: GemmaPackStore,
  private val cacheRoot: File,
  private val engineFactory: GemmaEngineFactory = LiteRtGemmaEngineFactory(),
  private val resolveAttachment: (handle: String, kind: String, requestId: String) -> File,
) : AutoCloseable {
  private var engine: GemmaEngineHandle? = null
  private var engineKey: String? = null
  private var conversation: GemmaConversationHandle? = null
  private var sessionId: String? = null
  private var expectedCalls: List<Pair<String, String>> = emptyList()
  private var round = 0
  private var lastActivityAt = 0L
  private var closed = false

  /** Set only while `sendMessage` is in flight, so cancel can interrupt it. */
  private val running = AtomicReference<Pair<String, GemmaConversationHandle>?>(null)
  private val cancellationLock = Any()

  /**
   * Cancellation tombstone.
   *
   * `Conversation.cancelProcess()` can only interrupt generation that has
   * already started. Engine initialization on a multi-gigabyte model takes
   * long enough that a user very reasonably cancels during it, and a request
   * cancelled before its queued `begin` runs must never start at all. Both
   * cases are covered by marking the id here and checking the mark at each
   * point where work is about to become expensive or observable.
   */
  private val cancelled = AtomicReference<String?>(null)

  fun requestCancel(requestId: String) {
    cancelled.set(requestId)
    synchronized(cancellationLock) {
      running.get()?.let { if (it.first == requestId) it.second.cancelProcess() }
    }
  }

  private fun checkCancelled(requestId: String) {
    if (cancelled.get() == requestId) {
      closeConversation()
      throw GemmaSessionException("GEMMA_CANCELLED")
    }
  }

  /** The id currently holding the session, for an honest status report. */
  fun activeRequestId(): String? = sessionId

  fun isEngineLoaded(): Boolean = engine != null

  fun loadedModelId(): String? = engineKey?.substringBefore(':')

  private fun closeConversation() {
    synchronized(cancellationLock) {
      // Detach before close; a concurrent cancellation must never call freed JNI.
      running.set(null)
      try {
        conversation?.close()
      } catch (_: Throwable) {
        throw GemmaSessionException("NATIVE_RECOVERY_REQUIRED")
      }
    }
    conversation = null
    sessionId = null
    expectedCalls = emptyList()
    round = 0
    lastActivityAt = 0L
  }

  /**
   * Drops a session that has been waiting for JS tool results too long.
   *
   * An idle session pins an engine and a KV cache, so it is not left alive on
   * the chance that the app comes back. Called from the inference executor, so
   * it can never race a `sendMessage`.
   */
  fun expireIdleSession(nowMs: Long, idleLimitMs: Long): String? {
    val id = sessionId ?: return null
    if (expectedCalls.isEmpty()) return null
    if (running.get() != null) return null
    if (nowMs - lastActivityAt < idleLimitMs) return null
    closeConversation()
    return id
  }

  fun begin(raw: String): String {
    check(!closed) { "GEMMA_SHUTDOWN" }
    check(sessionId == null) { "GEMMA_BUSY" }
    require(raw.length <= MAX_REQUEST_CHARS) { "REQUEST_TOO_LARGE" }

    val query = JSONObject(raw)
    val id = query.getString("requestId")
    require(id.matches(REQUEST_ID)) { "INVALID_REQUEST_ID" }
    checkCancelled(id)

    val modelId = query.getString("modelId")
    val mode = query.getString("mode")
    require(mode in MODES) { "INVALID_MODE" }

    val hasImage = query.has("imageHandle")
    val hasAudio = query.has("audioHandle")
    // One media kind per turn: mixing them multiplies the prefill cost and the
    // combination is not something the device profile has been measured on.
    require(!(hasImage && hasAudio)) { "ONE_MEDIA_KIND_PER_TURN" }

    val definitions = query.getJSONArray("tools")
    require(definitions.length() <= MAX_TOOLS) { "TOO_MANY_TOOLS" }
    // Extraction and transcription turns advertise nothing, so a document or a
    // recording that asks for an action has no tool to reach for.
    require(mode == "agent" || definitions.length() == 0) { "TOOLS_NOT_ALLOWED_IN_THIS_MODE" }

    // The backend profile is compiled and tested policy. It is deliberately
    // not a field in the request: prompt-adjacent data must not be able to
    // select a code path the device was never measured on.
    val key = "$modelId:$hasImage:$hasAudio"
    if (engineKey != key) {
      engine?.let { previous ->
        try { previous.close() } catch (_: Throwable) { throw GemmaSessionException("NATIVE_RECOVERY_REQUIRED") }
        engine = null
        engineKey = null
      }
      val modelFile = store.verifiedFile(modelId)
      checkCancelled(id)
      val candidate = engineFactory.create(
        EngineConfig(
          modelPath = modelFile.absolutePath,
          backend = Backend.CPU(),
          visionBackend = if (hasImage) Backend.GPU() else null,
          audioBackend = if (hasAudio) Backend.CPU() else null,
          maxNumTokens = MAX_CONTEXT_TOKENS,
          maxNumImages = 1,
          cacheDir = File(cacheRoot, modelId).apply { mkdirs() }.absolutePath,
        ),
      )
      try {
        candidate.initialize()
      } catch (error: Throwable) {
        try { candidate.close() } catch (_: Throwable) { throw GemmaSessionException("NATIVE_RECOVERY_REQUIRED") }
        throw error
      }
      // Initialization can take long enough that the user gave up during it.
      // Check before generating, and release the weights we just loaded.
      if (cancelled.get() == id) {
        try { candidate.close() } catch (_: Throwable) { throw GemmaSessionException("NATIVE_RECOVERY_REQUIRED") }
        throw GemmaSessionException("GEMMA_CANCELLED")
      }
      engine = candidate
      engineKey = key
    }

    val tools = (0 until definitions.length()).map {
      tool(SchemaOnlyTool(definitions.getJSONObject(it).toString()))
    }
    val conv = checkNotNull(engine).createConversation(
      ConversationConfig(
        systemInstruction = Contents.of(query.getString("system")),
        tools = tools,
        automaticToolCalling = false,
        samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0),
        maxOutputToken = MAX_OUTPUT_TOKENS,
      ),
    )
    // Belt and braces: the SDK reports what it was actually configured with, so
    // assert it rather than trusting that our config survived construction.
    // Take ownership before checking SDK configuration, so failure closes it.
    conversation = conv
    sessionId = id
    round = 0

    return try {
      check(!conv.automaticToolCalling) { "AUTOMATIC_TOOL_CALLING_ENABLED" }
      val parts = mutableListOf<Content>(Content.Text(query.getString("input")))
      if (hasImage) {
        parts.add(Content.ImageFile(resolveAttachment(query.getString("imageHandle"), "image", id).absolutePath))
      }
      if (hasAudio) {
        parts.add(Content.AudioFile(resolveAttachment(query.getString("audioHandle"), "audio", id).absolutePath))
      }
      checkCancelled(id)
      running.set(id to conv)
      val message = conv.sendMessage(Contents.of(parts))
      checkCancelled(id)
      frame(message).also { checkCancelled(id) }
    } catch (error: Throwable) {
      closeConversation()
      throw error
    } finally {
      running.set(null)
    }
  }

  fun resume(raw: String): String {
    check(!closed) { "GEMMA_SHUTDOWN" }
    require(raw.length <= MAX_RESUME_CHARS) { "REQUEST_TOO_LARGE" }

    val query = JSONObject(raw)
    val id = query.getString("requestId")
    // A late reply from an abandoned turn must not be spliced into the live
    // one, so the session id has to match exactly.
    check(id == sessionId) { "STALE_SESSION" }
    checkCancelled(id)

    val responses = query.getJSONArray("results")
    check(expectedCalls.isNotEmpty()) { "NO_TOOL_CALL_PENDING" }
    check(responses.length() == expectedCalls.size) { "TOOL_RESULT_COUNT_MISMATCH" }

    // Order and cardinality are preserved positionally. The model may request
    // the same tool more than once in one turn, so pairing by name alone would
    // quietly swap two results and answer from the wrong one.
    val parts = expectedCalls.mapIndexed { index, expected ->
      val row = responses.getJSONObject(index)
      check(row.getString("callId") == expected.first) { "TOOL_RESULT_ID_MISMATCH" }
      check(row.getString("name") == expected.second) { "TOOL_RESULT_NAME_MISMATCH" }
      Content.ToolResponse(expected.second, jsonValue(row.get("result")))
    }

    val conv = checkNotNull(conversation) { "NO_LIVE_CONVERSATION" }
    return try {
      running.set(id to conv)
      val message = conv.sendMessage(Message.tool(Contents.of(parts)))
      checkCancelled(id)
      frame(message).also { checkCancelled(id) }
    } catch (error: Throwable) {
      closeConversation()
      throw error
    } finally {
      running.set(null)
    }
  }

  /**
   * Renders one model turn for the bridge.
   *
   * Call ids are generated here because the SDK identifies a call only by name
   * and arguments. They are what lets the JS side match results back to
   * requests without guessing, and they are round-scoped so a result from an
   * earlier round cannot satisfy a later one.
   */
  private fun frame(message: Message): String {
    val request = checkNotNull(sessionId)
    round += 1
    check(round <= MAX_ROUNDS) { "STEP_LIMIT" }
    check(message.toolCalls.size <= MAX_TOOL_CALLS) { "TOO_MANY_TOOL_CALLS" }

    expectedCalls = message.toolCalls.mapIndexed { index, call -> "$round-$index" to call.name }
    val calls = JSONArray()
    message.toolCalls.forEachIndexed { index, call ->
      calls.put(
        JSONObject()
          .put("id", expectedCalls[index].first)
          .put("name", call.name)
          .put("arguments", argumentsToJson(call.arguments)),
      )
    }

    // Hidden reasoning is not evidence and is not shown or logged; only the
    // text the model actually addressed to the user crosses the bridge.
    val text = message.contents.contents
      .filterIsInstance<Content.Text>()
      .joinToString("") { it.text }

    val result = JSONObject()
      .put("requestId", request)
      .put("text", text)
      .put("calls", calls)
      .toString()
    check(result.length <= MAX_RESPONSE_CHARS) { "RESPONSE_TOO_LARGE" }

    lastActivityAt = System.currentTimeMillis()
    // A turn that asked for nothing is over. A turn that produced a mutation
    // proposal is also over: the session is not left alive across user review.
    if (calls.length() == 0) closeConversation()
    return result
  }

  /** Inference executor only. Also closes a session idling on JS tool work. */
  fun finish(requestId: String) {
    if (sessionId == requestId) closeConversation()
    cancelled.compareAndSet(requestId, null)
  }

  /**
   * Drops the engine after a failure that makes the weights untrustworthy.
   *
   * Ordinary input validation errors deliberately do not come here: rejecting a
   * malformed argument is no reason to spend twenty seconds reloading a model
   * that is working fine.
   */
  fun unloadEngine() {
    closeConversation()
    engine?.let { previous ->
      try { previous.close() } catch (_: Throwable) { throw GemmaSessionException("NATIVE_RECOVERY_REQUIRED") }
      engine = null
      engineKey = null
    }
  }

  override fun close() {
    closed = true
    unloadEngine()
  }

  companion object {
    private val REQUEST_ID = Regex("[A-Za-z0-9_-]{1,80}")
    private val MODES = setOf("agent", "extract", "transcribe")

    const val BRIDGE_VERSION = 3
    const val MAX_TOOLS = 8
    const val MAX_ROUNDS = 5
    const val MAX_TOOL_CALLS = 6
    const val MAX_CONTEXT_TOKENS = 4096
    const val MAX_OUTPUT_TOKENS = 768
    const val MAX_REQUEST_CHARS = 40_000
    const val MAX_RESUME_CHARS = 20_000
    const val MAX_RESPONSE_CHARS = 24_000
    const val IDLE_SESSION_MS = 15_000L
    const val TURN_DEADLINE_MS = 60_000L
  }
}

/** Carries a stable code so the bridge can map it without matching prose. */
class GemmaSessionException(val code: String) : IllegalStateException(code)
