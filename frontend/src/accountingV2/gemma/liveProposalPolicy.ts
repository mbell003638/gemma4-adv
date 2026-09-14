/** Operations with a tested transaction path and complete read-only preflight. */
export const LIVE_GEMMA_PROPOSALS = new Set([
  'add_expense', 'log_personal_expense', 'add_sale', 'record_inventory',
  'add_bill', 'create_supplier_payment', 'add_debtor_payment', 'create_invoice',
  'add_debtor', 'add_supplier',
]);

const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  expenses: ['add_expense', 'log_personal_expense'],
  sales: ['add_sale', 'add_debtor_payment'],
  purchases: ['add_bill', 'create_supplier_payment'],
  invoices: ['create_invoice'],
  inventory: ['record_inventory'],
  parties: ['add_debtor', 'add_supplier'],
};

export function gemmaProposalNames(question: string): readonly string[] {
  const q = question.toLowerCase();
  if (/\b(add|create|new)\b.*\b(customer|debtor|supplier)\b|\b(customer|debtor|supplier)\b.*\b(add|create|new)\b/.test(q)) return FAMILIES.parties;
  if (/\b(stock|inventory|count)\b/.test(q)) return FAMILIES.inventory;
  if (/\binvoice\b/.test(q)) return FAMILIES.invoices;
  if (/\b(bill|supplier|purchase)\b/.test(q)) return FAMILIES.purchases;
  if (/\b(customer payment|debtor payment|sale|sold)\b/.test(q)) return FAMILIES.sales;
  if (/\b(expense|spent|personal)\b/.test(q)) return FAMILIES.expenses;
  return [];
}

export function operationEnabled(operation: string, features: readonly string[]): boolean {
  const enabled = new Set(features);
  if (['add_expense', 'log_personal_expense', 'add_sale'].includes(operation)) return enabled.has('core_ledger');
  if (['add_bill', 'create_supplier_payment'].includes(operation)) return enabled.has('procurement');
  if (operation === 'add_debtor_payment') return enabled.has('customers');
  if (operation === 'add_debtor') return enabled.has('customers') || enabled.has('commerce');
  if (operation === 'add_supplier') return enabled.has('procurement');
  if (operation === 'create_invoice') return enabled.has('invoicing');
  return operation === 'record_inventory' && enabled.has('inventory');
}
