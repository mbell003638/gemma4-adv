import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Gemma media normalization source contract', () => {
  const media = read('modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai/GemmaMediaNormalizer.kt');
  const bridge = read('modules/ledgr-native-ai/android/src/gemma/java/expo/modules/ledgrnativeai/LedgrOnDeviceLlmModule.kt');

  it('bounds, rotates, downsizes, strips metadata and scopes images to handles', () => {
    expect(media).toContain('MAX_IMAGE_SOURCE_BYTES');
    expect(media).toContain('MAX_SOURCE_PIXELS');
    expect(media).toContain('ExifInterface.TAG_ORIENTATION');
    expect(media).toContain('IMAGE_EDGE = 1280');
    expect(media).toContain('Bitmap.CompressFormat.JPEG');
    expect(media).toContain('attachments.stage(output, "image", requestId)');
    expect(media).toContain('uri.scheme == "content" || uri.scheme == "file"');
  });

  it('renders only reviewed PDF pages and reports exclusions', () => {
    expect(media).toContain('PdfRenderer');
    expect(media).toContain('MAX_PDF_PAGES = 5');
    expect(media).toContain('PDF_PAGE_LIMIT');
    expect(media).toContain('excludedPages = max(0, renderer.pageCount - MAX_PDF_PAGES)');
    expect(bridge).toContain('gemmaPreparePdfPage');
    expect(bridge).toContain('gemmaDiscardAttachments');
  });

  it('does not advertise unverified vision or audio yet', () => {
    expect(media).toContain('MediaExtractor');
    expect(media).toContain('MediaCodec.createDecoderByType');
    expect(media).toContain('monoResample16');
    expect(media).toContain('AUDIO_SAMPLE_RATE = 16_000');
    expect(media).toContain('MAX_AUDIO_DURATION_MS = 60_000L');
    expect(media).toContain('ascii("RIFF")');
    expect(bridge).toContain('gemmaPrepareAudio');
    expect(bridge).toContain('"gemmaCapabilities" to listOf("text", "tools")');
    expect(bridge).not.toContain('"gemmaCapabilities" to listOf("text", "tools", "vision"');
  });

  it('deletes normalized output if encoding or handle registration fails', () => {
    expect(media.match(/output\.delete\(\)/g)).toHaveLength(3);
  });
});
