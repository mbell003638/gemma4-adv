package expo.modules.ledgrnativeai

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.media.ExifInterface
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Bounded, app-private preparation for Gemma image inputs.
 *
 * Raw picker URIs never reach LiteRT-LM. The source is copied with a byte cap,
 * decoded with a pixel cap, rotated from EXIF, downscaled, metadata-stripped,
 * and registered as a short-lived request-bound handle.
 */
class GemmaMediaNormalizer(
  private val resolver: ContentResolver,
  private val attachments: GemmaAttachmentStore,
) {
  data class PreparedImage(val handle: String, val pageCount: Int = 1, val excludedPages: Int = 0)
  data class PreparedAudio(val handle: String, val durationMs: Long, val sampleRate: Int = AUDIO_SAMPLE_RATE)

  fun prepareImage(uriText: String, requestId: String): PreparedImage {
    val raw = attachments.newWorkFile("image", "source")
    try {
      copyBounded(uriText, raw, MAX_IMAGE_SOURCE_BYTES)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(raw.absolutePath, bounds)
      require(bounds.outWidth > 0 && bounds.outHeight > 0) { "IMAGE_DECODE_FAILED" }
      require(bounds.outWidth <= MAX_SOURCE_EDGE && bounds.outHeight <= MAX_SOURCE_EDGE
        && bounds.outWidth.toLong() * bounds.outHeight.toLong() <= MAX_SOURCE_PIXELS) { "IMAGE_DIMENSIONS_REJECTED" }

      var sample = 1
      while (max(bounds.outWidth, bounds.outHeight) / sample > DECODE_EDGE) sample *= 2
      val decoded = BitmapFactory.decodeFile(raw.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: error("IMAGE_DECODE_FAILED")
      val oriented = rotate(decoded, orientation(raw))
      if (oriented !== decoded) decoded.recycle()
      val normalized = scale(oriented, IMAGE_EDGE)
      if (normalized !== oriented) oriented.recycle()

      val output = attachments.newWorkFile("image", "jpg")
      try {
        try {
          FileOutputStream(output).use {
            check(normalized.compress(Bitmap.CompressFormat.JPEG, 90, it)) { "IMAGE_ENCODE_FAILED" }
          }
          return PreparedImage(attachments.stage(output, "image", requestId))
        } catch (error: Throwable) {
          output.delete()
          throw error
        }
      } finally {
        normalized.recycle()
      }
    } finally {
      raw.delete()
    }
  }

  /**
   * Render one reviewed PDF page. Callers may request only the first five
   * pages, and the result reports how many pages were intentionally excluded.
   */
  fun preparePdfPage(uriText: String, pageIndex: Int, requestId: String): PreparedImage {
    require(pageIndex in 0 until MAX_PDF_PAGES) { "PDF_PAGE_LIMIT" }
    val raw = attachments.newWorkFile("image", "pdf")
    try {
      copyBounded(uriText, raw, MAX_PDF_SOURCE_BYTES)
      ParcelFileDescriptor.open(raw, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
          require(renderer.pageCount > 0) { "PDF_EMPTY" }
          if (renderer.pageCount > MAX_PDF_PAGES) throw GemmaSessionException("GEMMA_PDF_TOO_MANY_PAGES")
          require(pageIndex < renderer.pageCount) { "PDF_PAGE_OUT_OF_RANGE" }
          renderer.openPage(pageIndex).use { page ->
            val factor = minOf(1.0, IMAGE_EDGE.toDouble() / max(page.width, page.height).toDouble())
            val width = max(1, (page.width * factor).roundToInt())
            val height = max(1, (page.height * factor).roundToInt())
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val output = attachments.newWorkFile("image", "png")
            try {
              try {
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                FileOutputStream(output).use {
                  check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) { "PDF_RENDER_FAILED" }
                }
                return PreparedImage(
                  handle = attachments.stage(output, "image", requestId),
                  pageCount = renderer.pageCount,
                  excludedPages = max(0, renderer.pageCount - MAX_PDF_PAGES),
                )
              } catch (error: Throwable) {
                output.delete()
                throw error
              }
            } finally {
              bitmap.recycle()
            }
          }
        }
      }
    } finally {
      raw.delete()
    }
  }

  /**
   * Decode picker/recorder audio through the platform codec, downmix and
   * resample it, then write a real PCM WAV. Renaming an M4A file is never used.
   */
  fun prepareAudio(uriText: String, requestId: String): PreparedAudio {
    val raw = attachments.newWorkFile("audio", "source")
    try {
      copyBounded(uriText, raw, MAX_AUDIO_SOURCE_BYTES)
      val decoded = decodeAudio(raw)
      require(decoded.durationMs in 1..MAX_AUDIO_DURATION_MS) { "AUDIO_DURATION_REJECTED" }
      val pcm = monoResample16(decoded.pcm, decoded.sampleRate, decoded.channels, AUDIO_SAMPLE_RATE)
      require(pcm.isNotEmpty() && pcm.size.toLong() <= GemmaAttachmentStore.MAX_ATTACHMENT_BYTES) { "AUDIO_SIZE_REJECTED" }
      val output = attachments.newWorkFile("audio", "wav")
      try {
        writeWav(output, pcm, AUDIO_SAMPLE_RATE)
        return PreparedAudio(attachments.stage(output, "audio", requestId), decoded.durationMs)
      } catch (error: Throwable) {
        output.delete()
        throw error
      }
    } finally {
      raw.delete()
    }
  }

  private data class DecodedAudio(
    val pcm: ByteArray,
    val sampleRate: Int,
    val channels: Int,
    val durationMs: Long,
  )

  private fun decodeAudio(file: File): DecodedAudio {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(file.absolutePath)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: error("AUDIO_TRACK_NOT_FOUND")
      extractor.selectTrack(track)
      val sourceFormat = extractor.getTrackFormat(track)
      val mime = sourceFormat.getString(MediaFormat.KEY_MIME) ?: error("AUDIO_MIME_MISSING")
      val declaredDurationUs = if (sourceFormat.containsKey(MediaFormat.KEY_DURATION)) sourceFormat.getLong(MediaFormat.KEY_DURATION) else 0L
      require(declaredDurationUs <= MAX_AUDIO_DURATION_MS * 1000L) { "AUDIO_DURATION_REJECTED" }
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(sourceFormat, null, null, 0)
      codec.start()

      val output = ByteArrayOutputStream()
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      var sampleRate = sourceFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = sourceFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var maxPresentationUs = 0L
      var turns = 0

      while (!outputDone) {
        require(++turns <= MAX_CODEC_TURNS) { "AUDIO_DECODE_STALLED" }
        if (!inputDone) {
          val inputIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputIndex >= 0) {
            val buffer = codec.getInputBuffer(inputIndex) ?: error("AUDIO_INPUT_BUFFER_MISSING")
            buffer.clear()
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) {
              codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val time = extractor.sampleTime.coerceAtLeast(0)
              codec.queueInputBuffer(inputIndex, 0, size, time, 0)
              extractor.advance()
            }
          }
        }

        when (val outputIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = codec.outputFormat
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
              require(format.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_16BIT) {
                "AUDIO_PCM_ENCODING_UNSUPPORTED"
              }
            }
          }
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          else -> if (outputIndex >= 0) {
            val buffer = codec.getOutputBuffer(outputIndex) ?: error("AUDIO_OUTPUT_BUFFER_MISSING")
            if (info.size > 0) {
              require(output.size() + info.size <= MAX_DECODED_PCM_BYTES) { "AUDIO_DECODE_TOO_LARGE" }
              val bytes = ByteArray(info.size)
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              buffer.get(bytes)
              output.write(bytes)
              maxPresentationUs = max(maxPresentationUs, info.presentationTimeUs)
            }
            codec.releaseOutputBuffer(outputIndex, false)
            outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          }
        }
      }
      require(sampleRate in 8000..192000 && channels in 1..8) { "AUDIO_FORMAT_REJECTED" }
      val durationMs = max(declaredDurationUs, maxPresentationUs) / 1000L
      return DecodedAudio(output.toByteArray(), sampleRate, channels, durationMs.coerceAtLeast(1))
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      extractor.release()
    }
  }

  private fun monoResample16(source: ByteArray, sourceRate: Int, channels: Int, targetRate: Int): ByteArray {
    require(source.size % (2 * channels) == 0) { "AUDIO_PCM_TRUNCATED" }
    val frames = source.size / (2 * channels)
    val targetFrames = (frames.toLong() * targetRate / sourceRate).toInt()
    val result = ByteArray(targetFrames * 2)
    for (target in 0 until targetFrames) {
      val sourceFrame = minOf(frames - 1, (target.toLong() * sourceRate / targetRate).toInt())
      var sum = 0
      for (channel in 0 until channels) {
        val offset = (sourceFrame * channels + channel) * 2
        sum += ((source[offset + 1].toInt() shl 8) or (source[offset].toInt() and 0xff)).toShort().toInt()
      }
      val sample = (sum / channels).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
      result[target * 2] = (sample and 0xff).toByte()
      result[target * 2 + 1] = ((sample ushr 8) and 0xff).toByte()
    }
    return result
  }

  private fun writeWav(file: File, pcm: ByteArray, sampleRate: Int) {
    FileOutputStream(file).use { out ->
      fun ascii(value: String) = out.write(value.toByteArray(Charsets.US_ASCII))
      fun little(value: Int) {
        out.write(value and 0xff); out.write(value ushr 8 and 0xff)
        out.write(value ushr 16 and 0xff); out.write(value ushr 24 and 0xff)
      }
      fun short(value: Int) { out.write(value and 0xff); out.write(value ushr 8 and 0xff) }
      ascii("RIFF"); little(36 + pcm.size); ascii("WAVEfmt "); little(16)
      short(1); short(1); little(sampleRate); little(sampleRate * 2)
      short(2); short(16); ascii("data"); little(pcm.size); out.write(pcm); out.fd.sync()
    }
  }

  private fun copyBounded(uriText: String, target: File, maxBytes: Long) {
    val uri = Uri.parse(uriText)
    require(uri.scheme == "content" || uri.scheme == "file") { "UNSUPPORTED_MEDIA_URI" }
    val input = resolver.openInputStream(uri) ?: error("MEDIA_OPEN_FAILED")
    input.use { source ->
      FileOutputStream(target).use { sink ->
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val read = source.read(buffer)
          if (read < 0) break
          total += read
          require(total <= maxBytes) { "MEDIA_SOURCE_TOO_LARGE" }
          sink.write(buffer, 0, read)
        }
        require(total > 0) { "MEDIA_EMPTY" }
        sink.fd.sync()
      }
    }
  }

  private fun orientation(file: File): Int = runCatching {
    ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
  }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

  private fun rotate(source: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postScale(-1f, 1f); matrix.postRotate(270f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postScale(-1f, 1f); matrix.postRotate(90f) }
      else -> return source
    }
    return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
  }

  private fun scale(source: Bitmap, longest: Int): Bitmap {
    val edge = max(source.width, source.height)
    if (edge <= longest) return source
    val ratio = longest.toDouble() / edge.toDouble()
    return Bitmap.createScaledBitmap(source, max(1, (source.width * ratio).roundToInt()), max(1, (source.height * ratio).roundToInt()), true)
  }

  companion object {
    const val IMAGE_EDGE = 1280
    const val DECODE_EDGE = 2560
    const val MAX_SOURCE_EDGE = 20_000
    const val MAX_SOURCE_PIXELS = 50_000_000L
    const val MAX_IMAGE_SOURCE_BYTES = 24L * 1024 * 1024
    const val MAX_PDF_SOURCE_BYTES = 32L * 1024 * 1024
    const val MAX_PDF_PAGES = 5
    const val MAX_AUDIO_SOURCE_BYTES = 32L * 1024 * 1024
    const val MAX_AUDIO_DURATION_MS = 60_000L
    const val AUDIO_SAMPLE_RATE = 16_000
    const val MAX_DECODED_PCM_BYTES = 64 * 1024 * 1024
    const val MAX_CODEC_TURNS = 100_000
    const val CODEC_TIMEOUT_US = 10_000L
  }
}
