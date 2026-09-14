import type { SqlRunner } from '../db/schema';
import { V2_TABLES } from '../db/schema';

const yearEnd = (date: string) => `${date.slice(0, 4)}-12-31`;

/**
 * FK-safe children-before-parents wipe order for a FACTORY reset. Covers EVERY
 * v2_* table in the schema (same list v2Backup exports/imports) — the runtime
 * guard in factoryResetV2Data throws if a new table is added to V2_TABLES
 * without being added here.
 */
const V2_FACTORY_DELETE_ORDER: readonly string[] = [
  'v2_bank_feed_entries',
  'v2_budget_lines',
  'v2_audit_events',
  'v2_workflows',
  'v2_sync_queue',
  'v2_recurring_templates',
  'v2_budgets',
  'v2_tax_profiles',
  'v2_sync_state',
  'v2_integrations',
  'v2_trade_costs',
  'v2_production_orders',
  'v2_bom_lines',
  'v2_creator_payouts',
  'v2_project_entries',
  'v2_creator_contracts',
  'v2_boms',
  'v2_marketplace_settlements',
  'v2_marketplace_orders',
  'v2_projects',
  'v2_trade_shipments',
  'v2_payslips',
  'v2_pay_runs',
  'v2_employees',
  'v2_asset_depreciation',
  'v2_fixed_assets',
  'v2_stock_moves',
  'v2_products',
  'v2_locations',
  'v2_journal_lines',
  'v2_invoice_allocations',
  'v2_close_books',
  'v2_inventory_counts',
  'v2_journal_entries', // self-referential reversal_of nulled first
  'v2_sources',
  'v2_members',
  'v2_personas',
  'v2_parties',
  'v2_accounts',
  'v2_periods',
  'v2_books',
];

/**
 * FACTORY reset for the authoritative V2 store: delete ALL rows from EVERY
 * v2_* table (plus the V2 meta keys), atomically. Unlike resetV2AccountingData
 * — which deliberately preserves book identity/configuration for the in-app
 * "clear data" action — this is scorched earth. Leaving the v2_books row behind
 * made onboarding's re-initialization crash with
 * "UNIQUE constraint failed: v2_books.id" after a factory reset.
 */
export async function factoryResetV2Data(db: SqlRunner): Promise<void> {
  const covered = new Set(V2_FACTORY_DELETE_ORDER);
  const missing = (V2_TABLES as readonly string[]).filter((t) => !covered.has(t));
  if (missing.length) throw new Error(`factoryResetV2Data: wipe order is missing table(s): ${missing.join(', ')}`);

  await db.exec('SAVEPOINT v2_factory_reset');
  try {
    await db.run('DELETE FROM assistant_proposals');
    // Clear the self-referential reversal links so ON DELETE RESTRICT on
    // reversal_of cannot reject the wholesale journal delete.
    await db.run('UPDATE v2_journal_entries SET reversal_of=NULL');
    for (const table of V2_FACTORY_DELETE_ORDER) {
      await db.run(`DELETE FROM ${table}`);
    }
    await db.run("DELETE FROM meta WHERE key='v2_active_book_id'");
    await db.run("DELETE FROM meta WHERE key LIKE 'v2_book_version:%'");
    await db.exec('RELEASE SAVEPOINT v2_factory_reset');
  } catch (error) {
    try {
      await db.exec('ROLLBACK TO SAVEPOINT v2_factory_reset');
      await db.exec('RELEASE SAVEPOINT v2_factory_reset');
    } catch { /* preserve the wipe failure */ }
    throw error;
  }
}

/** Permanently remove one non-default book and every authoritative V2 child row. */
export async function deleteV2BookData(db: SqlRunner, bookId: string): Promise<boolean> {
  if (!bookId || bookId === 'default') throw new Error('The main account cannot be deleted.');
  const book = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [bookId]);
  if (!book) return false;

  await db.exec('SAVEPOINT v2_delete_book');
  try {
    await db.run('DELETE FROM assistant_proposals WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_bank_feed_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_budget_lines WHERE budget_id IN (SELECT id FROM v2_budgets WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_audit_events WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_workflows WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sync_queue WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_recurring_templates WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_budgets WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_tax_profiles WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_integrations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sync_state WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_trade_costs WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_production_orders WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_bom_lines WHERE bom_id IN (SELECT id FROM v2_boms WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_creator_payouts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_project_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_creator_contracts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_boms WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_marketplace_settlements WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_marketplace_orders WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_projects WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_trade_shipments WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_payslips WHERE pay_run_id IN (SELECT id FROM v2_pay_runs WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_pay_runs WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_employees WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_asset_depreciation WHERE asset_id IN (SELECT id FROM v2_fixed_assets WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_fixed_assets WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_stock_moves WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_products WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_journal_lines WHERE journal_id IN (SELECT id FROM v2_journal_entries WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_invoice_allocations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_close_books WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_inventory_counts WHERE book_id=?', [bookId]);
    await db.run('UPDATE v2_journal_entries SET reversal_of=NULL WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_journal_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sources WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_locations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_members WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_personas WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_parties WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_accounts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_periods WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_books WHERE id=?', [bookId]);
    await db.run('DELETE FROM meta WHERE key=?', ['v2_book_version:' + bookId]);
    await db.exec('RELEASE SAVEPOINT v2_delete_book');
    return true;
  } catch (error) {
    try {
      await db.exec('ROLLBACK TO SAVEPOINT v2_delete_book');
      await db.exec('RELEASE SAVEPOINT v2_delete_book');
    } catch { /* preserve the deletion failure */ }
    throw error;
  }
}

/** Clear one V2 book's accounting activity while preserving its identity/configuration. */
export async function resetV2AccountingData(db: SqlRunner, bookId: string, periodStart: string) {
  const book = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [bookId]);
  if (!book) return { reset: false, periodId: null };

  const previous = await db.first<{ end_date: string }>(
    "SELECT end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1",
    [bookId],
  );
  const periodEnd = previous?.end_date && previous.end_date >= periodStart ? previous.end_date : yearEnd(periodStart);
  const periodId = `${bookId}:period:${periodStart}`;

  await db.exec('SAVEPOINT v2_reset_book');
  try {
    await db.run('DELETE FROM assistant_proposals WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_bank_feed_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_budget_lines WHERE budget_id IN (SELECT id FROM v2_budgets WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_audit_events WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_workflows WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sync_queue WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_recurring_templates WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_budgets WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_tax_profiles WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_integrations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sync_state WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_trade_costs WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_production_orders WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_bom_lines WHERE bom_id IN (SELECT id FROM v2_boms WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_creator_payouts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_project_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_creator_contracts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_boms WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_marketplace_settlements WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_marketplace_orders WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_projects WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_trade_shipments WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_payslips WHERE pay_run_id IN (SELECT id FROM v2_pay_runs WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_pay_runs WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_employees WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_asset_depreciation WHERE asset_id IN (SELECT id FROM v2_fixed_assets WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_fixed_assets WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_stock_moves WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_products WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_invoice_allocations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_close_books WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_inventory_counts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_journal_lines WHERE journal_id IN (SELECT id FROM v2_journal_entries WHERE book_id=?)', [bookId]);
    // Reversal journals reference their original journal. Clear those links inside
    // this reset transaction before deleting all journals in the book.
    await db.run('UPDATE v2_journal_entries SET reversal_of=NULL WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_journal_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sources WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_members WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_parties WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_periods WHERE book_id=?', [bookId]);
    await db.run(
      'INSERT INTO v2_periods(id,book_id,start_date,end_date,status,close_snapshot) VALUES(?,?,?,?,?,?)',
      [periodId, bookId, periodStart, periodEnd, 'open', null],
    );
    await db.exec('RELEASE SAVEPOINT v2_reset_book');
    return { reset: true, periodId };
  } catch (error) {
    try {
      await db.exec('ROLLBACK TO SAVEPOINT v2_reset_book');
      await db.exec('RELEASE SAVEPOINT v2_reset_book');
    } catch { /* preserve the reset failure */ }
    throw error;
  }
}
/** Clear accounting activity for every V2 book without changing the active-book selection. */
export async function resetAllV2AccountingData(db: SqlRunner, periodStart: string) {
  const books = await db.all<{ id: string }>('SELECT id FROM v2_books ORDER BY id');
  const results = [];
  for (const book of books) results.push(await resetV2AccountingData(db, book.id, periodStart));
  return results;
}
