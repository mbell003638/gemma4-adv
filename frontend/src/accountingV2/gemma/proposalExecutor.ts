/** Manus on-device: confirmation infrastructure; domain adapters remain branch-specific. */
/**
 * The confirmation path: turning a reviewed proposal into exactly one
 * accounting effect (stage P5).
 *
 * The eight-step protocol from `01-architecture.md` section 5 lands here as
 * steps 5 to 8. Everything before it — parsing, entity resolution, normalizing,
 * preview — happened in `prepare`, with zero writes.
 *
 * Two properties are the whole point of this file:
 *
 *   1. **`confirm` takes only an id.** It accepts no action parameters. If a
 *      caller could pass params alongside the id, the reviewed preview and the
 *      thing actually posted would be two different objects, and every check
 *      before this would be theatre.
 *   2. **Nothing is marked applied before it posts.** The state change and the
 *      domain write share one savepoint, so a failure rolls back both —
 *      including any party the write materialized on the way.
 *
 * The domain write itself is injected (`apply`). This file deliberately does
 * not know how to post an expense: that logic already exists and is already
 * tested, and re-implementing it here would create a second accounting path to
 * keep correct.
 */
import type { Obj, Scope } from './agentCore';
import { sameScope } from './agentCore';
import { ProposalStore, proposalDigest, type StoredProposal } from './proposalStore';
import type { SqlRunner } from '../../db/schema';

export class ProposalRejected extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ProposalRejected';
  }
}

export type ConfirmOutcome =
  | { kind: 'applied'; result: Obj; replayed: boolean }
  | { kind: 'rejected'; code: string };

export type ExecutorPorts = {
  /** The live scope. Compared against the stored one; a difference rejects. */
  currentScope(): Promise<Scope>;
  /**
   * Current revisions for the entities the proposal depends on.
   *
   * Returns the live revision per id, or null when the entity is gone. A value
   * that differs from what the preview was built on means the record changed —
   * including by sync — and the user must review a fresh proposal.
   */
  entityRevisions(ids: readonly string[], scope: Scope): Promise<Record<string, string | null>>;
  /** False when the accounting period for this proposal's date is closed. */
  isPeriodOpen(operation: string, normalized: Obj, scope: Scope): Promise<boolean>;
  /** True when this actor may still perform this operation. */
  canApply(operation: string, scope: Scope): Promise<boolean>;
  /**
   * Performs the real domain write and returns its committed identifiers.
   *
   * This is the branch's existing action executor — the `applyAction` switch
   * extracted from the Ask screen — behind a port. It must post through the
   * normal domain services so every existing invariant, feature guard, sync
   * outbox entry and reversal rule still applies. It must NOT open its own
   * top-level BEGIN: it runs inside this executor's savepoint.
   * The global sync mutation lock is already held. Use the supplied runner
   * and withSyncOperationLocked/enqueueSyncOperation; do not re-enter the
   * public withSyncOperation wrapper or an api.* method that takes that lock.
   */
  apply(operation: string, normalized: Obj, scope: Scope, db: SqlRunner): Promise<Obj>;
};

/**
 * Builds the confirmation executor.
 *
 * One instance per app process, sharing the `SqlRunner` the store was built
 * with, so the savepoint below actually encloses the domain writes.
 */
export function createProposalExecutor(store: ProposalStore, ports: ExecutorPorts) {
  /**
   * Confirms a proposal by id.
   *
   * NOTE the signature: `(id: string)`. Adding an overload that accepts
   * replacement parameters would defeat the digest check and is the single
   * change most likely to reintroduce the vulnerability this design removes.
   */
  return async function confirm(id: string): Promise<ConfirmOutcome> {
    if (!id || typeof id !== 'string') return { kind: 'rejected', code: 'INVALID_PROPOSAL_ID' };

    try {
      return await store.tx(async (db) => {
        await store.expireStale();
        // Re-read after admission: a second tap must observe the first commit.
        const existing = await store.find(id);
        if (!existing) return { kind: 'rejected', code: 'PROPOSAL_NOT_FOUND' };
        const scope = await ports.currentScope();
        if (existing.state === 'applied') {
          // Posting normally advances the data revision. A retry may return
          // its receipt, but only within the same current authority boundary.
          if (existing.bookId !== scope.bookId || existing.actorId !== scope.actorId
            || existing.scope.locationId !== scope.locationId
            || existing.scope.permissionEpoch !== scope.permissionEpoch
            || existing.scope.featureEpoch !== scope.featureEpoch) throw new ProposalRejected('STALE_SCOPE');
          if (!await ports.canApply(existing.operation, scope)) throw new ProposalRejected('FORBIDDEN');
          if (!existing.result) throw new ProposalRejected('APPLIED_WITHOUT_RESULT');
          return { kind: 'applied', result: existing.result, replayed: true };
        }
        if (!sameScope(existing.scope, scope)) throw new ProposalRejected('STALE_SCOPE');
        if (existing.state !== 'pending') return { kind: 'rejected', code: `PROPOSAL_${existing.state.toUpperCase()}` };
        return commit(existing, db);
      });
    } catch (error) {
      if (error instanceof ProposalRejected) return { kind: 'rejected', code: error.code };
      // An unknown failure has already rolled the savepoint back. The proposal
      // stays pending, so the user can retry or discard it; nothing claims to
      // have been recorded.
      return { kind: 'rejected', code: 'COMMIT_FAILED' };
    }
  };

  async function commit(proposal: StoredProposal, db: SqlRunner): Promise<ConfirmOutcome> {
    // Step 6, re-checked inside the transaction boundary rather than trusted
    // from when the preview was built.
    const scope = await ports.currentScope();
    if (!sameScope(proposal.scope, scope)) throw new ProposalRejected('STALE_SCOPE');
    if (proposal.bookId !== scope.bookId) throw new ProposalRejected('WRONG_BOOK');
    if (proposal.actorId !== scope.actorId) throw new ProposalRejected('WRONG_ACTOR');

    // The digest covers the operation, the normalized payload, the scope and
    // the entity versions -- i.e. everything the user was shown.
    const recomputed = proposalDigest({
      operation: proposal.operation,
      normalized: proposal.normalized,
      scope: proposal.scope,
      entityVersions: proposal.entityVersions,
    });
    if (recomputed !== proposal.digest) throw new ProposalRejected('PROPOSAL_TAMPERED');

    if (!await ports.canApply(proposal.operation, scope)) throw new ProposalRejected('FORBIDDEN');

    const ids = Object.keys(proposal.entityVersions);
    if (ids.length) {
      const live = await ports.entityRevisions(ids, scope);
      for (const entityId of ids) {
        const current = live[entityId];
        if (current === null || current === undefined) throw new ProposalRejected('ENTITY_GONE');
        // A sync-applied edit counts: the invoice the preview allocated against
        // may already be paid.
        if (current !== proposal.entityVersions[entityId]) throw new ProposalRejected('ENTITY_CHANGED');
      }
    }

    if (!await ports.isPeriodOpen(proposal.operation, proposal.normalized, scope)) {
      throw new ProposalRejected('PERIOD_CLOSED');
    }

    // Step 7. The write and the state change share this savepoint, so a
    // failure after a party was materialized rolls the party back too.
    if (!sameScope(scope, await ports.currentScope())) throw new ProposalRejected('STALE_SCOPE');
    if (store.isExpired(proposal)) throw new ProposalRejected('PROPOSAL_EXPIRED');
    const latest = await store.find(proposal.id);
    if (latest?.state !== 'pending') throw new ProposalRejected('PROPOSAL_NOT_PENDING');
    const result = await ports.apply(proposal.operation, proposal.normalized, scope, db);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ProposalRejected('DOMAIN_RETURNED_NO_RESULT');
    }
    // Step 8: only a real committed identifier lets the UI say "recorded".
    if (!Object.keys(result).length) throw new ProposalRejected('DOMAIN_RETURNED_NO_RESULT');

    await store.markApplied(proposal.id, result);
    const confirmed = await store.find(proposal.id);
    if (confirmed?.state !== 'applied') throw new ProposalRejected('APPLY_NOT_RECORDED');

    return { kind: 'applied', result, replayed: false };
  }
}

/**
 * Cancels a proposal the user dismissed.
 *
 * Separate from expiry so a dismissed draft cannot be revived by a clock
 * change, and so the reason is visible in the row.
 */
export async function cancelProposal(store: ProposalStore, id: string): Promise<void> {
  await store.markCancelled(id);
}
