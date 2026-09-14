/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * The typed protocol wrapper over the Gemma native host.
 *
 * Kept separate from `onDeviceLlm.ts` on purpose: Needle's call semantics are
 * unchanged by this work, and a bug in the Gemma protocol must not be able to
 * take the trained transaction path down with it.
 */

import {
  parseFrame,
  type Engine,
  type Frame,
  type NativeRequest,
  type ToolResult,
} from '../accountingV2/gemma/agentCore';
import { GEMMA_BRIDGE_VERSION, type GemmaCapability } from '../accountingV2/gemma/packCatalogV2';
import { assertGemmaHealthy, markGemmaRecoveryRequired, gemmaRecoveryRequest, acknowledgeGemmaRecovery } from '../accountingV2/gemma/runtimeHealth';
import { bounded } from '../accountingV2/gemma/mediaDeadline';
import { MAX_DOCUMENT_PAGES } from '../accountingV2/gemma/documentOutput';
import { assertLifecycleAcknowledgement } from './gemmaLifecycleReply';

/** Mirrors the native host's own input caps, so an oversized request is
 *  refused here with a clear code instead of as a native exception. */
export const MAX_BEGIN_REQUEST_CHARS = 40_000;
export const MAX_RESUME_REQUEST_CHARS = 20_000;

export type GemmaNative = {
  gemmaBegin(json: string): Promise<string>;
  gemmaResume(json: string): Promise<string>;
  gemmaCancel(requestId: string): Promise<void>;
  gemmaFinish(requestId: string): Promise<string>;
};

/**
 * What native reports about itself. Each field is separate because they fail
 * separately: Needle can be present while Gemma is not, a verified download can
 * exist while the backend for a modality does not, and a running request must
 * be visible even when everything else looks ready.
 */
export type GemmaBridgeStatus = {
  recoveryRequired?: boolean;
  managementOperation?: string | null;
  supported: boolean;
  needleAvailable: boolean;
  gemmaBridgeAvailable: boolean;
  bridgeVersion: number;
  /** Model ids whose integrity native has actually confirmed. */
  verifiedModelIds: string[];
  /** Modalities this build has been tested to run on this device. */
  verifiedCapabilities: GemmaCapability[];
  backend?: string;
  runningRequestId?: string | null;
  reason?: string;
};

type NativeGemmaModule = Partial<GemmaNative> & {
  getStatus?: () => Promise<NativeGemmaStatus> | NativeGemmaStatus;
  gemmaDownload?: (modelId: string) => Promise<string>;
  gemmaPauseDownload?: (modelId: string) => Promise<boolean>;
  gemmaDiscardPartial?: (modelId: string) => Promise<string>;
  gemmaRemove?: (modelId: string) => Promise<string>;
  gemmaRecover?: (requestId: string) => Promise<string>;
  gemmaPrepareImage?: (uri: string, requestId: string) => Promise<string>;
  gemmaPreparePdfPage?: (uri: string, pageIndex: number, requestId: string) => Promise<string>;
  gemmaPrepareAudio?: (uri: string, requestId: string) => Promise<string>;
  gemmaDiscardAttachments?: (requestId: string) => Promise<string>;
};

type NativeGemmaStatus = Partial<GemmaBridgeStatus> & {
  gemmaBridgeVersion?: number;
  gemmaCapabilities?: string[];
  gemmaPacks?: Record<string, GemmaPackState>;
  gemmaRecoveryRequired?: boolean;
  gemmaManagementOperation?: string | null;
};

export type GemmaPackState = { state: string; bytesOnDisk: number; partialBytes: number; unsupportedReason?: string | null };
export type GemmaRuntimeStatus = {
  managementOperation?: string | null;
  recoveryRequired?: boolean;
  supported: boolean;
  bridgeVersion: number;
  capabilities: string[];
  packs: Record<string, GemmaPackState>;
};

function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

/**
 * Loads the optional native module, or returns null.
 *
 * Being on Android does not mean a compatible engine is present: Expo Go, the
 * web bundle and the Jest environment all run this code with no native module
 * at all, and a native build predating the tool protocol exports Needle but
 * not `gemmaBegin`. Every one of those cases must be a null, not a throw.
 */
export function loadGemmaNative(): GemmaNative | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== 'android') return null;
  let module: NativeGemmaModule | null = null;
  try {
    module = require('expo-modules-core').requireOptionalNativeModule('LedgrOnDeviceLlm')
      || (NativeModules as Record<string, NativeGemmaModule>).LedgrOnDeviceLlm
      || null;
  } catch {
    module = (NativeModules as Record<string, NativeGemmaModule>).LedgrOnDeviceLlm || null;
  }
  if (!module) return null;
  if (typeof module.gemmaBegin !== 'function' || typeof module.gemmaResume !== 'function'
    || typeof module.gemmaCancel !== 'function' || typeof module.gemmaFinish !== 'function') {
    return null;
  }
  return module as GemmaNative;
}

const UNSUPPORTED: GemmaBridgeStatus = {
  supported: false,
  needleAvailable: false,
  gemmaBridgeAvailable: false,
  bridgeVersion: 0,
  verifiedModelIds: [],
  verifiedCapabilities: [],
  reason: 'The local Gemma runtime needs a native Android build of this app.',
};

function asCapabilities(value: unknown): GemmaCapability[] {
  if (!Array.isArray(value)) return [];
  const allowed: GemmaCapability[] = ['text', 'tools', 'vision', 'audio'];
  return allowed.filter((capability) => value.includes(capability));
}

export async function gemmaBridgeStatus(): Promise<GemmaBridgeStatus> {
  const { Platform } = nativeRuntime();
  const native = loadGemmaNative();
  if (!native) {
    return { ...UNSUPPORTED, supported: Platform.OS === 'android' };
  }
  const module = native as NativeGemmaModule;
  if (!module.getStatus) {
    return {
      ...UNSUPPORTED,
      supported: true,
      gemmaBridgeAvailable: true,
      reason: 'This native build does not report a Gemma bridge version.',
    };
  }
  try {
    const raw = await module.getStatus();
    return {
      recoveryRequired: raw.gemmaRecoveryRequired === true || gemmaRecoveryRequest() !== null,
      managementOperation: raw.gemmaManagementOperation,
      supported: true,
      needleAvailable: raw.needleAvailable === true,
      gemmaBridgeAvailable: raw.gemmaBridgeAvailable === true,
      bridgeVersion: typeof raw.bridgeVersion === 'number' ? raw.bridgeVersion : 0,
      verifiedModelIds: Array.isArray(raw.verifiedModelIds)
        ? raw.verifiedModelIds.filter((id): id is string => typeof id === 'string')
        : [],
      verifiedCapabilities: asCapabilities(raw.verifiedCapabilities),
      ...(typeof raw.backend === 'string' ? { backend: raw.backend } : {}),
      runningRequestId: typeof raw.runningRequestId === 'string' ? raw.runningRequestId : null,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    };
  } catch {
    return { ...UNSUPPORTED, supported: true, reason: 'Could not query the local model runtime.' };
  }
}

export class GemmaBridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GemmaBridgeError';
  }
}

/**
 * Wraps the native module as the agent core's `Engine`.
 *
 * Every native reply goes through `parseFrame`. Casting the bridge string to
 * `Frame` would mean trusting model-authored text to have the shape the loop
 * assumes -- the native side is ours, but what it carries is not.
 */
export function createGemmaEngine(native: GemmaNative): Engine {
  const send = async (json: string, limit: number, call: (payload: string) => Promise<string>): Promise<Frame> => {
    assertGemmaHealthy();
    if (json.length > limit) throw new GemmaBridgeError('REQUEST_TOO_LARGE');
    return parseFrame(await call(json));
  };
  return {
    begin: (request: NativeRequest) =>
      send(JSON.stringify(request), MAX_BEGIN_REQUEST_CHARS, (payload) => native.gemmaBegin(payload)),
    resume: (requestId: string, results: ToolResult[]) =>
      send(JSON.stringify({ requestId, results }), MAX_RESUME_REQUEST_CHARS, (payload) => native.gemmaResume(payload)),
    cancel: (requestId: string) => native.gemmaCancel(requestId),
    finish: async (requestId: string) => {
      try { assertLifecycleAcknowledgement(await native.gemmaFinish(requestId), requestId); }
      catch (error) { markGemmaRecoveryRequired(requestId); throw error; }
    },
  };
}

export type EngineAvailability =
  | { ok: true; engine: Engine; status: GemmaBridgeStatus }
  | { ok: false; code: 'NO_NATIVE_BRIDGE' | 'BRIDGE_TOO_OLD' | 'BRIDGE_UNAVAILABLE'; status: GemmaBridgeStatus };

/**
 * The composition root's single entry point.
 *
 * A bridge older than this JS is an app-update condition, not a model problem:
 * re-downloading three gigabytes cannot add a native protocol that is not in
 * the installed APK, so it must never be offered as the fix.
 */
export async function resolveGemmaEngine(): Promise<EngineAvailability> {
  assertGemmaHealthy();
  const status = await gemmaBridgeStatus();
  const native = loadGemmaNative();
  if (!native) return { ok: false, code: 'NO_NATIVE_BRIDGE', status };
  if (!status.gemmaBridgeAvailable) return { ok: false, code: 'BRIDGE_UNAVAILABLE', status };
  if (status.bridgeVersion < GEMMA_BRIDGE_VERSION) return { ok: false, code: 'BRIDGE_TOO_OLD', status };
  assertGemmaHealthy();
  if (status.recoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if (status.managementOperation) throw new Error('GEMMA_BUSY');
  return { ok: true, engine: createGemmaEngine(native), status };
}

export type InstalledGemmaRuntime = { modelId: string; engine: Engine };
export type PreparedGemmaImage = { handle: string; pageCount: number; excludedPages: number };
export type PreparedGemmaAudio = { handle: string; durationMs: number; sampleRate: number };

function objectFrame(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error('GEMMA_MEDIA_FRAME_INVALID');
  if (raw.length > 16_384) throw new Error('GEMMA_MEDIA_FRAME_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('GEMMA_MEDIA_FRAME_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GEMMA_MEDIA_FRAME_INVALID');
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new Error(`GEMMA_MEDIA_${field}_INVALID`);
  return value;
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`GEMMA_MEDIA_${field}_INVALID`);
  return value as number;
}

async function mediaModule(capability: GemmaCapability): Promise<NativeGemmaModule> {
  assertGemmaHealthy();
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const status = await gemmaBridgeStatus();
  if (!status.gemmaBridgeAvailable || status.bridgeVersion < GEMMA_BRIDGE_VERSION) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  assertGemmaHealthy();
  if (status.recoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if (status.managementOperation) throw new Error('GEMMA_BUSY');
  if (!status.verifiedCapabilities.includes(capability)) throw new Error(`GEMMA_${capability.toUpperCase()}_UNVERIFIED`);
  return module;
}

export function parsePreparedGemmaImage(raw: string): PreparedGemmaImage {
  const value = objectFrame(raw);
  return {
    handle: boundedString(value.handle, 'HANDLE'),
    pageCount: boundedInteger(value.pageCount, 'PAGE_COUNT', 10_000),
    excludedPages: boundedInteger(value.excludedPages, 'EXCLUDED_PAGES', 10_000),
  };
}

export function parsePreparedGemmaAudio(raw: string): PreparedGemmaAudio {
  const value = objectFrame(raw);
  return {
    handle: boundedString(value.handle, 'HANDLE'),
    durationMs: boundedInteger(value.durationMs, 'DURATION', 60_000),
    sampleRate: boundedInteger(value.sampleRate, 'SAMPLE_RATE', 192_000),
  };
}

/** Media remains unavailable until the installed APK explicitly verifies vision/audio. */
export async function prepareGemmaImage(uri: string, requestId: string): Promise<PreparedGemmaImage> {
  const module = await mediaModule('vision');
  if (!module.gemmaPrepareImage) throw new Error('GEMMA_VISION_UNAVAILABLE');
  return parsePreparedGemmaImage(await module.gemmaPrepareImage(uri, requestId));
}

export async function prepareGemmaPdfPage(uri: string, pageIndex: number, requestId: string): Promise<PreparedGemmaImage> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= MAX_DOCUMENT_PAGES) throw new Error('GEMMA_PDF_PAGE_LIMIT');
  const module = await mediaModule('vision');
  if (!module.gemmaPreparePdfPage) throw new Error('GEMMA_VISION_UNAVAILABLE');
  return parsePreparedGemmaImage(await module.gemmaPreparePdfPage(uri, pageIndex, requestId));
}

export async function prepareGemmaAudio(uri: string, requestId: string): Promise<PreparedGemmaAudio> {
  const module = await mediaModule('audio');
  if (!module.gemmaPrepareAudio) throw new Error('GEMMA_AUDIO_UNAVAILABLE');
  return parsePreparedGemmaAudio(await module.gemmaPrepareAudio(uri, requestId));
}

export async function discardGemmaAttachments(requestId: string): Promise<number> {
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module?.gemmaDiscardAttachments) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  if (!(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_TOO_OLD');
  const removed = objectFrame(await module.gemmaDiscardAttachments(requestId)).removed;
  if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0) throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}

/** Resolve only a native host with text/tools and a verified installed pack. */
export async function installedGemmaRuntime(): Promise<InstalledGemmaRuntime | null> {
  assertGemmaHealthy();
  const health = await gemmaPackStatus();
  if (health.recoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if (health.managementOperation || Object.values(health.packs).some(pack => pack.state === 'verifying')) throw new Error('GEMMA_VERIFYING');
  const resolved = await resolveGemmaEngine();
  if (!resolved.ok) return null;
  const capabilities = resolved.status.verifiedCapabilities;
  if (!capabilities.includes('text') || !capabilities.includes('tools')) return null;
  const modelId = ['gemma4-e4b', 'gemma4-e2b'].find((id) => resolved.status.verifiedModelIds.includes(id));
  return modelId ? { modelId, engine: resolved.engine } : null;
}

export async function gemmaPackStatus(): Promise<GemmaRuntimeStatus> {
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module?.getStatus) return { supported: false, bridgeVersion: 0, capabilities: [] as string[], packs: {} as Record<string, GemmaPackState> };
  const status = await module.getStatus();
  const bridgeVersion = Number(status.gemmaBridgeVersion ?? status.bridgeVersion ?? 0);
  const management = status as typeof status & { gemmaManagementOperation?: string; gemmaRecoveryRequired?: boolean };
  return { supported: bridgeVersion >= GEMMA_BRIDGE_VERSION, managementOperation: management.gemmaManagementOperation, recoveryRequired: management.gemmaRecoveryRequired || gemmaRecoveryRequest() !== null, bridgeVersion, capabilities: Array.isArray(status.gemmaCapabilities) ? status.gemmaCapabilities : status.verifiedCapabilities || [], packs: status.gemmaPacks || {} };
}

/** True only when native verified the modality and a checksum-verified pack is ready. */
export function hasReadyGemmaCapability(status: GemmaRuntimeStatus, capability: 'text' | 'tools' | 'vision' | 'audio'): boolean {
  return status.supported
    && !status.recoveryRequired
    && !status.managementOperation
    && gemmaRecoveryRequest() === null
    && status.capabilities.includes(capability)
    && Object.values(status.packs).some((pack) => pack.state === 'ready');
}

export async function downloadGemmaPack(modelId: string): Promise<void> {
  assertGemmaHealthy();
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module?.gemmaDownload || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  await module.gemmaDownload(modelId);
}
export async function pauseGemmaDownload(modelId: string): Promise<boolean> {
  const module = loadGemmaNative() as NativeGemmaModule | null;
  return module?.gemmaPauseDownload ? module.gemmaPauseDownload(modelId) : false;
}
export async function discardGemmaPartial(modelId: string): Promise<boolean> {
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module?.gemmaDiscardPartial || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const removed = objectFrame(await module.gemmaDiscardPartial(modelId)).removed;
  if (typeof removed !== 'boolean') throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}
export async function removeGemmaPack(modelId: string): Promise<boolean> {
  const module = loadGemmaNative() as NativeGemmaModule | null;
  if (!module?.gemmaRemove || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const removed = objectFrame(await module.gemmaRemove(modelId)).removed;
  if (typeof removed !== 'boolean') throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}

export async function recoverGemmaRuntime(): Promise<void> {
  const native = loadGemmaNative() as NativeGemmaModule | null;
  if (!native?.getStatus || !native.gemmaRecover) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const requestId = gemmaRecoveryRequest();
  const status = await bounded(() => Promise.resolve(native.getStatus!()), 5000, 'NATIVE_CLEANUP_TIMEOUT') as { gemmaRecoveryRequired?: boolean; gemmaAdmittedRequestId?: string | null };
  if (status.gemmaRecoveryRequired) throw new Error('RESTART_APP_REQUIRED');
  if (!requestId) return;
  if (status.gemmaAdmittedRequestId && status.gemmaAdmittedRequestId !== requestId) throw new Error('GEMMA_BUSY');
  // An idle snapshot cannot acknowledge queued cleanup.
  const ack = await bounded(() => native.gemmaRecover!(requestId), 5000, 'NATIVE_CLEANUP_TIMEOUT');
  assertLifecycleAcknowledgement(ack, requestId);
  acknowledgeGemmaRecovery(requestId);
}
