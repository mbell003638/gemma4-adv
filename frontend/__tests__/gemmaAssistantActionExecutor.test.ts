import { createAssistantActionExecutor, AssistantActionApi } from '../src/accountingV2/gemma/assistantActionExecutor';

const methods = ["createExpense","createSale","listSuppliers","createBill","findOrCreateParty","listDebtors","createReceipt","createPayment","createInvoice","listInvoices","createQuote","listInvestors","drawInvestorFunds","depositInvestorCapital","recordV2InventoryCount","createMarketplaceOrder","recordMarketplaceRefund","recordMarketplaceRto","createMarketplaceSettlement","createProject","addProjectTime","recordProjectCost","createCreatorContract","recordCreatorPayout","createBom","addBomLine","createProductionOrder","createTradeShipment","addTradeLandedCost","recordFxRemeasurement","listExpenses","updateExpense","listSales","updateSale","listBills","updateBill","listPayments","updatePayment","listReceipts","updateReceipt","updateInvoice","listQuotes","updateQuote","updateDebtor","updateSupplier","listDeliveryNotes","updateDeliveryNote","updateNote","getInvestorLedger","updateInvestorCapital","listCashEntries","updateCashEntry","deleteExpense","deleteSale","deleteBill","deletePayment","deleteReceipt","deleteInvoice","deleteQuote","deleteDeliveryNote","deleteNote","deleteCashEntry","deleteInvestorCapital"];
function fixture() {
  const row = { id: 'r1', name: 'Acme', editable: true, amount: 10, date: '2026-09-01', status: 'unpaid', lines: [{ qty: 2, rate: 5 }] };
  const api = Object.fromEntries(methods.map(name => [name, jest.fn(async () =>
    name.startsWith('list') ? [{ ...row }] : name === 'getInvestorLedger' ? { transactions: [{ ...row, type: 'capital_injection' }] } : { id: 'posted' }
  )])) as unknown as AssistantActionApi;
  return { api, run: createAssistantActionExecutor(api, () => '2026-09-09') };
}

describe('branch-specific Ask action extraction', () => {
  test.each([
    ['expense', 'updateExpense'], ['sale', 'updateSale'], ['bill', 'updateBill'],
    ['supplier_payment', 'updatePayment'], ['receipt', 'updateReceipt'], ['invoice', 'updateInvoice'],
    ['quote', 'updateQuote'], ['customer', 'updateDebtor'], ['supplier', 'updateSupplier'],
    ['delivery_note', 'updateDeliveryNote'], ['note', 'updateNote'], ['capital', 'updateInvestorCapital'],
    ['drawing', 'updatePayment'], ['cash_entry', 'updateCashEntry'],
  ])('update %s routes to %s', async (entity, method) => {
    const { api, run } = fixture();
    (api.listPayments as jest.Mock).mockResolvedValue([{ id: 'r1', type: entity, amount: 10 }]);
    await run({ type: 'update_entry', params: { entity, id: 'r1', memberId: 'member', changes: { amount: 12 } } });
    expect(api[method as keyof AssistantActionApi]).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['expense', 'deleteExpense'], ['sale', 'deleteSale'], ['bill', 'deleteBill'],
    ['supplier_payment', 'deletePayment'], ['drawing', 'deletePayment'],
    ['receipt', 'deleteReceipt'], ['invoice', 'deleteInvoice'], ['quote', 'deleteQuote'],
    ['delivery_note', 'deleteDeliveryNote'], ['note', 'deleteNote'],
    ['cash_entry', 'deleteCashEntry'], ['capital', 'deleteInvestorCapital'],
  ])('delete %s routes to %s', async (entity, method) => {
    const { api, run } = fixture();
    await run({ type: 'delete_entry', params: { entity, id: 'r1', memberId: 'member' } });
    expect(api[method as keyof AssistantActionApi]).toHaveBeenCalledTimes(1);
  });
  test.each([["add_expense","createExpense"],["log_personal_expense","createExpense"],["add_sale","createSale"],["add_bill","createBill"],["add_debtor","findOrCreateParty"],["add_supplier","findOrCreateParty"],["add_debtor_payment","createReceipt"],["create_supplier_payment","createPayment"],["create_invoice","createInvoice"],["create_receipt","createReceipt"],["create_quote","createQuote"],["create_drawing","drawInvestorFunds"],["add_capital","depositInvestorCapital"],["record_inventory","recordV2InventoryCount"],["create_marketplace_order","createMarketplaceOrder"],["record_marketplace_refund","recordMarketplaceRefund"],["record_marketplace_rto","recordMarketplaceRto"],["create_marketplace_settlement","createMarketplaceSettlement"],["create_project","createProject"],["add_project_time","addProjectTime"],["record_project_cost","recordProjectCost"],["create_creator_contract","createCreatorContract"],["record_creator_payout","recordCreatorPayout"],["create_bom","createBom"],["add_bom_line","addBomLine"],["create_production_order","createProductionOrder"],["create_trade_shipment","createTradeShipment"],["add_trade_landed_cost","addTradeLandedCost"],["record_fx_remeasurement","recordFxRemeasurement"]])('%s dispatches to %s', async (type, method) => {
    const { api, run } = fixture();
    await run({ type, params: { amount: 12, name: 'Acme', supplierName: 'Acme', clientName: 'Acme', partnerName: 'Acme' } });
    expect(api[method as keyof AssistantActionApi]).toHaveBeenCalledTimes(1);
    const writes = methods.filter(name => !name.startsWith('list') && name !== 'getInvestorLedger');
    expect(writes.filter(name => (api[name as keyof AssistantActionApi] as jest.Mock).mock.calls.length)).toEqual([method]);
  });
  test('expense defaults and explicit overrides retain the AI note', async () => {
    const { api, run } = fixture();
    await run({ type: 'add_expense', params: { amount: 12 } });
    expect(api.createExpense).toHaveBeenCalledWith({ category: 'General', amount: 12, date: '2026-09-09', method: 'cash', notes: '[AI]' });
    await run({ type: 'add_expense', params: { amount: 20, category: 'Rent', date: '2026-08-01', method: 'bank', notes: 'office' } });
    expect(api.createExpense).toHaveBeenLastCalledWith({ category: 'Rent', amount: 20, date: '2026-08-01', method: 'bank', notes: '[AI] office' });
  });
  test('ambiguous parties never write', async () => {
    const { api, run } = fixture();
    (api.listSuppliers as jest.Mock).mockResolvedValue([{ id: '1', name: 'Acme' }, { id: '2', name: 'acme' }]);
    await expect(run({ type: 'add_bill', params: { supplierName: 'Acme', amount: 12 } })).rejects.toThrow('More than one');
    expect(api.createBill).not.toHaveBeenCalled();
  });
  test('missing exact party never writes', async () => {
    const { api, run } = fixture();
    await expect(run({ type: 'create_invoice', params: { clientName: 'Ac', amount: 12 } })).rejects.toThrow('not found');
    expect(api.createInvoice).not.toHaveBeenCalled();
  });
  test('invoice allocations retain the selected invoice and amount', async () => {
    const { api, run } = fixture();
    await run({ type: 'create_receipt', params: { mode: 'against_invoice', customerName: 'Acme', invoiceId: 'r1', amount: 12 } });
    expect(api.createReceipt).toHaveBeenCalledWith(expect.objectContaining({ debtorId: 'r1', allocations: [{ invoiceId: 'r1', amountApplied: 12 }] }));
  });
  test('single-line amount edits preserve quantity', async () => {
    const { api, run } = fixture();
    await run({ type: 'update_entry', params: { entity: 'invoice', id: 'r1', changes: { amount: 30 } } });
    expect(api.updateInvoice).toHaveBeenCalledWith('r1', expect.objectContaining({ total: 30, lines: [{ qty: 2, rate: 15 }] }));
  });
  test('multi-line amount edits require explicit lines', async () => {
    const { api, run } = fixture();
    (api.listInvoices as jest.Mock).mockResolvedValue([{ id: 'r1', lines: [{ qty: 1 }, { qty: 1 }] }]);
    await expect(run({ type: 'update_entry', params: { entity: 'invoice', id: 'r1', changes: { amount: 30 } } })).rejects.toThrow('multiple lines');
    expect(api.updateInvoice).not.toHaveBeenCalled();
  });
  test.each(['inventory_count', 'unknown'])('unsupported update %s fails closed', async entity => {
    const { run } = fixture();
    await expect(run({ type: 'update_entry', params: { entity, id: 'r1' } })).rejects.toThrow();
  });
  test('unknown operation fails closed', async () => {
    await expect(fixture().run({ type: 'unknown', params: {} })).rejects.toThrow();
  });
});
