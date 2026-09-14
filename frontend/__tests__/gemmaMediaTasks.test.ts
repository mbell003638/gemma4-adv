import type { Engine, Frame, NativeRequest } from '../src/accountingV2/gemma/agentCore';
import { extractDocumentWithGemma, transcribeAudioWithGemma } from '../src/accountingV2/gemma/mediaTasks';

function harness(frames: (request: NativeRequest) => Frame, pages = 1) {
  const begin = jest.fn(async (request: NativeRequest) => frames(request));
  const engine: Engine = {
    begin,
    resume: jest.fn(),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const discard = jest.fn(async () => 1);
  return {
    engine,
    begin,
    discard,
    deps: {
      runtime: async () => ({ modelId: 'gemma4-e2b', engine }),
      image: async (_uri: string, id: string) => ({ handle: `image:${id}`, pageCount: 1, excludedPages: 0 }),
      pdf: async (_uri: string, page: number, id: string) => ({ handle: `image:${id}`, pageCount: pages, excludedPages: Math.max(0, pages - 5) }),
      audio: async (_uri: string, id: string) => ({ handle: `audio:${id}`, durationMs: 1000, sampleRate: 16000 }),
      discard,
      markRecoveryRequired: jest.fn(),
    },
  };
}

describe('Gemma media tasks', () => {
  it('extracts an image with no tools and always releases its handle', async () => {
    const h = harness((request) => ({
      requestId: request.requestId,
      text: JSON.stringify({ docType: 'receipt', summary: 'Fuel receipt', entries: [] }),
      calls: [],
    }));
    await expect(extractDocumentWithGemma({ uri: 'content://receipt', mimeType: 'image/jpeg' }, h.deps))
      .resolves.toMatchObject({ docType: 'receipt', summary: 'Fuel receipt' });
    expect(h.begin.mock.calls[0][0]).toMatchObject({ mode: 'extract', tools: [] });
    expect(h.begin.mock.calls[0][0].imageHandle).toContain('image:extract-');
    expect(h.discard).toHaveBeenCalledTimes(1);
  });

  it('rejects PDFs above the five-page safety limit without partial output', async () => {
    const h = harness((request) => ({
      requestId: request.requestId,
      text: JSON.stringify({
        docType: 'transaction_list',
        summary: 'One page',
        entries: Array.from({ length: 15 }, (_, index) => ({ type: 'expense', amount: index + 1 })),
      }),
      calls: [],
    }), 8);
    await expect(extractDocumentWithGemma({ uri: 'content://statement', mimeType: 'application/pdf' }, h.deps))
      .rejects.toThrow('GEMMA_PDF_TOO_MANY_PAGES');
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.discard).toHaveBeenCalledTimes(1);
  });

  it('transcribes with no tools and rejects tool calls', async () => {
    const ok = harness((request) => ({ requestId: request.requestId, text: 'Paid rent 500', calls: [] }));
    await expect(transcribeAudioWithGemma('content://recording', ok.deps)).resolves.toEqual({ transcript: 'Paid rent 500' });
    expect(ok.begin.mock.calls[0][0]).toMatchObject({ mode: 'transcribe', tools: [] });

    const bad = harness((request) => ({
      requestId: request.requestId,
      text: '',
      calls: [{ id: '1', name: 'add_expense', arguments: {} }],
    }));
    await expect(transcribeAudioWithGemma('content://recording', bad.deps)).rejects.toThrow('INVALID_MEDIA_MODEL_FRAME');
    expect(bad.discard).toHaveBeenCalledTimes(1);
  });
});
