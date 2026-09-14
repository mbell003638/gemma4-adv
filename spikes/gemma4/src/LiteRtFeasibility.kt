package ledgr.gemma.spike

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.tool
import java.io.File
import java.security.MessageDigest

/** P1 only. No Ledgr API, SQLite, credentials, network, or automatic execution. */
class FixtureBalanceTool : OpenApiTool {
  override fun getToolDescriptionJsonString(): String = """
    {"name":"read_fixture_balance","description":"Read the test fixture balance; no parameters.",
    "parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false}}
  """.trimIndent()
  override fun execute(paramsJsonString: String): String =
    error("Automatic tool execution must remain disabled")
}

object LiteRtFeasibility {
  enum class Mode { TEXT, IMAGE, AUDIO, TOOLS }
  data class Model(val id: String, val bytes: Long, val sha256: String)
  val models = mapOf(
    "gemma4-e2b" to Model("gemma4-e2b", 2588147712,
      "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c"),
    "gemma4-e4b" to Model("gemma4-e4b", 3659530240,
      "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0"),
  )
  fun config(mode: Mode): ConversationConfig = ConversationConfig(
    systemInstruction = Contents.of("You are running a local integration test. Do not invent test data."),
    tools = if (mode == Mode.TOOLS) listOf(tool(FixtureBalanceTool())) else emptyList(),
    automaticToolCalling = false,
    samplerConfig = SamplerConfig(topK = 1, topP = 1.0, temperature = 0.0),
    maxOutputToken = 256,
  )
  fun verifyModel(file: File, id: String) {
    val expected = models[id] ?: error("Unknown approved test model")
    require(file.isFile && file.length() == expected.bytes) { "Model size mismatch" }
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(128 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        hash.update(buffer, 0, count)
      }
    }
    require(hash.digest().joinToString("") { "%02x".format(it) } == expected.sha256) {
      "Model checksum mismatch"
    }
  }
  private fun text(message: Message): String = message.contents.contents
    .filterIsInstance<Content.Text>().joinToString("") { it.text }.trim()

  /** Android worker thread only, with owner-supplied verified local fixtures. */
  fun run(model: File, modelId: String, cache: File, mode: Mode, fixture: File? = null): String {
    verifyModel(model, modelId)
    if (mode == Mode.IMAGE || mode == Mode.AUDIO) {
      require(fixture?.isFile == true && fixture.length() in 1..(8L * 1024 * 1024)) {
        "A bounded, prepared local fixture is required"
      }
    }
    require(cache.exists() || cache.mkdirs())
    val native = Engine(EngineConfig(
      modelPath = model.absolutePath, backend = Backend.CPU(),
      visionBackend = if (mode == Mode.IMAGE) Backend.GPU() else null,
      audioBackend = if (mode == Mode.AUDIO) Backend.CPU() else null,
      maxNumTokens = 4096, maxNumImages = 1, cacheDir = cache.absolutePath,
    ))
    native.use { engine ->
      engine.initialize()
      engine.createConversation(config(mode)).use { conversation ->
        val contents = when (mode) {
          Mode.TEXT -> Contents.of("Reply with the word READY.")
          Mode.IMAGE -> Contents.of(Content.ImageFile(checkNotNull(fixture).absolutePath),
            Content.Text("Transcribe the visible total exactly; do not guess."))
          Mode.AUDIO -> Contents.of(Content.AudioFile(checkNotNull(fixture).absolutePath),
            Content.Text("Transcribe exactly, preserving names and amounts."))
          Mode.TOOLS -> Contents.of("Use read_fixture_balance and tell me its currency and balance.")
        }
        val first = conversation.sendMessage(contents)
        if (mode != Mode.TOOLS) {
          check(first.toolCalls.isEmpty()) { "Tool call in a tool-free modality test" }
          return text(first).also { check(it.isNotBlank()) { "Empty model output" } }
        }
        val calls = first.toolCalls
        check(calls.size == 1 && calls[0].name == "read_fixture_balance" && calls[0].arguments.isEmpty()) {
          "Model did not produce the expected manual tool request"
        }
        val result = conversation.sendMessage(Message.tool(Contents.of(
          Content.ToolResponse("read_fixture_balance", mapOf("currency" to "INR", "balance" to 137.25)),
        )))
        check(result.toolCalls.isEmpty()) { "Unexpected further tool request" }
        return text(result).also {
          check(it.contains("137.25") && it.contains("INR", ignoreCase = true)) {
            "Final response did not preserve the supplied fixture result"
          }
        }
      }
    }
  }
}
