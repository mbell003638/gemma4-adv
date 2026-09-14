/**
 * What the assistant can actually do, per capability.
 *
 * The register exists so "supports all features" is a claim someone can check
 * rather than a sentence in a release note. Every capability this book can
 * enable resolves to exactly one row, and a row is only `read` or `proposal`
 * when named tools really exist and really authorize that feature.
 *
 * A `guided-screen` row is an honest answer: the assistant opens the right
 * screen and the user finishes the job. Marking a row `read` or `proposal` to
 * make the table look complete would be the single worst outcome here, so the
 * assertions below are deliberately unforgiving.
 */

import { CAPABILITIES, type CapabilityKey } from '../../utils/capabilities';
import { LIVE_GEMMA_PROPOSALS } from './liveProposalPolicy';
import { PROPOSAL_SPECS } from './proposalTools';

export type CoverageMode = 'read' | 'proposal' | 'guided-screen' | 'blocked';

export type CoverageRow = {
  feature: CapabilityKey;
  mode: CoverageMode;
  tools: readonly string[];
  /** A compiled route from this branch's app directory, never model-generated. */
  route?: string;
  reason?: string;
  tests: readonly string[];
};

/**
 * Screens the assistant may open, mapped from a small enum to a real route.
 *
 * The model never supplies a URL. It names a screen; this table decides where
 * that goes, and navigating opens the screen rather than submitting its form.
 */
export const NAVIGABLE_SCREENS = {
  expenses: '/expenses',
  sales: '/sales',
  payments: '/payments',
  invoices: '/invoices',
  receipts: '/receipts',
  quotes: '/quotes',
  customers: '/customers',
  debtors: '/debtors',
  cashbook: '/cashbook',
  daybook: '/daybook',
  products: '/products',
  inventory: '/inventory-form',
  monthly: '/monthly-summary',
  customReport: '/custom-report',
  reconcile: '/reconcile',
  scanImport: '/scan-import',
  voice: '/voice',
  ask: '/ask',
  payroll: '/payroll',
  fixedAssets: '/fixed-assets',
  locations: '/locations',
  posSessions: '/pos-sessions',
  stockTransfers: '/stock-transfers',
  marketplace: '/marketplace',
  projects: '/projects',
  manufacturing: '/manufacturing',
  trade: '/trade',
  deliveryNotes: '/delivery-notes',
  assets: '/assets',
  planning: '/planning',
  modules: '/modules',
  integrations: '/integrations',
  syncSettings: '/sync-settings',
  backupRecovery: '/backup-recovery',
  advancedSettings: '/advanced-settings',
} as const;

export type ScreenId = keyof typeof NAVIGABLE_SCREENS;

export function routeFor(screen: ScreenId): string {
  return NAVIGABLE_SCREENS[screen];
}

const READ_TESTS = ['gemmaReadTools.test.ts'] as const;
const PROPOSAL_TESTS = ['gemmaProposalTools.test.ts'] as const;
const COVERAGE_TESTS = ['gemmaCoverage.test.ts'] as const;

/**
 * The register.
 *
 * Rows are honest about this stage: the read tools and the proposal registry
 * exist and are tested, so families they cover are `read`/`proposal`. Families
 * whose domain services this stage did not wire are `guided-screen` with a real
 * route. Book destruction and credentials are `blocked` outright.
 */
export const GEMMA_COVERAGE: readonly CoverageRow[] = [
  {
    feature: 'core_ledger',
    mode: 'proposal',
    tools: [
      'read_profit_and_loss', 'read_trial_balance', 'read_balance_sheet',
      'search_entries', 'read_entry', 'add_expense', 'log_personal_expense',
    ],
    route: routeFor('expenses'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'invoicing',
    mode: 'proposal',
    tools: ['read_unpaid_invoices', 'search_parties', 'create_invoice'],
    route: routeFor('invoices'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'commerce',
    mode: 'proposal',
    tools: ['search_entries', 'read_entry', 'add_sale', 'add_debtor'],
    route: routeFor('sales'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'procurement',
    mode: 'proposal',
    tools: ['search_parties', 'read_party_statement', 'add_bill', 'add_supplier', 'create_supplier_payment'],
    route: routeFor('payments'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'customers',
    mode: 'proposal',
    tools: ['search_parties', 'read_party_statement', 'add_debtor', 'add_debtor_payment'],
    route: routeFor('customers'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'inventory',
    mode: 'proposal',
    tools: ['read_inventory', 'record_inventory'],
    route: routeFor('inventory'),
    tests: [...READ_TESTS, ...PROPOSAL_TESTS],
  },
  {
    feature: 'live_product_stock',
    mode: 'guided-screen',
    tools: ['read_inventory'],
    route: routeFor('products'),
    reason: 'Live stock adjustments post movements through the perpetual-inventory service, which this stage did not wire to a proposal.',
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
  {
    feature: 'marketplace',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('marketplace'),
    reason: 'Marketplace orders, returns, fees and settlements stay on their reconciled batch-review screen.',
    tests: [...PROPOSAL_TESTS],
  },
  {
    feature: 'shipping_returns',
    mode: 'guided-screen',
    tools: ['search_entries'],
    route: routeFor('deliveryNotes'),
    reason: 'Delivery notes and returns have no proposal descriptor yet; the screen carries the item-level review this needs.',
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
  {
    feature: 'projects',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('projects'),
    reason: 'Projects combine budgets, time and cost records and remain on the project review screen.',
    tests: [...PROPOSAL_TESTS],
  },
  {
    feature: 'creator_revenue',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('projects'),
    reason: 'Creator contracts and payouts retain their dedicated contract and settlement review workflow.',
    tests: [...PROPOSAL_TESTS],
  },
  {
    feature: 'manufacturing',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('manufacturing'),
    reason: 'Bills of materials and production orders require line-level stock review on the manufacturing screen.',
    tests: [...PROPOSAL_TESTS],
  },
  {
    feature: 'trade_landed_cost',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('trade'),
    reason: 'Shipment costs and foreign-exchange remeasurement remain in the trade reconciliation workflow.',
    tests: [...PROPOSAL_TESTS],
  },
  {
    feature: 'cogs_margin',
    mode: 'read',
    tools: ['read_profit_and_loss', 'read_inventory'],
    route: routeFor('monthly'),
    tests: [...READ_TESTS],
  },
  {
    feature: 'growth_analytics',
    mode: 'guided-screen',
    tools: ['read_profit_and_loss'],
    route: routeFor('customReport'),
    reason: 'CAC, ROI, ROE and PEG need metric inputs the user supplies; the assistant must not infer them from the ledger.',
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
  {
    feature: 'reconciliation',
    mode: 'guided-screen',
    tools: ['read_cash_movements', 'search_entries'],
    route: routeFor('reconcile'),
    reason: 'Statement matching is a reviewed batch with balance and duplicate checks, not a sequence of single-record proposals.',
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
  {
    feature: 'cashbook',
    mode: 'read',
    tools: ['read_cash_movements'],
    route: routeFor('cashbook'),
    tests: [...READ_TESTS],
  },
  {
    feature: 'reporting',
    mode: 'read',
    tools: [
      'read_profit_and_loss', 'read_trial_balance', 'read_balance_sheet',
      'read_business_accounts', 'describe_capabilities',
    ],
    route: routeFor('monthly'),
    tests: [...READ_TESTS],
  },
  {
    feature: 'ai_assistant',
    mode: 'read',
    tools: ['describe_capabilities'],
    route: routeFor('ask'),
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
  {
    feature: 'voice_assistant',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('voice'),
    reason: 'Gemma audio transcription is wired but stays unavailable until Android compilation and the phone capability gate pass.',
    tests: [...COVERAGE_TESTS],
  },
  {
    feature: 'payroll',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('payroll'),
    reason: 'Payroll holds personal data and has no read tool; a pay run must be previewed on its own screen, not proposed from chat.',
    tests: [...COVERAGE_TESTS],
  },
  {
    feature: 'fixed_assets',
    mode: 'guided-screen',
    tools: [],
    route: routeFor('fixedAssets'),
    reason: 'Depreciation schedules post over multiple periods; the asset register screen carries that review.',
    tests: [...COVERAGE_TESTS],
  },
  {
    feature: 'multi_location',
    mode: 'guided-screen',
    tools: ['read_cash_movements', 'read_inventory'],
    route: routeFor('locations'),
    reason: 'POS settlement and stock transfers change two locations at once and need their own variance preview.',
    tests: [...READ_TESTS, ...COVERAGE_TESTS],
  },
];

/**
 * Things the agent is never given, whatever a document or a user asks.
 *
 * These are not "unimplemented". They are refused: an assistant that can reset
 * a book, read out a sync credential or change who has access is a different
 * and much worse product.
 */
export const BLOCKED_OPERATIONS: readonly { operation: string; reason: string; route: string }[] = [
  { operation: 'reset_book', reason: 'Book reset destroys accounting history and is owner-only.', route: routeFor('advancedSettings') },
  { operation: 'delete_book', reason: 'Book deletion is irreversible and owner-only.', route: routeFor('advancedSettings') },
  { operation: 'read_credentials', reason: 'Sync tokens and keys are never exposed to a model or a prompt.', route: routeFor('syncSettings') },
  { operation: 'change_membership', reason: 'Changing who can access a book is a security decision, not an assistant action.', route: routeFor('syncSettings') },
  { operation: 'export_backup', reason: 'Backup export moves the whole book off the device and needs explicit user action.', route: routeFor('backupRecovery') },
  { operation: 'change_settings', reason: 'A generic settings write would let a scanned document reconfigure the app.', route: routeFor('modules') },
];

export class CoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageError';
  }
}

export type CoverageEnvironment = {
  /** Tool names the composition root actually built. */
  knownTools: readonly string[];
  /** Routes that exist in this branch. */
  knownRoutes: readonly string[];
  /** Test files that exist in this branch. */
  knownTests: readonly string[];
};

/**
 * Checks the register against reality.
 *
 * Beyond the shape rules, this insists every named tool was really built, every
 * route really exists in this branch, and every cited test file is really
 * present. A row citing a tool nobody wrote is exactly the false claim the
 * register is supposed to prevent.
 */
export function assertCoverage(
  enabled: readonly CapabilityKey[],
  rows: readonly CoverageRow[] = GEMMA_COVERAGE,
  environment?: CoverageEnvironment,
): void {
  const proposalNames = new Set(PROPOSAL_SPECS.map((spec) => spec.name));
  for (const feature of enabled) {
    const matches = rows.filter((row) => row.feature === feature);
    if (matches.length !== 1) throw new CoverageError(`Missing/duplicate coverage: ${feature}`);
    const row = matches[0];

    if (!row.tests.length) throw new CoverageError(`Untested coverage: ${feature}`);
    if ((row.mode === 'read' || row.mode === 'proposal') && !row.tools.length) {
      throw new CoverageError(`No tools: ${feature}`);
    }
    if (row.mode === 'guided-screen' && !row.route) throw new CoverageError(`No route: ${feature}`);
    if (row.mode === 'guided-screen' && !row.reason) throw new CoverageError(`No reason: ${feature}`);
    if (row.mode === 'blocked' && !row.reason) throw new CoverageError(`No reason: ${feature}`);
    if (row.mode === 'proposal') {
      for (const tool of row.tools) {
        if (proposalNames.has(tool as typeof PROPOSAL_SPECS[number]['name']) && !LIVE_GEMMA_PROPOSALS.has(tool)) {
          throw new CoverageError(`Proposal is not live: ${feature} -> ${tool}`);
        }
      }
    }

    if (!environment) continue;

    for (const tool of row.tools) {
      if (!environment.knownTools.includes(tool)) {
        throw new CoverageError(`Coverage names a tool that was never built: ${feature} -> ${tool}`);
      }
    }
    if (row.route && !environment.knownRoutes.includes(row.route)) {
      throw new CoverageError(`Coverage names a route that does not exist: ${feature} -> ${row.route}`);
    }
    for (const test of row.tests) {
      if (!environment.knownTests.includes(test)) {
        throw new CoverageError(`Coverage cites a test that does not exist: ${feature} -> ${test}`);
      }
    }
  }
}

/** Every capability this build knows about, for a completeness check. */
export function allCapabilityKeys(): CapabilityKey[] {
  return CAPABILITIES.map((definition) => definition.key);
}

/** A short, honest summary for `describe_capabilities`. */
export function coverageSummary(
  enabled: readonly CapabilityKey[],
  rows: readonly CoverageRow[] = GEMMA_COVERAGE,
): { feature: string; mode: CoverageMode; route?: string }[] {
  return enabled.flatMap((feature) => {
    const row = rows.find((entry) => entry.feature === feature);
    if (!row) return [];
    return [{ feature: row.feature, mode: row.mode, ...(row.route ? { route: row.route } : {}) }];
  });
}
