import { createAgent, type Engine, type Scope, type ProposalTool, type ReadTool } from '../src/accountingV2/gemma/agentCore';

const origin: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner',
  permissionEpoch: 'p1', featureEpoch: 'f1', revision: 'r1', currency: 'INR',
  basis: 'accrual', today: '2026-09-14', timeZone: 'Asia/Calcutta',
};
const changes: [string, Partial<Scope>][] = [
  ['book', { bookId: 'book-b' }], ['location', { locationId: 'other' }],
  ['actor', { actorId: 'other' }], ['permission', { permissionEpoch: 'p2' }],
  ['feature', { featureEpoch: 'f2' }], ['revision', { revision: 'r2' }],
];
const noArgs = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const };

describe.each(changes)('scope change: %s', (_label, change) => {
  test.each(['advertise', 'begin', 'authorize', 'prepare', 'cancel', 'finish'])('proposal rejected at %s', async boundary => {
    let current = { ...origin };
    let authorizations = 0;
    const changeAt = (point: string) => { if (boundary === point) current = { ...origin, ...change }; };
    const tool: ProposalTool = {
      name: 'add_expense', description: '', feature: 'expenses', access: 'proposal', parameters: noArgs,
      authorize: async () => { changeAt(++authorizations === 1 ? 'advertise' : 'authorize'); return true; },
      prepare: async () => { changeAt('prepare'); return { operation: 'add_expense', normalized: { amount: 100 }, preview: '100', destructive: false, entityVersions: {} }; },
    };
    const engine: Engine = {
      begin: jest.fn(async () => { changeAt('begin'); return { requestId: 'original-request', text: '', calls: [{ id: '1', name: tool.name, arguments: {} }] }; }),
      resume: jest.fn(),
      cancel: jest.fn(async () => { changeAt('cancel'); }),
      finish: jest.fn(async () => { changeAt('finish'); }),
    };
    // Manus cancels only stopped runs; its normal cleanup boundary is finish.
    if (boundary === 'cancel') engine.finish = jest.fn(async () => { changeAt('cancel'); });
    const run = createAgent(engine).run;
    const result = await run({ requestId: 'original-request', modelId: 'model', question: 'record expense',
      glossary: '', tools: [tool], canPropose: true, currentScope: async () => current });
    expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  });

  test.each(['read', 'resume', 'finish'])('plain answer rejected at %s', async boundary => {
    let current = { ...origin };
    const changeAt = (point: string) => { if (boundary === point) current = { ...origin, ...change }; };
    const tool: ReadTool = {
      name: 'read_total', description: '', feature: 'reports', access: 'read', parameters: noArgs,
      authorize: async () => true,
      read: async () => { changeAt('read'); return { source: 'ledger', scope: origin, asOf: origin.today, data: 100, truncated: false, nextCursor: null }; },
    };
    const engine: Engine = {
      begin: async () => ({ requestId: 'original-request', text: '', calls: [{ id: '1', name: tool.name, arguments: {} }] }),
      resume: async () => { changeAt('resume'); return { requestId: 'original-request', text: '100', calls: [] }; },
      cancel: async () => undefined, finish: async () => { changeAt('finish'); },
    };
    const run = createAgent(engine).run;
    expect(await run({ requestId: 'original-request', modelId: 'model', question: 'total',
      glossary: '', tools: [tool], canPropose: false, currentScope: async () => current }))
      .toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  });
});

test.each(['lock', 'signout', 'cancel', 'failed-finish'])('cleanup terminal boundary: %s', async mode => {
  let available = true;
  const controller = new AbortController();
  const engine: Engine = {
    begin: async () => ({ requestId: 'r', text: 'private answer', calls: [] }), resume: jest.fn(),
    cancel: async () => undefined,
    finish: async () => {
      if (mode === 'cancel') controller.abort();
      else if (mode === 'failed-finish') throw new Error('bad acknowledgment');
      else available = false;
    },
  };
  const run = createAgent(engine).run;
  const result = await run({ requestId: 'r', modelId: 'model', question: 'total', glossary: '',
    tools: [], canPropose: false, signal: controller.signal,
    currentScope: async () => { if (!available) throw new Error('APP_LOCKED'); return origin; } });
  expect(result).toEqual({ kind: 'stopped', code: mode === 'cancel' ? 'CANCELLED' : mode === 'failed-finish' ? 'NATIVE_RECOVERY_REQUIRED' : 'STALE_SCOPE' });
});

test('same-scope draft retains host request and isolates preparation data', async () => {
  const draft = { operation: 'add_expense', normalized: { amount: 100 }, preview: '100', destructive: false, entityVersions: {} };
  const tool: ProposalTool = { name: 'add_expense', description: '', feature: 'expenses', access: 'proposal',
    parameters: noArgs, authorize: async () => true, prepare: async () => draft };
  const engine: Engine = {
    begin: async () => ({ requestId: 'r', text: '', calls: [{ id: '1', name: tool.name, arguments: {} }] }),
    resume: jest.fn(), cancel: async () => undefined, finish: async () => { draft.normalized.amount = 500; },
  };
  const run = createAgent(engine).run;
  const result = await run({ requestId: 'r', modelId: 'model', question: 'record expense', glossary: '',
    tools: [tool], canPropose: true, currentScope: async () => origin });
  expect(result).toMatchObject({ kind: 'proposal', proposal: { requestId: 'r', scope: origin, draft: { normalized: { amount: 100 } } } });
});
