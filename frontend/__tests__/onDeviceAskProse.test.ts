const runOptionalOnDeviceModel = jest.fn();
// This suite exercises legacy prose only; Gemma availability is a separate boundary.
jest.mock('../src/accountingV2/gemma/liveGemmaAsk', () => ({
  askWithLiveGemma: jest.fn(async () => null),
}));

jest.mock('../src/utils/onDeviceLlm', () => ({
  __esModule: true,
  bestOnDevicePack: jest.fn(async () => ({ id: 'qwen', installed: true })),
  listOptionalOnDeviceModels: jest.fn(async () => [{ id: 'qwen', installed: true }]),
  interpretNeedleAskAction: jest.fn(async () => null),
  runOptionalOnDeviceModel: (...args: unknown[]) => runOptionalOnDeviceModel(...args),
}));

import { askBooksOnDevice } from '../src/accountingV2/onDeviceAsk';

const cfg = { interpretationProvider: 'device-only', apiKey: '' } as never;

describe('on-device Ask keeps a conversational reply', () => {
  beforeEach(() => runOptionalOnDeviceModel.mockReset());

  it('returns prose when the model answers a greeting in plain text', async () => {
    runOptionalOnDeviceModel.mockResolvedValue('Hello! How can I help you today?');
    const result = await askBooksOnDevice(cfg, 'Hi how are you?', 'CASH: 0');
    expect(result?.answer).toBe('Hello! How can I help you today?');
    expect(result?.action).toBeNull();
  });

  it('strips code fences a small model wraps around its reply', async () => {
    runOptionalOnDeviceModel.mockResolvedValue('```\nI am doing well, thanks.\n```');
    const result = await askBooksOnDevice(cfg, 'How are you?', 'CASH: 0');
    expect(result?.answer).toBe('I am doing well, thanks.');
  });

  it('still prefers a well-formed JSON answer', async () => {
    runOptionalOnDeviceModel.mockResolvedValue('{"answer":"Cash on hand is 500.","action":null}');
    const result = await askBooksOnDevice(cfg, 'How much cash?', 'CASH: 500');
    expect(result?.answer).toBe('Cash on hand is 500.');
  });

  it('does not present broken JSON as an answer', async () => {
    runOptionalOnDeviceModel.mockResolvedValue('{"answer": "unterminated');
    const result = await askBooksOnDevice(cfg, 'How much cash?', 'CASH: 500');
    // Half-parsed JSON is noise, not an answer: it must never reach the user.
    expect(result?.answer || '').not.toContain('unterminated');
  });

  it('lets the model answer questions that are not about the books', async () => {
    runOptionalOnDeviceModel.mockResolvedValue('ok');
    await askBooksOnDevice(cfg, 'Hi', 'CASH: 0');
    const prompt = String(runOptionalOnDeviceModel.mock.calls[0][0].prompt);
    expect(prompt).toMatch(/greeting, small talk, or general knowledge/i);
    expect(prompt).not.toMatch(/Answer from the snapshot only/i);
  });
});
