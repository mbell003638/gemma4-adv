import { activeBookId, activeSqlRunner, readSettings } from '../../db/backend';
import type { SqlRunner } from '../../db/schema';
import { getEnabledCapabilities } from '../../utils/capabilities';
import { getDataVersion } from '../../utils/dataVersion';
import { assertAssistantSessionReady, getAssistantSessionState } from '../../utils/assistantSessionState';
import { V2BookConfigRepository } from '../bookConfigRepository';
import { readV2BookPrefs } from '../optionalModules';
import type { Scope } from './agentCore';
import { sameScope } from './agentCore';
import type { BookContext } from './branchPorts';
import type { ReportReadGuard } from './scopedReportReader';

export type LiveBookProviders = {
  activeBookId(): string;
  readSettings(): Promise<Record<string, unknown>>;
  session(): { storageReady: boolean; unlocked: boolean; epoch: number };
  dataVersion(): number;
  now(): Date;
  timeZone(): string;
};

const productionProviders: LiveBookProviders = {
  activeBookId,
  readSettings,
  session: getAssistantSessionState,
  dataVersion: getDataVersion,
  now: () => new Date(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function buildLiveBookContext(db: SqlRunner, providers: LiveBookProviders): Promise<BookContext> {
  const session = providers.session();
  if (!session.storageReady) throw new Error('STORAGE_NOT_READY');
  if (!session.unlocked) throw new Error('APP_LOCKED');
  const memoryBook = providers.activeBookId();
  const persisted = await db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
  if (!memoryBook || persisted?.value !== memoryBook) throw new Error('NO_ACTIVE_BOOK');
  const sync = await db.first<{ enabled: number }>('SELECT enabled FROM sync_profiles WHERE id=?', [memoryBook]);
  if (sync && Boolean(sync.enabled)) throw new Error('SYNC_PERMISSIONS_UNAVAILABLE');

  const [settings, prefs, config, journal, revision] = await Promise.all([
    providers.readSettings(),
    readV2BookPrefs(db, memoryBook),
    new V2BookConfigRepository(db).getBookConfig(memoryBook),
    db.first<{ count: number; stamp: string }>("SELECT COUNT(*) count,COALESCE(MAX(posted_at),'') stamp FROM v2_journal_entries WHERE book_id=?", [memoryBook]),
    db.first<{ revision: number }>('SELECT COALESCE(MAX(revision),0) revision FROM sync_entity_revisions WHERE book_id=?', [memoryBook]),
  ]);
  const currency = String(settings.currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('SCOPE_CURRENCY_UNKNOWN');
  const timeZone = providers.timeZone();
  if (!timeZone) throw new Error('SCOPE_TIME_ZONE_UNKNOWN');
  const enabledFeatures = getEnabledCapabilities({
    ...settings,
    selectedPersonas: config.selectedPersonas,
    activePersona: config.activePersona,
    enabledFeatures: prefs?.enabledFeatures || [],
  });
  return {
    bookId: memoryBook,
    currency,
    basis: config.basis,
    timeZone,
    today: localDay(providers.now(), timeZone),
    actorId: 'local-owner',
    permissionEpoch: `local-owner:${session.epoch}`,
    featureEpoch: JSON.stringify([...enabledFeatures].sort()),
    revision: `${providers.dataVersion()}:${Number(journal?.count || 0)}:${journal?.stamp || ''}:${Number(revision?.revision || 0)}`,
    activeLocationId: prefs?.activeLocationId?.trim() || null,
    authorizedLocationIds: 'all',
    enabledFeatures,
  };
}

export async function liveBookContext(): Promise<BookContext> {
  assertAssistantSessionReady();
  const db = activeSqlRunner();
  if (!db) throw new Error('SQLITE_NOT_READY');
  return buildLiveBookContext(db, productionProviders);
}

function contextScope(context: BookContext): Scope {
  return {
    bookId: context.bookId, actorId: context.actorId, locationId: context.activeLocationId,
    permissionEpoch: context.permissionEpoch, featureEpoch: context.featureEpoch, revision: context.revision,
    currency: context.currency, basis: context.basis, today: context.today, timeZone: context.timeZone,
  };
}

export function createLiveReportGuard(current: () => Promise<BookContext>): ReportReadGuard {
  return {
    assertCurrent: async expected => { if (!sameScope(expected, contextScope(await current()))) throw new Error('STALE_SCOPE'); },
    canReadReports: async expected => {
      const context = await current();
      return sameScope(expected, contextScope(context)) && (context.enabledFeatures.includes('reporting') || context.enabledFeatures.includes('core_ledger'));
    },
    authorizedLocations: async expected => sameScope(expected, contextScope(await current())) ? 'all' : [],
  };
}
