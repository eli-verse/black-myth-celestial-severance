import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSET_MANIFEST,
  AssetLoader,
  assertLocalAssetPath,
} from '../../src/engine/AssetLoader.ts';

interface GlbJsonHeader {
  nodes?: Array<{ name?: string }>;
  animations?: Array<{ name?: string }>;
}

function readGlbJson(filePath: string): GlbJsonHeader {
  const buf = fs.readFileSync(filePath);
  expect(buf.byteLength).toBeGreaterThan(20);
  // Magic bytes 'glTF' === 0x46546c67 (little-endian)
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonText = buf.subarray(20, 20 + jsonChunkLength).toString('utf8');
  return JSON.parse(jsonText) as GlbJsonHeader;
}

describe('Local CC0 Asset Bundle & AssetLoader', () => {
  it('enforces local-only manifest paths and rejects external URLs', () => {
    for (const entry of ASSET_MANIFEST) {
      const resolved = assertLocalAssetPath(entry.path);
      expect(resolved.startsWith('/')).toBe(true);
    }

    expect(() => assertLocalAssetPath('https://example.com/a.glb')).toThrow();
    expect(() => assertLocalAssetPath('http://example.com/a.glb')).toThrow();
    expect(() => assertLocalAssetPath('//cdn.example.com/a.glb')).toThrow();
    expect(() => assertLocalAssetPath('data:application/octet-stream,AA==')).toThrow();
    expect(() => assertLocalAssetPath('')).toThrow();
    expect(() => assertLocalAssetPath('   ')).toThrow();
  });

  it('blocks backslash bypasses, traversal, bare root, control chars, and non-local schemes', () => {
    const maliciousPaths = [
      '\\\\evil.com\\x.glb',
      '\\evil.com\\x.glb',
      '\\/evil.com/x.glb',
      '/\\evil.com/x.glb',
      '..\\secret.glb',
      '../secret.glb',
      'assets/../../etc/passwd',
      '/',
      '///',
      '\u0000https://evil.com/x.glb',
      'https\t://evil.com/x.glb',
      'assets/\nfoo.glb',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http:evil.com/x.glb',
    ];

    for (const bad of maliciousPaths) {
      expect(
        () => assertLocalAssetPath(bad),
        `Expected assertLocalAssetPath to reject: ${JSON.stringify(bad)}`,
      ).toThrow();
    }

    const valid = assertLocalAssetPath('assets/models/player/player_swordsman.glb');
    const resolved = new URL(valid, 'http://localhost:5173/');
    expect(resolved.origin).toBe('http://localhost:5173');
    expect(resolved.pathname).toBe('/assets/models/player/player_swordsman.glb');
  });

  it('bundles every ASSET_MANIFEST file on disk with valid headers', () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    for (const entry of ASSET_MANIFEST) {
      const fullPath = path.join(publicDir, entry.path);
      expect(fs.existsSync(fullPath), `Missing asset on disk: ${fullPath}`).toBe(
        true,
      );
      const stat = fs.statSync(fullPath);
      expect(stat.size, `Empty asset file: ${fullPath}`).toBeGreaterThan(0);

      if (entry.kind === 'glb') {
        readGlbJson(fullPath);
      } else if (entry.kind === 'hdr') {
        const header = fs.readFileSync(fullPath).subarray(0, 16).toString('utf8');
        expect(header.startsWith('#?RADIANCE')).toBe(true);
      }
    }
  });

  it('verifies player_swordsman.glb bones, size < 5 MB, and all 18 combat clips', () => {
    const playerPath = path.resolve(
      process.cwd(),
      'public/assets/models/player/player_swordsman.glb',
    );
    const stat = fs.statSync(playerPath);
    expect(stat.size).toBeLessThan(5 * 1024 * 1024);

    const gltf = readGlbJson(playerPath);
    const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name));
    expect(nodeNames.has('hand_r')).toBe(true);

    const animNames = new Set((gltf.animations ?? []).map((a) => a.name));
    const requiredClips = [
      'Sword_Idle',
      'Idle_Loop',
      'Jog_Fwd_Loop',
      'Sprint_Loop',
      'Sword_Regular_A',
      'Sword_Regular_B',
      'Sword_Regular_C',
      'Sword_Regular_Combo',
      'Sword_Dash',
      'Sword_Heavy_Combo',
      'Sword_Attack',
      'Sword_Block',
      'Roll',
      'Slide_Start',
      'Spell_Simple_Shoot',
      'NinjaJump_Start',
      'Hit_Knockback',
      'Death01',
    ];
    for (const clip of requiredClips) {
      expect(animNames.has(clip), `Missing player clip: ${clip}`).toBe(true);
    }
  });

  it('verifies boss_titan.glb bones and all 18+ required boss clips', () => {
    const bossPath = path.resolve(
      process.cwd(),
      'public/assets/models/boss/boss_titan.glb',
    );
    const gltf = readGlbJson(bossPath);
    const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name));
    expect(nodeNames.has('handslot.r')).toBe(true);

    const animNames = new Set((gltf.animations ?? []).map((a) => a.name));
    const requiredClips = [
      'Idle_Combat',
      'Running_A',
      '2H_Melee_Idle',
      '2H_Melee_Attack_Chop',
      '2H_Melee_Attack_Slice',
      '2H_Melee_Attack_Spin',
      '2H_Melee_Attack_Spinning',
      '2H_Melee_Attack_Stab',
      '1H_Melee_Attack_Jump_Chop',
      'Block',
      'Hit_A',
      'Hit_B',
      'Death_A',
      'Death_B',
      'Death_C_Skeletons',
      'Death_C_Skeletons_Resurrect',
      'Skeletons_Awaken_Standing',
      'Skeletons_Taunt_Longer',
    ];
    for (const clip of requiredClips) {
      expect(animNames.has(clip), `Missing boss clip: ${clip}`).toBe(true);
    }
  });

  it('ships non-empty THIRD_PARTY_LICENSES.md at repo root', () => {
    const licensePath = path.resolve(process.cwd(), 'THIRD_PARTY_LICENSES.md');
    expect(fs.existsSync(licensePath)).toBe(true);
    const content = fs.readFileSync(licensePath, 'utf8').trim();
    expect(content.length).toBeGreaterThan(200);
    expect(content).toContain('CC0-1.0');
  });

  it('accounts for 404 failures accurately when mocked fetch fails', async () => {
    const originalFetch = globalThis.fetch;
    const errors: string[] = [];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as typeof fetch;

    try {
      const loader = new AssetLoader({
        manifest: [
          {
            key: 'missing_required_sfx',
            kind: 'audio',
            path: 'assets/audio/sfx/does_not_exist.ogg',
            requiredInM1: true,
          },
          {
            key: 'missing_optional_sfx',
            kind: 'audio',
            path: 'assets/audio/sfx/optional_missing.ogg',
            requiredInM1: false,
          },
        ],
        onError: (msg) => errors.push(msg),
      });

      await expect(loader.loadAll()).rejects.toThrow(/404/);
      const bundle = loader.getBundle();
      expect(bundle.loadedCount).toBe(0);
      expect(bundle.failedCount).toBe(2);
      expect(bundle.errors).toHaveLength(2);
      expect(errors).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resets counters and deduplicates loaded entries across loadRequiredM1() and repeated loadAll()', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const loader = new AssetLoader({
        manifest: [
          {
            key: 'req_audio',
            kind: 'audio',
            path: 'assets/audio/sfx/chime_bell.ogg',
            requiredInM1: true,
          },
          {
            key: 'opt_audio',
            kind: 'audio',
            path: 'assets/audio/sfx/gong_heavy.ogg',
            requiredInM1: false,
          },
        ],
      });

      const m1Progress: Array<{ loaded: number; total: number }> = [];
      const m1Bundle = await loader.loadRequiredM1((p) => {
        m1Progress.push({ loaded: p.loaded, total: p.total });
      });
      expect(m1Bundle.loadedCount).toBe(1);
      expect(m1Bundle.failedCount).toBe(0);
      expect(m1Progress.at(-1)).toEqual({ loaded: 1, total: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const firstAllProgress: Array<{ loaded: number; total: number }> = [];
      const firstAll = await loader.loadAll((p) => {
        firstAllProgress.push({ loaded: p.loaded, total: p.total });
      });
      expect(firstAll.loadedCount).toBe(2);
      expect(firstAll.failedCount).toBe(0);
      expect(firstAllProgress.at(-1)).toEqual({ loaded: 2, total: 2 });
      // req_audio was already loaded by loadRequiredM1(), so only opt_audio was fetched
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondAllProgress: Array<{ loaded: number; total: number }> = [];
      const secondAll = await loader.loadAll((p) => {
        secondAllProgress.push({ loaded: p.loaded, total: p.total });
      });
      expect(secondAll.loadedCount).toBe(2);
      expect(secondAll.failedCount).toBe(0);
      expect(secondAll.errors).toEqual([]);
      expect(secondAllProgress.at(-1)).toEqual({ loaded: 2, total: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
