import { ProposalStore } from '../src/accountingV2/gemma/proposalStore';
import { createProposalExecutor, type ExecutorPorts } from '../src/accountingV2/gemma/proposalExecutor';
import { schemaSql } from '../src/db/schema';
import { factoryResetV2Data, deleteV2BookData, resetV2AccountingData } from '../src/accountingV2/resetBook';
import type { Scope } from '../src/accountingV2/gemma/agentCore';
import { makeNodeRunner } from './helpers/nodeRunner';
import { withSyncDatabaseMutationLock } from '../src/sync/databaseMutex';

const scope: Scope = {
  bookId: 'a', actorId: 'owner', locationId: null, permissionEpoch: '1',
  featureEpoch: '1', revision: '1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((close) => close()); });
async function setup() {
  const { runner: db, close } = makeNodeRunner();
  cleanups.push(close);
  await db.exec(schemaSql());
  for (const id of ['a', 'b']) {
    await db.run('INSERT INTO v2_books(id,name,style,basis,created_at) VALUES(?,?,?,?,?)',
      [id, id, 'business', 'accrual', '2026-09-08']);
  }
  const store = new ProposalStore(db);
  for (const id of ['a', 'b']) {
    await store.create({ id, requestId: id, scope: { ...scope, bookId: id },
      operation: 'add_expense', normalized: { amount: 10 }, entityVersions: {} });
  }
  const ports: ExecutorPorts = {
    currentScope: async () => scope, canApply: async () => true,
    entityRevisions: async () => ({}), isPeriodOpen: async () => true,
    apply: async (_op, _args, _scope, tx) => {
      expect(tx).toBe(db);
      await tx.run("INSERT INTO expenses(id,data) VALUES('effect','{}')");
      return { id: 'effect' };
    },
  };
  return { db, store, ports };
}

test('concurrent confirmation on one connection commits exactly one effect', async () => {
  const { db, store, ports } = await setup();
  const a = createProposalExecutor(store, ports);
  const b = createProposalExecutor(new ProposalStore(db), ports);
  const results = await Promise.all([a('a'), b('a')]);
  expect(results.map((r) => r.kind)).toEqual(['applied', 'applied']);
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(1);
  expect(results[1]).toMatchObject({ replayed: true });
});

test('confirmation waits for a concurrent sync mutation before opening its savepoint', async () => {
  const { db, store, ports } = await setup();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const sync = withSyncDatabaseMutationLock(() => blocked);
  const apply = jest.fn(ports.apply);
  const confirming = createProposalExecutor(store, { ...ports, apply })('a');
  await Promise.resolve();
  await Promise.resolve();
  expect(apply).not.toHaveBeenCalled();
  release();
  await sync;
  expect((await confirming).kind).toBe('applied');
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(1);
});

test('failure rolls back the domain write and leaves the proposal retryable', async () => {
  const { db, store, ports } = await setup();
  const original = ports.apply;
  ports.apply = async (...args) => { await original(...args); throw new Error('post failed'); };
  expect(await createProposalExecutor(store, ports)('a')).toEqual({ kind: 'rejected', code: 'COMMIT_FAILED' });
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(0);
  expect((await store.find('a'))?.state).toBe('pending');
});

test.each(['actorId', 'bookId'] as const)('applied results stay bound to %s', async (key) => {
  const { store, ports } = await setup();
  const confirm = createProposalExecutor(store, ports);
  expect((await confirm('a')).kind).toBe('applied');
  ports.currentScope = async () => ({ ...scope, [key]: 'other' });
  expect(await confirm('a')).toEqual({ kind: 'rejected', code: 'STALE_SCOPE' });
});

test('replaying a successful post tolerates the revision advanced by that post', async () => {
  const { db, store, ports } = await setup();
  const confirm = createProposalExecutor(store, ports);
  expect((await confirm('a')).kind).toBe('applied');
  ports.currentScope = async () => ({ ...scope, revision: '2' });
  expect(await confirm('a')).toMatchObject({ kind: 'applied', replayed: true });
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(1);
});

test('tampered payload cannot be confirmed', async () => {
  const { db, store, ports } = await setup();
  await db.run("UPDATE assistant_proposals SET normalized_json='{\"amount\":999}' WHERE id='a'");
  expect(await createProposalExecutor(store, ports)('a')).toEqual({ kind: 'rejected', code: 'PROPOSAL_TAMPERED' });
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(0);
});

test.each(['cancelled', 'expired'] as const)('%s proposal cannot post', async (state) => {
  const { db, store, ports } = await setup();
  await db.run('UPDATE assistant_proposals SET state=? WHERE id=?', [state, 'a']);
  expect((await createProposalExecutor(store, ports)('a')).kind).toBe('rejected');
  expect(await db.all('SELECT * FROM expenses')).toHaveLength(0);
});

test('book deletion clears only that book proposals', async () => {
  const { db, store } = await setup();
  await deleteV2BookData(db, 'a');
  expect(await store.find('a')).toBeNull();
  expect(await store.find('b')).not.toBeNull();
});

test('accounting reset clears only that book proposals', async () => {
  const { db, store } = await setup();
  await resetV2AccountingData(db, 'a', '2026-01-01');
  expect(await store.find('a')).toBeNull();
  expect(await store.find('b')).not.toBeNull();
});

test('factory reset removes all proposal payloads and replay results', async () => {
  const { db } = await setup();
  await factoryResetV2Data(db);
  expect(await db.all('SELECT * FROM assistant_proposals')).toHaveLength(0);
});
