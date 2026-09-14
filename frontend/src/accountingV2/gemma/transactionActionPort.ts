import type { SqlRunner } from '../../db/schema';
import { withSyncedMutationLocked, type SyncMutation } from '../../sync/coordinator';
import { createAppMutationRouter, createAppWriteRouter, V2AppService } from '../appService';
import { V2InvestorLedgerService } from '../investorLedgerService';
import type { Obj, Scope } from './agentCore';
import { createAssistantActionExecutor, type AssistantActionApi } from './assistantActionExecutor';

type Row = Record<string, any>;
const parse = (raw: unknown): Row => { try { return JSON.parse(String(raw || '{}')); } catch { return {}; } };
const ids = (value: any): string[] => [...new Set([value?.id, value?.source?.id, value?.journal?.id].filter((id): id is string => typeof id === 'string'))];

/** Runs branch domain services on the ProposalExecutor's runner/savepoint. */
export function createTransactionActionPort() {
  return async (operation: string, normalized: Obj, scope: Scope, db: SqlRunner): Promise<Obj> => {
    const service = new V2AppService(db);
    const writes = createAppWriteRouter(service) as Row;
    const mutations = createAppMutationRouter(service) as Row;
    const committedIds: string[] = [];
    const capture = async <T>(mutation: SyncMutation, work: () => Promise<T>): Promise<T> => {
      const value = await withSyncedMutationLocked(db, mutation, work, scope.bookId);
      committedIds.push(...ids(value));
      return value;
    };
    const sources = async (types: string[]) => (await db.all<Row>(`SELECT id,type,date,reference,metadata FROM v2_sources WHERE book_id=? AND type IN (${types.map(() => '?').join(',')}) ORDER BY date DESC,id DESC`, [scope.bookId, ...types]))
      .map(row => ({ ...parse(row.metadata), id: row.id, type: row.type, sourceType: row.type, date: row.date, reference: row.reference }));
    const create = (name: string) => async (input: Row): Promise<any> => {
      const payload: Row = { ...input, ...(scope.locationId ? { locationId: scope.locationId } : {}) };
      return capture({ commandType: 'transaction.create', aggregateType: 'source', aggregateId: String(payload.id || `${name}:${Date.now()}`), payload: { name, input: payload }, businessDate: payload.date, operationIdentity: !payload.id }, () => writes[name](payload));
    };
    const mutate = (name: string) => async (...args: any[]) => capture({ commandType: 'transaction.mutate', aggregateType: 'source', aggregateId: String(args[0]), payload: { name, args }, businessDate: args[1]?.date }, () => mutations[name](...args));
    const domain = (name: string) => async (input: Row) => capture({ commandType: `assistant.${name}`, aggregateType: name, aggregateId: String(input.id || input.orderId || input.projectId || input.shipmentId || `${name}:${Date.now()}`), payload: input, businessDate: input.date, operationIdentity: !input.id }, () => (service as any)[name](input));
    const parties = async (role: 'customer' | 'supplier') => (await service.listParties()).filter((row: any) => row.roles.includes(role)).map((row: any) => ({ ...row, role }));
    const unsupported = async () => { throw new Error('GUIDED_SCREEN_ONLY'); };
    const api = {
      createExpense: create('createExpense'), createSale: create('createSale'), createBill: create('createBill'), createPayment: create('createPayment'), createReceipt: create('createReceipt'), createInvoice: create('createInvoice'),
      listSuppliers: () => parties('supplier'), listDebtors: () => parties('customer'),
      findOrCreateParty: async (name: string, role: any, details: any) => capture({ commandType: 'party.create', aggregateType: 'party', aggregateId: `${role}:${name.toLowerCase()}`, payload: { name, roles: [role], ...details }, operationIdentity: true }, () => service.ensureParty(name, role, details)),
      listExpenses: () => sources(['expense']), listSales: () => sources(['cash_sale', 'credit_sale']), listBills: () => service.listBills(), listPayments: () => sources(['supplier_payment', 'drawing']), listReceipts: () => sources(['receipt']), listInvoices: async () => (await service.listSalesAndInvoices()).filter((row: any) => row.type === 'invoice'),
      updateExpense: mutate('updateExpense'), deleteExpense: mutate('deleteExpense'), updateSale: mutate('updateSale'), deleteSale: mutate('deleteSale'), updateBill: mutate('updateBill'), deleteBill: mutate('deleteBill'), updatePayment: mutate('updatePayment'), deletePayment: mutate('deletePayment'), updateReceipt: mutate('updateReceipt'), deleteReceipt: mutate('deleteReceipt'), updateInvoice: mutate('updateInvoice'), deleteInvoice: mutate('deleteInvoice'), updateNote: mutate('updateNote'), deleteNote: mutate('deleteNote'),
      listQuotes: unsupported, createQuote: unsupported, updateQuote: unsupported, deleteQuote: unsupported, listDeliveryNotes: unsupported, updateDeliveryNote: unsupported, deleteDeliveryNote: unsupported,
      updateDebtor: async (id: string, patch: any) => capture({ commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch } }, () => service.updateParty(id, patch)),
      updateSupplier: async (id: string, patch: any) => capture({ commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch } }, () => service.updateParty(id, patch)),
      recordV2InventoryCount: async (input: any) => capture({ commandType: 'inventory.count.record', aggregateType: 'inventory_count', aggregateId: `inventory:${input.date}`, payload: input, businessDate: input.date, operationIdentity: true }, () => service.recordInventoryCount({ ...input, ...(scope.locationId ? { locationId: scope.locationId } : {}) })),
      listInvestors: () => db.all<any>('SELECT id,name,opening_contribution openingCapital,current_capital currentCapital,profit_share_pct profitSharePct FROM v2_members WHERE book_id=?', [scope.bookId]),
      getInvestorLedger: (id: string) => new V2InvestorLedgerService(db).detail(scope.bookId, id),
      depositInvestorCapital: async (id: string, input: any) => capture({ commandType: 'capital.deposit', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(db).deposit({ ...input, bookId: scope.bookId, memberId: id })),
      drawInvestorFunds: async (id: string, input: any) => capture({ commandType: 'capital.draw', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(db).draw({ ...input, bookId: scope.bookId, memberId: id })),
      updateInvestorCapital: async (id: string, sourceId: string, input: any) => capture({ commandType: 'capital.patch', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId, input }, businessDate: input.date }, () => new V2InvestorLedgerService(db).updateDeposit(sourceId, { ...input, bookId: scope.bookId, memberId: id })),
      deleteInvestorCapital: async (id: string, sourceId: string) => capture({ commandType: 'capital.delete', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId } }, () => new V2InvestorLedgerService(db).deleteDeposit(sourceId, scope.bookId, id)),
      listCashEntries: () => service.listCashMovements(), updateCashEntry: async (id: string, input: any) => capture({ commandType: 'cash.patch', aggregateType: 'source', aggregateId: id, payload: { id, input }, businessDate: input.date }, () => service.updateManualCash(id, input)), deleteCashEntry: async (id: string) => capture({ commandType: 'cash.delete', aggregateType: 'source', aggregateId: id, payload: { id } }, () => service.deleteManualCash(id)),
      createMarketplaceOrder: domain('createMarketplaceOrder'), recordMarketplaceRefund: domain('recordMarketplaceRefund'), recordMarketplaceRto: domain('recordMarketplaceRto'), createMarketplaceSettlement: domain('createMarketplaceSettlement'),
      createProject: domain('createProject'), addProjectTime: domain('addProjectTime'), recordProjectCost: domain('recordProjectCost'), createCreatorContract: domain('createCreatorContract'), recordCreatorPayout: domain('recordCreatorPayout'), createBom: domain('createBom'), addBomLine: domain('addBomLine'), createProductionOrder: domain('createProductionOrder'), createTradeShipment: domain('createTradeShipment'), addTradeLandedCost: domain('addTradeLandedCost'), recordFxRemeasurement: domain('recordFxRemeasurement'),
    } as unknown as AssistantActionApi;
    const message = await createAssistantActionExecutor(api, () => scope.today)({ type: operation, params: normalized });
    if (!committedIds.length) throw new Error('DOMAIN_RETURNED_NO_RESULT');
    return { message, committedIds: [...new Set(committedIds)] };
  };
}
