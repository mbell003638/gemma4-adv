/** Lifecycle acknowledgements are host metadata, never model frames. */
export function assertLifecycleAcknowledgement(raw: unknown, requestId: string): void {
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error('GEMMA_LIFECYCLE_REPLY_INVALID');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('GEMMA_LIFECYCLE_REPLY_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GEMMA_LIFECYCLE_REPLY_INVALID');
  const reply = value as Record<string, unknown>;
  if (reply.requestId !== requestId || reply.finished !== true) throw new Error('GEMMA_LIFECYCLE_REPLY_INVALID');
}
