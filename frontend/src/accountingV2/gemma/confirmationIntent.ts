export type ConfirmationIntent = 'confirm' | 'cancel' | 'other';
const confirmations = new Set(['yes', 'y', 'i confirm', 'confirm', 'apply', 'proceed', 'ok', 'okay', 'please apply', 'please record', 'please enter', 'please save']);
const cancellations = new Set(['no', 'n', 'cancel', 'stop', 'discard', 'never mind', 'nevermind']);
export function confirmationIntent(value: string): ConfirmationIntent {
  const text = value.trim().toLowerCase().replace(/[.!]+$/, '').trim().replace(/\s+/g, ' ');
  return cancellations.has(text) ? 'cancel' : confirmations.has(text) ? 'confirm' : 'other';
}

/** The screen uses this for both durable and legacy pending proposals. */
export async function handlePendingConfirmation(value: string, handlers: {
  confirm(): void | Promise<void>;
  cancel(): void | Promise<void>;
  clarify(): void | Promise<void>;
}): Promise<void> {
  const intent = confirmationIntent(value);
  if (intent === 'cancel') await handlers.cancel();
  else if (intent === 'confirm') await handlers.confirm();
  else await handlers.clarify();
}

/** Recheck the epoch after the asynchronous trusted scope lookup too. */
export async function requestIsCurrent(token: number, sequence: () => number, checkScope: () => Promise<boolean>): Promise<boolean> {
  if (token !== sequence()) return false;
  try {
    const current = await checkScope();
    return current && token === sequence();
  } catch { return false; }
}
