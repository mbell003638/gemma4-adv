import { createAgent, type Engine, type Frame, type Obj } from '../src/accountingV2/gemma/agentCore';
import {
  ScopeError,
  composeGemma,
  createProposalPorts,
  createReadPorts,
  toScope,
  type BookContext,
  type BranchDeps,
  type ReconciledReport,
} from '../src/accountingV2/gemma/branchPorts';

const bookContext: BookContext = {
  bookId: 'book-a',
  currency: 'INR',
  basis: 'accrual',
  timeZone: 'Asia/Calcutta',
  today: '2026-09-08',
  actorId: 'local-owner',
  permissionEpoch: 'p1',
  featureEpoch: 'f1',
  revision: 'r1',
  activeLocationId: null,
  authorizedLocationIds: 'all',
  enabledFeatures: ['core_ledger', 'reporting', 'cashbook', 'invoicing', 'customers', 'inventory'],
};

/** A reconciled report in the real V2Reports shape. */
const report: ReconciledReport = {
  trialBalance: {
    accounts: [
      { code: '1000', name: 'Cash', debit: 800, credit: 0 },
      { code: '4000', name: 'Sales Revenue', debit: 0, credit: 800 },
    ],
    totals: { debit: 800, credit: 800, difference: 0 },
    balanced: true,
  },
  profitAndLoss: { revenue: 800, expenses: 500, cogs: 300, grossProfit: 500, netProfit: 300 },
  balanceSheet: {
    assets: 1200, liabilities: 200, equity: 700, currentEarnings: 300,
    liabilitiesAndEquity: 1200, difference: 0, balanced: true,
  },
};

const page = <T,>(rows: T[]) => ({ rows, hasMore: false, next: null });

function deps(overrides: Partial<BranchDeps> = {}): BranchDeps {
  return {
    context: async () => bookContext,
    report: async () => report,
    balanceSheetAsOf: async () => report.balanceSheet,
    commission: async () => 25,
    cashMovements: async () => ({
      ...page([{ id: 'c1', date: '2026-02-01', amount: 100, direction: 'in' as const, reference: 'Sale' }]),
      openingBalance: 0, closingBalance: 100, totalIn: 100, totalOut: 0,
    }),
    parties: async () => page([{ id: 'p1', name: 'Amit', role: 'customer' as const, balance: 500 }]),
    partyStatement: async () => null,
    entries: async () => ({ ...page([]), totalAmountForRange: 0 }),
    entry: async () => null,
    unpaidInvoices: async () => null,
    inventory: async () => ({
      ...page([]), valuationMode: 'periodic', totalValue: 0, provisional: false, provisionalReason: null,
    }),
    businessAccounts: async () => page([]),
    featureDescriptions: async (features) =>
      features.map((key) => ({ key, label: key, description: `The ${key} workflow.` })),
    canReadEntity: async () => true,
    canPropose: async () => true,
    resolveParty: async (name, role) => [{ id: 'p1', name, role, revision: 'v1' }],
    resolveRecord: async (kind, id) => ({ id, revision: 'v2', label: `${kind} ${id}` }),
    computeAmounts: async (_operation, normalized): Promise<Record<string, number>> =>
      (typeof normalized.amount === 'number' ? { amount: normalized.amount } : {}),
    ...overrides,
  };
}

const asObj = (data: unknown) => data as Record<string, unknown>;

describe('scope construction', () => {
  it('builds a complete scope from real configuration', () => {
    expect(toScope(bookContext)).toEqual({
      bookId: 'book-a',
      locationId: null,
      actorId: 'local-owner',
      permissionEpoch: 'p1',
      featureEpoch: 'f1',
      revision: 'r1',
      currency: 'INR',
      basis: 'accrual',
      today: '2026-09-08',
      timeZone: 'Asia/Calcutta',
    });
  });

  it('refuses to assume a currency, basis, actor or timezone', () => {
    // A wrong default here would make every answer below wrong in a way that
    // looks entirely normal.
    expect(() => toScope({ ...bookContext, currency: '' })).toThrow(ScopeError);
    expect(() => toScope({ ...bookContext, currency: '' })).toThrow('SCOPE_NO_CURRENCY');
    expect(() => toScope({ ...bookContext, actorId: '' })).toThrow('SCOPE_NO_ACTOR');
    expect(() => toScope({ ...bookContext, timeZone: '' })).toThrow('SCOPE_NO_TIMEZONE');
    expect(() => toScope({ ...bookContext, bookId: '' })).toThrow('SCOPE_NO_BOOK');
    expect(() => toScope({ ...bookContext, revision: '' })).toThrow('SCOPE_NO_REVISION');
    expect(() => toScope({ ...bookContext, basis: 'hybrid' as never })).toThrow('SCOPE_BASIS_UNKNOWN');
    expect(() => toScope({ ...bookContext, today: '08-09-2026' })).toThrow('SCOPE_DATE_INVALID');
  });

  it('carries an active location through rather than widening to all', () => {
    const scoped = toScope({ ...bookContext, activeLocationId: 'loc-1' });
    expect(scoped.locationId).toBe('loc-1');
  });
});

describe('read ports over the reconciled report', () => {
  it('serves profit and loss from V2Reports.profitAndLoss', async () => {
    const ports = createReadPorts(deps());
    const figures = await ports.readPnl('2026-01-01', '2026-03-31', 'all');
    expect(figures).toEqual({
      revenue: 800, cogs: 300, grossProfit: 500, expenses: 500, netProfit: 300, commission: 25,
    });
  });

  it('serves the trial balance as accounts and totals, not scalars', async () => {
    const ports = createReadPorts(deps());
    const figures = await ports.readTrialBalance('2026-01-01', '2026-03-31', 'all');
    expect(figures.accounts).toHaveLength(2);
    expect(figures.totals).toEqual({ debit: 800, credit: 800, difference: 0 });
    expect(figures.balanced).toBe(true);
  });

  it('serves the balance sheet as scalar V2 figures', async () => {
    const ports = createReadPorts(deps());
    const sheet = await ports.readBalanceSheetAsOf('2026-03-31', 'all');
    expect(sheet.assets).toBe(1200);
    expect(sheet.balanced).toBe(true);
  });

  it('reports permission from the enabled capability set', async () => {
    const withoutCash = deps({
      context: async () => ({ ...bookContext, enabledFeatures: ['core_ledger'] }),
    });
    const ports = createReadPorts(withoutCash);
    expect(await ports.canReadCash({} as never)).toBe(false);
    expect(await ports.canReadInventory({} as never)).toBe(false);
    expect(await ports.canReadReports({} as never)).toBe(true);
  });

  it('passes the actor authorized locations through, never all', async () => {
    const restricted = deps({
      context: async () => ({ ...bookContext, authorizedLocationIds: ['loc-1'] }),
    });
    const ports = createReadPorts(restricted);
    expect(await ports.authorizedLocationIds({} as never)).toEqual(['loc-1']);
  });

  it('describes coverage honestly, including a guided-screen family', async () => {
    const withPayroll = deps({
      context: async () => ({ ...bookContext, enabledFeatures: ['cashbook', 'payroll'] }),
    });
    const ports = createReadPorts(withPayroll);
    const coverage = await ports.toolCoverage({} as never);
    expect(coverage).toEqual([
      { feature: 'cashbook', mode: 'read', route: '/cashbook' },
      { feature: 'payroll', mode: 'guided-screen', route: '/payroll' },
    ]);
  });
});

describe('proposal ports', () => {
  it('resolves a party and a record without any write capability', async () => {
    const ports = createProposalPorts(deps());
    expect(await ports.resolveParty({} as never, 'Amit', 'supplier'))
      .toEqual([{ id: 'p1', name: 'Amit', role: 'supplier', revision: 'v1' }]);
    expect(await ports.resolveRecord({} as never, 'invoice', 'inv-1'))
      .toEqual({ id: 'inv-1', revision: 'v2', label: 'invoice inv-1' });
    expect(Object.keys(ports).sort())
      .toEqual(['canPropose', 'computeAmounts', 'resolveParty', 'resolveRecord', 'today']);
  });

  it('takes today from the book context, not the device clock', async () => {
    const ports = createProposalPorts(deps({
      context: async () => ({ ...bookContext, today: '2026-01-31' }),
    }));
    expect(await ports.today({} as never)).toBe('2026-01-31');
  });
});

describe('composition', () => {
  it('builds every read and proposal tool with unique names', () => {
    const composed = composeGemma(deps());
    const names = [...composed.readTools, ...composed.proposalTools].map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(composed.readTools.length).toBe(12);
    expect(composed.proposalTools.length).toBe(31);
  });

  it('never hands a turn more than eight tools', () => {
    const composed = composeGemma(deps());
    for (const family of ['expenses', 'invoices', 'marketplace', 'inventory', 'trade']) {
      expect(composed.bundleFor(family).length).toBeLessThanOrEqual(8);
    }
  });

  it('includes the reads a proposal needs to resolve its ids', () => {
    const composed = composeGemma(deps());
    const invoices = composed.bundleFor('invoices').map((tool) => tool.name);
    expect(invoices).toContain('create_invoice');
    expect(invoices).toContain('read_unpaid_invoices');
  });

  it('asserts its own register is honest', () => {
    expect(() => composeGemma(deps()).assertRegisterHonest()).not.toThrow();
  });

  it('re-reads the scope for every step so a book switch ends the turn', async () => {
    let current = bookContext;
    const composed = composeGemma(deps({ context: async () => current }));
    const first = await composed.currentScope();
    current = { ...bookContext, bookId: 'book-b' };
    const second = await composed.currentScope();
    expect(first.bookId).toBe('book-a');
    expect(second.bookId).toBe('book-b');
  });
});

describe('end to end with the agent core', () => {
  const frame = (calls: Frame['calls'], text = ''): Frame => ({ requestId: 'request-1', calls, text });

  function engine(first: Frame, next: Frame): Engine {
    return {
      begin: jest.fn(async () => first),
      resume: jest.fn(async () => next),
      cancel: jest.fn(async () => undefined),
      finish: jest.fn(async () => undefined),
    };
  }

  it('answers a report question from the reconciled report', async () => {
    const composed = composeGemma(deps());
    const pnl = composed.readTools.find((tool) => tool.name === 'read_profit_and_loss');
    const local = engine(
      frame([{ id: '1', name: 'read_profit_and_loss', arguments: { from: '2026-01-01', to: '2026-03-31' } }]),
      frame([], 'Net profit for the quarter was INR 300.00.'),
    );

    const result = await createAgent(local).run({
      requestId: 'request-1',
      modelId: 'gemma4-e2b',
      question: 'What was the profit this quarter?',
      glossary: 'A bookkeeping application.',
      tools: [pnl!],
      canPropose: false,
      currentScope: composed.currentScope,
    });

    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.evidence).toHaveLength(1);
      const data = asObj(result.evidence[0].data);
      // The figure the model was shown is the reconciled one.
      expect(data.netProfit).toBe(300);
      expect(data.operatingExpenses).toBe(200);
      expect(result.evidence[0].source).toBe('v2-profit-and-loss');
    }
  });

  it('turns a write request into a reviewed draft, not a posting', async () => {
    const posted: string[] = [];
    const composed = composeGemma(deps({
      computeAmounts: async (operation, normalized: Obj): Promise<Record<string, number>> => {
        // A port that posted would be visible here; none exists.
        posted.push(`computed:${operation}`);
        return typeof normalized.amount === 'number' ? { amount: normalized.amount } : {};
      },
    }));
    const expense = composed.proposalTools.find((tool) => tool.name === 'add_expense');
    const local = engine(
      frame([{ id: '1', name: 'add_expense', arguments: { amount: 249.5, category: 'Tea' } }]),
      frame([], 'unused'),
    );

    const result = await createAgent(local).run({
      requestId: 'request-1',
      modelId: 'gemma4-e2b',
      question: 'Record a 249.50 tea expense',
      glossary: 'A bookkeeping application.',
      tools: [expense!],
      canPropose: true,
      currentScope: composed.currentScope,
    });

    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      expect(result.proposal.draft.operation).toBe('add_expense');
      expect(result.proposal.draft.normalized.amount).toBe(249.5);
      expect(result.proposal.draft.preview).toContain('INR 249.50');
    }
    expect(posted).toEqual(['computed:add_expense']);
    expect(local.resume).not.toHaveBeenCalled();
  });

  it('stops the turn when the book changes between steps', async () => {
    let current = bookContext;
    const composed = composeGemma(deps({ context: async () => current }));
    const pnl = composed.readTools.find((tool) => tool.name === 'read_profit_and_loss');
    const local = engine(frame([]), frame([]));
    local.begin = jest.fn(async () => {
      current = { ...bookContext, bookId: 'book-b' };
      return frame([{ id: '1', name: 'read_profit_and_loss', arguments: { from: '2026-01-01', to: '2026-03-31' } }]);
    });

    const result = await createAgent(local).run({
      requestId: 'request-1',
      modelId: 'gemma4-e2b',
      question: 'What was the profit?',
      glossary: 'A bookkeeping application.',
      tools: [pnl!],
      canPropose: false,
      currentScope: composed.currentScope,
    });

    expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  });
});
