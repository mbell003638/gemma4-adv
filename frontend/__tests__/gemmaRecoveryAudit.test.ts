import { createGemmaEngine, type GemmaNative } from '../src/utils/gemmaNative';
import { assertLifecycleAcknowledgement } from '../src/utils/gemmaLifecycleReply';
import { acknowledgeGemmaRecovery, assertGemmaHealthy, gemmaRecoveryRequest, markGemmaRecoveryRequired } from '../src/accountingV2/gemma/runtimeHealth';

afterEach(() => {
  for (let id = gemmaRecoveryRequest(); id !== null; id = gemmaRecoveryRequest()) acknowledgeGemmaRecovery(id);
});

test('recovering a later failed request cannot erase an earlier unresolved request', () => {
  markGemmaRecoveryRequired('first');
  markGemmaRecoveryRequired('late');
  expect(gemmaRecoveryRequest()).toBe('first');
  acknowledgeGemmaRecovery('late');
  expect(() => assertGemmaHealthy()).toThrow('NATIVE_RECOVERY_REQUIRED');
  acknowledgeGemmaRecovery('unrelated');
  expect(gemmaRecoveryRequest()).toBe('first');
  acknowledgeGemmaRecovery('first');
  expect(() => assertGemmaHealthy()).not.toThrow();
});

test.each(['{}', 'null', '[]', 'not-json', '{"requestId":"other","finished":true}', '{"requestId":"a","finished":false}'])(
  'a lifecycle reply cannot acknowledge another or unfinished request: %s', raw => {
    expect(() => assertLifecycleAcknowledgement(raw, 'a')).toThrow('GEMMA_LIFECYCLE_REPLY_INVALID');
  },
);

test('a failed acknowledgement blocks a newly constructed wrapper before native inference', async () => {
  const native: GemmaNative = {
    gemmaBegin: jest.fn(async () => '{"requestId":"next","text":"ok","calls":[]}'),
    gemmaResume: jest.fn(async () => '{"requestId":"next","text":"ok","calls":[]}'),
    gemmaCancel: jest.fn(async () => undefined),
    gemmaFinish: jest.fn(async () => '{"requestId":"wrong","finished":true}'),
  };
  await expect(createGemmaEngine(native).finish('a')).rejects.toThrow('GEMMA_LIFECYCLE_REPLY_INVALID');
  const fresh = createGemmaEngine(native);
  await expect(fresh.begin({ requestId: 'next', modelId: 'gemma4-e2b', mode: 'agent', system: 's', input: 'i', tools: [] })).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
  await expect(fresh.resume('next', [])).rejects.toThrow('NATIVE_RECOVERY_REQUIRED');
  expect(native.gemmaBegin).not.toHaveBeenCalled();
  expect(native.gemmaResume).not.toHaveBeenCalled();
  // Cancellation and cleanup remain available while admission is blocked.
  await fresh.cancel('a');
  expect(native.gemmaCancel).toHaveBeenCalledWith('a');
});

test('only the explicit finished acknowledgement for the requested id is accepted', () => {
  expect(() => assertLifecycleAcknowledgement('{"requestId":"a","finished":true}', 'a')).not.toThrow();
});
