import fs from 'fs';
import path from 'path';

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('Gemma media app wiring', () => {
  const apiSource = read('src/api.ts');
  const voiceFabSource = read('src/components/VoiceFab.tsx');
  const voiceScreenSource = read('app/voice.tsx');

  it('routes device document extraction through the bounded Gemma media task', () => {
    expect(apiSource).toContain('extractDocumentWithGemma({ uri: input.uri, mimeType: input.mimeType })');
    expect(apiSource).not.toContain("raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)");
    expect(apiSource).not.toContain('runOptionalOnDeviceModel({ id: vision.id');
  });

  it('keeps explicit device audio local and allows the verified Gemma recorder fallback', () => {
    expect(apiSource).toContain("ai.effectiveVoiceProvider(config) === 'android-device'");
    expect(apiSource).toContain('return transcribeAudioWithGemma(audioUri)');
    expect(apiSource).toContain('No audio was sent to a cloud provider.');
    for (const source of [voiceFabSource, voiceScreenSource]) {
      expect(source).toContain("hasReadyGemmaCapability(gemma, 'audio')");
      expect(source).toContain('await startVoiceRecorder(recorder)');
    }
  });
});
