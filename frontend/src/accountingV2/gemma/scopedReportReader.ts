import type { SqlRunner } from '../../db/schema';
import { buildPersistentV2Reports } from '../persistentReports';
import { withSyncDatabaseMutationLock } from '../../sync/databaseMutex';
import type { Scope } from './agentCore';

export type ReportReadGuard = {
  assertCurrent(scope: Scope): Promise<void>;
  canReadReports(scope: Scope): Promise<boolean>;
  authorizedLocations(scope: Scope): Promise<'all' | readonly string[]>;
};

/** Internal accounting adapter, not a model-visible DTO. The caller must map
 * only explicitly approved report fields into its branch's tool observations. */
export function createScopedReportReader(db: SqlRunner, guard: ReportReadGuard) {
  return async (scope: Scope, range: { from?: string; to: string }, locations: 'all' | readonly string[]) =>
    withSyncDatabaseMutationLock(async () => {
      const check = async () => {
        await guard.assertCurrent(scope);
        if (!await guard.canReadReports(scope)) throw new Error('FORBIDDEN');
        const grants = await guard.authorizedLocations(scope);
        if (locations === 'all') {
          if (grants !== 'all' || scope.locationId !== null) throw new Error('FORBIDDEN');
        } else {
          if (!locations.length || locations.some(id => !id || (grants !== 'all' && !grants.includes(id)))) throw new Error('FORBIDDEN');
          if (scope.locationId !== null && (locations.length !== 1 || locations[0] !== scope.locationId)) throw new Error('FORBIDDEN');
        }
      };
      await check();
      // The authoritative report engine currently supports one location, not a
      // restricted subset aggregate. Never substitute a whole-company report.
      if (locations !== 'all' && locations.length !== 1) throw new Error('MULTI_LOCATION_REPORT_UNAVAILABLE');
      const validDate = (value: string) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(value + 'T00:00:00Z');
        return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
      };
      if (!validDate(range.to) || (range.from !== undefined && (!validDate(range.from) || range.from > range.to))) throw new Error('INVALID_ARGUMENTS');
      const book = await db.first<{ basis: string }>('SELECT basis FROM v2_books WHERE id=?', [scope.bookId]);
      if (!book || book.basis !== scope.basis) throw new Error('STALE_SCOPE');
      const report = await buildPersistentV2Reports(db, {
        bookId: scope.bookId, ...range, ...(locations === 'all' ? {} : { locationId: locations[0] }),
      });
      await check();
      return report;
    });
}

