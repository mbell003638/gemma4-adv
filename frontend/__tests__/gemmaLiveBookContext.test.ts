import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { buildLiveBookContext, createLiveReportGuard, type LiveBookProviders } from '../src/accountingV2/gemma/liveBookContext';
import { toScope } from '../src/accountingV2/gemma/branchPorts';

const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach(close => close()));

async function setup() {
  const { runner: db, close } = makeNodeRunner(); closes.push(close);
  await initSchema(db);
  const repo = new V2SqlRepository(db);
  await repo.createBook(defaultBook('a', 'A'), defaultAccounts('a'));
  await repo.createPeriod({ id: 'p', bookId: 'a', startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
  await db.run("INSERT INTO v2_personas(id,book_id,type,enabled,active,config) VALUES('a:persona:custom','a','custom',1,1,'{}')");
  await db.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id','a') ON CONFLICT(key) DO UPDATE SET value='a'");
  await db.run("INSERT INTO settings(key,value) VALUES('v2_prefs:a',?)", [JSON.stringify({ enabledFeatures: ['locations'], activeLocationId: 'shop' })]);
  let session = { storageReady: true, unlocked: true, epoch: 3 };
  let version = 9;
  const providers: LiveBookProviders = {
    activeBookId: () => 'a', readSettings: async () => ({ currency: 'inr', activePersona: 'custom' }), session: () => session,
    dataVersion: () => version, now: () => new Date('2026-09-10T04:00:00Z'), timeZone: () => 'Asia/Calcutta',
  };
  return { db, providers, current: () => buildLiveBookContext(db, providers), setSession: (next: typeof session) => { session = next; }, bump: () => { version += 1; } };
}

test('builds trusted branch context with explicit local-owner policy', async () => {
  const { current } = await setup();
  const context = await current();
  expect(context).toMatchObject({
    bookId: 'a', actorId: 'local-owner', permissionEpoch: 'local-owner:3', currency: 'INR',
    basis: 'accrual', today: '2026-09-10', timeZone: 'Asia/Calcutta', activeLocationId: 'shop',
    authorizedLocationIds: 'all', revision: '9:0::0',
  });
  expect(context.enabledFeatures).toEqual(expect.arrayContaining(['core_ledger', 'reporting', 'multi_location']));
});

test('fails closed for lock, book disagreement and sync actors without local grants', async () => {
  const { db, providers, current, setSession } = await setup();
  setSession({ storageReady: true, unlocked: false, epoch: 4 });
  await expect(current()).rejects.toThrow('APP_LOCKED');
  setSession({ storageReady: true, unlocked: true, epoch: 5 });
  providers.activeBookId = () => 'other';
  await expect(current()).rejects.toThrow('NO_ACTIVE_BOOK');
  providers.activeBookId = () => 'a';
  await db.run("INSERT INTO sync_profiles(id,server_url,user_id,enabled,created_at,updated_at) VALUES('a','https://sync.example','u',1,'x','x')");
  await expect(current()).rejects.toThrow('SYNC_PERMISSIONS_UNAVAILABLE');
});

test('guard rechecks the complete live context after a data revision', async () => {
  const { current, bump } = await setup();
  const scope = toScope(await current());
  const guard = createLiveReportGuard(current);
  await expect(guard.assertCurrent(scope)).resolves.toBeUndefined();
  bump();
  await expect(guard.assertCurrent(scope)).rejects.toThrow('STALE_SCOPE');
});
