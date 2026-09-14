package expo.modules.ledgrnativeai

import android.content.Intent
import android.speech.tts.TextToSpeech
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale
import java.text.BreakIterator

class LedgrTtsModule : Module(), TextToSpeech.OnInitListener {
  private var tts: TextToSpeech? = null
  private var ready = false
  private var locale = Locale.getDefault()

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LedgrTts")

    OnCreate {
      tts = TextToSpeech(context, this@LedgrTtsModule)
    }

    OnDestroy {
      tts?.stop()
      tts?.shutdown()
      tts = null
      ready = false
    }

    AsyncFunction("isAvailable") {
      ready && tts != null
    }

    AsyncFunction("speak") { text: String ->
      val engine = tts ?: throw IllegalStateException("Phone speaker is not ready.")
      if (!ready) throw IllegalStateException("No text-to-speech voice is installed on this phone.")
      val spoken = text.trim()
      if (spoken.isEmpty()) return@AsyncFunction
      val chunks = speechChunks(spoken, TextToSpeech.getMaxSpeechInputLength().coerceAtLeast(256) - 32)
      chunks.forEachIndexed { index, chunk ->
        val queue = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        check(engine.speak(chunk, queue, null, "ledgr-tts-$index") == TextToSpeech.SUCCESS) {
          "TTS_SPEAK_FAILED"
        }
      }
    }

    AsyncFunction("stop") {
      tts?.stop()
    }

    AsyncFunction("setLocale") { languageTag: String ->
      val requested = Locale.forLanguageTag(languageTag.trim())
      if (requested.language.isBlank()) throw IllegalArgumentException("INVALID_TTS_LOCALE")
      locale = requested
      ready = tts?.let { selectOfflineVoice(it, requested) } == true
      ready
    }

    AsyncFunction("openVoiceDataInstaller") {
      context.startActivity(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  override fun onInit(status: Int) {
    ready = status == TextToSpeech.SUCCESS && tts?.let { selectOfflineVoice(it, locale) } == true
  }

  private fun selectOfflineVoice(engine: TextToSpeech, requested: Locale): Boolean {
    val chosen = engine.voices.orEmpty()
      .filter { !it.isNetworkConnectionRequired && it.locale.language == requested.language }
      .sortedWith(compareByDescending<android.speech.tts.Voice> { it.locale == requested }
        .thenByDescending { it.quality })
      .firstOrNull() ?: return false
    return engine.setVoice(chosen) == TextToSpeech.SUCCESS
  }

  private fun speechChunks(text: String, limit: Int): List<String> {
    if (text.length <= limit) return listOf(text)
    val sentences = mutableListOf<String>()
    val iterator = BreakIterator.getSentenceInstance(locale)
    iterator.setText(text)
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
      val sentence = text.substring(start, end).trim()
      if (sentence.isNotEmpty()) sentences += sentence
      start = end
      end = iterator.next()
    }
    val chunks = mutableListOf<String>()
    for (sentence in sentences) {
      var remaining = sentence
      while (remaining.length > limit) {
        val split = remaining.lastIndexOf(' ', limit).takeIf { it > 0 } ?: limit
        chunks += remaining.substring(0, split).trim()
        remaining = remaining.substring(split).trim()
      }
      if (remaining.isNotEmpty()) {
        val prior = chunks.lastOrNull()
        if (prior != null && prior.length + 1 + remaining.length <= limit) chunks[chunks.lastIndex] = "$prior $remaining"
        else chunks += remaining
      }
    }
    return chunks
  }
}
