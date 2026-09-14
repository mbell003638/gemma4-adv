package expo.modules.ledgrnativeai

import org.json.JSONObject

/**
 * Parses the approved pack catalogue that ships inside the APK.
 *
 * The list of models native code will download and load comes from here and
 * nowhere else. It deliberately does not come from JS: a descriptor passed
 * across the bridge is data the app assembled at runtime, and the whole point
 * of pinning a hash, a size and a commit is that a reviewed build decided them.
 * JS may ask for a model *by id*; it cannot describe one.
 *
 * Kept free of `android.*` so the parsing is host-testable. Only the caller
 * that reads `assets/model-packs-v2.json` needs a Context.
 */
object GemmaCatalogAsset {
  const val ASSET_NAME = "model-packs-v2.json"
  const val SCHEMA = 2
  const val RUNTIME = "litert-lm"

  /**
   * Every field is required and re-validated by `GemmaPackStore`'s own init.
   * Two layers look redundant until you remember they fail differently: a
   * malformed asset is a build error, and this is where it surfaces as one
   * instead of as a download that cannot verify on a user's phone.
   */
  fun parse(json: String): List<GemmaPackSpec> {
    val document = JSONObject(json)
    val schema = document.getInt("schema")
    require(schema == SCHEMA) { "CATALOG_SCHEMA_MISMATCH" }

    val packs = document.getJSONArray("packs")
    require(packs.length() > 0) { "CATALOG_EMPTY" }

    val specs = mutableListOf<GemmaPackSpec>()
    for (index in 0 until packs.length()) {
      val row = packs.getJSONObject(index)
      // An unknown runtime is not skipped quietly: a schema-2 catalogue naming
      // a runtime this build does not have means the build and the catalogue
      // disagree, and guessing which is right is how the wrong engine gets a
      // file it will fail to parse.
      require(row.getString("runtime") == RUNTIME) { "CATALOG_RUNTIME_NOT_SUPPORTED" }
      specs.add(
        GemmaPackSpec(
          id = row.getString("id"),
          filename = row.getString("filename"),
          url = row.getString("downloadUrl"),
          bytes = row.getLong("bytes"),
          sha256 = row.getString("sha256"),
          revision = row.getString("revision"),
        ),
      )
    }
    require(specs.map { it.id }.toSet().size == specs.size) { "CATALOG_DUPLICATE_ID" }
    return specs
  }

  /** Minimum bridge version any pack in the asset demands, for status reporting. */
  fun minBridgeVersion(json: String): Int {
    val packs = JSONObject(json).getJSONArray("packs")
    var required = 0
    for (index in 0 until packs.length()) {
      required = maxOf(required, packs.getJSONObject(index).getInt("minBridgeVersion"))
    }
    return required
  }
}

