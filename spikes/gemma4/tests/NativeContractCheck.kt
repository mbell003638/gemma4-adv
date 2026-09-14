package ledgr.gemma.spike

import expo.modules.ledgrnativeai.GemmaAttachmentStore
import expo.modules.ledgrnativeai.GemmaCatalogAsset
import expo.modules.ledgrnativeai.GemmaPackException
import expo.modules.ledgrnativeai.GemmaPackSpec
import expo.modules.ledgrnativeai.GemmaPackState
import expo.modules.ledgrnativeai.GemmaPackStore
import expo.modules.ledgrnativeai.GemmaSessionHost
import expo.modules.ledgrnativeai.SchemaOnlyTool
import java.io.File
import java.nio.file.Files

/**
 * Host-side contract checks for the P2/P3 native code.
 *
 * These run on a JVM with no Android, no JNI and no model. They cover the
 * guards that are pure logic: catalogue validation, path confinement, handle
 * binding, request validation and the automatic-tool-execution refusal. They
 * are NOT a device test and prove nothing about inference.
 */

private const val E2B_SHA = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c"
private const val E2B_REV = "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1"

private fun approvedSpec(): GemmaPackSpec = GemmaPackSpec(
  id = "gemma4-e2b",
  filename = "gemma4-e2b-181938105e0eefd1.litertlm",
  url = "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/$E2B_REV/gemma-4-E2B-it.litertlm",
  bytes = 2588147712L,
  sha256 = E2B_SHA,
  revision = E2B_REV,
)

private fun tempDir(prefix: String): File =
  Files.createTempDirectory(prefix).toFile().also { it.deleteOnExit() }

private fun failsWith(expected: String, work: () -> Unit): Boolean {
  return try {
    work()
    false
  } catch (error: Throwable) {
    val code = (error as? GemmaPackException)?.code ?: error.message.orEmpty()
    code.contains(expected)
  }
}

private fun checkPackStoreValidation() {
  val root = tempDir("packs")
  val good = approvedSpec()
  // A valid catalogue constructs.
  GemmaPackStore(root, listOf(good))

  check(failsWith("EMPTY_PACK_CATALOG") { GemmaPackStore(root, emptyList()) })
  check(failsWith("DUPLICATE_PACK_ID") { GemmaPackStore(root, listOf(good, good)) })
  check(failsWith("INVALID_PACK_HASH") { GemmaPackStore(root, listOf(good.copy(sha256 = "deadbeef"))) })
  check(failsWith("INVALID_PACK_HASH") { GemmaPackStore(root, listOf(good.copy(sha256 = E2B_SHA.uppercase()))) })
  check(failsWith("INVALID_PACK_REVISION") { GemmaPackStore(root, listOf(good.copy(revision = "main"))) })
  check(failsWith("INVALID_PACK_SIZE") { GemmaPackStore(root, listOf(good.copy(bytes = 0))) })
  check(failsWith("INVALID_PACK_SIZE") { GemmaPackStore(root, listOf(good.copy(bytes = -1))) })
  // A filename is used as a path component, so an escape must never construct.
  check(failsWith("INVALID_PACK_FILENAME") { GemmaPackStore(root, listOf(good.copy(filename = "../evil.litertlm"))) })
  check(failsWith("INVALID_PACK_FILENAME") { GemmaPackStore(root, listOf(good.copy(filename = "a/b.litertlm"))) })
  check(failsWith("INVALID_PACK_FILENAME") { GemmaPackStore(root, listOf(good.copy(filename = "model.task"))) })
  check(failsWith("INVALID_PACK_URL") { GemmaPackStore(root, listOf(good.copy(url = "http://huggingface.co/x"))) })
  check(failsWith("INVALID_PACK_URL") { GemmaPackStore(root, listOf(good.copy(url = "https://evil.example.com/x"))) })
  // The pinned commit must appear in the URL, so a mirror cannot serve another.
  check(
    failsWith("URL_REVISION_MISMATCH") {
      GemmaPackStore(root, listOf(good.copy(url = "https://huggingface.co/a/b/resolve/main/c.litertlm")))
    },
  )

  val store = GemmaPackStore(root, listOf(good))
  // Nothing on disk is NOT_INSTALLED, and an unknown id is never guessed at.
  check(store.state(good.id) == GemmaPackState.NOT_INSTALLED)
  check(store.partialBytes(good.id) == 0L)
  check(store.installedBytes(good.id) == 0L)
  check(failsWith("UNKNOWN_MODEL") { store.verifiedFile("gemma4-e9b") })
  check(store.approvedIds() == listOf("gemma4-e2b"))

  // A file of the right name but the wrong size is not a ready model. This is
  // the case the old downloader treated as installed because it existed.
  val planted = File(root, good.filename)
  planted.writeText("not a model")
  check(store.state(good.id) == GemmaPackState.ERROR || store.state(good.id) == GemmaPackState.NOT_INSTALLED)
  check(failsWith("MODEL_SIZE_MISMATCH") { store.verifiedFile(good.id) })
  planted.delete()

  // An unsupported mark is sticky until explicitly cleared.
  store.markUnsupported(good.id, "GPU_BACKEND_UNAVAILABLE")
  check(store.state(good.id) == GemmaPackState.UNSUPPORTED)
  check(store.unsupportedReason(good.id) == "GPU_BACKEND_UNAVAILABLE")
  store.clearUnsupported(good.id)
  check(store.unsupportedReason(good.id) == null)
  println("PASS: pack catalogue validation, install states and path confinement.")
}

private fun checkAttachmentStore() {
  val root = tempDir("attachments")
  var now = 1_000L
  val store = GemmaAttachmentStore(root) { now }

  val image = store.newWorkFile("image", "jpg")
  image.writeText("pretend jpeg bytes")
  val handle = store.stage(image, "image", "request-1")
  check(handle.length == 32) { "handle should be opaque and random" }
  check(store.resolve(handle, "image", "request-1").canonicalFile == image.canonicalFile)
  check(failsWith("ATTACHMENT_ALREADY_USED") { store.resolve(handle, "image", "request-1") })
  check(failsWith("INVALID_ATTACHMENT_TTL") { store.stage(image, "image", "request-1", 0) })

  // Kind and request binding: an audio path cannot arrive at the vision
  // encoder, and one turn cannot read another turn's media.
  check(failsWith("ATTACHMENT_WRONG_KIND") { store.resolve(handle, "audio", "request-1") })
  check(failsWith("ATTACHMENT_WRONG_REQUEST") { store.resolve(handle, "image", "request-2") })
  check(failsWith("ATTACHMENT_NOT_FOUND") { store.resolve("0".repeat(32), "image", "request-1") })

  // A file outside the private root is refused however it is spelled.
  val outside = File(tempDir("elsewhere"), "outside.jpg").also { it.writeText("x") }
  check(failsWith("ATTACHMENT_OUTSIDE_ROOT") { store.stage(outside, "image", "request-1") })
  check(failsWith("UNSUPPORTED_ATTACHMENT_KIND") { store.stage(image, "video", "request-1") })
  check(failsWith("INVALID_REQUEST_ID") { store.stage(image, "image", "../../etc") })
  val empty = store.newWorkFile("image", "jpg").also { it.writeText("") }
  check(failsWith("ATTACHMENT_SIZE_REJECTED") { store.stage(empty, "image", "request-1") })

  // A handle does not outlive its turn.
  now += GemmaAttachmentStore.DEFAULT_TTL_MS + 1
  check(failsWith("ATTACHMENT_EXPIRED") { store.resolve(handle, "image", "request-1") })
  check(!image.exists()) { "an expired attachment should be deleted, not merely hidden" }

  // Release removes the user's financial photographs, it does not orphan them.
  val second = store.newWorkFile("audio", "wav").also { it.writeText("pretend wav") }
  val audioHandle = store.stage(second, "audio", "request-3")
  check(store.stagedCount() == 1)
  check(store.release("request-3") == 1)
  check(!second.exists())
  check(failsWith("ATTACHMENT_NOT_FOUND") { store.resolve(audioHandle, "audio", "request-3") })

  val third = store.newWorkFile("image", "png").also { it.writeText("pretend png") }
  store.stage(third, "image", "request-4")
  check(store.releaseAll() == 1)
  check(store.stagedCount() == 0)
  val growing = store.newWorkFile("image", "jpg").also { it.writeText("initial bytes") }
  val growingHandle = store.stage(growing, "image", "request-5")
  java.io.RandomAccessFile(growing, "rw").use { it.setLength(GemmaAttachmentStore.MAX_ATTACHMENT_BYTES + 1) }
  check(failsWith("ATTACHMENT_SIZE_REJECTED") { store.resolve(growingHandle, "image", "request-5") })
  store.releaseAll()
  println("PASS: attachment handle binding, confinement, expiry and release.")
}

private fun checkSessionHostGuards() {
  // N4: the SDK must never be able to run a tool body. Even if a future SDK
  // upgrade flipped automaticToolCalling, this is what stops a callback from
  // reaching a domain service.
  val schema = """{"name":"read_total","parameters":{"type":"object","properties":{}}}"""
  val toolOnly = SchemaOnlyTool(schema)
  check(toolOnly.getToolDescriptionJsonString() == schema)
  check(failsWith("AUTOMATIC_TOOL_EXECUTION_FORBIDDEN") { toolOnly.execute("{}") })

  val packRoot = tempDir("host-packs")
  val store = GemmaPackStore(packRoot, listOf(approvedSpec()))
  val host = GemmaSessionHost(store, tempDir("host-cache")) { _, _, _ ->
    error("no attachment should be resolved in a validation-only check")
  }

  fun request(body: String) = """{"requestId":"request-1","modelId":"gemma4-e2b","mode":"agent","system":"s","input":"i","tools":[]$body}"""

  // Request validation happens before any engine work, so these never touch
  // JNI and never need a model file.
  check(failsWith("INVALID_REQUEST_ID") { host.begin(request("").replace("\"request-1\"", "\"bad id!\"")) })
  check(failsWith("INVALID_MODE") { host.begin(request("").replace("\"agent\"", "\"sudo\"")) })
  check(
    failsWith("ONE_MEDIA_KIND_PER_TURN") {
      host.begin(request(",\"imageHandle\":\"a\",\"audioHandle\":\"b\""))
    },
  )
  check(failsWith("REQUEST_TOO_LARGE") { host.begin("{" + " ".repeat(GemmaSessionHost.MAX_REQUEST_CHARS) + "}") })

  val nineTools = (1..9).joinToString(",") { """{"name":"t$it"}""" }
  check(
    failsWith("TOO_MANY_TOOLS") {
      host.begin("""{"requestId":"r1","modelId":"gemma4-e2b","mode":"agent","system":"s","input":"i","tools":[$nineTools]}""")
    },
  )
  // Extraction turns must advertise nothing at all.
  check(
    failsWith("TOOLS_NOT_ALLOWED_IN_THIS_MODE") {
      host.begin("""{"requestId":"r1","modelId":"gemma4-e2b","mode":"extract","system":"s","input":"i","tools":[{"name":"t"}]}""")
    },
  )

  // A cancel that arrives before the queued begin runs must stop it starting.
  host.requestCancel("request-9")
  check(
    failsWith("GEMMA_CANCELLED") {
      host.begin("""{"requestId":"request-9","modelId":"gemma4-e2b","mode":"agent","system":"s","input":"i","tools":[]}""")
    },
  )
  check(host.activeRequestId() == null)
  check(!host.isEngineLoaded())

  // Resume without a live session cannot be used to inject a tool result.
  check(failsWith("STALE_SESSION") { host.resume("""{"requestId":"request-1","results":[]}""") })

  host.close()
  check(failsWith("GEMMA_SHUTDOWN") { host.begin(request("")) })
  println("PASS: tool-callback refusal, request validation, cancel-before-start and shutdown.")
}

private fun checkCatalogAsset() {
  // The real asset that ships in the APK, parsed by the code that will parse it
  // on device. A malformed catalogue should be a build failure, not a download
  // that cannot verify on a user's phone.
  val asset = File(
    "frontend/modules/ledgr-native-ai/android/src/main/assets/${GemmaCatalogAsset.ASSET_NAME}",
  )
  check(asset.isFile) { "bundled catalogue asset is missing: ${asset.path}" }
  val json = asset.readText()
  val specs = GemmaCatalogAsset.parse(json)
  check(specs.map { it.id } == listOf("gemma4-e2b", "gemma4-e4b")) { "unexpected approved packs" }
  check(GemmaCatalogAsset.minBridgeVersion(json) == GemmaSessionHost.BRIDGE_VERSION)

  // The asset must satisfy the store's own validation, which is the check that
  // actually gates a download.
  val store = GemmaPackStore(tempDir("asset-packs"), specs)
  check(store.approvedIds() == listOf("gemma4-e2b", "gemma4-e4b"))

  // And the pins are the reviewed ones, so a rebuild cannot quietly retarget.
  val e2b = specs.first { it.id == "gemma4-e2b" }
  check(e2b.sha256 == E2B_SHA) { "E2B hash is not the reviewed pin" }
  check(e2b.bytes == 2588147712L) { "E2B size is not the reviewed pin" }
  check(specs.first { it.id == "gemma4-e4b" }.bytes == 3659530240L)

  check(failsWith("CATALOG_SCHEMA_MISMATCH") { GemmaCatalogAsset.parse(json.replace("\"schema\": 2", "\"schema\": 1")) })
  check(failsWith("CATALOG_RUNTIME_NOT_SUPPORTED") { GemmaCatalogAsset.parse(json.replace("litert-lm", "mediapipe")) })
  check(failsWith("CATALOG_EMPTY") { GemmaCatalogAsset.parse("""{"schema":2,"catalogVersion":1,"packs":[]}""") })

  // The native asset and the JS-imported catalogue are the same document. Two
  // copies that drift would mean the UI offering a model the downloader will
  // refuse, so this is asserted in the Jest suite as well.
  val shared = File("frontend/src/accountingV2/gemma/model-packs-v2.json")
  check(shared.isFile) { "shared catalogue is missing" }
  check(shared.readText().replace("\r\n", "\n") == json.replace("\r\n", "\n")) {
    "native asset and JS catalogue have drifted apart"
  }
  println("PASS: bundled catalogue asset parses, matches the reviewed pins and the JS copy.")
}

fun main() {
  checkPackStoreValidation()
  checkAttachmentStore()
  checkSessionHostGuards()
  checkCatalogAsset()
  println("PASS: native contract checks (no Android, no JNI, no model inference).")
}
