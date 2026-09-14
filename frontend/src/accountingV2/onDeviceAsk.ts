import { isExplicitBookMutationRequest, isOnDeviceInterpretation } from '../db/ai';
import {
  bestOnDevicePack,
  interpretNeedleAskAction,
  runNeedleAgentTurn,
  runOptionalOnDeviceModel,
} from '../utils/onDeviceLlm';
import { OPTIONAL_ON_DEVICE_MODELS, type LedgrOnDeviceToolCall } from './onDeviceTools';
import { askWithLiveGemma } from './gemma/liveGemmaAsk';
import { stageLiveProposal, type DurableProposalPreview } from './gemma/liveProposalController';

function trimSnapshot(dataContext: string): string {
  return dataContext.length > 4000 ? `${dataContext.slice(0, 4000)}\n[truncated]` : dataContext;
}

function parseAskJson(raw: string): { answer: string; action: { type: string; params: Record<string, unknown> } | null } | null {
  const text = raw.trim();
  const json = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    const action = parsed.action && parsed.action.type ? parsed.action : null;
    return { answer: String(parsed.answer || '').trim(), action };
  } catch { return null; }
}

/**
 * Small on-device models answer "how are you?" in prose, not JSON. Prose is a
 * real answer, so keep it rather than discarding the reply for the wrong shape.
 */
function plainAnswer(raw: string): string {
  const text = String(raw || '').replace(/```[a-z]*\n?|```/gi, '').trim();
  if (!text || text.startsWith('{')) return '';
  return text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}\u2026` : text;
}

/** Device-only / device-first Ask: Needle for mutations, optional Gemma for answers. */
export async function askBooksOnDevice(
  cfg: Parameters<typeof isOnDeviceInterpretation>[0],
  question: string,
  dataContext: string,
  /** Injected so this module never imports `api`, which would pull the whole
   *  app into its module graph. The Ask screen passes runReadTool. */
  runRead?: (call: LedgrOnDeviceToolCall) => Promise<string>,
): Promise<{ answer: string; action: any; durableProposal?: DurableProposalPreview } | null> {
  const mutation = isExplicitBookMutationRequest(question);
  if (mutation) {
    const action = await interpretNeedleAskAction(question);
    if (action) {
      return { answer: 'I prepared this Ledgr change on the phone for your confirmation.', action };
    }
  }

  // Not a mutation: let Needle read the book before answering. A read tool
  // answers from real figures instead of whatever a small model recalls, and
  // the loop stops at any write so the confirmation path is never bypassed.
  try {
    const turn = runRead ? await runNeedleAgentTurn(question, [], runRead) : { kind: 'none' as const, steps: 0 };
    if (turn.kind === 'answer' && turn.text.trim()) {
      return { answer: turn.text.trim(), action: null };
    }
    if (turn.kind === 'write' && mutation) {
      return { answer: 'I prepared this Ledgr change on the phone for your confirmation.', action: { type: turn.call.name, params: turn.call.arguments || {} } };
    }
  } catch {
    /* Needle is optional; fall through to the prose pack. */
  }

  // Gemma receives only scoped tool schemas/results. The broad legacy
  // snapshot below is never supplied to this path.
  {
    try {
      const gemma = await askWithLiveGemma(question, mutation);
      if (gemma?.kind === 'stopped') return { answer: 'The local request stopped. Check the active book and model status before trying again. Nothing was posted.', action: null };
      if (gemma?.kind === 'answer') return { answer: gemma.text, action: null };
      if (gemma?.kind === 'clarification') return { answer: gemma.text, action: null };
      if (gemma?.kind === 'proposal') {
        const durableProposal = await stageLiveProposal(gemma.proposal);
        return { answer: 'I prepared this Ledgr change for your review. Nothing has been posted.', action: null, durableProposal };
      }
    } catch {
      return { answer: 'The local request could not finish safely. Check the active book and try again. Nothing was posted.', action: null };
    }
  }

  const installed = await bestOnDevicePack(['text']);
  if (installed) {
    const prompt = [
      'You are Ledgr, a helpful assistant running privately on the phone.',
      'Ledgr is an offline-first double-entry bookkeeping app for small shops: it records sales, expenses,',
      'bills, payments, invoices and stock, and produces profit and loss, balance sheet and trial balance',
      'reports. It works with no internet, keeps the books on this device, and can sync to another phone.',
      'If asked what you or the app can do, answer from that description.',
      'If the question is about this business, answer from the SNAPSHOT and never invent figures or IDs.',
      'If it is a greeting, small talk, or general knowledge, simply answer it in your own words.',
      'Do not delete inventory_count, customer, or supplier.',
      'Prefer JSON {answer, action|null}; plain text is accepted too.',
      `SNAPSHOT:\n${trimSnapshot(dataContext)}`,
      `USER: ${question}`,
    ].join('\n');
    try {
      const raw = await runOptionalOnDeviceModel({ id: installed.id, prompt });
      const parsed = parseAskJson(raw);
      if (parsed) {
        if (parsed.action && !mutation) parsed.action = null;
        if (parsed.answer || parsed.action) return parsed;
      }
      const prose = plainAnswer(raw);
      if (prose) return { answer: prose, action: null };
    } catch {
      /* fall through */
    }
  }

  if (!isOnDeviceInterpretation(cfg)) return null;
  if (mutation) {
    return { answer: 'I could not map that to a Ledgr action on this phone. Add the amount and party, or download an on-device model pack in Advanced Settings.', action: null };
  }
  return {
    answer: installed
      ? 'The on-device model returned nothing usable. Try asking again, or keep the question shorter.'
      : `On-device Ask can record simple entries with Needle. Download ${OPTIONAL_ON_DEVICE_MODELS[0]?.label || 'a model pack'} in Advanced Settings for explanations, or use Reports.`,
    action: null,
  };
}
