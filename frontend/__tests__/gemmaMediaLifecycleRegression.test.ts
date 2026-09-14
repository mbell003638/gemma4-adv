import type { Frame, NativeRequest } from '../src/accountingV2/gemma/agentCore';
import { bounded } from '../src/accountingV2/gemma/mediaDeadline';
import { extractDocumentWithGemma, transcribeAudioWithGemma, type MediaDeps } from '../src/accountingV2/gemma/mediaTasks';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const input = { uri: 'content://document', mimeType: 'application/pdf' };
const document = (rows = 1, setup?: object) => ({
  docType: 'receipt', summary: 'Reviewed page',
  entries: Array.from({ length: rows }, () => ({ type: 'expense', amount: 1 })),
  ...(setup ? { setup } : {}),
});
function harness(pages = 1, rows = 1) {
  const events: string[] = [];
  let poisoned = false;
  const begin = jest.fn(async (request: NativeRequest): Promise<Frame> => ({
    requestId: request.requestId, text: JSON.stringify(document(rows)), calls: [],
  }));
  const cancel = jest.fn(async (id: string) => { events.push('cancel:' + id); });
  const finish = jest.fn(async (id: string) => { events.push('finish:' + id); });
  const discard = jest.fn(async (id: string) => { events.push('discard:' + id); return 1; });
  const engine = { begin, cancel, finish, resume: jest.fn() };
  const runtime = jest.fn(async () => {
    if (poisoned) throw new Error('NATIVE_RECOVERY_REQUIRED');
    return { modelId: 'gemma4-e2b', engine };
  });
  const pdf = jest.fn(async (_uri: string, _page: number, id: string) => ({
    handle: 'image:' + id, pageCount: pages, excludedPages: 0,
  }));
  const audio = jest.fn(async (_uri: string, id: string) => ({
    handle: 'audio:' + id, durationMs: 1000, sampleRate: 16000,
  }));
  const markRecoveryRequired = jest.fn((_id: string) => { poisoned = true; });
  const deps: MediaDeps = {
    runtime, pdf, audio, discard, markRecoveryRequired,
    image: async (_uri, id) => ({ handle: 'image:' + id, pageCount: 1, excludedPages: 0 }),
  };
  return { deps, begin, cancel, finish, discard, runtime, pdf, audio, markRecoveryRequired, events };
}
// Only microtasks; elapsed time is controlled explicitly by each test.
async function flush() { for (let i = 0; i < 40; i += 1) await Promise.resolve(); }

describe('A10 media ownership and deadlines (deferred execution)', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => { jest.useRealTimers(); });

  it('does not schedule work after an expired deadline, including a delayed microtask', async () => {
    const work = jest.fn(async () => 1);
    await expect(bounded(work, 0, 'TIMEOUT')).rejects.toThrow('TIMEOUT');
    const pending = bounded(work, 1, 'TIMEOUT');
    const checked = expect(pending).rejects.toThrow('TIMEOUT');
    jest.setSystemTime(2);
    await checked;
    expect(work).not.toHaveBeenCalled();
  });

  it('does not prepare when runtime lookup consumes the overall deadline', async () => {
    const h = harness();
    h.runtime.mockImplementation(async () => {
      jest.setSystemTime(60_001);
      return { modelId: 'gemma4-e2b', engine: { begin: h.begin, cancel: h.cancel, finish: h.finish, resume: jest.fn() } };
    });
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MEDIA_TIMEOUT');
    expect(h.pdf).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('pre-abort does not look up runtime or prepare audio', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(transcribeAudioWithGemma('content://audio', h.deps, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    expect(h.runtime).not.toHaveBeenCalled();
    expect(h.audio).not.toHaveBeenCalled();
  });

  it('bounds hung runtime lookup without starting preparation', async () => {
    const h = harness();
    h.runtime.mockImplementation(() => new Promise(() => {}));
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MEDIA_TIMEOUT');
    await flush();
    jest.advanceTimersByTime(60_000);
    await checked;
    expect(h.pdf).not.toHaveBeenCalled();
  });

  it('shares the deadline across PDF pages instead of renewing it', async () => {
    const h = harness(2);
    h.begin.mockImplementationOnce(async (request) => {
      jest.setSystemTime(40_000);
      return { requestId: request.requestId, text: JSON.stringify(document()), calls: [] };
    }).mockImplementationOnce(() => new Promise<Frame>(() => {}));
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MEDIA_TIMEOUT');
    await flush();
    // The second page is admitted in a later microtask after the first page's
    // cleanup handshake; flush that continuation before asserting ownership.
    await flush();
    expect(h.begin).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(20_000);
    await checked;
    expect(h.discard).toHaveBeenCalledTimes(2);
  });

  it('aborts audio preparation and releases its late handle only after another finish', async () => {
    const h = harness();
    const prepared = deferred<Awaited<ReturnType<MediaDeps['audio']>>>();
    const controller = new AbortController();
    h.audio.mockImplementation(() => prepared.promise);
    const checked = expect(transcribeAudioWithGemma('content://audio', h.deps, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    await flush();
    controller.abort();
    await checked;
    expect(h.discard).not.toHaveBeenCalled();
    prepared.resolve({ handle: 'late-audio', durationMs: 1000, sampleRate: 16000 });
    await flush();
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.discard).toHaveBeenCalledTimes(1);
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('latches failed late finish and retains the late attachment', async () => {
    const h = harness();
    const prepared = deferred<Awaited<ReturnType<MediaDeps['pdf']>>>();
    h.pdf.mockImplementation(() => prepared.promise);
    h.finish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('LATE_FINISH_FAILED'));
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MEDIA_TIMEOUT');
    await flush();
    jest.advanceTimersByTime(60_000);
    await checked;
    prepared.resolve({ handle: 'late', pageCount: 1, excludedPages: 0 });
    await flush();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.markRecoveryRequired).toHaveBeenCalled();
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
  });

  it('attempts cancel and finish after rejected begin, even if cancel rejects', async () => {
    const h = harness();
    h.begin.mockRejectedValue(new Error('LOAD_FAILED'));
    h.cancel.mockRejectedValue(new Error('CANCEL_FAILED'));
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('LOAD_FAILED');
    const id = h.begin.mock.calls[0][0].requestId;
    expect(h.cancel).toHaveBeenCalledWith(id);
    expect(h.finish).toHaveBeenCalledWith(id);
    expect(h.discard).toHaveBeenCalledWith(id);
  });

  it('bounds hung begin and retains attachments when finish cannot acknowledge', async () => {
    const h = harness();
    h.begin.mockImplementation(() => new Promise<Frame>(() => {}));
    h.finish.mockImplementation(() => new Promise<void>(() => {}));
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();
    jest.advanceTimersByTime(5_000);
    await checked;
    expect(h.cancel).toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.markRecoveryRequired).toHaveBeenCalledWith(h.begin.mock.calls[0][0].requestId);
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
    expect(h.begin).toHaveBeenCalledTimes(1);
  });

  it('aborts mid-begin, waits for finish before discard, and ignores late results', async () => {
    const h = harness();
    const frame = deferred<Frame>();
    const finished = deferred<void>();
    const controller = new AbortController();
    h.begin.mockImplementation(() => frame.promise);
    h.finish.mockImplementation(() => finished.promise);
    const checked = expect(extractDocumentWithGemma(input, h.deps, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    await flush();
    controller.abort();
    await flush();
    const id = h.begin.mock.calls[0][0].requestId;
    expect(h.cancel).toHaveBeenCalledWith(id);
    expect(h.discard).not.toHaveBeenCalled();
    finished.resolve();
    await checked;
    expect(h.discard).toHaveBeenCalledTimes(1);
    frame.resolve({ requestId: id, text: JSON.stringify(document()), calls: [] });
    await flush();
    expect(h.discard).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('cleans late preparation after timeout and %s', async (settlement) => {
    const h = harness();
    const prepared = deferred<Awaited<ReturnType<MediaDeps['pdf']>>>();
    h.pdf.mockImplementation(() => prepared.promise);
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MEDIA_TIMEOUT');
    await flush();
    jest.advanceTimersByTime(60_000);
    await checked;
    expect(h.discard).not.toHaveBeenCalled();
    if (settlement === 'resolve') prepared.resolve({ handle: 'late', pageCount: 1, excludedPages: 0 });
    else prepared.reject(new Error('LATE_PREP_FAILED'));
    await flush();
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.discard).toHaveBeenCalledTimes(1);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.events[h.events.length - 2]).toMatch(/^finish:/);
    expect(h.events[h.events.length - 1]).toMatch(/^discard:/);
  });

  it('never deletes late preparation after an uncertain finish', async () => {
    const h = harness();
    const prepared = deferred<Awaited<ReturnType<MediaDeps['pdf']>>>();
    h.pdf.mockImplementation(() => prepared.promise);
    h.finish.mockRejectedValue(new Error('FINISH_FAILED'));
    const checked = expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
    await flush();
    jest.advanceTimersByTime(60_000);
    await checked;
    prepared.resolve({ handle: 'late', pageCount: 1, excludedPages: 0 });
    await flush();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.markRecoveryRequired).toHaveBeenCalled();
  });

  it('rejects success when aborted during cleanup and removes its listener', async () => {
    const h = harness();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const finished = deferred<void>();
    h.finish.mockImplementation(() => finished.promise);
    const checked = expect(extractDocumentWithGemma(input, h.deps, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    await flush();
    controller.abort();
    finished.resolve();
    await checked;
    expect(remove).toHaveBeenCalled();
    expect(h.discard).toHaveBeenCalledTimes(1);
  });

  it('latches failed discard instead of returning a successful document', async () => {
    const h = harness();
    h.discard.mockRejectedValue(new Error('DISCARD_FAILED'));
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
    expect(h.markRecoveryRequired).toHaveBeenCalled();
  });

  it('request B cleanup never targets request A or deletes A while its begin is pending', async () => {
    const h = harness();
    const frame = deferred<Frame>();
    h.begin.mockImplementationOnce(() => frame.promise).mockRejectedValueOnce(new Error('GEMMA_BUSY'));
    const a = extractDocumentWithGemma(input, h.deps);
    await flush();
    const aId = h.begin.mock.calls[0][0].requestId;
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_BUSY');
    const bId = h.begin.mock.calls[1][0].requestId;
    expect(bId).not.toBe(aId);
    expect(h.cancel).not.toHaveBeenCalledWith(aId);
    expect(h.finish).not.toHaveBeenCalledWith(aId);
    expect(h.discard).not.toHaveBeenCalledWith(aId);
    expect(h.discard).toHaveBeenCalledWith(bId);
    frame.resolve({ requestId: aId, text: JSON.stringify(document()), calls: [] });
    await a;
    expect(h.discard).toHaveBeenCalledWith(aId);
  });

  it('rejects mismatched frame IDs', async () => {
    const h = harness();
    h.begin.mockResolvedValue({ requestId: 'different', text: JSON.stringify(document()), calls: [] });
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('INVALID_MEDIA_MODEL_FRAME');
    expect(h.finish).toHaveBeenCalled();
  });
});

describe('A11 complete documents only (deferred execution)', () => {
  it.each([1, 5])('accepts %i pages and releases each after finish', async (pages) => {
    const h = harness(pages);
    await expect(extractDocumentWithGemma(input, h.deps)).resolves.toMatchObject({ entries: Array.from({ length: pages }, () => ({ type: 'expense', amount: 1 })) });
    expect(h.discard).toHaveBeenCalledTimes(pages);
    for (const [id] of h.discard.mock.calls) {
      expect(h.events.indexOf('finish:' + id)).toBeLessThan(h.events.indexOf('discard:' + id));
    }
  });
  it.each([6, 8])('rejects %i pages before inference', async (pages) => {
    const h = harness(pages);
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_PDF_TOO_MANY_PAGES');
    expect(h.begin).not.toHaveBeenCalled();
  });
  it.each([49, 50])('accepts %i rows without dropping entries', async (rows) => {
    const h = harness(1, rows);
    const result = await extractDocumentWithGemma(input, h.deps);
    expect(result.entries).toHaveLength(rows);
  });
  it.each([51, 150])('rejects %i rows from a single page', async (rows) => {
    const h = harness(1, rows);
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow(/TOO_MANY.*ENTRIES/);
  });
  it.each([[3, 17], [5, 30]])('rejects aggregate rows across %i pages of %i rows', async (pages, rows) => {
    const h = harness(pages, rows);
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_DOCUMENT_TOO_MANY_ENTRIES');
    expect(h.discard).toHaveBeenCalledTimes(pages);
  });
  it.each([NaN, Infinity, 0, -1, 1.5])('rejects invalid page count %s', async (pages) => {
    const h = harness(pages);
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_DOCUMENT_CHANGED');
    expect(h.begin).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1, 0.5, 1])('rejects invalid or excluded page metadata %s', async (excludedPages) => {
    const h = harness();
    h.pdf.mockImplementation(async () => ({ handle: 'image', pageCount: 1, excludedPages }));
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow();
    expect(h.begin).not.toHaveBeenCalled();
  });
  it('rejects a changed document without returning its first page', async () => {
    const h = harness(2);
    h.pdf.mockImplementation(async (_uri, page, id) => ({ handle: id, pageCount: page === 0 ? 2 : 3, excludedPages: 0 }));
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_DOCUMENT_CHANGED');
  });
  it('rejects multiple setup sections', async () => {
    const h = harness(2);
    h.begin.mockImplementation(async (request) => ({ requestId: request.requestId, text: JSON.stringify(document(0, { openingCash: 10 })), calls: [] }));
    await expect(extractDocumentWithGemma(input, h.deps)).rejects.toThrow('GEMMA_MULTI_PAGE_SETUP_REVIEW_REQUIRED');
  });
});
