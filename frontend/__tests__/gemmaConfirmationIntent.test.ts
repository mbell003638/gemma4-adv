import { confirmationIntent, handlePendingConfirmation, requestIsCurrent } from '../src/accountingV2/gemma/confirmationIntent';

test.each(['yes', 'YES!', 'i confirm', 'please apply'])('exact confirm: %s', value => {
  expect(confirmationIntent(value)).toBe('confirm');
});
test.each(['okay.', 'y', 'ok'])('weak tokens do not confirm: %s', value => {
  expect(confirmationIntent(value)).toBe('other');
});
describe.each(['durable', 'legacy'])('%s pending handler', () => {
  test.each(['yes, but make it 500 instead', 'okay cancel it', 'proceed only after I check',
    'yes please change the book', '"yes"', 'do not apply', 'not okay', 'yes?', 'apply?'])('zero writes: %s', async value => {
    const domainWrite = jest.fn();
    const cancel = jest.fn();
    const clarify = jest.fn();
    await handlePendingConfirmation(value, { confirm: domainWrite, cancel, clarify });
    expect(domainWrite).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(clarify).toHaveBeenCalledTimes(1);
  });
  test.each(['no', 'cancel', 'never mind'])('cancel never applies: %s', async value => {
    const confirm = jest.fn(); const cancel = jest.fn();
    await handlePendingConfirmation(value, { confirm, cancel, clarify: jest.fn() });
    expect(confirm).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  test('exact confirmation calls apply once', async () => {
    const confirm = jest.fn();
    await handlePendingConfirmation('Please apply!', { confirm, cancel: jest.fn(), clarify: jest.fn() });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
test.each(['unmount', 'new ask', 'cancel', 'scope change'])('epoch changes during scope lookup: %s', async () => {
  let sequence = 1;
  let release!: (value: boolean) => void;
  const pending = requestIsCurrent(1, () => sequence, () => new Promise(resolve => { release = resolve; }));
  sequence += 1;
  release(true);
  expect(await pending).toBe(false);
});
test('current scope and epoch permits display; stale scope does not', async () => {
  expect(await requestIsCurrent(1, () => 1, async () => true)).toBe(true);
  expect(await requestIsCurrent(1, () => 1, async () => false)).toBe(false);
});

test('failed scope lookup is terminal and an already stale request never looks up scope', async () => {
  expect(await requestIsCurrent(1, () => 1, async () => { throw new Error('APP_LOCKED'); })).toBe(false);
  const check = jest.fn(async () => true);
  expect(await requestIsCurrent(1, () => 2, check)).toBe(false);
  expect(check).not.toHaveBeenCalled();
});
