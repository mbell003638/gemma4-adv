import { askWithLiveGemma, type LiveGemmaAskDeps } from '../src/accountingV2/gemma/liveGemmaAsk';
import type { Scope } from '../src/accountingV2/gemma/agentCore';

const origin: Scope = { bookId: 'a', locationId: null, actorId: 'local-owner',
  permissionEpoch: 'p1', featureEpoch: 'f1', revision: 'r1', currency: 'INR',
  basis: 'cash', today: '2026-09-14', timeZone: 'Asia/Calcutta' };

test.each(['bookId', 'locationId', 'actorId', 'permissionEpoch', 'featureEpoch', 'revision'])(
  'runtime discovery cannot rebind the original %s', async field => {
    let current = origin;
    const run = jest.fn();
    const composition = jest.fn();
    const deps = {
      captureScope: async () => current,
      runtime: async () => { current = { ...origin, [field]: 'changed' }; return null; },
      run, composition,
    } as LiveGemmaAskDeps;
    expect(await askWithLiveGemma('show my total', false, deps))
      .toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
    expect(run).not.toHaveBeenCalled();
    expect(composition).not.toHaveBeenCalled();
  },
);

test('locking during discovery cannot be treated as runtime unavailability', async () => {
  let locked = false;
  const run = jest.fn();
  const deps = {
    captureScope: async () => { if (locked) throw new Error('APP_LOCKED'); return origin; },
    runtime: async () => { locked = true; return null; },
    run, composition: jest.fn(),
  } as LiveGemmaAskDeps;
  await expect(askWithLiveGemma('show my total', false, deps)).rejects.toThrow('APP_LOCKED');
  expect(run).not.toHaveBeenCalled();
});
