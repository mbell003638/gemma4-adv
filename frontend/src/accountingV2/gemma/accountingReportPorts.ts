import type { SqlRunner } from '../../db/schema';
import type { Scope } from './agentCore';
import type { BranchDeps } from './branchPorts';
import { createScopedReportReader, type ReportReadGuard } from './scopedReportReader';

/** Bind once per request to its trusted scope. Never obtain a new book midway
 * through the request; guard.assertCurrent must reject stale context. */
export function createAccountingReportPorts(db: SqlRunner, guard: ReportReadGuard, scope: Scope):
  Pick<BranchDeps, 'report' | 'balanceSheetAsOf'> {
  const read = createScopedReportReader(db, guard);
  return {
    report: async (from, to, locations) => {
      const report = await read(scope, { from, to }, locations);
      if (!report.reconciliation.ok) throw new Error('INCONSISTENT_REPORT_DATA');
      return {
        trialBalance: report.trialBalance, profitAndLoss: report.profitAndLoss,
        balanceSheet: report.balanceSheet,
        ...('provisional' in report ? { provisional: report.provisional, provisionalReason: report.provisionalReason } : {}),
      };
    },
    balanceSheetAsOf: async (asOf, locations) => {
      const report = await read(scope, { to: asOf }, locations);
      if ('provisional' in report && report.provisional) throw new Error('PROVISIONAL_LOCATION_COGS');
      return report.balanceSheet;
    },
  };
}
