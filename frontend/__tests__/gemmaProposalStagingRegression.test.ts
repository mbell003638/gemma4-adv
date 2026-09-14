const mockCurrentScope = jest.fn();
const mockCreate = jest.fn();
const mockCancel = jest.fn();
jest.mock('../src/db/backend', () => ({ activeSqlRunner: () => ({}) }));
jest.mock('../src/accountingV2/gemma/branchPorts', () => ({ toScope: (scope: unknown) => scope }));
jest.mock('../src/accountingV2/gemma/liveBookContext', () => ({ liveBookContext: () => mockCurrentScope() }));
jest.mock('../src/accountingV2/gemma/proposalStore', () => ({
  ProposalStore: jest.fn().mockImplementation(() => ({ create: (input: unknown) => mockCreate(input), markCancelled: (id: string) => mockCancel(id) })),
}));
jest.mock('../src/accountingV2/gemma/proposalExecutor', () => ({
  cancelProposal: (store: { markCancelled(id: string): Promise<void> }, id: string) => store.markCancelled(id),
  createProposalExecutor: jest.fn(),
}));
import { stageLiveProposal, assistantScopeIsCurrent } from '../src/accountingV2/gemma/liveProposalController';
import type { Scope, ScopedDraft } from '../src/accountingV2/gemma/agentCore';
const origin: Scope = { bookId: 'a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'cash', today: '2026-09-14', timeZone: 'Asia/Calcutta' };
const draft = (): ScopedDraft => ({ draft: { operation: 'add_expense', normalized: { amount: 100 }, preview: '100',
  destructive: false, entityVersions: {} }, scope: { ...origin }, requestId: 'original-request' });
beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentScope.mockReset().mockResolvedValue(origin);
  mockCreate.mockReset().mockImplementation(async input => ({ ...input, id: 'stored-id' }));
  mockCancel.mockReset().mockResolvedValue(undefined);
});
test('wrong-book envelope never reaches create', async () => {
  mockCurrentScope.mockResolvedValue({ ...origin, bookId: 'b' });
  await expect(stageLiveProposal(draft())).rejects.toThrow('STALE_SCOPE');
  expect(mockCreate).not.toHaveBeenCalled();
});

test('post-write display tolerates only revision advancement, never changed authority', async () => {
  mockCurrentScope.mockResolvedValue({ ...origin, revision: 'r2' });
  expect(await assistantScopeIsCurrent(origin)).toBe(false);
  expect(await assistantScopeIsCurrent(origin, true)).toBe(true);
  for (const field of ['bookId', 'locationId', 'actorId', 'permissionEpoch', 'featureEpoch']) {
    mockCurrentScope.mockResolvedValue({ ...origin, revision: 'r2', [field]: 'changed' });
    expect(await assistantScopeIsCurrent(origin, true)).toBe(false);
  }
  mockCurrentScope.mockRejectedValue(new Error('APP_LOCKED'));
  expect(await assistantScopeIsCurrent(origin, true)).toBe(false);
});
test('missing origin metadata never stages', async () => {
  const value = draft();
  await expect(stageLiveProposal({ ...value, requestId: '' })).rejects.toThrow('STALE_SCOPE');
  expect(mockCreate).not.toHaveBeenCalled();
});
test.each(['bookId', 'locationId', 'actorId', 'permissionEpoch', 'featureEpoch', 'revision'])('change during create: %s', async field => {
  mockCreate.mockImplementation(async input => {
    mockCurrentScope.mockResolvedValue({ ...origin, [field]: 'changed' });
    return { ...input, id: 'stored-id' };
  });
  await expect(stageLiveProposal(draft())).rejects.toThrow('STALE_SCOPE');
  expect(mockCreate.mock.calls[0][0].scope).toEqual(origin);
  expect(mockCancel).toHaveBeenCalledWith('stored-id');
});
test('cancellation failure cannot turn stale staging into a preview or mask terminal code', async () => {
  mockCurrentScope.mockResolvedValueOnce(origin).mockRejectedValueOnce(new Error('APP_LOCKED'));
  mockCancel.mockRejectedValue(new Error('SQLITE_NOT_READY'));
  await expect(stageLiveProposal(draft())).rejects.toThrow('STALE_SCOPE');
});
test('snapshot preserves request, payload and preview across the first await', async () => {
  const input = draft();
  mockCurrentScope.mockImplementationOnce(async () => {
    input.draft.normalized.amount = 500; input.draft.preview = '500';
    input.draft.entityVersions.other = 'injected';
    return origin;
  }).mockResolvedValue(origin);
  expect(await stageLiveProposal(input)).toEqual({ id: 'stored-id', preview: '100', destructive: false });
  expect(mockCreate.mock.calls[0][0]).toMatchObject({
    requestId: 'original-request', normalized: { amount: 100 }, scope: origin, entityVersions: {},
  });
});
