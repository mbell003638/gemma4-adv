import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { createScopedReportReader, ReportReadGuard } from '../src/accountingV2/gemma/scopedReportReader';
import { createAccountingReportPorts } from '../src/accountingV2/gemma/accountingReportPorts';
import type { Scope } from '../src/accountingV2/gemma/agentCore';

const scope: Scope = { bookId: 'a', actorId: 'owner', locationId: null, permissionEpoch: '1', featureEpoch: '1', revision: '1', currency: 'INR', basis: 'accrual', today: '2026-09-09', timeZone: 'Asia/Calcutta' };
const closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).forEach(close => close()); });
async function setup() {
  const { runner: db, close } = makeNodeRunner(); closes.push(close);
  await initSchema(db);
  const repo = new V2SqlRepository(db);
  for (const id of ['a', 'b']) {
    await repo.createBook(defaultBook(id, id), defaultAccounts(id));
    await repo.createPeriod({ id: id + '-p', bookId: id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
    for (const [date, amount] of [['2026-01-02', 100], ['2026-02-02', id === 'a' ? 250 : 9000]] as const) {
      await repo.postJournal({ bookId: id, periodId: id + '-p', date, memo: 'sale', lines: [
        { accountId: id + ':account:1000', debit: amount, credit: 0 },
        { accountId: id + ':account:4000', debit: 0, credit: amount },
      ] });
    }
  }
  const guard: ReportReadGuard = { assertCurrent: jest.fn(async () => {}), canReadReports: async () => true, authorizedLocations: async () => 'all' };
  return { db, guard, read: createScopedReportReader(db, guard) };
}
test('real journal reads honor book and inclusive range', async () => {
  const { read } = await setup();
  const report = await read(scope, { from: '2026-02-01', to: '2026-02-28' }, 'all');
  expect(report.profitAndLoss.revenue).toBe(250);
  expect(report.trialBalance.totals).toEqual({ debit: 250, credit: 250, difference: 0 });
  expect((await read(scope, { to: '2026-02-28' }, 'all')).balanceSheet.assets).toBe(350);
});
test('branch report ports use authoritative report numbers', async () => {
  const { db, guard } = await setup();
  const ports = createAccountingReportPorts(db, guard, scope);
  expect((await ports.report('2026-02-01', '2026-02-28', 'all')).profitAndLoss.revenue).toBe(250);
  expect((await ports.balanceSheetAsOf('2026-02-28', 'all')).assets).toBe(350);
});
test('balance sheet refuses unlabelled provisional location figures', async () => {
  const { db, guard } = await setup();
  const ports = createAccountingReportPorts(db, guard, scope);
  await expect(ports.balanceSheetAsOf(scope.today, ['shop'])).rejects.toThrow('PROVISIONAL_LOCATION_COGS');
});
test('restricted actor cannot request a company report', async () => {
  const { read, guard } = await setup(); guard.authorizedLocations = async () => ['shop'];
  await expect(read(scope, { to: scope.today }, 'all')).rejects.toThrow('FORBIDDEN');
});
test('multi-location aggregation is unavailable, never widened', async () => {
  const { read } = await setup();
  await expect(read(scope, { to: scope.today }, ['one', 'two'])).rejects.toThrow('MULTI_LOCATION_REPORT_UNAVAILABLE');
});
test('denied permission does not query journal rows', async () => {
  const { read, guard, db } = await setup(); guard.canReadReports = async () => false;
  const all = jest.spyOn(db, 'all');
  await expect(read(scope, { to: scope.today }, 'all')).rejects.toThrow('FORBIDDEN');
  expect(all).not.toHaveBeenCalled();
});
test('scope is independently rechecked after report loading', async () => {
  const { read, guard } = await setup();
  (guard.assertCurrent as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('STALE_SCOPE'));
  await expect(read(scope, { to: scope.today }, 'all')).rejects.toThrow('STALE_SCOPE');
});
test('basis mismatch refuses misleading figures', async () => {
  const { read } = await setup();
  await expect(read({ ...scope, basis: 'cash' }, { to: scope.today }, 'all')).rejects.toThrow('STALE_SCOPE');
});
test.each(['2026-02-31', 'bad-date'])('invalid date %s fails closed', async to => {
  const { read } = await setup();
  await expect(read(scope, { to }, 'all')).rejects.toThrow('INVALID_ARGUMENTS');
});
