import bundledJson from '../src/accountingV2/gemma/model-packs-v2.json';
import {
  APPROVED_FINGERPRINTS,
  GEMMA_BRIDGE_VERSION,
  GEMMA_PACK_MANIFEST_CACHE_KEY,
  GEMMA_PACK_SCHEMA,
  GEMMA_PREFERRED_MODEL_KEY,
  bundledGemmaPacks,
  describePackState,
  effectiveCapabilities,
  fingerprint,
  isLoadableByGemmaRuntime,
  legacyPacksReclaimable,
  parseGemmaCatalog,
  parseGemmaPackRow,
  reconcileWithApproved,
  selectGemmaPack,
  type BridgeProfile,
  type GemmaPack,
  type InstalledGemmaPack,
  type PackStatus,
} from '../src/accountingV2/gemma/packCatalogV2';
import * as fs from 'fs';
import * as path from 'path';

const e2b = {
  id: 'gemma4-e2b',
  label: 'Gemma 4 E2B',
  runtime: 'litert-lm',
  minBridgeVersion: 2,
  license: 'Apache-2.0',
  revision: 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1',
  filename: 'gemma4-e2b-181938105e0eefd1.litertlm',
  bytes: 2588147712,
  sha256: '181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c',
  downloadUrl: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1/gemma-4-E2B-it.litertlm',
  capabilities: ['text', 'tools', 'vision', 'audio'],
  rank: 10,
  experimental: true,
};

const catalog = (packs: unknown[]) => ({ schema: GEMMA_PACK_SCHEMA, catalogVersion: 1, packs });
const row = (overrides: Record<string, unknown>) => ({ ...e2b, ...overrides });

const profile = (verified: BridgeProfile['verified'] = ['text', 'tools', 'vision', 'audio']): BridgeProfile => ({
  bridgeVersion: GEMMA_BRIDGE_VERSION,
  verified,
});

const ready: PackStatus = { id: 'gemma4-e2b', state: 'ready', receivedBytes: 2588147712 };

function installed(pack: GemmaPack, overrides: Partial<InstalledGemmaPack> = {}): InstalledGemmaPack {
  return { ...pack, status: { ...ready, id: pack.id }, deviceEligible: true, ...overrides };
}

describe('bundled catalogue', () => {
  it('is the pinned Gemma 4 pair and reaches the app only through the parser', () => {
    const packs = bundledGemmaPacks();
    expect(packs.map((pack) => pack.id)).toEqual(['gemma4-e2b', 'gemma4-e4b']);
    expect(packs[0].sha256).toBe('181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c');
    expect(packs[0].bytes).toBe(2588147712);
    expect(packs[0].revision).toBe('b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1');
    expect(packs[1].sha256).toBe('0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0');
    expect(packs[1].bytes).toBe(3659530240);
    expect(packs[1].revision).toBe('2eee7ac325f20eb8c9ac1d0e972f7c84663062da');
    // Every pack ships experimental until the device gates pass.
    expect(packs.every((pack) => pack.experimental)).toBe(true);
    expect(parseGemmaCatalog(bundledJson)).toHaveLength(2);
  });

  it('uses versioned storage keys so a schema-1 cache cannot be read back', () => {
    expect(GEMMA_PACK_MANIFEST_CACHE_KEY).toBe('ledgr_pack_manifest_cache_v2');
    expect(GEMMA_PREFERRED_MODEL_KEY).toBe('ledgr_preferred_on_device_model_v2');
  });
});

describe('row parsing', () => {
  it('accepts a well-formed row', () => {
    expect(parseGemmaPackRow(e2b)).toMatchObject({ id: 'gemma4-e2b', runtime: 'litert-lm', rank: 10 });
  });

  it.each([
    ['missing sha256', { sha256: undefined }],
    ['short sha256', { sha256: 'abc123' }],
    ['uppercase sha256', { sha256: '181938105E0EEFD105961417E8DA75903EACDA102C4FCE9CE90F50B97139A63C' }],
    ['bad revision', { revision: 'main' }],
    ['short revision', { revision: 'b3ca0d2f' }],
    ['path traversal filename', { filename: '../gemma4-e2b.litertlm' }],
    ['nested filename', { filename: 'weights/gemma4-e2b.litertlm' }],
    ['wrong extension', { filename: 'gemma4-e2b.task' }],
    ['non-https url', { downloadUrl: 'http://huggingface.co/x/resolve/main/a.litertlm' }],
    ['foreign host', { downloadUrl: 'https://example.com/x/resolve/main/a.litertlm' }],
    ['host suffix trick', { downloadUrl: 'https://huggingface.co.evil.test/a.litertlm' }],
    ['backslash in url', { downloadUrl: 'https://huggingface.co\\evil/a.litertlm' }],
    ['credentials in url', { downloadUrl: 'https://user:pw@huggingface.co/a.litertlm' }],
    ['signed query string', { downloadUrl: 'https://huggingface.co/a.litertlm?token=abc' }],
    ['wrong runtime', { runtime: 'mediapipe' }],
    ['too-new bridge', { minBridgeVersion: GEMMA_BRIDGE_VERSION + 1 }],
    ['zero bytes', { bytes: 0 }],
    ['fractional bytes', { bytes: 2588147712.5 }],
    ['absurd bytes', { bytes: 20 * 1024 ** 3 }],
    ['no capabilities', { capabilities: [] }],
    ['unknown capability', { capabilities: ['text', 'telepathy'] }],
    ['duplicate capability', { capabilities: ['text', 'text'] }],
    ['no text capability', { capabilities: ['vision'] }],
    ['missing license', { license: '' }],
    ['missing rank', { rank: undefined }],
    ['bad id', { id: 'Gemma 4!' }],
  ])('rejects a row with %s', (_label, overrides) => {
    expect(parseGemmaPackRow(row(overrides))).toBeNull();
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 42, 'gemma', [], [e2b]]) {
      expect(parseGemmaPackRow(value)).toBeNull();
    }
  });
});

describe('catalogue parsing', () => {
  it('refuses a schema-1 catalogue outright', () => {
    expect(() => parseGemmaCatalog({ schema: 1, packs: [e2b] })).toThrow('CATALOG_SCHEMA_MISMATCH');
    expect(() => parseGemmaCatalog({ packs: [e2b] })).toThrow('CATALOG_SCHEMA_MISMATCH');
  });

  it('fails closed on duplicate ids and duplicate filenames', () => {
    expect(() => parseGemmaCatalog(catalog([e2b, e2b]))).toThrow('CATALOG_SCHEMA_MISMATCH');
    const clash = row({ id: 'gemma4-other' });
    expect(() => parseGemmaCatalog(catalog([e2b, clash]))).toThrow('CATALOG_SCHEMA_MISMATCH');
  });

  it('fails closed when any row is unusable', () => {
    expect(() => parseGemmaCatalog(catalog([row({ sha256: 'nope' }), e2b]))).toThrow('CATALOG_SCHEMA_MISMATCH');
  });

  it('parses cached JSON through exactly the same path', () => {
    const cached = JSON.parse(JSON.stringify(catalog([e2b])));
    expect(parseGemmaCatalog(cached)).toHaveLength(1);
    const tampered = JSON.parse(JSON.stringify(catalog([row({ bytes: 1024 })])));
    expect(parseGemmaCatalog(tampered).map((pack) => pack.bytes)).toEqual([1024]);
    // Parsing accepts the shape; reconciliation is what refuses the fingerprint.
    expect(reconcileWithApproved(parseGemmaCatalog(tampered)).rejected)
      .toEqual([{ id: 'gemma4-e2b', reason: 'FINGERPRINT_CHANGED' }]);
  });
});

describe('reconciliation against the compiled approved set', () => {
  const approved = APPROVED_FINGERPRINTS;

  it('accepts a URL-only change for an approved fingerprint', () => {
    const moved = parseGemmaCatalog(catalog([row({
      downloadUrl: 'https://hf.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1/gemma-4-E2B-it.litertlm',
    })]));
    const result = reconcileWithApproved(moved, approved);
    expect(result.rejected).toEqual([]);
    const pack = result.packs.find((entry) => entry.id === 'gemma4-e2b');
    expect(pack?.downloadUrl).toContain('hf.co');
    expect(pack?.sha256).toBe(e2b.sha256);
  });

  it.each([
    ['changed hash', { sha256: '0'.repeat(64) }],
    ['changed bytes', { bytes: 1234567 }],
    ['changed revision', { revision: 'a'.repeat(40) }],
    ['changed filename', { filename: 'gemma4-e2b-other.litertlm' }],
  ])('rejects a %s', (_label, overrides) => {
    const rows = parseGemmaCatalog(catalog([row(overrides)]));
    expect(rows).toHaveLength(1);
    expect(reconcileWithApproved(rows, approved).rejected)
      .toEqual([{ id: 'gemma4-e2b', reason: 'FINGERPRINT_CHANGED' }]);
  });

  it('rejects an unknown model id even when every field is well-formed', () => {
    const rows = parseGemmaCatalog(catalog([row({ id: 'gemma4-e8b', filename: 'gemma4-e8b.litertlm' })]));
    expect(reconcileWithApproved(rows, approved).rejected)
      .toEqual([{ id: 'gemma4-e8b', reason: 'UNKNOWN_MODEL_FINGERPRINT' }]);
  });

  it('never lets a remote catalogue remove an approved pack', () => {
    const result = reconcileWithApproved([], approved);
    expect(result.packs.map((pack) => pack.id).sort()).toEqual(['gemma4-e2b', 'gemma4-e4b']);
  });

  it('keeps a fingerprint stable across parse and reconcile', () => {
    const pack = bundledGemmaPacks()[0];
    expect(fingerprint(pack)).toEqual(approved[0]);
  });
});

describe('capability gating', () => {
  it('never enables a modality the bridge has not verified', () => {
    const pack = bundledGemmaPacks()[0];
    expect(pack.capabilities).toContain('vision');
    expect(effectiveCapabilities(pack, profile(['text', 'tools']))).toEqual(['text', 'tools']);
  });

  it('grants nothing when the bridge is older than the pack requires', () => {
    const pack = bundledGemmaPacks()[0];
    expect(effectiveCapabilities(pack, { bridgeVersion: 1, verified: ['text', 'vision'] })).toEqual([]);
  });
});

describe('pack selection', () => {
  const [smallPack, largePack] = bundledGemmaPacks();

  it('defaults to the smaller tested model when both are ready', () => {
    const choice = selectGemmaPack([installed(largePack), installed(smallPack)], ['text'], profile());
    expect(choice.pack?.id).toBe('gemma4-e2b');
    expect(choice.reason).toBe('AUTO');
  });

  it('offers the larger model only on an explicit opt-in', () => {
    const packs = [installed(smallPack), installed(largePack)];
    expect(selectGemmaPack(packs, ['text'], profile(), { allowExperimentalLarge: true }).pack?.id)
      .toBe('gemma4-e4b');
  });

  it('honours a valid pin', () => {
    const choice = selectGemmaPack(
      [installed(smallPack), installed(largePack)], ['text'], profile(), { preferredId: 'gemma4-e4b' },
    );
    expect(choice).toMatchObject({ reason: 'PINNED' });
    expect(choice.pack?.id).toBe('gemma4-e4b');
  });

  it('falls back with a stated reason when the pin is not installed', () => {
    const choice = selectGemmaPack(
      [installed(smallPack), installed(largePack, { status: { id: 'gemma4-e4b', state: 'not-installed', receivedBytes: 0 } })],
      ['text'], profile(), { preferredId: 'gemma4-e4b' },
    );
    expect(choice.reason).toBe('PINNED_MODEL_NOT_INSTALLED');
    expect(choice.pack?.id).toBe('gemma4-e2b');
  });

  it('falls back with a stated reason when the pin cannot serve the task', () => {
    // The pinned pack is installed and eligible, but this build never declared
    // vision for it, so it cannot answer a scan request.
    const textOnlyLarge = installed({ ...largePack, capabilities: ['text', 'tools'] });
    const choice = selectGemmaPack(
      [installed(smallPack), textOnlyLarge], ['vision'], profile(['text', 'tools', 'vision']),
      { preferredId: 'gemma4-e4b' },
    );
    expect(choice.pack?.id).toBe('gemma4-e2b');
    expect(choice.reason).toBe('PINNED_MODEL_LACKS_CAPABILITY');
  });

  it('never selects a pack that is not installed', () => {
    const packs = [
      installed(smallPack, { status: { id: 'gemma4-e2b', state: 'paused', receivedBytes: 10 } }),
      installed(largePack, { status: { id: 'gemma4-e4b', state: 'verifying', receivedBytes: 20 } }),
    ];
    expect(selectGemmaPack(packs, ['text'], profile())).toEqual({ pack: null, reason: 'NO_MODEL_INSTALLED' });
  });

  it('reports device ineligibility separately from a missing model', () => {
    const packs = [installed(smallPack, { deviceEligible: false })];
    expect(selectGemmaPack(packs, ['text'], profile())).toEqual({ pack: null, reason: 'DEVICE_NOT_ELIGIBLE' });
  });

  it('reports an unsupported task rather than substituting a weaker answer', () => {
    const packs = [installed(smallPack)];
    expect(selectGemmaPack(packs, ['audio'], profile(['text', 'tools'])))
      .toEqual({ pack: null, reason: 'NO_INSTALLED_MODEL_SUPPORTS_TASK' });
  });
});

describe('pack state copy', () => {
  const pack = bundledGemmaPacks()[0];

  it('never offers Use before the file is verified', () => {
    for (const state of ['not-installed', 'downloading', 'paused', 'verifying', 'error', 'unsupported'] as const) {
      const described = describePackState(pack, { id: pack.id, state, receivedBytes: 0 });
      expect(described.actions).not.toContain('use');
    }
    expect(describePackState(pack, ready).actions).toContain('use');
  });

  it('offers Resume and Remove separately for a paused download', () => {
    const described = describePackState(pack, { id: pack.id, state: 'paused', receivedBytes: 1024 });
    expect(described.actions).toEqual(['resume', 'remove']);
  });
});

describe('legacy schema-1 downloads', () => {
  it('reports reclaimable space without treating them as loadable', () => {
    const files = [
      { filename: 'Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task', bytes: 546_660_344 },
      { filename: 'gemma4-e2b-181938105e0eefd1.litertlm', bytes: 2_588_147_712 },
    ];
    const reclaimable = legacyPacksReclaimable(files);
    expect(reclaimable.files.map((file) => file.filename)).toEqual([files[0].filename]);
    expect(reclaimable.totalBytes).toBe(546_660_344);
    expect(isLoadableByGemmaRuntime(files[0].filename)).toBe(false);
    expect(isLoadableByGemmaRuntime(files[1].filename)).toBe(true);
  });
});

test('the native asset and the JS catalogue are the same document', () => {
  // Two copies exist because native code must not take a model description
  // from JS (plan 02 s3) while the UI still needs to render the same list.
  // Drift would mean offering a model the downloader refuses, so it is a
  // build-time failure rather than a runtime surprise.
  const shared = path.join(__dirname, '../src/accountingV2/gemma/model-packs-v2.json');
  const asset = path.join(
    __dirname,
    '../modules/ledgr-native-ai/android/src/main/assets/model-packs-v2.json',
  );
  expect(fs.existsSync(asset)).toBe(true);
  const normalise = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  expect(normalise(asset)).toBe(normalise(shared));
});
