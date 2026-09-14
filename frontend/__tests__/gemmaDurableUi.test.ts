import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Gemma durable confirmation wiring', () => {
  it('stages a model draft and returns only a local proposal preview/id to Ask', () => {
    const ask = read('src/accountingV2/onDeviceAsk.ts');
    expect(ask).toContain('stageLiveProposal(gemma.proposal)');
    expect(ask).toContain('durableProposal');
    expect(ask).not.toContain('action: gemma.draft');
  });

  it('confirms by proposal id and uses the transaction-bound action port', () => {
    const controller = read('src/accountingV2/gemma/liveProposalController.ts');
    expect(controller).toContain('createProposalExecutor');
    expect(controller).toContain('createTransactionActionPort()');
    expect(controller).toContain('(id)');
    const screen = read('app/ask.tsx');
    expect(screen).toContain('confirmLiveProposal(proposal.id)');
    expect(screen).toContain('ask-durable-proposal-card');
    expect(screen).toContain('Only this proposal ID can be confirmed.');
  });
});
