import { discardGemmaAttachments, recoverGemmaRuntime } from '../src/utils/gemmaNative';
import { acknowledgeGemmaRecovery, gemmaRecoveryRequest, markGemmaRecoveryRequired } from '../src/accountingV2/gemma/runtimeHealth';

let mockStatus: { gemmaRecoveryRequired: boolean; gemmaAdmittedRequestId: string | null };
const mockNative = {
  getStatus: jest.fn(async () => mockStatus),
  gemmaBegin: jest.fn(async () => '{}'),
  gemmaResume: jest.fn(async () => '{}'),
  gemmaCancel: jest.fn(async () => undefined),
  gemmaFinish: jest.fn(async (requestId: string) => JSON.stringify({ requestId, finished: true })),
  gemmaRecover: jest.fn(async (requestId: string) => JSON.stringify({ requestId, finished: true })),
};
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {} }));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mockNative }));

beforeEach(() => {
  mockStatus = { gemmaRecoveryRequired: false, gemmaAdmittedRequestId: null };
  jest.clearAllMocks();
  mockNative.gemmaRecover.mockImplementation(async requestId => JSON.stringify({ requestId, finished: true }));
});
afterEach(() => {
  jest.useRealTimers();
  for (let id = gemmaRecoveryRequest(); id !== null; id = gemmaRecoveryRequest()) acknowledgeGemmaRecovery(id);
});

test('an idle status still requires a queued native acknowledgement', async () => {
  markGemmaRecoveryRequired('a');
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(r => { resolve = r; });
  mockNative.gemmaRecover.mockReturnValue(pending);
  const recovering = recoverGemmaRuntime();
  expect(gemmaRecoveryRequest()).toBe('a');
  resolve('{"requestId":"a","finished":true}');
  await recovering;
  expect(mockNative.gemmaRecover).toHaveBeenCalledWith('a');
  expect(gemmaRecoveryRequest()).toBeNull();
});

test('recovery for A cannot cancel or unload active B', async () => {
  markGemmaRecoveryRequired('a');
  mockStatus.gemmaAdmittedRequestId = 'b';
  await expect(recoverGemmaRuntime()).rejects.toThrow('GEMMA_BUSY');
  expect(mockNative.gemmaRecover).not.toHaveBeenCalled();
  expect(gemmaRecoveryRequest()).toBe('a');
});

test('a wrong acknowledgement preserves recovery admission blocking', async () => {
  markGemmaRecoveryRequired('a');
  mockNative.gemmaRecover.mockResolvedValue('{"requestId":"b","finished":true}');
  await expect(recoverGemmaRuntime()).rejects.toThrow('GEMMA_LIFECYCLE_REPLY_INVALID');
  expect(gemmaRecoveryRequest()).toBe('a');
});

test('poisoned native state requires restart and is not cleared locally', async () => {
  markGemmaRecoveryRequired('a');
  mockStatus.gemmaRecoveryRequired = true;
  await expect(recoverGemmaRuntime()).rejects.toThrow('RESTART_APP_REQUIRED');
  expect(mockNative.gemmaRecover).not.toHaveBeenCalled();
  expect(gemmaRecoveryRequest()).toBe('a');
});

test('missing attachment cleanup is an error rather than a successful zero removal', async () => {
  await expect(discardGemmaAttachments('a')).rejects.toThrow('GEMMA_BRIDGE_UNAVAILABLE');
});

test('timed-out recovery does not clear its latch on a late native reply', async () => {
  jest.useFakeTimers();
  markGemmaRecoveryRequired('a');
  let resolve!: (value: string) => void;
  mockNative.gemmaRecover.mockReturnValue(new Promise<string>(r => { resolve = r; }));
  const checked = expect(recoverGemmaRuntime()).rejects.toThrow('NATIVE_CLEANUP_TIMEOUT');
  await jest.advanceTimersByTimeAsync(6000);
  await checked;
  expect(gemmaRecoveryRequest()).toBe('a');
  resolve('{"requestId":"a","finished":true}');
  await Promise.resolve();
  expect(gemmaRecoveryRequest()).toBe('a');
});
