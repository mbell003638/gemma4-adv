import { chooseGemmaReadFamily } from '../src/accountingV2/gemma/liveGemmaAsk';
import { gemmaProposalNames, operationEnabled } from '../src/accountingV2/gemma/liveProposalPolicy';
import fs from 'fs';
import path from 'path';

describe('Gemma live Ask routing', () => {
  test.each([
    ['show my profit and loss', 'reports'],
    ['how much cash is in the bank?', 'cash'],
    ['what does customer Arjun owe?', 'parties'],
    ['which invoice is overdue?', 'invoices'],
    ['find journal entry INV-4', 'entries'],
    ['show stock valuation', 'inventory'],
    ['show partner capital and drawings', 'business-accounts'],
    ['what can this app do?', 'capabilities'],
  ])('%s selects %s', (question, expected) => {
    expect(chooseGemmaReadFamily(question)).toBe(expected);
  });
});

describe('Manus Gemma proposal policy', () => {
  it('selects a bounded family and no writes for an informational question', () => {
    expect(gemmaProposalNames('record a supplier bill')).toEqual(['add_bill', 'create_supplier_payment']);
    expect(gemmaProposalNames('add a new supplier')).toEqual(['add_debtor', 'add_supplier']);
    expect(gemmaProposalNames('what can this app do?')).toEqual([]);
  });

  it('requires the branch feature that owns each operation', () => {
    expect(operationEnabled('add_bill', ['procurement'])).toBe(true);
    expect(operationEnabled('add_bill', ['core_ledger'])).toBe(false);
    expect(operationEnabled('create_invoice', ['invoicing'])).toBe(true);
    expect(operationEnabled('record_inventory', ['inventory'])).toBe(true);
    expect(operationEnabled('add_debtor', ['customers'])).toBe(true);
    expect(operationEnabled('add_supplier', ['procurement'])).toBe(true);
  });

  it('passes the trusted UI proposal permission into the agent', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/accountingV2/gemma/liveGemmaAsk.ts'), 'utf8');
    expect(source).toContain('canPropose: allowProposals');
    expect(source).not.toContain('canPropose: false');
  });
});
