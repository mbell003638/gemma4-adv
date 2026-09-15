import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) =>
  fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const sourceFilesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });

describe('V2 UI contracts', () => {
  it.each(['ask.tsx', 'voice.tsx'])('%s routes writes through the explicit V2 confirmation gate', (screen) => {
    const source = readApp(screen);

    expect(source).toMatch(/validateAssistantProposal|buildVoiceTransactionDraft|prepareVoiceTransactionDraft/);
    expect(source).toContain('executeAssistantProposal');
    expect(source).toMatch(/executeAssistantProposal\([\s\S]*?\{\s*confirmed:\s*true\s*\}/);
  });

  it('Ask AI does not invoke its write executor directly from the model response', () => {
    const source = readApp('ask.tsx');

    expect(source).not.toContain('await applyAction(action)');
    expect(source).toContain('pendingProposal.action.confirmation.preview');
    expect(source).toContain('applyAction(proposal.action)');
    expect(source).toContain('applyingProposalRef.current');
  });

  it('voice validates the draft before showing confirmation and executes only from the confirm handler', () => {
    const source = readApp('voice.tsx');
    const validationIndex = source.indexOf('await buildVoiceDraft');
    const confirmPhaseIndex = source.indexOf('setPhase("confirm")');
    const confirmHandlerIndex = source.indexOf('const confirmSave');
    const executeIndex = source.indexOf('await executeAssistantProposal', confirmHandlerIndex);

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(confirmPhaseIndex).toBeGreaterThan(validationIndex);
    expect(executeIndex).toBeGreaterThan(confirmHandlerIndex);
  });

  it('voice entry points match the production-safe Ask AI voice workflow', () => {
    const source = readApp('voice.tsx');
    expect(source).toMatch(/await (api\.)?getAIConfig\(\)/);
    expect(source).toContain('await api.transcribe');
    expect(source).not.toContain('config.provider ===');
    expect(source).toContain('Editable voice transcript');
    expect(source).toContain('testID="btn-rebuild-voice-draft"');
    expect(source).toContain('voice-open-provider-settings');
    expect(source).toContain('KeyboardAvoidingView');
    expect(source).toContain('keyboardShouldPersistTaps="handled"');

    const fab = readSource('src/components/VoiceFab.tsx');
    expect(fab).toContain('await api.getAIConfig()');
    expect(fab).toContain('Editable homepage voice transcript');
    expect(fab).toContain('testID="voice-fab-rebuild-draft"');
    expect(fab).toContain('voice-fab-open-provider-settings');
  });

  it('removes Staff and employee-report terminology and routes from production sources', () => {
    const productionFiles = [
      ...sourceFilesUnder(path.join(root, 'app')),
      ...sourceFilesUnder(path.join(root, 'src')),
    ];
    const productionSource = productionFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    expect(fs.existsSync(path.join(root, 'app', '(tabs)', 'employee-report.tsx'))).toBe(false);
    expect(productionSource).not.toMatch(/\bstaff\b/i);
    expect(productionSource).not.toMatch(/employee[- ]report/i);
  });

  it('exposes Custom Report from reports', () => {
    const reports = readApp('(tabs)/reports.tsx');

    expect(reports).toContain('Custom Report');
    expect(reports).toContain('/custom-report');
  });

  it('maps the true v2 profitAndLoss fields into the P&L (no lossy expenses→cogs / netProfit→grossProfit)', () => {
    const reports = readApp('(tabs)/reports.tsx');
    const start = reports.indexOf('const report = core.report');
    const end = reports.indexOf('setTb(', start);
    const v2Block = reports.slice(start, end);

    // COGS and gross profit must come from the engine's real fields, not be aliased
    // to the total-expense or net-profit figures. Displayed net is the partnership
    // overlay (journal net minus unposted manager commission), not a remapped field.
    expect(v2Block).toContain('cogs: report.profitAndLoss.cogs');
    expect(v2Block).toContain('grossProfit: report.profitAndLoss.grossProfit');
    expect(v2Block).toContain('partnershipDisplayFromReports');
    expect(v2Block).toContain('netProfit: profit.netProfit');
    expect(v2Block).toContain('operatingExpenses: profit.operatingExpenses');
    expect(v2Block).not.toContain('cogs: report.profitAndLoss.expenses');
    expect(v2Block).not.toContain('grossProfit: report.profitAndLoss.netProfit');
  });

  it('Settings keeps accounting configuration exclusively in Advanced Settings', () => {
    const source = readApp('(tabs)/settings.tsx');
    const saveStart = source.indexOf('const save = async () =>');
    const saveEnd = source.indexOf('\n  const pickLogo', saveStart);
    const save = source.slice(saveStart, saveEnd);

    expect(save).not.toContain('api.updateV2BookConfig');
    expect(save).toContain('api.updateSettings');
    expect(source).not.toContain('testID="accounting-configuration-summary"');
    expect(source).not.toContain('title="Accounting setup"');
    expect(source).not.toContain('read-only summary');
    expect(source).toContain('Customize Dashboard & Feature Tabs');
    expect(source).not.toContain('const SettingsNavRow');
    expect(source).toContain('backgroundColor: theme.color.surfaceSecondary');
    expect(source).toContain('name="options-outline"');
    expect(source).toContain('padding: 16');
    expect(source).toContain('accessibilityLabel="Customize Dashboard & Feature Tabs"');
    expect(source).not.toContain('Accounting Style</Text>');
    expect(source).not.toContain('Accounting Basis</Text>');
    expect(source).toContain('router.push("/advanced-settings")');
    expect(source).not.toMatch(/onPress=\{\(\) => setAccountingStyle/);
    expect(source).not.toMatch(/onPress=\{\(\) => setAccountingBasis/);
    const advanced = readApp('advanced-settings.tsx');
    expect(advanced).toContain('Accounting & Workflow');
    expect(advanced).toContain('Accounting Basis');
    expect(advanced).toContain('Accounting Style');
    expect(advanced).toContain('api.updateV2BookConfig');
    expect(advanced).toContain('styles.advancedGroup');
    expect(advanced).toContain('const AdvancedNavRow');
    expect(advanced).toContain('backgroundColor: "transparent"');
    expect(advanced).toContain('restingBorderColor="transparent"');
    expect(advanced).not.toContain('Bank Statement Preview');
    expect(advanced).not.toContain('scan-import');
    expect(advanced).toContain('Book Health');
    expect(advanced).toContain('Self-hosted Sync');
    expect(advanced).not.toContain('HostingModeCard');
    expect(advanced).toContain('ON · Fingerprint / PIN');
    expect(advanced).toContain('backgroundColor: "transparent"');
    expect(advanced).toContain('lineHeight: 18');
    const sync = readApp('sync-settings.tsx');
    expect(sync).toContain('padding: 16, gap: 12');
    expect(sync).toContain('marginBottom: 2');
    const theme = readSource('src/theme.ts');
    expect(theme).toContain("muted: '#A0AAA2'");
    expect(theme).toContain("muted: '#ADB5CC'");
    const voiceFab = readSource('src/components/VoiceFab.tsx');
    expect(voiceFab).toContain('bottom: 112');
  });

  it('all shared report and transaction documents support mobile and print layouts', () => {
    const custom = readSource('src/utils/customReportDocument.ts');
    const monthly = readSource('src/utils/reportDocument.ts');
    const statement = readSource('src/utils/statementDocument.ts');
    const transaction = readSource('src/utils/transactionActions.ts');
    expect(custom).toContain('@media screen and (max-width: 600px)');
    expect(custom).toContain('body { padding: 0 !important; }');
    expect(custom).toContain('.tb-table { break-inside: auto;');
    expect(monthly).toContain('@media screen and (max-width: 600px)');
    expect(monthly).toContain('.body-grid { display: block; }');
    expect(statement).toContain('@media screen and (max-width:600px)');
    expect(statement).toContain('.columns{grid-template-columns:1fr}');
    expect(transaction).toContain('@media screen and (max-width: 600px)');
    expect(transaction).toContain('@page { size: A4 portrait; margin: 10mm; }');
    expect(transaction).toContain('table { break-inside: auto;');
  });

  it('onboarding has one multi-location control and asks for the accounting model', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('I operate multiple stores or POS points');
    expect(onboarding).toContain('setMultiLocation');
    expect(onboarding).toContain('item.key !== "multi_location"');
    expect(onboarding).toContain('testID="onboarding-accounting-standard"');
    expect(onboarding).toContain('testID="onboarding-accounting-equity-split"');
    expect(onboarding).toContain('style: accountingStyle');
    expect(onboarding).toContain('enabled: accountingStyle === "retail_partnership"');
  });

  it('keeps preferences free of accounting state and uses V2 as the single source', () => {
    const local = readSource('src/db/local.ts');
    const opening = readSource('src/components/OpeningBalancesModal.tsx');
    const settings = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const onboarding = readApp('onboarding.tsx');

    for (const key of [
      'openingCash', 'openingInventory', 'openingCapital', 'investors', 'partnerNames',
      'extraAssets', 'extraLiabilities', 'accountingStyle', 'accountingBasis',
      'selectedPersonas', 'activePersona',
    ]) expect(local).toContain(`'${key}'`);
    expect(local).toContain('Object.entries(partial).filter(([key]) => !ACCOUNTING_SETTING_KEYS.has(key))');
    expect(local).not.toContain('clearAccountingSettings');
    expect(opening).not.toContain('api.updateSettings({');

    for (const source of [settings, advanced, onboarding]) {
      const preferenceWrites = source.match(/api\.updateSettings\(\{[\s\S]*?\}\)/g) || [];
      for (const write of preferenceWrites) {
        expect(write).not.toMatch(/\b(?:openingCash|openingInventory|openingCapital|investors|partnerNames|accountingStyle|accountingBasis|selectedPersonas|activePersona)\s*:/);
      }
    }
  });

  it('exposes flexible-by-default and optional fixed period controls, and passes the reviewed close date explicitly', () => {
    const advanced = readApp('advanced-settings.tsx');
    const inventory = readApp('inventory-form.tsx');

    for (const testId of ['period-policy-flexible', 'period-policy-fixed', 'period-fixed-start', 'period-fixed-end']) {
      expect(advanced).toContain(`testID="${testId}"`);
    }
    expect(advanced).toContain('Flexible (Recommended)');
    expect(advanced).toContain('No assumed year-end');
    expect(advanced).toMatch(/periodPolicy:\s*periodMode === "fixed"[\s\S]*?\{ mode: "flexible" \}/);

    expect(inventory).toContain('testID="active-period-policy"');
    expect(inventory).toContain('testID="input-close-date"');
    expect(inventory).toContain('Close whenever you are ready');
    expect(inventory).toContain('Permanent action: entries through the closing date will be locked');
    expect(inventory).toContain('editable={periodPolicy.mode !== "fixed"}');
    expect(inventory).toContain('await api.closePeriod(act, notes, pct, closingIso)');
  });

  it('wires TransactionDetail into core production transaction screens with all action callbacks', () => {
    for (const screen of ['sales.tsx', 'invoices.tsx', 'receipts.tsx', '(tabs)/bills.tsx']) {
      const source = readApp(screen);
      expect(source).toContain('TransactionDetail');
      expect(source).toContain('onEdit=');
      expect(source).toContain('onReversalDelete=');
      expect(source).toContain('onShare=');
      expect(source).toContain('onPrint=');
      expect(source).toContain('onMore=');
    }
  });

  it('provides a shared accessible TransactionDetail action contract', () => {
    const source = readSource('src/components/TransactionDetail.tsx');

    expect(source).toContain('export function TransactionDetail');
    expect(source).toContain('accessibilityRole="button"');
    expect(source).toContain('accessibilityLabel={label}');
    expect(source).toMatch(/accessibilityState=\{\{\s*disabled:/);
    for (const action of ['Edit', 'Reversal/Delete', 'Share', 'Print', 'More']) {
      expect(source).toContain(`label: "${action}"`);
    }
  });

  it('exposes a shared FormCard entry-form grammar', () => {
    const source = readSource('src/components/FormCard.tsx');
    expect(source).toContain('export function FormCard');
    expect(source).toContain('export function FormField');
    expect(source).toContain('export function FormActions');
  });

  it.each(['investor/[id].tsx', 'inventory-form.tsx', 'assets.tsx'])(
    '%s adopts the shared FormField/FormActions entry grammar',
    (screen) => {
      const source = readApp(screen);
      expect(source).toMatch(/from ['"]@\/src\/components\/FormCard['"]/);
      expect(source).toContain('FormField');
      expect(source).toContain('FormActions');
    }
  );

  it('onboarding writes persona selection to the authoritative V2 book configuration', () => {
    const source = readApp('onboarding.tsx');
    expect(source).toMatch(/initializeV2Book\([\s\S]*?personas:\s*v2Personas/);
    const preferences = source.slice(source.indexOf('await api.updateSettings({'), source.indexOf('markOnboarded();'));
    expect(preferences).not.toMatch(/selectedPersonas|activePersona/);
    expect(preferences).toContain("enabledFeatures: null");
    expect(preferences).toContain("enabledCapabilities: selectedCapabilities");
  });

  it('the dashboard keeps financial cards and the original Quick Workspace shortcuts without backup notices or workspace metrics', () => {
    const source = readApp('(tabs)/index.tsx');
    expect(source).not.toContain('Action needed');
    expect(source).not.toContain('Workspace metrics');
    expect(source).toContain('KpiTile label="Sales"');
    expect(source).toContain('KpiTile label="Purchases"');
    expect(source).toContain('locationId');
    expect(source).toContain('Quick Workspaces');
    expect(source).toContain('Hold any tile to organize &amp; sort');
    expect(source).not.toContain('Featured tools');
    expect(source).toContain('ReorderableWorkspaceGrid');
    expect(source).toContain('workflowTilesFor(settings)');
    expect(source).toContain('onOrderChange={moveTile}');
    expect(source).toContain('BackHandler.addEventListener("hardwareBackPress"');
    expect(source).toContain('if (Platform.OS === "web" || !isEditingGrid) return;');
    expect(source).toContain('setIsEditingGrid(false);');
    expect(source).toContain('return true;');
  });

  it('normalizes the Scan Receipt quick action and restores the AI group divider', () => {
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const aiStart = quick.indexOf('styles.aiAction');
    const aiBlock = quick.slice(aiStart - 420, aiStart + 700);
    expect(aiBlock).toContain('topHighlight={false}');
    expect(aiBlock).toContain('clipSafe');
    expect(aiBlock).toContain('styles.aiAction');
    expect(aiBlock).toContain('sparkles-outline');
    expect(aiBlock).not.toContain('prominent');
    expect(aiBlock).not.toContain('LinearGradient');
    expect(aiBlock).not.toContain('textShadow');

    const advanced = readApp('advanced-settings.tsx');
    expect(advanced).toMatch(/<AccordionRow title="AI Provider" subtitle=\{selectedProviderTitle\} theme=/);
    expect(advanced).toMatch(/<AccordionRow title="AI Data & History"[\s\S]*?isLast theme=/);
  });

  it('keeps the Preferences divider between Invoice PDF Preset and Animations & haptics', () => {
    const settings = readApp('(tabs)/settings.tsx');
    expect(settings).toMatch(/<AccordionRow title="Invoice PDF Preset"[\s\S]*?theme=\{theme\} expandedKey=/);
    expect(settings).toMatch(/<AccordionRow title="Animations & haptics"[\s\S]*?isLast theme=\{theme\}/);
    const invoiceStart = settings.indexOf('title="Invoice PDF Preset"');
    const animationStart = settings.indexOf('title="Animations & haptics"');
    expect(invoiceStart).toBeGreaterThan(-1);
    expect(animationStart).toBeGreaterThan(invoiceStart);
    expect(settings.slice(invoiceStart, animationStart)).not.toContain('isLast');
  });

  it('all location-aware financial forms preserve location context across edit and save', () => {
    const forms = ['sale-form.tsx', 'bill-form.tsx', 'invoices.tsx', 'payment-form.tsx', 'receipt-form.tsx', 'expenses.tsx'];
    for (const form of forms) {
      const source = readApp(form);
      if (form === 'sale-form.tsx') expect(source).toContain('Location / POS');
      else expect(source).toContain('LocationPicker');
      expect(source).toContain('locationId');
      expect(source).toMatch(/setLocationId\([\s\S]*locationId/);
      expect(source).toMatch(/(?:finalLocationId\s*\?\s*\{[\s\S]*locationId|locationEnabled\s*&&\s*locationId\s*\?\s*\{\s*locationId)/);
    }
    const picker = readSource('src/components/LocationPicker.tsx');
    expect(picker).toContain('locations.length === 1');
    expect(picker).toContain('Choose a location before saving this entry.');
    expect(picker).toContain('locations.some((location) => location.id === requested)');
    expect(picker).toContain('minHeight: 44');
  });

  it('dashboard daily-summary card and KPI tiles share the hero GlowPressable press treatment', () => {
    const dashboard = readApp('(tabs)/index.tsx');
    const ui = readSource('src/components/UI.tsx');

    // Daily-summary card is a pressable surface with the hero's exact treatment.
    expect(dashboard).toMatch(
      /<GlowPressable[^>]*\n(?:[^>]*\n)*?\s*testID="daily-card-press"[\s\S]*?pressScale=\{0\.972\}[\s\S]*?onPress=\{\(\) => router\.push\("\/daybook"\)\}/
    );
    const dailyPressStart = dashboard.indexOf('testID="daily-card-press"');
    const dailyPress = dashboard.slice(dailyPressStart, dailyPressStart + 900);
    expect(dailyPress).toContain('accessibilityLabel="Open Day Book daily summary"');
    expect(dailyPress).toContain('haptic={false}');
    expect(dailyPress).toContain('clipSafe');
    expect(dailyPress).toContain('pressScale={0.972}');

    // Hero card uses the same press depth (the reference treatment).
    const heroStart = dashboard.indexOf('function AnimatedHeroCard');
    const hero = dashboard.slice(heroStart, dashboard.indexOf('export default function Dashboard'));
    expect(hero).toContain('GlowPressable');
    expect(hero).toContain('pressScale={0.972}');

    // KPI tiles render through GlowPressable with the identical press depth.
    const kpiStart = ui.indexOf('export function KpiTile');
    const kpi = ui.slice(kpiStart, ui.indexOf('export function Row'));
    expect(kpi).toContain('<GlowPressable');
    expect(kpi).toContain('pressScale={0.972}');
    expect(kpi).toContain('haptic');
  });

  it('liability defaults to due/accrued treatment and static mode removes the customization accent', () => {
    const assets = readApp('assets.tsx');
    const settings = readApp('(tabs)/settings.tsx');
    expect(assets).toContain('useState<(typeof liabilityRecognition)[number]["id"]>("expense")');
    expect(assets).toContain('Due / accrued expense');
    expect(assets).toContain('Cash received (loan)');
    expect(settings).not.toContain('const SettingsNavRow');
    expect(settings).toContain('restingBorderColor={theme.color.border}');
    expect(settings).toContain('hoverBorderColor={theme.color.brandPrimary}');
    expect(settings).toContain('onPress={() => router.push("/customize-features")}');
  });
  it('keeps responsive layout additive and phone-first across device classes', () => {
    const responsive = readSource('src/hooks/useResponsiveDevice.ts');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    const reports = readApp('(tabs)/reports.tsx');
    const sync = readApp('sync-settings.tsx');
    expect(responsive).toContain('const compactPhone = shortestSide < 360');
    expect(responsive).toContain('const tablet = shortestSide >= 600');
    expect(responsive).toContain('const wide = width >= 900');
    expect(responsive).toContain('const fold = useFoldPosture()');
    expect(responsive).toContain('dualPane: fold.dualPane');
    expect(responsive).toContain('hingeRect: fold.hingeRect');
    const foldPosture = readSource('src/hooks/foldPosture.ts');
    expect(foldPosture).toContain('UNKNOWN_FOLD_POSTURE');
    expect(foldPosture).toContain('configureFoldPostureAdapter');
    expect(foldPosture).toContain('dualPane: false');
    expect(workspace).toContain('const PHONE_COLUMNS = 2');
    expect(workspace).toContain('const columns = gridWidth >= 900 ? WIDE_COLUMNS : gridWidth >= 600 ? TABLET_COLUMNS : PHONE_COLUMNS');
    expect(workspace).toContain('onLayout={(event) => {');
    expect(workspace).toContain('columns={columns}');
    expect(reports).toContain('compactPhone && styles.summaryColumnsCompact');
    expect(reports).toContain('summaryColumnCompact');
    expect(sync).toContain('<ScreenHeader compact={compactPhone}');
  });
  it('input forms keep their fields reachable above the mobile keyboard', () => {
    const investor = readApp('investor/[id].tsx');
    const openingBalances = readSource('src/components/OpeningBalancesModal.tsx');
    const cashbook = readApp('cashbook.tsx');
    const customer = readApp('customer/[id].tsx');
    const supplier = readApp('supplier/[id].tsx');

    expect(investor).toContain("behavior={Platform.OS === 'ios' ? 'padding' : 'height'}");
    expect(investor).toContain('keyboardShouldPersistTaps="handled"');
    expect(investor).toContain("maxHeight: '88%'");
    expect(openingBalances).toContain('KeyboardAvoidingView');
    expect(openingBalances).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(openingBalances).toContain('keyboardShouldPersistTaps="handled"');
    expect(openingBalances).toContain('function OpeningTextInput');
    expect(openingBalances).toContain('outlineStyle: "none"');
    expect(openingBalances).toContain('borderRadius: theme.radius.input');
    expect(cashbook).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(customer).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(supplier).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
  });
  it('opening assets and liabilities use named dynamic rows', () => {
    const openingBalances = readSource('src/components/OpeningBalancesModal.tsx');
    expect(openingBalances).toContain('addOtherAsset');
    expect(openingBalances).toContain('Add Other Asset');
    expect(openingBalances).toContain('addOpeningLiability');
    expect(openingBalances).toContain('Add Liability');
    expect(openingBalances).toContain('Supplier / Creditor');
    expect(openingBalances).toContain('Other Liability');
    expect(openingBalances).toContain('liabilityBreakdown');
  });
  it('exposes safe corrections for scanned opening sets, capital, assets, and custom report ranges', () => {
    const assets = readApp('assets.tsx');
    const investor = readApp('investor/[id].tsx');
    const cashbook = readApp('cashbook.tsx');
    const inventory = readApp('inventory-form.tsx');
    const reports = readApp('(tabs)/reports.tsx');

    expect(assets).toContain('Opening Assets & Liabilities');
    expect(assets).toContain('edit-opening-balance-set');
    expect(assets).toContain('updateManualBalanceTransaction');
    expect(investor).toContain('updateInvestorCapital');
    expect(investor).toContain('deleteInvestorCapital');
    expect(cashbook).toContain('Number(opening?.cash || 0)');
    expect(cashbook).not.toContain('settings.openingCash');
    expect(inventory).toContain('opening?.inventory ?? v2?.openingInventory');
    expect(inventory).not.toContain('settings.openingInventory');
    expect(reports).toContain('const [customFrom');
    expect(reports).toContain('The From date must be on or before the To date');
    expect(reports).toContain('Applying custom range');
  });
  it('loads the report core first, normalizes capital data, and lazy-loads secondary segments', () => {
    const reports = readApp('(tabs)/reports.tsx');
    const coreLoad = reports.slice(reports.indexOf('const load = useCallback'), reports.indexOf('const loadSection'));

    expect(coreLoad).toContain('v2Reports({ from, to, locationId: shopId })');
    expect(coreLoad).toContain('api.dashboard(shopId)');
    expect(coreLoad).not.toContain('api.balanceSheet()');
    expect(coreLoad).not.toContain('api.monthlyProfitTrend');
    expect(coreLoad).not.toContain('api.creditorsReport');
    expect(reports).toContain('normalizeCapitalStatement');
    expect(reports).toContain('Array.isArray(value?.investors)');
    expect(reports).toContain('Array.isArray(value?.rows) ? value.rows : []');
    expect(reports).toContain('loadedVersion.current === getDataVersion()');
  });
  it('opens each balance editor in its owning context and keeps full review explicit', () => {
    const modal = readSource('src/components/OpeningBalancesModal.tsx');
    expect(readApp('cashbook.tsx')).toContain('mode="cash"');
    expect(readApp('inventory-form.tsx')).toContain('mode="inventory"');
    expect(readApp('assets.tsx')).toContain('mode="assets_liabilities"');
    expect(readApp('investor/[id].tsx')).toContain('mode="investor"');
    expect(modal).toContain('Review complete opening set');
    expect(modal).toContain('const showCash =');
    expect(modal).toContain('const showInventory =');
    expect(modal).toContain('const showAssetsLiabilities =');
    expect(modal).toContain('if (Math.abs(openingAssets - openingCredits) > 0.005)');
  });
  it('lists named opening assets and liabilities in their corresponding current-balance cards', () => {
    const assets = readApp('assets.tsx');
    expect(assets).toContain('openingAssetEntries');
    expect(assets).toContain('openingCreditorEntries');
    expect(assets).toContain('openingLiabilityEntries');
    expect(assets).toContain('total={otherAssetsTotal}');
    expect(assets).toContain('total={creditorsTotal}');
    expect(assets).toContain('total={otherLiabilitiesTotal}');
    expect(assets).toContain('entry.origin === "opening"');
  });
  it('shows investor actions when Equity Split is configured or investor ledgers already exist', () => {
    const parties = readApp('(tabs)/suppliers.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');
    expect(parties).toContain('partnerConfigured || investors.length > 0');
    expect(parties).toContain("['all', 'customer', 'supplier', 'partner']");
    expect(quick).toContain('config?.style === "retail_partnership" || investors.length > 0');
    expect(quick).toContain('Add Account');
  });
  it('disables motion and haptics together and follows the device Reduce Motion setting', () => {
    const context = readSource('src/context/ThemeContext.tsx');
    const glow = readSource('src/components/GlowPressable.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const tabs = readApp('(tabs)/_layout.tsx');
    expect(context).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(context).toContain("addEventListener('reduceMotionChanged'");
    expect(context).toContain('const hapticsEnabled = motionEnabled');
    expect(glow).toContain('if (!motionEnabled)');
    expect(quick).toContain('if (hapticsEnabled && Platform.OS !== "web")');
    expect(quick).toContain('quickActionMenuMaxHeight(windowHeight, insets.top, insets.bottom)');
    expect(quick).toContain('actionDetails: { flex: 1, minWidth: 0 }');
    expect(quick).toContain('accessibilityLabel="Open Quick Actions"');
    expect(tabs).toContain('if (hapticsEnabled && Platform.OS !== "web")');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    const glass = readSource('src/components/AnimatedGlassSurface.tsx');
    const voiceFab = readSource('src/components/VoiceFab.tsx');
    expect(workspace).toContain('!motionEnabled && (Platform.OS === "web"');
    expect(workspace).toContain('boxShadow: "none"');
    expect(workspace).toContain('isWeb && motionEnabled');
    expect(glow).toContain('boxShadow: "none"');
    expect(glass).toContain('boxShadow: "none"');
    expect(voiceFab).toContain('backgroundColor: theme.color.brandPrimary');
    expect(voiceFab).toContain('color={theme.color.onBrandPrimary}');
  });
  it.each(['customer/[id].tsx', 'supplier/[id].tsx'])('%s renders and edits debit / credit notes', (screen) => {
    const source = readApp(screen);
    expect(source).toContain(`${screen.startsWith('customer') ? 'r' : 't'}.kind === "credit_note"`);
    expect(source).toContain('debit_note');
    expect(source).toContain('api.updateNote');
    expect(source).toContain('api.deleteNote');
    expect(source).toContain('trash-outline');
    expect(source).toContain('onRequestClose={closeNote}');
  });
  it('keeps Ask AI history per business book, exposes clear history, and avoids the stuck Android keyboard layout', () => {
    const source = readApp('ask.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(source).toContain('AsyncStorage.getItem(historyKey)');
    expect(source).toContain('askHistoryStorageKey(api.activeBookId())');
    expect(source).toContain('AsyncStorage.setItem(historyKey, JSON.stringify(normalizeAskHistory(next)))');
    expect(source).toContain('AsyncStorage.removeItem(historyKey)');
    expect(source).toContain('if (!rememberHistory)');
    expect(source).toContain('Clear Ask AI history');
    expect(source).toContain('enabled={Platform.OS === "ios"}');
    expect(source).toContain('behavior={Platform.OS === "ios" ? "padding" : undefined}');
    expect(source).not.toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(source).toContain('testID="ask-pending-action-card"');
    expect(source).toContain('submitBehavior="submit"');
    // Reading `input` from the render closure dropped the IME's last word when
    // the send button blurred the field, so the ref is the source of truth.
    expect(source).toContain('onSubmitEditing={() => send(inputRef.current)}');
    expect(source).toContain('onChangeText={updateInput}');
    expect(source).not.toContain('send(input)');
    expect(source).toContain('keyboardDismissMode="on-drag"');
    expect(source).toContain('setKeyboardHeight(height)');
    expect(source).toContain('composerBottomPad');
    expect(source).toContain('Platform.OS === "android" ? keyboardHeight : 0');
    expect(advanced).toContain('toggleAiRememberHistory');
    expect(advanced).toContain('AsyncStorage.removeItem(askHistoryStorageKey(api.activeBookId()))');
    expect(appConfig.expo.android.softwareKeyboardLayoutMode).toBe('resize');
    expect(appConfig.expo.android.edgeToEdgeEnabled).toBe(true);
  });
  it('offers scan retry controls and explains automatic transient retries', () => {
    const source = readApp('scan-import.tsx');
    const ai = readSource('src/db/ai.ts');
    expect(source).toContain('testID="btn-retry-analysis"');
    expect(source).toContain('Retry same document');
    expect(source).toContain('quality: 0.7');
    expect(ai).toContain('TRANSIENT_AI_STATUSES');
    expect(ai).toContain('AI_REQUEST_TIMEOUT_MS = 60_000');
    expect(ai).toContain('The prior extraction response was not valid JSON');
  });
  it('quick sales persist standardized units and optional fixed discounts', () => {
    const sale = readApp('sale-form.tsx');
    expect(sale).toContain('placeholder="Unit"');
    expect(sale).toContain('unit: l.unit.trim()');
    expect(sale).toContain('input-sale-discount');
    expect(sale).toContain('discount: totals.discount');
    expect(sale).toContain('editable={lines.length === 0}');
  });
  it('invoice and sale edit paths do not create a party immediately before updateInvoice', () => {
    const invoices = readApp('invoices.tsx');
    const sale = readApp('sale-form.tsx');
    const saveInvoice = invoices.slice(invoices.indexOf('const saveInvoice = async () =>'), invoices.indexOf('const markPaid'));
    const saveSale = sale.slice(sale.indexOf('const save = async () =>'), sale.indexOf('const remove = async () =>'));

    expect(saveInvoice).toContain('findOrCreateParty');
    expect(saveInvoice).toMatch(/if\s*\(\s*!editId\s*\)[\s\S]*?findOrCreateParty/);
    const invoiceEdit = saveInvoice.slice(saveInvoice.indexOf('if (editId)'), saveInvoice.indexOf('else await api.createInvoice'));
    expect(invoiceEdit).toContain('updateInvoice');
    expect(invoiceEdit).not.toMatch(/findOrCreateParty|ensureParty/);

    expect(saveSale).toContain('findOrCreateParty');
    expect(saveSale).toMatch(/if\s*\(\s*!editId[\s\S]*?findOrCreateParty/);
    const saleEdit = saveSale.slice(saveSale.indexOf('if (editId)'), saveSale.indexOf('} else if (saleType === "cash")'));
    expect(saleEdit).toContain('updateInvoice');
    expect(saleEdit).not.toMatch(/findOrCreateParty|ensureParty/);
  });
  it('customize-features resets to the multi-persona baseline and persists a manual override', () => {
    const source = readApp('customize-features.tsx');
    const capabilities = readSource('src/utils/capabilities.ts');
    const products = readApp('products.tsx');
    expect(source).toContain('getPersonaBaselineFeatures');
    expect(source).toMatch(/updateSettings\(\{\s*enabledFeatures/);
    expect(capabilities).toContain("key: 'live_product_stock'");
    expect(capabilities).toContain("featureKeys: ['perpetualInventory']");
    expect(source).toContain('CAPABILITIES.filter');
    expect(capabilities).toContain("label: 'Live Product Stock'");
    expect(products).toContain('Turn on in Customize Features');
    expect(products).toContain('perpetualInventory');
  });

  it('Quick Action Create Invoice opens the invoices modal, not sale-form', () => {
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const invoices = readApp('invoices.tsx');
    expect(quick).toContain('title="Create Invoice"');
    expect(quick).toContain('pathname: "/invoices"');
    expect(quick).toContain('action: "create"');
    expect(quick).toContain('title="Log Sale"');
    expect(quick).toContain('navigate("/sale-form")');
    expect(invoices).toContain('params.action !== "create"');
    expect(invoices).toContain('setSelected(null)');
    expect(invoices).toContain('api.getSettings()');
  });

  it('overdueInvoices compares due dates to localTodayIso, not a UTC slice', () => {
    const apiSrc = readSource('src/api.ts');
    const localSrc = readSource('src/db/local.ts');
    expect(apiSrc).toMatch(/overdueInvoices:[\s\S]*dueDate < localTodayIso\(\)/);
    expect(apiSrc).not.toMatch(/overdueInvoices:[\s\S]*toISOString\(\)\.slice\(0,\s*10\)/);
    expect(localSrc).toMatch(/export async function overdueInvoices\(\)[\s\S]*localTodayIso\(\)/);
  });

  it('restores the Gemini / Custom AI picker with gated dialect pills and Base URL', () => {
    const advanced = readApp('advanced-settings.tsx');

    expect(advanced).toContain('Google Gemini');
    expect(advanced).toContain('voice-transcription-model');
    expect(advanced).toContain('voice-transcription-base-url');
    expect(advanced).toContain('voice-transcription-api-key');
    expect(advanced).toContain('vision-model');
    expect(advanced).toContain('hasCustomVoiceHost');
    expect(advanced).toContain('I trust these custom chat, OCR, and voice hosts');
    expect(advanced).toContain('Anthropic has no speech endpoint.');
    expect(advanced).toContain('Custom Provider');
    expect(advanced).toContain('OpenAI Compatible');
    expect(advanced).toContain('Anthropic Compatible');

    const pickerStart = advanced.indexOf('title="AI Provider"');
    const apiKeyStart = advanced.indexOf('API Key', pickerStart);
    const picker = advanced.slice(pickerStart, apiKeyStart);
    expect(pickerStart).toBeGreaterThanOrEqual(0);
    expect(apiKeyStart).toBeGreaterThan(pickerStart);

    // Primary picker is two explicit pills, not PROVIDERS.map over every dialect.
    // Unused leftover styles (providerTileRow) are allowed; the JSX must not map them.
    expect(picker).toContain('Google Gemini');
    expect(picker).toContain('Custom Provider');
    expect(picker).not.toMatch(/PROVIDERS\.map\s*\(/);
    expect(picker).not.toMatch(/PROVIDER_MARK\s*\[/);

    // Dialect pills appear only for custom (openai / anthropic) providers.
    const customClick =
      /if\s*\(\s*provider === ["']gemini["']\s*\)\s*(?:chooseProvider|setProvider)\(\s*["']openai["']\s*\)/.test(advanced);
    const dialectGate =
      /isCustomProvider/.test(picker) ||
      /provider === ["']openai["']\s*\|\|\s*provider === ["']anthropic["']/.test(picker) ||
      /provider !== ["']gemini["']/.test(picker);
    expect(customClick || dialectGate).toBe(true);
    expect(picker).toContain('OpenAI Compatible');
    expect(picker).toContain('Anthropic Compatible');

    const baseUrlIdx = advanced.indexOf('>Base URL</Text>', apiKeyStart);
    expect(baseUrlIdx).toBeGreaterThan(apiKeyStart);
    const baseUrlGate = advanced.slice(Math.max(0, baseUrlIdx - 240), baseUrlIdx);
    expect(baseUrlGate).toMatch(
      /isCustomProvider|provider === ["']openai["']\s*\|\|\s*provider === ["']anthropic["']|provider !== ["']gemini["']/,
    );
  });

  it('Ask AI lifts Android by keyboard height', () => {
    const source = readApp('ask.tsx');
    expect(source).toContain('keyboardDidShow');
    expect(source).toMatch(/endCoordinates|keyboardHeight/);
  });

  it('VoiceFab lifts dock above keyboard when typing in draft clarification', () => {
    const fab = readSource('src/components/VoiceFab.tsx');
    expect(fab).toContain('keyboardDidShow');
    expect(fab).toMatch(/endCoordinates|keyboardHeight/);
    expect(fab).toContain('dockBottom');
    expect(fab).toContain('maxDockHeight');
  });

  it('remaining operational entry points preserve capability and location context', () => {
    const voice = readSource('src/components/VoiceFab.tsx');
    const voiceOrb = readSource('src/components/VoiceOrb.tsx');
    const glassSurface = readSource('src/components/AnimatedGlassSurface.tsx');
    const glowPressable = readSource('src/components/GlowPressable.tsx');
    const capabilities = readSource('src/utils/capabilities.ts');
    const home = readApp('(tabs)/index.tsx');
    const transfers = readApp('stock-transfers.tsx');
    const delivery = readApp('delivery-notes.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const rootLayout = readApp('_layout.tsx');
    const ai = readSource('src/db/ai.ts');
    const apiFacade = readSource('src/api.ts');
    const advanced = readApp('advanced-settings.tsx');

    expect(voice).toContain('loadLocationsIfEnabled');
    expect(voice).toContain('locationFields');
    expect(voice).toContain('Voice inventory counts are book-level');
    expect(transfers).not.toContain('activeLocations[0]?.id');
    expect(transfers).not.toContain('activeLocations[1]?.id');
    expect(delivery).toContain('LocationPicker');
    expect(delivery).toContain('finalLocationId');
    expect(quick).toContain('isCapabilityEnabled(settings, "ai_assistant") && <QuickActionRow');
    expect(voice).toContain('isCapabilityEnabled(settings, "ai_assistant")');
    expect(voice).toContain('styles.voiceDock');
    expect(voice).not.toContain('<Modal');
    expect(voiceOrb).toContain('withRepeat');
    expect(voiceOrb).toContain('motionEnabled');
    expect(voiceOrb).not.toContain('elevation: 8');
    expect(voiceOrb).toContain('rootCompact');
    expect(glassSurface).toContain('staticElevation(theme, shadowEnabled)');
    expect(glassSurface).toContain('shadowOpacity: 0.18');
    expect(glowPressable).toContain('boxShadow: focus > 0');
    expect(glowPressable).toContain('elevation: 7');
    expect(glowPressable).toContain(': {}),');
    expect(glowPressable).not.toContain('shadowOpacity: isWeb ? interpolate');
    expect(capabilities).toContain("| 'voice_assistant'");
    expect(capabilities).toContain("key: 'voice_assistant'");
    expect(home).toContain('capability: "voice_assistant"');
    expect(home).toContain('requestVoiceAssistant()');
    const ask = readApp('ask.tsx');
    expect(ask).toContain('backgroundColor: theme.color.brandPrimary');
    expect(ask).toContain('accessibilityLabel="Open voice transaction assistant"');
    expect(ask).toContain('onPress={() => requestVoiceAssistant()}');
    expect(ask).toContain('<VoiceFab showFab={false} />');
    expect(ask).not.toContain('Adding it to this chat');
    expect(ask).not.toContain('useAudioRecorder');
    expect(ask).toContain('Nothing changes until you tap Apply.');
    const reports = readApp('(tabs)/reports.tsx');
    expect(reports).toContain('const [displaySeg, setDisplaySeg] = useState<Seg>("Summary")');
    expect(reports).toContain('locationScroll');
    expect(reports).toContain('setDisplaySeg(seg)');
    expect(advanced).toContain('ai-provider-recovery-hint');
    expect(apiFacade).toContain('getAIConfig: async () => getAIConfig()');
    expect(voice).toContain('subscribeToVoiceAssistantRequest');
    expect(rootLayout).toMatch(/Stack\.Protected guard=\{canOpen\("customers"\) \|\| canOpen\("procurement"\) \|\| canOpen\("invoicing"\)\}/);
    expect(rootLayout).toContain('<Stack.Protected guard={canOpen("ai_assistant")}>');
    expect(rootLayout).toContain('<Stack.Protected guard={canOpen("voice_assistant")}>');
    expect(rootLayout).toMatch(/guard=\{canOpen\("ai_assistant"\)\}[\s\S]*name="ask"[\s\S]*name="scan-import"/);
    expect(rootLayout).toMatch(/guard=\{canOpen\("voice_assistant"\)\}[\s\S]*name="voice"/);
    expect(ai).toContain('/audio/transcriptions');
    expect(ai).toContain('Anthropic does not include speech-to-text');
  });

  it('exposes semantic self-host sync without removing local integrations', () => {
    const integrations = readApp('integrations.tsx');
    const syncSettings = readApp('sync-settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const hostingCard = readSource('src/components/HostingModeCard.tsx');
    const syncService = readSource('src/accountingV2/services/selfHostedSyncService.ts');
    const apiFacade = readSource('src/api.ts');
    expect(integrations).not.toContain('testID="self-host-sync-card"');
    expect(integrations).not.toContain('Semantic self-host sync');
    expect(integrations).not.toContain('open-semantic-sync-settings');
    expect(integrations).toContain('Local CSV');
    expect(integrations).not.toContain('Save server');
    expect(integrations).not.toContain('Push local');
    expect(syncSettings).toContain('configureSync');
    expect(syncSettings).toContain('syncNow');
    expect(syncSettings).toContain('publishSyncSnapshot');
    expect(syncSettings).toContain('verifySyncCheckpoint');
    expect(syncService).toContain('importBackup(body.snapshot)');
    expect(syncService).toContain('SecureStore');
    expect(apiFacade).toContain('configureSync');
    expect(apiFacade).toContain('resolveSyncConflict');
    expect(advanced).not.toContain('HostingModeCard');
    expect(hostingCard).toContain('testID="open-private-sync"');
    expect(hostingCard).toContain('testID="open-backup-recovery"');
  });

  it('keeps Quick Actions as the center control and keeps workspace metrics out of Home', () => {
    const tabs = readApp('(tabs)/_layout.tsx');
    const home = readApp('(tabs)/index.tsx');
    const onboarding = readApp('onboarding.tsx');
    const reports = readApp('(tabs)/reports.tsx');
    const rootLayout = readApp('_layout.tsx');
    const shopClose = readApp('shop-close.tsx');

    expect(tabs).toContain('import QuickActionMenu');
    expect(tabs).toContain('<QuickActionMenu />');
    expect(tabs).toContain('name="quick_action_spacer"');
    expect(tabs).toMatch(/name="operations" options=\{\{ href: null \}\}/);
    expect(home).toContain('home-workflow-shortcuts');
    expect(home).toContain('items={visibleTiles}');
    expect(home).toContain('onTilePress={handleTilePress}');
    expect(home).toContain('key: "sales"');
    expect(home).toContain('key: "purchases"');
    expect(home).toContain('key: "expenses"');
    expect(home).toContain('key: "stock"');
    expect(home).toContain('key: "locations"');
    expect(home).toContain('capability: "multi_location"');
    expect(home).not.toContain('Workspace metrics');
    expect(onboarding).toContain('Choose report metrics');
    expect(onboarding).toContain('workspaceMetricKeys');
    expect(reports).toContain('selectedWorkspaceMetrics');
    expect(reports).toContain('testID="report-workspace-metrics"');
    expect(rootLayout).toContain('name="receipt-form"');
    expect(rootLayout).toContain('canOpen("customers")');
    expect(shopClose).toContain('normalizeDateInput');
    expect(shopClose).toContain('isValidDateString');
    expect(shopClose).toContain('locationId');
    expect(shopClose).toContain('Physical stock posted');
    expect(shopClose).toContain('does not close the whole company accounting period');
    const locations = readApp('locations.tsx');
    const inventory = readApp('inventory-form.tsx');
    expect(locations).toContain('Choose two different shops for a cash transfer.');
    expect(locations).toContain('Choose two different shops for a stock transfer.');
    expect(inventory).toContain('Shop being counted');
    expect(inventory).toContain('Choose the shop being counted before saving this audit.');
    expect(inventory).toContain('LocationPicker');
  });
});


describe('hosting mode and Backup & Recovery UI contracts', () => {
  it('exposes local-only mode during onboarding and persists the safe default', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('setRequestedHostingMode("local_only")');
    expect(onboarding).toContain('testID="onboarding-hosting-mode"');
    expect(onboarding).toContain('encrypted backup');
    expect(onboarding).toContain('private sync later');
  });

  it('keeps hosting status and recovery/private-sync routes under Advanced Settings', () => {
    const settings = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const card = readSource('src/components/HostingModeCard.tsx');
    const hosting = readSource('src/utils/hostingMode.ts');
    expect(settings).not.toContain('<HostingModeCard />');
    expect(settings).not.toContain('Self-hosted Sync');
    expect(advanced).not.toContain('<HostingModeCard />');
    expect(card).toContain('testID="hosting-mode-card"');
    expect(card).toContain('testID="open-backup-recovery"');
    expect(card).toContain('testID="open-private-sync"');
    expect(hosting).toContain("local_only: 'Local-only mode'");
    expect(hosting).toContain("private_sync: 'Private sync'");
  });

  it('registers Backup & Recovery under the authenticated core ledger shell', () => {
    const layout = readApp('_layout.tsx');
    const backup = readApp('backup-recovery.tsx');
    expect(layout).toContain('name="backup-recovery"');
    expect(backup).toContain('testID="backup-export-button"');
    expect(backup).toContain('testID="backup-dry-run-button"');
    expect(backup).toContain('testID="backup-restore-button"');
    expect(backup).toContain('testID="backup-integrity-button"');
    expect(backup).toContain('Encrypted backup');
    expect(backup).toContain('Restore dry-run');
    expect(backup).toContain('No data has been changed');
    expect(backup).toContain('testID="backup-recovery-header"');
    expect(backup).toContain('style={styles.scrollView}');
    expect(backup).not.toContain('<View style={styles.header}>');
  });

  it('requires integrity and recent encrypted backup before private sync activation', () => {
    const api = readSource('src/api.ts');
    const sync = readApp('sync-settings.tsx');
    expect(api).toContain('getPrivateSyncPrerequisites');
    expect(api).toContain('hasRecentEncryptedBackup');
    expect(api).toContain('checkLocalIntegrity');
    expect(sync).toContain('getPrivateSyncPrerequisites');
    expect(sync).toContain('encrypted backup before connecting private sync');
  });
});


describe('phases 3–6 self-hosting UI contracts', () => {
  it('exposes sync administration and health routes from the private sync workspace', () => {
    const layout = readApp('_layout.tsx');
    const sync = readApp('sync-settings.tsx');
    const admin = readApp('sync-admin.tsx');
    const health = readApp('sync-health.tsx');
    expect(layout).toContain('name="sync-admin"');
    expect(layout).toContain('name="sync-health"');
    expect(sync).toContain('testID="open-sync-admin"');
    expect(sync).toContain('testID="open-sync-health"');
    expect(admin).toContain('Sync Administration');
    expect(admin).toContain('Save location scope');
    expect(admin).toContain('Revoke');
    expect(health).toContain('testID="check-server-health"');
    expect(health).toContain('Check server health');
    expect(health).toContain('never stored');
  });

  it('keeps sync administration and health behind the authenticated core-ledger guard', () => {
    const layout = readApp('_layout.tsx');
    const guardStart = layout.lastIndexOf('<Stack.Protected guard={canOpen("core_ledger")}>');
    const guardEnd = layout.indexOf('</Stack.Protected>', guardStart);
    const block = layout.slice(guardStart, guardEnd);
    expect(block).toContain('name="sync-admin"');
    expect(block).toContain('name="sync-health"');
    expect(block).toContain('name="sync-settings"');
  });

  it('surfaces durable sync attempt and error telemetry in the coordinator', () => {
    const schema = readSource('src/db/schema.ts');
    const coordinator = readSource('src/sync/coordinator.ts');
    expect(schema).toContain("'sync_profiles', 'last_sync_attempt_at'");
    expect(schema).toContain("'sync_profiles', 'last_sync_error'");
    expect(coordinator).toContain('lastSyncAttemptAt');
    expect(coordinator).toContain('lastSyncError');
    expect(coordinator).toContain('last_sync_error_at');
  });
});


describe('roadmap phases 7–8 sync UX contracts', () => {
  it('exposes secure one-time enrollment in the user flow and administrator flow', () => {
    const settings = readApp('sync-settings.tsx');
    const admin = readApp('sync-admin.tsx');
    const recovery = readSource('src/sync/recovery.ts');
    const server = readSource('../sync-server/src/server.ts');
    expect(settings).toContain('testID="sync-enrollment-code"');
    expect(settings).toContain('testID="redeem-sync-enrollment-code"');
    expect(admin).toContain('Create QR invitation');
    expect(admin).toContain('Invitation code behind the QR');
    expect(recovery).toContain('redeemSyncEnrollmentCode');
    expect(recovery).toContain('epochResult.currentSequence >= epochResult.epochStartSequence');
    expect(recovery).toContain('Install the validated server snapshot before sync resumes');
    expect(recovery).not.toContain('UPDATE sync_profiles SET book_epoch=?,enabled=?,recovery_required=0,recovery_reason=NULL');
    expect(server).toContain('/v1/sync/enrollment-codes');
    expect(server).toContain('/v1/sync/enroll-code/redeem');
  });

  it('keeps global sync attention compact and makes conflicts business-readable', () => {
    const layout = readApp('_layout.tsx');
    const indicator = readSource('src/components/SyncStatusIndicator.tsx');
    const conflicts = readApp('sync-conflicts.tsx');
    expect(layout).toContain('SyncStatusIndicator');
    expect(indicator).toContain('Open Sync Health');
    expect(indicator).toContain('20_000');
    expect(conflicts).toContain('Field differences');
    expect(conflicts).toContain('No settlement is silently posted');
    expect(conflicts).toContain('silent last-write-wins');
  });
});


describe('271498 recording remediation contracts', () => {
  it('keeps onboarding content top-aligned and action spacing responsive', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('useSafeAreaInsets');
    expect(onboarding).toContain('<SafeAreaView style={styles.container} edges={["top"]}>');
    expect(onboarding).toContain('style={styles.scrollView}');
    expect(onboarding).toContain('const footerBottomPadding = Math.max(12, insets.bottom);');
    expect(onboarding).toContain('paddingBottom: footerBottomPadding');
    expect(onboarding).toContain('scrollView: { flex: 1 }');
    expect(onboarding).toContain('justifyContent: "flex-start"');
    expect(onboarding).toContain('flexGrow: 0');
    expect(onboarding).toContain('Open my workspace');
    expect(onboarding).not.toContain('minHeight: Math.max(0, viewportHeight - 220)');
  });

  it('restores capability-aware Quick Workspace organization controls', () => {
    const home = readApp('(tabs)/index.tsx');
    const grid = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    expect(home).toContain('workflowTilesFor(settings)');
    expect(home).toContain('sortTilesByPreset');
    for (const preset of ['recent', 'frequent', 'alphabetical', 'default']) expect(home).toContain(`sortTilesByPreset("${preset}")`);
    expect(home).toContain('Reset workspaces to default order');
    expect(home).toContain('onOrderChange={moveTile}');
    expect(grid).toContain('const TilePressableComponent: any = isWeb ? Pressable : AnimatedPressable;');
    expect(grid).toContain('const isWeb = Platform.OS === "web";');
    expect(grid).toContain('boxShadow: "none"');
    expect(grid).toContain('shadowOpacity: 0');
    expect(grid).toContain('shadowRadius: 0');
    expect(grid).toContain('elevation: 0');
    expect(grid).toContain('overflow: "hidden"');
    expect(grid).toContain('theme.motion.longPress * 1.28');
    expect(grid).toContain('activateAfterLongPress(motionEnabled ? reorderLongPress : 999999)');
  });

  it('keeps privacy in-app and exposes local save alongside sharing', () => {
    const settings = readApp('(tabs)/settings.tsx');
    const layout = readApp('_layout.tsx');
    const privacy = readApp('privacy.tsx');
    const backup = readApp('backup-recovery.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const share = readSource('src/utils/share.ts');
    expect(settings).toContain('router.push("/privacy"');
    expect(settings).not.toContain('Linking.openURL');
    expect(layout).toContain('name="privacy"');
    expect(privacy).toContain('Local-first privacy');
    expect(privacy).toContain('Ledgr Privacy Policy');
    expect(backup).toContain('testID="backup-save-device-button"');
    expect(backup).toContain('testID="backup-export-button"');
    expect(advanced).toContain('testID="legacy-save-device-button"');
    expect(advanced).toContain('doExport("save")');
    expect(advanced).toContain('doExport("share")');
    expect(backup).toContain("exportEncrypted('save')");
    expect(backup).toContain("exportEncrypted('share')");
    expect(share).toContain('export async function saveJsonFile');
    expect(share).toContain('StorageAccessFramework.requestDirectoryPermissionsAsync');
    expect(share).toContain('FileSystem.documentDirectory');
  });
});
describe('roadmap phases 9–10 migration and release contracts', () => {
  it('exposes a guarded local-to-private migration flow and safe return path', () => {
    const migration = readApp('private-sync-migration.tsx');
    const settings = readApp('sync-settings.tsx');
    const apiSource = readSource('src/api.ts');
    const layout = readApp('_layout.tsx');
    expect(migration).toContain('Start safe migration');
    expect(migration).toContain('Return this device to Local-only mode');
    expect(migration).toContain('not destructively replace');
    expect(settings).toContain('Open guided setup');
    expect(apiSource).toContain('migrateToPrivateSync');
    expect(apiSource).toContain('leavePrivateSync');
    expect(layout).toContain('private-sync-migration');
  });

  it('keeps release requirements and rollback gates discoverable in the user-owned package', () => {
    const deployGuide = readSource('../sync-server/deploy/README.md');
    const checklist = readSource('../sync-server/deploy/RELEASE_CHECKLIST.md');
    const preflight = readSource('../sync-server/deploy/preflight.sh');
    const advanced = readSource('../sync-server/deploy/install-advanced.sh');
    expect(deployGuide).toContain('./preflight.sh advanced');
    expect(checklist).toContain('Rollback procedure');
    expect(checklist).toContain('Minimum requirements');
    expect(checklist).toContain('future full hosted ERP');
    expect(preflight).toContain('No services were started');
    expect(advanced).toContain('sslmode');
  });
});


describe('beginner-first private sync UI contracts', () => {
  it('provides a simple guide and progressive disclosure', () => {
    const settings = readApp('sync-settings.tsx');
    const guide = readApp('private-sync-guide.tsx');
    expect(settings).toContain('open-private-sync-guide');
    expect(settings).toContain('Simple setup');
    expect(settings).toContain('Choose a path');
    expect(settings).toContain('I already have a server — show sign-in fields');
    expect(settings).toContain('Download Self-host Package');
    expect(settings).toContain('testID="download-self-host-package"');
    expect(settings).toContain("Open guided self-host setup");
    expect(settings).toContain('testID="open-self-host-setup-guide"');
    expect(settings).toContain('testID="open-private-sync-guide"');
    expect(settings).toContain('Collapse sync workflows');
    expect(settings).toContain('Collapse sync system settings');
    expect(settings).toContain('KeyboardAvoidingView');
    expect(settings).toContain('scrollRef.current?.scrollToEnd');
    expect(settings).toContain('testID="sign-in-and-join-sync"');
    expect(settings).toContain('authorizeAndRedeemSyncEnrollmentCode');
    expect(guide).toContain('Ledgr helps you choose the right setup.');
    expect(guide).toContain('Go to Private sync');
  });
});


describe('QR private sync onboarding contracts', () => {
  it('keeps QR invitations short-lived, token-free, and validated', () => {
    const admin = readApp('sync-admin.tsx');
    const scanner = readApp('sync-scan.tsx');
    const settings = readApp('sync-settings.tsx');
    const qr = readSource('src/sync/qrEnrollment.ts');
    const qrCode = readSource('src/components/SyncQrCode.tsx');
    const layout = readApp('_layout.tsx');
    const guide = readApp('private-sync-guide.tsx');
    expect(admin).toContain('Create QR invitation');
    expect(admin).toContain('Scan to join this business');
    expect(admin).toContain('never contains this administrator’s access token');
    expect(scanner).toContain('Scan invitation');
    expect(scanner).toContain('CameraView');
    expect(scanner).toContain('Paste an invitation');
    expect(settings).toContain('testID="scan-sync-invitation"');
    expect(settings).toContain('decodeLedgrSyncQrInvite');
    expect(settings).toContain('Owner setup invitation');
    expect(settings).toContain('You will become the owner of this Business Account.');
    expect(qr).toContain("LEDGR_SYNC_QR_KIND = 'ledgr.sync.enrollment'");
    expect(qr).toContain('This Ledgr invitation has expired');
    expect(qrCode).toContain('QRCode.toString');
    expect(layout).toContain('name="sync-scan"');
    expect(guide).toContain('Office computer');
    expect(guide).toContain('VPS');
    expect(guide).toContain('NAS');
    expect(guide).toContain('Docker Compose v2');
  });

  it('links each beginner host choice to a versioned public self-host release', () => {
    const guide = readApp('private-sync-guide.tsx');
    const distribution = readSource('src/sync/selfHostDistribution.ts');
    expect(guide).toContain('download-self-host-${host}');
    expect(guide).toContain('Download Windows one-click installer');
    expect(guide).toContain('Download macOS one-click launcher');
    expect(guide).toContain('Download Linux one-click installer');
    expect(guide).toContain('After the installer finishes');
    expect(guide).toContain('/setup');
    expect(guide).toContain('Download NAS/Docker bundle');
    expect(guide).toContain('Open QR invitation scanner');
    expect(distribution).toContain('releases/latest/download/ledgr-selfhost-bundle.tar.gz');
    expect(distribution).toContain('releases/latest/download/ledgr-selfhost-install.sh');
    expect(distribution).toContain('releases/latest/download/ledgr-selfhost-install.ps1');
    expect(distribution).toContain('releases/latest/download/ledgr-selfhost-install.bat');
    expect(distribution).toContain('releases/latest/download/ledgr-selfhost-install.command');
    expect(distribution).toContain('ghcr.io/mbell003638/ledgr-self-host-sync:latest');
    expect(distribution).toContain('mbell003638/Ledgr-Self-Host');
  });

  it('uses one organized Advanced Settings header above the System & Workflows section', () => {
    const advanced = readApp('advanced-settings.tsx');
    expect(advanced).toContain('testID="advanced-settings-header"');
    expect(advanced).toContain('title="Advanced Settings"');
    expect(advanced).toContain('subtitle="Workspace configuration and workflows"');
    expect(advanced).toContain('accessibilityLabel="Back to Settings"');
    expect(advanced).toContain('title="System & Workflows"');
    expect(advanced).not.toContain('<ScreenHeader title="Advanced" subtitle="System & Workflows" />');
    expect(advanced).not.toContain('paddingHorizontal: theme.spacing.lg, paddingTop: 16');
    expect(advanced).toContain('advancedHeader: { paddingTop: 20, paddingBottom: 10 }');
    expect(advanced).toContain('advancedGroup: { marginTop: theme.spacing.lg, padding: 20 }');
  });
  it('keeps compact-phone onboarding controls reachable and Home workflow labels wrapped', () => {
    const onboarding = readApp('onboarding.tsx');
    const home = readApp('(tabs)/index.tsx');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    expect(onboarding).toContain('minHeight: 44');
    expect(onboarding).toContain('accessibilityLabel={`Currency ${value}`}');
    expect(onboarding).toContain('toggleHitArea: { minWidth: 50, minHeight: 44');
    expect(onboarding).toContain('Operate multiple stores or POS points');
    expect(home).toContain('home-workflow-shortcuts');
    expect(workspace).toContain('accessibilityRole="button"');
    expect(workspace).toContain('numberOfLines={2}');
    expect(workspace).toContain('ellipsizeMode="tail"');
    expect(workspace).toContain('flexShrink: 1');
  });
  it('keeps compact bottom-tab labels inside the navigation shell', () => {
    const tabs = readApp('(tabs)/_layout.tsx');
    expect(tabs).toContain('minWidth: 60');
    expect(tabs).toContain('fontSize: 11');
    expect(tabs).toContain('lineHeight: 14');
    expect(tabs).toContain('tabBarItemStyle: { borderRadius: 18');
  });
  it('keeps two-pane presentation opt-in and single-pane without native posture data', () => {
    const twoPane = readSource('src/components/ResponsiveTwoPane.tsx');
    expect(twoPane).toContain('snapshot.dualPane && snapshot.hasHinge');
    expect(twoPane).toContain('snapshot.posture === "flat" || snapshot.posture === "book"');
    expect(twoPane).toContain('if (!isSafeTwoPanePosture(snapshot)) return <>{primary}</>');
    for (const excluded of ['sync', 'voice', 'invoice', 'modal']) {
      expect(twoPane).not.toContain(`/${excluded}`);
    }
  });
});
