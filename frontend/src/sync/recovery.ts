import type { SqlRunner } from '../db/schema';
import { assertSyncOperation, hashPayload, SYNC_PAYLOAD_VERSION, SYNC_PROTOCOL_VERSION, type SyncOperation, type SyncSnapshot } from './protocol';
import { readSyncBookState, writeSyncBookState } from './outbox';
import { FIRST_DEVICE_BOOTSTRAP_REASON, getSyncProfile, markSyncRecoveryRequired, type SyncProfile } from './coordinator';
import { withDeterministicAccountingIds } from '../accountingV2/runtimeIds';
import { clearSyncTokens, getValidSyncAccessToken } from './oidc';
import { withSyncDatabaseMutationLock } from './databaseMutex';

const now = () => new Date().toISOString();
let savepointSequence = 0;

export type SyncEpochState = { bookId: string; bookEpoch: string; epochNumber: number; epochStartSequence: number; currentSequence: number };
export type SyncDevice = { deviceId: string; subject?: string; enrolledAt?: string; expiresAt?: string; lastSeenAt?: string; revokedAt?: string | null; current?: boolean; displayName?: string; platform?: string };
export type SyncMembership = { bookId: string; subject: string; role: 'owner' | 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor'; locationIds: string[]; updatedAt: string };
export type EnrollmentCode = { codeId: string; bookId: string; code: string; role: Exclude<SyncMembership['role'], 'owner'>; locationIds: string[]; expiresAt: string };
export type ProjectionVerification = { bookId: string; bookEpoch: string; throughSequence: number; serverEventHash: string; eventHashMatches: boolean; projectionHashMatches?: boolean; verifiedAt: string };
export type SnapshotInstaller = (db: SqlRunner, payload: unknown, snapshot: SyncSnapshot) => Promise<void>;
export type SnapshotReplayer = (db: SqlRunner, operation: SyncOperation) => Promise<void>;
export type ProjectionHasher = (db: SqlRunner, bookId: string) => Promise<string>;
export type SnapshotExporter = (db: SqlRunner, bookId: string) => Promise<{ schemaVersion: number; payload: unknown; projectionHash: string }>;

class RecoveryHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request(profile: SyncProfile, path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${profile.serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${await getValidSyncAccessToken(profile)}`, 'x-ledgr-protocol-version': String(SYNC_PROTOCOL_VERSION), 'x-ledgr-payload-version': String(SYNC_PAYLOAD_VERSION), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new RecoveryHttpError(response.status, String(body?.message || `Sync request failed (${response.status})`));
  return body;
}

function integer(value: unknown, label: string, positive = false): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (positive ? 1 : 0)) throw new Error(`Sync server returned an invalid ${label}`);
  return result;
}

function epoch(value: any, bookId: string): SyncEpochState {
  if (!value || value.bookId !== bookId || typeof value.bookEpoch !== 'string' || !value.bookEpoch) throw new Error('Sync server returned an invalid enrollment');
  return { bookId, bookEpoch: value.bookEpoch, epochNumber: integer(value.epochNumber, 'epoch number'), epochStartSequence: integer(value.epochStartSequence, 'epoch start sequence'), currentSequence: integer(value.currentSequence, 'current sequence') };
}

/** Explicit enrollment installs only server-issued epoch identity. */
export async function createSyncEnrollmentCode(db: SqlRunner, bookId: string, role: EnrollmentCode['role'], locationIds: string[], ttlMinutes = 15): Promise<EnrollmentCode> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Configure the sync server before creating an enrollment code');
  const result = await request(profile, '/v1/sync/enrollment-codes', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, role, locationIds, ttlMinutes }) });
  const enrollment = result.enrollment;
  if (!enrollment || typeof enrollment.code !== 'string' || typeof enrollment.expiresAt !== 'string') throw new Error('Sync server returned an invalid enrollment code');
  return { codeId: String(enrollment.codeId), bookId: String(enrollment.bookId), code: enrollment.code, role: enrollment.role, locationIds: Array.isArray(enrollment.locationIds) ? enrollment.locationIds.map(String) : [], expiresAt: enrollment.expiresAt };
}

export async function redeemSyncEnrollmentCode(db: SqlRunner, bookId: string, code: string, displayName?: string, platform?: string): Promise<SyncEpochState> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Configure the sync server before redeeming an enrollment code');
  const response = await request(profile, '/v1/sync/enroll-code/redeem', { method: 'POST', body: JSON.stringify({ code, deviceId: profile.deviceId, ...(displayName ? { displayName } : {}), ...(platform ? { platform } : {}) }) });
  const enrollment = response.enrollment;
  if (!enrollment || String(enrollment.bookId) !== bookId) throw new Error('Enrollment code belongs to another Business Account');
  const epochResult = epoch(enrollment, bookId);
  const timestamp = now();
  const canonicalDataExists = epochResult.currentSequence >= epochResult.epochStartSequence;
  const recoveryReason = canonicalDataExists ? 'Install the validated server snapshot before sync resumes' : null;
  await db.run('UPDATE sync_profiles SET book_epoch=?,enabled=?,recovery_required=?,recovery_reason=?,updated_at=? WHERE id=?', [epochResult.bookEpoch, canonicalDataExists ? 0 : 1, canonicalDataExists ? 1 : 0, recoveryReason, timestamp, bookId]);
  await writeSyncBookState(db, { bookId, bookEpoch: epochResult.bookEpoch, serverCursor: Math.max(0, epochResult.epochStartSequence - 1), epochNumber: epochResult.epochNumber, epochStartSequence: epochResult.epochStartSequence, updatedAt: timestamp, ...(canonicalDataExists ? {} : { snapshotHash: hashPayload([]) }) });
  return epochResult;
}

export async function enrollSyncDevice(db: SqlRunner, bookId: string): Promise<SyncEpochState> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile) throw new Error('Configure the sync server before enrolling this device');
  const response = await request(profile, '/v1/sync/enroll', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, actorId: profile.actorId }) });
  const result = epoch(response, bookId);
  const current = await readSyncBookState(db, bookId);
  const changed = Boolean(current?.bookEpoch && current.bookEpoch !== result.bookEpoch);
  const canonicalDataExists = Boolean(response.snapshotAvailable) || result.currentSequence >= result.epochStartSequence;
  const needsSnapshot = canonicalDataExists && (changed || !current || profile.recoveryRequired);
  const bootstrapRequired = !canonicalDataExists;
  const timestamp = now();
  const recoveryReason = needsSnapshot ? 'Install a validated server snapshot before sync resumes' : bootstrapRequired ? FIRST_DEVICE_BOOTSTRAP_REASON : null;
  await db.run('UPDATE sync_profiles SET book_epoch=?,enabled=?,recovery_required=?,recovery_reason=?,updated_at=? WHERE id=?', [result.bookEpoch, needsSnapshot || bootstrapRequired ? 0 : 1, needsSnapshot || bootstrapRequired ? 1 : 0, recoveryReason, timestamp, bookId]);
  if (changed) {
    await db.run("UPDATE sync_outbox SET status='quarantined',last_error=?,updated_at=? WHERE book_id=? AND book_epoch<>? AND status IN ('pending','retryable','conflict')", ['Book epoch changed; explicit reconciliation is required', timestamp, bookId, result.bookEpoch]);
    await db.run("UPDATE sync_conflicts SET status='ignored',resolved_at=? WHERE book_id=? AND status='open'", [timestamp, bookId]);
    await db.run("UPDATE sync_conflict_resolutions SET status='rejected',last_error=?,updated_at=? WHERE book_id=? AND status='pending'", ['Book epoch changed before resolution delivery', timestamp, bookId]);
  }
  await writeSyncBookState(db, changed || !current
    ? { bookId, bookEpoch: result.bookEpoch, serverCursor: Math.max(0, result.epochStartSequence - 1), ...(bootstrapRequired ? { snapshotHash: hashPayload([]) } : {}), epochNumber: result.epochNumber, epochStartSequence: result.epochStartSequence, updatedAt: timestamp }
    : { ...current, epochNumber: result.epochNumber, epochStartSequence: result.epochStartSequence, updatedAt: timestamp });
  return result;
}

function validateSnapshot(value: any, bookId: string, bookEpoch: string): asserts value is SyncSnapshot {
  if (!value || value.bookId !== bookId || value.bookEpoch !== bookEpoch) throw new Error('Snapshot belongs to another Business Account or epoch');
  if (typeof value.snapshotId !== 'string' || !value.snapshotId || typeof value.checkpointHash !== 'string' || !value.checkpointHash) throw new Error('Snapshot identity is invalid');
  integer(value.throughSequence, 'snapshot sequence');
  integer(value.schemaVersion, 'snapshot schema version', true);
  if (typeof value.payloadHash !== 'string' || hashPayload(value.payload) !== value.payloadHash) throw new Error('Snapshot payload hash verification failed');
  if (!value.payload || typeof value.payload !== 'object' || Number(value.payload.schemaVersion) !== Number(value.schemaVersion)) throw new Error('Snapshot envelope and projection schema versions do not match');
  if (!value.aggregateRevisions || typeof value.aggregateRevisions !== 'object' || Array.isArray(value.aggregateRevisions)) throw new Error('Snapshot aggregate revisions are invalid');
  for (const [aggregateId, revision] of Object.entries(value.aggregateRevisions)) {
    if (!aggregateId.trim() || !Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('Snapshot aggregate revisions are invalid');
  }
}

/** Publish an administrator-authorized projection checkpoint for bootstrap/recovery of other devices. */
export async function publishServerSnapshot(db: SqlRunner, bookId: string, exporter: SnapshotExporter): Promise<SyncSnapshot> {
  const profile = await getSyncProfile(db, bookId); const state = await readSyncBookState(db, bookId);
  const bootstrapRequired = profile?.recoveryRequired && profile.recoveryReason === FIRST_DEVICE_BOOTSTRAP_REASON;
  if (!profile || (!profile.enabled && !bootstrapRequired) || !state || state.bookEpoch !== profile.bookEpoch) throw new Error('Complete enrollment before publishing a snapshot');
  if (!state.snapshotHash) throw new Error('Sync once to obtain a canonical event checkpoint before publishing a snapshot');
  const unsettled = await db.first<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE book_id=? AND book_epoch=? AND status IN ('pending','retryable','conflict','quarantined')", [bookId, state.bookEpoch]);
  const conflicts = await db.first<{ count: number }>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE book_id=? AND status='open'", [bookId]);
  if (Number(unsettled?.count || 0) > 0 || Number(conflicts?.count || 0) > 0) throw new Error('Resolve or sync all pending work before publishing a canonical recovery snapshot');
  const exported = await exporter(db, bookId);
  integer(exported.schemaVersion, 'snapshot schema version', true);
  if (typeof exported.projectionHash !== 'string' || !exported.projectionHash) throw new Error('Projection exporter returned an invalid hash');
  const payloadHash = hashPayload(exported.payload);
  const saved = await request(profile, '/v1/sync/snapshot', {
    method: 'POST',
    body: JSON.stringify({ bookId, deviceId: profile.deviceId, bookEpoch: state.bookEpoch, throughSequence: state.serverCursor, schemaVersion: exported.schemaVersion, payload: exported.payload, payloadHash, checkpointHash: state.snapshotHash, projectionHash: exported.projectionHash }),
  });
  validateSnapshot(saved, bookId, state.bookEpoch);
  if (bootstrapRequired) await db.run('UPDATE sync_profiles SET enabled=1,recovery_required=0,recovery_reason=NULL,updated_at=? WHERE id=?', [now(), bookId]);
  await writeSyncBookState(db, { ...state, projectionHash: saved.projectionHash, updatedAt: now() });
  return saved;
}

/** Validates first, then installs snapshot + sync metadata in one savepoint. Unsent intent is retained and made replayable. */
export async function installServerSnapshot(db: SqlRunner, bookId: string, installer: SnapshotInstaller, replayer: SnapshotReplayer): Promise<SyncSnapshot> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile?.bookEpoch) throw new Error('Enroll this device before downloading a snapshot');
  const snapshot = await request(profile, `/v1/sync/snapshot?bookId=${encodeURIComponent(bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}`, { method: 'GET' });
  validateSnapshot(snapshot, bookId, profile.bookEpoch);
  const canonical: any[] = [];
  let canonicalCursor = Number(snapshot.throughSequence); let canonicalCheckpoint = String(snapshot.checkpointHash);
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await request(profile, `/v1/sync/pull?bookId=${encodeURIComponent(bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}&after=${canonicalCursor}&limit=100`, { method: 'GET' });
    if (page.bookEpoch && page.bookEpoch !== snapshot.bookEpoch) throw new Error('Server epoch changed while preparing snapshot recovery');
    const events = Array.isArray(page.events) ? page.events : [];
    for (const event of events) {
      assertSyncOperation(event);
      if (event.bookId !== bookId || event.bookEpoch !== snapshot.bookEpoch || hashPayload(event.payload) !== event.payloadHash) throw new Error('Canonical recovery event failed identity or payload verification');
      if (!Number.isSafeInteger(Number(event.bookSequence)) || Number(event.bookSequence) <= canonicalCursor) throw new Error('Canonical recovery events are not strictly ordered');
      integer(event.aggregateRevision, 'canonical aggregate revision', true);
      canonical.push(event); canonicalCursor = Number(event.bookSequence);
    }
    const responseCursor = Number(page.cursor);
    if (!Number.isSafeInteger(responseCursor) || responseCursor < canonicalCursor) throw new Error('Canonical recovery cursor is invalid');
    canonicalCursor = responseCursor;
    if (typeof page.checkpointHash === 'string') canonicalCheckpoint = page.checkpointHash;
    if (!page.hasMore) break;
    if (!events.length) throw new Error('Canonical recovery pagination made no progress');
    if (pageNumber === 9_999) throw new Error('Canonical recovery exceeded the safe page limit');
  }
  return withSyncDatabaseMutationLock(async () => {
    const replay = await db.all<any>("SELECT * FROM sync_outbox WHERE book_id=? AND book_epoch=? AND status IN ('pending','retryable','quarantined') ORDER BY device_sequence", [bookId, snapshot.bookEpoch]);
    const replayIds = replay.map((row) => String(row.op_id));
    const name = `sync_snapshot_${++savepointSequence}`;
    await db.exec(`SAVEPOINT ${name}`);
    try {
    await installer(db, snapshot.payload, snapshot);
    await db.run('DELETE FROM sync_applied_ops WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM sync_entity_revisions WHERE book_id=?', [bookId]);
    for (const [aggregateId, revision] of Object.entries(snapshot.aggregateRevisions)) {
      await db.run('INSERT INTO sync_entity_revisions(book_id,aggregate_type,aggregate_id,revision,updated_at) VALUES(?,?,?,?,?)', [bookId, 'canonical_snapshot', aggregateId, revision, now()]);
    }
    for (const event of canonical) {
      await withDeterministicAccountingIds(String(event.opId), () => replayer(db, event as SyncOperation));
      await db.run("INSERT OR IGNORE INTO sync_applied_ops(op_id,book_id,book_sequence,aggregate_revision,applied_at,apply_mode) VALUES(?,?,?,?,?,'recovery_replay')", [event.opId, bookId, event.bookSequence, event.aggregateRevision ?? null, now()]);
      if (event.aggregateRevision != null) await db.run(
        `INSERT INTO sync_entity_revisions(book_id,aggregate_type,aggregate_id,revision,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(book_id,aggregate_type,aggregate_id) DO UPDATE SET revision=MAX(revision,excluded.revision),updated_at=excluded.updated_at`,
        [bookId, String(event.commandType).split('.')[0] || 'unknown', event.aggregateId, Number(event.aggregateRevision), now()],
      );
    }
    for (const row of replay) {
      const operation: SyncOperation = {
        protocolVersion: SYNC_PROTOCOL_VERSION, payloadVersion: SYNC_PAYLOAD_VERSION, opId: String(row.op_id), bookId: String(row.book_id), bookEpoch: String(row.book_epoch),
        deviceId: String(row.device_id), deviceSequence: Number(row.device_sequence), actorId: String(row.actor_id), commandType: String(row.command_type), aggregateId: String(row.aggregate_id),
        baseRevision: row.base_revision == null ? null : Number(row.base_revision), dependencies: JSON.parse(row.dependencies || '[]'), payload: JSON.parse(row.payload),
        payloadHash: String(row.payload_hash), clientCreatedAt: String(row.client_created_at), ...(row.business_date ? { businessDate: String(row.business_date) } : {}),
      };
      assertSyncOperation(operation);
      if (hashPayload(operation.payload) !== operation.payloadHash) throw new Error(`Preserved operation ${operation.opId} failed payload verification`);
      await withDeterministicAccountingIds(operation.opId, () => replayer(db, operation));
    }
    await db.run('INSERT INTO sync_bootstrap_history(snapshot_id,book_id,book_epoch,through_sequence,payload_hash,checkpoint_hash,projection_hash,installed_at,replay_operation_ids) VALUES(?,?,?,?,?,?,?,?,?)', [snapshot.snapshotId, bookId, snapshot.bookEpoch, snapshot.throughSequence, snapshot.payloadHash, snapshot.checkpointHash, snapshot.projectionHash || null, now(), JSON.stringify(replayIds)]);
    await writeSyncBookState(db, { bookId, bookEpoch: snapshot.bookEpoch, serverCursor: canonicalCursor, snapshotHash: canonicalCheckpoint, ...(!canonical.length && !replayIds.length && snapshot.projectionHash ? { projectionHash: snapshot.projectionHash } : {}), updatedAt: now() });
    for (const opId of replayIds) await db.run("UPDATE sync_outbox SET status='pending',next_retry_at=NULL,last_error=NULL,updated_at=? WHERE book_id=? AND op_id=?", [now(), bookId, opId]);
    await db.run('UPDATE sync_profiles SET enabled=1,recovery_required=0,recovery_reason=NULL,updated_at=? WHERE id=?', [now(), bookId]);
      await db.exec(`RELEASE SAVEPOINT ${name}`);
      return snapshot;
    } catch (error) {
      try { await db.exec(`ROLLBACK TO SAVEPOINT ${name}`); await db.exec(`RELEASE SAVEPOINT ${name}`); } catch { /* retain original */ }
      throw error;
    }
  });
}

export async function verifyProjectionCheckpoint(db: SqlRunner, bookId: string, hasher: ProjectionHasher): Promise<ProjectionVerification> {
  const profile = await getSyncProfile(db, bookId); const state = await readSyncBookState(db, bookId);
  if (!profile || !state) throw new Error('Sync is not enrolled');
  const projectionHash = await hasher(db, bookId);
  const result = await request(profile, '/v1/sync/checkpoints/verify', { method: 'POST', body: JSON.stringify({ bookId, bookEpoch: state.bookEpoch, throughSequence: state.serverCursor, eventHash: state.snapshotHash, projectionHash, sourceId: profile.deviceId }) }) as ProjectionVerification;
  if (result.bookId !== bookId || result.bookEpoch !== state.bookEpoch || Number(result.throughSequence) !== state.serverCursor) throw new Error('Checkpoint response does not match local sync state');
  await writeSyncBookState(db, { ...state, projectionHash, lastVerifiedAt: result.verifiedAt || now(), updatedAt: now() });
  if (!result.eventHashMatches || result.projectionHashMatches === false) await markSyncRecoveryRequired(db, bookId, 'Projection checkpoint mismatch; install a validated server snapshot before syncing again');
  return result;
}

export async function advanceSyncEpoch(db: SqlRunner, bookId: string, reason: string): Promise<SyncEpochState> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  const result = epoch(await request(profile, '/v1/sync/epoch/advance', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, expectedEpoch: profile.bookEpoch, reason, advancedBy: profile.actorId }) }), bookId);
  await markSyncRecoveryRequired(db, bookId, `Server epoch advanced: ${reason}`);
  await db.run('UPDATE sync_profiles SET book_epoch=?,updated_at=? WHERE id=?', [result.bookEpoch, now(), bookId]);
  await writeSyncBookState(db, { bookId, bookEpoch: result.bookEpoch, serverCursor: Math.max(0, result.epochStartSequence - 1), epochNumber: result.epochNumber, epochStartSequence: result.epochStartSequence, updatedAt: now() });
  return result;
}

export async function listSyncDevices(db: SqlRunner, bookId: string): Promise<SyncDevice[]> {
  const profile = await getSyncProfile(db, bookId); if (!profile) return [];
  const result = await request(profile, `/v1/sync/devices?bookId=${encodeURIComponent(bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}`, { method: 'GET' });
  return (Array.isArray(result.devices) ? result.devices : []).map((item: any) => ({ deviceId: String(item.deviceId), subject: item.subject, enrolledAt: item.enrolledAt, expiresAt: item.expiresAt, lastSeenAt: item.lastSeenAt, revokedAt: item.revokedAt == null ? null : String(item.revokedAt), ...(item.displayName ? { displayName: String(item.displayName) } : {}), ...(item.platform ? { platform: String(item.platform) } : {}), current: String(item.deviceId) === profile.deviceId }));
}

export async function renameSyncDevice(db: SqlRunner, bookId: string, targetDeviceId: string, displayName: string, platform?: string): Promise<void> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  await request(profile, '/v1/sync/devices/rename', { method: 'POST', body: JSON.stringify({ bookId, deviceId: targetDeviceId, callerDeviceId: profile.deviceId, displayName, ...(platform ? { platform } : {}) }) });
}

export async function listSyncMemberships(db: SqlRunner, bookId: string): Promise<SyncMembership[]> {
  const profile = await getSyncProfile(db, bookId); if (!profile) return [];
  const result = await request(profile, `/v1/sync/memberships?bookId=${encodeURIComponent(bookId)}&deviceId=${encodeURIComponent(profile.deviceId)}`, { method: 'GET' });
  return (Array.isArray(result.memberships) ? result.memberships : []).map((item: any) => ({ bookId: String(item.bookId || bookId), subject: String(item.subject), role: item.role, locationIds: Array.isArray(item.locationIds) ? item.locationIds.map(String) : [], updatedAt: String(item.updatedAt) }));
}

export async function upsertSyncMembership(db: SqlRunner, bookId: string, subject: string, role: SyncMembership['role']): Promise<SyncMembership> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  const result = await request(profile, '/v1/sync/memberships', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, subject, role }) });
  return { ...(result.membership as SyncMembership), bookId, subject, role, locationIds: Array.isArray(result.membership?.locationIds) ? result.membership.locationIds.map(String) : [], updatedAt: String(result.membership?.updatedAt || now()) };
}

export async function removeSyncMembership(db: SqlRunner, bookId: string, subject: string): Promise<void> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  await request(profile, '/v1/sync/memberships/remove', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, subject }) });
}

export async function setSyncMembershipLocations(db: SqlRunner, bookId: string, subject: string, locationIds: string[]): Promise<void> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  await request(profile, '/v1/sync/memberships/locations', { method: 'POST', body: JSON.stringify({ bookId, deviceId: profile.deviceId, subject, locationIds }) });
}

export async function revokeSyncDevice(db: SqlRunner, bookId: string, targetDeviceId: string): Promise<void> {
  const profile = await getSyncProfile(db, bookId); if (!profile) throw new Error('Sync is not configured');
  await request(profile, '/v1/sync/devices/revoke', { method: 'POST', body: JSON.stringify({ bookId, deviceId: targetDeviceId, callerDeviceId: profile.deviceId }) });
  if (targetDeviceId === profile.deviceId) {
    await markSyncRecoveryRequired(db, bookId, 'This device was revoked and must be explicitly re-enrolled');
    await clearSyncTokens(bookId);
  }
}
