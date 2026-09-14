/**
 * The Manus composition root.
 *
 * This is the only Gemma file allowed to know about this branch's data sources,
 * and even here they arrive as injected dependencies rather than as an
 * `api.ts` import. Two reasons: `api.ts` already imports the on-device model
 * helpers, so importing it back would close a cycle; and the whole read layer
 * stays unit-testable without SQLite.
 *
 * The scope built here is the boundary of everything the assistant can see. It
 * is assembled from real configuration -- never a hard-coded currency, basis,
 * actor or all-locations default -- because a wrong default here silently
 * widens what every tool below is allowed to read.
 */

import { assertCoverage, coverageSummary, GEMMA_COVERAGE, NAVIGABLE_SCREENS } from './coverage';
import {
  readToolRegistry,
  type BalanceSheetFigures,
  type CashMovementsPage,
  type EntryDetail,
  type EntrySummary,
  type InventorySnapshot,
  type MemberAccount,
  type Page,
  type PartyRow,
  type PartyStatement,
  type PnlFigures,
  type ReadEntity,
  type ReadPorts,
  type TrialBalanceFigures,
  type UnpaidInvoice,
} from './coreReadTools';
import {
  proposalToolRegistry,
  selectBundle,
  type ProposalPorts,
  type ResolvedParty,
  type ResolvedRecord,
} from './proposalTools';
import type { Obj, Scope, Tool } from './agentCore';
import type { CapabilityKey } from '../../utils/capabilities';

/** A reconciled V2 report for one range, as `reports.ts` publishes it. */
export type ReconciledReport = {
  trialBalance: {
    accounts: { code: string; name: string; debit: number; credit: number }[];
    totals: { debit: number; credit: number; difference: number };
    balanced: boolean;
  };
  profitAndLoss: {
    revenue: number;
    /** Total expenses INCLUDING cost of goods sold. */
    expenses: number;
    cogs: number;
    grossProfit: number;
    netProfit: number;
  };
  balanceSheet: BalanceSheetFigures;
  provisional?: boolean;
  provisionalReason?: string;
};

export type BookContext = {
  bookId: string;
  currency: string;
  basis: 'cash' | 'accrual';
  timeZone: string;
  today: string;
  actorId: string;
  permissionEpoch: string;
  featureEpoch: string;
  revision: string;
  activeLocationId: string | null;
  authorizedLocationIds: string[] | 'all';
  enabledFeatures: CapabilityKey[];
};

/**
 * What the branch must supply.
 *
 * `report` is the one dependency with no public accessor on this branch today:
 * `api.pnlRange` returns only profit-and-loss numbers, and `api.trialBalance` /
 * `api.balanceSheet` return dashboard-derived UI shapes rather than the
 * reconciled `V2Reports`. Wiring the trial balance and balance sheet correctly
 * therefore needs `api.ts` to expose the reconciled report for a range. That is
 * a small, reviewable addition and is recorded as an open item rather than
 * approximated here -- approximating it is exactly the defect this layer exists
 * to remove.
 */
export type BranchDeps = {
  context(): Promise<BookContext>;
  report(from: string, to: string, locations: string[] | 'all'): Promise<ReconciledReport>;
  balanceSheetAsOf(asOf: string, locations: string[] | 'all'): Promise<BalanceSheetFigures>;
  commission(from: string, to: string, locations: string[] | 'all'): Promise<number>;
  cashMovements(
    from: string, to: string, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<CashMovementsPage>;
  parties(
    text: string, role: 'customer' | 'supplier' | 'any', locations: string[] | 'all',
    page: { size: number; after: Obj | null },
  ): Promise<Page<PartyRow>>;
  partyStatement(
    partyId: string, from: string, to: string, locations: string[] | 'all',
    page: { size: number; after: Obj | null },
  ): Promise<PartyStatement | null>;
  entries(
    entity: ReadEntity, from: string, to: string, text: string | null,
    locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<Page<EntrySummary> & { totalAmountForRange: number }>;
  entry(entity: ReadEntity, entryId: string, locations: string[] | 'all'): Promise<EntryDetail | null>;
  unpaidInvoices(
    partyId: string, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<(Page<UnpaidInvoice> & { totalOutstanding: number }) | null>;
  inventory(
    text: string | null, locations: string[] | 'all', page: { size: number; after: Obj | null },
  ): Promise<InventorySnapshot>;
  businessAccounts(
    from: string, to: string, page: { size: number; after: Obj | null },
  ): Promise<Page<MemberAccount>>;
  featureDescriptions(features: readonly CapabilityKey[]): Promise<{ key: string; label: string; description: string }[]>;
  /** Whether this actor may read this entity at all. */
  canReadEntity(entity: ReadEntity, context: BookContext): Promise<boolean>;
  /** Whether this actor may draft this operation. */
  canPropose(operation: string, context: BookContext): Promise<boolean>;
  resolveParty(name: string, role: 'customer' | 'supplier', context: BookContext): Promise<ResolvedParty[]>;
  resolveRecord(kind: string, id: string, context: BookContext): Promise<ResolvedRecord | null>;
  computeAmounts(operation: string, normalized: Obj, context: BookContext): Promise<Record<string, number>>;
};

export class ScopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ScopeError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns the branch's context into a `Scope`, refusing anything incomplete.
 *
 * Every field is required. A missing currency or basis means the book is not
 * ready to be read, not that USD and accrual should be assumed: an answer given
 * in the wrong currency or the wrong basis looks exactly like a correct one.
 */
export function toScope(context: BookContext): Scope {
  const require = (value: unknown, code: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new ScopeError(code);
    return value;
  };
  if (context.basis !== 'cash' && context.basis !== 'accrual') throw new ScopeError('SCOPE_BASIS_UNKNOWN');
  if (!ISO_DATE.test(context.today)) throw new ScopeError('SCOPE_DATE_INVALID');

  return {
    bookId: require(context.bookId, 'SCOPE_NO_BOOK'),
    locationId: context.activeLocationId,
    actorId: require(context.actorId, 'SCOPE_NO_ACTOR'),
    permissionEpoch: require(context.permissionEpoch, 'SCOPE_NO_PERMISSION_EPOCH'),
    featureEpoch: require(context.featureEpoch, 'SCOPE_NO_FEATURE_EPOCH'),
    revision: require(context.revision, 'SCOPE_NO_REVISION'),
    currency: require(context.currency, 'SCOPE_NO_CURRENCY'),
    basis: context.basis,
    today: context.today,
    timeZone: require(context.timeZone, 'SCOPE_NO_TIMEZONE'),
  };
}

/**
 * Read ports over the reconciled report.
 *
 * The trial balance and balance sheet come from `V2Reports`, not from the
 * dashboard: `api.trialBalance()` returns `{debits: [...], credits: [...]}`
 * assembled for a screen, and `api.balanceSheet()` returns nested asset
 * objects. Reading either as a scalar is the defect this replaces.
 */
export function createReadPorts(deps: BranchDeps): ReadPorts {
  const context = () => deps.context();

  return {
    authorizedLocationIds: async () => (await context()).authorizedLocationIds,

    canReadReports: async () => {
      const current = await context();
      return current.enabledFeatures.includes('reporting') || current.enabledFeatures.includes('core_ledger');
    },
    canReadCash: async () => (await context()).enabledFeatures.includes('cashbook'),
    canReadParties: async () => {
      const current = await context();
      return current.enabledFeatures.includes('customers') || current.enabledFeatures.includes('procurement');
    },
    canReadInvoices: async () => (await context()).enabledFeatures.includes('invoicing'),
    canReadInventory: async () => (await context()).enabledFeatures.includes('inventory'),
    canReadBusinessAccounts: async () => (await context()).enabledFeatures.includes('core_ledger'),
    canReadEntity: async (_scope, entity) => deps.canReadEntity(entity, await context()),

    readPnl: async (from, to, locations): Promise<PnlFigures> => {
      const report = await deps.report(from, to, locations);
      const commission = await deps.commission(from, to, locations);
      const pnl = report.profitAndLoss;
      return {
        revenue: pnl.revenue,
        cogs: pnl.cogs,
        grossProfit: pnl.grossProfit,
        expenses: pnl.expenses,
        netProfit: pnl.netProfit,
        commission,
      };
    },

    readTrialBalance: async (from, to, locations): Promise<TrialBalanceFigures> => {
      const report = await deps.report(from, to, locations);
      return report.trialBalance;
    },

    readBalanceSheetAsOf: (asOf, locations) => deps.balanceSheetAsOf(asOf, locations),
    readCashMovements: (from, to, locations, page) => deps.cashMovements(from, to, locations, page),
    searchParties: (text, role, locations, page) => deps.parties(text, role, locations, page),
    readPartyStatement: (partyId, from, to, locations, page) =>
      deps.partyStatement(partyId, from, to, locations, page),
    searchEntries: (entity, from, to, text, locations, page) =>
      deps.entries(entity, from, to, text, locations, page),
    readEntry: (entity, entryId, locations) => deps.entry(entity, entryId, locations),
    readUnpaidInvoices: (partyId, locations, page) => deps.unpaidInvoices(partyId, locations, page),
    readInventory: (text, locations, page) => deps.inventory(text, locations, page),
    readBusinessAccounts: (from, to, page) => deps.businessAccounts(from, to, page),

    enabledFeatures: async () => {
      const current = await context();
      return deps.featureDescriptions(current.enabledFeatures);
    },
    toolCoverage: async () => coverageSummary((await context()).enabledFeatures),
    navigableScreens: async () => Object.values(NAVIGABLE_SCREENS),
  };
}

/** Proposal ports. Nothing here can post; see `ProposalPorts`. */
export function createProposalPorts(deps: BranchDeps): ProposalPorts {
  return {
    canPropose: async (_scope, operation) => deps.canPropose(operation, await deps.context()),
    resolveParty: async (_scope, name, role) => deps.resolveParty(name, role, await deps.context()),
    resolveRecord: async (_scope, kind, id) => deps.resolveRecord(kind, id, await deps.context()),
    computeAmounts: async (_scope, operation, normalized) =>
      deps.computeAmounts(operation, normalized, await deps.context()),
    today: async () => (await deps.context()).today,
  };
}

export type GemmaComposition = {
  currentScope(): Promise<Scope>;
  readTools: Tool[];
  proposalTools: Tool[];
  /** At most eight tools for one feature family. */
  bundleFor(family: string): Tool[];
  assertRegisterHonest(): void;
};

/**
 * Wires the whole thing for this branch.
 *
 * `currentScope` is deliberately a function, not a value: the agent core calls
 * it between every step so a book switch, a lock or a sync-applied write ends
 * the turn instead of being answered from a stale snapshot.
 */
export function composeGemma(deps: BranchDeps): GemmaComposition {
  const readPorts = createReadPorts(deps);
  const proposalPorts = createProposalPorts(deps);
  const reads = readToolRegistry(readPorts);
  const proposals = proposalToolRegistry(proposalPorts);
  const readsByFeature = new Map<string, Tool[]>();
  for (const tool of reads) {
    readsByFeature.set(tool.feature, [...(readsByFeature.get(tool.feature) ?? []), tool]);
  }

  return {
    currentScope: async () => toScope(await deps.context()),
    readTools: reads,
    proposalTools: proposals,
    bundleFor: (family: string) => {
      const writes = selectBundle(family, proposalPorts);
      const relevantReads = readsByFeature.get(family) ?? [];
      // Reads first, then writes, trimmed to the per-turn budget. A turn that
      // cannot fit both is a signal to route to the screen, not to drop the
      // reads a proposal needs to resolve its ids.
      return [...relevantReads, ...writes].slice(0, 8);
    },
    assertRegisterHonest: () => {
      assertCoverage(GEMMA_COVERAGE.map((row) => row.feature), GEMMA_COVERAGE);
    },
  };
}
