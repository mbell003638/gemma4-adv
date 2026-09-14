import type { SqlRunner } from '../db/schema';
import { storage } from '../utils/storage';
import { withDeterministicAccountingIds } from '../accountingV2/runtimeIds';
import { createSyncId } from './ids';
import { getValidSyncAccessToken, storeManualSyncAccessToken } from './oidc';
import { withSyncDatabaseMutationLock } from './databaseMutex';
import {
  assertSyncOperation,
  hashPayload,
  SYNC_PAYLOAD_VERSION,
  SYNC_PROTOCOL_VERSION,
  type SyncBookState,
  type SyncOperation,
  type SyncOutboxRow,
} from './protocol';
import {
  listPendingSyncOperations,
  makeSyncOperation,
  markSyncOperationAccepted,
  markSyncOperationFailed,
  nextDeviceSequence,
  readSyncBookState,
  withSyncOperationLocked,
  writeSyncBookState,
} from './outbox';

const DEVICE_KEY = 'ledgr:sync:device-id';
export const FIRST_DEVICE_BOOTSTRAP_REASON = 'First-device bootstrap requires a canonical local snapshot';
const now = () => new Date().toISOString();
let remoteBatchSequence = 0;

export type SyncProfile = {
  bookId: string;
  serverUrl: string;
  userId: string;
  deviceId: string;
  actorId: string;
  bookEpoch: string;
  enabled: boolean;
  recoveryRequired: boolean;
  recoveryReason?: string;
  lastSyncAt?: string;
  lastSyncAttemptAt?: string;
  lastSyncError?: string;
  lastSyncErrorAt?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcScopes?: string;
  updatedAt: string;
};

export type SyncMutation = {
  commandType: string;
  aggregateType?: string;
  aggregateId: string;
  payload: unknown;
  baseRevision?: number | null;
  dependencies?: string[];
  businessDate?: string;
  /** The first generated V2 row ID and aggregate ID are the immutable opId. */
  operationIdentity?: boolean;
};

export type SyncStatus = {
  enabled: boolean;
  configured: boolean;
  serverUrl?: string;
  userId?: string;
  deviceId?: string;
  bookEpoch?: string;
  cursor?: number;
  checkpointHash?: string;
  projectionHash?: string;
  lastVerifiedAt?: string;
  lastSyncAt?: string;
  lastSyncAttemptAt?: string;
  lastSyncError?: string;
  lastSyncErrorAt?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcScopes?: string;
  pending: number;
  retryable: number;
  conflicts: number;
  lastError?: string;
  recoveryRequired?: boolean;
  recoveryReason?: string;
  bootstrapRequired?: boolean;
};

function validServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Sync server URL is invalid'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Sync server URL must use HTTPS (HTTP is allowed only for local development)');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '10.0.2.2', '::1'].includes(parsed.hostname)) throw new Error('Sync server URL must use HTTPS outside local development');
  return url;
}

async function deviceId(): Promise<string> {
  const existing = await storage.secureGet<string | null>(DEVICE_KEY, null);
  if (existing) return existing;
  const created = createSyncId();
  await storage.secureSet(DEVICE_KEY, created);
  return created;
}

export async function getSyncProfile(db: SqlRunner, bookId: string): Promise<SyncProfile | null> {
  const row = await db.first<any>('SELECT * FROM sync_profiles WHERE id=?', [bookId]);
  if (!row) return null;
  return {
    bookId,
    serverUrl: String(row.server_url),
    userId: String(row.user_id || ''),
    deviceId: String(row.device_id || ''),
    actorId: String(row.actor_id || row.user_id || ''),
    bookEpoch: String(row.book_epoch || ''),
    enabled: Boolean(row.enabled),
    recoveryRequired: Boolean(row.recovery_required),
    ...(row.recovery_reason ? { recoveryReason: String(row.recovery_reason) } : {}),
    ...(row.last_sync_at ? { lastSyncAt: String(row.last_sync_at) } : {}),
    ...(row.last_sync_attempt_at ? { lastSyncAttemptAt: String(row.last_sync_attempt_at) } : {}),
    ...(row.last_sync_error ? { lastSyncError: String(row.last_sync_error) } : {}),
    ...(row.last_sync_error_at ? { lastSyncErrorAt: String(row.last_sync_error_at) } : {}),
    ...(row.oidc_issuer ? { oidcIssuer: String(row.oidc_issuer) } : {}),
    ...(row.oidc_client_id ? { oidcClientId: String(row.oidc_client_id) } : {}),
    ...(row.oidc_scopes ? { oidcScopes: String(row.oidc_scopes) } : {}),
    updatedAt: String(row.updated_at),
  };
}

export async function configureSync(db: SqlRunner, input: { bookId: string; serverUrl: string; userId: string; actorId?: string; accessToken?: string; enabled?: boolean; oidcIssuer?: string; oidcClientId?: string; oidcScopes?: string }): Promise<SyncProfile> {
  const bookId = input.bookId.trim();
  if (!bookId) throw new Error('A Business Account is required for sync');
  const serverUrl = validServerUrl(input.serverUrl);
  const device = await deviceId();
  const existing = await getSyncProfile(db, bookId);
  const epoch = existing?.bookEpoch || '';
  const timestamp = now();
  await db.run(
    `INSERT INTO sync_profiles(id,server_url,user_id,device_id,actor_id,book_epoch,enabled,oidc_issuer,oidc_client_id,oidc_scopes,protocol_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(id) DO UPDATE SET server_url=excluded.server_url,user_id=excluded.user_id,
       device_id=excluded.device_id,actor_id=excluded.actor_id,book_epoch=excluded.book_epoch,
       enabled=excluded.enabled,oidc_issuer=excluded.oidc_issuer,oidc_client_id=excluded.oidc_client_id,oidc_scopes=excluded.oidc_scopes,updated_at=excluded.updated_at`,
    [bookId, serverUrl, input.userId.trim(), device, (input.actorId || input.userId).trim(), epoch, epoch ? (input.enabled === false ? 0 : 1) : 0, input.oidcIssuer?.trim() || null, input.oidcClientId?.trim() || null, input.oidcScopes?.trim() || null, timestamp, timestamp],
  );
  const state = await readSyncBookState(db, bookId);
  if (state && epoch && state.bookEpoch !== epoch) throw new Error('Sync book epoch mismatch; re-enrollment is required');
  if (state) await writeSyncBookState(db, { ...state, updatedAt: timestamp });
  if (input.accessToken !== undefined) await storeManualSyncAccessToken(bookId, input.accessToken);
  return (await getSyncProfile(db, bookId))!;
}

export async function disableSync(db: SqlRunner, bookId: string): Promise<void> {
  await db.run('UPDATE sync_profiles SET enabled=0,updated_at=? WHERE id=?', [now(), bookId]);
}

export async function enableSync(db: SqlRunner, bookId: string): Promise<void> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile?.bookEpoch) throw new Error('Enroll this device before enabling sync');
  if (profile.recoveryRequired) throw new Error(profile.recoveryReason || 'Complete snapshot recovery before enabling sync');
  await getValidSyncAccessToken(profile);
  await db.run('UPDATE sync_profiles SET enabled=1,updated_at=? WHERE id=?', [now(), bookId]);
}

/** Preserve pending intent and require explicit re-enrollment after destructive local changes. */
export async function markSyncRecoveryRequired(db: SqlRunner, bookId: string, reason: string): Promise<void> {
  await db.run("UPDATE sync_outbox SET status='quarantined',last_error=?,updated_at=? WHERE book_id=? AND status IN ('pending','retryable')", [reason, now(), bookId]);
  await db.run('UPDATE sync_profiles SET enabled=0,recovery_required=1,recovery_reason=?,updated_at=? WHERE id=?', [reason, now(), bookId]);
}

/** @deprecated Recovery epochs are server-authoritative; use enrollSyncDevice and installServerSnapshot. */
export async function completeSyncRecovery(_db: SqlRunner, _bookId: string, _bookEpoch: string): Promise<void> {
  throw new Error('Recovery must use server enrollment and a validated snapshot');
}

export async function getSyncStatus(db: SqlRunner, bookId: string): Promise<SyncStatus> {
  const profile = await getSyncProfile(db, bookId);
  const state = await readSyncBookState(db, bookId);
  const pendingRow = await db.first<{ count: number; retryable: number }>("SELECT COUNT(*) AS count, SUM(CASE WHEN status='retryable' THEN 1 ELSE 0 END) AS retryable FROM sync_outbox WHERE book_id=? AND status IN ('pending','retryable','quarantined')", [bookId]);
  const errorRow = await db.first<{ last_error?: string }>("SELECT last_error FROM sync_outbox WHERE book_id=? AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1", [bookId]);
  const conflictRow = await db.first<{ count: number }>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE book_id=? AND status='open'", [bookId]);
  return {
    enabled: Boolean(profile?.enabled), configured: Boolean(profile), ...(profile ? { serverUrl: profile.serverUrl, userId: profile.userId, deviceId: profile.deviceId, bookEpoch: profile.bookEpoch, ...(profile.lastSyncAt ? { lastSyncAt: profile.lastSyncAt } : {}), ...(profile.lastSyncAttemptAt ? { lastSyncAttemptAt: profile.lastSyncAttemptAt } : {}), ...(profile.lastSyncError ? { lastSyncError: profile.lastSyncError } : {}), ...(profile.lastSyncErrorAt ? { lastSyncErrorAt: profile.lastSyncErrorAt } : {}), ...(profile.oidcIssuer ? { oidcIssuer: profile.oidcIssuer } : {}), ...(profile.oidcClientId ? { oidcClientId: profile.oidcClientId } : {}), ...(profile.oidcScopes ? { oidcScopes: profile.oidcScopes } : {}) } : {}),
    ...(state ? { cursor: state.serverCursor, checkpointHash: state.snapshotHash, projectionHash: state.projectionHash, lastVerifiedAt: state.lastVerifiedAt } : {}),
    pending: Number(pendingRow?.count || 0), retryable: Number(pendingRow?.retryable || 0), conflicts: Number(conflictRow?.count || 0),
    ...(errorRow?.last_error ? { lastError: errorRow.last_error } : {}),
    ...(profile?.recoveryRequired ? { recoveryRequired: true, recoveryReason: profile.recoveryReason, ...(profile.recoveryReason === FIRST_DEVICE_BOOTSTRAP_REASON ? { bootstrapRequired: true } : {}) } : {}),
  };
}

export async function withSyncedMutation<T>(db: SqlRunner, mutation: SyncMutation, apply: () => Promise<T>): Promise<T> {
  return withSyncDatabaseMutationLock(() => withSyncedMutationLocked(db, mutation, apply));
}

/** Caller must already hold the sync database lock, and use the same runner for
 * its surrounding savepoint and domain write. Never call the public locking API
 * from a proposal transaction: the database lock is deliberately non-reentrant. */
export async function withSyncedMutationLocked<T>(db: SqlRunner, mutation: SyncMutation, apply: () => Promise<T>, expectedBookId?: string): Promise<T> {
    const context = await db.first<any>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    const bookId = String(context?.value || '');
    if (expectedBookId !== undefined && bookId !== expectedBookId) throw new Error('Active book changed before assistant mutation');
    const profile = bookId ? await getSyncProfile(db, bookId) : null;
    if (!profile?.bookEpoch || (profile.recoveryRequired && profile.recoveryReason === FIRST_DEVICE_BOOTSTRAP_REASON)) return apply();
    const state = (await readSyncBookState(db, bookId)) || { bookId, bookEpoch: profile.bookEpoch, serverCursor: 0, updatedAt: now() };
    const sequence = await nextDeviceSequence(db, bookId, profile.deviceId, state.bookEpoch);
    const opId = createSyncId();
    const aggregateId = mutation.operationIdentity ? opId : mutation.aggregateId;
    const revisionRow = mutation.baseRevision === undefined && mutation.aggregateType
      ? await db.first<{ revision: number }>('SELECT MAX(revision) AS revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?', [bookId, aggregateId])
      : null;
    const payload = mutation.payload;
    const operation = makeSyncOperation({
      bookId, bookEpoch: state.bookEpoch, deviceId: profile.deviceId, deviceSequence: sequence,
      opId, actorId: profile.actorId, commandType: mutation.commandType, aggregateId,
      baseRevision: mutation.baseRevision === undefined ? (mutation.aggregateType ? Number(revisionRow?.revision || 0) : null) : mutation.baseRevision,
      dependencies: mutation.dependencies || [], payload, payloadHash: hashPayload(payload), clientCreatedAt: now(),
      ...(mutation.businessDate ? { businessDate: mutation.businessDate } : {}),
    });
    return withSyncOperationLocked(db, operation, apply, (result, original) => {
      if (result === undefined) return original;
      const capturedPayload = original.payload && typeof original.payload === 'object' && !Array.isArray(original.payload)
        ? { ...(original.payload as Record<string, unknown>), _result: result }
        : { value: original.payload, _result: result };
      return { ...original, payload: capturedPayload, payloadHash: hashPayload(capturedPayload) };
    }, profile.recoveryRequired ? 'quarantined' : 'pending');
}

class SyncHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request(profile: SyncProfile, path: string, init: RequestInit, token: string): Promise<any> {
  const response = await fetch(`${profile.serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-ledgr-protocol-version': String(SYNC_PROTOCOL_VERSION), 'x-ledgr-payload-version': String(SYNC_PAYLOAD_VERSION), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SyncHttpError(response.status, String(body?.message || `Sync request failed (${response.status})`));
  return body;
}

async function recordConflict(db: SqlRunner, operation: SyncOperation, reason: string, canonical?: any, blocking = false): Promise<void> {
  const canonicalEvent = canonical || (blocking ? operation : null);
  await db.run(
     `INSERT INTO sync_conflicts(conflict_id,book_id,op_id,canonical_op_id,aggregate_id,command_type,reason,local_payload,canonical_payload,remote_operation,blocking_book_sequence,canonical_revision,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
       SELECT 1 FROM sync_conflicts WHERE book_id=? AND op_id=? AND status='open'
     )`,
    [canonicalEvent?.conflictId || (blocking ? `local:${createSyncId()}` : createSyncId()), operation.bookId, operation.opId, canonicalEvent?.opId || null, operation.aggregateId, operation.commandType, reason,
      JSON.stringify(operation.payload), canonicalEvent?.payload === undefined ? null : JSON.stringify(canonicalEvent.payload),
      canonicalEvent ? JSON.stringify(canonicalEvent) : null, blocking ? Number(canonicalEvent?.bookSequence || 0) || null : null,
      canonicalEvent?.aggregateRevision ?? null, now(), operation.bookId, operation.opId],
  );
}

export type RemoteOperationApplier = (db: SqlRunner, operation: SyncOperation) => Promise<void>;

async function pullAndApply(
  db: SqlRunner,
  profile: SyncProfile,
  bookId: string,
  token: string,
  state: SyncBookState,
  applyRemote?: RemoteOperationApplier,
): Promise<SyncBookState & { hasMore?: boolean }> {
  const pulled = await request(profile, `/v1/sync/pull?bookId=${encodeURIComponent(bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}&after=${state.serverCursor}&limit=100`, { method: 'GET' }, token);
  if (pulled.bookEpoch && pulled.bookEpoch !== state.bookEpoch) {
    await markSyncRecoveryRequired(db, bookId, 'The server epoch changed; re-enrollment and snapshot recovery are required');
    throw new Error('Sync epoch changed; re-enrollment is required');
  }
  return withSyncDatabaseMutationLock(async () => {
    const savepoint = `sync_remote_batch_${++remoteBatchSequence}`;
    let failedEvent: SyncOperation | undefined;
    await db.exec(`SAVEPOINT ${savepoint}`);
    try {
      let priorSequence = state.serverCursor;
      for (const event of Array.isArray(pulled.events) ? pulled.events : []) {
      assertSyncOperation(event);
      if (event.bookId !== bookId || event.bookEpoch !== state.bookEpoch || hashPayload(event.payload) !== event.payloadHash) throw new Error('Pulled operation identity or payload hash is invalid');
      const bookSequence = Number(event.bookSequence), aggregateRevision = Number(event.aggregateRevision);
      if (!Number.isSafeInteger(bookSequence) || bookSequence <= priorSequence) throw new Error('Pulled operations are not in strictly increasing canonical sequence order');
      if (!Number.isSafeInteger(aggregateRevision) || aggregateRevision < 1) throw new Error('Pulled operation aggregate revision is invalid');
      priorSequence = bookSequence;
      const already = await db.first<{ op_id: string }>('SELECT op_id FROM sync_applied_ops WHERE op_id=?', [event.opId]);
      if (already) continue;
      failedEvent = event as SyncOperation;
      const local = await db.first<any>('SELECT * FROM sync_outbox WHERE op_id=?', [event.opId]);
      if (!local && applyRemote) await withDeterministicAccountingIds(event.opId, () => applyRemote(db, event as SyncOperation));
      else if (!local && !applyRemote) throw new Error('No remote operation applier is registered');
      await db.run("INSERT OR IGNORE INTO sync_applied_ops(op_id,book_id,book_sequence,aggregate_revision,applied_at,apply_mode) VALUES(?,?,?,?,?,'replayed')", [event.opId, bookId, event.bookSequence, event.aggregateRevision ?? null, now()]);
      if (event.aggregateRevision != null) await db.run(
        `INSERT INTO sync_entity_revisions(book_id,aggregate_type,aggregate_id,revision,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(book_id,aggregate_type,aggregate_id) DO UPDATE SET revision=MAX(revision,excluded.revision),updated_at=excluded.updated_at`,
        [bookId, String(event.commandType).split('.')[0] || 'unknown', event.aggregateId, Number(event.aggregateRevision), now()],
      );
      failedEvent = undefined;
      }
      const nextCursor = Number(pulled.cursor || state.serverCursor);
      if (!Number.isSafeInteger(nextCursor) || nextCursor < state.serverCursor) throw new Error('Sync server returned an invalid or backwards cursor');
      if (nextCursor < priorSequence) throw new Error('Sync server cursor is behind the last returned canonical operation');
      const nextState = {
        ...state,
        serverCursor: nextCursor,
        ...(typeof pulled.checkpointHash === 'string' ? { snapshotHash: pulled.checkpointHash } : {}),
        hasMore: Boolean(pulled.hasMore),
        updatedAt: now(),
      };
      await writeSyncBookState(db, nextState);
      await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return nextState;
    } catch (error: any) {
      try {
        await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve the original replay failure */ }
      if (failedEvent) await recordConflict(db, failedEvent, error?.message || 'Remote operation could not be applied', failedEvent, true);
      throw error;
    }
  });
}

async function pullUntilCurrent(db: SqlRunner, profile: SyncProfile, bookId: string, token: string, initial: SyncBookState, applyRemote?: RemoteOperationApplier): Promise<SyncBookState> {
  let state: SyncBookState & { hasMore?: boolean } = initial;
  for (let page = 0; page < 1000; page += 1) {
    state = await pullAndApply(db, profile, bookId, token, state, applyRemote);
    if (!state.hasMore) return state;
  }
  throw new Error('Sync pull exceeded the safe pagination limit');
}

async function refreshServerConflicts(db: SqlRunner, profile: SyncProfile, token: string): Promise<void> {
  const result = await request(profile, `/v1/sync/conflicts?bookId=${encodeURIComponent(profile.bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}&status=open`, { method: 'GET' }, token);
  for (const item of Array.isArray(result.conflicts) ? result.conflicts : []) {
    const local = item.localOperation;
    if (!item.conflictId || !item.opId || !local) continue;
    await db.run(
      `INSERT INTO sync_conflicts(conflict_id,book_id,op_id,canonical_op_id,aggregate_id,command_type,reason,base_payload,local_payload,canonical_payload,remote_operation,canonical_revision,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(conflict_id) DO UPDATE SET canonical_op_id=excluded.canonical_op_id,aggregate_id=excluded.aggregate_id,command_type=excluded.command_type,reason=excluded.reason,base_payload=excluded.base_payload,local_payload=excluded.local_payload,canonical_payload=excluded.canonical_payload,remote_operation=excluded.remote_operation,canonical_revision=excluded.canonical_revision`,
      [String(item.conflictId), profile.bookId, String(item.opId), item.canonicalOpId || item.canonicalEvent?.opId || null, item.aggregateId || local.aggregateId || null,
        local.commandType || null, String(item.reason || 'Canonical conflict'), item.basePayload == null ? null : JSON.stringify(item.basePayload), JSON.stringify(local.payload),
        item.canonicalEvent ? JSON.stringify(item.canonicalEvent.payload) : null, item.canonicalEvent ? JSON.stringify(item.canonicalEvent) : null,
        item.canonicalRevision ?? item.canonicalEvent?.aggregateRevision ?? null, String(item.createdAt || now())],
    );
  }
}

async function flushConflictResolutions(db: SqlRunner, profile: SyncProfile, token: string): Promise<void> {
  const rows = await db.all<any>("SELECT * FROM sync_conflict_resolutions WHERE book_id=? AND status='pending' ORDER BY created_at LIMIT 50", [profile.bookId]);
  for (const row of rows) {
    if (String(row.conflict_id).startsWith('local:')) {
      await db.run("UPDATE sync_conflict_resolutions SET status='sent',updated_at=? WHERE resolution_id=?", [now(), row.resolution_id]);
      continue;
    }
    try {
      await request(profile, '/v1/sync/conflicts/resolve', { method: 'POST', body: JSON.stringify({ bookId: profile.bookId, deviceId: profile.deviceId, conflictId: row.conflict_id, resolutionType: row.resolution_type === 'audited_correction' ? 'correction' : row.resolution_type, resolutionOpId: row.resolution_op_id || undefined }) }, token);
      await db.run("UPDATE sync_conflict_resolutions SET status='sent',updated_at=? WHERE resolution_id=?", [now(), row.resolution_id]);
    } catch (error: any) {
      await db.run('UPDATE sync_conflict_resolutions SET attempts=attempts+1,last_error=?,updated_at=? WHERE resolution_id=?', [error?.message || 'Resolution delivery failed', now(), row.resolution_id]);
      if (error instanceof SyncHttpError && error.status >= 400 && error.status < 500 && ![401, 403, 409].includes(error.status)) await db.run("UPDATE sync_conflict_resolutions SET status='rejected',updated_at=? WHERE resolution_id=?", [now(), row.resolution_id]);
    }
  }
}

const activeSyncRuns = new Map<string, Promise<SyncStatus>>();

export async function syncNow(db: SqlRunner, bookId: string, applyRemote?: RemoteOperationApplier): Promise<SyncStatus> {
  const existing = activeSyncRuns.get(bookId);
  if (existing) return existing;
  const run = syncNowSerialized(db, bookId, applyRemote).catch(async (error: any) => {
    const message = String(error?.message || 'Sync failed').slice(0, 1000);
    const timestamp = now();
    await db.run('UPDATE sync_profiles SET last_sync_error=?,last_sync_error_at=?,updated_at=? WHERE id=?', [message, timestamp, timestamp, bookId]).catch(() => undefined);
    throw error;
  }).finally(() => {
    if (activeSyncRuns.get(bookId) === run) activeSyncRuns.delete(bookId);
  });
  activeSyncRuns.set(bookId, run);
  return run;
}

async function syncNowSerialized(db: SqlRunner, bookId: string, applyRemote?: RemoteOperationApplier): Promise<SyncStatus> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile?.enabled) return getSyncStatus(db, bookId);
  if (profile.recoveryRequired) throw new Error(profile.recoveryReason || 'Sync recovery requires explicit re-enrollment');
  const token = await getValidSyncAccessToken(profile);
  const attemptAt = now();
  await db.run('UPDATE sync_profiles SET last_sync_attempt_at=?,last_sync_error=NULL,last_sync_error_at=NULL,updated_at=? WHERE id=?', [attemptAt, attemptAt, bookId]);

  // Pull first so the local projection observes the server order before this
  // device pushes operations that may depend on the current canonical state.
  let state = (await readSyncBookState(db, bookId)) || { bookId, bookEpoch: profile.bookEpoch, serverCursor: 0, updatedAt: now() };
  state = await pullUntilCurrent(db, profile, bookId, token, state, applyRemote);

  const pending = await listPendingSyncOperations(db, bookId, 100, profile.bookEpoch);
  if (pending.length) {
    try {
      const pushed = await request(profile, '/v1/sync/push', { method: 'POST', body: JSON.stringify({ bookId, operations: pending }) }, token);
      const handled = new Set<string>();
      // Accepting a push raises the aggregate's revision on the server, but only
      // pull and snapshot install ever wrote sync_entity_revisions. A second edit
      // to the same aggregate before the next pull therefore re-sent the stale
      // revision and the server reported a conflict between two of this device's
      // own sequential edits. The server accepts at baseRevision + 1, so that is
      // the revision this device now holds.
      const bumpAcceptedRevision = async (operation: SyncOperation) => {
        if (operation.baseRevision == null || !operation.aggregateId) return;
        const next = Number(operation.baseRevision) + 1;
        if (!Number.isSafeInteger(next) || next < 1) return;
        await db.run(
          `INSERT INTO sync_entity_revisions(book_id,aggregate_type,aggregate_id,revision,updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(book_id,aggregate_type,aggregate_id) DO UPDATE SET revision=MAX(revision,excluded.revision),updated_at=excluded.updated_at`,
          [bookId, String(operation.commandType).split('.')[0] || 'unknown', operation.aggregateId, next, now()],
        );
      };
      for (const accepted of Array.isArray(pushed.accepted) ? pushed.accepted : []) {
        const opId = String(accepted.opId || ''); if (!opId) continue;
        const sequence = Number(accepted.bookSequence);
        if (Number.isSafeInteger(sequence) && sequence > 0) {
          await markSyncOperationAccepted(db, opId, sequence);
          const operation = pending.find((item) => item.opId === opId);
          if (operation) await bumpAcceptedRevision(operation);
          handled.add(opId);
        }
      }
      for (const result of Array.isArray(pushed.results) ? pushed.results : []) {
        const opId = String(result.opId || ''); const operation = pending.find((item) => item.opId === opId);
        if (!operation || handled.has(opId)) continue;
        if (result.status === 'accepted' || result.status === 'duplicate') {
          const sequence = Number(result.bookSequence);
          if (Number.isSafeInteger(sequence) && sequence > 0) { await markSyncOperationAccepted(db, opId, sequence); await bumpAcceptedRevision(operation); }
          else await markSyncOperationFailed(db, opId, 'retryable', 'Server omitted the canonical sequence');
        }
        else if (result.status === 'conflict') { const reason = String(result.message || 'Canonical conflict'); await markSyncOperationFailed(db, opId, 'conflict', reason); await recordConflict(db, operation, reason, { ...(result.canonicalEvent || {}), conflictId: result.conflictId }); }
        else if (result.status === 'rejected') await markSyncOperationFailed(db, opId, 'rejected', String(result.message || 'Operation rejected'));
        else await markSyncOperationFailed(db, opId, 'retryable', String(result.message || 'Operation must be retried'));
        handled.add(opId);
      }
      for (const conflict of Array.isArray(pushed.conflicts) ? pushed.conflicts : []) {
        const opId = String(conflict.opId || conflict.operation?.opId || '');
        const operation = pending.find((item) => item.opId === opId); if (!operation) continue;
        const reason = String(conflict.message || conflict.reason || 'Canonical conflict');
        await markSyncOperationFailed(db, opId, 'conflict', reason);
        await recordConflict(db, operation, reason, conflict.canonicalEvent);
        handled.add(opId);
      }
      for (const rejected of Array.isArray(pushed.rejected) ? pushed.rejected : []) {
        const opId = String(rejected.opId || rejected.operation?.opId || ''); if (!opId) continue;
        await markSyncOperationFailed(db, opId, 'rejected', String(rejected.message || rejected.reason || 'Operation rejected'));
        handled.add(opId);
      }
      for (const operation of pending) if (!handled.has(operation.opId)) await markSyncOperationFailed(db, operation.opId, 'retryable', 'Server returned no result for this operation');
    } catch (error: any) {
      const permanent = error instanceof SyncHttpError && error.status === 400;
      for (const operation of pending) await markSyncOperationFailed(db, operation.opId, permanent ? 'rejected' : 'retryable', error?.message || 'Sync push failed');
    }
  }

  try { await refreshServerConflicts(db, profile, token); } catch { /* conflict hydration is retried on the next sync */ }
  await flushConflictResolutions(db, profile, token);

  // Pull again so accepted operations and any concurrent device operations are
  // applied before the durable cursor is considered complete.
  await pullUntilCurrent(db, profile, bookId, token, state, applyRemote);
  const completedAt = now();
  await db.run('UPDATE sync_profiles SET last_sync_at=?,last_sync_error=NULL,last_sync_error_at=NULL,updated_at=? WHERE id=?', [completedAt, completedAt, bookId]);
  return getSyncStatus(db, bookId);
}

/** Clear only transient backoff and immediately run the normal safe coordinator. */
export async function retrySyncNow(db: SqlRunner, bookId: string, applyRemote?: RemoteOperationApplier): Promise<SyncStatus> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile?.enabled) return getSyncStatus(db, bookId);
  if (profile.recoveryRequired) throw new Error(profile.recoveryReason || 'Sync recovery requires explicit re-enrollment');
  const timestamp = now();
  await db.run("UPDATE sync_outbox SET status='pending',next_retry_at=NULL,updated_at=? WHERE book_id=? AND book_epoch=? AND status='retryable'", [timestamp, bookId, profile.bookEpoch]);
  return syncNow(db, bookId, applyRemote);
}

export async function listSyncConflicts(db: SqlRunner, bookId: string): Promise<any[]> {
  return db.all<any>("SELECT * FROM sync_conflicts WHERE book_id=? AND status='open' ORDER BY created_at DESC", [bookId]);
}

export async function resolveSyncConflict(db: SqlRunner, conflictId: string): Promise<void> {
  await db.run("UPDATE sync_conflicts SET status='resolved',resolved_at=? WHERE conflict_id=? AND status='open'", [now(), conflictId]);
}

export function isSyncOutboxRow(value: unknown): value is SyncOutboxRow { return Boolean(value && typeof value === 'object' && 'opId' in value); }
