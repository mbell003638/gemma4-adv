import { hasReadyGemmaCapability, parsePreparedGemmaAudio, parsePreparedGemmaImage } from '../src/utils/gemmaNative';

describe('Gemma media bridge frames', () => {
  it('accepts bounded native image and audio metadata', () => {
    expect(parsePreparedGemmaImage('{"handle":"image:req:1","pageCount":3,"excludedPages":0}'))
      .toEqual({ handle: 'image:req:1', pageCount: 3, excludedPages: 0 });
    expect(parsePreparedGemmaAudio('{"handle":"audio:req:1","durationMs":2500,"sampleRate":16000}'))
      .toEqual({ handle: 'audio:req:1', durationMs: 2500, sampleRate: 16000 });
  });

  it('rejects malformed, oversized, or impossible native metadata', () => {
    expect(() => parsePreparedGemmaImage('not-json')).toThrow('GEMMA_MEDIA_FRAME_INVALID');
    expect(() => parsePreparedGemmaImage('{"handle":"","pageCount":1,"excludedPages":0}')).toThrow('GEMMA_MEDIA_HANDLE_INVALID');
    expect(() => parsePreparedGemmaAudio('{"handle":"a","durationMs":60001,"sampleRate":16000}')).toThrow('GEMMA_MEDIA_DURATION_INVALID');
    expect(() => parsePreparedGemmaAudio('{"handle":"a","durationMs":1,"sampleRate":0.5}')).toThrow('GEMMA_MEDIA_SAMPLE_RATE_INVALID');
  });

  it('requires both a verified native capability and a ready pack', () => {
    const ready = { supported: true, bridgeVersion: 2, capabilities: ['text', 'audio'], packs: { 'gemma4-e2b': { state: 'ready', bytesOnDisk: 1, partialBytes: 0 } } };
    expect(hasReadyGemmaCapability(ready, 'audio')).toBe(true);
    expect(hasReadyGemmaCapability(ready, 'vision')).toBe(false);
    expect(hasReadyGemmaCapability({ ...ready, packs: {} }, 'audio')).toBe(false);
    expect(hasReadyGemmaCapability({ ...ready, supported: false }, 'audio')).toBe(false);
  });
});
