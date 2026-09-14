import { ASSISTANT_PROPOSAL_TYPES, MAX_AI_AMOUNT, validateAssistantProposal } from '../src/accountingV2/aiActions';
import { validate, type Obj, type Scope, type ToolContext } from '../src/accountingV2/gemma/agentCore';
import {
  BUNDLES,
  INTENTIONALLY_UNADVERTISED,
  MAX_BUNDLE_TOOLS,
  PROPOSAL_SPECS,
  UNDELETABLE_ENTITIES,
  proposalToolRegistry,
  selectBundle,
  toAssistantProposal,
  type ProposalPorts,
} from '../src/accountingV2/gemma/proposalTools';

const scope: Scope = {
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
};

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    scope,
    signal: new AbortController().signal,
    assertCurrent: async () => undefined,
    ...overrides,
  };
}

/**
 * Ports where every method is a spy. Nothing here can write, which is the
 * point: `prepare` has no vocabulary for posting, so the test asserts on which
 * resolution calls happened rather than hoping a write did not.
 */
function spyPorts(overrides: Partial<ProposalPorts> = {}) {
  const ports = {
    canPropose: jest.fn(async () => true),
    resolveParty: jest.fn(async (_scope: Scope, name: string, role: 'customer' | 'supplier') => [
      { id: `party-${name.toLowerCase().replace(/\s+/g, '-')}`, name, role, revision: 'v1' },
    ]),
    resolveRecord: jest.fn(async (_scope: Scope, kind: string, id: string) => ({
      id, revision: 'v2', label: `${kind} ${id}`,
    })),
    computeAmounts: jest.fn(async (_scope: Scope, _operation: string, normalized: Obj) => (
      typeof normalized.amount === 'number' ? { amount: normalized.amount } : {}
    )),
    today: jest.fn(async () => '2026-09-08'),
    ...overrides,
  };
  return ports as unknown as ProposalPorts & Record<string, jest.Mock>;
}

const byName = (ports: ProposalPorts) => new Map(proposalToolRegistry(ports).map((tool) => [tool.name, tool]));

test('direct preparation cannot bypass permission or its schema', async () => {
  const denied = spyPorts({ canPropose: async () => false });
  await expect(byName(denied).get('add_expense')!.prepare({ amount: 10 }, context()))
    .rejects.toThrow('FORBIDDEN');
  expect(denied.computeAmounts).not.toHaveBeenCalled();
  const allowed = spyPorts();
  await expect(byName(allowed).get('add_expense')!.prepare({ amount: '10' }, context()))
    .rejects.toThrow('INVALID_ARGUMENTS');
  expect(allowed.computeAmounts).not.toHaveBeenCalled();
});

describe('registry completeness', () => {
  it('covers every AssistantProposalType this branch defines', () => {
    // The plan's table lists sixteen; this branch has thirty-one, the extra
    // fifteen being the marketplace/projects/manufacturing/trade operations.
    expect(ASSISTANT_PROPOSAL_TYPES).toHaveLength(31);
    const advertised = new Set(PROPOSAL_SPECS.map((spec) => spec.name));
    const missing = ASSISTANT_PROPOSAL_TYPES.filter(
      (type) => !advertised.has(type) && !(type in INTENTIONALLY_UNADVERTISED),
    );
    expect(missing).toEqual([]);
  });

  it('advertises nothing the branch validator would reject as unsupported', () => {
    for (const spec of PROPOSAL_SPECS) {
      expect(ASSISTANT_PROPOSAL_TYPES).toContain(spec.name);
    }
  });

  it('gives every operation a bounded object schema and a feature', () => {
    for (const tool of proposalToolRegistry(spyPorts())) {
      expect(tool.access).toBe('proposal');
      expect(tool.feature).toBeTruthy();
      expect(tool.parameters.type).toBe('object');
      if (tool.parameters.type === 'object') {
        expect(tool.parameters.additionalProperties).toBe(false);
      }
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.description.length).toBeLessThan(200);
    }
  });

  it('uses the application own wording rather than schema jargon', () => {
    const tools = byName(spyPorts());
    expect(tools.get('add_capital')?.description).toContain('Business Accounts');
    expect(tools.get('create_drawing')?.description).toContain('Business Accounts');
    expect(tools.get('create_supplier_payment')?.description).toContain('supplier');
    expect(tools.get('delete_entry')?.description).toContain('Reverse');
  });

  it('keeps a resolved party name visible in the confirmation preview', async () => {
    const ports = spyPorts();
    const tool = byName(ports).get('add_bill');
    const draft = await tool!.prepare({ amount: 125, supplierName: 'Acme' }, context());
    expect(draft.preview).toContain('for Acme');
  });

  it('refuses to propose a duplicate customer or supplier', async () => {
    const ports = spyPorts();
    await expect(byName(ports).get('add_debtor')!.prepare({ name: 'Acme' }, context()))
      .rejects.toThrow('PARTY_ALREADY_EXISTS');
    await expect(byName(ports).get('add_supplier')!.prepare({ name: 'Acme' }, context()))
      .rejects.toThrow('PARTY_ALREADY_EXISTS');
  });
});

describe('amount schemas', () => {
  const expense = () => byName(spyPorts()).get('add_expense');

  it('refuses a numeric string instead of coercing it', () => {
    const tool = expense();
    // aiActions.assistantAmount strips characters out of strings to find a
    // number. That leniency is for a human at a keyboard, not for a model.
    expect(validate(tool!.parameters, { amount: '125' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: '1,250' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: '1,25o' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: 125 })).toHaveLength(0);
  });

  it('refuses NaN, Infinity, zero, negatives and absurd amounts', () => {
    const tool = expense();
    for (const amount of [Number.NaN, Infinity, -Infinity, 0, -5, MAX_AI_AMOUNT + 1]) {
      expect(validate(tool!.parameters, { amount })).not.toHaveLength(0);
    }
    expect(validate(tool!.parameters, { amount: MAX_AI_AMOUNT })).toHaveLength(0);
  });

  it('refuses unknown keys', () => {
    const tool = expense();
    expect(validate(tool!.parameters, { amount: 10, sql: 'select 1' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: 10, bookId: 'book-b' })).not.toHaveLength(0);
  });

  it('refuses a prototype-polluting key as it actually arrives, from JSON', () => {
    const tool = expense();
    // In an object literal `__proto__` is a prototype setter and never becomes
    // an own property, so it has to be tested the way model output reaches us.
    const parsed = JSON.parse('{"amount": 10, "__proto__": {"admin": true}}');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(validate(tool!.parameters, parsed)).not.toHaveLength(0);
  });

  it('allows a zero stock count but not a negative one', () => {
    const tool = byName(spyPorts()).get('record_inventory');
    expect(validate(tool!.parameters, { amount: 0 })).toHaveLength(0);
    expect(validate(tool!.parameters, { amount: -1 })).not.toHaveLength(0);
  });

  it('refuses a malformed date', () => {
    const tool = expense();
    expect(validate(tool!.parameters, { amount: 10, date: '08/09/2026' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: 10, date: '2026-09-08' })).toHaveLength(0);
  });

  it('refuses an unknown payment method or payment type', () => {
    const tool = expense();
    expect(validate(tool!.parameters, { amount: 10, method: 'crypto' })).not.toHaveLength(0);
    expect(validate(tool!.parameters, { amount: 10, method: 'cash' })).toHaveLength(0);
    const sale = byName(spyPorts()).get('add_sale');
    expect(validate(sale!.parameters, { amount: 10, paymentType: 'barter' })).not.toHaveLength(0);
  });
});

describe('entry updates and deletions', () => {
  it('refuses deletion of customers, suppliers and stock counts', () => {
    const tool = byName(spyPorts()).get('delete_entry');
    for (const entity of UNDELETABLE_ENTITIES) {
      // The schema accepts the entity name; the branch validator is what
      // refuses it, so this asserts the real rule end to end.
      const result = validateAssistantProposal({ type: 'delete_entry', params: { entity, id: 'x1' } }, 'ai');
      expect(result.ok).toBe(false);
    }
    expect(validate(tool!.parameters, { entity: 'expense', id: 'e1' })).toHaveLength(0);
  });

  it('refuses an update field the entity does not accept', () => {
    // `category` is not an invoice field in ASSISTANT_UPDATE_FIELDS.
    const rejected = validateAssistantProposal(
      { type: 'update_entry', params: { entity: 'invoice', id: 'inv-1', changes: { category: 'Tea' } } },
      'ai',
    );
    expect(rejected.ok).toBe(false);

    const accepted = validateAssistantProposal(
      { type: 'update_entry', params: { entity: 'expense', id: 'e1', changes: { category: 'Tea' } } },
      'ai',
    );
    expect(accepted.ok).toBe(true);
  });

  it('requires a member id for a capital entry', () => {
    const without = validateAssistantProposal(
      { type: 'update_entry', params: { entity: 'capital', id: 'c1', changes: { amount: 100 } } },
      'ai',
    );
    expect(without.ok).toBe(false);

    const withMember = validateAssistantProposal(
      { type: 'update_entry', params: { entity: 'capital', id: 'c1', memberId: 'm1', changes: { amount: 100 } } },
      'ai',
    );
    expect(withMember.ok).toBe(true);
  });

  it('marks a deletion destructive so the sheet can harden its confirmation', async () => {
    const tool = byName(spyPorts()).get('delete_entry');
    const draft = await tool!.prepare({ entity: 'expense', id: 'e1' }, context());
    expect(draft.destructive).toBe(true);
  });

  it('refuses an entity outside the allowed list at the schema', () => {
    const tool = byName(spyPorts()).get('delete_entry');
    expect(validate(tool!.parameters, { entity: 'payroll_run', id: 'p1' })).not.toHaveLength(0);
  });
});

describe('preparation performs no writes', () => {
  it('only calls read-only resolution ports', async () => {
    const ports = spyPorts();
    const tool = byName(ports).get('add_bill');
    await tool!.prepare({ amount: 500, supplierName: 'Amit Traders' }, context());

    expect(ports.resolveParty).toHaveBeenCalledTimes(1);
    expect(ports.computeAmounts).toHaveBeenCalledTimes(1);
    // The ports object exposes no method that could post, create or enqueue.
    const surface = Object.keys(ports).sort();
    expect(surface).toEqual(['canPropose', 'computeAmounts', 'resolveParty', 'resolveRecord', 'today']);
    for (const name of surface) {
      expect(name).not.toMatch(/create|post|save|insert|write|commit|enqueue|delete|update/i);
    }
  });

  it('binds the resolved supplier id and revision into the draft', async () => {
    const ports = spyPorts();
    const tool = byName(ports).get('add_bill');
    const draft = await tool!.prepare({ amount: 500, supplierName: 'Amit Traders' }, context());

    expect(draft.normalized.supplierNameId).toBe('party-amit-traders');
    expect(draft.entityVersions).toEqual({ 'party-amit-traders': 'v1' });
  });

  it('stops on an ambiguous party rather than choosing the closest name', async () => {
    const ports = spyPorts({
      resolveParty: jest.fn(async () => [
        { id: 'p1', name: 'Amit Traders', role: 'supplier' as const, revision: 'v1' },
        { id: 'p2', name: 'Amit Stores', role: 'supplier' as const, revision: 'v1' },
      ]),
    });
    const tool = byName(ports).get('add_bill');
    await expect(tool!.prepare({ amount: 500, supplierName: 'Amit' }, context()))
      .rejects.toThrow('AMBIGUOUS_PARTY:supplierName');
  });

  it('leaves an unmatched party unresolved so the sheet shows a creation', async () => {
    const ports = spyPorts({ resolveParty: jest.fn(async () => []) });
    const tool = byName(ports).get('add_bill');
    const draft = await tool!.prepare({ amount: 500, supplierName: 'Brand New Co' }, context());
    expect(draft.normalized.supplierNameId).toBeUndefined();
    expect(draft.entityVersions).toEqual({});
  });

  it('rejects a record id the model invented', async () => {
    const ports = spyPorts({ resolveRecord: jest.fn(async () => null) });
    const tool = byName(ports).get('record_marketplace_refund');
    await expect(tool!.prepare({ orderId: 'order-999', amount: 50 }, context()))
      .rejects.toThrow('UNKNOWN_RECORD:orderId');
  });

  it('takes totals from the host, not from the model arguments', async () => {
    const ports = spyPorts({ computeAmounts: jest.fn(async () => ({ amount: 499.5 })) });
    const tool = byName(ports).get('add_expense');
    const draft = await tool!.prepare({ amount: 500 }, context());

    expect(draft.normalized.amount).toBe(499.5);
    expect(draft.preview).toContain('INR 499.50');
  });

  it('refuses a non-finite host total', async () => {
    const ports = spyPorts({ computeAmounts: jest.fn(async () => ({ amount: Number.NaN })) });
    const tool = byName(ports).get('add_expense');
    await expect(tool!.prepare({ amount: 500 }, context())).rejects.toThrow('INVALID_TOTAL:amount');
  });

  it('fills the date from the book local today when the model omitted it', async () => {
    const ports = spyPorts({ today: jest.fn(async () => '2026-09-08') });
    const tool = byName(ports).get('add_expense');
    const draft = await tool!.prepare({ amount: 10 }, context());
    expect(draft.normalized.date).toBe('2026-09-08');
    expect(ports.today).toHaveBeenCalled();
  });

  it('aborts when the scope moves during preparation', async () => {
    let calls = 0;
    const assertCurrent = async () => {
      calls += 1;
      if (calls > 1) throw new Error('STALE_SCOPE');
    };
    const tool = byName(spyPorts()).get('add_expense');
    await expect(tool!.prepare({ amount: 10 }, context({ assertCurrent }))).rejects.toThrow('STALE_SCOPE');
  });

  it('names the currency from the trusted scope, never from the arguments', async () => {
    const tool = byName(spyPorts()).get('add_expense');
    const draft = await tool!.prepare({ amount: 10 }, context({ scope: { ...scope, currency: 'AED' } }));
    expect(draft.preview).toContain('AED');
  });
});

describe('authorization', () => {
  it('does not authorize an operation the actor cannot propose', async () => {
    const ports = spyPorts({ canPropose: jest.fn(async (_scope: Scope, operation: string) => operation === 'add_expense') });
    const tools = byName(ports);
    expect(await tools.get('add_expense')!.authorize(context())).toBe(true);
    expect(await tools.get('delete_entry')!.authorize(context())).toBe(false);
  });
});

describe('bundles', () => {
  it('never exceeds the per-turn tool budget', () => {
    for (const [family, names] of Object.entries(BUNDLES)) {
      expect(names.length).toBeLessThanOrEqual(MAX_BUNDLE_TOOLS);
      expect(selectBundle(family, spyPorts()).length).toBe(names.length);
    }
  });

  it('only names operations that exist', () => {
    const advertised = new Set(PROPOSAL_SPECS.map((spec) => spec.name));
    for (const names of Object.values(BUNDLES)) {
      for (const name of names) expect(advertised.has(name)).toBe(true);
    }
  });

  it('rejects an unknown family', () => {
    expect(() => selectBundle('nonsense', spyPorts())).toThrow('UNKNOWN_BUNDLE');
  });

  it('does not mix unrelated families into one bundle', () => {
    const marketplace = selectBundle('marketplace', spyPorts()).map((tool) => tool.feature);
    expect(new Set(marketplace)).toEqual(new Set(['marketplace']));
  });
});

describe('handover to the existing validator', () => {
  it('produces a shape the branch validator accepts', async () => {
    const ports = spyPorts();
    const tool = byName(ports).get('add_expense');
    const draft = await tool!.prepare({ amount: 125, category: 'Tea' }, context());
    const result = validateAssistantProposal(toAssistantProposal(draft), 'ai');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe('add_expense');
      expect(result.action.confirmation.required).toBe(true);
    }
  });

  it('keeps the validator as the final gate for a domain rule this layer does not know', async () => {
    const ports = spyPorts();
    const tool = byName(ports).get('create_receipt');
    // Schema-valid, but the validator requires a customer and invoice id for
    // an against_invoice receipt.
    const draft = await tool!.prepare({ amount: 100, mode: 'against_invoice' }, context());
    const result = validateAssistantProposal(toAssistantProposal(draft), 'ai');
    expect(result.ok).toBe(false);
  });

  it('every advertised operation survives its own happy path through the validator', async () => {
    const ports = spyPorts();
    const happy: Partial<Record<string, Obj>> = {
      add_expense: { amount: 10 },
      log_personal_expense: { amount: 10 },
      add_sale: { amount: 10 },
      add_bill: { amount: 10, supplierName: 'Amit' },
      create_supplier_payment: { amount: 10, supplierName: 'Amit', method: 'cash' },
      add_debtor: { name: 'Amit' },
      add_supplier: { name: 'Amit' },
      add_debtor_payment: { amount: 10, name: 'Amit' },
      create_invoice: { amount: 10, clientName: 'Amit' },
      create_quote: { amount: 10, clientName: 'Amit' },
      create_receipt: { amount: 10, mode: 'cash_sale' },
      create_drawing: { amount: 10, partnerName: 'Partner A' },
      add_capital: { amount: 10, partnerName: 'Partner A' },
      record_inventory: { amount: 0 },
      update_entry: { entity: 'expense', id: 'e1', changes: { amount: 10 } },
      delete_entry: { entity: 'expense', id: 'e1' },
      create_marketplace_order: { platform: 'amazon', externalOrderId: 'A1', gross: 100 },
      record_marketplace_refund: { orderId: 'o1', amount: 10 },
      record_marketplace_rto: { orderId: 'o1', fee: 10 },
      create_marketplace_settlement: { platform: 'amazon', settlementId: 'S1', payout: 100 },
      create_project: { name: 'Site A' },
      add_project_time: { projectId: 'p1', hours: 3 },
      record_project_cost: { projectId: 'p1', amount: 10 },
      create_creator_contract: { brand: 'Acme', campaign: 'Diwali', agreedAmount: 100 },
      record_creator_payout: { contractId: 'c1', amount: 10 },
      create_bom: { productId: 'sku-1', name: 'Mix' },
      add_bom_line: { bomId: 'b1', componentProductId: 'sku-2', quantity: 2 },
      create_production_order: { bomId: 'b1', quantity: 5 },
      create_trade_shipment: { reference: 'SHP-1' },
      add_trade_landed_cost: { shipmentId: 's1', kind: 'freight', amount: 10 },
      record_fx_remeasurement: { amount: 10, gainLoss: 'gain' },
    };

    const failures: string[] = [];
    for (const registered of proposalToolRegistry(ports)) {
      const tool = ['add_debtor', 'add_supplier'].includes(registered.name)
        ? byName(spyPorts({ resolveParty: async () => [] })).get(registered.name)!
        : registered;
      const args = happy[tool.name];
      if (!args) {
        failures.push(`${tool.name}: no happy-path fixture`);
        continue;
      }
      // Schema first, exactly as the agent loop does it.
      const schemaErrors = validate(tool.parameters, args);
      if (schemaErrors.length) {
        failures.push(`${tool.name}: schema rejected its own fixture (${schemaErrors.join('; ')})`);
        continue;
      }
      const draft = await tool.prepare(args, context());
      const result = validateAssistantProposal(toAssistantProposal(draft), 'ai');
      if (!result.ok) failures.push(`${tool.name}: ${result.errors.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });
});
