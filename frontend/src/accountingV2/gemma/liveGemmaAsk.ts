import { activeSqlRunner } from '../../db/backend';
import { CAPABILITIES } from '../../utils/capabilities';
import { installedGemmaRuntime } from '../../utils/gemmaNative';
import { createAgent, type AgentResult, type Scope, type Tool } from './agentCore';
import { createAccountingReportPorts } from './accountingReportPorts';
import { createProposalPorts, createReadPorts, toScope, type BranchDeps } from './branchPorts';
import { readToolRegistry } from './coreReadTools';
import { createLiveReportGuard, liveBookContext } from './liveBookContext';
import { createLiveDataPorts } from './liveDataPorts';
import { proposalToolRegistry } from './proposalTools';
import { gemmaProposalNames, LIVE_GEMMA_PROPOSALS, operationEnabled } from './liveProposalPolicy';
import { captureAssistantScope } from './liveProposalController';
import { sameScope } from './agentCore';

export type GemmaReadFamily = 'reports' | 'cash' | 'parties' | 'entries' | 'invoices' | 'inventory' | 'business-accounts' | 'capabilities';

export function chooseGemmaReadFamily(question: string): GemmaReadFamily {
  const q = question.toLowerCase();
  if (/\b(stock|inventory|product|quantity|valuation)\b/.test(q)) return 'inventory';
  if (/\b(invoice|receipt|outstanding|overdue)\b/.test(q)) return 'invoices';
  if (/\b(customer|supplier|party|parties|owe|owes|owed|receivable|payable)\b/.test(q)) return 'parties';
  if (/\b(cash|bank|money in|money out|cashbook)\b/.test(q)) return 'cash';
  if (/\b(entry|entries|transaction|journal|daybook|reference)\b/.test(q)) return 'entries';
  if (/\b(capital|drawing|partner|member|business account)\b/.test(q)) return 'business-accounts';
  if (/\b(profit|loss|balance sheet|trial balance|revenue|expense|report|sales total|cogs)\b/.test(q)) return 'reports';
  return 'capabilities';
}

const FAMILY_TOOLS: Readonly<Record<GemmaReadFamily, readonly string[]>> = {
  reports: ['read_profit_and_loss', 'read_trial_balance', 'read_balance_sheet', 'describe_capabilities'],
  cash: ['read_cash_movements', 'search_entries', 'describe_capabilities'],
  parties: ['search_parties', 'read_party_statement', 'read_unpaid_invoices', 'describe_capabilities'],
  entries: ['search_entries', 'read_entry', 'search_parties', 'describe_capabilities'],
  invoices: ['search_parties', 'read_unpaid_invoices', 'read_entry', 'describe_capabilities'],
  inventory: ['read_inventory', 'read_profit_and_loss', 'describe_capabilities'],
  'business-accounts': ['read_business_accounts', 'describe_capabilities'],
  capabilities: ['describe_capabilities'],
};

function commissionPort(db: NonNullable<ReturnType<typeof activeSqlRunner>>, scope: Scope) {
  return async (from: string, to: string, locations: string[] | 'all') => {
    const ids = locations === 'all' ? [] : locations;
    const where = ids.length ? ` AND l.location_id IN (${ids.map(() => '?').join(',')})` : '';
    const row = await db.first<{ amount: number }>(
      `SELECT COALESCE(SUM(l.debit-l.credit),0) amount FROM v2_journal_lines l
       JOIN v2_journal_entries j ON j.id=l.journal_id AND j.book_id=l.book_id
       JOIN v2_accounts a ON a.id=l.account_id AND a.book_id=l.book_id
       WHERE l.book_id=? AND j.date>=? AND j.date<=? AND a.code='6100'${where}`,
      [scope.bookId, from, to, ...ids],
    );
    return Number(row?.amount || 0);
  };
}

async function liveReadComposition(): Promise<{ currentScope(): Promise<Scope>; tools: Tool[]; proposals: Tool[] }> {
  const db = activeSqlRunner();
  if (!db) throw new Error('SQLITE_NOT_READY');
  const context = await liveBookContext();
  const scope = toScope(context);
  const guard = createLiveReportGuard(liveBookContext);
  const reports = createAccountingReportPorts(db, guard, scope);
  const data = createLiveDataPorts(db, guard, scope);
  const deps: BranchDeps = {
    context: liveBookContext,
    ...reports,
    ...data,
    commission: commissionPort(db, scope),
    featureDescriptions: async (features) => CAPABILITIES
      .filter((item) => features.includes(item.key))
      .map(({ key, label, description }) => ({ key, label, description })),
    canReadEntity: async (_entity, current) => current.enabledFeatures.includes('core_ledger'),
    canPropose: async (operation, current) => LIVE_GEMMA_PROPOSALS.has(operation)
      && current.actorId === 'local-owner' && operationEnabled(operation, current.enabledFeatures),
    resolveParty: async (name, role, current) => {
      const rows = await db.all<{ id: string; name: string; roles: string }>(
        'SELECT id,name,roles FROM v2_parties WHERE book_id=? AND archived=0 AND lower(trim(name))=lower(trim(?))',
        [current.bookId, name],
      );
      const matches = rows.filter((row) => {
        try { return (JSON.parse(row.roles) as unknown[]).includes(role); } catch { return false; }
      });
      return Promise.all(matches.map(async (row) => {
        const revision = await db.first<{ revision: number }>(
          'SELECT MAX(revision) revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?',
          [current.bookId, row.id],
        );
        return { id: row.id, name: row.name, role, revision: String(Number(revision?.revision || 0)) };
      }));
    },
    resolveRecord: async (kind, id, current) => {
      if (kind !== 'invoice') return null;
      const row = await db.first<{ id: string; reference: string | null }>(
        "SELECT id,reference FROM v2_sources WHERE id=? AND book_id=? AND type='invoice'",
        [id, current.bookId],
      );
      if (!row) return null;
      const revision = await db.first<{ revision: number }>(
        'SELECT MAX(revision) revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_id=?',
        [current.bookId, row.id],
      );
      return { id: row.id, label: row.reference || row.id, revision: String(Number(revision?.revision || 0)) };
    },
    computeAmounts: async (operation, normalized) => {
      if (operation === 'add_sale' && normalized.paymentType === 'credit') throw new Error('GUIDED_SCREEN_ONLY_CREDIT_SALE');
      if (operation === 'create_invoice' && Number(normalized.taxRate || 0) !== 0) throw new Error('GUIDED_SCREEN_ONLY_TAXED_INVOICE');
      const totals: Record<string, number> = {};
      if (typeof normalized.amount === 'number') totals.amount = normalized.amount;
      return totals;
    },
  };
  return {
    currentScope: async () => toScope(await deps.context()),
    tools: readToolRegistry(createReadPorts(deps)),
    proposals: proposalToolRegistry(createProposalPorts(deps)).filter((tool) => LIVE_GEMMA_PROPOSALS.has(tool.name)),
  };
}

export type LiveGemmaAskDeps = {
  captureScope?: typeof captureAssistantScope;
  runtime: typeof installedGemmaRuntime;
  composition: typeof liveReadComposition;
  run: typeof createAgent;
};

const productionDeps: LiveGemmaAskDeps = { runtime: installedGemmaRuntime, composition: liveReadComposition, run: createAgent };

/** Runs Gemma with live, typed, scoped readers and no whole-book snapshot. */
export async function askWithLiveGemma(question: string, allowProposals = false, deps: LiveGemmaAskDeps = productionDeps): Promise<AgentResult | null> {
  const originScope = Object.freeze({ ...await (deps.captureScope ?? captureAssistantScope)() });
  const runtime = await deps.runtime();
  if (!sameScope(originScope, await (deps.captureScope ?? captureAssistantScope)())) {
    return { kind: 'stopped', code: 'STALE_SCOPE' };
  }
  if (!runtime) return null;
  const composition = await deps.composition();
  const allowed = new Set<string>(FAMILY_TOOLS[chooseGemmaReadFamily(question)]);
  const tools = composition.tools.filter((tool) => allowed.has(tool.name));
  if (allowProposals) {
    const proposalNames = new Set(gemmaProposalNames(question));
    tools.push(...composition.proposals.filter((tool) => proposalNames.has(tool.name)).slice(0, Math.max(0, 8 - tools.length)));
  }
  return deps.run(runtime.engine).run({
    requestId: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    modelId: runtime.modelId,
    question,
    glossary: 'Sales are income; bills and supplier payments are purchases/payables; Business Accounts are member capital and drawings. Use reconciled reports; purchases are not automatically COGS.',
    tools,
    currentScope: async () => {
      const scope = await composition.currentScope();
      if (!sameScope(originScope, scope)) throw new Error('STALE_SCOPE');
      return scope;
    },
    canPropose: allowProposals,
  });
}
