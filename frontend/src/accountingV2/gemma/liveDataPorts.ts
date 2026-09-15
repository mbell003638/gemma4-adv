import type { SqlRunner } from '../../db/schema';
import { round2 } from '../../money';
import { V2BookConfigRepository } from '../bookConfigRepository';
import { buildPersistentV2Reports } from '../persistentReports';
import { partnershipProfitFromReports, postedCommissionFromReports } from '../reports';
import { MAX_PAGE_ROWS } from './coreReadTools';
import type { Obj, Scope } from './agentCore';
import type {
  CashMovementsPage, EntryDetail, EntrySummary, InventorySnapshot, MemberAccount,
  Page, PartyRow, PartyStatement, ReadEntity, UnpaidInvoice,
} from './coreReadTools';
import type { BranchDeps } from './branchPorts';
import type { ReportReadGuard } from './scopedReportReader';

type Json = Record<string, any>;
type LiveKeys = 'cashMovements' | 'parties' | 'partyStatement' | 'entries' | 'entry'
  | 'unpaidInvoices' | 'inventory' | 'businessAccounts';
type LivePorts = Pick<BranchDeps, LiveKeys>;

function json(raw: unknown): Json {
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function roles(raw: unknown): string[] {
  try { const v = JSON.parse(String(raw || '[]')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function sourceTypes(entity: ReadEntity): string[] {
  const map: Partial<Record<ReadEntity, string[]>> = {
    expense: ['expense'], sale: ['cash_sale'], bill: ['cash_purchase', 'credit_purchase'],
    supplier_payment: ['supplier_payment'], receipt: ['receipt'], invoice: ['invoice'],
    note: ['credit_note', 'debit_note'], capital: ['capital_injection'], drawing: ['drawing'],
    cash_entry: ['manual_cash_income', 'manual_cash_expense'],
  };
  const found = map[entity];
  if (!found) throw new Error('GUIDED_SCREEN_ONLY');
  return found;
}
function locationClause(locations: string[] | 'all', alias: string) {
  if (locations === 'all') return { sql: '', params: [] as string[] };
  if (!locations.length) throw new Error('NO_AUTHORIZED_LOCATION');
  return { sql: ` AND ${alias}.location_id IN (${locations.map(() => '?').join(',')})`, params: locations };
}
function cursor(page: { size: number; after: Obj | null }): { date?: string; id?: string } {
  if (!page.after) return {};
  const date = typeof page.after.date === 'string' ? page.after.date : '';
  const id = typeof page.after.id === 'string' ? page.after.id : '';
  if (!date || !id) throw new Error('INVALID_CURSOR');
  return { date, id };
}
function page<T extends { id?: string; productId?: string; memberId?: string; date?: string }>(rows: T[], size: number): Page<T> {
  const shown = rows.slice(0, size);
  const last = shown[shown.length - 1];
  return { rows: shown, hasMore: rows.length > size, next: rows.length > size && last ? { date: last.date || '', id: last.id || last.productId || last.memberId || '' } : null };
}
async function rev(db: SqlRunner, bookId: string, id: string): Promise<string> {
  const sync = await db.first<{ revision: number }>('SELECT MAX(revision) revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?', [bookId, id]);
  const local = await db.first<{ stamp: string; count: number }>('SELECT COALESCE(MAX(posted_at),\'\') stamp,COUNT(*) count FROM v2_journal_entries WHERE book_id=? AND source_id=?', [bookId, id]);
  return `${Number(sync?.revision || 0)}:${local?.stamp || ''}:${Number(local?.count || 0)}`;
}
function orderedPage<T>(rows: T[], request: { size: number; after: Obj | null }, key: (row: T) => string, binding: string): Page<T> {
  if (!Number.isInteger(request.size) || request.size < 1 || request.size > MAX_PAGE_ROWS) throw new Error('INVALID_PAGE_SIZE');
  const identities = rows.map(key);
  if (new Set(identities).size !== identities.length) throw new Error('DUPLICATE_PAGE_ID');
  let start = 0;
  if (request.after) {
    if (request.after.v !== 2 || typeof request.after.id !== 'string' || typeof request.after.binding !== 'string') throw new Error('INVALID_CURSOR');
    if (request.after.binding !== binding) throw new Error('STALE_CURSOR');
    const index = identities.indexOf(request.after.id);
    if (index < 0) throw new Error('STALE_CURSOR');
    start = index + 1;
  }
  const shown = rows.slice(start, start + request.size);
  const hasMore = start + shown.length < rows.length;
  return { rows: shown, hasMore, next: hasMore && shown.length ? { v: 2, id: key(shown[shown.length - 1]), binding } : null };
}
async function sourceRows(db: SqlRunner, scope: Scope, locations: string[] | 'all', types: string[], from?: string, to?: string) {
  const l = locationClause(locations, 'jl');
  return db.all<any>(
    `SELECT s.id,s.type,s.date,s.reference,s.metadata,s.location_id,p.name party_name
       FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') AND p.book_id=s.book_id
      WHERE s.book_id=? AND s.type IN (${types.map(() => '?').join(',')})
        ${from ? 'AND s.date>=?' : ''} ${to ? 'AND s.date<=?' : ''}
        AND EXISTS (SELECT 1 FROM v2_journal_entries je JOIN v2_journal_lines jl ON jl.journal_id=je.id
                    WHERE je.book_id=s.book_id AND je.source_id=s.id${l.sql})
      ORDER BY s.date DESC,s.id DESC`,
    [scope.bookId, ...types, ...(from ? [from] : []), ...(to ? [to] : []), ...l.params],
  );
}
function flag(value: unknown): boolean { return value === true || value === 1 || value === '1'; }
function active(meta: Json): boolean { return !flag(meta.deleted) && !flag(meta.reversed); }

export function createLiveDataPorts(db: SqlRunner, guard: ReportReadGuard, scope: Scope): LivePorts {
  // The outer cursor carries book/revision only. Bind name-ordered continuation
  // to the full request as well, so an existing ID in a different query cannot
  // silently skip the start of that query. This remains an opaque Obj payload.
  const binding = (tool: string, ...query: unknown[]) => JSON.stringify([
    scope.bookId, scope.actorId, scope.locationId, scope.permissionEpoch,
    scope.featureEpoch, scope.revision, scope.currency, scope.basis,
    scope.today, scope.timeZone, tool, ...query,
  ]);
  const guarded = async <T>(work: () => Promise<T>) => {
    await guard.assertCurrent(scope);
    const result = await work();
    await guard.assertCurrent(scope);
    return result;
  };
  return {
    parties: (text, role, locations, request) => guarded(async () => {
      const l = locationClause(locations, 'l');
      const rows = await db.all<any>(
        `SELECT p.id,p.name,p.roles,
          COALESCE(SUM(CASE WHEN a.code='1100' THEN l.debit-l.credit ELSE 0 END),0) receivable,
          COALESCE(SUM(CASE WHEN a.code='2000' THEN l.credit-l.debit ELSE 0 END),0) payable
         FROM v2_parties p LEFT JOIN v2_journal_lines l ON l.party_id=p.id${l.sql}
         LEFT JOIN v2_journal_entries j ON j.id=l.journal_id AND j.book_id=p.book_id
         LEFT JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=p.book_id
         WHERE p.book_id=? AND p.archived=0 AND lower(p.name) LIKE ?
         GROUP BY p.id,p.name,p.roles ORDER BY lower(p.name),p.id`,
        [...l.params, scope.bookId, `%${text.toLowerCase()}%`],
      );
      const expanded: PartyRow[] = rows.flatMap(row => roles(row.roles)
        .filter(item => (item === 'customer' || item === 'supplier') && (role === 'any' || item === role))
        .sort()
        .map(item => ({ id: row.id, name: row.name, role: item as 'customer' | 'supplier', balance: Number(item === 'customer' ? row.receivable : row.payable) })));
      return orderedPage(expanded, request, row => JSON.stringify([row.id, row.role]), binding('parties', text, role, locations));
    }),

    partyStatement: (partyId, from, to, locations, request) => guarded(async () => {
      const party = await db.first<any>('SELECT id,name,roles FROM v2_parties WHERE id=? AND book_id=? AND archived=0', [partyId, scope.bookId]);
      if (!party) return null;
      const partyRoles = roles(party.roles).filter(role => role === 'customer' || role === 'supplier') as ('customer' | 'supplier')[];
      if (partyRoles.length !== 1) throw new Error('AMBIGUOUS_PARTY_ROLE');
      const role = partyRoles[0];
      const l = locationClause(locations, 'l');
      const accountCodes = role === 'customer' ? ['1100', '2100'] : ['2000', '1210'];
      const rows = await db.all<any>(
        `SELECT j.id,j.date,s.reference,COALESCE(s.type,'journal') type,
          COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit
         FROM v2_journal_entries j LEFT JOIN v2_sources s ON j.source_id=s.id AND j.book_id=s.book_id
         JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=?${l.sql}
         JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=j.book_id
         WHERE j.book_id=? AND j.date<=? AND a.code IN (?,?) GROUP BY j.id,s.type,j.date,s.reference
         ORDER BY j.date,j.id`,
        [partyId, ...l.params, scope.bookId, to, ...accountCodes],
      );
      let running = 0;
      const all = rows.map(row => {
        const debit = Number(row.debit);
        const credit = Number(row.credit);
        const delta = role === 'customer' ? debit - credit : credit - debit;
        running += delta;
        return { id: row.id, date: row.date, amount: Math.abs(delta), direction: delta >= 0 ? 'debit' as const : 'credit' as const, reference: String(row.reference || row.type) };
      });
      let opening = 0;
      for (let i = 0; i < rows.length; i += 1) if (rows[i].date < from) opening += role === 'customer' ? Number(rows[i].debit) - Number(rows[i].credit) : Number(rows[i].credit) - Number(rows[i].debit);
      const ranged = all.filter(row => row.date >= from);
      const a = cursor(request);
      const eligible = a.date ? ranged.filter(row => row.date > a.date! || (row.date === a.date && row.id > a.id!)) : ranged;
      const result = page(eligible, request.size);
      return { ...result, partyId, partyName: party.name, role, openingBalance: opening, closingBalance: running, revision: await rev(db, scope.bookId, partyId) } satisfies PartyStatement;
    }),

    entries: (entity, from, to, text, locations, request) => guarded(async () => {
      if (entity === 'inventory_count') {
        const l = locations === 'all' ? { sql: '', params: [] as string[] } : { sql: ` AND location_id IN (${locations.map(() => '?').join(',')})`, params: locations };
        const rows = await db.all<any>(`SELECT id,date,value amount,notes reference FROM v2_inventory_counts WHERE book_id=? AND date>=? AND date<=?${l.sql} ORDER BY date DESC,id DESC`, [scope.bookId, from, to, ...l.params]);
        const filtered = rows.filter(row => !text || String(row.reference || '').toLowerCase().includes(text.toLowerCase()));
        const totalAmountForRange = filtered.reduce((sum, row) => sum + Number(row.amount), 0);
        const a = cursor(request);
        const eligible = a.date ? filtered.filter(row => row.date < a.date! || (row.date === a.date && row.id < a.id!)) : filtered;
        const mapped: EntrySummary[] = [];
        for (const row of eligible.slice(0, request.size + 1)) mapped.push({ id: row.id, entity, date: row.date, amount: Number(row.amount), reference: String(row.reference || ''), revision: await rev(db, scope.bookId, row.id) });
        return { ...page(mapped, request.size), totalAmountForRange };
      }
      const rows = await sourceRows(db, scope, locations, sourceTypes(entity), from, to);
      const filtered = rows.filter(row => { const m = json(row.metadata); return active(m) && (!text || `${row.reference || ''} ${row.party_name || ''} ${m.notes || ''}`.toLowerCase().includes(text.toLowerCase())); });
      const totalAmountForRange = filtered.reduce((sum, row) => sum + Number(json(row.metadata).total), 0);
      const a = cursor(request);
      const eligible = a.date ? filtered.filter(row => row.date < a.date! || (row.date === a.date && row.id < a.id!)) : filtered;
      const mapped: EntrySummary[] = [];
      for (const row of eligible.slice(0, request.size + 1)) mapped.push({ id: row.id, entity, date: row.date, amount: Number(json(row.metadata).total), reference: String(row.reference || ''), revision: await rev(db, scope.bookId, row.id) });
      return { ...page(mapped, request.size), totalAmountForRange };
    }),

    entry: (entity, entryId, locations) => guarded(async () => {
      if (entity === 'inventory_count') {
        const l = locations === 'all' ? { sql: '', params: [] as string[] } : { sql: ` AND location_id IN (${locations.map(() => '?').join(',')})`, params: locations };
        const row = await db.first<any>(`SELECT id,date,value,notes,location_id FROM v2_inventory_counts WHERE id=? AND book_id=?${l.sql}`, [entryId, scope.bookId, ...l.params]);
        return row ? { id: row.id, entity, date: row.date, amount: Number(row.value), reference: row.notes || '', revision: await rev(db, scope.bookId, row.id), locationId: row.location_id || undefined, reversible: false, editable: false, allocations: [] } : null;
      }
      const rows = await sourceRows(db, scope, locations, sourceTypes(entity));
      const row = rows.find(item => item.id === entryId);
      if (!row) return null;
      const m = json(row.metadata);
      const allocations = await db.all<any>('SELECT id,amount,invoice_source_id FROM v2_invoice_allocations WHERE book_id=? AND receipt_source_id=? ORDER BY allocated_at,id', [scope.bookId, entryId]);
      const reversed = flag(m.reversed) || Boolean(await db.first('SELECT 1 FROM v2_journal_entries o JOIN v2_journal_entries r ON r.reversal_of=o.id WHERE o.book_id=? AND o.source_id=? LIMIT 1', [scope.bookId, entryId]));
      return { id: row.id, entity, date: row.date, amount: Number(m.total), reference: String(row.reference || ''), revision: await rev(db, scope.bookId, row.id),
        ...(m.partyId ? { partyId: String(m.partyId) } : {}), ...(row.party_name ? { partyName: row.party_name } : {}), ...(row.location_id ? { locationId: row.location_id } : {}),
        reversible: active(m) && !reversed, editable: active(m) && !reversed,
        allocations: allocations.map(a => ({ id: a.id, amount: Number(a.amount), appliesTo: a.invoice_source_id })) } satisfies EntryDetail;
    }),

    unpaidInvoices: (partyId, locations, request) => guarded(async () => {
      const party = await db.first<any>('SELECT roles FROM v2_parties WHERE id=? AND book_id=? AND archived=0', [partyId, scope.bookId]);
      if (!party || !roles(party.roles).includes('customer')) return null;
      const rows = await sourceRows(db, scope, locations, ['invoice']);
      const invoices: UnpaidInvoice[] = [];
      for (const row of rows) {
        const m = json(row.metadata);
        if (!active(m) || String(m.partyId || '') !== partyId) continue;
        const allocated = await db.first<{ amount: number }>('SELECT COALESCE(SUM(amount),0) amount FROM v2_invoice_allocations WHERE book_id=? AND invoice_source_id=?', [scope.bookId, row.id]);
        const total = Number(m.total), outstanding = total - Number(allocated?.amount || 0);
        if (outstanding > 0.005) invoices.push({ id: row.id, date: row.date, dueDate: m.dueDate ? String(m.dueDate) : null, total, outstanding, status: outstanding < total ? 'partial' : 'unpaid', allocatable: true });
      }
      const totalOutstanding = invoices.reduce((sum, row) => sum + row.outstanding, 0);
      const a = cursor(request);
      const eligible = a.date ? invoices.filter(row => row.date < a.date! || (row.date === a.date && row.id < a.id!)) : invoices;
      return { ...page(eligible, request.size), totalOutstanding };
    }),

    cashMovements: (from, to, locations, request) => guarded(async () => {
      const l = locationClause(locations, 'l');
      const rows = await db.all<any>(`SELECT l.id,e.date,e.source_id,e.memo,l.debit,l.credit FROM v2_journal_entries e JOIN v2_journal_lines l ON l.journal_id=e.id${l.sql} JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=e.book_id WHERE e.book_id=? AND a.code IN ('1000','1010','1020','1030') AND e.date<=? ORDER BY e.date,e.id,l.id`, [...l.params, scope.bookId, to]);
      const openingBalance = rows.filter(row => row.date < from).reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0);
      const ranged = rows.filter(row => row.date >= from);
      const totalIn = ranged.reduce((sum, row) => sum + Number(row.debit), 0);
      const totalOut = ranged.reduce((sum, row) => sum + Number(row.credit), 0);
      // A journal can contain multiple cash lines. Use its line primary key,
      // with the same string ordering in the sort, filter and emitted cursor.
      const compare = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
      const desc = ranged.slice().sort((a, b) => compare(b.date, a.date) || compare(String(b.id), String(a.id)));
      const a = cursor(request);
      const eligible = a.date ? desc.filter(row => row.date < a.date! || (row.date === a.date && String(row.id) < a.id!)) : desc;
      const result = page(eligible.slice(0, request.size + 1).map(row => ({ id: String(row.id), date: row.date, amount: Number(row.debit) || Number(row.credit), direction: Number(row.debit) > 0 ? 'in' as const : 'out' as const, reference: String(row.source_id || row.memo || '') })), request.size);
      return { ...result, openingBalance, closingBalance: openingBalance + totalIn - totalOut, totalIn, totalOut } satisfies CashMovementsPage;
    }),

    inventory: (text, locations, request) => guarded(async () => {
      const ids = locations === 'all' ? [] : locations;
      const qtyExpr = ids.length ? `COALESCE((SELECT SUM(sm.qty) FROM v2_stock_moves sm WHERE sm.book_id=p.book_id AND sm.product_id=p.id AND sm.location_id IN (${ids.map(() => '?').join(',')})),0)` : 'p.qty';
      const rows = await db.all<any>(`SELECT p.id,p.name,p.unit,p.cost,${qtyExpr} qty FROM v2_products p WHERE p.book_id=? AND p.archived=0 AND (? IS NULL OR lower(p.name) LIKE ?) ORDER BY lower(p.name),p.id`, [...ids, scope.bookId, text, text ? `%${text.toLowerCase()}%` : null]);
      const mapped = rows.map(row => ({ productId: row.id, name: row.name, quantity: Number(row.qty), unit: String(row.unit || ''), value: Number(row.qty) * Number(row.cost) }));
      const totalValue = mapped.reduce((sum, row) => sum + row.value, 0);
      return { ...orderedPage(mapped, request, row => row.productId, binding('inventory', text, locations)), valuationMode: 'recorded-cost-times-quantity', totalValue, provisional: false, provisionalReason: null } satisfies InventorySnapshot;
    }),

    businessAccounts: (from, to, request) => guarded(async () => {
      // current_capital already includes closed-period deposits; only the open period is additive.
      const period = await db.first<any>("SELECT start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [scope.bookId]);
      if (!period) throw new Error('NO_ACTIVE_PERIOD');
      const rows = await db.all<any>('SELECT id,name,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY lower(name),id', [scope.bookId]);
      const report = await buildPersistentV2Reports(db, { bookId: scope.bookId, from: period.start_date, to: period.end_date });
      let commissionPct = 0;
      try { commissionPct = (await new V2BookConfigRepository(db).getBookConfig(scope.bookId)).retailPartnership.commissionPct; } catch { /* optional low-level book config */ }
      const allocatableProfit = partnershipProfitFromReports(report.profitAndLoss, commissionPct, postedCommissionFromReports(report)).netProfit;
      const sources = await db.all<any>("SELECT id,type,metadata FROM v2_sources WHERE book_id=? AND date>=? AND date<=? AND type IN ('capital_injection','drawing') ORDER BY date DESC,id DESC", [scope.bookId, period.start_date, period.end_date]);
      const members: MemberAccount[] = [];
      for (const row of rows) {
        let injected = 0, drawings = 0;
        for (const source of sources) {
          const m = json(source.metadata);
          const matches = m.memberId === row.id || String(m.memberName || m.partnerName || '').trim().toLowerCase() === String(row.name).trim().toLowerCase();
          if (!active(m) || !matches) continue;
          if (source.type === 'drawing') drawings += round2(Number(m.total || 0)); else injected += round2(Number(m.total || 0));
        }
        injected = round2(injected); drawings = round2(drawings);
        const openingCapital = round2(Number(row.current_capital));
        const sharePct = row.profit_share_pct == null ? null : Number(row.profit_share_pct);
        const profitShare = sharePct == null ? 0 : round2(allocatableProfit * sharePct / 100);
        members.push({ memberId: row.id, name: row.name, capital: round2(openingCapital + injected + profitShare - drawings), drawings, sharePct, revision: await rev(db, scope.bookId, row.id) });
      }
      return orderedPage(members, request, row => row.memberId, binding('businessAccounts', from, to));
    }),
  };
}
