import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { createLiveDataPorts } from '../src/accountingV2/gemma/liveDataPorts';
import type { Obj, Scope } from '../src/accountingV2/gemma/agentCore';
import { decodeCursor, encodeCursor, MAX_PAGE_ROWS, type Page } from '../src/accountingV2/gemma/coreReadTools';

const scope: Scope = { bookId: 'a', actorId: 'owner', locationId: null, permissionEpoch: '1', featureEpoch: '1', revision: '1', currency: 'INR', basis: 'accrual', today: '2026-09-10', timeZone: 'Asia/Calcutta' };
const cleanups: (() => void)[] = [];
test('cash pages traverse every cash line once with stable totals and scoped history', async () => {
  const { db, repo, ports } = await setup();
  await repo.postJournal({ id: 'multi-cash', bookId: 'a', periodId: 'a-p', date: '2026-03-02', memo: 'transfer', lines: [
    { accountId: 'a:account:1000', debit: 10, credit: 0, locationId: 'shop-a' },
    { accountId: 'a:account:1010', debit: 0, credit: 3, locationId: 'shop-a' },
    { accountId: 'a:account:3000', debit: 0, credit: 7, locationId: 'shop-a' },
  ] });
  await repo.postJournal({ id: 'other-cash', bookId: 'a', periodId: 'a-p', date: '2026-03-02', memo: 'deposit', lines: [
    { accountId: 'a:account:1000', debit: 5, credit: 0, locationId: 'shop-a' },
    { accountId: 'a:account:3000', debit: 0, credit: 5, locationId: 'shop-a' },
  ] });
  for (const [id, bookId, locationId, date] of [
    ['foreign-cash', 'b', undefined, '2026-03-02'],
    ['hidden-cash', 'a', 'shop-b', '2026-03-02'],
    ['later-cash', 'a', 'shop-a', '2026-04-01'],
  ] as const) {
    await repo.postJournal({ id, bookId, periodId: bookId + '-p', date, memo: id, lines: [
      { accountId: bookId + ':account:1000', debit: 900, credit: 0, locationId },
      { accountId: bookId + ':account:3000', debit: 0, credit: 900, locationId },
    ] });
  }
  // Integer SQLite keys deliberately straddle a digit boundary. Numeric '<'
  // must not be mixed with the adapter's string cursor order.
  await db.run("UPDATE v2_journal_lines SET id=900 WHERE journal_id='multi-cash' AND account_id='a:account:1000'");
  await db.run("UPDATE v2_journal_lines SET id=1000 WHERE journal_id='multi-cash' AND account_id='a:account:1010'");
  await db.run("UPDATE v2_journal_lines SET id=1001 WHERE journal_id='other-cash' AND account_id='a:account:1000'");

  let after: Obj | null = null;
  const seen: string[] = [];
  do {
    const result = await ports.cashMovements('2026-03-01', '2026-03-31', ['shop-a'], { size: 1, after });
    expect(result).toMatchObject({ openingBalance: 40, totalIn: 15, totalOut: 3, closingBalance: 52 });
    expect(result.rows).toHaveLength(1);
    seen.push(result.rows[0].id);
    expect(seen.length).toBeLessThanOrEqual(3);
    after = result.next;
    expect(result.hasMore).toBe(seen.length < 3);
    expect(after).toEqual(seen.length < 3 ? { date: '2026-03-02', id: seen[seen.length - 1] } : null);
  } while (after !== null);
  expect(seen).toEqual(['900', '1001', '1000']);
});

afterEach(() => cleanups.splice(0).forEach(close => close()));

async function setup() {
  const { runner: db, close } = makeNodeRunner(); cleanups.push(close);
  await initSchema(db);
  const repo = new V2SqlRepository(db);
  for (const id of ['a', 'b']) {
    await repo.createBook(defaultBook(id, id), defaultAccounts(id));
    await repo.createPeriod({ id: id + '-p', bookId: id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
  }
  await db.run("INSERT INTO v2_locations(id,book_id,name,archived) VALUES('shop-a','a','Shop A',0)");
  await db.run("INSERT INTO v2_locations(id,book_id,name,archived) VALUES('shop-b','a','Shop B',0)");
  await repo.createParty({ id: 'cust-a', bookId: 'a', name: 'Acme', roles: ['customer'] });
  await repo.createParty({ id: 'cust-b', bookId: 'b', name: 'Secret Other Book', roles: ['customer'] });
  await repo.createParty({ id: 'supplier-a', bookId: 'a', name: 'Supply Co', roles: ['supplier'] });
  const post = async (id: string, bookId: string, type: any, total: number, date: string, locationId: string | undefined, partyId: string | undefined, lines: any[]) =>
    repo.postSourceJournal({ id, bookId, type, date, locationId, reference: id, metadata: { total, partyId, dueDate: '2026-12-31' } }, {
      id: id + '-j', bookId, periodId: bookId + '-p', date, memo: id, lines,
    });
  await post('inv-a', 'a', 'invoice', 100, '2026-02-01', 'shop-a', 'cust-a', [
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 100, credit: 0 },
    { accountId: 'a:account:4000', debit: 0, credit: 100 },
  ]);
  await post('receipt-a', 'a', 'receipt', 40, '2026-02-02', 'shop-a', 'cust-a', [
    { accountId: 'a:account:1000', debit: 40, credit: 0 },
    { accountId: 'a:account:1100', partyId: 'cust-a', debit: 0, credit: 40 },
  ]);
  await db.run("INSERT INTO v2_invoice_allocations(id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at) VALUES('alloc','a','inv-a','receipt-a',40,'2026-02-02')");
  await post('secret', 'b', 'invoice', 9000, '2026-02-01', undefined, 'cust-b', [
    { accountId: 'b:account:1100', partyId: 'cust-b', debit: 9000, credit: 0 },
    { accountId: 'b:account:4000', debit: 0, credit: 9000 },
  ]);
  await db.run("INSERT INTO v2_products(id,book_id,name,unit,cost,price,qty,archived) VALUES('product-a','a','Widget','pc',3,5,7,0)");
  await db.run("INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES('member-a','a','Owner',100,100,100)");
  const guard = { assertCurrent: jest.fn(async () => {}), canReadReports: async () => true, authorizedLocations: async () => 'all' as const };
  return { db, repo, ports: createLiveDataPorts(db, guard, scope), guard };
}

async function orderedFixture() {
  const fixture = await setup();
  const { db, repo } = fixture;
  await db.run("UPDATE v2_parties SET archived=1 WHERE book_id='a'");
  for (const [id, name] of [['z', 'Alpha'], ['a', 'Beta'], ['d', 'Same'], ['c', 'Same'], ['u', 'Ωmega'], ['v', 'éclair']] as const) {
    await repo.createParty({ id, bookId: 'a', name, roles: id === 'z' ? ['supplier', 'customer'] : ['customer'] });
  }
  // Seed parties before members: production party creation correctly refuses
  // a name already used by a capital account, including our duplicate names.
  for (const [id, name] of [['z', 'Alpha'], ['a', 'Beta'], ['d', 'Same'], ['c', 'Same'], ['u', 'Ωmega'], ['v', 'éclair']] as const) {
    await db.run('INSERT INTO v2_products(id,book_id,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,0)', ['ordered-product-' + id, 'a', name, 'pc', 2, 3, 4]);
    await db.run('INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES(?,?,?,?,?,?)', ['ordered-member-' + id, 'a', name, 5, 5, 0]);
  }
  await db.run("INSERT INTO v2_products(id,book_id,name,unit,cost,price,qty,archived) VALUES('foreign-product','b','AAA Foreign','pc',1000,1000,1000,0)");
  await db.run("INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES('foreign-member','b','AAA Foreign',999,999,100)");
  return fixture;
}

async function traverse<T>(read: (request: { size: number; after: Obj | null }) => Promise<Page<T>>, size: number): Promise<T[]> {
  const result: T[] = [];
  let after: Obj | null = null;
  let calls = 0;
  do {
    const current = await read({ size, after });
    expect(current.rows.length).toBeGreaterThan(0);
    expect(current.rows.length).toBeLessThanOrEqual(size);
    result.push(...current.rows);
    calls += 1;
    expect(calls).toBeLessThanOrEqual(20);
    expect(current.hasMore).toBe(current.next !== null);
    // Exercise the actual outer encoder/parser; v2 and binding must survive.
    after = current.next ? decodeCursor(scope, encodeCursor(scope, current.next)) : null;
    if (after) expect(after.v).toBe(2);
  } while (after !== null);
  return result;
}

test.each([1, 2])('A07 all name-ordered lists traverse without loss at size %s', async size => {
  const { ports } = await orderedFixture();
  const parties = (request: { size: number; after: Obj | null }) => ports.parties('', 'any', 'all', request);
  const inventory = (request: { size: number; after: Obj | null }) => ports.inventory(null, 'all', request);
  const members = (request: { size: number; after: Obj | null }) => ports.businessAccounts('2026-01-01', '2026-12-31', request);
  const onePage = { size: MAX_PAGE_ROWS, after: null };
  const partyReference = await parties(onePage);
  expect(partyReference.hasMore).toBe(false);
  expect(partyReference.rows.slice(0, 3).map(row => [row.id, row.role])).toEqual([
    ['z', 'customer'], ['z', 'supplier'], ['a', 'customer'],
  ]);
  expect(await traverse(parties, size)).toEqual(partyReference.rows);
  const inventoryReference = await inventory(onePage);
  expect(inventoryReference.hasMore).toBe(false);
  expect(await traverse(async request => {
    const result = await inventory(request);
    expect(result.totalValue).toBe(inventoryReference.totalValue);
    return result;
  }, size)).toEqual(inventoryReference.rows);
  expect(inventoryReference.totalValue).toBe(69);
  const memberReference = await members(onePage);
  expect(memberReference.hasMore).toBe(false);
  expect(await traverse(members, size)).toEqual(memberReference.rows);
  expect(memberReference.rows.map(row => row.memberId)).not.toContain('foreign-member');
});

test('A07 deleted anchors fail closed in parties, inventory and capital lists', async () => {
  const { db, ports } = await orderedFixture();
  const parties = await ports.parties('', 'any', 'all', { size: 1, after: null });
  const inventory = await ports.inventory(null, 'all', { size: 1, after: null });
  const members = await ports.businessAccounts('2026-01-01', '2026-12-31', { size: 1, after: null });
  await db.run("DELETE FROM v2_parties WHERE id='z'");
  await db.run("DELETE FROM v2_products WHERE id='ordered-product-z'");
  await db.run("DELETE FROM v2_members WHERE id='ordered-member-z'");
  await expect(ports.parties('', 'any', 'all', { size: 1, after: parties.next })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.inventory(null, 'all', { size: 1, after: inventory.next })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.businessAccounts('2026-01-01', '2026-12-31', { size: 1, after: members.next })).rejects.toThrow('STALE_CURSOR');
});

test('A07 malformed and legacy cursors and oversized pages are rejected for every name list', async () => {
  const { ports } = await orderedFixture();
  const reads = [
    (request: { size: number; after: Obj | null }) => ports.parties('', 'any', 'all', request),
    (request: { size: number; after: Obj | null }) => ports.inventory(null, 'all', request),
    (request: { size: number; after: Obj | null }) => ports.businessAccounts('2026-01-01', '2026-12-31', request),
  ];
  for (const read of reads) {
    for (const after of [{ id: 'z' }, { v: 1, id: 'z' }, { v: 2, id: 7 }, { v: 2, id: 'z' }] as Obj[]) {
      await expect(read({ size: 1, after })).rejects.toThrow('INVALID_CURSOR');
    }
    for (const size of [0, -1, 1.5, MAX_PAGE_ROWS + 1]) {
      await expect(read({ size, after: null })).rejects.toThrow('INVALID_PAGE_SIZE');
    }
  }
});

test('A07 continuations bind query, role, location, tool and all scope epochs', async () => {
  const { db, guard, ports } = await orderedFixture();
  const first = await ports.parties('', 'any', 'all', { size: 1, after: null });
  const after = decodeCursor(scope, encodeCursor(scope, first.next!));
  await expect(ports.parties('a', 'any', 'all', { size: 1, after })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.parties('', 'customer', 'all', { size: 1, after })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.parties('', 'any', ['shop-a'], { size: 1, after })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.inventory(null, 'all', { size: 1, after })).rejects.toThrow('STALE_CURSOR');
  for (const change of [
    { bookId: 'b' }, { revision: '2' }, { permissionEpoch: '2' },
    { featureEpoch: '2' }, { actorId: 'another' }, { locationId: 'shop-a' },
  ]) {
    const changed = createLiveDataPorts(db, guard, { ...scope, ...change });
    await expect(changed.parties('', 'any', 'all', { size: 1, after })).rejects.toThrow('STALE_CURSOR');
  }
  const inventory = await ports.inventory(null, 'all', { size: 1, after: null });
  await expect(ports.inventory('a', 'all', { size: 1, after: inventory.next })).rejects.toThrow('STALE_CURSOR');
  await expect(ports.inventory(null, ['shop-a'], { size: 1, after: inventory.next })).rejects.toThrow('STALE_CURSOR');
  const members = await ports.businessAccounts('2026-01-01', '2026-12-31', { size: 1, after: null });
  await expect(ports.businessAccounts('2026-02-01', '2026-12-31', { size: 1, after: members.next })).rejects.toThrow('STALE_CURSOR');
  expect(() => decodeCursor({ ...scope, bookId: 'b' }, encodeCursor(scope, first.next!))).toThrow('STALE_CURSOR');
});

test('party search and statements remain inside the scoped book', async () => {
  const { ports } = await setup();
  const found = await ports.parties('', 'any', 'all', { size: 25, after: null });
  expect(found.rows.map(row => row.name)).toEqual(['Acme', 'Supply Co']);
  expect(found.rows.find(row => row.id === 'cust-a')).toMatchObject({ balance: 60 });
  const statement = await ports.partyStatement('cust-a', '2026-02-01', '2026-02-28', 'all', { size: 25, after: null });
  expect(statement).toMatchObject({ openingBalance: 0, closingBalance: 60 });
  expect(statement?.rows).toHaveLength(2);
});

test('entries and unpaid invoices expose real IDs and allocations', async () => {
  const { ports } = await setup();
  const entries = await ports.entries('invoice', '2026-01-01', '2026-12-31', null, 'all', { size: 25, after: null });
  expect(entries.rows).toEqual([expect.objectContaining({ id: 'inv-a', amount: 100 })]);
  const detail = await ports.entry('receipt', 'receipt-a', 'all');
  expect(detail?.allocations).toEqual([{ id: 'alloc', amount: 40, appliesTo: 'inv-a' }]);
  const unpaid = await ports.unpaidInvoices('cust-a', 'all', { size: 25, after: null });
  expect(unpaid?.rows).toEqual([expect.objectContaining({ id: 'inv-a', outstanding: 60, status: 'partial' })]);
});

test('cash, inventory and Business Accounts read authoritative rows', async () => {
  const { ports } = await setup();
  expect(await ports.cashMovements('2026-02-01', '2026-02-28', 'all', { size: 25, after: null }))
    .toMatchObject({ openingBalance: 0, totalIn: 40, totalOut: 0, closingBalance: 40 });
  expect((await ports.inventory('Wid', 'all', { size: 25, after: null })).rows)
    .toEqual([{ productId: 'product-a', name: 'Widget', quantity: 7, unit: 'pc', value: 21 }]);
  expect((await ports.businessAccounts('2026-01-01', '2026-12-31', { size: 25, after: null })).rows[0])
    .toMatchObject({ memberId: 'member-a', capital: 200, drawings: 0, sharePct: 100 });
});

test('location filters are applied in SQL and stale scope is rechecked', async () => {
  const { ports, guard } = await setup();
  const denied = await ports.entries('invoice', '2026-01-01', '2026-12-31', null, ['shop-b'], { size: 25, after: null });
  expect(denied.rows).toEqual([]);
  expect(guard.assertCurrent).toHaveBeenCalledTimes(2);
});

test('pages are bounded and anchored', async () => {
  const { ports } = await setup();
  const first = await ports.parties('', 'any', 'all', { size: 1, after: null });
  expect(first.rows).toHaveLength(1);
  expect(first.next).not.toBeNull();
  const second = await ports.parties('', 'any', 'all', { size: 1, after: first.next });
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
});

test('legacy quote and delivery-note collections are never presented as scoped V2 data', async () => {
  const { ports } = await setup();
  await expect(ports.entries('quote', '2026-01-01', '2026-12-31', null, 'all', { size: 25, after: null })).rejects.toThrow('GUIDED_SCREEN_ONLY');
  await expect(ports.entry('delivery_note', 'id', 'all')).rejects.toThrow('GUIDED_SCREEN_ONLY');
});
