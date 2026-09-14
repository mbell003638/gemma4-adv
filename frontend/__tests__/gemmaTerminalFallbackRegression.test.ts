const mockGemma = jest.fn();
const mockStage = jest.fn();
const mockFallback = jest.fn();
jest.mock('../src/accountingV2/gemma/liveGemmaAsk', () => ({ askWithLiveGemma: (...args: unknown[]) => mockGemma(...args) }));
jest.mock('../src/accountingV2/gemma/liveProposalController', () => ({ stageLiveProposal: (...args: unknown[]) => mockStage(...args) }));
jest.mock('../src/utils/onDeviceLlm', () => ({
  interpretNeedleAskAction: jest.fn(async () => null),
  runNeedleAgentTurn: jest.fn(async () => ({ kind: 'none' })),
  bestOnDevicePack: (...args: unknown[]) => mockFallback(...args),
  runOptionalOnDeviceModel: jest.fn(async () => 'legacy reply'),
}));
import { askBooksOnDevice } from '../src/accountingV2/onDeviceAsk';
const ask = () => askBooksOnDevice({ interpretationProvider: 'device-only' } as never, 'show total', '');
beforeEach(() => {
  jest.clearAllMocks();
  mockGemma.mockReset(); mockStage.mockReset();
  mockFallback.mockReset().mockResolvedValue({ id: 'legacy' });
});
test.each(['STALE_SCOPE', 'CANCELLED', 'NATIVE_RECOVERY_REQUIRED', 'STALE_RESPONSE', 'BUSY'])('terminal outcome: %s', async code => {
  mockGemma.mockResolvedValue({ kind: 'stopped', code });
  expect(await ask()).toMatchObject({ action: null });
  expect(mockFallback).not.toHaveBeenCalled(); expect(mockStage).not.toHaveBeenCalled();
});
test.each(['STALE_SCOPE', 'CANCELLED', 'NATIVE_RECOVERY_REQUIRED'])('terminal exception: %s', async code => {
  mockGemma.mockRejectedValue(new Error(code));
  expect(await ask()).toMatchObject({ action: null });
  expect(mockFallback).not.toHaveBeenCalled();
});
test('stale staging never falls back', async () => {
  mockGemma.mockResolvedValue({ kind: 'proposal', proposal: { requestId: 'r' } });
  mockStage.mockRejectedValue(new Error('STALE_SCOPE'));
  expect(await ask()).toMatchObject({ action: null });
  expect(mockFallback).not.toHaveBeenCalled();
});
test('explicit unavailable runtime permits legacy fallback', async () => {
  mockGemma.mockResolvedValue(null);
  expect(await ask()).toMatchObject({ answer: 'legacy reply', action: null });
  expect(mockFallback).toHaveBeenCalledTimes(1);
});
