/**
 * The Gemma model catalogue, schema 2.
 *
 * This is a deliberately separate path from `onDevicePackManifest.ts` rather
 * than a bump of it. Schema 1 describes MediaPipe `.task` packs; an APK holding
 * only the MediaPipe runtime must never be offered a `.litertlm` file, and a
 * LiteRT-LM build must never try to load a Qwen `.task`. Two schemas that
 * cannot parse each other's rows is the cheapest way to guarantee that.
 */

import bundled from './model-packs-v2.json';

export const GEMMA_PACK_SCHEMA = 2;

/**
 * The native protocol version this JS speaks. Native reports its own; a lower
 * one means the installed APK predates the tool protocol and the user needs an
 * app update, NOT another multi-gigabyte download.
 */
export const GEMMA_BRIDGE_VERSION = 3;

/** Versioned so a schema-1 cache can never be read back as a Gemma catalogue. */
export const GEMMA_PACK_MANIFEST_CACHE_KEY = 'ledgr_pack_manifest_cache_v2';
export const GEMMA_PREFERRED_MODEL_KEY = 'ledgr_preferred_on_device_model_v2';

export type GemmaCapability = 'text' | 'tools' | 'vision' | 'audio';

export const GEMMA_CAPABILITIES: readonly GemmaCapability[] = ['text', 'tools', 'vision', 'audio'];

/** The only runtime this catalogue may describe. */
export const GEMMA_RUNTIME = 'litert-lm';

/** Hosts a pinned artifact may be fetched from. */
const ALLOWED_HOSTS = new Set(['huggingface.co', 'hf.co']);
const ALLOWED_HOST_SUFFIX = '.hf.co';

export type GemmaPack = {
  id: string;
  label: string;
  runtime: typeof GEMMA_RUNTIME;
  minBridgeVersion: number;
  license: string;
  revision: string;
  filename: string;
  bytes: number;
  sha256: string;
  downloadUrl: string;
  capabilities: GemmaCapability[];
  rank: number;
  experimental: boolean;
};

/**
 * What actually decides whether a file on disk is the reviewed artifact. A
 * remote catalogue may move a URL, but changing any part of this tuple means a
 * different model, which needs a new reviewed build.
 */
export type PackFingerprint = {
  id: string;
  sha256: string;
  bytes: number;
  runtime: string;
  revision: string;
  filename: string;
};

export function fingerprint(pack: GemmaPack): PackFingerprint {
  const { id, sha256, bytes, runtime, revision, filename } = pack;
  return { id, sha256, bytes, runtime, revision, filename };
}

function sameFingerprint(a: PackFingerprint, b: PackFingerprint): boolean {
  return a.id === b.id && a.sha256 === b.sha256 && a.bytes === b.bytes
    && a.runtime === b.runtime && a.revision === b.revision && a.filename === b.filename;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function capabilities(value: unknown): GemmaCapability[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const parsed: GemmaCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(GEMMA_CAPABILITIES as readonly string[]).includes(entry)) return null;
    if (parsed.includes(entry as GemmaCapability)) return null;
    parsed.push(entry as GemmaCapability);
  }
  return parsed;
}

/**
 * Minimal https parser used instead of `new URL`, because React Native's URL
 * is a partial polyfill whose `port`/`username` handling cannot be relied on
 * for a security check. Backslashes are refused outright: several parsers
 * treat `\` as `/`, so a string that disagrees with itself about where the
 * host ends is never allowed to reach a downloader.
 */
function allowedUrl(raw: string, filename: string): boolean {
  if (!filename) return false;
  if (raw.includes('\\') || /[\s"'<>]/.test(raw)) return false;
  const match = /^https:\/\/([^/?#]+)([/?#][^\s]*)?$/i.exec(raw);
  if (!match) return false;
  const authority = match[1];
  if (authority.includes('@')) return false;
  const portSplit = /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!portSplit) return false;
  const host = portSplit[1].toLowerCase();
  const port = portSplit[2];
  if (port !== undefined && port !== '443') return false;
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith(ALLOWED_HOST_SUFFIX)) return false;
  const rest = match[2] || '';
  // A signed-CDN query string is fine to follow at download time, but a
  // catalogue row carrying one is a sign the URL was captured, not pinned.
  if (rest.includes('?') || rest.includes('#')) return false;
  return true;
}

/**
 * Parses one catalogue row, or returns null when it is unusable.
 *
 * Every field is required. Schema 1 made the checksum optional, which meant a
 * manifest could hand the device an unverifiable multi-gigabyte file and the
 * downloader would install it. There is no such row here: no hash, no pack.
 */
export function parseGemmaPackRow(row: unknown): GemmaPack | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const source = row as Record<string, unknown>;

  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return null;

  const runtime = typeof source.runtime === 'string' ? source.runtime : '';
  if (runtime !== GEMMA_RUNTIME) return null;

  const minBridgeVersion = safeInteger(source.minBridgeVersion);
  if (minBridgeVersion === null || minBridgeVersion > GEMMA_BRIDGE_VERSION) return null;

  const sha256 = typeof source.sha256 === 'string' ? source.sha256 : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;

  const revision = typeof source.revision === 'string' ? source.revision : '';
  if (!/^[0-9a-f]{40}$/.test(revision)) return null;

  const filename = typeof source.filename === 'string' ? source.filename : '';
  // The filename becomes a path on the device. Anchored and separator-free, so
  // no row can write outside the model directory.
  if (!/^[A-Za-z0-9_-]+\.litertlm$/.test(filename)) return null;

  const bytes = safeInteger(source.bytes);
  if (bytes === null || bytes > 16 * 1024 ** 3) return null;

  const declared = capabilities(source.capabilities);
  if (!declared || !declared.includes('text')) return null;

  const downloadUrl = typeof source.downloadUrl === 'string' ? source.downloadUrl.trim() : '';
  if (!allowedUrl(downloadUrl, filename)) return null;

  const license = typeof source.license === 'string' && source.license.trim() ? source.license.trim() : '';
  if (!license) return null;

  const rank = typeof source.rank === 'number' && Number.isFinite(source.rank) ? source.rank : null;
  if (rank === null) return null;

  return {
    id,
    label: typeof source.label === 'string' && source.label.trim() ? source.label.trim() : id,
    runtime: GEMMA_RUNTIME,
    minBridgeVersion,
    license,
    revision,
    filename,
    bytes,
    sha256,
    downloadUrl,
    capabilities: declared,
    rank,
    experimental: source.experimental !== false,
  };
}

/**
 * Parses a whole catalogue, or throws CATALOG_SCHEMA_MISMATCH.
 *
 * The document fails as a unit. If one row is unusable, the remaining rows have
 * no more standing than the broken one. Cached JSON is not more trustworthy
 * for having been written by us once, so it goes through the same checks.
 */
export function parseGemmaCatalog(raw: unknown): GemmaPack[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CATALOG_SCHEMA_MISMATCH');
  const body = raw as Record<string, unknown>;
  if (body.schema !== GEMMA_PACK_SCHEMA) throw new Error('CATALOG_SCHEMA_MISMATCH');
  if (!Array.isArray(body.packs) || body.packs.length === 0) throw new Error('CATALOG_SCHEMA_MISMATCH');

  const packs: GemmaPack[] = [];
  const ids = new Set<string>();
  const filenames = new Set<string>();
  for (const row of body.packs) {
    const pack = parseGemmaPackRow(row);
    if (!pack) throw new Error('CATALOG_SCHEMA_MISMATCH');
    // Two rows claiming one id makes selection non-deterministic; two rows
    // sharing a filename makes them overwrite each other on disk.
    if (ids.has(pack.id) || filenames.has(pack.filename)) throw new Error('CATALOG_SCHEMA_MISMATCH');
    ids.add(pack.id);
    filenames.add(pack.filename);
    packs.push(pack);
  }
  return packs;
}

/** The packs compiled into this build. This is the approved set. */
export function bundledGemmaPacks(): GemmaPack[] {
  return parseGemmaCatalog(bundled);
}

export const APPROVED_FINGERPRINTS: readonly PackFingerprint[] = bundledGemmaPacks().map(fingerprint);

export type ReconcileResult = {
  packs: GemmaPack[];
  rejected: { id: string; reason: string }[];
};

/**
 * Applies a remote catalogue on top of the compiled approved set.
 *
 * A remote row may only move the download URL for a pack whose id, hash, byte
 * count, runtime, revision and filename already match a build-approved
 * fingerprint. Anything else is refused.
 *
 * The reason this is not "verify the hash we were given" is that the hash and
 * the file would both come from the same untrusted manifest: an attacker who
 * can rewrite the URL can rewrite the expected hash beside it, and the device
 * would happily verify a substituted model against the substituted digest. The
 * only digest worth checking is one that shipped in the reviewed APK. A signed
 * catalogue could relax this later, but that needs signature verification, key
 * rotation and rollback protection -- not HTTPS plus a self-declared hash.
 */
export function reconcileWithApproved(
  remote: readonly GemmaPack[],
  approved: readonly PackFingerprint[] = APPROVED_FINGERPRINTS,
): ReconcileResult {
  const bundledById = new Map(bundledGemmaPacks().map((pack) => [pack.id, pack]));
  const approvedById = new Map(approved.map((entry) => [entry.id, entry]));
  const packs: GemmaPack[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const pack of remote) {
    if (seen.has(pack.id)) {
      rejected.push({ id: pack.id, reason: 'DUPLICATE_ID' });
      continue;
    }
    seen.add(pack.id);
    const expected = approvedById.get(pack.id);
    if (!expected) {
      rejected.push({ id: pack.id, reason: 'UNKNOWN_MODEL_FINGERPRINT' });
      continue;
    }
    if (!sameFingerprint(fingerprint(pack), expected)) {
      rejected.push({ id: pack.id, reason: 'FINGERPRINT_CHANGED' });
      continue;
    }
    // Only the URL and presentation fields survive from the remote row.
    const base = bundledById.get(pack.id);
    packs.push(base ? { ...base, downloadUrl: pack.downloadUrl, label: pack.label } : pack);
  }

  // A catalogue that omits an approved pack must not make an installed model
  // disappear from the UI, so the approved set is the floor.
  for (const pack of bundledGemmaPacks()) {
    if (!seen.has(pack.id)) packs.push(pack);
  }
  return { packs, rejected };
}

/**
 * What the UI is allowed to say about a pack. `File.exists()` is not one of
 * these: a partially written file exists, and a file whose hash was never
 * confirmed exists too.
 */
export type PackState =
  | 'not-installed'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'unsupported'
  | 'error';

export type PackStatus = {
  id: string;
  state: PackState;
  receivedBytes: number;
  /** Present only once integrity has actually been confirmed. */
  verifiedSha256?: string;
  reason?: string;
};

/** User-facing copy per state, and which action the UI may offer. */
export function describePackState(pack: GemmaPack, status: PackStatus): {
  title: string;
  detail: string;
  actions: ('download' | 'pause' | 'resume' | 'remove' | 'use' | 'cancel' | 'update-app')[];
} {
  const size = `${(pack.bytes / 1024 ** 3).toFixed(1)} GB`;
  switch (status.state) {
    case 'not-installed':
      return { title: 'Not installed', detail: `${size} download. Use Wi-Fi.`, actions: ['download'] };
    case 'downloading':
      return { title: 'Downloading', detail: `${(status.receivedBytes / 1024 ** 3).toFixed(2)} of ${size}.`, actions: ['pause'] };
    case 'paused':
      return { title: 'Paused', detail: 'Part of the download is kept on this phone.', actions: ['resume', 'remove'] };
    case 'verifying':
      return { title: 'Checking the file', detail: 'Not usable until the check finishes.', actions: ['cancel'] };
    case 'ready':
      return { title: 'Ready', detail: `${size} on this phone.`, actions: ['use', 'remove'] };
    case 'unsupported':
      return { title: 'Not supported on this phone', detail: status.reason ?? 'This phone cannot run this model.', actions: ['remove'] };
    case 'error':
      return { title: 'Needs attention', detail: status.reason ?? 'The download could not be completed.', actions: ['remove', 'download'] };
  }
}

/**
 * What a pack can actually be used for here.
 *
 * A manifest boolean is a claim, not a capability. A modality counts only when
 * the bridge on this device has been verified to run it, so a catalogue saying
 * `vision` cannot by itself put a "scan with Gemma" button on screen.
 */
export type BridgeProfile = {
  bridgeVersion: number;
  /** Modalities this build has actually been tested to run on this device. */
  verified: readonly GemmaCapability[];
};

export function effectiveCapabilities(pack: GemmaPack, profile: BridgeProfile): GemmaCapability[] {
  if (profile.bridgeVersion < pack.minBridgeVersion) return [];
  return pack.capabilities.filter((capability) => profile.verified.includes(capability));
}

export type InstalledGemmaPack = GemmaPack & {
  status: PackStatus;
  /** Set by the measured device profile, never by a manifest RAM threshold. */
  deviceEligible: boolean;
};

export type PackChoice = { pack: InstalledGemmaPack | null; reason: string };

/**
 * Picks the pack for a task and says WHY.
 *
 * The schema-1 selector took the highest rank that was installed, which would
 * make E4B the silent default on any phone holding both. E2B is the tested
 * default instead; E4B is opt-in for a validated device profile. A pin is
 * honoured only when it can actually serve the task, and a rejected pin returns
 * a reason so the UI can explain the fallback rather than quietly substituting.
 *
 * Nothing here may select a pack that is not installed: an answer must never
 * begin with a surprise multi-gigabyte download.
 */
export function selectGemmaPack(
  packs: readonly InstalledGemmaPack[],
  needs: readonly GemmaCapability[],
  profile: BridgeProfile,
  options: { preferredId?: string | null; allowExperimentalLarge?: boolean } = {},
): PackChoice {
  const serves = (pack: InstalledGemmaPack) =>
    pack.status.state === 'ready'
    && pack.deviceEligible
    && needs.every((capability) => effectiveCapabilities(pack, profile).includes(capability));

  const usable = packs.filter(serves);
  if (!usable.length) {
    const installed = packs.filter((pack) => pack.status.state === 'ready');
    if (!installed.length) return { pack: null, reason: 'NO_MODEL_INSTALLED' };
    if (!installed.some((pack) => pack.deviceEligible)) return { pack: null, reason: 'DEVICE_NOT_ELIGIBLE' };
    return { pack: null, reason: 'NO_INSTALLED_MODEL_SUPPORTS_TASK' };
  }

  if (options.preferredId) {
    const pinned = usable.find((pack) => pack.id === options.preferredId);
    if (pinned) return { pack: pinned, reason: 'PINNED' };
    const known = packs.find((pack) => pack.id === options.preferredId);
    const reason = !known ? 'PINNED_MODEL_UNKNOWN'
      : known.status.state !== 'ready' ? 'PINNED_MODEL_NOT_INSTALLED'
        : !known.deviceEligible ? 'PINNED_MODEL_NOT_ELIGIBLE'
          : 'PINNED_MODEL_LACKS_CAPABILITY';
    // Fall through to Auto rather than leaving the feature unavailable, but
    // carry the reason so the screen can say what happened.
    const auto = pickAuto(usable, options.allowExperimentalLarge === true);
    return { pack: auto, reason };
  }

  return { pack: pickAuto(usable, options.allowExperimentalLarge === true), reason: 'AUTO' };
}

/** Smallest tested model first; the larger one only on an explicit opt-in. */
function pickAuto(usable: readonly InstalledGemmaPack[], allowLarge: boolean): InstalledGemmaPack {
  const ordered = usable.slice().sort((a, b) => a.rank - b.rank);
  if (allowLarge) {
    const large = ordered.slice().reverse().find((pack) => pack.deviceEligible);
    if (large) return large;
  }
  return ordered[0];
}

/**
 * Schema-1 Qwen/Phi downloads left on disk.
 *
 * They are inert: LiteRT-LM cannot read a `.task` container, so they are never
 * offered as a model. They are also the user's data and several gigabytes of
 * it, so they are never deleted without being asked -- only reported so the
 * settings screen can offer the space back.
 */
export type LegacyPackFile = { filename: string; bytes: number };

export function legacyPacksReclaimable(files: readonly LegacyPackFile[]): {
  files: LegacyPackFile[];
  totalBytes: number;
} {
  const legacy = files.filter((file) => /\.task$/i.test(file.filename));
  return { files: legacy, totalBytes: legacy.reduce((sum, file) => sum + file.bytes, 0) };
}

export function isLoadableByGemmaRuntime(filename: string): boolean {
  return /^[A-Za-z0-9_-]+\.litertlm$/.test(filename);
}
