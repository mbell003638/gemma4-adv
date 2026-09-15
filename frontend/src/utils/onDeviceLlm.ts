/* eslint-disable @typescript-eslint/no-require-imports */
import {
  LEDGR_ON_DEVICE_TOOL_NAMES,
  advertisedRamBytes,
  ledgrOnDeviceToolContext,
  isReadToolName,
  ledgrOnDeviceToolsJson,
  toolCallToAskAction,
  toolCallToVoiceCommand,
  type LedgrOnDeviceToolCall,
  type LedgrOnDeviceToolName,
  type OnDevicePackCapability,
} from '../accountingV2/onDeviceTools';
import type { VoiceCommand } from '../accountingV2/voicePartyResolution';
import {
  DEFAULT_PACK_MANIFEST_URL,
  ON_DEVICE_PACK_SCHEMA,
  bundledPacks,
  parsePackManifest,
  type OnDevicePack,
} from '../accountingV2/onDevicePackManifest';

function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

export type OnDeviceLlmStatus = {
  supported: boolean;
  needleAvailable: boolean;
  engineLoaded: boolean;
  reason?: string;
  totalRamBytes?: number;
};

export type OptionalModelStatus = {
  id: string;
  installed: boolean;
  eligible: boolean;
  bytesOnDisk?: number;
  /** Bytes already fetched into the .part file, for resuming. Absent on older native builds. */
  partialBytes?: number;
};

type NativeOnDeviceLlm = {
  isAvailable?: () => Promise<boolean> | boolean;
  getStatus?: () => Promise<OnDeviceLlmStatus> | OnDeviceLlmStatus;
  runNeedle?: (transcript: string, toolsJson: string) => Promise<string> | string;
  runOptional?: (modelId: string, filename: string, prompt: string, imageUri?: string, audioUri?: string) => Promise<string> | string;
  /** Packs are described by JS so a manifest can add one without a new APK. */
  listOptional?: (packsJson: string) => Promise<OptionalModelStatus[]> | OptionalModelStatus[];
  downloadOptional?: (modelId: string, url: string, filename: string, sha256?: string | null, expectedBytes?: number, minRamBytes?: number) => Promise<boolean> | boolean;
  cancelDownload?: (modelId: string) => Promise<boolean> | boolean;
  deleteOptional?: (modelId: string, filename: string) => Promise<boolean> | boolean;
  addListener?: (event: string, listener: (payload: any) => void) => { remove: () => void };
};

function nativeModule(): NativeOnDeviceLlm | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== 'android') return null;
  try {
    return require('expo-modules-core').requireOptionalNativeModule('LedgrOnDeviceLlm')
      || (NativeModules as any).LedgrOnDeviceLlm
      || null;
  } catch { return (NativeModules as any).LedgrOnDeviceLlm || null; }
}

function parseToolCall(raw: string): LedgrOnDeviceToolCall | null {
  const text = String(raw || '').trim();
  if (!text || text === 'null' || text === '{}') return null;
  try {
    const decoded = JSON.parse(text);
    // The training set frames a call as `answers: [{name, arguments}]`, so the
    // model emits an array. Accepting only a bare object meant a correctly
    // formed call parsed to null and looked like "no tool call".
    const parsed = Array.isArray(decoded) ? decoded[0] : decoded;
    if (!parsed || typeof parsed !== 'object') return null;
    const name = String(parsed.name || parsed.tool || parsed.type || parsed.function?.name || '').trim() as LedgrOnDeviceToolName;
    if (!LEDGR_ON_DEVICE_TOOL_NAMES.includes(name)) return null;
    const args = parsed.arguments || parsed.params || parsed.function?.arguments || {};
    const argumentsObject = typeof args === 'string' ? JSON.parse(args) : args;
    if (!argumentsObject || typeof argumentsObject !== 'object') return null;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;
    if (confidence != null && confidence < 0.35) return null;
    return { name, arguments: argumentsObject, confidence };
  } catch { return null; }
}

export async function getOnDeviceLlmStatus(): Promise<OnDeviceLlmStatus> {
  const { Platform } = nativeRuntime();
  const module = nativeModule();
  if (!module) {
    return {
      supported: Platform.OS === 'android',
      needleAvailable: false,
      engineLoaded: false,
      reason: Platform.OS === 'android'
        ? 'On-device Needle is available in a native Android build that vendors the Cactus engine.'
        : 'On-device Needle is supported only on Android.',
    };
  }
  try {
    if (module.getStatus) return await module.getStatus();
    const available = module.isAvailable ? await module.isAvailable() : true;
    return { supported: true, needleAvailable: available, engineLoaded: available };
  } catch {
    return { supported: true, needleAvailable: false, engineLoaded: false, reason: 'Could not query the on-device LLM engine.' };
  }
}

export async function runNeedleTools(transcript: string, partyHints: string[] = []): Promise<LedgrOnDeviceToolCall | null> {
  const module = nativeModule();
  if (!module?.runNeedle) return null;
  // The date, known parties and rules travel with the transcript now that the
  // tool argument is the bare array needle_init expects.
  const prompt = `${ledgrOnDeviceToolContext(partyHints)}
USER: ${transcript.trim()}`;
  const raw = await module.runNeedle(prompt, ledgrOnDeviceToolsJson(partyHints));
  return parseToolCall(String(raw || ''));
}

/**
 * One agent turn: let Needle read before it acts.
 *
 * Reads are chained -- "how much does Amit owe" may need a lookup before an
 * answer -- but the loop stops the moment a WRITE tool is proposed, so the
 * proposal reaches validateAssistantProposal and the user's confirmation sheet
 * exactly as a single-shot call would. The cap is small on purpose: a phone is
 * not the place for an open-ended agent loop, and three steps covers the
 * look-up-then-act shape without ever running away.
 */
export const NEEDLE_MAX_AGENT_STEPS = 3;

export type NeedleAgentTurn =
  | { kind: 'write'; call: LedgrOnDeviceToolCall; steps: number }
  | { kind: 'answer'; text: string; steps: number }
  | { kind: 'none'; steps: number };

export async function runNeedleAgentTurn(
  transcript: string,
  partyHints: string[] = [],
  runRead: (call: LedgrOnDeviceToolCall) => Promise<string> = async () => '',
): Promise<NeedleAgentTurn> {
  let prompt = transcript.trim();
  const observations: string[] = [];

  for (let step = 1; step <= NEEDLE_MAX_AGENT_STEPS; step += 1) {
    const call = await runNeedleTools(prompt, partyHints);
    if (!call) {
      return observations.length
        ? { kind: 'answer', text: observations.join('\n'), steps: step }
        : { kind: 'none', steps: step };
    }
    if (!isReadToolName(call.name)) {
      return { kind: 'write', call, steps: step };
    }
    const observation = await runRead(call);
    if (observation) observations.push(observation);
    // Feed the result back so the next step can build on what was just read.
    prompt = `${prompt}\nTOOL ${call.name} RESULT: ${observation || '(nothing found)'}`;
  }

  return observations.length
    ? { kind: 'answer', text: observations.join('\n'), steps: NEEDLE_MAX_AGENT_STEPS }
    : { kind: 'none', steps: NEEDLE_MAX_AGENT_STEPS };
}

export async function interpretNeedleVoiceCommand(transcript: string, partyHints: string[] = []): Promise<VoiceCommand | null> {
  const call = await runNeedleTools(transcript, partyHints);
  return call ? toolCallToVoiceCommand(call) : null;
}

export async function interpretNeedleAskAction(transcript: string, partyHints: string[] = []): Promise<{ type: string; params: Record<string, unknown> } | null> {
  const call = await runNeedleTools(transcript, partyHints);
  return call ? toolCallToAskAction(call) : null;
}

const PACK_MANIFEST_URL_KEY = 'ledgr_pack_manifest_url';
const PACK_MANIFEST_CACHE_KEY = 'ledgr_pack_manifest_cache';

export async function getPackManifestUrl(): Promise<string> {
  try { return (await asyncStorage()?.getItem(PACK_MANIFEST_URL_KEY)) || DEFAULT_PACK_MANIFEST_URL; }
  catch { return DEFAULT_PACK_MANIFEST_URL; }
}

export async function setPackManifestUrl(url: string | null): Promise<void> {
  const storage = asyncStorage();
  if (!storage) return;
  if (url && url.trim()) await storage.setItem(PACK_MANIFEST_URL_KEY, url.trim());
  else await storage.removeItem(PACK_MANIFEST_URL_KEY);
}

/**
 * The packs on offer. A manifest lets a URL be corrected or a pack added
 * without shipping a new APK, but it is never required: a fetch that fails
 * falls back to the last good copy, and then to what shipped in this build, so
 * losing the network never takes the feature away.
 */
export async function resolveOnDevicePacks(options: { refresh?: boolean } = {}): Promise<OnDevicePack[]> {
  const storage = asyncStorage();
  if (options.refresh) {
    try {
      const response = await fetch(await getPackManifestUrl(), { headers: { accept: 'application/json' } });
      if (response.ok) {
        const packs = parsePackManifest(await response.json());
        if (packs.length) {
          try { await storage?.setItem(PACK_MANIFEST_CACHE_KEY, JSON.stringify(packs)); } catch { /* cache is optional */ }
          return packs;
        }
      }
    } catch { /* fall through to cache */ }
  }
  try {
    const cached = await storage?.getItem(PACK_MANIFEST_CACHE_KEY);
    if (cached) {
      const decoded = JSON.parse(cached);
      const packs = parsePackManifest(
        Array.isArray(decoded) ? { schema: ON_DEVICE_PACK_SCHEMA, packs: decoded } : decoded,
      );
      if (packs.length) return packs;
    }
  } catch { /* fall through to bundled */ }
  return bundledPacks();
}

export async function listOptionalOnDeviceModels(): Promise<InstalledOnDevicePack[]> {
  const module = nativeModule();
  const packs = await resolveOnDevicePacks();
  const descriptors = JSON.stringify(packs.map((pack) => ({
    id: pack.id, filename: pack.filename, minRamBytes: pack.minRamBytes,
  })));
  const nativeList = module?.listOptional ? await module.listOptional(descriptors) : [];
  const byId = new Map(nativeList.map((row) => [row.id, row]));
  const ram = advertisedRamBytes((await getOnDeviceLlmStatus()).totalRamBytes);
  return packs.map((model) => {
    const native = byId.get(model.id);
    return {
      ...model,
      installed: Boolean(native?.installed),
      eligible: native?.eligible ?? (ram == null || ram >= model.minRamBytes),
      bytesOnDisk: native?.bytesOnDisk,
    };
  });
}

export type InstalledOnDevicePack = OnDevicePack & OptionalModelStatus;

/**
 * Picks the pack to answer with. Previously this took the first installed entry
 * in array order, so a phone holding both Gemma 3 1B and 4 E2B silently used
 * 3 1B -- the weaker one -- because it happened to be listed first.
 *
 * Ranking replaces array order, and a pack is only considered when it declares
 * every capability the task needs, so an image is never handed to a text-only
 * pack. A pinned pack wins outright, but falls back to Auto when it is not
 * installed or the phone cannot run it, rather than leaving Ask unavailable.
 */
export function selectOnDevicePack(
  packs: InstalledOnDevicePack[],
  needs: OnDevicePackCapability[] = ['text'],
  preferredId?: string | null,
): InstalledOnDevicePack | null {
  const usable = packs.filter((pack) => (
    pack.installed
    && pack.eligible
    && needs.every((capability) => pack.capabilities.includes(capability))
  ));
  if (preferredId) {
    const pinned = usable.find((pack) => pack.id === preferredId);
    if (pinned) return pinned;
  }
  return usable.slice().sort((a, b) => b.rank - a.rank)[0] || null;
}

/**
 * Which pack the user pinned, or null for Auto. Lives here rather than in
 * api.ts because api.ts already imports this module, and the reverse import
 * would be circular.
 */
export const PREFERRED_ON_DEVICE_MODEL_KEY = 'ledgr_preferred_on_device_model';

function asyncStorage(): { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void>; removeItem: (k: string) => Promise<void> } | null {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

export async function getPreferredOnDevicePack(): Promise<string | null> {
  try { return (await asyncStorage()?.getItem(PREFERRED_ON_DEVICE_MODEL_KEY)) || null; } catch { return null; }
}

export async function setPreferredOnDevicePack(id: string | null): Promise<void> {
  const storage = asyncStorage();
  if (!storage) return;
  if (id) await storage.setItem(PREFERRED_ON_DEVICE_MODEL_KEY, id);
  else await storage.removeItem(PREFERRED_ON_DEVICE_MODEL_KEY);
}

/** The pack Ask should use for a task, honouring the pinned-model setting. */
export async function bestOnDevicePack(
  needs: OnDevicePackCapability[] = ['text'],
): Promise<InstalledOnDevicePack | null> {
  const [packs, preferred] = await Promise.all([
    listOptionalOnDeviceModels(),
    getPreferredOnDevicePack(),
  ]);
  return selectOnDevicePack(packs, needs, preferred);
}

export async function downloadOptionalOnDeviceModel(
  id: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const model = (await resolveOnDevicePacks()).find((row) => row.id === id);
  if (!model) throw new Error('Unknown on-device model.');
  const module = nativeModule();
  if (!module?.downloadOptional) throw new Error('Model download requires an Android native build.');
  let subscription: { remove: () => void } | undefined;
  if (onProgress && module.addListener) {
    subscription = module.addListener('downloadProgress', (payload: { id?: string; received?: number; total?: number }) => {
      if (payload?.id && payload.id !== id) return;
      onProgress(Number(payload.received || 0), Number(payload.total || model.bytes));
    });
  }
  try {
    await module.downloadOptional(id, model.downloadUrl, model.filename, model.sha256 ?? null, model.bytes, model.minRamBytes);
  } finally {
    subscription?.remove();
  }
}

/**
 * Stops an in-flight download and discards its partial file. Safe to call when
 * nothing is downloading, so a UI cancel button needs no guard of its own.
 */
export async function cancelOptionalOnDeviceModelDownload(id: string): Promise<void> {
  const module = nativeModule();
  if (!module?.cancelDownload) return;
  try { await module.cancelDownload(id); } catch { /* already finished or never started */ }
}

export async function deleteOptionalOnDeviceModel(id: string): Promise<void> {
  const module = nativeModule();
  if (!module?.deleteOptional) throw new Error('Deleting a model requires an Android native build.');
  const model = (await resolveOnDevicePacks()).find((row) => row.id === id);
  if (!model) throw new Error('Unknown on-device model.');
  await module.deleteOptional(id, model.filename);
}

export async function runOptionalOnDeviceModel(input: {
  id: string;
  prompt: string;
  imageUri?: string;
  audioUri?: string;
}): Promise<string> {
  const module = nativeModule();
  if (!module?.runOptional) throw new Error('The optional on-device model is not loaded.');
  const model = (await resolveOnDevicePacks()).find((row) => row.id === input.id);
  if (!model) throw new Error('Unknown on-device model.');
  return String(await module.runOptional(input.id, model.filename, input.prompt, input.imageUri, input.audioUri) || '').trim();
}
