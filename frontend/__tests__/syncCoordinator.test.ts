import { withSyncedMutationLocked , completeSyncRecovery, disableSync, enableSync, getSyncStatus, markSyncRecoveryRequired, retrySyncNow, syncNow, withSyncedMutation } from '../src/sync/coordinator';
import { withSyncDatabaseMutationLock } from '../src/sync/databaseMutex';

import { initSchema } from '../src/db/schema';
import { makeNodeRunner } from './helpers/nodeRunner';
import { makeSyncOperation, enqueueSyncOperation } from '../src/sync/outbox';
import { hashPayload } from '../src/sync/protocol';

import { enrollSyncDevice, publishServerSnapshot } from '../src/sync/recovery';
const asyncMem: Record<string, string> = {};

test('assistant-held transaction can capture sync intent without reacquiring the lock', async () => {
  const { runner, close } = await setup();
  try {
    await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", [bookId]);
    await withSyncDatabaseMutationLock(async () => {
      await runner.exec('SAVEPOINT assistant_test');
      await withSyncedMutationLocked(runner, {
        commandType: 'party.patch', aggregateType: 'party', aggregateId: 'assistant-party',
        payload: { id: 'assistant-party', patch: { phone: '123' } },
      }, async () => {
        await runner.run("INSERT INTO meta(key,value) VALUES('assistant-effect','yes')");
        return { id: 'assistant-party' };
      }, bookId);
      expect(await runner.all("SELECT * FROM sync_outbox WHERE aggregate_id='assistant-party'")).toHaveLength(1);
      await runner.exec('ROLLBACK TO SAVEPOINT assistant_test');
      await runner.exec('RELEASE SAVEPOINT assistant_test');
    });
    expect(await runner.all("SELECT * FROM sync_outbox WHERE aggregate_id='assistant-party'")).toHaveLength(0);
    expect(await runner.first("SELECT * FROM meta WHERE key='assistant-effect'")).toBeFalsy();
  } finally { close(); }
}, 15000);

test('assistant sync adapter rejects a changed active book before any write', async () => {
  const { runner, close } = await setup();
  try {
    const apply = jest.fn(async () => 'must not run');
    await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", [bookId]);
    await expect(withSyncDatabaseMutationLock(() => withSyncedMutationLocked(runner, {
      commandType: 'party.patch', aggregateId: 'assistant-party', payload: {},
    }, apply, 'different-book'))).rejects.toThrow('Active book changed');
    expect(apply).not.toHaveBeenCalled();
    expect(await runner.all('SELECT * FROM sync_outbox')).toHaveLength(0);
  } finally { close(); }
});
const secureMem: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => asyncMem[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { asyncMem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete asyncMem[key]; }),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => secureMem[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { secureMem[key] = value; }),
  deleteItemAsync: jest.fn(async (key: string) => { delete secureMem[key]; }),
}));

jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-auth-session', () => ({
  ResponseType: { Code: 'code' },
  makeRedirectUri: jest.fn(() => 'ledgr://sync-oidc'),
  fetchDiscoveryAsync: jest.fn(),
  exchangeCodeAsync: jest.fn(),
  refreshAsync: jest.fn(),
  AuthRequest: jest.fn(),
}));

const bookId = 'book-coordinator';
const epoch = 'epoch-coordinator';
const deviceId = 'device-coordinator';
const tokenKey = `ledgr:sync:${bookId}:access-token`;

function profileSql() {
  return `INSERT INTO sync_profiles(id,server_url,user_id,device_id,actor_id,book_epoch,enabled,protocol_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,1,?,?)`;
}

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const timestamp = '2026-08-20T00:00:00.000Z';
  await node.runner.run(profileSql(), [bookId, 'https://sync.example.test', 'user-coordinator', deviceId, 'user-coordinator', epoch, timestamp, timestamp]);
  await node.runner.run('INSERT INTO sync_book_state(book_id,book_epoch,server_cursor,updated_at) VALUES(?,?,0,?)', [bookId, epoch, timestamp]);
  secureMem[tokenKey] = JSON.stringify('token-coordinator');
  return node;
}

function canonical(op: ReturnType<typeof makeSyncOperation>, bookSequence: number) {
  return { ...op, aggregateRevision: 1, bookSequence, acceptedAt: '2026-08-20T00:00:01.000Z' };
}

describe('sync coordinator safety', () => {
  beforeEach(() => {
    for (const key of Object.keys(asyncMem)) delete asyncMem[key];
    for (const key of Object.keys(secureMem)) delete secureMem[key];
    jest.restoreAllMocks();
  });

  it('uses pull, push, pull ordering and commits the final cursor', async () => {
    const { runner, close } = await setup();
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId, deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-1', baseRevision: 0, dependencies: [],
      payload: { id: 'party-1', patch: { phone: '1' } }, payloadHash: hashPayload({ id: 'party-1', patch: { phone: '1' } }),
      clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    await enqueueSyncOperation(runner, op);
    await runner.run("UPDATE sync_outbox SET status='retryable',next_retry_at='2099-01-01T00:00:00.000Z' WHERE op_id=?", [op.opId]);
    const calls: string[] = [];
    let pullCount = 0;
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      calls.push(method);
      if (method === 'POST') return { ok: true, json: async () => ({ accepted: [canonical(op, 1)], cursor: 1 }) } as Response;
      if (url.includes('/v1/sync/conflicts?')) return { ok: true, json: async () => ({ conflicts: [] }) } as Response;
      pullCount += 1;
      return { ok: true, json: async () => ({ events: pullCount === 2 ? [canonical(op, 1)] : [], cursor: pullCount === 2 ? 1 : 0, hasMore: false, checkpointHash: `checkpoint-${pullCount}` }) } as Response;
    }) as unknown as typeof fetch;
    try {
      const status = await retrySyncNow(runner, bookId, async () => undefined);
      expect(calls).toEqual(['GET', 'POST', 'GET', 'GET']);
      expect(status.lastSyncAt).toEqual(expect.any(String));
      expect(await runner.first<{ server_cursor: number }>('SELECT server_cursor FROM sync_book_state WHERE book_id=?', [bookId])).toEqual({ server_cursor: 1 });
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });

  it('quarantines pending work before recovery and requires explicit epoch completion', async () => {
    const { runner, close } = await setup();
    const payload = { id: 'party-recovery', patch: { phone: '7' } };
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId, deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-recovery', baseRevision: 0, dependencies: [],
      payload, payloadHash: hashPayload(payload), clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    await enqueueSyncOperation(runner, op);
    await markSyncRecoveryRequired(runner, bookId, 'restore requires reconciliation');
    expect(await runner.first<{ status: string }>('SELECT status FROM sync_outbox WHERE op_id=?', [op.opId])).toEqual({ status: 'quarantined' });
    expect(await runner.first<{ enabled: number; recovery_required: number }>('SELECT enabled,recovery_required FROM sync_profiles WHERE id=?', [bookId])).toEqual({ enabled: 0, recovery_required: 1 });
    await expect(completeSyncRecovery(runner, bookId, 'epoch-recovered')).rejects.toThrow(/server enrollment/i);
    expect(await runner.first<{ enabled: number; recovery_required: number; book_epoch: string }>('SELECT enabled,recovery_required,book_epoch FROM sync_profiles WHERE id=?', [bookId])).toEqual({ enabled: 0, recovery_required: 1, book_epoch: epoch });
    close();
  });

  it('rolls back all remote projection writes and leaves the cursor unchanged on failure', async () => {
    const { runner, close } = await setup();
    const payload = { id: 'party-remote', patch: { phone: '9' } };
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId: 'device-remote', deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-remote', baseRevision: 0, dependencies: [],
      payload, payloadHash: hashPayload(payload), clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ events: [canonical(op, 1)], cursor: 1, hasMore: false, checkpointHash: 'checkpoint-1' }),
    })) as unknown as typeof fetch;
    try {
      await expect(syncNow(runner, bookId, async (db) => {
        await db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['remote-write', 'must-rollback']);
        throw new Error('simulated replay failure');
      })).rejects.toThrow('simulated replay failure');
      expect(await runner.first('SELECT value FROM meta WHERE key=?', ['remote-write'])).toBeNull();
      expect(await runner.first('SELECT server_cursor FROM sync_book_state WHERE book_id=?', [bookId])).toEqual({ server_cursor: 0 });
      expect(await runner.first<{ status: string; reason: string }>("SELECT status,reason FROM sync_conflicts WHERE book_id=? AND op_id=?", [bookId, op.opId])).toEqual({ status: 'open', reason: 'simulated replay failure' });
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });

  it('keeps first-device sync disabled until the user explicitly publishes a canonical snapshot', async () => {
    const { runner, close } = await setup();
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/sync/enroll')) return { ok: true, json: async () => ({ bookId, bookEpoch: 'epoch-empty', epochNumber: 1, epochStartSequence: 1, currentSequence: 0, snapshotAvailable: false }) } as Response;
      if (url.endsWith('/v1/sync/snapshot') && init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ snapshotId: 'snapshot-bootstrap', bookId, bookEpoch: 'epoch-empty', throughSequence: 0, schemaVersion: input.schemaVersion, payload: input.payload, payloadHash: input.payloadHash, checkpointHash: input.checkpointHash, projectionHash: input.projectionHash, aggregateRevisions: {}, createdAt: '2026-08-20T00:00:01.000Z' }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    try {
      await enrollSyncDevice(runner, bookId);
      expect(await getSyncStatus(runner, bookId)).toMatchObject({ enabled: false, recoveryRequired: true, bootstrapRequired: true, bookEpoch: 'epoch-empty' });
      await expect(enableSync(runner, bookId)).rejects.toThrow(/bootstrap/i);

      await publishServerSnapshot(runner, bookId, async () => ({
        schemaVersion: 1,
        payload: { schemaVersion: 1, bookId, tables: {} },
        projectionHash: 'projection-bootstrap',
      }));
      const enabled = await getSyncStatus(runner, bookId);
      expect(enabled).toMatchObject({ enabled: true, bookEpoch: 'epoch-empty', projectionHash: 'projection-bootstrap' });
      expect(enabled.recoveryRequired).toBeUndefined();
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });

  it('captures new local intent as quarantined while non-bootstrap recovery is pending', async () => {
    const { runner, close } = await setup();
    await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", [bookId]);
    await markSyncRecoveryRequired(runner, bookId, 'install canonical snapshot');
    await withSyncedMutation(runner, {
      commandType: 'party.patch', aggregateType: 'party', aggregateId: 'party-during-recovery',
      payload: { id: 'party-during-recovery', patch: { phone: '8' } },
    }, async () => {
      await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('local-recovery-write','kept')");
    });
    expect(await runner.first<{ status: string }>("SELECT status FROM sync_outbox WHERE aggregate_id='party-during-recovery'")).toEqual({ status: 'quarantined' });
    expect(await runner.first<{ value: string }>("SELECT value FROM meta WHERE key='local-recovery-write'")).toEqual({ value: 'kept' });
    close();
  });

  it('keeps capturing pending intent while an enrolled profile is manually disabled', async () => {
    const { runner, close } = await setup();
    await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", [bookId]);
    await disableSync(runner, bookId);
    await withSyncedMutation(runner, {
      commandType: 'party.patch', aggregateType: 'party', aggregateId: 'party-while-disabled',
      payload: { id: 'party-while-disabled', patch: { phone: '6' } },
    }, async () => {
      await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('disabled-local-write','kept')");
    });
    expect(await runner.first<{ status: string }>("SELECT status FROM sync_outbox WHERE aggregate_id='party-while-disabled'")).toEqual({ status: 'pending' });
    expect(await getSyncStatus(runner, bookId)).toMatchObject({ enabled: false, pending: 1 });
    close();
  });

  it('preserves cursor and checkpoint when re-enrolling into the same epoch', async () => {
    const { runner, close } = await setup();
    await runner.run("UPDATE sync_book_state SET server_cursor=12,snapshot_hash='checkpoint-12' WHERE book_id=?", [bookId]);
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ bookId, bookEpoch: epoch, epochNumber: 2, epochStartSequence: 1, currentSequence: 12, snapshotAvailable: true }) })) as unknown as typeof fetch;
    try {
      await enrollSyncDevice(runner, bookId);
      expect(await runner.first<{ server_cursor: number; snapshot_hash: string }>('SELECT server_cursor,snapshot_hash FROM sync_book_state WHERE book_id=?', [bookId])).toEqual({ server_cursor: 12, snapshot_hash: 'checkpoint-12' });
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });

  it('rejects non-positive canonical revisions before applying remote work', async () => {
    const { runner, close } = await setup();
    const payload = { id: 'party-invalid', patch: { phone: '0' } };
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId: 'device-remote', deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-invalid', baseRevision: 0, dependencies: [],
      payload, payloadHash: hashPayload(payload), clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ events: [{ ...op, bookSequence: 1, aggregateRevision: 0 }], cursor: 1, hasMore: false, checkpointHash: 'invalid' }) })) as unknown as typeof fetch;
    try {
      await expect(syncNow(runner, bookId, async () => undefined)).rejects.toThrow(/aggregate revision/i);
      expect(await runner.first('SELECT op_id FROM sync_applied_ops WHERE op_id=?', [op.opId])).toBeNull();
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });
});
