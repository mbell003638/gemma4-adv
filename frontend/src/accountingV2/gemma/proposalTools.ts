/**
 * The write proposals Gemma may draft.
 *
 * `prepare()` resolves references and computes totals. It does not post, create
 * a party, or enqueue sync -- the ports it is given have no method that can.
 * The draft it returns still has to pass the branch's own
 * `validateAssistantProposal` and then an explicit user confirmation, so this
 * layer is a stricter gate in front of the existing one, never a replacement.
 *
 * Schemas here are deliberately harsher than the validator behind them. The
 * validator coerces `"1,250"` into a number because a human typing into a form
 * is allowed to be loose; a model emitting a malformed amount is a signal to
 * stop, not something to clean up silently.
 */

import { MAX_AI_AMOUNT, type AssistantProposalType } from '../aiActions';
import type { Draft, Obj, ProposalTool, Schema, Scope } from './agentCore';
import { validate } from './agentCore';

/** Mirrors the branch's METHODS list in aiActions.ts. */
export const PAYMENT_METHODS = ['cash', 'bank', 'card', 'mobile', 'other'] as const;
export const PAYMENT_TYPES = ['cash', 'credit'] as const;
export const RECEIPT_MODES = ['cash_sale', 'against_invoice', 'advance'] as const;

/** Entities `update_entry` / `delete_entry` may name, from ASSISTANT_ENTRY_ENTITIES. */
export const ENTRY_ENTITIES = [
  'expense', 'sale', 'bill', 'supplier_payment', 'receipt', 'invoice', 'quote',
  'customer', 'supplier', 'delivery_note', 'note', 'inventory_count', 'capital',
  'drawing', 'cash_entry',
] as const;

export type EntryEntity = (typeof ENTRY_ENTITIES)[number];

/**
 * Fields each entity accepts on an update, from ASSISTANT_UPDATE_FIELDS.
 * Kept in step with that map; a field missing there will be refused downstream
 * anyway, but refusing it here keeps the model's schema honest.
 */
export const UPDATE_FIELDS: Record<EntryEntity, readonly string[]> = {
  expense: ['amount', 'date', 'category', 'method', 'notes'],
  sale: ['amount', 'date', 'paymentType', 'method', 'notes'],
  bill: ['amount', 'date', 'paymentType', 'method', 'notes', 'invoiceNo'],
  supplier_payment: ['amount', 'date', 'method', 'notes'],
  receipt: ['amount', 'date', 'method', 'notes'],
  invoice: ['amount', 'date', 'dueDate', 'notes', 'clientName', 'clientPhone', 'taxRate', 'taxLabel'],
  quote: ['amount', 'date', 'validUntil', 'notes', 'clientName', 'clientPhone', 'taxRate', 'taxLabel', 'status'],
  customer: ['name', 'phone', 'email', 'address', 'notes'],
  supplier: ['name', 'phone', 'email', 'address', 'notes'],
  delivery_note: ['date', 'clientName', 'clientPhone', 'invoiceId', 'vehicleNo', 'status', 'notes'],
  note: ['amount', 'date', 'reference', 'reason', 'notes'],
  inventory_count: [],
  capital: ['amount', 'date', 'notes'],
  drawing: ['amount', 'date', 'notes'],
  cash_entry: ['amount', 'date', 'type', 'category', 'notes'],
};

/**
 * Entities a delete may never name.
 *
 * Customer and supplier deletion belongs to its dedicated screen, and an
 * inventory count is reversed and re-recorded rather than removed -- deleting
 * one would silently rewrite a period's cost of goods sold.
 */
export const UNDELETABLE_ENTITIES: readonly EntryEntity[] = ['customer', 'supplier', 'inventory_count'];

export class ProposalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProposalError';
  }
}

function fail(code: string): never {
  throw new ProposalError(code);
}

// --- Schema helpers ------------------------------------------------------

const isoDate: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 };
const recordId: Schema = { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,64}$', maxLength: 64 };
const label: Schema = { type: 'string', maxLength: 120 };
const notes: Schema = { type: 'string', maxLength: 500 };

/** A finite number in the app's accepted range. Never a coercible string. */
const money: Schema = { type: 'number', minimum: 0.01, maximum: MAX_AI_AMOUNT };
const moneyOrZero: Schema = { type: 'number', minimum: 0, maximum: MAX_AI_AMOUNT };
const quantity: Schema = { type: 'number', minimum: 0.0001, maximum: 1_000_000 };
const rate: Schema = { type: 'number', minimum: 0, maximum: 100 };

const method: Schema = { type: 'string', enum: PAYMENT_METHODS, maxLength: 10 };
const paymentType: Schema = { type: 'string', enum: PAYMENT_TYPES, maxLength: 10 };

function object(
  properties: Record<string, Schema>,
  required: readonly string[],
): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

// --- Ports ---------------------------------------------------------------

export type ResolvedParty = { id: string; name: string; role: 'customer' | 'supplier'; revision: string };
export type ResolvedRecord = { id: string; revision: string; label: string };

/**
 * Read-only resolution.
 *
 * There is intentionally no port here that writes. `prepare()` can therefore
 * not post a record even by mistake: the capability is absent from its
 * vocabulary rather than merely unused.
 */
export type ProposalPorts = {
  canPropose(scope: Scope, operation: string): Promise<boolean>;
  /** Every match, so an ambiguous name stays ambiguous. */
  resolveParty(scope: Scope, name: string, role: 'customer' | 'supplier'): Promise<ResolvedParty[]>;
  resolveRecord(scope: Scope, kind: string, id: string): Promise<ResolvedRecord | null>;
  /**
   * Host-computed figures. The draft shows these, never the model's arithmetic.
   */
  computeAmounts(scope: Scope, operation: string, normalized: Obj): Promise<Record<string, number>>;
  /** The book's local today, for a proposal that omitted a date. */
  today(scope: Scope): Promise<string>;
};

// --- The factory ---------------------------------------------------------

type Resolution = {
  /** Party fields to resolve: argument key -> role. */
  parties?: Record<string, 'customer' | 'supplier'>;
  /** Record fields to resolve: argument key -> record kind. */
  records?: Record<string, string>;
};

type Spec = {
  name: AssistantProposalType;
  feature: string;
  description: string;
  schema: Schema;
  destructive?: boolean;
  resolve?: Resolution;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value
    && value >= '2000-01-01' && value <= '2099-12-31';
}

/**
 * Builds one proposal tool from a spec.
 *
 * `prepare` normalises, resolves, and asks the host for the money. It ends by
 * checking the draft still claims the operation this tool advertises, so a
 * misbehaving adapter cannot smuggle a different action into the review sheet.
 */
export function proposalTool(spec: Spec, ports: ProposalPorts): ProposalTool {
  return {
    name: spec.name,
    feature: spec.feature,
    access: 'proposal',
    description: spec.description,
    parameters: spec.schema,
    authorize: (context) => ports.canPropose(context.scope, spec.name),
    prepare: async (args, context) => {
      await context.assertCurrent();
      if (!await ports.canPropose(context.scope, spec.name)) fail('FORBIDDEN');
      if (validate(spec.schema, args).length) fail('INVALID_ARGUMENTS');
      await context.assertCurrent();

      const normalized: Obj = { ...args };
      const date = typeof args.date === 'string' && args.date ? args.date : await ports.today(context.scope);
      if (!validDate(date)) fail('INVALID_DATE');
      normalized.date = date;

      const entityVersions: Record<string, string> = {};

      if (spec.name === 'add_debtor' || spec.name === 'add_supplier') {
        const role = spec.name === 'add_debtor' ? 'customer' : 'supplier';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const matches = await ports.resolveParty(context.scope, name, role);
        if (matches.length) fail('PARTY_ALREADY_EXISTS:name');
      }

      for (const [key, role] of Object.entries(spec.resolve?.parties ?? {})) {
        const raw = args[key];
        if (typeof raw !== 'string' || !raw.trim()) fail(`MISSING_PARTY:${key}`);
        const matches = await ports.resolveParty(context.scope, raw.trim(), role);
        // One name, several real parties: the user picks. Choosing the nearest
        // is how a payment lands on the wrong ledger.
        if (matches.length > 1) fail(`AMBIGUOUS_PARTY:${key}`);
        if (matches.length === 1) {
          normalized[`${key}Id`] = matches[0].id;
          normalized[key] = matches[0].name;
          entityVersions[matches[0].id] = matches[0].revision;
        }
        // Zero matches is a new party, which the confirmation sheet must show
        // as a creation. It is not resolved here and not created here.
      }

      for (const [key, kind] of Object.entries(spec.resolve?.records ?? {})) {
        const raw = args[key];
        if (raw === undefined) continue;
        if (typeof raw !== 'string' || !raw.trim()) fail(`MISSING_RECORD:${key}`);
        const found = await ports.resolveRecord(context.scope, kind, raw.trim());
        // A record id the model invented, or one from another book, stops here.
        if (!found) fail(`UNKNOWN_RECORD:${key}`);
        entityVersions[found.id] = found.revision;
      }

      const totals = await ports.computeAmounts(context.scope, spec.name, normalized);
      for (const [key, value] of Object.entries(totals)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(`INVALID_TOTAL:${key}`);
        normalized[key] = value;
      }

      await context.assertCurrent();

      const draft: Draft = {
        operation: spec.name,
        normalized,
        preview: buildPreview(spec, normalized, context.scope, totals),
        destructive: spec.destructive === true,
        entityVersions,
      };
      if (draft.operation !== spec.name) fail('OPERATION_MISMATCH');
      return draft;
    },
  };
}

/**
 * The line the user actually reads before confirming.
 *
 * Built from host-computed totals and the trusted scope's currency, so the
 * sheet cannot show a figure the model made up.
 */
function buildPreview(spec: Spec, normalized: Obj, scope: Scope, totals: Record<string, number>): string {
  const headline = Object.entries(totals)[0];
  const amount = headline ? `${scope.currency} ${headline[1].toFixed(2)}` : '';
  const who = ['supplierName', 'clientName', 'partnerName', 'name', 'customerName']
    .map((key) => normalized[key])
    .find((value) => typeof value === 'string' && value) as string | undefined;
  const parts = [
    spec.name.replace(/_/g, ' '),
    amount,
    who ? `for ${who}` : '',
    `on ${String(normalized.date)}`,
  ];
  return parts.filter(Boolean).join(' ');
}

// --- Specifications ------------------------------------------------------

const dated = (extra: Record<string, Schema>, required: readonly string[]) =>
  object({ date: isoDate, notes, ...extra }, required);

/**
 * The core sixteen. Wording follows the app's own screens -- supplier payment,
 * receipt, Business Accounts, reversal -- so a preview reads like the product
 * rather than like a schema.
 */
const CORE_SPECS: Spec[] = [
  {
    name: 'add_expense', feature: 'expenses',
    description: 'Record a business expense for review.',
    schema: dated({ amount: money, category: label, method }, ['amount']),
  },
  {
    name: 'log_personal_expense', feature: 'expenses',
    description: 'Record a personal expense, kept out of business profit, for review.',
    schema: dated({ amount: money, category: label, method }, ['amount']),
  },
  {
    name: 'add_sale', feature: 'sales',
    description: 'Record a sale for review, cash or credit.',
    schema: dated({ amount: money, paymentType, method, customerName: label }, ['amount']),
    resolve: { parties: {} },
  },
  {
    name: 'add_bill', feature: 'purchases',
    description: 'Record a supplier bill for review.',
    schema: dated({ amount: money, supplierName: label, paymentType, method, invoiceNo: label }, ['amount', 'supplierName']),
    resolve: { parties: { supplierName: 'supplier' } },
  },
  {
    name: 'create_supplier_payment', feature: 'purchases',
    description: 'Record a payment to a supplier for review, settling bills or as an advance.',
    schema: dated({ amount: money, supplierName: label, method }, ['amount', 'supplierName', 'method']),
    resolve: { parties: { supplierName: 'supplier' } },
  },
  {
    name: 'add_debtor', feature: 'parties',
    description: 'Add a customer for review.',
    schema: dated({ name: label, phone: label, amount: moneyOrZero }, ['name']),
  },
  {
    name: 'add_supplier', feature: 'parties',
    description: 'Add a supplier for review.',
    schema: dated({ name: label, phone: label, amount: moneyOrZero }, ['name']),
  },
  {
    name: 'add_debtor_payment', feature: 'receipts',
    description: 'Record money received from a customer for review.',
    schema: dated({ amount: money, name: label, method }, ['amount', 'name']),
    resolve: { parties: { name: 'customer' } },
  },
  {
    name: 'create_invoice', feature: 'invoices',
    description: 'Draft an invoice for review. Totals are calculated by the app.',
    schema: dated({
      amount: money, clientName: label, clientPhone: label,
      dueDate: isoDate, taxRate: rate, taxLabel: label,
    }, ['amount', 'clientName']),
    resolve: { parties: { clientName: 'customer' } },
  },
  {
    name: 'create_quote', feature: 'quotes',
    description: 'Draft a quote for review. Totals are calculated by the app.',
    schema: dated({
      amount: money, clientName: label, clientPhone: label,
      validUntil: isoDate, taxRate: rate, taxLabel: label,
    }, ['amount', 'clientName']),
    resolve: { parties: { clientName: 'customer' } },
  },
  {
    name: 'create_receipt', feature: 'receipts',
    description: 'Record a receipt for review: a cash sale, a payment against an invoice, or an advance.',
    schema: dated({
      amount: money, mode: { type: 'string', enum: RECEIPT_MODES, maxLength: 20 },
      customerName: label, invoiceId: recordId, method,
    }, ['amount', 'mode']),
    resolve: { parties: { }, records: { invoiceId: 'invoice' } },
  },
  {
    name: 'create_drawing', feature: 'business-accounts',
    description: 'Record a drawing from Business Accounts for review.',
    schema: dated({ amount: money, partnerName: label }, ['amount', 'partnerName']),
  },
  {
    name: 'add_capital', feature: 'business-accounts',
    description: 'Record capital contributed to Business Accounts for review.',
    schema: dated({ amount: money, partnerName: label }, ['amount', 'partnerName']),
  },
  {
    name: 'record_inventory', feature: 'inventory',
    description: 'Record a closing stock count for review. Zero is allowed.',
    schema: dated({ amount: moneyOrZero }, ['amount']),
  },
  {
    name: 'update_entry', feature: 'entries',
    description: 'Change specific fields on one existing record, for review.',
    schema: object({
      entity: { type: 'string', enum: ENTRY_ENTITIES, maxLength: 24 },
      id: recordId,
      memberId: recordId,
      changes: object({
        amount: money, date: isoDate, dueDate: isoDate, validUntil: isoDate,
        category: label, method, paymentType, notes, invoiceNo: label,
        clientName: label, clientPhone: label, taxRate: rate, taxLabel: label,
        name: label, phone: label, email: label, address: label,
        reference: label, reason: label, vehicleNo: label, invoiceId: recordId,
        status: label, type: label,
      }, []),
    }, ['entity', 'id', 'changes']),
    resolve: { records: { } },
  },
  {
    name: 'delete_entry', feature: 'entries',
    description: 'Reverse or delete one existing record, for review. Customers, suppliers and stock counts cannot be deleted this way.',
    schema: object({
      entity: { type: 'string', enum: ENTRY_ENTITIES, maxLength: 24 },
      id: recordId,
      memberId: recordId,
    }, ['entity', 'id']),
    destructive: true,
  },
];

/** The fifteen domain operations this branch adds beyond the core set. */
const DOMAIN_SPECS: Spec[] = [
  {
    name: 'create_marketplace_order', feature: 'marketplace',
    description: 'Record a marketplace order for review.',
    schema: dated({
      platform: label, externalOrderId: label, gross: money, tax: moneyOrZero,
      marketplaceFee: moneyOrZero, shippingFee: moneyOrZero, refund: moneyOrZero, rtoFee: moneyOrZero,
      status: { type: 'string', enum: ['paid', 'shipped', 'delivered', 'refunded', 'rto'], maxLength: 12 },
    }, ['platform', 'externalOrderId', 'gross']),
  },
  {
    name: 'record_marketplace_refund', feature: 'marketplace',
    description: 'Record a marketplace refund against a known order, for review.',
    schema: dated({ orderId: recordId, amount: money }, ['orderId', 'amount']),
    resolve: { records: { orderId: 'marketplace_order' } },
  },
  {
    name: 'record_marketplace_rto', feature: 'marketplace',
    description: 'Record a marketplace return to origin against a known order, for review.',
    schema: dated({ orderId: recordId, fee: money }, ['orderId', 'fee']),
    resolve: { records: { orderId: 'marketplace_order' } },
  },
  {
    name: 'create_marketplace_settlement', feature: 'marketplace',
    description: 'Record a marketplace settlement payout for review.',
    schema: dated({ platform: label, settlementId: label, payout: money }, ['platform', 'settlementId', 'payout']),
  },
  {
    name: 'create_project', feature: 'projects',
    description: 'Create a project for review.',
    schema: dated({ name: label, budget: moneyOrZero }, ['name']),
  },
  {
    name: 'add_project_time', feature: 'projects',
    description: 'Record hours worked on a known project, for review.',
    schema: dated({ projectId: recordId, hours: quantity, rate: moneyOrZero }, ['projectId', 'hours']),
    resolve: { records: { projectId: 'project' } },
  },
  {
    name: 'record_project_cost', feature: 'projects',
    description: 'Record a cost against a known project, for review.',
    schema: dated({ projectId: recordId, amount: money }, ['projectId', 'amount']),
    resolve: { records: { projectId: 'project' } },
  },
  {
    name: 'create_creator_contract', feature: 'creators',
    description: 'Record a creator contract for review.',
    schema: dated({ brand: label, campaign: label, agreedAmount: money }, ['brand', 'campaign', 'agreedAmount']),
  },
  {
    name: 'record_creator_payout', feature: 'creators',
    description: 'Record a payout against a known creator contract, for review.',
    schema: dated({ contractId: recordId, amount: money }, ['contractId', 'amount']),
    resolve: { records: { contractId: 'creator_contract' } },
  },
  {
    name: 'create_bom', feature: 'manufacturing',
    description: 'Create a bill of materials for review.',
    schema: dated({ productId: recordId, name: label }, ['productId', 'name']),
    resolve: { records: { productId: 'product' } },
  },
  {
    name: 'add_bom_line', feature: 'manufacturing',
    description: 'Add a component line to a known bill of materials, for review.',
    schema: dated({
      bomId: recordId, componentProductId: recordId, quantity, unitCost: moneyOrZero,
    }, ['bomId', 'componentProductId', 'quantity']),
    resolve: { records: { bomId: 'bom', componentProductId: 'product' } },
  },
  {
    name: 'create_production_order', feature: 'manufacturing',
    description: 'Create a production order against a known bill of materials, for review.',
    schema: dated({ bomId: recordId, quantity }, ['bomId', 'quantity']),
    resolve: { records: { bomId: 'bom' } },
  },
  {
    name: 'create_trade_shipment', feature: 'trade',
    description: 'Record an import or export shipment for review.',
    schema: dated({
      reference: label, goodsValue: moneyOrZero,
      direction: { type: 'string', enum: ['import', 'export'], maxLength: 8 },
      exchangeRate: money,
    }, ['reference']),
  },
  {
    name: 'add_trade_landed_cost', feature: 'trade',
    description: 'Add a landed cost to a known shipment, for review.',
    schema: dated({
      shipmentId: recordId, kind: label, amount: money,
      method: { type: 'string', enum: ['cash', 'bank', 'ap'], maxLength: 6 },
    }, ['shipmentId', 'kind', 'amount']),
    resolve: { records: { shipmentId: 'trade_shipment' } },
  },
  {
    name: 'record_fx_remeasurement', feature: 'trade',
    description: 'Record a foreign-exchange gain or loss for review.',
    schema: dated({
      amount: money,
      gainLoss: { type: 'string', enum: ['gain', 'loss'], maxLength: 4 },
      exchangeRate: money,
    }, ['amount', 'gainLoss']),
  },
];

export const PROPOSAL_SPECS: readonly Spec[] = [...CORE_SPECS, ...DOMAIN_SPECS];

/**
 * Operations deliberately not advertised to the model.
 *
 * Empty today: every `AssistantProposalType` has a descriptor. Anything added
 * here needs a reason, because an unlisted operation silently disappears from
 * the coverage register.
 */
export const INTENTIONALLY_UNADVERTISED: Readonly<Record<string, string>> = {};

export function proposalToolRegistry(ports: ProposalPorts): ProposalTool[] {
  return PROPOSAL_SPECS.map((spec) => proposalTool(spec, ports));
}

// --- Bundles -------------------------------------------------------------

/** At most eight tools reach the model in one turn. */
export const MAX_BUNDLE_TOOLS = 8;

export const BUNDLES: Readonly<Record<string, readonly AssistantProposalType[]>> = {
  expenses: ['add_expense', 'log_personal_expense', 'update_entry', 'delete_entry'],
  sales: ['add_sale', 'add_debtor', 'add_debtor_payment', 'update_entry', 'delete_entry'],
  purchases: ['add_bill', 'add_supplier', 'create_supplier_payment', 'update_entry', 'delete_entry'],
  invoices: ['create_invoice', 'create_receipt', 'create_quote', 'update_entry', 'delete_entry'],
  'business-accounts': ['add_capital', 'create_drawing', 'update_entry'],
  inventory: ['record_inventory'],
  marketplace: [
    'create_marketplace_order', 'record_marketplace_refund',
    'record_marketplace_rto', 'create_marketplace_settlement',
  ],
  projects: ['create_project', 'add_project_time', 'record_project_cost'],
  creators: ['create_creator_contract', 'record_creator_payout'],
  manufacturing: ['create_bom', 'add_bom_line', 'create_production_order'],
  trade: ['create_trade_shipment', 'add_trade_landed_cost', 'record_fx_remeasurement'],
};

/**
 * The proposal tools for one feature family.
 *
 * Bundles are per-family on purpose: handing E2B every operation at once both
 * overflows the context budget and invites it to pick a plausible-looking tool
 * from an unrelated part of the product.
 */
export function selectBundle(family: string, ports: ProposalPorts): ProposalTool[] {
  const names = BUNDLES[family];
  if (!names) fail('UNKNOWN_BUNDLE');
  if (names.length > MAX_BUNDLE_TOOLS) fail('BUNDLE_TOO_LARGE');
  const byName = new Map(PROPOSAL_SPECS.map((spec) => [spec.name, spec]));
  return names.map((name) => {
    const spec = byName.get(name);
    if (!spec) fail(`UNKNOWN_OPERATION:${name}`);
    return proposalTool(spec, ports);
  });
}

// --- Handover to the existing validator ----------------------------------

export type AssistantProposalShape = {
  type: AssistantProposalType;
  params: Record<string, unknown>;
};

/**
 * Shapes a draft for `validateAssistantProposal`.
 *
 * The existing validator stays the final authority. Where the two disagree the
 * stricter one wins, which is always this layer for amounts and unknown keys
 * and always the validator for domain rules it alone knows.
 */
export function toAssistantProposal(draft: Draft): AssistantProposalShape {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.normalized)) {
    // Host-resolved ids travel in entityVersions and the params the domain
    // expects; nothing else from the model's arguments is invented here.
    params[key] = value;
  }
  return { type: draft.operation as AssistantProposalType, params };
}
