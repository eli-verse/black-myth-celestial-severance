import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export type AssetKind = 'glb' | 'hdr' | 'audio';

export interface AssetManifestEntry {
  readonly key: string;
  readonly kind: AssetKind;
  readonly path: string;
  readonly requiredInM1: boolean;
}

export interface AssetLoadProgress {
  loaded: number;
  failed: number;
  total: number;
  currentKey: string | null;
}

export interface LoadedAssetBundle {
  glbs: Map<string, GLTF>;
  hdris: Map<string, THREE.DataTexture>;
  audioBuffers: Map<string, ArrayBuffer>;
  loadedCount: number;
  failedCount: number;
  errors: string[];
}

export const ASSET_MANIFEST: readonly AssetManifestEntry[] = [
  // Player models
  {
    key: 'hero_wukong',
    kind: 'glb',
    path: 'assets/models/player/hero_wukong.glb',
    requiredInM1: false,
  },
  {
    key: 'player_swordsman',
    kind: 'glb',
    path: 'assets/models/player/player_swordsman.glb',
    requiredInM1: true,
  },
  {
    key: 'weapon_katana',
    kind: 'glb',
    path: 'assets/models/player/weapon_katana.glb',
    requiredInM1: true,
  },

  // Boss models
  {
    key: 'boss_jiebo',
    kind: 'glb',
    path: 'assets/models/boss/boss_jiebo.glb',
    requiredInM1: false,
  },
  {
    key: 'boss_titan',
    kind: 'glb',
    path: 'assets/models/boss/boss_titan.glb',
    requiredInM1: true,
  },
  {
    key: 'boss_weapon',
    kind: 'glb',
    path: 'assets/models/boss/boss_weapon.glb',
    requiredInM1: true,
  },

  // Temple environment props
  {
    key: 'env_column',
    kind: 'glb',
    path: 'assets/models/env/column.glb',
    requiredInM1: false,
  },
  {
    key: 'env_dragon_statue',
    kind: 'glb',
    path: 'assets/models/env/dragon_statue.glb',
    requiredInM1: false,
  },
  {
    key: 'env_bell_structure',
    kind: 'glb',
    path: 'assets/models/env/bell_structure.glb',
    requiredInM1: false,
  },
  {
    key: 'env_arch_banner',
    kind: 'glb',
    path: 'assets/models/env/arch_banner.glb',
    requiredInM1: false,
  },
  {
    key: 'env_main_altar',
    kind: 'glb',
    path: 'assets/models/env/main_altar.glb',
    requiredInM1: false,
  },
  {
    key: 'env_column_broken',
    kind: 'glb',
    path: 'assets/models/env/column_broken.glb',
    requiredInM1: false,
  },

  // HDRI environments
  {
    key: 'hdri_night',
    kind: 'hdr',
    path: 'assets/hdri/arena_night.hdr',
    requiredInM1: true,
  },
  {
    key: 'hdri_dusk',
    kind: 'hdr',
    path: 'assets/hdri/arena_dusk.hdr',
    requiredInM1: false,
  },

  // Audio BGM (5-Act Studio-Mastered High-Octane Eastern Myth & Choir Boss Soundtrack + CC0 fallbacks)
  {
    key: 'bgm_wuxia_overture',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_wuxia_overture.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_phase1_chant_rock',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_phase1_chant_rock.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_phase2_deity_choir',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_phase2_deity_choir.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_finisher_kengeki',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_finisher_kengeki.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_victory_wuxia2',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_victory_wuxia2.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_phase1',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_phase1.ogg',
    requiredInM1: false,
  },
  {
    key: 'bgm_phase2',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_phase2.mp3',
    requiredInM1: false,
  },
  {
    key: 'bgm_victory',
    kind: 'audio',
    path: 'assets/audio/bgm/bgm_victory.ogg',
    requiredInM1: false,
  },

  // Audio SFX
  {
    key: 'sfx_wukong_dai_1',
    kind: 'audio',
    path: 'assets/audio/sfx/wukong_dai_1.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_wukong_dai_2',
    kind: 'audio',
    path: 'assets/audio/sfx/wukong_dai_2.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_wukong_hei_1',
    kind: 'audio',
    path: 'assets/audio/sfx/wukong_hei_1.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_meat_hit_light',
    kind: 'audio',
    path: 'assets/audio/sfx/meat_hit_light.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_meat_hit_heavy',
    kind: 'audio',
    path: 'assets/audio/sfx/meat_hit_heavy.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_meat_hit_slam',
    kind: 'audio',
    path: 'assets/audio/sfx/meat_hit_slam.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_sword_slash_1',
    kind: 'audio',
    path: 'assets/audio/sfx/sword_slash_1.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_sword_slash_2',
    kind: 'audio',
    path: 'assets/audio/sfx/sword_slash_2.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_sword_slash_3',
    kind: 'audio',
    path: 'assets/audio/sfx/sword_slash_3.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_sword_slash_4',
    kind: 'audio',
    path: 'assets/audio/sfx/sword_slash_4.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_sword_heavy',
    kind: 'audio',
    path: 'assets/audio/sfx/sword_heavy.wav',
    requiredInM1: false,
  },
  {
    key: 'sfx_knife_slice_1',
    kind: 'audio',
    path: 'assets/audio/sfx/knife_slice_1.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_knife_slice_2',
    kind: 'audio',
    path: 'assets/audio/sfx/knife_slice_2.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_impact_heavy_1',
    kind: 'audio',
    path: 'assets/audio/sfx/impact_heavy_1.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_impact_heavy_2',
    kind: 'audio',
    path: 'assets/audio/sfx/impact_heavy_2.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_impact_metal_1',
    kind: 'audio',
    path: 'assets/audio/sfx/impact_metal_1.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_impact_metal_2',
    kind: 'audio',
    path: 'assets/audio/sfx/impact_metal_2.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_dodge_cloth_1',
    kind: 'audio',
    path: 'assets/audio/sfx/dodge_cloth_1.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_dodge_cloth_2',
    kind: 'audio',
    path: 'assets/audio/sfx/dodge_cloth_2.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_chime_bell',
    kind: 'audio',
    path: 'assets/audio/sfx/chime_bell.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_gong_heavy',
    kind: 'audio',
    path: 'assets/audio/sfx/gong_heavy.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_posture_break',
    kind: 'audio',
    path: 'assets/audio/sfx/posture_break.ogg',
    requiredInM1: false,
  },
  {
    key: 'sfx_boss_roar',
    kind: 'audio',
    path: 'assets/audio/sfx/boss_roar.m4a',
    requiredInM1: false,
  },
  {
    key: 'sfx_boss_roar_2',
    kind: 'audio',
    path: 'assets/audio/sfx/boss_roar_2.ogg',
    requiredInM1: false,
  },
] as const;

const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const PARENT_TRAVERSAL_REGEX = /(^|\/)\.\.(\/|$)/;

const FORBIDDEN_PROTOCOL_PREFIXES = [
  'http://',
  'https://',
  '//',
  'ws://',
  'wss://',
  'ftp://',
  'data:',
  'blob:',
];

export function assertLocalAssetPath(assetPath: string): string {
  if (CONTROL_CHAR_REGEX.test(assetPath)) {
    throw new Error(`Invalid control characters in asset path: ${assetPath}`);
  }
  const trimmed = assetPath.trim();
  if (!trimmed) {
    throw new Error('Asset path must not be empty');
  }
  if (trimmed.includes('\\')) {
    throw new Error(`Backslashes are forbidden in asset path: ${assetPath}`);
  }
  if (trimmed.includes(':')) {
    throw new Error(`Protocol/colon is forbidden in asset path: ${assetPath}`);
  }
  if (trimmed.startsWith('//')) {
    throw new Error(`Protocol-relative asset URL forbidden: ${assetPath}`);
  }
  if (PARENT_TRAVERSAL_REGEX.test(trimmed)) {
    throw new Error(`Parent directory traversal is forbidden: ${assetPath}`);
  }
  const lower = trimmed.toLowerCase();
  for (const prefix of FORBIDDEN_PROTOCOL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new Error(`External asset URL forbidden: ${assetPath}`);
    }
  }
  const rawBase =
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const withLeading = rawBase.startsWith('/') ? rawBase : `/${rawBase}`;
  const normalizedBase = withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
  const cleanRel = trimmed.replace(/^\/+/, '');
  if (!cleanRel) {
    throw new Error(`Asset path must reference a file inside ${normalizedBase}`);
  }
  const resolved = `${normalizedBase}${cleanRel}`;
  const parsed = new URL(resolved, 'https://local.invalid');
  if (
    parsed.origin !== 'https://local.invalid' ||
    !parsed.pathname.startsWith(normalizedBase) ||
    parsed.pathname.length <= normalizedBase.length
  ) {
    throw new Error(`Resolved asset path escapes local root: ${assetPath}`);
  }
  return resolved;
}

const PBR_TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
] as const;

function applyTextureAnisotropy(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const rawMat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!rawMat) {
      return;
    }
    const materials = Array.isArray(rawMat) ? rawMat : [rawMat];
    for (const mat of materials) {
      const matRecord = mat as unknown as Record<string, unknown>;
      for (const slot of PBR_TEXTURE_SLOTS) {
        const tex = matRecord[slot] as THREE.Texture | null | undefined;
        if (tex && tex.isTexture) {
          tex.anisotropy = 8;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
        }
      }
    }
  });
}

export class AssetLoader {
  private readonly manifest: readonly AssetManifestEntry[];
  private readonly onError?: (msg: string) => void;
  private gltfLoader: GLTFLoader | null = null;
  private hdrLoader: HDRLoader | null = null;
  private readonly bundle: LoadedAssetBundle = {
    glbs: new Map(),
    hdris: new Map(),
    audioBuffers: new Map(),
    loadedCount: 0,
    failedCount: 0,
    errors: [],
  };

  constructor(options?: {
    manifest?: readonly AssetManifestEntry[];
    onError?: (msg: string) => void;
  }) {
    this.manifest = options?.manifest ?? ASSET_MANIFEST;
    this.onError = options?.onError;
  }

  getBundle(): LoadedAssetBundle {
    return this.bundle;
  }

  async loadAll(
    onProgress?: (progress: AssetLoadProgress) => void,
  ): Promise<LoadedAssetBundle> {
    return this.loadEntries(this.manifest, onProgress);
  }

  async loadRequiredM1(
    onProgress?: (progress: AssetLoadProgress) => void,
  ): Promise<LoadedAssetBundle> {
    const required = this.manifest.filter((entry) => entry.requiredInM1);
    return this.loadEntries(required, onProgress);
  }

  cloneModel(key: string): THREE.Object3D {
    const gltf = this.bundle.glbs.get(key);
    if (!gltf) {
      throw new Error(`GLB asset "${key}" is not loaded`);
    }
    return SkeletonUtils.clone(gltf.scene);
  }

  private hasLoadedEntry(entry: AssetManifestEntry): boolean {
    if (entry.kind === 'glb') {
      return this.bundle.glbs.has(entry.key);
    }
    if (entry.kind === 'hdr') {
      return this.bundle.hdris.has(entry.key);
    }
    return this.bundle.audioBuffers.has(entry.key);
  }

  private async loadEntries(
    entries: readonly AssetManifestEntry[],
    onProgress?: (progress: AssetLoadProgress) => void,
  ): Promise<LoadedAssetBundle> {
    this.bundle.loadedCount = 0;
    this.bundle.failedCount = 0;
    this.bundle.errors = [];

    const total = entries.length;
    let requiredFailure: string | null = null;

    for (const entry of entries) {
      onProgress?.({
        loaded: this.bundle.loadedCount,
        failed: this.bundle.failedCount,
        total,
        currentKey: entry.key,
      });

      try {
        const resolvedUrl = assertLocalAssetPath(entry.path);
        if (!this.hasLoadedEntry(entry)) {
          await this.loadSingleEntry(entry, resolvedUrl);
        }
        this.bundle.loadedCount += 1;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Failed loading ${entry.key}`;
        const formatted = `[AssetLoader] ${entry.key} (${entry.path}): ${message}`;
        this.bundle.failedCount += 1;
        this.bundle.errors.push(formatted);
        this.onError?.(formatted);
        if (entry.requiredInM1 && requiredFailure === null) {
          requiredFailure = formatted;
        }
      }
    }

    onProgress?.({
      loaded: this.bundle.loadedCount,
      failed: this.bundle.failedCount,
      total,
      currentKey: null,
    });

    if (requiredFailure !== null) {
      throw new Error(requiredFailure);
    }

    return this.bundle;
  }

  private async loadSingleEntry(
    entry: AssetManifestEntry,
    resolvedUrl: string,
  ): Promise<void> {
    if (entry.kind === 'glb') {
      if (!this.gltfLoader) {
        this.gltfLoader = new GLTFLoader();
      }
      const gltf = await this.gltfLoader.loadAsync(resolvedUrl);
      applyTextureAnisotropy(gltf.scene);
      this.bundle.glbs.set(entry.key, gltf);
      return;
    }

    if (entry.kind === 'hdr') {
      if (!this.hdrLoader) {
        this.hdrLoader = new HDRLoader();
      }
      const texture = await this.hdrLoader.loadAsync(resolvedUrl);
      this.bundle.hdris.set(entry.key, texture);
      return;
    }

    // Audio is preloaded strictly as raw ArrayBuffer; AudioContext is never created here.
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} loading ${resolvedUrl}`);
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength === 0) {
      throw new Error(`Empty audio buffer from ${resolvedUrl}`);
    }
    this.bundle.audioBuffers.set(entry.key, buf);
  }
}
