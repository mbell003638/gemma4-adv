export type AssistantSessionState = {
  storageReady: boolean;
  unlocked: boolean;
  epoch: number;
};

let state: AssistantSessionState = { storageReady: false, unlocked: false, epoch: 0 };

/** Mirrors the root app-lock/storage boundary for non-React assistant code. */
export function setAssistantSessionState(next: Pick<AssistantSessionState, 'storageReady' | 'unlocked'>): void {
  if (state.storageReady === next.storageReady && state.unlocked === next.unlocked) return;
  state = { ...next, epoch: state.epoch + 1 };
}

export function getAssistantSessionState(): Readonly<AssistantSessionState> {
  return state;
}

export function assertAssistantSessionReady(heldEpoch?: number): AssistantSessionState {
  if (!state.storageReady) throw new Error('STORAGE_NOT_READY');
  if (!state.unlocked) throw new Error('APP_LOCKED');
  if (heldEpoch !== undefined && heldEpoch !== state.epoch) throw new Error('STALE_SESSION');
  return state;
}

