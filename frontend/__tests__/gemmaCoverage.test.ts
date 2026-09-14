import fs from 'node:fs';
import path from 'node:path';

import { CAPABILITIES, type CapabilityKey } from '../src/utils/capabilities';
import {
  BLOCKED_OPERATIONS,
  CoverageError,
  GEMMA_COVERAGE,
  NAVIGABLE_SCREENS,
  allCapabilityKeys,
  assertCoverage,
  coverageSummary,
  routeFor,
  type CoverageEnvironment,
  type CoverageRow,
} from '../src/accountingV2/gemma/coverage';
import { readToolRegistry, type ReadPorts } from '../src/accountingV2/gemma/coreReadTools';
import { proposalToolRegistry, type ProposalPorts } from '../src/accountingV2/gemma/proposalTools';

const frontend = path.resolve(__dirname, '..');

/**
 * The environment the register is checked against: the tools that were really
 * built, the routes that really exist as files, and the test files that really
 * exist. A row citing anything absent is the false claim this guards.
 */
function realEnvironment(): CoverageEnvironment {
  const readTools = readToolRegistry({} as ReadPorts).map((tool) => tool.name);
  const proposalTools = proposalToolRegistry({} as ProposalPorts).map((tool) => tool.name);

  const appFiles = fs.readdirSync(path.join(frontend, 'app'));
  const knownRoutes = Object.values(NAVIGABLE_SCREENS).filter((route) => {
    const base = route.replace(/^\//, '');
    return appFiles.includes(`${base}.tsx`) || appFiles.includes(base);
  });

  return {
    knownTools: [...readTools, ...proposalTools],
    knownRoutes,
    knownTests: fs.readdirSync(path.join(frontend, '__tests__')).filter((name) => name.endsWith('.test.ts')),
  };
}

const environment = realEnvironment();
const enabled = allCapabilityKeys();

describe('the register itself', () => {
  it('has exactly one row for every capability this build can enable', () => {
    expect(enabled.length).toBe(CAPABILITIES.length);
    for (const feature of enabled) {
      expect(GEMMA_COVERAGE.filter((row) => row.feature === feature)).toHaveLength(1);
    }
    expect(GEMMA_COVERAGE).toHaveLength(enabled.length);
  });

  it('passes its own assertions against the real tools, routes and tests', () => {
    expect(() => assertCoverage(enabled, GEMMA_COVERAGE, environment)).not.toThrow();
  });

  it('names only tools that were actually built', () => {
    const unknown: string[] = [];
    for (const row of GEMMA_COVERAGE) {
      for (const tool of row.tools) {
        if (!environment.knownTools.includes(tool)) unknown.push(`${row.feature} -> ${tool}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('names only routes that exist as screens in this branch', () => {
    const missing: string[] = [];
    for (const row of GEMMA_COVERAGE) {
      if (row.route && !environment.knownRoutes.includes(row.route)) {
        missing.push(`${row.feature} -> ${row.route}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('cites only test files that exist', () => {
    const missing: string[] = [];
    for (const row of GEMMA_COVERAGE) {
      for (const test of row.tests) {
        if (!environment.knownTests.includes(test)) missing.push(`${row.feature} -> ${test}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every guided-screen row a route and an honest reason', () => {
    for (const row of GEMMA_COVERAGE.filter((entry) => entry.mode === 'guided-screen')) {
      expect(row.route).toBeTruthy();
      expect(row.reason && row.reason.length).toBeGreaterThan(20);
    }
  });

  it('does not claim a mode it cannot back with tools', () => {
    for (const row of GEMMA_COVERAGE.filter((entry) => entry.mode === 'read' || entry.mode === 'proposal')) {
      expect(row.tools.length).toBeGreaterThan(0);
    }
  });

  it('resolves every navigable screen to a real file', () => {
    const appFiles = fs.readdirSync(path.join(frontend, 'app'));
    const broken: string[] = [];
    for (const [screen, route] of Object.entries(NAVIGABLE_SCREENS)) {
      const base = route.replace(/^\//, '');
      if (!appFiles.includes(`${base}.tsx`) && !appFiles.includes(base)) broken.push(`${screen} -> ${route}`);
    }
    expect(broken).toEqual([]);
  });
});

describe('assertCoverage catches a dishonest register', () => {
  const row = (overrides: Partial<CoverageRow>): CoverageRow => ({
    feature: 'cashbook',
    mode: 'read',
    tools: ['read_cash_movements'],
    tests: ['gemmaReadTools.test.ts'],
    ...overrides,
  });

  it('catches a missing family', () => {
    expect(() => assertCoverage(['cashbook'], [])).toThrow(CoverageError);
    expect(() => assertCoverage(['cashbook'], [])).toThrow(/Missing\/duplicate/);
  });

  it('catches a duplicate row', () => {
    expect(() => assertCoverage(['cashbook'], [row({}), row({})])).toThrow(/Missing\/duplicate/);
  });

  it('catches an untested row', () => {
    expect(() => assertCoverage(['cashbook'], [row({ tests: [] })])).toThrow(/Untested/);
  });

  it('catches a read or proposal row with no tools', () => {
    expect(() => assertCoverage(['cashbook'], [row({ tools: [] })])).toThrow(/No tools/);
    expect(() => assertCoverage(['cashbook'], [row({ mode: 'proposal', tools: [] })])).toThrow(/No tools/);
  });

  it('catches a guided-screen row with no route or no reason', () => {
    expect(() => assertCoverage(['cashbook'], [row({ mode: 'guided-screen', tools: [] })]))
      .toThrow(/No route/);
    expect(() => assertCoverage(['cashbook'], [row({ mode: 'guided-screen', tools: [], route: '/cashbook' })]))
      .toThrow(/No reason/);
  });

  it('catches a blocked row with no reason', () => {
    expect(() => assertCoverage(['cashbook'], [row({ mode: 'blocked', tools: [] })])).toThrow(/No reason/);
  });

  it('catches a row citing a tool nobody wrote', () => {
    expect(() => assertCoverage(['cashbook'], [row({ tools: ['read_everything'] })], environment))
      .toThrow(/never built/);
  });

  it('catches a row citing a route that does not exist', () => {
    expect(() => assertCoverage(['cashbook'], [row({ route: '/does-not-exist' })], environment))
      .toThrow(/route that does not exist/);
  });

  it('catches a row citing a test that does not exist', () => {
    expect(() => assertCoverage(['cashbook'], [row({ tests: ['imaginary.test.ts'] })], environment))
      .toThrow(/cites a test that does not exist/);
  });
});

describe('blocked operations', () => {
  it('refuses book destruction, credentials, membership, export and generic settings writes', () => {
    const operations = BLOCKED_OPERATIONS.map((entry) => entry.operation);
    expect(operations).toEqual(expect.arrayContaining([
      'reset_book', 'delete_book', 'read_credentials', 'change_membership',
      'export_backup', 'change_settings',
    ]));
  });

  it('gives every blocked operation a reason and a real owner-controlled screen', () => {
    for (const entry of BLOCKED_OPERATIONS) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(environment.knownRoutes).toContain(entry.route);
    }
  });

  it('never exposes a blocked operation as a tool', () => {
    const blocked = new Set(BLOCKED_OPERATIONS.map((entry) => entry.operation));
    for (const tool of environment.knownTools) {
      expect(blocked.has(tool)).toBe(false);
    }
  });
});

describe('summary for describe_capabilities', () => {
  it('reports the mode per enabled feature without inventing rows', () => {
    const summary = coverageSummary(['cashbook', 'payroll']);
    expect(summary).toEqual([
      { feature: 'cashbook', mode: 'read', route: '/cashbook' },
      { feature: 'payroll', mode: 'guided-screen', route: '/payroll' },
    ]);
  });

  it('omits a feature with no row rather than guessing one', () => {
    expect(coverageSummary(['not_a_capability' as CapabilityKey])).toEqual([]);
  });

  it('does not describe an unwired family as automated', () => {
    const payroll = GEMMA_COVERAGE.find((entry) => entry.feature === 'payroll');
    expect(payroll?.mode).toBe('guided-screen');
    expect(payroll?.tools).toEqual([]);
  });
});

describe('routeFor', () => {
  it('maps a screen id to a compiled route', () => {
    expect(routeFor('ask')).toBe('/ask');
    expect(routeFor('payroll')).toBe('/payroll');
  });
});
