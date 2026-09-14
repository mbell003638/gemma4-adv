package ledgr.gemma.spike

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * P3 native manual-tool host.
 *
 * The whole point of this class is that the model gets to *ask* for a tool and
 * nothing more. Tool schemas are advertised, tool calls come back as typed SDK
 * objects, and the answers are supplied by TypeScript after it has decided the
 * call is allowed. Automatic tool calling stays off, and the only
 * `OpenApiTool.execute` in the process throws.
 *
 * Errors are typed codes, never prose. A user-facing message must not carry a
 * filesystem path, a signed URL, a prompt or a JNI stack trace, so the bridge
 * maps these codes to copy and logs the detail separately.
 */

/** Codes the bridge may translate; anything else becomes a generic failure. */
object GemmaError {
  const val BUSY = "GEMMA_BUSY"
  const val CANCELLED = "GEMMA_CANCELLED"
  const val STALE_SESSION = "GEMMA_STALE_SESSION"
  const val REQUEST_TOO_LARGE = "GEMMA_REQUEST_TOO_LARGE"
  const val RESPONSE_TOO_LARGE = "GEMMA_RESPONSE_TOO_LARGE"
  const val BAD_REQUEST = "GEMMA_BAD_REQUEST"
  const val STEP_LIMIT = "GEMMA_STEP_LIMIT"
  const val TOO_MANY_TOOL_CALLS = "GEMMA_TOO_MANY_TOOL_CALLS"
  const val ONE_MEDIA_KIND = "GEMMA_ONE_MEDIA_KIND_PER_TURN"
  const val TOOLS_NOT_ALLOWED = "GEMMA_TOOLS_NOT_ALLOWED_IN_THIS_MODE"
  const val MODEL_INTEGRITY = "GEMMA_MODEL_INTEGRITY"
  const val OUT_OF_MEMORY = "GEMMA_OUT_OF_MEMORY"
  const val UNSUPPORTED_BACKEND = "GEMMA_UNSUPPORTED_BACKEND"
  const val CONTEXT_FULL = "GEMMA_CONTEXT_FULL"
  const val IDLE_EXPIRED = "GEMMA_IDLE_EXPIRED"
  const val AUTOMATIC_TOOL_FORBIDDEN = "AUTOMATIC_TOOL_EXECUTION_FORBIDDEN"
}

class GemmaHostException(val code: String, cause: Throwable? = null) : RuntimeException(code, cause)

private fun fail(code: String): Nothing = throw GemmaHostException(code)

/**
 * A tool the model can see but never invoke.
 *
 * The SDK can be configured to call tools itself. If a future upgrade flips
 * that default, or a config is built wrong, this is the backstop: the callback
 * exists only to throw, so an accidental automatic call fails loudly instead of
 * quietly reaching a domain service.
 */
class SchemaOnlyTool(private val schema: String) : OpenApiTool {
  override fun getToolDescriptionJsonString(): String = schema
  override fun execute(paramsJsonString: String): String = fail(GemmaError.AUTOMATIC_TOOL_FORBIDDEN)
}

// --- Engine seam ---------------------------------------------------------

/**
 * The host talks to the runtime through these three interfaces rather than
 * touching `Engine` directly, so the lifecycle rules can be executed on a
 * desktop JVM where JNI is unavailable. `LiteRtEngineFactory` below is the real
 * implementation and is what compiles against the SDK.
 */
interface GemmaConversationHandle : AutoCloseable {
  fun send(contents: Contents): Message
  fun sendTool(message: Message): Message
  fun cancel()
}

interface GemmaEngineHandle : AutoCloseable {
  fun createConversation(config: ConversationConfig): GemmaConversationHandle
}

fun interface GemmaEngineFactory {
  /** Must return an INITIALIZED engine, or throw. */
  fun open(config: EngineConfig): GemmaEngineHandle
}

/** The real runtime. Constructing this needs the native library. */
class LiteRtEngineFactory : GemmaEngineFactory {
  override fun open(config: EngineConfig): GemmaEngineHandle {
    val engine = Engine(config)
    try {
      engine.initialize()
    } catch (error: Throwable) {
      engine.close()
      throw error
    }
    return object : GemmaEngineHandle {
      override fun createConversation(config: ConversationConfig): GemmaConversationHandle {
        val conversation: Conversation = engine.createConversation(config)
        return object : GemmaConversationHandle {
          override fun send(contents: Contents): Message = conversation.sendMessage(contents)
          override fun sendTool(message: Message): Message = conversation.sendMessage(message)
          override fun cancel() = conversation.cancelProcess()
          override fun close() = conversation.close()
        }
      }
      override fun close() = engine.close()
    }
  }
}

// --- JSON helpers --------------------------------------------------------

/** Recursively converts org.json values into plain Kotlin for ToolResponse. */
internal fun jsonValue(value: Any?): Any? = when (value) {
  null, JSONObject.NULL -> null
  is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
  is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
  else -> value
}

/**
 * Converts the SDK's tool-call argument map into JSON for the bridge.
 *
 * Written by hand rather than using `JSONObject(Map)` because Android ships its
 * own org.json and the Maven build used for desktop checks is a different
 * implementation; relying on their constructor behaviour matching for nested
 * maps would make the desktop check prove less than it appears to.
 */
internal fun toJson(value: Any?): Any = when (value) {
  null -> JSONObject.NULL
  is Map<*, *> -> JSONObject().also { target ->
    value.forEach { (key, entry) -> target.put(key.toString(), toJson(entry)) }
  }
  is Iterable<*> -> JSONArray().also { array -> value.forEach { array.put(toJson(it)) } }
  is Number, is Boolean, is String -> value
  else -> value.toString()
}

// --- Host ----------------------------------------------------------------

class GemmaSessionHost(
  private val resolveModel: (String) -> File,
  private val cacheRoot: File,
  private val resolveAttachment: (String, String) -> File,
  private val factory: GemmaEngineFactory,
  private val now: () -> Long = System::currentTimeMillis,
  private val idleTimeoutMs: Long = 15_000,
) : AutoCloseable {

  private var engine: GemmaEngineHandle? = null
  private var engineKey: String? = null
  private var conversation: GemmaConversationHandle? = null
  private var sessionId: String? = null
  private var expectedCalls: List<Pair<String, String>> = emptyList()
  private var round = 0
  private var waitingSince = 0L

  /**
   * Admission. One accepted request at a time, and a tombstone so a cancel
   * that arrives before a queued `begin` runs -- or during the seconds an
   * engine takes to initialize -- is observed instead of lost. Without the
   * tombstone, `cancel()` can only interrupt generation that has already
   * started, which is the gap the plan's draft called out.
   */
  private val lock = Any()
  private var accepted: String? = null
  private val cancelled = mutableSetOf<String>()
  private var running: Pair<String, GemmaConversationHandle>? = null

  /** Reserve the slot. Called on the control path before queueing work. */
  fun admit(requestId: String): Boolean = synchronized(lock) {
    requireId(requestId)
    if (accepted != null) return false
    accepted = requestId
    cancelled.remove(requestId)
    true
  }

  private fun requireId(requestId: String) {
    if (!requestId.matches(Regex("[A-Za-z0-9_-]{1,80}"))) fail(GemmaError.BAD_REQUEST)
  }

  private fun checkCancelled(requestId: String) {
    synchronized(lock) { if (cancelled.contains(requestId)) fail(GemmaError.CANCELLED) }
  }

  private fun closeConversation() {
    runCatching { conversation?.close() }
    conversation = null
    sessionId = null
    expectedCalls = emptyList()
    waitingSince = 0L
    synchronized(lock) {
      running = null
      accepted = null
    }
  }

  /**
   * A session left waiting for JS tool data cannot be allowed to pin a native
   * conversation forever: if the JS side crashes or is killed mid-turn, the
   * next request would be refused as busy with nothing actually running.
   */
  private fun expireIdleSession() {
    if (sessionId != null && waitingSince > 0L && now() - waitingSince > idleTimeoutMs) {
      closeConversation()
    }
  }

  fun begin(raw: String): String {
    expireIdleSession()
    if (raw.length > 40_000) fail(GemmaError.REQUEST_TOO_LARGE)

    val query = runCatching { JSONObject(raw) }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    val requestId = runCatching { query.getString("requestId") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    requireId(requestId)

    synchronized(lock) {
      // A queued begin for a request already cancelled must never start.
      if (cancelled.contains(requestId)) fail(GemmaError.CANCELLED)
      if (accepted != null && accepted != requestId) fail(GemmaError.BUSY)
      if (sessionId != null) fail(GemmaError.BUSY)
      accepted = requestId
    }

    val modelId = runCatching { query.getString("modelId") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    val mode = runCatching { query.getString("mode") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    if (mode !in listOf("agent", "extract", "transcribe")) fail(GemmaError.BAD_REQUEST)

    val hasImage = query.has("imageHandle")
    val hasAudio = query.has("audioHandle")
    // One encoder per turn: mixing them has not been validated on any device
    // profile, and a silent choice between them would be worse than refusing.
    if (hasImage && hasAudio) fail(GemmaError.ONE_MEDIA_KIND)

    val definitions = if (query.has("tools")) {
      runCatching { query.getJSONArray("tools") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    } else {
      JSONArray()
    }
    if (definitions.length() > 8) fail(GemmaError.BAD_REQUEST)
    // Extraction and transcription see a document or a recording, which is
    // untrusted text. Nothing in those modes may hold a tool.
    if (mode != "agent" && definitions.length() != 0) fail(GemmaError.TOOLS_NOT_ALLOWED)

    val system = runCatching { query.getString("system") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    val input = runCatching { query.getString("input") }.getOrElse { fail(GemmaError.BAD_REQUEST) }

    val modelFile = runCatching { resolveModel(modelId) }
      .getOrElse { throw GemmaHostException(GemmaError.MODEL_INTEGRITY, it) }

    checkCancelled(requestId)

    // The backend profile is compiled, tested policy. It is deliberately not
    // something a request can choose.
    val key = "$modelId:$hasImage:$hasAudio"
    if (engineKey != key) {
      runCatching { engine?.close() }
      engine = null
      engineKey = null
      val config = EngineConfig(
        modelPath = modelFile.absolutePath,
        backend = Backend.CPU(),
        visionBackend = if (hasImage) Backend.GPU() else null,
        audioBackend = if (hasAudio) Backend.CPU() else null,
        maxNumTokens = 4096,
        maxNumImages = if (hasImage) 1 else null,
        cacheDir = File(cacheRoot, modelId).apply { mkdirs() }.absolutePath,
      )
      val opened = try {
        factory.open(config)
      } catch (error: OutOfMemoryError) {
        closeConversation()
        throw GemmaHostException(GemmaError.OUT_OF_MEMORY, error)
      } catch (error: GemmaHostException) {
        closeConversation()
        throw error
      } catch (error: Throwable) {
        closeConversation()
        throw GemmaHostException(GemmaError.UNSUPPORTED_BACKEND, error)
      }
      // Initialization can take seconds. A cancel that arrived while it ran is
      // honoured here rather than being discovered after a full generation.
      if (synchronized(lock) { cancelled.contains(requestId) }) {
        runCatching { opened.close() }
        closeConversation()
        fail(GemmaError.CANCELLED)
      }
      engine = opened
      engineKey = key
    }

    val tools = (0 until definitions.length()).map { index ->
      tool(SchemaOnlyTool(definitions.getJSONObject(index).toString()))
    }
    val handle = checkNotNull(engine)
    val conv = try {
      handle.createConversation(
        ConversationConfig(
          systemInstruction = Contents.of(system),
          tools = tools,
          automaticToolCalling = false,
          samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0),
          maxOutputToken = 768,
        ),
      )
    } catch (error: Throwable) {
      closeConversation()
      throw GemmaHostException(GemmaError.UNSUPPORTED_BACKEND, error)
    }

    conversation = conv
    sessionId = requestId
    round = 0

    return try {
      val parts = mutableListOf<Content>(Content.Text(input))
      if (hasImage) {
        parts.add(Content.ImageFile(resolveAttachment(query.getString("imageHandle"), "image").absolutePath))
      }
      if (hasAudio) {
        parts.add(Content.AudioFile(resolveAttachment(query.getString("audioHandle"), "audio").absolutePath))
      }
      synchronized(lock) { running = requestId to conv }
      checkCancelled(requestId)
      frame(conv.send(Contents.of(parts)))
    } catch (error: GemmaHostException) {
      closeConversation()
      throw error
    } catch (error: OutOfMemoryError) {
      closeConversation()
      throw GemmaHostException(GemmaError.OUT_OF_MEMORY, error)
    } catch (error: Throwable) {
      closeConversation()
      throw GemmaHostException(GemmaError.CONTEXT_FULL, error)
    } finally {
      synchronized(lock) { running = null }
    }
  }

  fun resume(raw: String): String {
    expireIdleSession()
    if (raw.length > 20_000) fail(GemmaError.REQUEST_TOO_LARGE)

    val query = runCatching { JSONObject(raw) }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    val requestId = runCatching { query.getString("requestId") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    if (sessionId == null) fail(GemmaError.IDLE_EXPIRED)
    if (requestId != sessionId) fail(GemmaError.STALE_SESSION)
    checkCancelled(requestId)

    val responses = runCatching { query.getJSONArray("results") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
    // Order and cardinality must match what the model asked for. A reply that
    // is one short, or reordered, would attach a figure to the wrong question.
    if (expectedCalls.isEmpty() || responses.length() != expectedCalls.size) fail(GemmaError.BAD_REQUEST)

    val parts = expectedCalls.mapIndexed { index, expected ->
      val row = runCatching { responses.getJSONObject(index) }.getOrElse { fail(GemmaError.BAD_REQUEST) }
      val callId = runCatching { row.getString("callId") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
      val name = runCatching { row.getString("name") }.getOrElse { fail(GemmaError.BAD_REQUEST) }
      if (callId != expected.first || name != expected.second) fail(GemmaError.BAD_REQUEST)
      Content.ToolResponse(expected.second, jsonValue(row.opt("result")))
    }

    val conv = conversation ?: fail(GemmaError.IDLE_EXPIRED)
    return try {
      synchronized(lock) { running = requestId to conv }
      waitingSince = 0L
      frame(conv.sendTool(Message.tool(Contents.of(parts))))
    } catch (error: GemmaHostException) {
      closeConversation()
      throw error
    } catch (error: OutOfMemoryError) {
      closeConversation()
      throw GemmaHostException(GemmaError.OUT_OF_MEMORY, error)
    } catch (error: Throwable) {
      closeConversation()
      throw GemmaHostException(GemmaError.CONTEXT_FULL, error)
    } finally {
      synchronized(lock) { running = null }
    }
  }

  /**
   * Renders one model turn for the bridge.
   *
   * Bridge-side call ids are generated here because the SDK identifies a call
   * only by name and arguments. Two calls to the same tool in one turn are
   * legitimate, so positional ids keep the eventual answers matchable.
   */
  private fun frame(message: Message): String {
    val requestId = sessionId ?: fail(GemmaError.STALE_SESSION)
    round += 1
    if (round > 5) {
      closeConversation()
      fail(GemmaError.STEP_LIMIT)
    }
    if (message.toolCalls.size > 6) {
      closeConversation()
      fail(GemmaError.TOO_MANY_TOOL_CALLS)
    }

    expectedCalls = message.toolCalls.mapIndexed { index, call -> "$round-$index" to call.name }
    val calls = JSONArray()
    message.toolCalls.forEachIndexed { index, call ->
      calls.put(
        JSONObject()
          .put("id", expectedCalls[index].first)
          .put("name", call.name)
          .put("arguments", toJson(call.arguments)),
      )
    }

    val text = message.contents.contents
      .filterIsInstance<Content.Text>()
      .joinToString("") { it.text }

    val payload = JSONObject()
      .put("requestId", requestId)
      .put("text", text)
      .put("calls", calls)
      .toString()

    if (payload.length > 24_000) {
      closeConversation()
      fail(GemmaError.RESPONSE_TOO_LARGE)
    }

    if (calls.length() == 0) {
      // The turn is finished, including any turn that produced a mutation
      // proposal: the session must not stay alive across a user review.
      closeConversation()
    } else {
      waitingSince = now()
    }
    return payload
  }

  /**
   * Control path only. Marks the tombstone and asks a live generation to stop;
   * it never frees an engine, because doing so while JNI is generating is a
   * crash rather than a cancellation.
   */
  fun cancel(requestId: String) {
    val live = synchronized(lock) {
      cancelled.add(requestId)
      running?.takeIf { it.first == requestId }
    }
    runCatching { live?.second?.cancel() }
  }

  /** Inference path only. Also closes a session idling on JS tool work. */
  fun finish(requestId: String) {
    if (sessionId == requestId) {
      closeConversation()
    } else {
      synchronized(lock) {
        cancelled.remove(requestId)
        if (accepted == requestId) accepted = null
      }
    }
  }

  fun isBusy(): Boolean = synchronized(lock) { accepted != null || sessionId != null }

  override fun close() {
    closeConversation()
    runCatching { engine?.close() }
    engine = null
    engineKey = null
    synchronized(lock) { cancelled.clear() }
  }
}
