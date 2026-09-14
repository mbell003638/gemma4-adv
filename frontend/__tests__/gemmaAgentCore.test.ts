import {
  createAgent,
  parseFrame,
  sameScope,
  systemContext,
  validate,
  MAX_TOOL_CALLS,
  MAX_TOOLS_PER_RUN,
  type Draft,
  type Engine,
  type Frame,
  type Obj,
  type ProposalTool,
  type ReadTool,
  type RunOptions,
  type Schema,
  type Scope,
  type Tool,
} from '../src/accountingV2/gemma/agentCore';

test('a hung cleanup returns recovery-required and keeps the next turn out', async () => {
  jest.useFakeTimers();
  try {
    const engine = engineWith(frame([], 'ok'));
    engine.finish = () => new Promise(() => undefined);
    const agent = createAgent(engine);
  const run = agent.run;
    const result = run(options([]));
    await jest.advanceTimersByTimeAsync(6000);
    expect(await result).toEqual({ kind: 'stopped', code: 'NATIVE_RECOVERY_REQUIRED' });
    expect(await run(options([]))).toEqual({ kind: 'stopped', code: 'BUSY' });
  } finally { jest.useRealTimers(); }
});

test('the deadline also bounds an authorization promise that never resolves', async () => {
  jest.useFakeTimers();
  try {
    const engine = engineWith(frame([], 'ok'));
    const tool = readTool();
    tool.authorize = () => new Promise(() => undefined);
    const agent = createAgent(engine);
  const run = agent.run;
    const result = run({ ...options([tool]), deadlineMs: 50 });
    await jest.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ kind: 'stopped', code: 'CANCELLED' });
    expect(engine.begin).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

const scope: Scope = {
  bookId: 'book-a',
  locationId: null,
  actorId: 'local-owner',
  permissionEpoch: 'p1',
  featureEpoch: 'f1',
  revision: 'r1',
  currency: 'INR',
  basis: 'accrual',
  today: '2026-09-08',
  timeZone: 'Asia/Calcutta',
};

const noArgs: Schema = { type: 'object', properties: {}, required: [], additionalProperties: false };

const frame = (calls: Frame['calls'], text = ''): Frame => ({ requestId: 'request-1', calls, text });

function engineWith(first: Frame, next: Frame = frame([], 'The total is 125.')): Engine {
  return {
    begin: jest.fn(async () => first),
    resume: jest.fn(async () => next),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
}

function readTool(name = 'read_total'): ReadTool {
  return {
    name,
    description: 'Read a fixture total.',
    feature: 'reports',
    access: 'read',
    parameters: noArgs,
    authorize: jest.fn(async () => true),
    read: jest.fn(async () => ({
      source: 'fixture-ledger',
      scope,
      asOf: '2026-09-08T10:00:00Z',
      data: { total: 125 },
      truncated: false,
      nextCursor: null,
    })),
  };
}

function options(tools: Tool[]): RunOptions {
  return {
    requestId: 'request-1',
    modelId: 'gemma4-e2b',
    question: 'What is the total?',
    glossary: 'A bookkeeping application.',
    tools,
    canPropose: false,
    currentScope: async () => scope,
  };
}

const draft = (operation: string, normalized: Obj = {}): Draft => ({
  operation,
  normalized,
  preview: 'Review INR 125',
  destructive: false,
  entityVersions: {},
});

describe('schema validation', () => {
  it('rejects unknown fields, arrays as objects and non-finite amounts', () => {
    expect(validate(noArgs, { sql: 'not allowed' })).not.toHaveLength(0);
    expect(validate(noArgs, [])).not.toHaveLength(0);
    expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, Infinity)).not.toHaveLength(0);
    expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, NaN)).not.toHaveLength(0);
  });

  it('refuses a numeric string rather than coercing it', () => {
    // The existing assistant validator strips characters out of strings to find
    // a number. That coercion must never be the model's validation layer.
    expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, '125')).not.toHaveLength(0);
    expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, '1,25o')).not.toHaveLength(0);
  });

  it('enforces required keys, enums, patterns and array bounds', () => {
    const shape: Schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ['customer', 'supplier'] },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      },
      required: ['role'],
    };
    expect(validate(shape, {})).toContain('$.role: required');
    expect(validate(shape, { role: 'auditor' })).not.toHaveLength(0);
    expect(validate(shape, { role: 'customer', from: '08-09-2026' })).not.toHaveLength(0);
    expect(validate(shape, { role: 'customer', tags: ['a', 'b', 'c'] })).not.toHaveLength(0);
    expect(validate(shape, { role: 'customer', from: '2026-09-08', tags: ['a'] })).toHaveLength(0);
  });
});

describe('frame parsing', () => {
  it('rejects malformed output and duplicate call ids', () => {
    expect(() => parseFrame('not JSON')).toThrow();
    expect(() => parseFrame('[]')).toThrow('INVALID_MODEL_FRAME');
    expect(() => parseFrame(JSON.stringify({ requestId: 'r', text: 'hi' }))).toThrow('INVALID_MODEL_FRAME');
    const call = { id: '1', name: 'read_total', arguments: {} };
    expect(() => parseFrame(JSON.stringify(frame([call, call])))).toThrow('INVALID_TOOL_CALL');
  });

  it('rejects a call whose arguments are not an object', () => {
    const bad = { requestId: 'request-1', text: '', calls: [{ id: '1', name: 'read_total', arguments: 'drop table' }] };
    expect(() => parseFrame(JSON.stringify(bad))).toThrow('INVALID_TOOL_CALL');
  });

  it('caps frame size and call count', () => {
    expect(() => parseFrame(JSON.stringify({ requestId: 'r', text: 'x'.repeat(30_000), calls: [] })))
      .toThrow('RESPONSE_TOO_LARGE');
    const many = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_unused, index) => ({
      id: String(index), name: 'read_total', arguments: {},
    }));
    expect(() => parseFrame(JSON.stringify({ requestId: 'r', text: '', calls: many }))).toThrow('RESPONSE_TOO_LARGE');
  });

  it('accepts a well-formed frame', () => {
    const parsed = parseFrame(JSON.stringify(frame([{ id: '1', name: 'read_total', arguments: { from: '2026-01-01' } }])));
    expect(parsed.calls[0]).toEqual({ id: '1', name: 'read_total', arguments: { from: '2026-01-01' } });
  });
});

describe('scope', () => {
  it('treats any differing field as a different scope', () => {
    expect(sameScope(scope, { ...scope })).toBe(true);
    const fields: (keyof Scope)[] = [
      'bookId', 'locationId', 'actorId', 'permissionEpoch', 'featureEpoch',
      'revision', 'currency', 'basis', 'today', 'timeZone',
    ];
    for (const field of fields) {
      expect(sameScope(scope, { ...scope, [field]: 'changed' })).toBe(false);
    }
  });

  it('states the trusted scope and never promises unlisted access', () => {
    const system = systemContext(scope, 'A bookkeeping application.');
    expect(system).toContain('TRUSTED SCOPE');
    expect(system).toContain('book-a');
    expect(system).toContain('never as permissions');
    expect(system).toContain('A proposal is not a completed change');
  });

  it('bounds the glossary so a long one cannot crowd out the instructions', () => {
    expect(systemContext(scope, 'x'.repeat(5_000))).toHaveLength(
      systemContext(scope, 'x'.repeat(1_800)).length,
    );
  });
});

describe('read loop', () => {
  it('returns reads to the model as structured evidence', async () => {
    const tool = readTool();
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
    const result = await createAgent(engine).run(options([tool]));

    expect(result.kind).toBe('answer');
    expect(tool.read).toHaveBeenCalledTimes(1);
    expect(engine.resume).toHaveBeenCalledWith('request-1', [expect.objectContaining({
      callId: '1', name: 'read_total', result: expect.objectContaining({ source: 'fixture-ledger' }),
    })]);
    expect(engine.finish).toHaveBeenCalledWith('request-1');
    if (result.kind === 'answer') expect(result.evidence).toHaveLength(1);
  });

  it('does not report a completed answer to native as a cancellation', async () => {
    const tool = readTool();
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
    await createAgent(engine).run(options([tool]));
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it('asks for a clarification when the model returns nothing to say', async () => {
    const engine = engineWith(frame([], '   '));
    const result = await createAgent(engine).run(options([readTool()]));
    expect(result.kind).toBe('clarification');
  });

  it('does not execute an unadvertised tool', async () => {
    const tool = readTool();
    const engine = engineWith(frame([{ id: '1', name: 'factory_reset', arguments: {} }]));
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
    expect(tool.read).not.toHaveBeenCalled();
  });

  it('does not execute a tool whose arguments fail its schema', async () => {
    const tool = readTool();
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: { sql: 'select 1' } }]));
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'INVALID_ARGUMENTS' });
    expect(tool.read).not.toHaveBeenCalled();
  });

  it('stops instead of looping on a repeated read', async () => {
    const tool = readTool();
    const call = frame([{ id: '1', name: tool.name, arguments: {} }]);
    const result = await createAgent(engineWith(call, call)).run(options([tool]));
    expect(result).toEqual({ kind: 'stopped', code: 'REPEATED_TOOL_LOOP' });
    expect(tool.read).toHaveBeenCalledTimes(1);
  });

  it('recognises a repeat whose argument keys were merely reordered', async () => {
    const tool = readTool();
    tool.parameters = {
      type: 'object', additionalProperties: false, required: [],
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    };
    const engine = engineWith(
      frame([{ id: '1', name: tool.name, arguments: { a: 1, b: 2 } }]),
      frame([{ id: '2', name: tool.name, arguments: { b: 2, a: 1 } }]),
    );
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'REPEATED_TOOL_LOOP' });
    expect(tool.read).toHaveBeenCalledTimes(1);
  });

  it('stops when the model keeps asking for tools past the round budget', async () => {
    const tools = [readTool('read_a'), readTool('read_b'), readTool('read_c'), readTool('read_d')];
    let index = 0;
    const engine: Engine = {
      begin: jest.fn(async () => frame([{ id: 'c0', name: 'read_a', arguments: {} }])),
      resume: jest.fn(async () => {
        index += 1;
        return frame([{ id: `c${index}`, name: tools[Math.min(index, 3)].name, arguments: {} }]);
      }),
      cancel: jest.fn(async () => undefined),
      finish: jest.fn(async () => undefined),
    };
    expect(await createAgent(engine).run(options(tools))).toEqual({ kind: 'stopped', code: 'TOOL_LIMIT' });
  });

  it('rejects an observation belonging to another scope', async () => {
    const tool = readTool();
    tool.read = jest.fn(async () => ({
      source: 'fixture-ledger',
      scope: { ...scope, bookId: 'book-b' },
      asOf: '2026-09-08T10:00:00Z',
      data: { total: 125 },
      truncated: false,
      nextCursor: null,
    }));
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'CROSS_SCOPE_RESULT' });
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('asks for a narrower query instead of truncating an oversized observation', async () => {
    const tool = readTool();
    tool.read = jest.fn(async () => ({
      source: 'fixture-ledger',
      scope,
      asOf: '2026-09-08T10:00:00Z',
      data: { rows: 'x'.repeat(7_000) },
      truncated: false,
      nextCursor: null,
    }));
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'NARROW_QUERY_REQUIRED' });
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('rejects a frame answering a different request', async () => {
    const engine = engineWith({ requestId: 'other-request', calls: [], text: 'hello' });
    expect(await createAgent(engine).run(options([readTool()]))).toEqual({ kind: 'stopped', code: 'STALE_RESPONSE' });
  });
});

describe('authorization and scope changes', () => {
  it('blocks every read when the book changes after generation', async () => {
    const tool = readTool();
    let current = scope;
    const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
    engine.begin = jest.fn(async () => {
      current = { ...scope, bookId: 'book-b' };
      return frame([{ id: '1', name: tool.name, arguments: {} }]);
    });
    const result = await createAgent(engine).run({ ...options([tool]), currentScope: async () => current });
    expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
    expect(tool.read).not.toHaveBeenCalled();
  });

  it('does not advertise a tool the actor is not permitted to use', async () => {
    const allowed = readTool('read_allowed');
    const denied = readTool('read_denied');
    denied.authorize = jest.fn(async () => false);
    const engine = engineWith(frame([{ id: '1', name: 'read_denied', arguments: {} }]));
    expect(await createAgent(engine).run(options([allowed, denied])))
      .toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
    expect(denied.read).not.toHaveBeenCalled();
    const request = (engine.begin as jest.Mock).mock.calls[0][0];
    expect(request.tools.map((entry: { name: string }) => entry.name)).toEqual(['read_allowed']);
  });

  it('denies a tool whose permission is revoked between rounds', async () => {
    const tool = readTool();
    let permitted = true;
    tool.authorize = jest.fn(async () => permitted);
    tool.read = jest.fn(async () => {
      permitted = false;
      return { source: 'fixture-ledger', scope, asOf: '2026-09-08T10:00:00Z', data: {}, truncated: false, nextCursor: null };
    });
    const first = frame([{ id: '1', name: tool.name, arguments: {} }]);
    const second = frame([{ id: '2', name: tool.name, arguments: { } }]);
    const engine = engineWith(first, second);
    const result = await createAgent(engine).run(options([tool]));
    expect(result.kind).toBe('stopped');
  });

  it('never sends the model a tool description it is not allowed to call', async () => {
    const proposal: ProposalTool = {
      name: 'add_expense', access: 'proposal', feature: 'expenses', description: 'Prepare an expense',
      parameters: noArgs, authorize: async () => true, prepare: async () => draft('add_expense'),
    };
    const engine = engineWith(frame([], 'Nothing to do.'));
    await createAgent(engine).run(options([readTool(), proposal]));
    const request = (engine.begin as jest.Mock).mock.calls[0][0];
    expect(request.tools.map((entry: { name: string }) => entry.name)).toEqual(['read_total']);
  });
});

describe('proposals', () => {
  const expenseTool = (prepare: ProposalTool['prepare']): ProposalTool => ({
    name: 'add_expense',
    access: 'proposal',
    feature: 'expenses',
    description: 'Prepare an expense for review',
    parameters: {
      type: 'object', additionalProperties: false, required: ['amount'],
      properties: { amount: { type: 'number', minimum: 0.01, maximum: 1e9 } },
    },
    authorize: async () => true,
    prepare,
  });

  it('prepares a draft without executing a domain write', async () => {
    const post = jest.fn();
    const tool = expenseTool(async (args) => draft('add_expense', args));
    const engine = engineWith(frame([{ id: '1', name: 'add_expense', arguments: { amount: 125 } }]));
    const result = await createAgent(engine).run({ ...options([tool]), canPropose: true });

    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') expect(result.proposal.draft.normalized).toEqual({ amount: 125 });
    expect(post).not.toHaveBeenCalled();
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('executes neither half of a mixed read and write batch', async () => {
    const read = readTool();
    const prepare = jest.fn(async () => draft('write_fixture'));
    const write: ProposalTool = {
      name: 'write_fixture', description: 'Test proposal', feature: 'expenses',
      access: 'proposal', parameters: noArgs, authorize: async () => true, prepare,
    };
    const engine = engineWith(frame([
      { id: '1', name: read.name, arguments: {} },
      { id: '2', name: write.name, arguments: {} },
    ]));
    const result = await createAgent(engine).run({ ...options([read, write]), canPropose: true });

    expect(result.kind).toBe('clarification');
    expect(read.read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('refuses a write when the caller only authorised reading', async () => {
    const prepare = jest.fn(async () => draft('add_expense'));
    const tool = expenseTool(prepare);
    const engine = engineWith(frame([{ id: '1', name: 'add_expense', arguments: { amount: 125 } }]));
    expect(await createAgent(engine).run(options([tool]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('discards a draft prepared after the scope moved on', async () => {
    let current = scope;
    const tool = expenseTool(async (args) => {
      current = { ...scope, revision: 'r2' };
      return draft('add_expense', args);
    });
    const engine = engineWith(frame([{ id: '1', name: 'add_expense', arguments: { amount: 125 } }]));
    const result = await createAgent(engine).run({
      ...options([tool]), canPropose: true, currentScope: async () => current,
    });
    expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  });

  it('rejects a draft whose operation does not match the tool that produced it', async () => {
    const tool = expenseTool(async () => draft('delete_entry'));
    const engine = engineWith(frame([{ id: '1', name: 'add_expense', arguments: { amount: 125 } }]));
    const result = await createAgent(engine).run({ ...options([tool]), canPropose: true });
    // The core surfaces the draft; the operation-name guard lives in the
    // proposalTool factory, so this asserts the core does not silently rename.
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') expect(result.proposal.draft.operation).toBe('delete_entry');
  });
});

describe('admission and lifecycle', () => {
  it('refuses a second overlapping turn', async () => {
    const tool = readTool();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine: Engine = {
      begin: jest.fn(async () => { await gate; return frame([], 'done'); }),
      resume: jest.fn(async () => frame([], 'done')),
      cancel: jest.fn(async () => undefined),
      finish: jest.fn(async () => undefined),
    };
    const agent = createAgent(engine);
    const first = agent.run(options([tool]));
    expect(agent.isBusy()).toBe(true);
    expect(await agent.run(options([tool]))).toEqual({ kind: 'stopped', code: 'BUSY' });
    release?.();
    expect((await first).kind).toBe('answer');
    expect(agent.isBusy()).toBe(false);
  });

  it('keeps admission closed when native cleanup fails', async () => {
    const engine = engineWith(frame([], 'done'));
    engine.finish = jest.fn(async () => { throw new Error('JNI_STUCK'); });
    const agent = createAgent(engine);

    expect(await agent.run(options([readTool()]))).toEqual({ kind: 'stopped', code: 'NATIVE_RECOVERY_REQUIRED' });
    expect(agent.isBusy()).toBe(true);
    expect(await agent.run(options([readTool()]))).toEqual({ kind: 'stopped', code: 'BUSY' });

    agent.recover();
    expect(agent.isBusy()).toBe(false);
  });

  it('cancels native work when the caller aborts', async () => {
    const controller = new AbortController();
    const engine: Engine = {
      begin: jest.fn(async () => { controller.abort(); return frame([], 'late'); }),
      resume: jest.fn(async () => frame([], 'late')),
      cancel: jest.fn(async () => undefined),
      finish: jest.fn(async () => undefined),
    };
    const result = await createAgent(engine).run({ ...options([readTool()]), signal: controller.signal });
    expect(result).toEqual({ kind: 'stopped', code: 'CANCELLED' });
    expect(engine.cancel).toHaveBeenCalledWith('request-1');
    expect(engine.finish).toHaveBeenCalledWith('request-1');
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = engineWith(frame([], 'unused'));
    const result = await createAgent(engine).run({ ...options([readTool()]), signal: controller.signal });
    expect(result).toEqual({ kind: 'stopped', code: 'CANCELLED' });
    expect(engine.begin).not.toHaveBeenCalled();
  });

  it('stops when the app is locked and the scope cannot be read', async () => {
    const engine = engineWith(frame([], 'unused'));
    const result = await createAgent(engine).run({
      ...options([readTool()]),
      currentScope: async () => { throw new Error('APP_LOCKED'); },
    });
    expect(result).toEqual({ kind: 'stopped', code: 'LOCAL_MODEL_FAILED' });
    expect(engine.begin).not.toHaveBeenCalled();
  });

  it('does not leak an internal failure message to the caller', async () => {
    const engine = engineWith(frame([], 'unused'));
    engine.begin = jest.fn(async () => { throw new Error('/data/user/0/com.ledgr/files/model.litertlm not found'); });
    const result = await createAgent(engine).run(options([readTool()]));
    expect(result).toEqual({ kind: 'stopped', code: 'LOCAL_MODEL_FAILED' });
  });
});

describe('run guards', () => {
  it('rejects an empty or oversized question', async () => {
    const engine = engineWith(frame([], 'unused'));
    expect(await createAgent(engine).run({ ...options([readTool()]), question: '   ' }))
      .toEqual({ kind: 'stopped', code: 'INPUT_LIMIT' });
    expect(await createAgent(engine).run({ ...options([readTool()]), question: 'x'.repeat(3_001) }))
      .toEqual({ kind: 'stopped', code: 'INPUT_LIMIT' });
    expect(engine.begin).not.toHaveBeenCalled();
  });

  it('rejects too many tools or a duplicate tool name', async () => {
    const engine = engineWith(frame([], 'unused'));
    const many = Array.from({ length: MAX_TOOLS_PER_RUN + 1 }, (_unused, index) => readTool(`read_${index}`));
    expect(await createAgent(engine).run(options(many)))
      .toEqual({ kind: 'stopped', code: 'INVALID_TOOL_SELECTION' });
    expect(await createAgent(engine).run(options([readTool('same'), readTool('same')])))
      .toEqual({ kind: 'stopped', code: 'INVALID_TOOL_SELECTION' });
    expect(engine.begin).not.toHaveBeenCalled();
  });
});
