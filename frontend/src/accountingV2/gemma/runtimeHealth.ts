// Late cleanup failures must not overwrite an earlier request's unresolved state.
const failedRequests = new Set<string>();
export function markGemmaRecoveryRequired(requestId: string): void { failedRequests.add(requestId); }
export function gemmaRecoveryRequest(): string | null { return failedRequests.values().next().value ?? null; }
export function assertGemmaHealthy(): void {
  if (failedRequests.size !== 0) throw new Error('NATIVE_RECOVERY_REQUIRED');
}
export function acknowledgeGemmaRecovery(requestId: string): void {
  failedRequests.delete(requestId);
}
