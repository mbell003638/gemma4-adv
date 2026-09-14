/**
 * SQLite schema + runner contract for the Ledgr data layer.
 * Non-posting document collections remain row-per-record JSON tables; V2 uses
 * normalized tables for books, parties, accounts, periods, sources, journals,
 * and lines.
 */

export interface SqlRunner {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: any[]): Promise<void>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  first<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

export const COLLECTIONS = [
  'suppliers', 'bills', 'sales', 'payments', 'inventoryChecks', 'periods', 'expenses',
  'debtors', 'invoices', 'quotes', 'receipts', 'creditNotes', 'debitNotes', 'deliveryNotes', 'cashEntries',
  'locations', 'posSessions', 'stockTransfers',
] as const;
export type CollectionName = typeof COLLECTIONS[number];
export const SCHEMA_VERSION = 16;

export const V2_TABLES = [
  'v2_books', 'v2_personas', 'v2_parties', 'v2_accounts', 'v2_periods', 'v2_sources',
  'v2_journal_entries', 'v2_journal_lines', 'v2_invoice_allocations', 'v2_inventory_counts',
  'v2_members', 'v2_close_books',
  'v2_employees', 'v2_pay_runs', 'v2_payslips',
  'v2_fixed_assets', 'v2_asset_depreciation',
  'v2_products', 'v2_stock_moves',
  'v2_locations', 'v2_marketplace_orders', 'v2_marketplace_settlements', 'v2_projects', 'v2_project_entries', 'v2_creator_contracts', 'v2_creator_payouts',
  'v2_boms', 'v2_bom_lines', 'v2_production_orders', 'v2_trade_shipments', 'v2_trade_costs',
  'v2_workflows', 'v2_audit_events', 'v2_sync_queue', 'v2_integrations', 'v2_sync_state', 'v2_tax_profiles', 'v2_budgets', 'v2_budget_lines', 'v2_recurring_templates', 'v2_bank_feed_entries',
] as const;

export function schemaSql(): string {
  const documents = COLLECTIONS.map((c) => `
    CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, date TEXT, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_${c}_date ON ${c}(date);`).join('\n');
  return `${documents}
    CREATE TABLE IF NOT EXISTS assistant_proposals (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      entity_versions_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','cancelled','expired')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(book_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_proposals_book_state ON assistant_proposals(book_id, state, created_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS v2_books (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL, basis TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS v2_personas (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
      UNIQUE(book_id, type), FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_parties (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT, roles TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_accounts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, payment_method TEXT, active INTEGER NOT NULL,
      UNIQUE(book_id, code), FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_periods (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL, close_snapshot TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_sources (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, reference TEXT, metadata TEXT,
      location_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id)
    );
    CREATE TABLE IF NOT EXISTS v2_journal_entries (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, source_id TEXT, date TEXT NOT NULL, memo TEXT NOT NULL, posted_at TEXT NOT NULL, reversal_of TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(reversal_of) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT NOT NULL, account_id TEXT NOT NULL, party_id TEXT,
      debit REAL NOT NULL CHECK(typeof(debit) IN ('integer','real') AND debit >= 0),
      credit REAL NOT NULL CHECK(typeof(credit) IN ('integer','real') AND credit >= 0), memo TEXT,
      location_id TEXT,
      CHECK((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
      FOREIGN KEY(journal_id) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES v2_accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(party_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_invoice_allocations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, invoice_source_id TEXT NOT NULL, receipt_source_id TEXT NOT NULL,
      amount REAL NOT NULL CHECK(typeof(amount) IN ('integer','real') AND amount > 0), allocated_at TEXT NOT NULL,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(invoice_source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(receipt_source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_inventory_counts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, date TEXT NOT NULL,
      value REAL NOT NULL CHECK(typeof(value) IN ('integer','real') AND value >= 0),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_members (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL,
      opening_contribution REAL NOT NULL CHECK(typeof(opening_contribution) IN ('integer','real') AND opening_contribution >= 0),
      current_capital REAL NOT NULL CHECK(typeof(current_capital) IN ('integer','real')),
      profit_share_pct REAL NOT NULL CHECK(typeof(profit_share_pct) IN ('integer','real') AND profit_share_pct >= 0 AND profit_share_pct <= 100),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_close_books (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, closed_at TEXT NOT NULL, snapshot TEXT NOT NULL, journal_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(journal_id) REFERENCES v2_journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      UNIQUE(book_id, period_id)
    );
    CREATE TABLE IF NOT EXISTS v2_employees (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
      pay_rate REAL NOT NULL DEFAULT 0, tax_withhold_pct REAL NOT NULL DEFAULT 0,
      start_date TEXT, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_pay_runs (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, period_id TEXT NOT NULL, date TEXT NOT NULL,
      notes TEXT, source_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(period_id) REFERENCES v2_periods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_payslips (
      id TEXT PRIMARY KEY, pay_run_id TEXT NOT NULL, employee_id TEXT NOT NULL,
      gross REAL NOT NULL, tax_withheld REAL NOT NULL, net REAL NOT NULL, notes TEXT,
      FOREIGN KEY(pay_run_id) REFERENCES v2_pay_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(employee_id) REFERENCES v2_employees(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_fixed_assets (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
      acquired_date TEXT NOT NULL, cost REAL NOT NULL, residual REAL NOT NULL DEFAULT 0,
      useful_life_months INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'straight_line',
      disposed INTEGER NOT NULL DEFAULT 0, source_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_asset_depreciation (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, source_id TEXT,
      FOREIGN KEY(asset_id) REFERENCES v2_fixed_assets(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_products (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, sku TEXT, name TEXT NOT NULL, unit TEXT,
      cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_stock_moves (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, product_id TEXT NOT NULL, date TEXT NOT NULL,
      qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL, source_id TEXT,
      location_id TEXT,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(product_id) REFERENCES v2_products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_locations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_marketplace_orders (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, platform TEXT NOT NULL, external_order_id TEXT NOT NULL,
      date TEXT NOT NULL, status TEXT NOT NULL, gross REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
      marketplace_fee REAL NOT NULL DEFAULT 0, shipping_fee REAL NOT NULL DEFAULT 0, refund REAL NOT NULL DEFAULT 0,
      rto_fee REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL, exchange_rate REAL NOT NULL DEFAULT 1,
      source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(book_id, platform, external_order_id),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_marketplace_settlements (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, platform TEXT NOT NULL, settlement_id TEXT NOT NULL,
      date TEXT NOT NULL, payout REAL NOT NULL, currency TEXT NOT NULL, exchange_rate REAL NOT NULL DEFAULT 1,
      settlement_account_id TEXT NOT NULL, source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(book_id, platform, settlement_id),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(settlement_account_id) REFERENCES v2_accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_marketplace_orders_book_date ON v2_marketplace_orders(book_id, date);
    CREATE INDEX IF NOT EXISTS idx_v2_marketplace_settlements_book_date ON v2_marketplace_settlements(book_id, date);
    CREATE TABLE IF NOT EXISTS v2_projects (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, party_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      budget REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(party_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_project_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, book_id TEXT NOT NULL, date TEXT NOT NULL,
      kind TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0, rate REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
      description TEXT, source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(project_id) REFERENCES v2_projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_creator_contracts (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, party_id TEXT, brand TEXT NOT NULL, campaign TEXT NOT NULL,
      agreed_amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', due_date TEXT, status TEXT NOT NULL DEFAULT 'draft',
      source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(party_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_creator_payouts (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, book_id TEXT NOT NULL, date TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', method TEXT NOT NULL DEFAULT 'bank', source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(contract_id) REFERENCES v2_creator_contracts(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_projects_book ON v2_projects(book_id);
    CREATE INDEX IF NOT EXISTS idx_v2_project_entries_project_date ON v2_project_entries(project_id,date);
    CREATE INDEX IF NOT EXISTS idx_v2_creator_contracts_book ON v2_creator_contracts(book_id);
    CREATE INDEX IF NOT EXISTS idx_v2_creator_payouts_contract_date ON v2_creator_payouts(contract_id,date);
    CREATE TABLE IF NOT EXISTS v2_boms (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, product_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '1',
      status TEXT NOT NULL DEFAULT 'active', metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(product_id) REFERENCES v2_products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_bom_lines (
      id TEXT PRIMARY KEY, bom_id TEXT NOT NULL, component_product_id TEXT NOT NULL, quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(bom_id) REFERENCES v2_boms(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(component_product_id) REFERENCES v2_products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_production_orders (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, bom_id TEXT NOT NULL, date TEXT NOT NULL, quantity REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed', total_cost REAL NOT NULL DEFAULT 0, source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(bom_id) REFERENCES v2_boms(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_trade_shipments (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, reference TEXT NOT NULL, date TEXT NOT NULL, direction TEXT NOT NULL,
      supplier_id TEXT, customer_id TEXT, currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1,
      goods_value REAL NOT NULL DEFAULT 0, landed_cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(supplier_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(customer_id) REFERENCES v2_parties(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_trade_costs (
      id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, book_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL,
      amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', exchange_rate REAL NOT NULL DEFAULT 1, capitalized INTEGER NOT NULL DEFAULT 1,
      source_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(shipment_id) REFERENCES v2_trade_shipments(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_boms_product ON v2_boms(product_id);
    CREATE INDEX IF NOT EXISTS idx_v2_production_orders_book_date ON v2_production_orders(book_id,date);
    CREATE INDEX IF NOT EXISTS idx_v2_trade_shipments_book_date ON v2_trade_shipments(book_id,date);
    CREATE INDEX IF NOT EXISTS idx_v2_trade_costs_shipment ON v2_trade_costs(shipment_id);
    CREATE TABLE IF NOT EXISTS v2_workflows (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, action_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', payload TEXT NOT NULL DEFAULT '{}', preview TEXT NOT NULL,
      requested_by TEXT NOT NULL DEFAULT 'user', confidence REAL, created_at TEXT NOT NULL, submitted_at TEXT,
      approved_at TEXT, posted_at TEXT, rejected_at TEXT, source_id TEXT, error TEXT,
      UNIQUE(book_id, idempotency_key),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_audit_events (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, workflow_id TEXT, event_type TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(workflow_id) REFERENCES v2_workflows(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_sync_queue (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(book_id, provider, idempotency_key),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_integrations (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(book_id, provider, kind),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_sync_state (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, provider TEXT NOT NULL, remote_book_id TEXT NOT NULL,
      device_id TEXT NOT NULL, etag TEXT, last_local_hash TEXT, last_sync_at TEXT, status TEXT NOT NULL DEFAULT 'never',
      last_error TEXT, conflict_payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
      UNIQUE(book_id, provider),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_tax_profiles (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, country_code TEXT NOT NULL, tax_label TEXT NOT NULL,
      default_rate REAL NOT NULL DEFAULT 0, registration TEXT, config TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_budgets (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, name TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_budget_lines (
      id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, account_code TEXT NOT NULL, location_id TEXT, amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(budget_id) REFERENCES v2_budgets(id) ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS v2_recurring_templates (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, action_type TEXT NOT NULL, frequency TEXT NOT NULL,
      next_date TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, idempotency_key TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS v2_bank_feed_entries (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
      date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', description TEXT,
      status TEXT NOT NULL DEFAULT 'unmatched', matched_source_id TEXT, raw_metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(book_id, provider, external_id),
      FOREIGN KEY(book_id) REFERENCES v2_books(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY(matched_source_id) REFERENCES v2_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_workflows_book_status ON v2_workflows(book_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_audit_events_book_created ON v2_audit_events(book_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_sync_queue_pending ON v2_sync_queue(book_id,status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_v2_sync_state_book ON v2_sync_state(book_id,provider);
    CREATE INDEX IF NOT EXISTS idx_v2_budget_lines_budget ON v2_budget_lines(budget_id);
    CREATE INDEX IF NOT EXISTS idx_v2_bank_feed_book_date ON v2_bank_feed_entries(book_id,date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_unique_reversal ON v2_journal_entries(reversal_of) WHERE reversal_of IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_v2_journals_book_date ON v2_journal_entries(book_id, date);
    CREATE INDEX IF NOT EXISTS idx_v2_journal_lines_journal ON v2_journal_lines(journal_id);
    CREATE INDEX IF NOT EXISTS idx_v2_sources_book_date ON v2_sources(book_id, date);
    CREATE INDEX IF NOT EXISTS idx_v2_alloc_invoice ON v2_invoice_allocations(invoice_source_id);

    CREATE TABLE IF NOT EXISTS sync_profiles (
      id TEXT PRIMARY KEY, server_url TEXT NOT NULL, user_id TEXT, device_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '', book_epoch TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
      recovery_required INTEGER NOT NULL DEFAULT 0, recovery_reason TEXT, last_sync_at TEXT, last_sync_attempt_at TEXT, last_sync_error TEXT, last_sync_error_at TEXT, oidc_issuer TEXT, oidc_client_id TEXT, oidc_scopes TEXT, protocol_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_device_state (
      book_id TEXT NOT NULL, device_id TEXT NOT NULL, book_epoch TEXT NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(book_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      op_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_epoch TEXT NOT NULL, device_id TEXT NOT NULL,
      device_sequence INTEGER NOT NULL, actor_id TEXT NOT NULL, command_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL, base_revision INTEGER, dependencies TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL, payload_hash TEXT NOT NULL, client_created_at TEXT NOT NULL,
      business_date TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT, last_error TEXT, accepted_book_sequence INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(book_id, device_id, device_sequence)
    );
    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      op_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_sequence INTEGER NOT NULL,
      applied_at TEXT NOT NULL, aggregate_revision INTEGER, apply_mode TEXT NOT NULL DEFAULT 'replayed', resolution_conflict_id TEXT,
      UNIQUE(book_id, book_sequence)
    );
    CREATE TABLE IF NOT EXISTS sync_book_state (
      book_id TEXT PRIMARY KEY, book_epoch TEXT NOT NULL, server_cursor INTEGER NOT NULL DEFAULT 0,
      snapshot_hash TEXT, projection_hash TEXT, last_verified_at TEXT, epoch_number INTEGER,
      epoch_start_sequence INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_entity_revisions (
      book_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(book_id, aggregate_type, aggregate_id)
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, op_id TEXT NOT NULL,
      canonical_op_id TEXT, aggregate_id TEXT, command_type TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      base_payload TEXT, local_payload TEXT NOT NULL, canonical_payload TEXT,
      remote_operation TEXT, blocking_book_sequence INTEGER, canonical_revision INTEGER, resolution_type TEXT,
      resolution_op_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_bootstrap_history (
      snapshot_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, book_epoch TEXT NOT NULL,
      through_sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL, checkpoint_hash TEXT NOT NULL,
      projection_hash TEXT, installed_at TEXT NOT NULL, replay_operation_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS sync_conflict_resolutions (
      resolution_id TEXT PRIMARY KEY, conflict_id TEXT NOT NULL, book_id TEXT NOT NULL,
      resolution_type TEXT NOT NULL, resolution_op_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      book_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      op_id TEXT NOT NULL, book_sequence INTEGER, created_at TEXT NOT NULL,
      PRIMARY KEY(book_id, aggregate_type, aggregate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(book_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_applied_book_seq ON sync_applied_ops(book_id, book_sequence);
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(book_id, status, created_at);
  `;
}

async function addColumnIfMissing(db: SqlRunner, table: string, column: string, definition: string): Promise<void> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function initSchema(db: SqlRunner): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA busy_timeout = 5000;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA wal_autocheckpoint = 1000;');
  await db.exec(schemaSql());
  // Schema 7: add migration-safe location dimensions without deleting existing modules.

  await addColumnIfMissing(db, 'v2_sync_state', 'last_local_hash', 'TEXT');
  await addColumnIfMissing(db, 'v2_sources', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_journal_lines', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_stock_moves', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_inventory_counts', 'location_id', 'TEXT');
  await addColumnIfMissing(db, 'v2_inventory_counts', 'notes', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'device_id', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'actor_id', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'book_epoch', "TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing(db, 'sync_profiles', 'recovery_required', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'sync_profiles', 'recovery_reason', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'last_sync_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'last_sync_attempt_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'last_sync_error', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'last_sync_error_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_issuer', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_client_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_profiles', 'oidc_scopes', 'TEXT');
  await addColumnIfMissing(db, 'sync_applied_ops', 'aggregate_revision', 'INTEGER');
  await addColumnIfMissing(db, 'sync_applied_ops', 'apply_mode', "TEXT NOT NULL DEFAULT 'replayed'");
  await addColumnIfMissing(db, 'sync_applied_ops', 'resolution_conflict_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'projection_hash', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'last_verified_at', 'TEXT');
  await addColumnIfMissing(db, 'sync_book_state', 'epoch_number', 'INTEGER');
  await addColumnIfMissing(db, 'sync_book_state', 'epoch_start_sequence', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'sync_conflicts', 'aggregate_id', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'command_type', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'remote_operation', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'blocking_book_sequence', 'INTEGER');
  await addColumnIfMissing(db, 'sync_conflicts', 'canonical_revision', 'INTEGER');
  await addColumnIfMissing(db, 'sync_conflicts', 'resolution_type', 'TEXT');
  await addColumnIfMissing(db, 'sync_conflicts', 'resolution_op_id', 'TEXT');
  const personaColumns = await db.all<{ name: string }>('PRAGMA table_info(v2_personas)');
  if (!personaColumns.some((column) => column.name === 'active')) {
    await db.exec('ALTER TABLE v2_personas ADD COLUMN active INTEGER NOT NULL DEFAULT 0;');
  }
  const memberColumns = await db.all<{ name: string }>('PRAGMA table_info(v2_members)');
  if (!memberColumns.some((column) => column.name === 'current_capital')) {
    await db.exec('ALTER TABLE v2_members ADD COLUMN current_capital REAL NOT NULL DEFAULT 0;');
    await db.exec('UPDATE v2_members SET current_capital = opening_contribution;');
  }
  await db.run("UPDATE v2_accounts SET name='Capital Accounts' WHERE code='3000' AND name='Member Capital'");
  await db.run("UPDATE v2_accounts SET name='Capital Withdrawals' WHERE code='3100' AND name='Member Drawings'");
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_persona_book_type ON v2_personas(book_id, type);');
  const booksWithoutActivePersona = await db.all<{ book_id: string }>(`SELECT book_id FROM v2_personas
    GROUP BY book_id HAVING SUM(CASE WHEN enabled = 1 AND active = 1 THEN 1 ELSE 0 END) = 0
    AND SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) > 0`);
  for (const { book_id } of booksWithoutActivePersona) {
    const firstPersona = await db.first<{ id: string }>('SELECT id FROM v2_personas WHERE book_id = ? AND enabled = 1 ORDER BY rowid LIMIT 1', [book_id]);
    if (firstPersona) await db.run('UPDATE v2_personas SET active = 1 WHERE id = ?', [firstPersona.id]);
  }
  const row = await db.first<{ value: string }>('SELECT value FROM meta WHERE key = \'schema_version\'');
  if (!row) await db.run('INSERT INTO meta(key, value) VALUES(\'schema_version\', ?)', [String(SCHEMA_VERSION)]);
  else if (Number(row.value) < SCHEMA_VERSION) await db.run('UPDATE meta SET value = ? WHERE key = \'schema_version\'', [String(SCHEMA_VERSION)]);
}
