/** Manus on-device: confirmation infrastructure; domain adapters remain branch-specific. */
/**
 * Durable storage for reviewed assistant proposals (stage P5).
 *
 * A proposal is a draft, not a ledger mutation, so writing one here is not an
 * accounting change and the `prepare` path stays free of domain side effects.
 * It is stored rather than kept in chat state for one specific reason: the UI
 * must be able to confirm by **id**. If the action lived in the conversation as
 * text, then a quoted message, a scanned document or a stale chat bubble could
 * be replayed as authority. An id can be checked against a row that carries its
 * own scope, digest, expiry and entity revisions.
 *
 * Transactions use SAVEPOINT, not BEGIN/COMMIT, matching `V2SqlRepository.tx`
 * and `bookConfigRepository` — the sqlite store may already have an outer
 * transaction open, and a nested BEGIN throws "cannot start a transaction
 * within a transaction".
 */
import type { SqlRunner } from '../../db/schema';
import type { Obj, Scope } from './agentCore';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { withSyncDatabaseMutationLock } from '../../sync/databaseMutex';

export type ProposalState = 'pending' | 'applied' | 'cancelled' | 'expired';

export type StoredProposal = {
  id: string;
  bookId: string;
  actorId: string;
  requestId: string;
  operation: string;
  normalized: Obj;
  scope: Scope;
  entityVersions: Record<string, string>;
  digest: string;
  expiresAt: string;
  state: ProposalState;
  result: Obj | null;
  createdAt: string;
};

export class ProposalStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ProposalStoreError';
  }
}

/** Default review window. A proposal the user leaves open goes stale, not live. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

let savepointSequence = 0;
// SQLite savepoints nest on a connection; they do not serialize JS callers.
// Share the queue across stores/executors using that same connection.
const transactionTails = new WeakMap<SqlRunner, Promise<void>>();

/**
 * A stable digest of everything the user was shown.
 *
 * Confirmation checks this, so an operation, an amount or a resolved entity id
 * that changed between preview and commit invalidates the proposal instead of
 * posting something the user never saw. Keys are sorted so the same content
 * always produces the same digest.
 */
export function proposalDigest(input: {
  operation: string;
  normalized: Obj;
  scope: Scope;
  entityVersions: Record<string, string>;
}): string {
  const canonical = stable({
    operation: input.operation,
    normalized: input.normalized,
    scope: input.scope as unknown as Obj,
    entityVersions: input.entityVersions as unknown as Obj,
  });
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseObject(raw: string, field: string): Obj {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProposalStoreError('CORRUPT_PROPOSAL_ROW', `${field} is not an object`);
  }
  return value as Obj;
}

type Row = {
  id: string; book_id: string; actor_id: string; request_id: string; operation: string;
  normalized_json: string; scope_json: string; entity_versions_json: string;
  digest: string; expires_at: string; state: string; result_json: string | null; created_at: string;
};

function toProposal(row: Row): StoredProposal {
  const state = row.state as ProposalState;
  if (!['pending', 'applied', 'cancelled', 'expired'].includes(state)) {
    throw new ProposalStoreError('CORRUPT_PROPOSAL_ROW', 'unknown state');
  }
  return {
    id: row.id,
    bookId: row.book_id,
    actorId: row.actor_id,
    requestId: row.request_id,
    operation: row.operation,
    normalized: parseObject(row.normalized_json, 'normalized_json'),
    scope: parseObject(row.scope_json, 'scope_json') as unknown as Scope,
    entityVersions: parseObject(row.entity_versions_json, 'entity_versions_json') as Record<string, string>,
    digest: row.digest,
    expiresAt: row.expires_at,
    state,
    result: row.result_json === null ? null : parseObject(row.result_json, 'result_json'),
    createdAt: row.created_at,
  };
}

export class ProposalStore {
  constructor(private readonly db: SqlRunner, private readonly now: () => Date = () => new Date()) {}

  isExpired(proposal: StoredProposal): boolean {
    const expiry = Date.parse(proposal.expiresAt);
    return !Number.isFinite(expiry) || expiry <= this.now().getTime();
  }

  /**
   * Stores a draft.
   *
   * `UNIQUE(book_id, request_id)` means one turn yields at most one proposal:
   * a model that emitted two writes cannot leave two confirmable drafts behind.
   */
  async create(input: {
    id: string;
    requestId: string;
    operation: string;
    normalized: Obj;
    scope: Scope;
    entityVersions: Record<string, string>;
    ttlMs?: number;
  }): Promise<StoredProposal> {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + (input.ttlMs ?? PROPOSAL_TTL_MS));
    const digest = proposalDigest(input);
    const row = {
      id: input.id,
      book_id: input.scope.bookId,
      actor_id: input.scope.actorId,
      request_id: input.requestId,
      operation: input.operation,
      normalized_json: JSON.stringify(input.normalized),
      scope_json: JSON.stringify(input.scope),
      entity_versions_json: JSON.stringify(input.entityVersions),
      digest,
      expires_at: expiresAt.toISOString(),
      state: 'pending' as const,
      result_json: null,
      created_at: createdAt.toISOString(),
    };
    await this.db.run(
      `INSERT INTO assistant_proposals
       (id, book_id, actor_id, request_id, operation, normalized_json, scope_json,
        entity_versions_json, digest, expires_at, state, result_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.book_id, row.actor_id, row.request_id, row.operation, row.normalized_json,
        row.scope_json, row.entity_versions_json, row.digest, row.expires_at, row.state,
        row.result_json, row.created_at],
    );
    return toProposal(row as Row);
  }

  async find(id: string): Promise<StoredProposal | null> {
    const row = await this.db.first<Row>('SELECT * FROM assistant_proposals WHERE id = ?', [id]);
    return row ? toProposal(row) : null;
  }

  /** Marks applied and records the committed result, in one statement. */
  async markApplied(id: string, result: Obj): Promise<void> {
    await this.db.run(
      `UPDATE assistant_proposals SET state = 'applied', result_json = ?
       WHERE id = ? AND state = 'pending'`,
      [JSON.stringify(result), id],
    );
  }

  async markCancelled(id: string): Promise<void> {
    await this.db.run(
      "UPDATE assistant_proposals SET state = 'cancelled' WHERE id = ? AND state = 'pending'",
      [id],
    );
  }

  /**
   * Expires anything past its window.
   *
   * Called before a confirmation and when the assistant screen opens, so a
   * proposal cannot sit pending for an hour and then apply to a book whose
   * numbers have moved on.
   */
  async expireStale(): Promise<number> {
    const nowIso = this.now().toISOString();
    const stale = await this.db.all<{ id: string }>(
      "SELECT id FROM assistant_proposals WHERE state = 'pending' AND expires_at <= ?",
      [nowIso],
    );
    if (stale.length) {
      await this.db.run(
        "UPDATE assistant_proposals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?",
        [nowIso],
      );
    }
    return stale.length;
  }

  /**
   * Cancels every pending draft for a book.
   *
   * Used on lock, logout, book switch, role change and model switch: a draft
   * prepared under one scope must never become confirmable under another.
   */
  async cancelPendingForBook(bookId: string): Promise<number> {
    const pending = await this.db.all<{ id: string }>(
      "SELECT id FROM assistant_proposals WHERE book_id = ? AND state = 'pending'",
      [bookId],
    );
    if (pending.length) {
      await this.db.run(
        "UPDATE assistant_proposals SET state = 'cancelled' WHERE book_id = ? AND state = 'pending'",
        [bookId],
      );
    }
    return pending.length;
  }

  /** Drops a book's drafts with the book. Drafts are not synced by default. */
  async deleteForBook(bookId: string): Promise<void> {
    await this.db.run('DELETE FROM assistant_proposals WHERE book_id = ?', [bookId]);
  }

  /**
   * Runs `fn` inside a savepoint.
   *
   * SAVEPOINT rather than BEGIN so this composes with an outer transaction the
   * sqlite store may already have opened, and so the domain writes the executor
   * performs roll back together with the state change that records them.
   */
  async tx<T>(fn: (db: SqlRunner) => Promise<T>): Promise<T> {
    const previous = transactionTails.get(this.db) ?? Promise.resolve();
    let unlock!: () => void;
    const tail = new Promise<void>((resolve) => { unlock = resolve; });
    transactionTails.set(this.db, tail);
    await previous;
    try {
      return await withSyncDatabaseMutationLock(() => this.savepoint(fn));
    } finally {
      unlock();
      if (transactionTails.get(this.db) === tail) transactionTails.delete(this.db);
    }
  }

  private async savepoint<T>(fn: (db: SqlRunner) => Promise<T>): Promise<T> {
    const savepoint = `gemma_proposal_${++savepointSequence}`;
    await this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this.db);
      await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve the original failure */ }
      throw error;
    }
  }
}
