package expo.modules.ledgrnativeai

import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message

/** Injectable runtime only; tests use real SDK message/configuration types. */
interface GemmaConversationHandle : AutoCloseable {
  val automaticToolCalling: Boolean
  fun sendMessage(contents: Contents): Message
  fun sendMessage(message: Message): Message
  fun cancelProcess()
}

interface GemmaEngineHandle : AutoCloseable {
  fun initialize()
  fun createConversation(config: ConversationConfig): GemmaConversationHandle
}

fun interface GemmaEngineFactory {
  fun create(config: EngineConfig): GemmaEngineHandle
}

class LiteRtGemmaEngineFactory : GemmaEngineFactory {
  override fun create(config: EngineConfig): GemmaEngineHandle {
    val engine = Engine(config)
    return object : GemmaEngineHandle {
      override fun initialize() = engine.initialize()
      override fun createConversation(config: ConversationConfig): GemmaConversationHandle {
        val conversation = engine.createConversation(config)
        return object : GemmaConversationHandle {
          override val automaticToolCalling: Boolean get() = conversation.automaticToolCalling
          override fun sendMessage(contents: Contents): Message = conversation.sendMessage(contents)
          override fun sendMessage(message: Message): Message = conversation.sendMessage(message)
          override fun cancelProcess() = conversation.cancelProcess()
          override fun close() = conversation.close()
        }
      }
      override fun close() = engine.close()
    }
  }
}
