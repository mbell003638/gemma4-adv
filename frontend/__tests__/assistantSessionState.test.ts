import { assertAssistantSessionReady, getAssistantSessionState, setAssistantSessionState } from '../src/utils/assistantSessionState';

afterEach(() => setAssistantSessionState({ storageReady: false, unlocked: false }));

test('assistant cannot read before storage and app unlock are both ready', () => {
  setAssistantSessionState({ storageReady: false, unlocked: false });
  expect(() => assertAssistantSessionReady()).toThrow('STORAGE_NOT_READY');
  setAssistantSessionState({ storageReady: true, unlocked: false });
  expect(() => assertAssistantSessionReady()).toThrow('APP_LOCKED');
});

test('lock changes invalidate an in-flight session epoch', () => {
  setAssistantSessionState({ storageReady: true, unlocked: true });
  const held = assertAssistantSessionReady().epoch;
  setAssistantSessionState({ storageReady: true, unlocked: false });
  setAssistantSessionState({ storageReady: true, unlocked: true });
  expect(getAssistantSessionState().epoch).toBeGreaterThan(held);
  expect(() => assertAssistantSessionReady(held)).toThrow('STALE_SESSION');
});
