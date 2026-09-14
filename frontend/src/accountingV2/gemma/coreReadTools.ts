/**
 * The typed read tools Gemma may ask for.
 *
 * Every figure here comes from a reconciled V2 report or a scoped domain query
 * supplied as a port. Nothing imports `api.ts`, so this file stays testable and
 * the agent core stays acyclic; the composition root wires the real adapters.
 *
 * This exists because the previous read layer answered from UI DTOs it had
 * guessed at. `onDeviceReadTools.ts` reads `dashboard.sales` where the
 * dashboard publishes `totalSales`, coerces the balance sheet's nested objects
 * with `Number()`, and expects scalar `debit`/`credit` from a facade that
 * returns arrays. Each of those renders as `0.00` or "OUT OF BALANCE" with no
 * error, which is the one failure mode a bookkeeping assistant must not have.
 * So: missing data throws here. It is never a zero.
 */

import type { Json, Obj, Observation, ReadTool, Schema, Scope, ToolContext } from './agentCore';
import { validate } from './agentCore';

/** No page may exceed this; a bigger answer must be asked for more narrowly. */
export const MAX_PAGE_ROWS = 25;

const isoDate: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 };
const id: Schema = { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,64}$', maxLength: 64 };
const cursor: Schema = { type: 'string', pattern: '^[0-9a-f]{2,2048}$', maxLength: 2048 };
const query: Schema = { type: 'string', maxLength: 120 };

export const rangeSchema: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: { from: isoDate, to: isoDate },
  required: ['from', 'to'],
};

export const asOfSchema: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: { asOf: isoDate },
  required: ['asOf'],
};

export const noArgsSchema: Schema = {
  type: 'object', additionalProperties: false, properties: {}, required: [],
};

/** Entities a read may name. Mirrors the branch's assistant entity list. */
export const READ_ENTITIES = [
  'expense', 'sale', 'bill', 'supplier_payment', 'receipt', 'invoice', 'quote',
  'delivery_note', 'note', 'inventory_count', 'capital', 'drawing', 'cash_entry',
] as const;

export type ReadEntity = (typeof READ_ENTITIES)[number];

const entityEnum: Schema = { type: 'string', enum: READ_ENTITIES, maxLength: 24 };

/**
 * A real calendar date in a sane range.
 *
 * The round-trip is what rejects `2026-02-31`: a regex accepts it and `Date`
 * silently rolls it into March, which would quietly shift a period boundary.
 */
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf())) return false;
  return parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= '2099-12-31';
}

export class ReadToolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReadToolError';
  }
}

function fail(code: string): never {
  throw new ReadToolError(code);
}

function requireRange(args: Obj): { from: string; to: string } {
  const from = String(args.from ?? '');
  const to = String(args.to ?? '');
  if (!validDate(from) || !validDate(to) || from > to) fail('INVALID_ARGUMENTS');
  return { from, to };
}

/**
 * Insists a figure really is a figure.
 *
 * A port that returns `undefined` because a DTO field was renamed must break
 * the tool, not contribute a zero to a total the user will act on.
 */
export function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`MISSING_FIGURE:${field}`);
  return value;
}

function finiteAll<T extends Record<string, unknown>>(source: T, fields: readonly (keyof T & string)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of fields) out[field] = finite(source[field], field);
  return out;
}

/**
 * Opaque, scope-bound cursors.
 *
 * A cursor is not an offset into a changing table. It carries the book and the
 * data revision it was minted under, so a page fetched after a sync cannot be
 * stitched onto one fetched before it.
 */
function toHex(text: string): string {
  // encodeURIComponent first, so every code unit below is plain ASCII and the
  // hex pass needs no UTF-8 handling of its own.
  const escaped = encodeURIComponent(text);
  let hex = '';
  for (let index = 0; index < escaped.length; index += 1) {
    hex += escaped.charCodeAt(index).toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex: string): string {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) fail('INVALID_CURSOR');
  let escaped = '';
  for (let index = 0; index < hex.length; index += 2) {
    escaped += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    fail('INVALID_CURSOR');
  }
}

export function encodeCursor(scope: Scope, payload: Obj): string {
  const encoded = toHex(JSON.stringify({ b: scope.bookId, r: scope.revision, p: payload }));
  if (encoded.length > 2048) fail('CURSOR_TOO_LARGE');
  return encoded;
}

export function decodeCursor(scope: Scope, raw: string): Obj {
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromHex(raw));
  } catch (error) {
    if (error instanceof ReadToolError) throw error;
    fail('INVALID_CURSOR');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('INVALID_CURSOR');
  const row = decoded as Record<string, unknown>;
  if (row.b !== scope.bookId || row.r !== scope.revision) fail('STALE_CURSOR');
  const payload = row.p;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_CURSOR');
  return payload as Obj;
}

function optionalCursor(args: Obj, scope: Scope): Obj | null {
  const raw = args.cursor;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !raw) fail('INVALID_CURSOR');
  return decodeCursor(scope, raw);
}

/** A page as a port returns it: the rows shown plus whether more exist. */
export type Page<T> = { rows: T[]; hasMore: boolean; next: Obj | null };

/**
 * Location authority.
 *
 * `locationId: null` means "the whole book" only for an actor entitled to the
 * whole book. For a restricted actor it must resolve to their authorized set
 * or be refused; fetching everything and trimming afterwards would already
 * have put other locations' figures in front of the model.
 */
export type LocationPorts = {
  authorizedLocationIds(scope: Scope): Promise<string[] | 'all'>;
};

async function resolveLocations(ports: LocationPorts, scope: Scope): Promise<string[] | 'all'> {
  const authorized = await ports.authorizedLocationIds(scope);
  if (scope.locationId !== null) {
    if (authorized !== 'all' && !authorized.includes(scope.locationId)) fail('FORBIDDEN');
    return [scope.locationId];
  }
  if (authorized === 'all') return 'all';
  if (!authorized.length) fail('FORBIDDEN');
  return authorized;
}

type Meta = { source: string; truncated?: boolean; nextCursor?: string | null };

function observe(context: ToolContext, meta: Meta, data: Json): Observation {
  return {
    source: meta.source,
    scope: context.scope,
    asOf: new Date().toISOString(),
    data,
    truncated: meta.truncated === true,
    nextCursor: meta.nextCursor ?? null,
  };
}

/** Wraps a read so scope is rechecked either side of the domain call. */
function readOnly(tool: ReadTool): ReadTool {
  const read = tool.read;
  return { ...tool, read: async (args, context) => {
    await context.assertCurrent();
    if (!await tool.authorize(context)) fail('FORBIDDEN');
    if (validate(tool.parameters, args).length) fail('INVALID_ARGUMENTS');
    await context.assertCurrent();
    const result = await read(args, context);
    await context.assertCurrent();
    if (!await tool.authorize(context)) fail('FORBIDDEN');
    return result;
  } };
}

function guarded(
  read: (args: Obj, context: ToolContext) => Promise<Observation>,
): (args: Obj, context: ToolContext) => Promise<Observation> {
  return async (args, context) => {
    await context.assertCurrent();
    const observation = await read(args, context);
    await context.assertCurrent();
    return observation;
  };
}

// --- Reports -------------------------------------------------------------

export type PnlFigures = {
  revenue: number;
  cogs: number;
  grossProfit: number;
  /** Accrual includes COGS; cash basis expenses exclude cash-paid purchases. */
  expenses: number;
  netProfit: number;
  commission: number;
};

export type PnlPorts = LocationPorts & {
  canReadReports(scope: Scope): Promise<boolean>;
  readPnl(from: string, to: string, locations: string[] | 'all'): Promise<PnlFigures>;
};

export function pnlTool(ports: PnlPorts): ReadTool {
return readOnly({
    name: 'read_profit_and_loss',
    access: 'read',
    feature: 'reports',
    description: 'Read the reconciled profit and loss for an inclusive local-date range in the current book and location.',
    parameters: rangeSchema,
    authorize: (context) => ports.canReadReports(context.scope),
    read: guarded(async (args, context) => {
      const { from, to } = requireRange(args);
      const locations = await resolveLocations(ports, context.scope);
      const figures = await ports.readPnl(from, to, locations);
      const numbers = finiteAll(figures, ['revenue', 'cogs', 'grossProfit', 'expenses', 'netProfit', 'commission']);
      const accrual = context.scope.basis === 'accrual';
      const totalExpenses = accrual ? numbers.expenses : numbers.expenses + numbers.cogs;
      const operatingExpenses = accrual ? numbers.expenses - numbers.cogs : numbers.expenses;
      if (Math.abs(numbers.grossProfit - (numbers.revenue - numbers.cogs)) > 0.005
        || Math.abs(numbers.netProfit - (numbers.revenue - totalExpenses)) > 0.005) {
        fail('INCONSISTENT_PROFIT_AND_LOSS');
      }
      // The report's `expenses` includes COGS. Publishing an "operating
      // expenses" figure means subtracting it, not renaming the field.
      return observe(context, { source: 'v2-profit-and-loss' }, {
        from,
        to,
        currency: context.scope.currency,
        basis: context.scope.basis,
        revenue: numbers.revenue,
        costOfGoodsSold: numbers.cogs,
        grossProfit: numbers.grossProfit,
        totalExpensesIncludingCogs: Number(totalExpenses.toFixed(2)),
        operatingExpenses: Number(operatingExpenses.toFixed(2)),
        commission: numbers.commission,
        netProfit: numbers.netProfit,
      });
    }),
  });
}

export type TrialBalanceAccount = { code: string; name: string; debit: number; credit: number };

export type TrialBalanceFigures = {
  accounts: TrialBalanceAccount[];
  totals: { debit: number; credit: number; difference: number };
  balanced: boolean;
};

export type TrialBalancePorts = LocationPorts & {
  canReadReports(scope: Scope): Promise<boolean>;
  readTrialBalance(from: string, to: string, locations: string[] | 'all'): Promise<TrialBalanceFigures>;
};

export function trialBalanceTool(ports: TrialBalancePorts): ReadTool {
return readOnly({
    name: 'read_trial_balance',
    access: 'read',
    feature: 'reports',
    description: 'Read the trial balance accounts and totals for an inclusive local-date range, with its reconciliation state.',
    parameters: rangeSchema,
    authorize: (context) => ports.canReadReports(context.scope),
    read: guarded(async (args, context) => {
      const { from, to } = requireRange(args);
      const locations = await resolveLocations(ports, context.scope);
      const report = await ports.readTrialBalance(from, to, locations);
      if (!Array.isArray(report.accounts)) fail('MISSING_FIGURE:accounts');
      if (!report.totals || typeof report.totals !== 'object') fail('MISSING_FIGURE:totals');

      const totals = finiteAll(report.totals, ['debit', 'credit', 'difference']);
      // Recomputed from the rows rather than trusting a summary: the point of
      // a trial balance is that the two sides are checked, and `balanced` is
      // reported alongside, not instead of, the arithmetic.
      let debit = 0;
      let credit = 0;
      const accounts = report.accounts.slice(0, 200).map((account) => {
        const row = finiteAll(account, ['debit', 'credit']);
        debit += row.debit;
        credit += row.credit;
        if (typeof account.code !== 'string' || typeof account.name !== 'string') fail('MISSING_FIGURE:account');
        return { code: account.code, name: account.name, debit: row.debit, credit: row.credit };
      });
      if (typeof report.balanced !== 'boolean') fail('MISSING_FIGURE:balanced');

      const difference = Number((totals.debit - totals.credit).toFixed(2));
      if (Math.abs(totals.difference - difference) > 0.005
        || report.balanced !== (Math.abs(difference) <= 0.005)
        || (report.accounts.length <= 200
          && (Math.abs(debit - totals.debit) > 0.005 || Math.abs(credit - totals.credit) > 0.005))) {
        fail('INCONSISTENT_TRIAL_BALANCE');
      }

      return observe(context, {
        source: 'v2-trial-balance',
        truncated: report.accounts.length > 200,
      }, {
        from,
        to,
        currency: context.scope.currency,
        accounts,
        totals: { debit: totals.debit, credit: totals.credit, difference: totals.difference },
        balanced: report.balanced,
        recomputedTotals: { debit: Number(debit.toFixed(2)), credit: Number(credit.toFixed(2)) },
        accountsReturned: accounts.length,
        accountsTotal: report.accounts.length,
      });
    }),
  });
}

export type BalanceSheetFigures = {
  assets: number;
  liabilities: number;
  equity: number;
  currentEarnings: number;
  liabilitiesAndEquity: number;
  difference: number;
  balanced: boolean;
};

export type BalanceSheetPorts = LocationPorts & {
  canReadReports(scope: Scope): Promise<boolean>;
  /** Cumulative as at the given date, not a movement over a period. */
  readBalanceSheetAsOf(asOf: string, locations: string[] | 'all'): Promise<BalanceSheetFigures>;
};

export function balanceSheetTool(ports: BalanceSheetPorts): ReadTool {
return readOnly({
    name: 'read_balance_sheet',
    access: 'read',
    feature: 'reports',
    description: 'Read cumulative assets, liabilities and equity as at one local date in the current book.',
    parameters: asOfSchema,
    authorize: (context) => ports.canReadReports(context.scope),
    read: guarded(async (args, context) => {
      const asOf = String(args.asOf ?? '');
      if (!validDate(asOf)) fail('INVALID_ARGUMENTS');
      const locations = await resolveLocations(ports, context.scope);
      const sheet = await ports.readBalanceSheetAsOf(asOf, locations);
      const numbers = finiteAll(sheet, [
        'assets', 'liabilities', 'equity', 'currentEarnings', 'liabilitiesAndEquity', 'difference',
      ]);
      if (typeof sheet.balanced !== 'boolean') fail('MISSING_FIGURE:balanced');
      if (Math.abs(numbers.liabilitiesAndEquity - numbers.liabilities - numbers.equity - numbers.currentEarnings) > 0.005
        || Math.abs(numbers.difference - (numbers.assets - numbers.liabilitiesAndEquity)) > 0.005
        || sheet.balanced !== (Math.abs(numbers.difference) <= 0.005)) {
        fail('INCONSISTENT_BALANCE_SHEET');
      }
      return observe(context, { source: 'v2-balance-sheet' }, {
        asOf,
        cumulative: true,
        currency: context.scope.currency,
        ...numbers,
        balanced: sheet.balanced,
      });
    }),
  });
}

export type CashMovement = {
  id: string;
  date: string;
  amount: number;
  direction: 'in' | 'out';
  reference: string;
};

export type CashMovementsPage = Page<CashMovement> & {
  openingBalance: number;
  closingBalance: number;
  totalIn: number;
  totalOut: number;
};

export type CashPorts = LocationPorts & {
  canReadCash(scope: Scope): Promise<boolean>;
  readCashMovements(
    from: string, to: string, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<CashMovementsPage>;
};

export function cashMovementsTool(ports: CashPorts): ReadTool {
return readOnly({
    name: 'read_cash_movements',
    access: 'read',
    feature: 'cash',
    // Deliberately not called a cash-flow statement: these are posted cash and
    // bank movements, not operating/investing/financing classifications.
    description: 'Read posted cash and bank movements for a date range, with opening and closing balances. Not a classified cash-flow statement.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { from: isoDate, to: isoDate, cursor },
      required: ['from', 'to'],
    },
    authorize: (context) => ports.canReadCash(context.scope),
    read: guarded(async (args, context) => {
      const { from, to } = requireRange(args);
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const page = await ports.readCashMovements(from, to, locations, { size: MAX_PAGE_ROWS, after });
      const summary = finiteAll(page, ['openingBalance', 'closingBalance', 'totalIn', 'totalOut']);
      const rows = requireRows(page.rows, (row) => ({
        id: requireId(row.id),
        date: requireDate(row.date),
        amount: finite(row.amount, 'amount'),
        direction: row.direction === 'in' || row.direction === 'out' ? row.direction : fail('MISSING_FIGURE:direction'),
        reference: String(row.reference ?? ''),
      }));
      return observe(context, {
        source: 'v2-cash-movements',
        truncated: page.hasMore,
        nextCursor: page.hasMore && page.next ? encodeCursor(context.scope, page.next) : null,
      }, {
        from,
        to,
        currency: context.scope.currency,
        // The totals cover the whole authorized range, not this page, so the
        // model cannot mistake a page sum for a period total.
        totalsCoverFullRange: true,
        ...summary,
        movements: rows,
        rowsReturned: rows.length,
        morePages: page.hasMore,
      });
    }),
  });
}

// --- Parties -------------------------------------------------------------

export type PartyRow = {
  id: string;
  name: string;
  role: 'customer' | 'supplier';
  balance: number;
};

export type PartyPorts = LocationPorts & {
  canReadParties(scope: Scope): Promise<boolean>;
  searchParties(
    text: string, role: 'customer' | 'supplier' | 'any', locations: string[] | 'all',
    page: { size: number; after: Obj | null },
  ): Promise<Page<PartyRow>>;
};

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 64) fail('MISSING_FIGURE:id');
  return value;
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !validDate(value)) fail('MISSING_FIGURE:date');
  return value;
}

function requireRows<T, R>(rows: T[] | undefined, map: (row: T) => R): R[] {
  if (!Array.isArray(rows)) fail('MISSING_FIGURE:rows');
  if (rows.length > MAX_PAGE_ROWS) fail('PAGE_TOO_LARGE');
  return rows.map(map);
}

export function searchPartiesTool(ports: PartyPorts): ReadTool {
return readOnly({
    name: 'search_parties',
    access: 'read',
    feature: 'parties',
    description: 'Find customers or suppliers by name. Returns every match with its record id, role and balance.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query, role: { type: 'string', enum: ['customer', 'supplier', 'any'], maxLength: 10 }, cursor },
      required: ['query'],
    },
    authorize: (context) => ports.canReadParties(context.scope),
    read: guarded(async (args, context) => {
      const text = String(args.query ?? '').trim();
      if (!text) fail('INVALID_ARGUMENTS');
      const role = args.role === 'customer' || args.role === 'supplier' ? args.role : 'any';
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const page = await ports.searchParties(text, role, locations, { size: MAX_PAGE_ROWS, after });
      const rows = requireRows(page.rows, (row) => ({
        id: requireId(row.id),
        name: typeof row.name === 'string' && row.name ? row.name : fail('MISSING_FIGURE:name'),
        role: row.role === 'customer' || row.role === 'supplier' ? row.role : fail('MISSING_FIGURE:role'),
        balance: finite(row.balance, 'balance'),
      }));
      // Several matches stay several. Collapsing them to the closest name is
      // how a payment lands on the wrong ledger.
      return observe(context, {
        source: 'v2-party-search',
        truncated: page.hasMore,
        nextCursor: page.hasMore && page.next ? encodeCursor(context.scope, page.next) : null,
      }, {
        query: text,
        role,
        currency: context.scope.currency,
        matches: rows,
        matchCount: rows.length,
        ambiguous: rows.length > 1,
        morePages: page.hasMore,
      });
    }),
  });
}

export type StatementMovement = {
  id: string;
  date: string;
  amount: number;
  direction: 'debit' | 'credit';
  reference: string;
};

export type PartyStatement = Page<StatementMovement> & {
  partyId: string;
  partyName: string;
  role: 'customer' | 'supplier';
  openingBalance: number;
  closingBalance: number;
  revision: string;
};

export type StatementPorts = LocationPorts & {
  canReadParties(scope: Scope): Promise<boolean>;
  readPartyStatement(
    partyId: string, from: string, to: string, locations: string[] | 'all',
    page: { size: number; after: Obj | null },
  ): Promise<PartyStatement | null>;
};

export function partyStatementTool(ports: StatementPorts): ReadTool {
return readOnly({
    name: 'read_party_statement',
    access: 'read',
    feature: 'parties',
    description: 'Read one known customer or supplier statement for a date range: opening balance, movements and closing balance.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { partyId: id, from: isoDate, to: isoDate, cursor },
      required: ['partyId', 'from', 'to'],
    },
    authorize: (context) => ports.canReadParties(context.scope),
    read: guarded(async (args, context) => {
      const partyId = String(args.partyId ?? '');
      if (!partyId) fail('INVALID_ARGUMENTS');
      const { from, to } = requireRange(args);
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const statement = await ports.readPartyStatement(partyId, from, to, locations, { size: MAX_PAGE_ROWS, after });
      // A party id the model invented, or one from another book, resolves to
      // nothing here rather than to someone else's ledger.
      if (!statement) fail('UNKNOWN_PARTY');
      const balances = finiteAll(statement, ['openingBalance', 'closingBalance']);
      const rows = requireRows(statement.rows, (row) => ({
        id: requireId(row.id),
        date: requireDate(row.date),
        amount: finite(row.amount, 'amount'),
        direction: row.direction === 'debit' || row.direction === 'credit' ? row.direction : fail('MISSING_FIGURE:direction'),
        reference: String(row.reference ?? ''),
      }));
      return observe(context, {
        source: 'v2-party-statement',
        truncated: statement.hasMore,
        nextCursor: statement.hasMore && statement.next ? encodeCursor(context.scope, statement.next) : null,
      }, {
        partyId: requireId(statement.partyId),
        partyName: String(statement.partyName ?? ''),
        role: statement.role,
        revision: String(statement.revision ?? ''),
        from,
        to,
        currency: context.scope.currency,
        ...balances,
        movements: rows,
        morePages: statement.hasMore,
      });
    }),
  });
}

// --- Entries -------------------------------------------------------------

export type EntrySummary = {
  id: string;
  entity: ReadEntity;
  date: string;
  amount: number;
  reference: string;
  revision: string;
};

export type EntryDetail = EntrySummary & {
  partyId?: string;
  partyName?: string;
  locationId?: string;
  reversible: boolean;
  editable: boolean;
  allocations: { id: string; amount: number; appliesTo: string }[];
};

export type EntryPorts = LocationPorts & {
  canReadEntity(scope: Scope, entity: ReadEntity): Promise<boolean>;
  searchEntries(
    entity: ReadEntity, from: string, to: string, text: string | null,
    locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<Page<EntrySummary> & { totalAmountForRange: number }>;
  readEntry(entity: ReadEntity, entryId: string, locations: string[] | 'all'): Promise<EntryDetail | null>;
};

function requireEntity(value: unknown): ReadEntity {
  if (typeof value !== 'string' || !(READ_ENTITIES as readonly string[]).includes(value)) fail('INVALID_ARGUMENTS');
  return value as ReadEntity;
}

export function searchEntriesTool(ports: EntryPorts): ReadTool {
return readOnly({
    name: 'search_entries',
    access: 'read',
    feature: 'entries',
    description: 'List records of one kind in a date range, with their ids, dates, amounts and references.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { entity: entityEnum, from: isoDate, to: isoDate, query, cursor },
      required: ['entity', 'from', 'to'],
    },
    authorize: async () => true,
    read: guarded(async (args, context) => {
      const entity = requireEntity(args.entity);
      // Per-entity permission, checked here because one tool covers many kinds.
      if (!await ports.canReadEntity(context.scope, entity)) fail('FORBIDDEN');
      const { from, to } = requireRange(args);
      const text = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : null;
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const page = await ports.searchEntries(entity, from, to, text, locations, { size: MAX_PAGE_ROWS, after });
      const rows = requireRows(page.rows, (row) => ({
        id: requireId(row.id),
        entity,
        date: requireDate(row.date),
        amount: finite(row.amount, 'amount'),
        reference: String(row.reference ?? ''),
        revision: String(row.revision ?? ''),
      }));
      return observe(context, {
        source: `v2-entries-${entity}`,
        truncated: page.hasMore,
        nextCursor: page.hasMore && page.next ? encodeCursor(context.scope, page.next) : null,
      }, {
        entity,
        from,
        to,
        query: text,
        currency: context.scope.currency,
        totalAmountForRange: finite(page.totalAmountForRange, 'totalAmountForRange'),
        totalsCoverFullRange: true,
        rows,
        rowsReturned: rows.length,
        morePages: page.hasMore,
      });
    }),
  });
}

export function readEntryTool(ports: EntryPorts): ReadTool {
return readOnly({
    name: 'read_entry',
    access: 'read',
    feature: 'entries',
    description: 'Read one known record by its id, including its allocations and whether it can still be edited or reversed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { entity: entityEnum, entryId: id },
      required: ['entity', 'entryId'],
    },
    authorize: async () => true,
    read: guarded(async (args, context) => {
      const entity = requireEntity(args.entity);
      if (!await ports.canReadEntity(context.scope, entity)) fail('FORBIDDEN');
      const entryId = String(args.entryId ?? '');
      if (!entryId) fail('INVALID_ARGUMENTS');
      const locations = await resolveLocations(ports, context.scope);
      const entry = await ports.readEntry(entity, entryId, locations);
      if (!entry) fail('UNKNOWN_ENTRY');
      const allocations = Array.isArray(entry.allocations)
        ? entry.allocations.slice(0, MAX_PAGE_ROWS).map((allocation) => ({
          id: requireId(allocation.id),
          amount: finite(allocation.amount, 'allocation.amount'),
          appliesTo: String(allocation.appliesTo ?? ''),
        }))
        : [];
      return observe(context, { source: `v2-entry-${entity}` }, {
        entity,
        id: requireId(entry.id),
        date: requireDate(entry.date),
        amount: finite(entry.amount, 'amount'),
        reference: String(entry.reference ?? ''),
        revision: String(entry.revision ?? ''),
        currency: context.scope.currency,
        ...(entry.partyId ? { partyId: entry.partyId } : {}),
        ...(entry.partyName ? { partyName: entry.partyName } : {}),
        ...(entry.locationId ? { locationId: entry.locationId } : {}),
        reversible: entry.reversible === true,
        editable: entry.editable === true,
        allocations,
      });
    }),
  });
}

export type UnpaidInvoice = {
  id: string;
  date: string;
  dueDate: string | null;
  total: number;
  outstanding: number;
  status: string;
  allocatable: boolean;
};

export type InvoicePorts = LocationPorts & {
  canReadInvoices(scope: Scope): Promise<boolean>;
  readUnpaidInvoices(
    partyId: string, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<(Page<UnpaidInvoice> & { totalOutstanding: number }) | null>;
};

export function unpaidInvoicesTool(ports: InvoicePorts): ReadTool {
return readOnly({
    name: 'read_unpaid_invoices',
    access: 'read',
    feature: 'invoices',
    description: 'Read the outstanding invoices for one known customer, with amounts due, due dates and whether a receipt can be allocated.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { partyId: id, cursor },
      required: ['partyId'],
    },
    authorize: (context) => ports.canReadInvoices(context.scope),
    read: guarded(async (args, context) => {
      const partyId = String(args.partyId ?? '');
      if (!partyId) fail('INVALID_ARGUMENTS');
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const page = await ports.readUnpaidInvoices(partyId, locations, { size: MAX_PAGE_ROWS, after });
      if (!page) fail('UNKNOWN_PARTY');
      const rows = requireRows(page.rows, (row) => ({
        id: requireId(row.id),
        date: requireDate(row.date),
        dueDate: row.dueDate === null || row.dueDate === undefined ? null : requireDate(row.dueDate),
        total: finite(row.total, 'total'),
        outstanding: finite(row.outstanding, 'outstanding'),
        status: String(row.status ?? ''),
        allocatable: row.allocatable === true,
      }));
      return observe(context, {
        source: 'v2-unpaid-invoices',
        truncated: page.hasMore,
        nextCursor: page.hasMore && page.next ? encodeCursor(context.scope, page.next) : null,
      }, {
        partyId,
        currency: context.scope.currency,
        totalOutstanding: finite(page.totalOutstanding, 'totalOutstanding'),
        totalsCoverFullRange: true,
        invoices: rows,
        morePages: page.hasMore,
      });
    }),
  });
}

// --- Inventory and business accounts -------------------------------------

export type InventoryRow = {
  productId: string;
  name: string;
  quantity: number;
  unit: string;
  value: number;
};

export type InventorySnapshot = Page<InventoryRow> & {
  valuationMode: string;
  totalValue: number;
  provisional: boolean;
  provisionalReason: string | null;
};

export type InventoryPorts = LocationPorts & {
  canReadInventory(scope: Scope): Promise<boolean>;
  readInventory(
    text: string | null, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<InventorySnapshot>;
};

export function inventoryTool(ports: InventoryPorts): ReadTool {
return readOnly({
    name: 'read_inventory',
    access: 'read',
    feature: 'inventory',
    description: 'Read stock quantities and valuation for the current book, stating the valuation mode and whether the figure is provisional.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query, cursor },
      required: [],
    },
    authorize: (context) => ports.canReadInventory(context.scope),
    read: guarded(async (args, context) => {
      const text = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : null;
      const after = optionalCursor(args, context.scope);
      const locations = await resolveLocations(ports, context.scope);
      const snapshot = await ports.readInventory(text, locations, { size: MAX_PAGE_ROWS, after });
      if (typeof snapshot.valuationMode !== 'string' || !snapshot.valuationMode) fail('MISSING_FIGURE:valuationMode');
      const rows = requireRows(snapshot.rows, (row) => ({
        productId: requireId(row.productId),
        name: String(row.name ?? ''),
        quantity: finite(row.quantity, 'quantity'),
        unit: String(row.unit ?? ''),
        value: finite(row.value, 'value'),
      }));
      // An open period's COGS is an estimate. Saying so is the difference
      // between a caveat and a wrong margin.
      return observe(context, {
        source: 'v2-inventory',
        truncated: snapshot.hasMore,
        nextCursor: snapshot.hasMore && snapshot.next ? encodeCursor(context.scope, snapshot.next) : null,
      }, {
        currency: context.scope.currency,
        valuationMode: snapshot.valuationMode,
        totalValue: finite(snapshot.totalValue, 'totalValue'),
        provisional: snapshot.provisional === true,
        provisionalReason: snapshot.provisionalReason ?? null,
        products: rows,
        morePages: snapshot.hasMore,
      });
    }),
  });
}

export type MemberAccount = {
  memberId: string;
  name: string;
  capital: number;
  drawings: number;
  sharePct: number | null;
  revision: string;
};

export type BusinessAccountPorts = {
  canReadBusinessAccounts(scope: Scope): Promise<boolean>;
  readBusinessAccounts(
    from: string, to: string, page: { size: number; after: Obj | null },
  ): Promise<Page<MemberAccount>>;
};

export function businessAccountsTool(ports: BusinessAccountPorts): ReadTool {
return readOnly({
    name: 'read_business_accounts',
    access: 'read',
    feature: 'business-accounts',
    // "Business Accounts" is the app's own wording for this screen.
    description: 'Read the Business Accounts members for a period: capital contributed, drawings taken and profit share.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { from: isoDate, to: isoDate, cursor },
      required: ['from', 'to'],
    },
    authorize: (context) => ports.canReadBusinessAccounts(context.scope),
    read: guarded(async (args, context) => {
      const { from, to } = requireRange(args);
      const after = optionalCursor(args, context.scope);
      const page = await ports.readBusinessAccounts(from, to, { size: MAX_PAGE_ROWS, after });
      const rows = requireRows(page.rows, (row) => ({
        memberId: requireId(row.memberId),
        name: String(row.name ?? ''),
        capital: finite(row.capital, 'capital'),
        drawings: finite(row.drawings, 'drawings'),
        sharePct: row.sharePct === null || row.sharePct === undefined ? null : finite(row.sharePct, 'sharePct'),
        revision: String(row.revision ?? ''),
      }));
      return observe(context, {
        source: 'v2-business-accounts',
        truncated: page.hasMore,
        nextCursor: page.hasMore && page.next ? encodeCursor(context.scope, page.next) : null,
      }, { from, to, currency: context.scope.currency, members: rows, morePages: page.hasMore });
    }),
  });
}

// --- Capabilities --------------------------------------------------------

export type CapabilityRow = { key: string; label: string; description: string };

export type CapabilityPorts = {
  enabledFeatures(scope: Scope): Promise<CapabilityRow[]>;
  /** Coverage rows the agent can actually act on, from the register. */
  toolCoverage(scope: Scope): Promise<{ feature: string; mode: string }[]>;
  navigableScreens(scope: Scope): Promise<string[]>;
};

/** Never let a settings value reach a prompt. */
const SECRET_HINT = /(key|token|secret|password|credential|salt|hash|seed|auth|bearer|cookie|session)/i;

export function redactCapability(row: CapabilityRow): CapabilityRow {
  const clean = (text: string) => (SECRET_HINT.test(text) ? '' : text);
  return { key: row.key, label: clean(row.label), description: clean(row.description) };
}

export function describeCapabilitiesTool(ports: CapabilityPorts): ReadTool {
return readOnly({
    name: 'describe_capabilities',
    access: 'read',
    feature: 'capabilities',
    description: 'List which workflows this book has turned on, what the assistant can do with each, and which screens it can open.',
    parameters: noArgsSchema,
    authorize: async () => true,
    read: guarded(async (_args, context) => {
      const [features, coverage, screens] = await Promise.all([
        ports.enabledFeatures(context.scope),
        ports.toolCoverage(context.scope),
        ports.navigableScreens(context.scope),
      ]);
      // Answered from the register, so a family with no tool is described as a
      // guided screen instead of being implied to be automated.
      return observe(context, { source: 'app-capabilities' }, {
        enabledFeatures: features.map(redactCapability),
        assistantCoverage: coverage.map((row) => ({ feature: row.feature, mode: row.mode })),
        navigableScreens: screens.slice(0, 40),
        note: 'Enabled does not mean automated. A feature listed as guided-screen opens the screen for you to complete.',
      });
    }),
  });
}

// --- Registry ------------------------------------------------------------

export type ReadPorts = PnlPorts & TrialBalancePorts & BalanceSheetPorts & CashPorts
  & PartyPorts & StatementPorts & EntryPorts & InvoicePorts & InventoryPorts
  & BusinessAccountPorts & CapabilityPorts;

/**
 * Every read tool. The caller selects a bundle of at most eight per turn; this
 * is the catalogue, not a set to hand over whole.
 */
export function readToolRegistry(ports: ReadPorts): ReadTool[] {
  return [
    describeCapabilitiesTool(ports),
    pnlTool(ports),
    trialBalanceTool(ports),
    balanceSheetTool(ports),
    cashMovementsTool(ports),
    searchPartiesTool(ports),
    partyStatementTool(ports),
    searchEntriesTool(ports),
    readEntryTool(ports),
    unpaidInvoicesTool(ports),
    inventoryTool(ports),
    businessAccountsTool(ports),
  ];
}
