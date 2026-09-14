import type { Frame, NativeRequest } from '../src/accountingV2/gemma/agentCore';
import { acknowledgeGemmaRecovery } from '../src/accountingV2/gemma/runtimeHealth';
import {
  GemmaBridgeError,
  MAX_BEGIN_REQUEST_CHARS,
  MAX_RESUME_REQUEST_CHARS,
  createGemmaEngine,
  type GemmaNative,
} from '../src/utils/gemmaNative';

const request = (overrides: Partial<NativeRequest> = {}): NativeRequest => ({
  requestId: 'request-1',
  modelId: 'gemma4-e2b',
  mode: 'agent',
  system: 'You are the local Ledgr assistant.',
  input: 'What is the total?',
  tools: [],
  ...overrides,
});

const frame = (calls: Frame['calls'] = [], text = 'The total is 125.') =>
  JSON.stringify({ requestId: 'request-1', text, calls });

function fakeNative(overrides: Partial<GemmaNative> = {}): GemmaNative {
  return {
    gemmaBegin: jest.fn(async () => frame()),
    gemmaResume: jest.fn(async () => frame()),
    gemmaCancel: jest.fn(async () => undefined),
    gemmaFinish: jest.fn(async (requestId: string) => JSON.stringify({ requestId, finished: true })),
    ...overrides,
  };
}

describe('createGemmaEngine', () => {
  it('serialises a begin request and parses the reply', async () => {
    const native = fakeNative();
    const engine = createGemmaEngine(native);
    const result = await engine.begin(request());

    expect(native.gemmaBegin).toHaveBeenCalledWith(JSON.stringify(request()));
    expect(result).toEqual({ requestId: 'request-1', text: 'The total is 125.', calls: [] });
  });

  it('sends tool results back in order and cardinality', async () => {
    const native = fakeNative();
    const engine = createGemmaEngine(native);
    const results = [
      { callId: '1-0', name: 'read_total', result: { total: 125 } },
      { callId: '1-1', name: 'read_total', result: { total: 200 } },
    ];
    await engine.resume('request-1', results);

    expect(native.gemmaResume).toHaveBeenCalledWith(JSON.stringify({ requestId: 'request-1', results }));
  });

  it('parses every reply rather than casting it', async () => {
    const engine = createGemmaEngine(fakeNative({ gemmaBegin: async () => 'not JSON' }));
    await expect(engine.begin(request())).rejects.toThrow();
  });

  it('rejects a frame that is not the agreed shape', async () => {
    const engine = createGemmaEngine(fakeNative({
      gemmaBegin: async () => JSON.stringify({ requestId: 'request-1', text: 'hi' }),
    }));
    await expect(engine.begin(request())).rejects.toThrow('INVALID_MODEL_FRAME');
  });

  it('rejects duplicate call ids from native', async () => {
    const call = { id: '1', name: 'read_total', arguments: {} };
    const engine = createGemmaEngine(fakeNative({ gemmaBegin: async () => frame([call, call], '') }));
    await expect(engine.begin(request())).rejects.toThrow('INVALID_TOOL_CALL');
  });

  it('rejects an oversized frame', async () => {
    const engine = createGemmaEngine(fakeNative({
      gemmaBegin: async () => JSON.stringify({ requestId: 'request-1', text: 'x'.repeat(25_000), calls: [] }),
    }));
    await expect(engine.begin(request())).rejects.toThrow('RESPONSE_TOO_LARGE');
  });

  it('refuses an oversized request before it reaches native', async () => {
    const native = fakeNative();
    const engine = createGemmaEngine(native);
    const huge = request({ input: 'x'.repeat(MAX_BEGIN_REQUEST_CHARS) });

    await expect(engine.begin(huge)).rejects.toThrow(GemmaBridgeError);
    await expect(engine.begin(huge)).rejects.toThrow('REQUEST_TOO_LARGE');
    expect(native.gemmaBegin).not.toHaveBeenCalled();
  });

  it('refuses an oversized resume payload before it reaches native', async () => {
    const native = fakeNative();
    const engine = createGemmaEngine(native);
    const bulky = [{ callId: '1-0', name: 'read_total', result: { rows: 'x'.repeat(MAX_RESUME_REQUEST_CHARS) } }];

    await expect(engine.resume('request-1', bulky)).rejects.toThrow('REQUEST_TOO_LARGE');
    expect(native.gemmaResume).not.toHaveBeenCalled();
  });

  it('passes cancel and finish straight through', async () => {
    const native = fakeNative();
    const engine = createGemmaEngine(native);
    await engine.cancel('request-1');
    await engine.finish('request-1');

    expect(native.gemmaCancel).toHaveBeenCalledWith('request-1');
    expect(native.gemmaFinish).toHaveBeenCalledWith('request-1');
  });

  it('refuses a malformed lifecycle acknowledgement', async () => {
    const engine = createGemmaEngine(fakeNative({ gemmaFinish: async () => 'not JSON at all' }));
    try {
      await expect(engine.finish('request-1')).rejects.toThrow('GEMMA_LIFECYCLE_REPLY_INVALID');
    } finally {
      acknowledgeGemmaRecovery('request-1');
    }
  });
});

describe('bridge availability off Android', () => {
  it('reports unsupported instead of throwing when there is no native module', async () => {
    // The Jest environment has no React Native runtime, which is exactly the
    // web/Expo Go case: the loader must return null rather than throw.
    const { loadGemmaNative, gemmaBridgeStatus, resolveGemmaEngine } = await import('../src/utils/gemmaNative');

    expect(loadGemmaNative()).toBeNull();

    const status = await gemmaBridgeStatus();
    expect(status.gemmaBridgeAvailable).toBe(false);
    expect(status.bridgeVersion).toBe(0);
    expect(status.verifiedCapabilities).toEqual([]);
    expect(status.reason).toBeTruthy();

    const resolved = await resolveGemmaEngine();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('NO_NATIVE_BRIDGE');
  });
});
