package ledgr.gemma.spike

import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Message
import java.io.File

/** No JNI/model initialization: this is not an Android/device pass. */
fun main() {
  for (mode in LiteRtFeasibility.Mode.entries) {
    val config = LiteRtFeasibility.config(mode)
    check(!config.automaticToolCalling)
    check(config.maxOutputToken == 256)
    check(config.tools.size == if (mode == LiteRtFeasibility.Mode.TOOLS) 1 else 0)
  }
  check(runCatching { FixtureBalanceTool().execute("{}") }.isFailure)
  check(runCatching { LiteRtFeasibility.verifyModel(File("does-not-exist.litertlm"), "gemma4-e2b") }.isFailure)
  check(runCatching { LiteRtFeasibility.verifyModel(File("does-not-exist.litertlm"), "unknown") }.isFailure)
  val response = Message.tool(Contents.of(Content.ToolResponse("read_fixture_balance", mapOf("balance" to 137.25))))
  check(response.contents.contents.single() is Content.ToolResponse)
  println("PASS: SDK config, tool-message API, callback denial and model guards (no inference).")
}
