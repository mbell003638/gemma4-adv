import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '@/src/utils/storage';
import { bumpDataVersion } from '@/src/utils/dataVersion';
import { localTodayIso } from '@/src/utils/dateValidation';
import { round2 } from '@/src/money';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig } from '@/src/db/ai';
import { recognizeLocalOcr } from '@/src/utils/localOcr';
import { interpretLocalDocumentText } from '@/src/accountingV2/localDocumentParser';
import { extractDocumentWithGemma, transcribeAudioWithGemma } from '@/src/accountingV2/gemma/mediaTasks';
import { askBooksOnDevice } from '@/src/accountingV2/onDeviceAsk';
import { runReadTool } from '@/src/accountingV2/onDeviceReadTools';
import { adoptRemoteKey, getCloudConfig, getStorageClient, saveCloudConfig, type CloudDriveConfig } from '@/src/sync/cloudDriveProvider';
import { createWifiP2pSession, packWifiTransfer, type WifiP2pTransferPackage } from '@/src/sync/wifiP2pSync';
import { getPreferredOnDevicePack, setPreferredOnDevicePack } from '@/src/utils/onDeviceLlm';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter, stablePartyId, type V2ClosingBalancesImportInput, type V2ScanPartyRequest, type V2ScanTransactionImportInput } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import type { PersonaId } from '@/src/accountingV2/config';
import { getEnabledFeatures, type FeatureKey } from '@/src/utils/featureFlags';
import { assertFeatureDisableAllowed } from '@/src/accountingV2/featureDisableGuards';
import { readV2BookPrefs, writeV2BookPrefs } from '@/src/accountingV2/optionalModules';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
import { partnershipDisplayFromReports } from './accountingV2/reports';
import { buildPersistentV2Reports } from '@/src/accountingV2/persistentReports';
import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook';
import { V2InvestorLedgerService, type InvestorLedgerDetail } from '@/src/accountingV2/investorLedgerService';
import { selfHostedSync } from '@/src/accountingV2/services/selfHostedSyncService';
import { V2SqlRepository } from '@/src/accountingV2/repository';
import { resolveWriteLocationId } from '@/src/accountingV2/services/locationDomainService';
import { V2DocumentService } from '@/src/accountingV2/documentService';
import { v2Services } from '@/src/accountingV2/runtime';
import { configureSync, disableSync, enableSync, getSyncStatus, markSyncRecoveryRequired, retrySyncNow, syncNow, withSyncedMutation, type SyncMutation } from '@/src/sync/coordinator';
import { listOpenSyncConflicts, listSyncCorrectionAccounts, resolveSyncConflict as resolveSyncConflictDecision, type ConflictResolutionType } from '@/src/sync/conflicts';
import { createSyncEnrollmentCode, enrollSyncDevice, installServerSnapshot, listSyncDevices, listSyncMemberships, publishServerSnapshot, redeemSyncEnrollmentCode, removeSyncMembership, renameSyncDevice, revokeSyncDevice, setSyncMembershipLocations, upsertSyncMembership, verifyProjectionCheckpoint } from '@/src/sync/recovery';
import { BOOK_PROJECTION_SCHEMA_VERSION, exportBookProjection, hashBookProjection, installBookProjection } from '@/src/sync/projection';
import { hashPayload, type SyncOperation, type SyncSnapshot } from '@/src/sync/protocol';
import { authorizeSyncOidc as runSyncOidcAuthorization } from '@/src/sync/oidc';
import { checkLocalIntegrity } from '@/src/utils/localIntegrity';
import { getRequestedHostingMode, setRequestedHostingMode, type HostingMode } from '@/src/utils/hostingMode';
import { listBackupHistory } from '@/src/utils/backupHistory';
import {
  listBooks as beListBooks,
  activeBookId as beActiveBookId,
  activeSqlRunner,
  setActiveBook as beSetActiveBook,
  createBook as beCreateBook,
  renameBook as beRenameBook,
  deleteBook as beDeleteBook,
  resetBooksAndActiveBook as beResetBooksAndActiveBook,
  type BookMeta,
} from '@/src/db/backend';

const AI_PROVIDER_KEY = 'ai_provider';
const AI_API_KEY_KEY  = 'ai_api_key';
const AI_MODEL_KEY    = 'ai_model';
const AI_VISION_MODEL_KEY = 'ai_vision_model';
const AI_TRANSCRIPTION_MODEL_KEY = 'ai_transcription_model';
const AI_TRANSCRIPTION_BASE_URL_KEY = 'ai_transcription_base_url';
const AI_TRANSCRIPTION_API_KEY_KEY = 'ai_transcription_api_key';
const AI_BASE_URL_KEY = 'ai_base_url';
const AI_VOICE_PROVIDER_KEY = 'ai_voice_provider';
const AI_OCR_PROVIDER_KEY = 'ai_ocr_provider';
const AI_INTERPRETATION_PROVIDER_KEY = 'ai_interpretation_provider';
const AI_ENTRY_HELP_ORDER_KEY = 'ai_entry_help_order';
const SPEAK_ANSWERS_KEY = 'ledgr_speak_answers';

// User-preference + UI-customization AsyncStorage keys that live OUTSIDE the
// per-book settings blob. A factory reset must wipe these too so the device is
// returned to a truly pristine state (the user explicitly wants preferences
// gone, not preserved). Mirrors the keys written by:
//   - ThemeContext.tsx: 'theme_mode', 'animations_enabled'
//   - app/(tabs)/index.tsx: 'ledgr_tile_order', 'ledgr_tile_usage'
const THEME_MODE_KEY        = 'theme_mode';
const ANIMATIONS_ENABLED_KEY = 'animations_enabled';
const TILE_ORDER_KEY        = 'ledgr_tile_order';
const TILE_USAGE_KEY        = 'ledgr_tile_usage';
const LAST_BACKUP_KEY        = 'ledgr:last_backup_at';
// Exported so the reset UI (advanced-settings) can assert/reset in lockstep and
// tests can enumerate the exact device-level keys a factory reset must clear.
export const FACTORY_RESET_PREF_KEYS = [
  THEME_MODE_KEY,
  ANIMATIONS_ENABLED_KEY,
  TILE_ORDER_KEY,
  TILE_USAGE_KEY,
  'ledgr:hosting_mode',
  LAST_BACKUP_KEY,
  SPEAK_ANSWERS_KEY,
] as const;

let webSessionAiKey = '';
let webSessionTranscriptionAiKey = '';
const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

export async function getAIConfig(): Promise<AIConfig> {
  const [provider, secureKey, storedKey, model, visionModel, transcriptionModel, transcriptionBaseUrl, secureTranscriptionKey, baseUrl, voiceProvider, ocrProvider, interpretationProvider, entryHelpOrder] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    isWebRuntime ? Promise.resolve(webSessionAiKey) : storage.secureGet(AI_API_KEY_KEY, ''),
    isWebRuntime ? Promise.resolve(null) : AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_VISION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_BASE_URL_KEY),
    isWebRuntime ? Promise.resolve(webSessionTranscriptionAiKey) : storage.secureGet(AI_TRANSCRIPTION_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
    AsyncStorage.getItem(AI_VOICE_PROVIDER_KEY),
    AsyncStorage.getItem(AI_OCR_PROVIDER_KEY),
    AsyncStorage.getItem(AI_INTERPRETATION_PROVIDER_KEY),
    AsyncStorage.getItem(AI_ENTRY_HELP_ORDER_KEY),
  ]);
  if (isWebRuntime) await AsyncStorage.removeItem(AI_API_KEY_KEY).catch(() => {});
  const resolvedKey = isWebRuntime ? webSessionAiKey : (secureKey || storedKey || '');
  if (!isWebRuntime && resolvedKey && !secureKey) {
    let migrated = false;
    try { migrated = await storage.secureSet(AI_API_KEY_KEY, resolvedKey); } catch { migrated = false; }
    if (migrated) await AsyncStorage.removeItem(AI_API_KEY_KEY);
    else console.warn('[ai] Secure key migration failed; retaining legacy key for recovery.');
  }
  return {
    provider: ai.normalizeProviderId(provider),
    apiKey: resolvedKey,
    model: model ?? ai.DEFAULT_GEMINI_MODEL,
    visionModel: visionModel ?? undefined,
    transcriptionModel: transcriptionModel ?? undefined,
    transcriptionBaseUrl: transcriptionBaseUrl ?? undefined,
    transcriptionApiKey: secureTranscriptionKey || undefined,
    baseUrl: baseUrl ?? undefined,
    voiceProvider: voiceProvider === 'android-device' || voiceProvider === 'cloud' ? voiceProvider : 'auto',
    ocrProvider: ocrProvider === 'android-device' || ocrProvider === 'cloud' ? ocrProvider : 'auto',
    interpretationProvider: interpretationProvider === 'android-device' || interpretationProvider === 'cloud' ? interpretationProvider : 'auto',
    entryHelpOrder: ai.normalizeEntryHelpOrder(entryHelpOrder),
  };
}

export async function setAIConfig(cfg: Partial<AIConfig>) {
  const ops: Promise<unknown>[] = [];
  if (cfg.provider !== undefined) ops.push(AsyncStorage.setItem(AI_PROVIDER_KEY, cfg.provider));
  let secureKeyWrite: Promise<boolean> | null = null;
  let transcriptionKeyWrite: Promise<boolean> | null = null;
  if (cfg.apiKey !== undefined) {
    if (isWebRuntime) {
      webSessionAiKey = cfg.apiKey || '';
      secureKeyWrite = AsyncStorage.removeItem(AI_API_KEY_KEY).then(() => true).catch(() => false);
    } else {
      secureKeyWrite = cfg.apiKey ? storage.secureSet(AI_API_KEY_KEY, cfg.apiKey) : storage.secureRemove(AI_API_KEY_KEY);
    }
  }
  if (cfg.transcriptionApiKey !== undefined) {
    if (isWebRuntime) {
      webSessionTranscriptionAiKey = cfg.transcriptionApiKey || '';
      transcriptionKeyWrite = AsyncStorage.removeItem(AI_TRANSCRIPTION_API_KEY_KEY).then(() => true).catch(() => false);
    } else {
      transcriptionKeyWrite = cfg.transcriptionApiKey ? storage.secureSet(AI_TRANSCRIPTION_API_KEY_KEY, cfg.transcriptionApiKey) : storage.secureRemove(AI_TRANSCRIPTION_API_KEY_KEY);
    }
  }
  if (cfg.model !== undefined) ops.push(AsyncStorage.setItem(AI_MODEL_KEY, cfg.model));
  if (cfg.visionModel !== undefined) ops.push(AsyncStorage.setItem(AI_VISION_MODEL_KEY, cfg.visionModel));
  if (cfg.transcriptionModel !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_MODEL_KEY, cfg.transcriptionModel));
  if (cfg.transcriptionBaseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.transcriptionBaseUrl)));
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.baseUrl)));
  if (cfg.voiceProvider !== undefined) ops.push(AsyncStorage.setItem(AI_VOICE_PROVIDER_KEY, cfg.voiceProvider));
  if (cfg.ocrProvider !== undefined) ops.push(AsyncStorage.setItem(AI_OCR_PROVIDER_KEY, cfg.ocrProvider));
  if (cfg.interpretationProvider !== undefined) ops.push(AsyncStorage.setItem(AI_INTERPRETATION_PROVIDER_KEY, cfg.interpretationProvider));
  if (cfg.entryHelpOrder !== undefined) ops.push(AsyncStorage.setItem(AI_ENTRY_HELP_ORDER_KEY, ai.normalizeEntryHelpOrder(cfg.entryHelpOrder)));
  const [secureOk, transcriptionSecureOk] = await Promise.all([
    secureKeyWrite ?? Promise.resolve(true),
    transcriptionKeyWrite ?? Promise.resolve(true),
    ...ops,
  ]);
  if ((secureKeyWrite && secureOk === false) || (transcriptionKeyWrite && transcriptionSecureOk === false)) {
    throw new Error('Could not securely save your AI API key on this device. Please try again.');
  }
  if (secureKeyWrite && cfg.apiKey !== undefined) await AsyncStorage.removeItem(AI_API_KEY_KEY);
  if (transcriptionKeyWrite && cfg.transcriptionApiKey !== undefined) await AsyncStorage.removeItem(AI_TRANSCRIPTION_API_KEY_KEY);
}
// Convenience aliases used by the current voice and bill screens.
export async function getGeminiKey(): Promise<string> { return (await getAIConfig()).apiKey; }
export async function setGeminiKey(v: string) { await setAIConfig({ apiKey: v }); }
export async function getGeminiModel(): Promise<string> { return (await getAIConfig()).model; }
export async function setGeminiModel(v: string) { await setAIConfig({ model: v }); }

// ---------- reconcile helper (matching logic in JS) ----------
// Works for BOTH a supplier (compare their statement to our bills/payments) and a
// customer/debtor (compare their statement to our invoices/receipts). `party`
// selects which ledger side to pull; `partyId` is the supplier or debtor id.
async function reconcileStatement(
  imageBase64: string,
  partyId: string,
  mimeType = 'image/jpeg',
  party: 'supplier' | 'customer' = 'supplier',
) {
  const extracted = await ai.reconcileStatementAI(await getAIConfig(), imageBase64, mimeType);

  let ourBills: any[] = [], ourPayments: any[] = [];
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
  if (!partyId) throw new Error('Choose a customer or supplier before reconciling');
  const detail: any = await service.getPartyDetail(partyId, party);
  if (!detail) throw new Error(`${party === 'customer' ? 'Customer' : 'Supplier'} was not found in the active V2 book`);
  if (party === 'customer') {
    ourBills = (detail.statement?.ledger || []).filter((item: any) => item.kind === 'invoice').map((item: any) => ({ amount: item.debit, date: item.date, reference: item.ref }));
    ourPayments = (detail.payments || []).map((item: any) => ({ amount: item.amount, date: item.date }));
  } else {
    ourBills = detail.bills || [];
    ourPayments = detail.payments || [];
  }

  const daysBetween = (a: string, b: string) => {
    const A = new Date(a); const B = new Date(b);
    if (isNaN(A.getTime()) || isNaN(B.getTime())) return 999;
    return Math.abs(Math.round((A.getTime() - B.getTime()) / 86400000));
  };
  const match = (e: any, pool: any[]) => {
    const eAmt = Number(e.amount || 0);
    for (const o of pool) {
      if (daysBetween(e.date || '', o.date || '') > 3) continue;
      const oAmt = Number(o.amount || 0);
      if (eAmt && oAmt && Math.abs(oAmt - eAmt) / Math.max(eAmt, 1) <= 0.01) return o;
    }
    return null;
  };

  const matched: any[] = [], missing: any[] = [];
  for (const e of (extracted.entries || [])) {
    const pool = e.type === 'bill' ? ourBills : e.type === 'payment' ? ourPayments : [...ourBills, ...ourPayments];
    const m = match(e, pool);
    if (m) matched.push({ statement: e, ledgr: m });
    else missing.push(e);
  }
  const stmtRefs = (extracted.entries || []).map((e: any) => ({ date: e.date, amount: Number(e.amount || 0) }));
  const extra: any[] = [];
  for (const o of [...ourBills, ...ourPayments]) {
    const oAmt = Number(o.amount || 0);
    const found = stmtRefs.some((r: any) => r.date === o.date && r.amount && Math.abs(r.amount - oAmt) / Math.max(r.amount, 1) <= 0.01);
    if (!found) extra.push(o);
  }
  return { extracted, matched, missingInLedgr: missing, notOnStatement: extra, partyId, party, supplierId: party === 'supplier' ? partyId : undefined };
}

type AiDataMode = 'summary' | 'detailed';

async function buildAiSnapshot(from: string, to: string, mode: AiDataMode = 'summary') {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const [settings, context] = await Promise.all([db.getSettings(), service.activeContext()]);
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');

  // Summary mode is the default and only needs the KPI/report totals. Avoid
  // loading full parties, source rows, quotes, delivery notes, and inventory
  // history for every ordinary question.
  const [dashboard, reports] = await Promise.all([
    getV2Dashboard(runner, context.bookId),
    buildPersistentV2Reports(runner, { bookId: context.bookId, from, to }),
  ]);
  const detailed = mode === 'detailed';
  if (!detailed) {
    return {
      source: 'v2', currency: settings.currency, businessName: settings.businessName,
      snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
      yearToDate: reports.profitAndLoss,
      creditors: [], debtors: [], expensesByCategory: {}, openInvoices: [], parties: [], capitalAccounts: [],
      recentEntries: [], snapshotLimit: 0, snapshotTruncated: false,
    };
  }

  const [parties, salesAndInvoices, expenseSources, entrySources, inventoryCounts, members, quotes, deliveryNotes] = await Promise.all([
    service.listParties(),
    service.listSalesAndInvoices(),
    runner.all<any>("SELECT date,metadata FROM v2_sources WHERE book_id=? AND type='expense' AND date>=? AND date<=? ORDER BY date DESC", [context.bookId, from, to]),
    runner.all<any>(
      `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
       FROM v2_sources s
       LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId')
       WHERE s.book_id=?
       ORDER BY s.date DESC,s.id DESC
       LIMIT 300`,
      [context.bookId],
    ),
    runner.all<any>("SELECT id,date,value FROM v2_inventory_counts WHERE book_id=? AND period_id=? ORDER BY date DESC,id DESC", [context.bookId, context.periodId]),
    runner.all<any>("SELECT id,name FROM v2_members WHERE book_id=? ORDER BY name", [context.bookId]),
    db.listQuotes().catch(() => []),
    db.listDeliveryNotes().catch(() => []),
  ]);
  const expensesByCategory: Record<string, number> = {};
  for (const row of expenseSources) {
    let meta: any = {}; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (!meta.reversed && !meta.deleted) expensesByCategory.General = (expensesByCategory.General || 0) + Number(meta.total || 0);
  }
  const recentEntries: any[] = entrySources.flatMap((row: any) => {
    let meta: any = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (meta.reversed || meta.deleted) return [];
    const entity = row.type === 'cash_purchase' || row.type === 'credit_purchase' ? 'bill'
      : row.type === 'cash_sale' ? 'sale'
      : row.type === 'capital_injection' ? 'capital'
      : row.type === 'credit_note' || row.type === 'debit_note' ? 'note'
      : row.type === 'manual_cash_income' || row.type === 'manual_cash_expense' ? 'cash_entry'
      : row.type;
    return [{
      id: row.id, entity, sourceType: row.type, date: row.date, reference: row.reference || '',
      amount: Number(meta.total ?? meta.amount ?? meta.value ?? 0), partyId: meta.partyId || '', memberId: meta.memberId || '',
      partyName: row.party_name || meta.clientName || meta.supplierName || meta.partnerName || meta.memberName || '',
      category: meta.category || '', paymentType: meta.paymentType || '', method: meta.method || '', notes: meta.notes || '',
      lines: Array.isArray(meta.lines) ? meta.lines.slice(0, 20) : undefined,
    }];
  });
  recentEntries.push(
    ...inventoryCounts.map((row: any) => ({ id: row.id, entity: 'inventory_count', sourceType: 'inventory_count', date: row.date, amount: Number(row.value) })),
    ...quotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'quote', sourceType: 'quote', date: row.date, reference: row.quoteNumber || '', amount: Number(row.total || 0), partyName: row.clientName || '', status: row.status, notes: row.notes || '', lines: Array.isArray(row.lines) ? row.lines.slice(0, 20) : [] })),
    ...deliveryNotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'delivery_note', sourceType: 'delivery_note', date: row.date, reference: row.noteNumber || '', partyName: row.clientName || '', status: row.status, notes: row.notes || '', items: Array.isArray(row.items) ? row.items.slice(0, 20) : [] })),
  );
  recentEntries.sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
  const visibleEntries = recentEntries.slice(0, 300);
  return {
    source: 'v2', currency: settings.currency, businessName: settings.businessName,
    snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
    yearToDate: reports.profitAndLoss,
    creditors: parties.filter((p: any) => p.roles.includes('supplier') && p.payable !== 0).sort((a: any, b: any) => b.payable - a.payable).slice(0, 20).map((p: any) => ({ name: p.name, owed: p.payable })),
    debtors: parties.filter((p: any) => p.roles.includes('customer') && p.receivable !== 0).sort((a: any, b: any) => b.receivable - a.receivable).slice(0, 20).map((p: any) => ({ name: p.name, owes: p.receivable })),
    expensesByCategory,
    openInvoices: salesAndInvoices.filter((item: any) => item.type === 'invoice' && item.status !== 'paid').slice(0, 50).map((item: any) => ({ id: item.id, number: item.reference || item.id, client: item.clientName, amount: item.openAmount ?? item.amount })),
    parties: parties.map((party: any) => ({ id: party.id, name: party.name, roles: party.roles, receivable: party.receivable, payable: party.payable })),
    capitalAccounts: members.map((member: any) => ({ id: member.id, name: member.name })),
    recentEntries: visibleEntries, snapshotLimit: 300, snapshotTruncated: recentEntries.length > visibleEntries.length,
  };
}

/** Settings store preferences only. Accounting state and configuration live in V2. */
async function assertRequestedFeaturesAllowed(runner: NonNullable<ReturnType<typeof activeSqlRunner>>, bookId: string, nextFeatures: readonly FeatureKey[]): Promise<void> {
  const scoped = await readV2BookPrefs(runner, bookId);
  const currentSettings = await preferenceSettings();
  const previous = (scoped?.enabledFeatures || getEnabledFeatures(currentSettings)) as FeatureKey[];
  await assertFeatureDisableAllowed(runner, bookId, previous, nextFeatures);
}

async function preferenceSettings() {
  const settings = await db.getSettings();
  const runner = activeSqlRunner();
  if (!runner) return settings;
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) return settings;
  const config = await new V2BookConfigRepository(runner).getBookConfig(context.bookId);
  return {
    ...settings,
    accountingStyle: config.style,
    accountingBasis: config.basis,
    selectedPersonas: config.selectedPersonas,
    activePersona: config.activePersona,
    managerCommissionPct: config.retailPartnership?.commissionPct ?? settings.managerCommissionPct ?? 0,
  };
}
type AppCreateName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
async function resolvedSharedLocation(runner: NonNullable<ReturnType<typeof activeSqlRunner>>, input: any, date?: string): Promise<any> {
  const service = new V2AppService(runner);
  const context = await service.activeContext(date || input?.date);
  if (!context) return { ...input };
  const locationId = await resolveWriteLocationId(runner, context.bookId, input?.locationId);
  const withoutLocation = { ...(input || {}) };
  delete withoutLocation.locationId;
  return { ...withoutLocation, ...(locationId ? { locationId } : {}) };
}

async function createTransaction(name: AppCreateName, payload: any) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const writes = createAppWriteRouter(service);

  const injected = await resolvedSharedLocation(runner, payload, payload?.date);
  const partyId = name === 'createBill' || name === 'createPayment'
    ? injected.supplierId
    : name === 'createInvoice' || name === 'createReceipt'
      ? (injected.partyId || injected.debtorId)
      : null;
  if (partyId && !injected.supplierName && !injected.clientName) {
    const party = (await service.listParties()).find((item: any) => item.id === partyId);
    if (party) {
      if (name === 'createBill' || name === 'createPayment') injected.supplierName = party.name;
      else injected.clientName = party.name;
    }
  }

  const mutation: SyncMutation = {
    commandType: 'transaction.create', aggregateType: 'source', aggregateId: String(injected.id || `${name}:${Date.now()}`),
    payload: { name, input: injected }, businessDate: injected.date, operationIdentity: !injected.id,
  };
  const result = await withSyncedMutation(runner, mutation, () => writes[name](injected));
  bumpDataVersion();
  return result;
}

type AppMutationName = 'updateReceipt'|'deleteReceipt'|'markInvoicePaid'|'updateInvoice'|'deleteInvoice'|'updateExpense'|'deleteExpense'|'updatePayment'|'deletePayment'|'updateSale'|'deleteSale'|'updateBill'|'deleteBill'|'updateNote'|'deleteNote';
async function mutateTransaction(name: AppMutationName, ...args: any[]) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  if (name === 'updateInvoice' && args[1]?.status != null && args[1]?.total == null && args[1]?.amount == null) {
    const result = await (createAppMutationRouter(new V2AppService(runner)) as any)[name](...args);
    bumpDataVersion();
    return result;
  }
  let mutationArgs = args;
  if (name.startsWith('update')) {
    const row = await runner.first<any>('SELECT book_id,type,date,location_id,metadata FROM v2_sources WHERE id=?', [args[0]]);
    if (!row) throw new Error('Accounting source not found');
    let prior: any = {};
    try { prior = JSON.parse(String(row.metadata || '{}')); } catch { prior = {}; }
    const supplied = args[1] || {};
    const suppliedWithoutLocation = { ...supplied };
    delete suppliedWithoutLocation.locationId;
    const requestedLocation = supplied.locationId ?? prior.locationId ?? row.location_id;
    const resolvedLocation = await resolveWriteLocationId(runner, String(row.book_id), requestedLocation);
    mutationArgs = [args[0], {
      ...suppliedWithoutLocation,
      date: supplied.date ?? row.date,
      ...(supplied.productLines == null && Array.isArray(prior.productLines) ? { productLines: prior.productLines } : {}),
      ...(supplied.partyId == null && supplied.debtorId == null && prior.partyId != null ? { partyId: prior.partyId, debtorId: prior.partyId } : {}),
      ...(supplied.method == null && prior.method != null ? { method: prior.method } : {}),
      ...(supplied.paymentType == null && prior.paymentType != null ? { paymentType: prior.paymentType } : {}),
      ...(supplied.isExpense == null && prior.isExpense != null ? { isExpense: prior.isExpense } : {}),
      ...(supplied.billType == null && prior.billType != null ? { billType: prior.billType } : {}),
      ...(resolvedLocation ? { locationId: resolvedLocation } : {}),
      ...(name === 'updateNote' ? { amount: supplied.amount ?? prior.total, role: prior.role === 'supplier' ? 'supplier' : 'customer', noteType: row.type } : {}),
    }];
  }
  const r = await withSyncedMutation(runner, {
    commandType: 'transaction.mutate', aggregateType: 'source', aggregateId: String(args[0] || name),
    payload: { name, args: mutationArgs }, businessDate: mutationArgs[1]?.date,
  }, () => (createAppMutationRouter(new V2AppService(runner)) as any)[name](...mutationArgs));
  bumpDataVersion();
  return r;
}

/**
 * [Finding A] Create a credit/debit note. The customer screen sends {customerId}
 * and the supplier screen sends {supplierId}. We map those fields to a canonical
 * shape and route the note through the V2 write
 * path so it hits the journal + party balance and is visible on party detail /
 * statements. Active V2 books have one write path and no compatibility mirror.
 */
async function createNote(name: 'createCreditNote'|'createDebitNote', raw: any) {
  const isSupplier = raw.supplierId != null || raw.role === 'supplier';
  const partyId = raw.debtorId || raw.customerId || raw.supplierId || raw.partyId;
  const partyName = raw.clientName || raw.customerName || raw.supplierName || raw.partyName || '';
  let mapped = {
    ...raw,
    debtorId: partyId,
    partyId,
    role: isSupplier ? 'supplier' : 'customer',
    clientName: isSupplier ? raw.clientName : partyName,
    supplierName: isSupplier ? partyName : raw.supplierName,
  };
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const v2 = new V2AppService(runner);
  mapped = await resolvedSharedLocation(runner, mapped, mapped.date);
  const v2Res = await withSyncedMutation(runner, {
    commandType: 'transaction.create', aggregateType: 'source', aggregateId: String(mapped.id || `${name}:${Date.now()}`),
    payload: { name, input: mapped }, businessDate: mapped.date, operationIdentity: !mapped.id,
  }, () => name === 'createCreditNote' ? v2.createCreditNote(mapped) : v2.createDebitNote(mapped));
  bumpDataVersion();
  const total = Number(v2Res.source?.metadata?.total ?? mapped.amount);
  return { ...v2Res, id: v2Res.source?.id, noteNumber: v2Res.source?.reference || v2Res.source?.id, amount: total };
}

/** Apply canonical remote operations directly to the domain service. This path
 * deliberately bypasses the API wrappers so replay never creates a second
 * outbox item. Unsupported commands remain visible as conflicts. */
async function applyRemoteSyncOperation(dbRunner: NonNullable<ReturnType<typeof activeSqlRunner>>, operation: SyncOperation): Promise<void> {
  const service = new V2AppService(dbRunner);
  const body: any = operation.payload;
  if (operation.commandType === 'accounting.correction.post') {
    const posting = body?.posting; const date = String(posting?.date || operation.businessDate || '');
    const context = await service.activeContext(date); if (!context) throw new Error('Correction date is outside an open accounting period');
    const repo = new V2SqlRepository(dbRunner);
    await repo.postSourceJournal({ id: operation.opId, bookId: context.bookId, type: 'accounting_correction', date, metadata: { reason: body.reason, conflictId: body.conflictId, correctsOperationId: body.correctsOperationId, correctsSourceId: body.correctsSourceId } }, { bookId: context.bookId, periodId: context.periodId, date, memo: String(posting.memo || body.reason), lines: posting.lines });
    return;
  }
  if (operation.commandType === 'accounting.correction.reverse') {
    const sourceId = String(body?.sourceId || body?.originalSourceId || '');
    const source = await dbRunner.first<{ type: string }>('SELECT type FROM v2_sources WHERE id=?', [sourceId]);
    if (!source) throw new Error('Correction reversal source is unavailable');
    await new V2DocumentService(new V2SqlRepository(dbRunner)).reverseSource(sourceId, source.type, String(body.reason || 'Audited correction reversal'));
    return;
  }
  if (operation.commandType === 'transaction.create' && body?.name && body?.input) {
    const writes = createAppWriteRouter(service) as any;
    if (body.name === 'createCreditNote' || body.name === 'createDebitNote') {
      if (body.name === 'createCreditNote') await service.createCreditNote(body.input);
      else await service.createDebitNote(body.input);
    } else if (typeof writes[body.name] === 'function') await writes[body.name](body.input);
    else throw new Error(`Unsupported remote create command: ${String(body.name)}`);
    return;
  }
  if (operation.commandType === 'transaction.mutate' && body?.name && Array.isArray(body.args)) {
    const mutations = createAppMutationRouter(service) as any;
    if (typeof mutations[body.name] !== 'function') throw new Error(`Unsupported remote mutation command: ${String(body.name)}`);
    await mutations[body.name](...body.args);
    return;
  }
  const direct: Record<string, (value: any) => Promise<unknown>> = {
    'party.create': async (value) => {
      const roles = Array.isArray(value.roles) && value.roles.length ? value.roles : ['customer'];
      let result: unknown;
      for (const role of roles) result = await service.ensureParty(String(value.name), role === 'supplier' ? 'supplier' : 'customer', { phone: value.phone, email: value.email });
      return result;
    },
    'party.patch': (value) => service.updateParty(String(value.id), value.patch || {}),
    'party.archive': (value) => service.archiveParty(String(value.id)),
    'cash.create': (value) => service.recordManualCash(value),
    'cash.patch': (value) => service.updateManualCash(String(value.id), value.input || {}),
    'cash.delete': (value) => service.deleteManualCash(String(value.id)),
    'location.create': (value) => service.createLocation(value),
    'location.rename': (value) => service.renameLocation(String(value.id), String(value.name || '')),
    'location.archive': (value) => service.archiveLocation(String(value.id)),
    'location.reopen': (value) => service.reopenLocation(String(value.id)),
    'location.transfer_cash': (value) => service.transferLocationCash(value),
    'location.transfer_stock': (value) => service.transferLocationStock(value),
    'product.upsert': (value) => service.upsertProduct(value),
    'product.archive': (value) => service.archiveProduct(String(value.id)),
    'product.adjust_qty': (value) => service.adjustProductQty(value),
    'employee.upsert': (value) => service.upsertEmployee(value),
    'employee.archive': (value) => service.archiveEmployee(String(value.id)),
    'payroll.run': (value) => service.runPayroll(value),
    'capital.deposit': (value) => new V2InvestorLedgerService(dbRunner).deposit({ ...(value.input || {}), bookId: String((value.input || {}).bookId || ''), memberId: String(value.memberId) }),
    'capital.draw': (value) => new V2InvestorLedgerService(dbRunner).draw({ ...(value.input || {}), bookId: String((value.input || {}).bookId || ''), memberId: String(value.memberId) }),
    'capital.patch': (value) => new V2InvestorLedgerService(dbRunner).updateDeposit(String(value.sourceId), { ...(value.input || {}), bookId: String((value.input || {}).bookId || ''), memberId: String(value.memberId) }),
    'capital.delete': (value) => new V2InvestorLedgerService(dbRunner).deleteDeposit(String(value.sourceId), String((value.input || {}).bookId || ''), String(value.memberId)),
    'opening_balances.post': (value) => service.postOpeningBalances(value),
    'opening_balances.update': (value) => service.updateOpeningBalances(value),
    'closing_balances.import': (value) => service.importClosingBalances(value),
    'period.close': (value) => createCloseBooksRouter(service)(value),
    'scan.transaction.import': (value) => service.importScanTransaction(value),
    'inventory.count.record': (value) => service.recordInventoryCount(value),
    'manual.asset.create': (value) => service.recordManualAsset(value),
    'manual.liability.create': (value) => service.recordManualLiability(value),
    'manual.balance.delete': (value) => service.deleteManualBalanceTransaction(String(value.sourceId)),
    'manual.balance.update': (value) => service.updateManualBalanceTransaction(String(value.sourceId), value.input || {}),
    'inventory.count.delete': (value) => service.deleteV2InventoryCount(String(value.id)),
    'book.config.patch': async (value) => {
      const context = await service.activeContext(); if (!context) throw new Error('No active versioned V2 book');
      if (value.activePersona) return new V2BookConfigRepository(dbRunner).setActivePersona(context.bookId, value.activePersona);
      let applied = false;
      if (value.config) { await service.updateActiveBookConfig(value.config); applied = true; }
      if (Array.isArray(value.enabledFeatures)) { await writeV2BookPrefs(dbRunner, context.bookId, { enabledFeatures: value.enabledFeatures }); applied = true; }
      if (!applied) throw new Error('Unsupported book configuration patch');
    },
  };
  const handler = direct[operation.commandType];
  if (handler) { await handler(body); return; }
  throw new Error(`Unsupported remote sync command: ${operation.commandType}`);
}

/**
 * The ONE computation of an investor's live ledger detail: the V2
 * journal-derived detail. Both the investor detail screen (api.getInvestorLedger) and the
 * Parties list tile (api.listInvestors) MUST read the balance from here so the
 * two surfaces can never disagree after a deposit/draw.
 */
async function mergedInvestorLedgerDetail(id: string): Promise<InvestorLedgerDetail> {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const app = new V2AppService(runner);
  const context = await app.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  return new V2InvestorLedgerService(runner).detail(context.bookId, id);
}

/** Read source documents from the authoritative ledger in screen-friendly form. */
async function v2SourceDocuments(types: string[]) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  const placeholders = types.map(() => '?').join(',');
  const rows = await runner.all<any>(
    `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
     FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId')
     WHERE s.book_id=? AND s.type IN (${placeholders}) ORDER BY s.date DESC,s.id DESC`,
    [context.bookId, ...types],
  );
  return rows.flatMap((row: any) => {
    let metadata: any = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (metadata.deleted || metadata.reversed) return [];
    return [{
      ...metadata,
      id: row.id,
      type: row.type,
      date: row.date,
      reference: row.reference || '',
      amount: Number(metadata.total || 0),
      total: Number(metadata.total || 0),
      tax: Number(metadata.tax || 0),
      taxRate: Number(metadata.taxRate || 0),
      subtotal: Number(metadata.subtotal ?? (metadata.total ? Number(metadata.total) - Number(metadata.tax || 0) : 0)),
      partyId: metadata.partyId || null,
      partyName: row.party_name || '',
      clientName: row.party_name || '',
      supplierName: row.party_name || '',
      metadata,
    }];
  });
}

async function v2Report(from?: string, to?: string, locationId?: string) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const context = await new V2AppService(runner).activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  return buildPersistentV2Reports(runner, { bookId: context.bookId, from, to, locationId });
}

async function liveCommissionPct() {
  const config = await api.getV2BookConfig().catch(() => null);
  const settings: any = await api.getSettings().catch(() => ({}));
  return Number(config?.retailPartnership?.commissionPct ?? settings?.managerCommissionPct ?? 0);
}

export const api = {
  // Persistent V2 runtime services are available after storage initialization.
  v2: () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return v2Services();
  },
  initializeV2Book: async (options: Parameters<typeof initializeV2Book>[1]) => {
    const runner = activeSqlRunner();
    if (!runner) {
      return { bookId: options.book.id, periodId: options.period.id || `${options.book.id}:period`, version: 1 };
    }
    const result = await initializeV2Book(runner, options);
    await preferenceSettings();
    return result;
  },
  v2BookVersion: async (bookId: string) => {
    const runner = activeSqlRunner();
    return runner ? accountingBookVersion(runner, bookId) : null;
  },
  v2Personas: async (bookId: string, includeDisabled = true) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2BookConfigRepository(runner).listPersonas(bookId, includeDisabled);
  },
  setV2Persona: async (bookId: string, type: PersonaId) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const currentSettings = await preferenceSettings();
    const nextFeatures = getEnabledFeatures({ ...currentSettings, activePersona: type });
    await assertRequestedFeaturesAllowed(runner, bookId, nextFeatures);
    const r = await withSyncedMutation(runner, { commandType: 'book.config.patch', aggregateType: 'book', aggregateId: bookId, payload: { activePersona: type } }, () => new V2BookConfigRepository(runner).setActivePersona(bookId, type));
    bumpDataVersion();
    return r;
  },
  getV2BookConfig: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).getActiveBookConfig();
  },
  updateV2BookConfig: async (config: V2BookConfigUpdate) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const context = await service.activeContext();
    if (!context) throw new Error('No active versioned V2 book');
    const nextFeatures = getEnabledFeatures({ ...(await preferenceSettings()), selectedPersonas: config.selectedPersonas, activePersona: config.activePersona });
    await assertRequestedFeaturesAllowed(runner, context.bookId, nextFeatures);
    const r = await withSyncedMutation(runner, { commandType: 'book.config.patch', aggregateType: 'book', aggregateId: context.bookId, payload: { config } }, () => service.updateActiveBookConfig(config));
    bumpDataVersion();
    return r;
  },
  getV2OpeningBalances: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).getOpeningBalances();
  },
  getV2ActivePeriod: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).getActivePeriod();
  },
  postV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = { ...input, date: input.date || localTodayIso() };
    const r = await withSyncedMutation(runner, {
      commandType: 'opening_balances.post', aggregateType: 'opening_balance', aggregateId: `opening:${beActiveBookId()}`,
      payload: resolved, businessDate: resolved.date,
    }, () => new V2AppService(runner).postOpeningBalances(resolved));
    bumpDataVersion();
    return r;
  },
  updateV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = { ...input, date: input.date || localTodayIso() };
    const r = await withSyncedMutation(runner, {
      commandType: 'opening_balances.update', aggregateType: 'opening_balance', aggregateId: `opening:${beActiveBookId()}`,
      payload: resolved, businessDate: resolved.date,
    }, () => new V2AppService(runner).updateOpeningBalances(resolved));
    bumpDataVersion();
    return r;
  },
  importV2ClosingBalances: async (input: V2ClosingBalancesImportInput) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = { ...input, date: input.date || localTodayIso() };
    const r = await withSyncedMutation(runner, {
      commandType: 'closing_balances.import', aggregateType: 'closing_balance', aggregateId: `closing:${resolved.date}`,
      payload: resolved, businessDate: resolved.date,
    }, () => new V2AppService(runner).importClosingBalances(resolved));
    bumpDataVersion();
    return r;
  },
  preflightV2ScanParties: async (requests: V2ScanPartyRequest[]) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).preflightScanParties(requests);
  },
  importV2ScanTransaction: async (input: V2ScanTransactionImportInput) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = await resolvedSharedLocation(runner, input, input.date);
    const r = await withSyncedMutation(runner, {
      commandType: 'scan.transaction.import', aggregateType: 'scan_transaction',
      aggregateId: `scan:${resolved.entryType}:${resolved.date}:${resolved.partyName || ''}:${resolved.amount}:${resolved.method || ''}`,
      payload: resolved, businessDate: resolved.date, operationIdentity: true,
    }, () => new V2AppService(runner).importScanTransaction(resolved));
    bumpDataVersion();
    return r;
  },
  recordV2InventoryCount: async (input: { date: string; value: number; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = await resolvedSharedLocation(runner, input, input.date);
    const r = await withSyncedMutation(runner, {
      commandType: 'inventory.count.record', aggregateType: 'inventory_count',
      aggregateId: `inventory:${resolved.date}:${resolved.locationId || 'global'}`, payload: resolved, businessDate: resolved.date,
    }, () => new V2AppService(runner).recordInventoryCount(resolved));
    bumpDataVersion();
    return r;
  },
  createManualAsset: async (input: { date: string; name: string; category?: string; amount: number; funding: 'cash' | 'bank' | 'capital' | 'liability'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual asset transactions require SQLite storage');
    const r = await withSyncedMutation(runner, {
      commandType: 'manual.asset.create', aggregateType: 'manual_asset', aggregateId: `manual-asset:${input.date}:${input.name}:${input.amount}`,
      payload: input, businessDate: input.date, operationIdentity: true,
    }, () => new V2AppService(runner).recordManualAsset(input));
    bumpDataVersion();
    return r;
  },
  createManualLiability: async (input: { date: string; name: string; category?: string; amount: number; recognition: 'cash' | 'bank' | 'asset' | 'expense' | 'creditor'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual liability transactions require SQLite storage');
    const r = await withSyncedMutation(runner, {
      commandType: 'manual.liability.create', aggregateType: 'manual_liability', aggregateId: `manual-liability:${input.date}:${input.name}:${input.amount}`,
      payload: input, businessDate: input.date, operationIdentity: true,
    }, () => new V2AppService(runner).recordManualLiability(input));
    bumpDataVersion();
    return r;
  },
  listManualBalanceTransactions: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return new V2AppService(runner).listManualBalanceTransactions();
  },
  deleteManualBalanceTransaction: async (sourceId: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual balance transactions require SQLite storage');
    const r = await withSyncedMutation(runner, {
      commandType: 'manual.balance.delete', aggregateType: 'source', aggregateId: sourceId, payload: { sourceId },
    }, () => new V2AppService(runner).deleteManualBalanceTransaction(sourceId));
    bumpDataVersion();
    return r;
  },
  updateManualBalanceTransaction: async (sourceId: string, input: any) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual balance transactions require SQLite storage');
    const existing = await runner.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [sourceId]);
    let prior: any = {};
    try { prior = JSON.parse(existing?.metadata || '{}'); } catch { prior = {}; }
    const resolved = { ...prior, ...input };
    const r = await withSyncedMutation(runner, {
      commandType: 'manual.balance.update', aggregateType: 'source', aggregateId: sourceId,
      payload: { sourceId, input: resolved }, businessDate: resolved.date,
    }, () => new V2AppService(runner).updateManualBalanceTransaction(sourceId, input));
    bumpDataVersion();
    return r;
  },
  getSettings: () => preferenceSettings(),
  updateSettings: async (s: any) => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const context = await service.activeContext();
      if (context) {
        const repo = new V2BookConfigRepository(runner);
        const personaRow = await runner.first<{ id: string; config: string }>('SELECT id,config FROM v2_personas WHERE book_id=? AND enabled=1 AND active=1 LIMIT 1', [context.bookId]);
        const personaPrefsChanged = Array.isArray(s.enabledFeatures) || Array.isArray(s.enabledCapabilities) || s.activeLocationId !== undefined;
        if (personaRow && personaPrefsChanged) {
          let personaConfig: any = {}; try { personaConfig = JSON.parse(personaRow.config || '{}'); } catch { personaConfig = {}; }
          if (Array.isArray(s.enabledFeatures)) personaConfig.enabledFeatures = [...new Set(s.enabledFeatures.map(String))];
          if (Array.isArray(s.enabledCapabilities)) personaConfig.enabledCapabilities = [...new Set(s.enabledCapabilities.map(String))];
          if (s.activeLocationId !== undefined) personaConfig.activeLocationId = s.activeLocationId ? String(s.activeLocationId) : '';
          const nextFeatures = Array.isArray(s.enabledFeatures)
            ? s.enabledFeatures as FeatureKey[]
            : getEnabledFeatures({ ...(await preferenceSettings()), enabledCapabilities: s.enabledCapabilities });
          await assertRequestedFeaturesAllowed(runner, context.bookId, nextFeatures);
          await withSyncedMutation(runner, {
            commandType: 'book.config.patch', aggregateType: 'book', aggregateId: context.bookId,
            payload: { ...(Array.isArray(s.enabledFeatures) ? { enabledFeatures: s.enabledFeatures } : {}), ...(Array.isArray(s.enabledCapabilities) ? { enabledCapabilities: s.enabledCapabilities } : {}), ...(s.activeLocationId !== undefined ? { activeLocationId: s.activeLocationId } : {}) },
          }, async () => {
            await runner.run('UPDATE v2_personas SET config=? WHERE id=? AND book_id=?', [JSON.stringify(personaConfig), personaRow.id, context.bookId]);
            if (Array.isArray(s.enabledFeatures)) await writeV2BookPrefs(runner, context.bookId, { enabledFeatures: s.enabledFeatures.map(String) });
            if (s.activeLocationId !== undefined) await writeV2BookPrefs(runner, context.bookId, { activeLocationId: String(s.activeLocationId || '') });
          });
        }
        if (Array.isArray(s.selectedPersonas) || s.activePersona !== undefined || s.businessType !== undefined) {
          const current = await repo.getBookConfig(context.bookId);
          const requestedPersonas = Array.isArray(s.selectedPersonas) && s.selectedPersonas.length ? s.selectedPersonas : (s.businessType ? [s.businessType] : current.selectedPersonas);
          const nextActivePersona = s.activePersona || s.businessType || current.activePersona;
          const update: V2BookConfigUpdate = { style: current.style, basis: current.basis, selectedPersonas: [...new Set(requestedPersonas.map(String))] as PersonaId[], activePersona: String(nextActivePersona) as PersonaId, retailPartnership: current.retailPartnership };
          const nextFeatures = getEnabledFeatures({ ...(await preferenceSettings()), selectedPersonas: update.selectedPersonas, activePersona: update.activePersona });
          await assertRequestedFeaturesAllowed(runner, context.bookId, nextFeatures);
          await withSyncedMutation(runner, { commandType: 'book.config.patch', aggregateType: 'book', aggregateId: context.bookId, payload: { config: update } }, () => repo.updateBookConfig(context.bookId, update));
        }
        if (s.managerCommissionPct !== undefined) {
          const config = await repo.getBookConfig(context.bookId);
          const update: V2BookConfigUpdate = { style: config.style, basis: config.basis, selectedPersonas: config.selectedPersonas, activePersona: config.activePersona, retailPartnership: { ...config.retailPartnership, commissionPct: Number(s.managerCommissionPct || 0) } };
          await withSyncedMutation(runner, { commandType: 'book.config.patch', aggregateType: 'book', aggregateId: context.bookId, payload: { config: update } }, () => repo.updateBookConfig(context.bookId, update));
        }
      }
    }
    const r = await db.updateSettings(s);
    const preferences = await preferenceSettings();
    bumpDataVersion();
    return { ...r, ...preferences };
  },
  migrateToPrivateSync: async (input: { serverUrl: string; userId: string; accessToken?: string; oidcIssuer?: string; oidcClientId?: string; oidcScopes?: string }) => {
    const prerequisites = await api.getPrivateSyncPrerequisites();
    if (!prerequisites.integrity.ok) throw new Error(`Complete the local integrity check first: ${prerequisites.integrity.issues.join(' ')}`);
    if (!prerequisites.hasRecentEncryptedBackup) throw new Error('Create and verify an encrypted backup within the last 30 days before migrating this book.');
    const before = await api.getSyncStatus();
    await api.configureSync({ ...input, enabled: false });
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const enrolled = await enrollSyncDevice(runner, beActiveBookId());
    const after = await api.getSyncStatus();
    return { enrolled, before, after, preservedPending: Number(before.pending || 0) + Number(before.retryable || 0), stage: after.bootstrapRequired ? 'publish_initial_snapshot' : after.recoveryRequired ? 'install_validated_snapshot' : 'ready_for_sync' as const };
  },
  leavePrivateSync: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await disableSync(runner, beActiveBookId());
    await setRequestedHostingMode('local_only');
    bumpDataVersion();
  },
  configureSync: async (input: { serverUrl: string; userId: string; actorId?: string; accessToken?: string; enabled?: boolean; oidcIssuer?: string; oidcClientId?: string; oidcScopes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await setRequestedHostingMode('private_sync');
    const profile = await configureSync(runner, { ...input, bookId: beActiveBookId() });
    bumpDataVersion();
    return profile;
  },
  authorizeSyncOidc: async (input: { serverUrl: string; userId: string; actorId?: string; oidcIssuer: string; oidcClientId: string; oidcScopes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const profile = await configureSync(runner, { ...input, bookId: beActiveBookId(), enabled: false });
    await runSyncOidcAuthorization(profile);
    await setRequestedHostingMode('private_sync');
    bumpDataVersion();
    return profile;
  },
  authorizeAndRedeemSyncEnrollmentCode: async (input: { serverUrl: string; userId: string; code: string; displayName?: string; platform?: string; actorId?: string; oidcIssuer: string; oidcClientId: string; oidcScopes?: string }) => {
    const prerequisites = await api.getPrivateSyncPrerequisites();
    if (!prerequisites.integrity.ok) throw new Error(`Complete the local integrity check first: ${prerequisites.integrity.issues.join(' ')}`);
    if (!prerequisites.hasRecentEncryptedBackup) throw new Error('Create and verify an encrypted backup within the last 30 days before joining private sync.');
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const bookId = beActiveBookId();
    const profile = await configureSync(runner, { serverUrl: input.serverUrl, userId: input.userId, actorId: input.actorId, oidcIssuer: input.oidcIssuer, oidcClientId: input.oidcClientId, oidcScopes: input.oidcScopes, bookId, enabled: false });
    await runSyncOidcAuthorization(profile);
    const enrolled = await redeemSyncEnrollmentCode(runner, bookId, input.code, input.displayName, input.platform);
    await setRequestedHostingMode('private_sync');
    bumpDataVersion();
    return enrolled;
  },
  disableSync: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await disableSync(runner, beActiveBookId());
    bumpDataVersion();
  },
  getHostingMode: () => getRequestedHostingMode(),
  setHostingMode: async (mode: HostingMode) => { await setRequestedHostingMode(mode); bumpDataVersion(); },
  checkLocalIntegrity,
  getPrivateSyncPrerequisites: async () => {
    const integrity = await checkLocalIntegrity();
    const history = await listBackupHistory();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentEncryptedBackup = history.find((item) => item.kind === 'encrypted_export' && item.verified && new Date(item.createdAt).getTime() >= cutoff);
    return { ok: integrity.ok && !!recentEncryptedBackup, integrity, hasRecentEncryptedBackup: !!recentEncryptedBackup, latestEncryptedBackup: recentEncryptedBackup || null };
  },

  // Multi-device sync transports. These sit beside the self-hosted server
  // rather than replacing it: cloud drive for a shop owner who cannot run a
  // server, Wi-Fi pairing for somewhere with no internet at all.
  getCloudSyncConfig: async (bookId = beActiveBookId()) => getCloudConfig(bookId),
  saveCloudSyncConfig: async (config: CloudDriveConfig, bookId = beActiveBookId()) => saveCloudConfig(bookId, config),
  adoptCloudSyncKey: async (passphrase: string, bookId = beActiveBookId()) => {
    const config = await getCloudConfig(bookId);
    if (!config) throw new Error('Set up cloud sync on this device first.');
    return adoptRemoteKey(bookId, passphrase, getStorageClient(config));
  },
  createWifiP2pSession: (bookId = beActiveBookId(), hostIp?: string, port?: number) => createWifiP2pSession(bookId, hostIp, port),
  exportWifiP2pPackage: async (key: Uint8Array, bookId = beActiveBookId()) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const projection = await exportBookProjection(runner, bookId);
    const snapshot: SyncSnapshot = {
      snapshotId: 'snap_' + Date.now(),
      bookId,
      bookEpoch: 'epoch_1',
      throughSequence: 0,
      schemaVersion: BOOK_PROJECTION_SCHEMA_VERSION,
      payload: projection,
      payloadHash: hashPayload(projection),
      checkpointHash: await hashBookProjection(runner, bookId),
      aggregateRevisions: {},
      createdAt: new Date().toISOString(),
    };
    return packWifiTransfer(snapshot, [], key);
  },
  installWifiP2pPackage: async (pkg: WifiP2pTransferPackage) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await installBookProjection(runner, pkg.snapshot.payload as any, pkg.snapshot);
    bumpDataVersion();
  },

  getSyncStatus: async () => {
    const runner = activeSqlRunner();
    if (!runner) return { enabled: false, configured: false, pending: 0, retryable: 0, conflicts: 0 };
    return getSyncStatus(runner, beActiveBookId());
  },
  getServerHealth: async (operationsToken: string) => {
    const local = await api.getSyncStatus();
    if (!local.serverUrl) throw new Error('Configure private sync before checking server health.');
    const response = await fetch(`${String(local.serverUrl).replace(/\/+$/u, '')}/v1/ops/health`, { headers: { authorization: `Bearer ${operationsToken.trim()}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.dependencies?.message || body?.message || `Server health request failed (${response.status})`));
    return { local, server: body };
  },
  syncNow: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const status = await syncNow(runner, beActiveBookId(), applyRemoteSyncOperation);
    bumpDataVersion();
    return status;
  },
  retrySyncNow: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const status = await retrySyncNow(runner, beActiveBookId(), applyRemoteSyncOperation);
    bumpDataVersion();
    return status;
  },
  publishSyncSnapshot: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    return publishServerSnapshot(runner, beActiveBookId(), async (dbRunner, bookId) => {
      const payload = await exportBookProjection(dbRunner, bookId);
      return { schemaVersion: BOOK_PROJECTION_SCHEMA_VERSION, payload, projectionHash: await hashBookProjection(dbRunner, bookId) };
    });
  },
  enableSync: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const prerequisites = await api.getPrivateSyncPrerequisites();
    if (!prerequisites.integrity.ok) throw new Error(`Complete the local integrity check before enabling private sync: ${prerequisites.integrity.issues.join(' ')}`);
    if (!prerequisites.hasRecentEncryptedBackup) throw new Error('Create and verify an encrypted backup within the last 30 days before enabling private sync.');
    await enableSync(runner, beActiveBookId());
    await setRequestedHostingMode('private_sync');
    return getSyncStatus(runner, beActiveBookId());
  },
  installSyncSnapshot: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    const snapshot = await installServerSnapshot(runner, beActiveBookId(), async (dbRunner, payload, candidate) => {
      await installBookProjection(dbRunner, payload, candidate);
      const installedHash = await hashBookProjection(dbRunner, candidate.bookId);
      if (candidate.projectionHash && installedHash !== candidate.projectionHash) throw new Error('Installed projection hash does not match the validated snapshot');
    }, applyRemoteSyncOperation);
    bumpDataVersion();
    return snapshot;
  },
  recordBackupAuditEvent: async (eventType: string, payload: Record<string, unknown> = {}) => {
    const runner = activeSqlRunner();
    if (!runner) return false;
    await runner.run('INSERT INTO v2_audit_events(id,book_id,event_type,actor,payload,created_at) VALUES(?,?,?,?,?,?)', [
      `backup:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`, beActiveBookId(), eventType, 'local-user', JSON.stringify(payload), new Date().toISOString(),
    ]);
    return true;
  },
  createSyncEnrollmentCode: async (role: 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor', locationIds: string[], ttlMinutes = 15) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    return createSyncEnrollmentCode(runner, beActiveBookId(), role, locationIds, ttlMinutes);
  },
  redeemSyncEnrollmentCode: async (code: string, displayName?: string, platform?: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    return redeemSyncEnrollmentCode(runner, beActiveBookId(), code, displayName, platform);
  },
  listSyncDevices: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return listSyncDevices(runner, beActiveBookId());
  },
  renameSyncDevice: async (deviceId: string, displayName: string, platform?: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await renameSyncDevice(runner, beActiveBookId(), deviceId, displayName, platform);
  },
  listSyncMemberships: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return listSyncMemberships(runner, beActiveBookId());
  },
  upsertSyncMembership: async (subject: string, role: 'owner' | 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor') => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    return upsertSyncMembership(runner, beActiveBookId(), subject, role);
  },
  removeSyncMembership: async (subject: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await removeSyncMembership(runner, beActiveBookId(), subject);
  },
  setSyncMembershipLocations: async (subject: string, locationIds: string[]) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await setSyncMembershipLocations(runner, beActiveBookId(), subject, locationIds);
  },
  revokeSyncDevice: async (deviceId: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await revokeSyncDevice(runner, beActiveBookId(), deviceId);
  },
  verifySyncCheckpoint: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    return verifyProjectionCheckpoint(runner, beActiveBookId(), hashBookProjection);
  },
  listSyncConflicts: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return listOpenSyncConflicts(runner, beActiveBookId());
  },
  listSyncCorrectionAccounts: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return listSyncCorrectionAccounts(runner, beActiveBookId());
  },
  resolveSyncConflict: async (conflictId: string, resolutionType: ConflictResolutionType = 'keep_canonical', payload?: unknown, correctionCommandType?: 'accounting.correction.post' | 'accounting.correction.reverse') => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Sync requires SQLite storage');
    await resolveSyncConflictDecision(runner, beActiveBookId(), conflictId, {
      type: resolutionType,
      ...(payload === undefined ? {} : { payload }),
      ...(correctionCommandType ? { correctionCommandType } : {}),
    });
    bumpDataVersion();
  },
  testKey: async (config?: AIConfig) => ai.testKey(config || await getAIConfig()),
  getAIConfig: async () => getAIConfig(),

  // Books (separate isolated accounts, e.g. Shop vs Technician)
  listBooks: (): Promise<BookMeta[]> => beListBooks(),
  activeBookId: (): string => beActiveBookId(),
  setActiveBook: async (id: string) => { const r = await beSetActiveBook(id); bumpDataVersion(); return r; },
  createBook: async (name: string, businessType?: string) => { const r = await beCreateBook(name, businessType); bumpDataVersion(); return r; },
  renameBook: async (id: string, name: string) => { const r = await beRenameBook(id, name); bumpDataVersion(); return r; },
  deleteBook: async (id: string) => {
    const runner = activeSqlRunner();
    if (runner) await markSyncRecoveryRequired(runner, id, 'Business Account deletion requires sync re-enrollment');
    const r = await beDeleteBook(id); bumpDataVersion(); return r;
  },

  // POS sessions keep register metadata locally, while cash settlement is posted to the authoritative V2 ledger.
  listPosSessions: async () => db.listPosSessions(),
  createPosSession: async (input: any) => { const r = await db.createPosSession(input); bumpDataVersion(); return r; },
  posSettlementPreview: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).posSettlementPreview(input);
  },
  createMarketplaceOrder: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createMarketplaceOrder(input); },
  recordMarketplaceRefund: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).recordMarketplaceRefund(input); },
  recordMarketplaceRto: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).recordMarketplaceRto(input); },
  createMarketplaceSettlement: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createMarketplaceSettlement(input); },
  listMarketplaceOrders: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listMarketplaceOrders(); },
  listMarketplaceSettlements: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listMarketplaceSettlements(); },
  reconcileMarketplaceSettlement: async (platform: string, settlementId: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).reconcileMarketplaceSettlement(platform, settlementId); },
  createProject: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createProject(input); },
  addProjectTime: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).addProjectTime(input); },
  recordProjectCost: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).recordProjectCost(input); },
  listProjects: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listProjects(); },
  createCreatorContract: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createCreatorContract(input); },
  recordCreatorPayout: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).recordCreatorPayout(input); },
  listCreatorContracts: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listCreatorContracts(); },
  createBom: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createBom(input); },
  addBomLine: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).addBomLine(input); },
  createProductionOrder: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createProductionOrder(input); },
  listBoms: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listBoms(); },
  listProductionOrders: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listProductionOrders(); },
  createTradeShipment: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createTradeShipment(input); },
  addTradeLandedCost: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).addTradeLandedCost(input); },
  recordFxRemeasurement: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).recordFxRemeasurement(input); },
  listTradeShipments: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listTradeShipments(); },
  listTradeCosts: async (shipmentId?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listTradeCosts(shipmentId); },
  createWorkflowDraft: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createWorkflowDraft(input); },
  submitWorkflow: (id: string, actor?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).submitWorkflow(id, actor); },
  approveWorkflow: (id: string, actor?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).approveWorkflow(id, actor); },
  rejectWorkflow: (id: string, actor?: string, reason?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).rejectWorkflow(id, actor, reason); },
  markWorkflowPosted: (id: string, sourceId?: string, actor?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).markWorkflowPosted(id, sourceId, actor); },
  markWorkflowFailed: (id: string, error: string, actor?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).markWorkflowFailed(id, error, actor); },
  getWorkflow: async (id: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).getWorkflow(id); },
  listWorkflows: async (status?: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listWorkflows(status); },
  listAuditEvents: async (workflowId?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listAuditEvents(workflowId); },
  enqueueSync: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).enqueueSync(input); },
  listPendingSync: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listPendingSync(); },
  upsertIntegration: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).upsertIntegration(input); },
  listIntegrations: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listIntegrations(); },
  configureSelfHostedSync: selfHostedSync.configure,
  disableSelfHostedSync: selfHostedSync.disable,
  getSelfHostedSyncState: selfHostedSync.getState,
  testSelfHostedSyncConnection: selfHostedSync.testConnection,
  pushSelfHostedSnapshot: selfHostedSync.push,
  pullSelfHostedSnapshot: selfHostedSync.pull,
  resolveSelfHostedConflict: selfHostedSync.resolveConflict,
  syncSelfHostedNow: selfHostedSync.syncNow,
  upsertTaxProfile: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).upsertTaxProfile(input); },
  listTaxProfiles: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listTaxProfiles(); },
  importBankFeedRows: (provider: string, rows: any[]) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).importBankFeedRows(provider, rows); },
  listBankFeedEntries: async (status?: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listBankFeedEntries(status); },
  createBudget: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createBudget(input); },
  addBudgetLine: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).addBudgetLine(input); },
  listBudgets: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listBudgets(); },
  budgetVariance: async (id: string) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).budgetVariance(id); },
  createRecurringTemplate: (input: any) => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).createRecurringTemplate(input); },
  listRecurringTemplates: async () => { const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(runner).listRecurringTemplates(); },
  settlePosSession: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const result = await new V2AppService(runner).settlePosSession(input);
    const updated = await db.updatePosSession(input.sessionId, { status: 'closed', closed_at: new Date().toISOString(), countedCash: result.countedCash, expectedCash: result.expectedCash, variance: result.variance, settlementSourceId: result.sourceId, settlementJournalId: result.journalId || null });
    bumpDataVersion();
    return { ...result, session: updated };
  },
  closePosSession: async (id: string) => { const r = await db.closePosSession(id); bumpDataVersion(); return r; },


  createParty: async (p: any) => {
    const name = (p.name || '').trim();
    if (!name) throw new Error('Business account name is required');
    if (isWebRuntime) {
      const roles: string[] = p.roles || (p.type === 'customer' ? ['customer'] : ['supplier']);
      const creator = roles.includes('supplier') && !roles.includes('customer') ? db.createSupplier : db.createDebtor;
      const result = await creator({ ...p, name });
      bumpDataVersion();
      return { ...result, roles };
    }
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const ctx = await service.activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    const roles: string[] = p.roles || (p.type === 'customer' ? ['customer'] : ['supplier']);
    const primaryRole = roles.includes('supplier') && !roles.includes('customer') ? 'supplier' : 'customer';
    const aggregateId = String(p.id || stablePartyId(primaryRole, { [primaryRole === 'customer' ? 'clientName' : 'supplierName']: name }, ctx.bookId));
    return withSyncedMutation(runner, { commandType: 'party.create', aggregateType: 'party', aggregateId, payload: { ...p, id: aggregateId, name, roles } }, async () => {
      const party = await service.ensureParty(name, primaryRole, { phone: p.phone, email: p.email });
      for (const r of roles) {
        if (r !== primaryRole && (r === 'customer' || r === 'supplier')) await service.ensureParty(name, r, { phone: p.phone, email: p.email });
      }
      const finalRoles = Array.isArray(party.roles) ? party.roles : JSON.parse(party.roles || '[]');
      return { id: party.id, name: party.name, phone: party.phone || p.phone, email: party.email || p.email, roles: finalRoles };
    });
  },

  findOrCreateParty: async (rawName: string, role: 'customer' | 'supplier' = 'customer', details?: { phone?: string; email?: string }) => {
    const name = (rawName || '').trim();
    if (!name) return null;
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    if (isWebRuntime) {
      const parties = await api.listParties();
      const existing = parties.find((party: any) => norm(party.name) === norm(name));
      if (existing && existing.roles.includes(role)) return { id: existing.id, name: existing.name, role: existing.roles.length > 1 ? 'both' : role };
      const created = await api.createParty({ name, type: role, roles: [role], ...(details || {}) });
      return { id: created.id, name: created.name, role };
    }

    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const context = await service.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    await service.assertPartyNameAvailable(name, context.bookId);
    const existing = (await service.listParties()).find((party: any) => norm(party.name) === norm(name));
    const aggregateId = existing?.id || stablePartyId(role, { [role === 'customer' ? 'clientName' : 'supplierName']: name }, context.bookId);
    const party = existing && (Array.isArray(existing.roles) ? existing.roles : JSON.parse(existing.roles || '[]')).includes(role)
      ? existing
      : await withSyncedMutation(runner, { commandType: 'party.create', aggregateType: 'party', aggregateId, payload: { id: aggregateId, name, roles: [role], ...details } }, () => service.ensureParty(name, role, details));
    const roles: string[] = Array.isArray(party.roles) ? party.roles : JSON.parse(party.roles || '[]');
    return { id: party.id, name: party.name, role: roles.length > 1 ? 'both' : role };
  },

  searchParties: async (query: string) => {
    const q = (query || '').trim().toLowerCase();
    if (isWebRuntime) return (await api.listParties()).filter((party: any) => !q || party.name.toLowerCase().includes(q)).map((party: any) => ({ id: party.id, name: party.name, phone: party.phone || '', role: party.roles.length > 1 ? 'both' : party.roles[0] }));
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
    const parties = await service.listParties();
    return parties
      .filter((party: any) => !q || party.name.toLowerCase().includes(q))
      .map((party: any) => ({ id: party.id, name: party.name, phone: party.phone || '', role: party.roles.length > 1 ? 'both' : party.roles[0] }));
  },

  listParties: async (locationId?: string) => {
    if (isWebRuntime) {
      const [suppliers, customers] = await Promise.all([db.listSuppliers(), db.listDebtors()]);
      return [
        ...suppliers.map((party: any) => ({ ...party, roles: ['supplier'], role: 'supplier' })),
        ...customers.map((party: any) => ({ ...party, roles: ['customer'], role: 'customer' })),
      ];
    }
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
    return service.listParties(locationId);
  },
  listInvestors: async (): Promise<{ id: string; name: string; openingCapital: number; currentCapital: number; profitSharePct: number }[]> => {
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext();
      if (context) {
        const rows = await runner.all<any>('SELECT id,name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY name', [context.bookId]);
        if (rows.length) {
          // v2_members.current_capital is the PERIOD-OPENING capital snapshot;
          // the live balance is journal-derived. Compute it via the SAME
          // merged-ledger path the investor detail screen uses so the Parties
          // tile always shows Opening + injections + profit share − drawings.
          return Promise.all(rows.map(async (row) => {
            let currentCapital = Number(row.current_capital);
            try { currentCapital = (await mergedInvestorLedgerDetail(row.id)).currentCapitalBalance; }
            catch { /* keep the period-opening snapshot if the detail is unavailable */ }
            return { id: row.id, name: row.name, openingCapital: Number(row.opening_contribution), currentCapital, profitSharePct: Number(row.profit_share_pct) };
          }));
        }
      }
    }
    return [];
  },
  listSalesAndInvoices: async () => {
    const runner=activeSqlRunner(); if(!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listSalesAndInvoices();
  },
  // Suppliers
  listSuppliers: async (locationId?: string) => {
    if (isWebRuntime) return db.listSuppliers();
    const parties = (await api.listParties(locationId)).filter((party: any) => party.roles.includes('supplier'));
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    return Promise.all(parties.map(async (party: any) => {
      const detail: any = await service.getPartyDetail(party.id, 'supplier', locationId);
      return { ...party, ...detail, balance: detail?.balance ?? party.payable ?? 0, payable: detail?.balance ?? party.payable ?? 0, totalBilled: detail?.billsTotal ?? 0, totalPaid: detail?.paymentsTotal ?? 0, advanceBalance: detail?.advanceBalance ?? 0 };
    }));
  },
  createSupplier: (s: any) => api.createParty({ ...s, roles: ['supplier'] }),
  updateSupplier: async (id: string, s: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'supplier')) throw new Error('Supplier not found');
    return withSyncedMutation(runner, { commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch: s } }, () => service.updateParty(id, s));
  },
  getSupplier: async (id: string, locationId?: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'supplier', locationId);
    if (!detail) throw new Error('Supplier not found');
    return detail;
  },
  deleteSupplier: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'supplier')) throw new Error('Supplier not found');
    return withSyncedMutation(runner, { commandType: 'party.archive', aggregateType: 'party', aggregateId: id, payload: { id } }, () => service.archiveParty(id));
  },
  listBills: async () => {
    if (isWebRuntime) return db.listBills();
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listBills() as Promise<any[]>;
  },
  createBill: (b: any) => isWebRuntime ? db.createBill(b).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createBill', b),
  updateBill: (id: string, b: any) => isWebRuntime ? db.updateBill(id, b).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updateBill', id, b),
  deleteBill: (id: string) => isWebRuntime ? db.deleteBill(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deleteBill', id),

  listSales: async () => {
    if (isWebRuntime) return db.listSales();
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    return service.listSalesAndInvoices();
  },
  createSale: (s: any) => isWebRuntime ? db.createSale(s).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createSale', s),
  updateSale: (id: string, s: any) => isWebRuntime ? db.updateSale(id, s).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updateSale', id, s),
  deleteSale: (id: string) => isWebRuntime ? db.deleteSale(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deleteSale', id),

  listPayments: async () => isWebRuntime ? db.listPayments() : (await v2SourceDocuments(['supplier_payment','drawing','commission_payment'])).map((row: any) => ({ ...row, supplierId: row.partyId, partnerName: row.partnerName || row.memberName })),
  createPayment: (p: any) => isWebRuntime ? db.createPayment(p).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createPayment', p),
  updatePayment: (id: string, p: any) => isWebRuntime ? db.updatePayment(id, p).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updatePayment', id, p),
  deletePayment: (id: string) => isWebRuntime ? db.deletePayment(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deletePayment', id),

  // Inventory
  v2InventoryOverview: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).inventoryOverview();
  },
  deleteV2InventoryCount: async (id: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const result = await withSyncedMutation(runner, { commandType: 'inventory.count.delete', aggregateType: 'inventory_count', aggregateId: id, payload: { id } }, () => new V2AppService(runner).deleteV2InventoryCount(id));
    bumpDataVersion();
    return result;
  },
  // Cash Book (manual cash in/out ledger)
  listCashEntries: async () => {
    if (isWebRuntime) return db.listCashEntries();
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        // V2 rows are journal-derived movements. They stay visible, but must be
        // changed from their original source document rather than as cash rows.
        // The enriched read includes reversal linkage (reversal_of/posted_at/
        // source flags) so screens can collapse reverse+repost noise for display.
        // Capital deposits keep the journal memo ("Capital deposit — <name>")
        // and surface the user's own note as appended detail.
        const v2Entries = (await service.listCashMovements()).map((entry: any) => ({
          ...entry,
          id: entry.sourceType === 'manual_cash_income' || entry.sourceType === 'manual_cash_expense' ? entry.sourceId : entry.id,
          notes: entry.sourceType === 'capital_injection' && entry.sourceNotes && !String(entry.notes || '').includes(entry.sourceNotes)
            ? `${entry.notes} — ${entry.sourceNotes}`
            : entry.notes,
          origin: 'v2',
          editable: entry.sourceType === 'manual_cash_income' || entry.sourceType === 'manual_cash_expense',
        }));
        return v2Entries;
      }
    }
    return [];
  },
  createCashEntry: async (e: any) => {
    if (isWebRuntime) { const result = await db.createCashEntry(e); bumpDataVersion(); return result; }
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      if (await service.activeContext(e.date)) {
        const resolved = await resolvedSharedLocation(runner, e, e.date);
        const result = await withSyncedMutation(runner, { commandType: 'cash.create', aggregateType: 'source', aggregateId: String(resolved.id || `cash:${Date.now()}`), payload: resolved, businessDate: resolved.date, operationIdentity: !resolved.id }, () => service.recordManualCash(resolved));
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  updateCashEntry: async (id: string, e: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const row = await runner.first<any>('SELECT date,location_id,metadata FROM v2_sources WHERE id=?', [id]);
    let prior: any = {}; try { prior = JSON.parse(String(row?.metadata || '{}')); } catch { prior = {}; }
    const resolved = await resolvedSharedLocation(runner, { ...prior, ...e, date: e.date ?? row?.date, locationId: e.locationId ?? prior.locationId ?? row?.location_id }, e.date ?? row?.date);
    const result = await withSyncedMutation(runner, { commandType: 'cash.patch', aggregateType: 'source', aggregateId: id, payload: { id, input: resolved }, businessDate: resolved.date }, () => new V2AppService(runner).updateManualCash(id, resolved)); bumpDataVersion(); return result;
  },
  deleteCashEntry: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const result = await withSyncedMutation(runner, { commandType: 'cash.delete', aggregateType: 'source', aggregateId: id, payload: { id } }, () => new V2AppService(runner).deleteManualCash(id)); bumpDataVersion(); return result;
  },

  getInvestorLedger: async (id: string): Promise<InvestorLedgerDetail> => {
    const runner = activeSqlRunner();
    if (runner && await new V2AppService(runner).activeContext()) return mergedInvestorLedgerDetail(id);
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  depositInvestorCapital: async (id: string, input: { amount: number; date: string; notes?: string }) => {
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await withSyncedMutation(runner, { commandType: 'capital.deposit', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input: { ...input, bookId: context.bookId } }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(runner).deposit({ ...input, bookId: context.bookId, memberId: id }));
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  updateInvestorCapital: async (id: string, sourceId: string, input: { amount: number; date: string; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Editing posted capital requires SQLite storage');
    const app = new V2AppService(runner);
    const context = await app.activeContext(input.date);
    if (!context) throw new Error('Posting date is outside the open accounting period');
    const result = await withSyncedMutation(runner, { commandType: 'capital.patch', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId, input: { ...input, bookId: context.bookId } }, businessDate: input.date }, () => new V2InvestorLedgerService(runner).updateDeposit(sourceId, { ...input, bookId: context.bookId, memberId: id }));
    bumpDataVersion();
    return result;
  },
  deleteInvestorCapital: async (id: string, sourceId: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Reversing posted capital requires SQLite storage');
    const app = new V2AppService(runner);
    const context = await app.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const result = await withSyncedMutation(runner, { commandType: 'capital.delete', aggregateType: 'source', aggregateId: sourceId, payload: { memberId: id, sourceId, input: { bookId: context.bookId } } }, () => new V2InvestorLedgerService(runner).deleteDeposit(sourceId, context.bookId, id));
    bumpDataVersion();
    return result;
  },
  drawInvestorFunds: async (id: string, input: { amount: number; date: string; method?: 'cash' | 'bank' | 'card' | 'mobile' | 'upi'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await withSyncedMutation(runner, { commandType: 'capital.draw', aggregateType: 'member', aggregateId: id, payload: { memberId: id, input: { ...input, bookId: context.bookId } }, businessDate: input.date, operationIdentity: true }, () => new V2InvestorLedgerService(runner).draw({ ...input, bookId: context.bookId, memberId: id }));
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },

  // Dashboard & reports
  dashboard: async (locationId?: string) => {
    if (isWebRuntime) return db.dashboard();
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const ctx = await new V2AppService(runner).activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    return getV2Dashboard(runner, ctx.bookId, locationId);
  },
  pnl: async () => {
    if (isWebRuntime) return db.pnl();
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          revenue: d.totalSales, cogs: d.totalPurchases, grossProfit: d.grossProfit,
          managerCommissionPct: d.managerCommissionPct, commission: d.commission,
          drawings: d.drawings, netProfit: d.netProfit,
        };
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  balanceSheet: async () => {
    if (isWebRuntime) return db.balanceSheet();
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          assets: { cash: d.cash, inventory: d.inventoryValue, accountsReceivable: d.accountsReceivable, supplierAdvances: d.supplierAdvances, other: d.otherAssets, total: d.assets },
          liabilities: { suppliersPayable: d.accountsPayable, customerAdvances: d.customerAdvances, commissionPayable: d.commissionPayable, other: d.otherLiabilities, total: d.liabilities },
          equity: d.netWorth,
        };
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  trialBalance: async () => {
    if (isWebRuntime) return db.trialBalance();
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          debits: [
            { account: 'Cash', amount: d.cash },
            { account: 'Inventory', amount: d.inventoryValue },
            { account: 'Purchases', amount: d.totalPurchases },
            { account: 'Drawings', amount: d.drawings },
          ],
          credits: [
            { account: 'Sales Revenue', amount: d.totalSales },
            { account: 'Accounts Payable', amount: d.liabilities },
          ],
        };
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  capitalStatement: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); const context = await service.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const period = await service.getActivePeriod();
    const report = await v2Report(period?.startDate, period?.endDate);
    const display = partnershipDisplayFromReports(report, await liveCommissionPct());
    const members = await api.listInvestors();
    const investors = await Promise.all(members.map(async (member: any) => {
      const detail = await mergedInvestorLedgerDetail(member.id);
      const profitShare = Math.round(display.netProfit * Number(member.profitSharePct || 0)) / 100;
      return { id: member.id, name: member.name, contributed: detail.openingCapital + detail.totalInjected, drawings: detail.totalDrawings, profitShare, balance: detail.currentCapitalBalance, profitSharePct: member.profitSharePct };
    }));
    return { netProfit: display.netProfit, investors };
  },
  drawingsHistory: async () => (await v2SourceDocuments(['drawing'])).map((row: any) => ({ ...row, investorId: row.memberId })),
  monthlyProfitTrend: async (months = 6) => {
    const out: any[] = []; const now = new Date();
    for (let offset = months - 1; offset >= 0; offset--) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const from = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
      const to = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
      const report = await v2Report(from, to);
      const display = partnershipDisplayFromReports(report, await liveCommissionPct());
      out.push({ month: from.slice(0, 7), revenue: report.profitAndLoss.revenue, purchases: report.profitAndLoss.cogs, grossProfit: report.profitAndLoss.grossProfit, netProfit: display.netProfit });
    }
    return out;
  },
  assetDistribution: async () => {
    const d: any = await api.dashboard();
    return [
      { label: 'Cash', value: d.cash }, { label: 'Inventory', value: d.inventoryValue },
      { label: 'Receivables', value: d.accountsReceivable }, { label: 'Other Assets', value: d.otherAssets },
    ].filter((item) => Number(item.value) !== 0);
  },
  monthlySummary: async (m: string) => {
    const [year, month] = m.split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${m}-01`;
    const to = `${m}-${String(lastDay).padStart(2, '0')}`;
    const report = await v2Report(from, to);
    const pnl = report.profitAndLoss;
    const display = partnershipDisplayFromReports(report, await liveCommissionPct());
    return {
      month: m,
      periodStart: from,
      revenue: pnl.revenue,
      purchases: pnl.cogs,
      cogs: pnl.cogs,
      grossProfit: pnl.grossProfit,
      expenses: display.operatingExpenses,
      totalExpenses: pnl.expenses,
      commission: display.commission,
      managerCommissionPct: display.managerCommissionPct,
      netProfit: display.netProfit,
    };
  },
  dailySummary: async (d: string) => {
    if (isWebRuntime) {
      const [range, sales, bills, payments, cashMovements] = await Promise.all([db.pnlRange(d, d), db.listSales(), db.listBills(), db.listPayments(), db.listCashEntries()]);
      const onDate = (row: any) => String(row?.date || '').slice(0, 10) === d;
      const netCash = round2(cashMovements.filter(onDate).reduce((sum: number, row: any) => sum + (row.direction === 'in' ? Number(row.amount || 0) : -Number(row.amount || 0)), 0));
      return { date: d, revenue: range.revenue, purchases: range.purchases, grossProfit: range.grossProfit, expenses: range.expenses, netProfit: range.netProfit, netCash, salesCount: sales.filter(onDate).length, billsCount: bills.filter(onDate).length, paymentsCount: payments.filter(onDate).length };
    }
    const runner = activeSqlRunner();
    if (!runner) throw new Error('No active versioned V2 book with an open accounting period');
    const service = new V2AppService(runner);
    const ctx = await service.activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    const report = await buildPersistentV2Reports(runner, { bookId: ctx.bookId, from: d, to: d });
    const salesAndInvoices = await service.listSalesAndInvoices();
    const bills = await service.listBills();
    const payments = await api.listPayments();
    const cashMovements = await service.listCashMovements();
    const daySales = salesAndInvoices.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayBills = bills.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayPayments = payments.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayMovements = cashMovements.filter((m: any) => (m.date || '').slice(0, 10) === d);
    const netCash = round2(dayMovements.reduce((sum: number, m: any) => sum + (m.direction === 'in' ? Number(m.amount || 0) : -Number(m.amount || 0)), 0));
    const display = partnershipDisplayFromReports(report, await liveCommissionPct());
    return {
      date: d,
      revenue: report.profitAndLoss.revenue,
      purchases: report.profitAndLoss.cogs,
      grossProfit: report.profitAndLoss.grossProfit,
      expenses: display.operatingExpenses,
      netProfit: display.netProfit,
      netCash,
      salesCount: daySales.length,
      billsCount: dayBills.length,
      paymentsCount: dayPayments.length,
    };
  },

  // Book health keeps trust signals visible without changing the authoritative ledger.
  bookHealth: async () => {
    const [settings, invoices, bills, sessions, locations] = await Promise.all([
      api.getSettings(), db.listInvoices(), api.listBills(), db.listPosSessions(), db.listLocations(),
    ]);
    const warnings: { key: string; severity: 'info' | 'warning'; label: string; detail: string }[] = [];
    if (!settings.businessName) warnings.push({ key: 'business_name', severity: 'warning', label: 'Business profile incomplete', detail: 'Add your business name before sharing documents.' });
    const draftCount = invoices.filter((item: any) => String(item.status || '').toLowerCase() === 'draft').length;
    if (draftCount) warnings.push({ key: 'drafts', severity: 'info', label: `${draftCount} invoice draft${draftCount === 1 ? '' : 's'} waiting`, detail: 'Review and post drafts before relying on receivables.' });
    const missingDates = [...invoices, ...bills].filter((item: any) => !item.date).length;
    if (missingDates) warnings.push({ key: 'missing_dates', severity: 'warning', label: 'Entries missing dates', detail: 'Add dates so reports and periods remain reliable.' });
    const openSessions = sessions.filter((item: any) => item.status !== 'closed').length;
    if (openSessions) warnings.push({ key: 'open_pos', severity: 'info', label: `${openSessions} POS session${openSessions === 1 ? '' : 's'} open`, detail: 'Close drawers at the end of each trading day.' });
    const lastBackup = await AsyncStorage.getItem('ledgr:last_backup_at');
    if (!lastBackup) warnings.push({ key: 'backup', severity: 'warning', label: 'No recent backup recorded', detail: 'Export a JSON backup after important bookkeeping work.' });
    return { warnings, lastBackupAt: lastBackup, locationCount: locations.length, openPosSessions: openSessions, draftCount, hasRecoveryWarning: !lastBackup };
  },

  // Backup + danger
  exportBackup: async () => {
    const data: any = await db.exportBackup();
    // Include model name so it carries over to other devices
    data.geminiModel = await getGeminiModel();
    await AsyncStorage.setItem('ledgr:last_backup_at', new Date().toISOString());
    return data;
  },
  importBackup: async (payload: any) => {
    const runner = activeSqlRunner();
    if (runner) await markSyncRecoveryRequired(runner, beActiveBookId(), 'Manual backup restore requires sync re-enrollment and reconciliation');
    const result: any = await db.importBackup(payload);
    // Restore model name if present in backup
    if (payload.geminiModel && typeof payload.geminiModel === 'string') {
      await setGeminiModel(payload.geminiModel);
    }
    // Surface the atomic-import outcome (v2 restore status + warnings) to callers.
    return result;
  },
  listPeriods: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const context = await new V2AppService(runner).activeContext(); if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const rows = await runner.all<any>('SELECT p.id,p.start_date,p.end_date,c.closed_at,c.snapshot FROM v2_periods p JOIN v2_close_books c ON c.period_id=p.id WHERE p.book_id=? ORDER BY p.end_date DESC', [context.bookId]);
    return rows.map((row: any) => { const snapshot = JSON.parse(row.snapshot || '{}'); return { id: row.id, startDate: row.start_date, endDate: row.end_date, closedAt: row.closed_at, ...snapshot, closingCash: Number(snapshot.cash || 0) + Number(snapshot.bank || 0), closingInventory: Number(snapshot.inventory || 0) }; });
  },
  closePeriod: async (actualStock: number, notes = '', commissionPct = 0, date?: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const closeBooks = createCloseBooksRouter(service);
    const overview = await service.inventoryOverview();
    const closeDate = date || localTodayIso();
    const syncStatus = await getSyncStatus(runner, beActiveBookId());
    const closeInput = {
      actualStock,
      openingInventory: Number(overview?.openingInventory || 0),
      commissionPct,
      notes,
      date: closeDate,
      ...(syncStatus.enabled ? { expectedBookSequence: Number(syncStatus.cursor || 0) } : {}),
    };
    const result = await withSyncedMutation(runner, { commandType: 'period.close', aggregateType: 'period', aggregateId: closeDate, payload: closeInput, businessDate: closeDate }, () => closeBooks(closeInput));
    bumpDataVersion();
    return result;
  },
  listEmployees: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listEmployees();
  },
  upsertEmployee: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await withSyncedMutation(runner, { commandType: 'employee.upsert', aggregateType: 'employee', aggregateId: String(input.id || input.name), payload: input, operationIdentity: !input.id }, () => new V2AppService(runner).upsertEmployee(input)); bumpDataVersion(); return r;
  },
  archiveEmployee: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await withSyncedMutation(runner, { commandType: 'employee.archive', aggregateType: 'employee', aggregateId: id, payload: { id } }, () => new V2AppService(runner).archiveEmployee(id)); bumpDataVersion(); return r;
  },
  runPayroll: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = await resolvedSharedLocation(runner, input, input.date);
    const r = await withSyncedMutation(runner, { commandType: 'payroll.run', aggregateType: 'pay_run', aggregateId: String(resolved.id || resolved.date || Date.now()), payload: resolved, businessDate: resolved.date, operationIdentity: !resolved.id }, () => new V2AppService(runner).runPayroll(resolved)); bumpDataVersion(); return r;
  },
  listPayRuns: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listPayRuns();
  },
  listPayslips: async (payRunId: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listPayslips(payRunId);
  },
  yearEndPayrollSummary: async (year: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).yearEndPayrollSummary(year);
  },
  listProducts: async (locationId?: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listProducts(locationId);
  },
  listLocations: async (options?: { includeArchived?: boolean }) => {
    const runner = activeSqlRunner();
    if (!runner) {
      const rows = await db.listLocations();
      return options?.includeArchived ? rows : rows.filter((row: any) => row.active !== false);
    }
    return new V2AppService(runner).listLocations(options);
  },
  createLocation: async (input: any) => {
    const runner = activeSqlRunner();
    if (!runner) { const r = await db.createLocation(input); bumpDataVersion(); return r; }
    const r = await withSyncedMutation(runner, { commandType: 'location.create', aggregateType: 'location', aggregateId: String(input.id || input.name), payload: input, operationIdentity: !input.id }, () => new V2AppService(runner).createLocation(input)); bumpDataVersion(); return r;
  },
  renameLocation: async (id: string, name: string) => {
    const runner = activeSqlRunner();
    if (!runner) { const r = await db.updateLocation(id, { name }); bumpDataVersion(); return r; }
    const r = await withSyncedMutation(runner, { commandType: 'location.rename', aggregateType: 'location', aggregateId: id, payload: { id, name } }, () => new V2AppService(runner).renameLocation(id, name)); bumpDataVersion(); return r;
  },
  archiveLocation: async (id: string) => {
    const runner = activeSqlRunner();
    if (!runner) { const r = await db.updateLocation(id, { active: false }); bumpDataVersion(); return r; }
    const r = await withSyncedMutation(runner, { commandType: 'location.archive', aggregateType: 'location', aggregateId: id, payload: { id } }, () => new V2AppService(runner).archiveLocation(id)); bumpDataVersion(); return r;
  },
  reopenLocation: async (id: string) => {
    const runner = activeSqlRunner();
    if (!runner) { const r = await db.updateLocation(id, { active: true }); bumpDataVersion(); return r; }
    const r = await withSyncedMutation(runner, { commandType: 'location.reopen', aggregateType: 'location', aggregateId: id, payload: { id } }, () => new V2AppService(runner).reopenLocation(id)); bumpDataVersion(); return r;
  },
  transferLocationCash: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await withSyncedMutation(runner, { commandType: 'location.transfer_cash', aggregateType: 'location', aggregateId: String(input.locationId || input.fromLocationId || Date.now()), payload: input, businessDate: input.date, operationIdentity: true }, () => new V2AppService(runner).transferLocationCash(input)); bumpDataVersion(); return r;
  },
  transferLocationStock: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await withSyncedMutation(runner, { commandType: 'location.transfer_stock', aggregateType: 'location', aggregateId: String(input.productId || input.fromLocationId || Date.now()), payload: input, businessDate: input.date, operationIdentity: true }, () => new V2AppService(runner).transferLocationStock(input)); bumpDataVersion(); return r;
  },
  listStockTransfers: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listLocationStockTransfers();
  },
  upsertProduct: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const hasQuantity = input.openingQty != null || input.qty != null || input.locationId != null;
    const resolved = hasQuantity ? await resolvedSharedLocation(runner, input, input.date || localTodayIso()) : { ...input };
    const r = await withSyncedMutation(runner, { commandType: 'product.upsert', aggregateType: 'product', aggregateId: String(resolved.id || resolved.sku || resolved.name), payload: resolved, operationIdentity: !resolved.id }, () => new V2AppService(runner).upsertProduct(resolved)); bumpDataVersion(); return r;
  },
  archiveProduct: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await withSyncedMutation(runner, { commandType: 'product.archive', aggregateType: 'product', aggregateId: id, payload: { id } }, () => new V2AppService(runner).archiveProduct(id)); bumpDataVersion(); return r;
  },
  adjustProductQty: async (input: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const resolved = await resolvedSharedLocation(runner, input, input.date);
    const r = await withSyncedMutation(runner, { commandType: 'product.adjust_qty', aggregateType: 'product', aggregateId: String(resolved.productId || resolved.id), payload: resolved, businessDate: resolved.date, operationIdentity: true }, () => new V2AppService(runner).adjustProductQty(resolved)); bumpDataVersion(); return r;
  },
  // Clears books and ledgers only; device preferences and AI credentials remain.
  clearAccountingData: async () => {
    const runner = activeSqlRunner();
    const today = localTodayIso();
    const originalBookId = beActiveBookId();
    const originalV2Active = runner ? await runner.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'") : null;
    try {
      const books = await beListBooks();
      if (runner) {
        for (const book of books) await markSyncRecoveryRequired(runner, book.id, 'Accounting reset requires sync re-enrollment and reconciliation');
        await resetAllV2AccountingData(runner, today);
      }
      for (const book of books) {
        await beSetActiveBook(book.id);
        await db.resetAll();
      }
      bumpDataVersion();
      if (originalBookId && (await beListBooks()).some((book) => book.id === originalBookId)) {
        await beSetActiveBook(originalBookId);
      }
      if (runner && originalV2Active?.value) {
        await runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", [originalV2Active.value]);
      }
      return { success: true };
    } catch (e: any) {
      if (originalBookId) await beSetActiveBook(originalBookId);
      if (runner && originalV2Active?.value) {
        await runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", [originalV2Active.value]);
      }
      throw e;
    }
  },

  resetAll: async () => api.clearAccountingData(),
  factoryReset: async () => {
    await api.clearAccountingData();
    // Wipe each book's business configuration (and its logo key). We iterate all
    // books first, THEN tear down the books index — so no book is missed.
    try {
      for (const book of await beListBooks()) {
        await beSetActiveBook(book.id);
        await db.factoryReset();
      }
    } finally {
      // Remove the books index + active-book pointer, reset the in-memory active
      // book to default, and clear the V2 meta keys (v2_active_book_id +
      // every v2_book_version:*). Preserves theme keys + AI-config clearing. [C4/M2]
      await beResetBooksAndActiveBook();
    }
    // Scorched earth for the authoritative V2 SQLite store: a FACTORY reset must
    // leave ZERO rows in EVERY v2_* table. clearAccountingData deliberately
    // preserves book identity rows (v2_books/v2_accounts/v2_personas/v2_members)
    // for the in-app "reset data" action — leaving them here made the next
    // onboarding bootstrap crash with "UNIQUE constraint failed: v2_books.id"
    // when it re-inserted the same deterministic active-book id. [reset]
    {
      const runner = activeSqlRunner();
      if (runner) await factoryResetV2Data(runner);
    }
    const backupHistoryKeys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith('ledgr:backup_history:'));
    await Promise.all([
      storage.secureRemove(AI_API_KEY_KEY),
      storage.secureRemove(AI_TRANSCRIPTION_API_KEY_KEY),
      AsyncStorage.multiRemove([
        AI_PROVIDER_KEY, AI_API_KEY_KEY, AI_MODEL_KEY, AI_VISION_MODEL_KEY, AI_TRANSCRIPTION_MODEL_KEY, AI_TRANSCRIPTION_BASE_URL_KEY, AI_TRANSCRIPTION_API_KEY_KEY, AI_BASE_URL_KEY, AI_VOICE_PROVIDER_KEY, AI_OCR_PROVIDER_KEY, AI_INTERPRETATION_PROVIDER_KEY, AI_ENTRY_HELP_ORDER_KEY,
        // Device-level user prefs + UI customizations (theme, animations, tile
        // order/usage). The user wants EVERYTHING wiped on factory reset. [reset]
        ...FACTORY_RESET_PREF_KEYS,
        ...backupHistoryKeys,
      ]),
    ]);
    return { ok: true };
  },

  aiSnapshot: (from: string, to: string, mode: AiDataMode = 'summary') => buildAiSnapshot(from, to, mode),
  // AI
  parseCommand: async (text: string) => { const settings = await db.getSettings(); return ai.parseCommand(await getAIConfig(), text, settings.currency || 'USD'); },
  ocrReceipt: async (imageBase64: string, mimeType = 'image/jpeg') => { const settings = await db.getSettings(); return ai.ocrReceipt(await getAIConfig(), imageBase64, mimeType, settings.currency || 'USD'); },
  analyzeDocument: async (input: { base64?: string; mimeType?: string; text?: string; uri?: string }) => {
    const config = await getAIConfig();
    const mode = ai.effectiveOcrProvider(config);
    const order = config.entryHelpOrder || 'cloud-first';
    const isImage = Boolean(input.uri && input.mimeType?.startsWith('image/'));
    const isPdf = input.mimeType === 'application/pdf';
    const hasCloudAI = Boolean(config.apiKey.trim());

    const withMeta = (document: any, extra?: { notice?: string; pending?: unknown; extractedText?: string }) => ({
      ...document,
      __ledgrAnalysisMeta: { source: 'local', extractedText: extra?.extractedText, notice: extra?.notice, pending: extra?.pending },
    });
    const runLocal = async (): Promise<{ document?: any; failure: string }> => {
      let localText = String(input.text || '').trim();
      let localFailure = '';
      if ((isImage || isPdf) && input.uri && !localText) {
        try {
          localText = await recognizeLocalOcr(input.uri);
        } catch (error) {
          localFailure = String((error as any)?.message || 'Android OCR could not read this document.');
        }
      }
      if (!localText) return { failure: localFailure || 'Local OCR needs an Android image, PDF, or pasted document text.' };
      const [suppliers, customers, capitalAccounts] = await Promise.all([
        api.listSuppliers(), api.listDebtors(), api.listInvestors(),
      ]);
      const local = interpretLocalDocumentText(localText, { directory: { suppliers, customers, capitalAccounts } });
      if (local.status === 'confident') return { document: withMeta(local.document, { extractedText: localText }), failure: '' };
      if (local.status === 'clarification' && local.document) {
        return {
          document: withMeta(local.document, { extractedText: localText, notice: local.question, pending: local }),
          failure: '',
        };
      }
      return { failure: local.status === 'unsupported' ? local.reason : local.question };
    };

    if (mode === 'android-device') {
      const local = await runLocal();
      if (local.document) return local.document;
      if (input.uri && input.mimeType) {
        try {
          const extracted = await extractDocumentWithGemma({ uri: input.uri, mimeType: input.mimeType });
          return { ...extracted, __ledgrAnalysisMeta: { source: 'on-device-llm', notice: 'On-device Gemma prepared this draft because local OCR did not find enough ledger lines.' } };
        } catch (error) {
          const { gemmaMediaErrorMessage } = await import('./accountingV2/gemma/mediaTasks');
          throw new Error(gemmaMediaErrorMessage(error));
        }
      }
      throw new Error(local.failure || 'The document needs more information before Ledgr can prepare a draft.');
    }

    if (mode === 'cloud' || (mode === 'auto' && order === 'cloud-first' && hasCloudAI)) {
      try {
        return await ai.withCloudHelpTimeout(ai.analyzeDocumentAI(config, input));
      } catch (error) {
        if (mode === 'cloud') throw error;
        const local = await runLocal();
        if (local.document) return local.document;
        throw new Error(`${String((error as any)?.message || 'Cloud document analysis failed.')} ${local.failure}`.trim());
      }
    }

    const local = await runLocal();
    if (local.document) return local.document;
    if (!hasCloudAI) {
      throw new Error(`${local.failure || 'Ledgr could not safely understand this document locally.'} Edit or paste clearer text, use a page image, or configure cloud vision for complex documents.`);
    }
    return ai.withCloudHelpTimeout(ai.analyzeDocumentAI(config, input));
  },
  transcribe: async (audioBase64: string, mimeType = 'audio/m4a', audioUri?: string) => {
    const config = await getAIConfig();
    if (ai.effectiveVoiceProvider(config) === 'android-device') {
      if (!audioUri) throw new Error('On-device transcription needs the recording URI. No audio was sent to a cloud provider.');
      return transcribeAudioWithGemma(audioUri);
    }
    return ai.transcribe(config, audioBase64, mimeType, audioUri);
  },
  reconcileStatement: (imageBase64: string, partyId: string, mimeType = 'image/jpeg', party: 'supplier' | 'customer' = 'supplier') => reconcileStatement(imageBase64, partyId, mimeType, party),
  askBooks: async (question: string, dataContext: string) => {
    const config = await getAIConfig();
    if (ai.isOnDeviceInterpretation(config) || config.entryHelpOrder === 'device-first') {
      const onDevice = await askBooksOnDevice(config, question, dataContext, runReadTool);
      if (onDevice) return onDevice;
    }
    return ai.askBooks(config, question, dataContext);
  },
  getSpeakAnswers: async () => (await AsyncStorage.getItem(SPEAK_ANSWERS_KEY)) === '1',
  setSpeakAnswers: async (enabled: boolean) => {
    if (enabled) await AsyncStorage.setItem(SPEAK_ANSWERS_KEY, '1');
    else await AsyncStorage.removeItem(SPEAK_ANSWERS_KEY);
  },

  /**
   * Which downloaded pack to use, or null for Auto (the best installed pack the
   * phone can run). Stored by onDeviceLlm, which owns the key; api.ts only
   * re-exposes it so settings screens have one place to look.
   */
  getPreferredOnDeviceModel: getPreferredOnDevicePack,
  setPreferredOnDeviceModel: setPreferredOnDevicePack,

  // Expenses
  listExpenses: async () => isWebRuntime
    ? db.listExpenses()
    : (await v2SourceDocuments(['expense'])).map((row: any) => ({ ...row, category: row.category || 'Expense' })),
  createExpense: (e: any) => isWebRuntime ? db.createExpense(e).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createExpense', e),
  updateExpense: (id: string, e: any) => isWebRuntime ? db.updateExpense(id, e).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updateExpense', id, e),
  deleteExpense: (id: string) => isWebRuntime ? db.deleteExpense(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deleteExpense', id),

  // Debtors
  listDebtors: async (locationId?: string) => {
    if (isWebRuntime) return db.listDebtors();
    const parties = (await api.listParties(locationId)).filter((party: any) => party.roles.includes('customer'));
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    return Promise.all(parties.map(async (party: any) => {
      const detail: any = await service.getPartyDetail(party.id, 'customer', locationId);
      return { ...party, ...detail, balance: detail?.balance ?? party.receivable ?? 0, receivable: detail?.balance ?? party.receivable ?? 0, totalInvoiced: detail?.totalInvoiced ?? 0, totalPaid: detail?.totalPaid ?? 0, advanceBalance: detail?.advanceBalance ?? 0 };
    }));
  },
  getCustomer: async (id: string, locationId?: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'customer', locationId);
    if (!detail) throw new Error('Customer not found');
    return detail;
  },
  createDebtor: (d: any) => api.createParty({ ...d, roles: ['customer'] }),
  updateDebtor: async (id: string, d: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'customer')) throw new Error('Customer not found');
    return withSyncedMutation(runner, { commandType: 'party.patch', aggregateType: 'party', aggregateId: id, payload: { id, patch: d } }, () => service.updateParty(id, d));
  },
  deleteDebtor: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'customer')) throw new Error('Customer not found');
    return withSyncedMutation(runner, { commandType: 'party.archive', aggregateType: 'party', aggregateId: id, payload: { id } }, () => service.archiveParty(id));
  },
  getDebtorStatement: async (id: string, locationId?: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'customer', locationId);
    if (!detail) throw new Error('Customer not found');
    return detail.statement;
  },
  // Date-range reports
  pnlRange: async (from: string, to: string) => {
    const report = await v2Report(from, to);
    const display = partnershipDisplayFromReports(report, await liveCommissionPct());
    return {
      revenue: report.profitAndLoss.revenue,
      purchases: report.profitAndLoss.cogs,
      cogs: report.profitAndLoss.cogs,
      grossProfit: report.profitAndLoss.grossProfit,
      expenses: display.operatingExpenses,
      managerCommissionPct: display.managerCommissionPct,
      commission: display.commission,
      netProfit: display.netProfit,
    };
  },
  creditorsReport: async (_from?: string, _to?: string, locationId?: string) => (await api.listSuppliers(locationId)).map((party: any) => ({ id: party.id, name: party.name, balance: party.payable || party.balance || 0, locationId: locationId || undefined })),
  debtorsReport: async (_from?: string, _to?: string, locationId?: string) => (await api.listDebtors(locationId)).map((party: any) => ({ id: party.id, name: party.name, balance: party.receivable || party.balance || 0, locationId: locationId || undefined })),

  // Invoices
  listInvoices: async () => {
    if (isWebRuntime) return db.listInvoices();
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const statuses = new Map((await service.listSalesAndInvoices()).filter((row: any) => row.type === 'invoice').map((row: any) => [row.id, row]));
    return (await v2SourceDocuments(['invoice'])).map((row: any) => {
      const live: any = statuses.get(row.id);
      return { ...row, invoiceNumber: row.reference || row.id, status: live?.status || row.status || 'unpaid', openAmount: live?.openAmount ?? row.total, lines: Array.isArray(row.lines) ? row.lines : [] };
    });
  },
  createInvoice: (inv: any) => isWebRuntime ? db.createInvoice(inv).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createInvoice', inv),
  updateInvoice: (id: string, inv: any) => isWebRuntime ? db.updateInvoice(id, inv).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updateInvoice', id, inv),
  deleteInvoice: (id: string) => isWebRuntime ? db.deleteInvoice(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deleteInvoice', id),
  markInvoicePaid: (id: string, input?: any) => isWebRuntime ? db.markInvoicePaid(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('markInvoicePaid', id, { ...(input || {}), date: input?.date || localTodayIso(), method: input?.method || 'cash' }),
  overdueInvoices: async () => (await api.listInvoices()).filter((invoice: any) => invoice.status !== 'paid' && invoice.dueDate && invoice.dueDate < localTodayIso()),

  // Receipts (money actually received)
  listReceipts: async () => {
    if (isWebRuntime) return db.listReceipts();
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const receipts = await v2SourceDocuments(['receipt']);
    const ids = receipts.map((row: any) => row.id);
    const allocations = ids.length ? await runner.all<any>(`SELECT receipt_source_id,invoice_source_id,amount FROM v2_invoice_allocations WHERE receipt_source_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    return receipts.map((row: any) => ({ ...row, receiptNumber: row.reference || row.id, debtorId: row.partyId, mode: row.mode || (Number(row.advance) > 0 ? 'advance' : 'against_invoice'), allocations: allocations.filter((item: any) => item.receipt_source_id === row.id).map((item: any) => ({ invoiceId: item.invoice_source_id, invoiceSourceId: item.invoice_source_id, amountApplied: Number(item.amount), amount: Number(item.amount) })) }));
  },
  createReceipt: (r: any) => isWebRuntime ? db.createReceipt(r).then((result) => { bumpDataVersion(); return result; }) : createTransaction('createReceipt', r),
  updateReceipt: (id: string, input: any) => isWebRuntime ? db.updateReceipt(id, input).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('updateReceipt', id, input),
  deleteReceipt: (id: string) => isWebRuntime ? db.deleteReceipt(id).then((result) => { bumpDataVersion(); return result; }) : mutateTransaction('deleteReceipt', id),
  invoicePaidAmount: async (invoiceId: string) => {
    if (isWebRuntime) return db.invoicePaidAmount(invoiceId);
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const row = await runner.first<{ total: number }>('SELECT COALESCE(SUM(amount),0) total FROM v2_invoice_allocations WHERE invoice_source_id=?', [invoiceId]);
    return Number(row?.total || 0);
  },

  // Quotes / Estimates (non-posting until converted)
  listQuotes: () => db.listQuotes(),
  createQuote: async (q: any) => { const r = await db.createQuote(q); bumpDataVersion(); return r; },
  updateQuote: async (id: string, q: any) => { const r = await db.updateQuote(id, q); bumpDataVersion(); return r; },
  deleteQuote: async (id: string) => { const r = await db.deleteQuote(id); bumpDataVersion(); return r; },
  setQuoteStatus: async (id: string, status: any) => { const r = await db.setQuoteStatus(id, status); bumpDataVersion(); return r; },
  convertQuoteToInvoice: async (id: string, opts?: any) => {
    // [Finding B] Route the invoice creation through the SAME V2 write path the
    // invoices screen uses so the converted invoice is visible to the V2 ledger
    // (dashboard, reports, party detail) — not stranded outside the ledger.
    const r = await db.convertQuoteToInvoice(id, opts, (payload: any) => createTransaction('createInvoice', payload));
    bumpDataVersion();
    return r;
  },

  // Credit / Debit Notes (post-sale adjustments: discounts, returns, extra charges)
  createCreditNote: async (n: any) => createNote('createCreditNote', n),
  createDebitNote: async (n: any) => createNote('createDebitNote', n),
  updateNote: async (id: string, n: any) => mutateTransaction('updateNote', id, n),
  deleteNote: async (id: string) => mutateTransaction('deleteNote', id),

  // Delivery Notes / Challans (goods movement, no ledger posting)
  listDeliveryNotes: () => db.listDeliveryNotes(),
  createDeliveryNote: async (n: any) => { const r = await db.createDeliveryNote(n); bumpDataVersion(); return r; },
  updateDeliveryNote: async (id: string, n: any) => { const r = await db.updateDeliveryNote(id, n); bumpDataVersion(); return r; },
  deleteDeliveryNote: async (id: string) => { const r = await db.deleteDeliveryNote(id); bumpDataVersion(); return r; },

  // Enhanced reports
  taxReport: async (from: string, to: string) => {
    const [settings, config, invoices, cashSales, receipts, bills, creditNotes, report] = await Promise.all([
      api.getSettings(), api.getV2BookConfig(), v2SourceDocuments(['invoice']), v2SourceDocuments(['cash_sale']), v2SourceDocuments(['receipt']), v2SourceDocuments(['cash_purchase','credit_purchase']), v2SourceDocuments(['credit_note']), v2Report(from, to).catch(() => null),
    ]);
    const inRange = (row: any) => row.date >= from && row.date <= to;
    const taxOf = (gross: number, rate: number) => rate > 0 ? Math.round((gross - gross / (1 + rate / 100)) * 100) / 100 : 0;
    const basis = config?.basis === 'cash' ? 'cash' : 'accrual';
    const rate = Number(settings.taxRate || 0);

    let outputBase = 0;
    let outputTax = 0;
    if (basis === 'accrual') {
      const salesRows = [...invoices, ...cashSales].filter(inRange);
      for (const row of salesRows) {
        const total = Number(row.total || row.amount || 0);
        const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
        const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
        outputBase += base;
        outputTax += rowTax;
      }
    } else {
      const cashRows = [...cashSales, ...receipts].filter(inRange);
      for (const row of cashRows) {
        const total = Number(row.total || row.amount || 0);
        const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
        const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
        outputBase += base;
        outputTax += rowTax;
      }
    }

    const cnRows = creditNotes.filter(inRange);
    const creditNoteTax = cnRows.reduce((sum: number, row: any) => {
      const total = Number(row.total || row.amount || 0);
      return sum + Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
    }, 0);
    const netOutputTax = Math.max(0, Math.round((outputTax - creditNoteTax) * 100) / 100);

    const inputRows = bills.filter(inRange);
    let inputBase = 0;
    let inputTax = 0;
    for (const row of inputRows) {
      const total = Number(row.amount || row.total || 0);
      const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
      const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
      inputBase += base;
      inputTax += rowTax;
    }
    inputBase = Math.round(inputBase * 100) / 100;
    inputTax = Math.round(inputTax * 100) / 100;
    outputBase = Math.round(outputBase * 100) / 100;
    outputTax = Math.round(outputTax * 100) / 100;

    const glTaxAccount = report?.trialBalance?.accounts?.find((a: any) => a.code === '2300');
    const glTaxPayable = glTaxAccount ? glTaxAccount.normalBalance : 0;
    const netTaxPayable = (basis === 'accrual' && glTaxAccount) ? glTaxPayable : Math.round((netOutputTax - inputTax) * 100) / 100;

    return { from, to, taxLabel: settings.taxLabel || 'Tax', taxRate: rate, basis, outputBase, outputTax, creditNoteTax, debitNoteTax: 0, netOutputTax, inputBase, inputTax, netTaxPayable, glTaxPayable };
  },
  salesRegister: async (from: string, to: string) => {
    const rows = (await v2SourceDocuments(['cash_sale','invoice'])).filter((row: any) => row.date >= from && row.date <= to).map((row: any) => ({ date: row.date, type: row.type === 'invoice' ? 'Invoice' : 'Cash Sale', ref: row.reference || '', party: row.partyName || '', amount: row.amount, status: row.status }));
    const cashTotal = rows.filter((row: any) => row.type === 'Cash Sale').reduce((sum: number, row: any) => sum + row.amount, 0);
    const invoiceTotal = rows.filter((row: any) => row.type === 'Invoice').reduce((sum: number, row: any) => sum + row.amount, 0);
    return { from, to, rows: rows.sort((a: any,b: any) => a.date.localeCompare(b.date)), total: cashTotal + invoiceTotal, cashTotal, invoiceTotal, count: rows.length };
  },
  receiptsRegister: async (from: string, to: string) => {
    const rows = (await api.listReceipts()).filter((row: any) => row.date >= from && row.date <= to).map((row: any) => ({ date: row.date, ref: row.receiptNumber, party: row.clientName || 'Walk-in', mode: row.mode, method: row.method || 'cash', amount: row.amount }));
    const byMethod: Record<string, number> = {}; const byMode: Record<string, number> = {};
    for (const row of rows) { byMethod[row.method] = (byMethod[row.method] || 0) + row.amount; byMode[row.mode] = (byMode[row.mode] || 0) + row.amount; }
    return { from, to, rows: rows.sort((a: any,b: any) => a.date.localeCompare(b.date)), byMethod, byMode, total: rows.reduce((sum: number, row: any) => sum + row.amount, 0), count: rows.length };
  },
};
