import { localTodayIso } from '../../utils/dateValidation';

/** This branch's existing Ask action mapping, shared by UI and transaction adapters. */
export type AssistantActionApi = Pick<typeof import('../../api').api,
'createExpense' | 'createSale' | 'listSuppliers' | 'createBill' | 'findOrCreateParty' | 'listDebtors' | 'createReceipt' | 'createPayment' | 'createInvoice' | 'listInvoices' | 'createQuote' | 'listInvestors' | 'drawInvestorFunds' | 'depositInvestorCapital' | 'recordV2InventoryCount' | 'createMarketplaceOrder' | 'recordMarketplaceRefund' | 'recordMarketplaceRto' | 'createMarketplaceSettlement' | 'createProject' | 'addProjectTime' | 'recordProjectCost' | 'createCreatorContract' | 'recordCreatorPayout' | 'createBom' | 'addBomLine' | 'createProductionOrder' | 'createTradeShipment' | 'addTradeLandedCost' | 'recordFxRemeasurement' | 'listExpenses' | 'updateExpense' | 'listSales' | 'updateSale' | 'listBills' | 'updateBill' | 'listPayments' | 'updatePayment' | 'listReceipts' | 'updateReceipt' | 'updateInvoice' | 'listQuotes' | 'updateQuote' | 'updateDebtor' | 'updateSupplier' | 'listDeliveryNotes' | 'updateDeliveryNote' | 'updateNote' | 'getInvestorLedger' | 'updateInvestorCapital' | 'listCashEntries' | 'updateCashEntry' | 'deleteExpense' | 'deleteSale' | 'deleteBill' | 'deletePayment' | 'deleteReceipt' | 'deleteInvoice' | 'deleteQuote' | 'deleteDeliveryNote' | 'deleteNote' | 'deleteCashEntry' | 'deleteInvestorCapital'
>;
const tagNote = (note?: string) => `[AI] ${note || ''}`.trim();

function requireExactMatch<T extends { id: string; name?: string }>(rows: T[], name: unknown, label: string): T {
  const requested = String(name || "").trim().toLocaleLowerCase();
  const exact = rows.filter((row) => String(row.name || "").trim().toLocaleLowerCase() === requested);
  if (exact.length !== 1) {
    throw new Error(exact.length > 1
      ? `More than one ${label} is named "${String(name)}". Choose the exact entry in Ledgr first.`
      : `${label} "${String(name)}" was not found. Add it first or use its exact Ledgr name.`);
  }
  return exact[0];
}

function requireEntry<T extends { id: string }>(rows: T[], id: unknown, label: string): T {
  const found = rows.find((row) => row.id === String(id || ""));
  if (!found) throw new Error(`${label} was not found. Refresh Ask AI and try again.`);
  return found;
}

function mergeAmount(current: any, changes: any) {
  if (changes.amount === undefined) return { ...current, ...changes };
  const amount = Number(changes.amount);
  const next = { ...current, ...changes, amount, total: amount };
  if (Array.isArray(current.lines)) {
    if (current.lines.length > 1 && changes.lines === undefined) {
      throw new Error("This document has multiple lines. Tell me which line to change.");
    }
    if (current.lines.length === 1 && changes.lines === undefined) {
      const qty = Number(current.lines[0].qty ?? current.lines[0].quantity ?? 1) || 1;
      next.lines = [{ ...current.lines[0], qty, rate: amount / qty }];
    }
  }
  return next;
}

export function createAssistantActionExecutor(api: AssistantActionApi, todayIso: () => string = localTodayIso) {
  return async function applyAction(action: { type: string; params: any }): Promise<string> {
  const today = todayIso();
  const p = action.params || {};
  switch (action.type) {
    case "add_expense":
      await api.createExpense({ category: p.category || "General", amount: p.amount, date: p.date || today, method: p.method || "cash", notes: tagNote(p.notes) });
      return "Expense recorded ✓";
    case "log_personal_expense":
      await api.createExpense({ category: p.category || "Personal", amount: p.amount, date: p.date || today, method: p.method || "cash", notes: tagNote(p.notes || "Personal expense") });
      return `Personal expense of $${Number(p.amount).toFixed(2)} recorded ✓`;
    case "add_sale":
      await api.createSale({ amount: p.amount, date: p.date || today, paymentType: p.paymentType || "cash", method: p.method || "cash", notes: tagNote(p.notes) });
      return "Sale recorded ✓";
    case "add_bill": {
      const supplier = requireExactMatch(await api.listSuppliers(), p.supplierName, "Supplier");
      await api.createBill({ supplierId: supplier.id, supplierName: supplier.name, amount: p.amount, date: p.date || today, paymentType: p.paymentType || "cash", method: p.method || "cash", notes: tagNote(p.notes) });
      return "Purchase recorded ✓";
    }
    case "add_debtor":
      await api.findOrCreateParty(p.name, "customer", { phone: p.phone || "" });
      return `Customer "${p.name}" added ✓`;
    case "add_supplier":
      await api.findOrCreateParty(p.name, "supplier", { phone: p.phone || "" });
      return `Supplier "${p.name}" added ✓`;
    case "add_debtor_payment": {
      const customer = requireExactMatch(await api.listDebtors(), p.name, "Customer");
      await api.createReceipt({ mode: "advance", debtorId: customer.id, clientName: customer.name, amount: p.amount, date: p.date || today, method: p.method || "cash", notes: tagNote(p.notes || "customer advance") });
      return `Payment received from "${customer.name}" ✓`;
    }
    case "create_supplier_payment": {
      const supplier = requireExactMatch(await api.listSuppliers(), p.supplierName, "Supplier");
      await api.createPayment({ type: "supplier_payment", supplierId: supplier.id, supplierName: supplier.name, amount: p.amount, date: p.date || today, method: p.method || "cash", notes: tagNote(p.notes) });
      return `Payment to "${supplier.name}" recorded ✓`;
    }
    case "create_invoice": {
      const customer = requireExactMatch(await api.listDebtors(), p.clientName, "Customer");
      const amt = Number(p.amount);
      await api.createInvoice({ partyId: customer.id, debtorId: customer.id, clientName: customer.name, lines: [{ description: p.notes || "Service", qty: 1, rate: amt }], taxRate: 0, total: amt, date: p.date || today, notes: tagNote(p.notes) });
      return `Invoice for "${customer.name}" created ✓`;
    }
    case "create_receipt": {
      const amt = Number(p.amount);
      const mode = p.mode || (p.customerName ? "advance" : "cash_sale");
      let debtorId: string | null = null;
      let clientName = "";
      let allocations: { invoiceId: string; amountApplied: number }[] = [];
      if (mode !== "cash_sale") {
        const customer = requireExactMatch(await api.listDebtors(), p.customerName, "Customer");
        debtorId = customer.id;
        clientName = customer.name || "";
        if (mode === "against_invoice") {
          const invoices = (await api.listInvoices()).filter((item: any) => item.status !== "paid" && item.id === String(p.invoiceId || ""));
          if (invoices.length !== 1) throw new Error("Choose the exact unpaid invoice before applying this receipt.");
          allocations = [{ invoiceId: invoices[0].id, amountApplied: amt }];
        }
      }
      await api.createReceipt({ mode, amount: amt, date: p.date || today, method: p.method || "cash", debtorId, clientName, allocations, notes: tagNote(p.notes) });
      return `Receipt for ${amt.toFixed(2)} recorded ✓`;
    }
    case "create_quote": {
      const customer = requireExactMatch(await api.listDebtors(), p.clientName, "Customer");
      const amt = Number(p.amount);
      await api.createQuote({ partyId: customer.id, debtorId: customer.id, clientName: customer.name, lines: [{ description: p.notes || "Service", qty: 1, rate: amt }], taxRate: 0, total: amt, date: p.date || today, notes: tagNote(p.notes) });
      return `Quote for "${customer.name}" created ✓`;
    }
    case "create_drawing": {
      const member = requireExactMatch(await api.listInvestors(), p.partnerName, "Capital Account");
      await api.drawInvestorFunds(member.id, { amount: Number(p.amount), date: p.date || today, notes: tagNote(p.notes) });
      return `Withdrawal for "${member.name}" recorded ✓`;
    }
    case "add_capital": {
      const member = requireExactMatch(await api.listInvestors(), p.partnerName, "Capital Account");
      await api.depositInvestorCapital(member.id, { amount: Number(p.amount), date: p.date || today, notes: tagNote(p.notes) });
      return `Capital for "${member.name}" added ✓`;
    }
    case "record_inventory":
      await api.recordV2InventoryCount({ date: p.date || today, value: Number(p.amount), notes: tagNote(p.notes) });
      return "Inventory count recorded ✓";
    case "create_marketplace_order":
      await api.createMarketplaceOrder({ platform: p.platform, externalOrderId: p.externalOrderId, date: p.date || today, status: p.status, gross: p.gross, tax: p.tax, marketplaceFee: p.marketplaceFee, shippingFee: p.shippingFee, refund: p.refund, rtoFee: p.rtoFee, currency: p.currency, exchangeRate: p.exchangeRate, settlementId: p.settlementId, notes: tagNote(p.notes) });
      return `Marketplace order ${p.externalOrderId} recorded ✓`;
    case "record_marketplace_refund":
      await api.recordMarketplaceRefund({ orderId: p.orderId, date: p.date || today, amount: p.amount, notes: tagNote(p.notes) });
      return "Marketplace refund recorded ✓";
    case "record_marketplace_rto":
      await api.recordMarketplaceRto({ orderId: p.orderId, date: p.date || today, fee: p.fee, notes: tagNote(p.notes) });
      return "Marketplace RTO recorded ✓";
    case "create_marketplace_settlement":
      await api.createMarketplaceSettlement({ platform: p.platform, settlementId: p.settlementId, date: p.date || today, payout: p.payout, currency: p.currency, exchangeRate: p.exchangeRate, settlementAccountCode: p.settlementAccountCode, notes: tagNote(p.notes) });
      return `Marketplace settlement ${p.settlementId} recorded ✓`;
    case "create_project":
      await api.createProject({ name: p.name, partyId: p.partyId, budget: p.budget, currency: p.currency, metadata: { source: "ai" } });
      return `Project "${p.name}" created ✓`;
    case "add_project_time":
      await api.addProjectTime({ projectId: p.projectId, date: p.date || today, hours: p.hours, rate: p.rate, description: tagNote(p.description || p.notes) });
      return "Project time recorded ✓";
    case "record_project_cost":
      await api.recordProjectCost({ projectId: p.projectId, date: p.date || today, amount: p.amount, description: tagNote(p.description || p.notes), accountCode: p.accountCode, method: p.method || "cash" });
      return "Project cost recorded ✓";
    case "create_creator_contract":
      await api.createCreatorContract({ brand: p.brand, campaign: p.campaign, agreedAmount: p.agreedAmount, partyId: p.partyId, currency: p.currency, dueDate: p.dueDate, metadata: { source: "ai" } });
      return `Creator contract for ${p.brand} created ✓`;
    case "record_creator_payout":
      await api.recordCreatorPayout({ contractId: p.contractId, date: p.date || today, amount: p.amount, currency: p.currency, method: p.method || "bank", notes: tagNote(p.notes) });
      return "Creator payout recorded ✓";
    case "create_bom":
      await api.createBom({ productId: p.productId, name: p.name, version: p.version, metadata: { source: "ai" } });
      return `BOM "${p.name}" created ✓`;
    case "add_bom_line":
      await api.addBomLine({ bomId: p.bomId, componentProductId: p.componentProductId, quantity: p.quantity, unitCost: p.unitCost, metadata: { source: "ai" } });
      return "BOM component added ✓";
    case "create_production_order":
      await api.createProductionOrder({ bomId: p.bomId, date: p.date || today, quantity: p.quantity, status: p.status || "completed", notes: tagNote(p.notes) });
      return "Production order recorded ✓";
    case "create_trade_shipment":
      await api.createTradeShipment({ reference: p.reference, date: p.date || today, direction: p.direction || "import", supplierId: p.supplierId, customerId: p.customerId, currency: p.currency, exchangeRate: p.exchangeRate, goodsValue: p.goodsValue, notes: tagNote(p.notes) });
      return `Trade shipment ${p.reference} created ✓`;
    case "add_trade_landed_cost":
      await api.addTradeLandedCost({ shipmentId: p.shipmentId, date: p.date || today, kind: p.kind, amount: p.amount, currency: p.currency, exchangeRate: p.exchangeRate, capitalized: p.capitalized !== false, method: p.method || "cash", notes: tagNote(p.notes) });
      return "Trade landed cost recorded ✓";
    case "record_fx_remeasurement":
      await api.recordFxRemeasurement({ date: p.date || today, accountCode: p.accountCode, amount: p.amount, gainLoss: p.gainLoss, currency: p.currency, exchangeRate: p.exchangeRate, reference: p.reference, notes: tagNote(p.notes) });
      return `FX ${p.gainLoss} recorded ✓`;
    case "update_entry": {
      const changes = p.changes || {};
      switch (p.entity) {
        case "expense": {
          const current = requireEntry(await api.listExpenses(), p.id, "Expense");
          await api.updateExpense(current.id, mergeAmount(current, changes));
          break;
        }
        case "sale": {
          const current = requireEntry((await api.listSales()).filter((row: any) => row.type !== "invoice"), p.id, "Sale");
          await api.updateSale(current.id, mergeAmount(current, changes));
          break;
        }
        case "bill": {
          const current = requireEntry(await api.listBills(), p.id, "Bill");
          await api.updateBill(current.id, mergeAmount(current, changes));
          break;
        }
        case "supplier_payment": {
          const current = requireEntry((await api.listPayments()).filter((row: any) => row.type === "supplier_payment"), p.id, "Supplier payment");
          await api.updatePayment(current.id, mergeAmount(current, changes));
          break;
        }
        case "receipt": {
          const current = requireEntry(await api.listReceipts(), p.id, "Receipt");
          await api.updateReceipt(current.id, mergeAmount(current, changes));
          break;
        }
        case "invoice": {
          const current = requireEntry(await api.listInvoices(), p.id, "Invoice");
          await api.updateInvoice(current.id, mergeAmount(current, changes));
          break;
        }
        case "quote": {
          const current = requireEntry(await api.listQuotes(), p.id, "Quote");
          await api.updateQuote(current.id, mergeAmount(current, changes));
          break;
        }
        case "customer": {
          const current = requireEntry(await api.listDebtors(), p.id, "Customer");
          await api.updateDebtor(current.id, { ...current, ...changes });
          break;
        }
        case "supplier": {
          const current = requireEntry(await api.listSuppliers(), p.id, "Supplier");
          await api.updateSupplier(current.id, { ...current, ...changes });
          break;
        }
        case "delivery_note": {
          const current = requireEntry(await api.listDeliveryNotes(), p.id, "Delivery note");
          await api.updateDeliveryNote(current.id, { ...current, ...changes });
          break;
        }
        case "note":
          await api.updateNote(String(p.id), changes);
          break;
        case "capital": {
          const memberId = String(p.memberId || "");
          if (!memberId) throw new Error("The Capital Account is missing. Ask again using the partner name.");
          const ledger = await api.getInvestorLedger(memberId);
          const current = requireEntry(ledger.transactions.filter((row: any) => row.type === "capital_injection"), p.id, "Capital entry");
          await api.updateInvestorCapital(memberId, current.id, { amount: Number(changes.amount ?? current.amount), date: changes.date || current.date, notes: tagNote(changes.notes ?? current.notes) });
          break;
        }
        case "drawing": {
          const current = requireEntry((await api.listPayments()).filter((row: any) => row.type === "drawing"), p.id, "Withdrawal");
          await api.updatePayment(current.id, mergeAmount(current, changes));
          break;
        }
        case "cash_entry": {
          const current = requireEntry((await api.listCashEntries()).filter((row: any) => row.editable), p.id, "Cash Book entry");
          await api.updateCashEntry(current.id, mergeAmount(current, changes));
          break;
        }
        case "inventory_count":
          throw new Error("Inventory counts are audit records. Reverse this count, then record a corrected count.");
        default:
          throw new Error("That entry type cannot be edited from Ask AI.");
      }
      return "Entry updated ✓";
    }
    case "delete_entry":
      switch (p.entity) {
        case "expense": await api.deleteExpense(String(p.id)); break;
        case "sale": await api.deleteSale(String(p.id)); break;
        case "bill": await api.deleteBill(String(p.id)); break;
        case "supplier_payment":
        case "drawing": await api.deletePayment(String(p.id)); break;
        case "receipt": await api.deleteReceipt(String(p.id)); break;
        case "invoice": await api.deleteInvoice(String(p.id)); break;
        case "quote": await api.deleteQuote(String(p.id)); break;
        case "delivery_note": await api.deleteDeliveryNote(String(p.id)); break;
        case "note": await api.deleteNote(String(p.id)); break;
        case "inventory_count": throw new Error("Inventory counts are audit records. Reverse this count, then record a corrected count.");
        case "cash_entry": await api.deleteCashEntry(String(p.id)); break;
        case "capital": {
          const memberId = String(p.memberId || "");
          if (!memberId) throw new Error("The Capital Account is missing. Ask again using the partner name.");
          await api.deleteInvestorCapital(memberId, String(p.id));
          break;
        }
        default: throw new Error("That entry type cannot be reversed or deleted from Ask AI.");
      }
      return ["quote", "delivery_note"].includes(String(p.entity)) ? "Entry deleted ✓" : "Entry safely reversed ✓";
    default:
      throw new Error("Unknown action — no changes made.");
  }
}
}
