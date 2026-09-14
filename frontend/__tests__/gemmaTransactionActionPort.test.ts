import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { ProposalStore } from '../src/accountingV2/gemma/proposalStore';
import { createProposalExecutor } from '../src/accountingV2/gemma/proposalExecutor';
import { createTransactionActionPort } from '../src/accountingV2/gemma/transactionActionPort';
import type { Scope } from '../src/accountingV2/gemma/agentCore';
import { LIVE_GEMMA_PROPOSALS } from '../src/accountingV2/gemma/liveProposalPolicy';
import { V2AppService } from '../src/accountingV2/appService';

jest.mock('../src/utils/storage', () => ({ storage: { secureGet: jest.fn(async (_key: string, fallback: unknown) => fallback), secureSet: jest.fn(async () => {}) } }));

const scope: Scope = { bookId: 'a', actorId: 'local-owner', locationId: null, permissionEpoch: 'p', featureEpoch: 'f', revision: 'r', currency: 'INR', basis: 'accrual', today: '2026-09-10', timeZone: 'Asia/Calcutta' };

test('confirmation posts once through Manus V2 services', async () => {
  const { runner: db, close } = makeNodeRunner();
  try {
    await initSchema(db);
    await initializeV2Book(db, { book: { id: 'a', name: 'A', style: 'standard', basis: 'accrual' }, period: { id: 'p', startDate: '2026-01-01', endDate: '2026-12-31' }, personas: ['custom'] });
    await db.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id','a') ON CONFLICT(key) DO UPDATE SET value='a'");
    const store = new ProposalStore(db, () => new Date('2026-09-10T05:00:00Z'));
    const proposal = await store.create({ id: 'proposal-1', requestId: 'request-1', operation: 'add_expense', normalized: { amount: 125, category: 'Fuel', date: '2026-09-10', method: 'cash' }, scope, entityVersions: {} });
    const confirm = createProposalExecutor(store, { currentScope: async () => scope, entityRevisions: async () => ({}), isPeriodOpen: async () => true, canApply: async () => true, apply: createTransactionActionPort() });
    expect(await confirm(proposal.id)).toMatchObject({ kind: 'applied', replayed: false, result: { message: 'Expense recorded ✓' } });
    expect(await db.first("SELECT COUNT(*) count FROM v2_sources WHERE book_id='a' AND type='expense'")).toEqual({ count: 1 });
    expect(await confirm(proposal.id)).toMatchObject({ kind: 'applied', replayed: true });
    expect(await db.first("SELECT COUNT(*) count FROM v2_sources WHERE book_id='a' AND type='expense'")).toEqual({ count: 1 });
  } finally { close(); }
});

test('every advertised Manus live proposal has a real transaction-bound domain route', async () => {
  const { runner: db, close } = makeNodeRunner();
  try {
    await initSchema(db);
    await initializeV2Book(db, {
      book: { id: 'a', name: 'A', style: 'standard', basis: 'accrual' },
      period: { id: 'p', startDate: '2026-01-01', endDate: '2026-12-31' },
      personas: ['custom'],
    });
    await db.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id','a') ON CONFLICT(key) DO UPDATE SET value='a'");
    const service = new V2AppService(db);
    await service.ensureParty('Supplier A', 'supplier');
    await service.ensureParty('Customer A', 'customer');
    const params: Record<string, Record<string, unknown>> = {
      add_expense: { amount: 10, category: 'Fuel' },
      log_personal_expense: { amount: 11, category: 'Personal' },
      add_sale: { amount: 12, paymentType: 'cash' },
      record_inventory: { amount: 13 },
      add_bill: { amount: 14, supplierName: 'Supplier A', paymentType: 'cash' },
      create_supplier_payment: { amount: 15, supplierName: 'Supplier A', method: 'cash' },
      add_debtor_payment: { amount: 16, name: 'Customer A', method: 'cash' },
      create_invoice: { amount: 17, clientName: 'Customer A' },
      add_debtor: { name: 'New Customer' },
      add_supplier: { name: 'New Supplier' },
    };
    const apply = createTransactionActionPort();
    for (const operation of LIVE_GEMMA_PROPOSALS) {
      expect(params[operation]).toBeDefined();
      const result = await apply(operation, { date: scope.today, ...params[operation] }, scope, db);
      expect(result.committedIds).toEqual(expect.arrayContaining([expect.any(String)]));
    }
    expect(await db.first("SELECT COUNT(*) count FROM v2_parties WHERE book_id='a' AND archived=0")).toEqual({ count: 4 });
  } finally { close(); }
});
