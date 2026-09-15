import { activeSqlRunner } from '../../db/backend';
import { sameScope, type ScopedDraft, type Obj, type Scope } from './agentCore';
import { toScope } from './branchPorts';
import { liveBookContext } from './liveBookContext';
import { cancelProposal, createProposalExecutor } from './proposalExecutor';
import { ProposalStore } from './proposalStore';
import { LIVE_GEMMA_PROPOSALS, operationEnabled } from './liveProposalPolicy';

function db() {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('SQLITE_NOT_READY');
  return runner;
}
async function currentScope(): Promise<Scope> { return toScope(await liveBookContext()); }

export type DurableProposalPreview = { id: string; preview: string; destructive: boolean };

export async function captureAssistantScope(): Promise<Scope> { return { ...await currentScope() }; }
export async function assistantScopeIsCurrent(scope: Scope, afterWrite = false): Promise<boolean> {
  try {
    const current = await currentScope();
    // A successful write advances revision, but never changes its authority.
    return sameScope(afterWrite ? { ...scope, revision: current.revision } : scope, current);
  } catch { return false; }
}

export async function stageLiveProposal(input: ScopedDraft): Promise<DurableProposalPreview> {
  // Snapshot every field before the first await, including the displayed preview.
  const envelope = JSON.parse(JSON.stringify(input)) as ScopedDraft;
  if (!envelope?.scope || !envelope.requestId || !envelope.draft) throw new Error('STALE_SCOPE');
  const { draft, requestId } = envelope;
  if (!LIVE_GEMMA_PROPOSALS.has(draft.operation)) throw new Error('PROPOSAL_NOT_LIVE');
  const scope = Object.freeze({ ...envelope.scope });
  if (!sameScope(scope, await currentScope())) throw new Error('STALE_SCOPE');
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const store = new ProposalStore(db());
  const stored = await store.create({
    id: `proposal-${nonce}`, requestId, operation: draft.operation,
    normalized: draft.normalized, scope, entityVersions: draft.entityVersions,
  });
  try {
    if (!sameScope(scope, await currentScope())) throw new Error('STALE_SCOPE');
  } catch {
    await cancelProposal(store, stored.id).catch(() => undefined);
    throw new Error('STALE_SCOPE');
  }
  return { id: stored.id, preview: draft.preview, destructive: draft.destructive };
}

function executorPorts(runner: ReturnType<typeof db>) {
  return {
    currentScope,
    entityRevisions: async (ids: readonly string[], scope: Scope) => {
      const out: Record<string, string | null> = {};
      for (const id of ids) {
        const row = await runner.first<{ revision: number }>('SELECT MAX(revision) revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?', [scope.bookId, id]);
        out[id] = row ? String(Number(row.revision || 0)) : null;
      }
      return out;
    },
    isPeriodOpen: async (_operation: string, normalized: Obj, scope: Scope) => {
      const date = String(normalized.date || scope.today);
      return Boolean(await runner.first("SELECT 1 ok FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? LIMIT 1", [scope.bookId, date, date]));
    },
    canApply: async (operation: string, expected: Scope) => {
      const current = await currentScope();
      let features: string[] = [];
      try {
        const value: unknown = JSON.parse(current.featureEpoch);
        features = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      } catch { features = []; }
      return LIVE_GEMMA_PROPOSALS.has(operation) && sameScope(expected, current) && operationEnabled(operation, features);
    },
    apply: async (operation: string, normalized: Obj, scope: Scope, tx: ReturnType<typeof db>) => {
      const { createTransactionActionPort } = await import('./transactionActionPort');
      return createTransactionActionPort()(operation, normalized, scope, tx);
    },
  };
}

export async function confirmLiveProposal(id: string) {
  const runner = db();
  return createProposalExecutor(new ProposalStore(runner), executorPorts(runner))(id);
}
export async function cancelLiveProposal(id: string): Promise<void> {
  await cancelProposal(new ProposalStore(db()), id);
}
