import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioManager, type AudioBufferProvider } from '../../src/audio/AudioManager.ts';
import { CombatSystem, type PlayerInputFrame } from '../../src/combat/CombatSystem.ts';
import { GameStateMachine } from '../../src/combat/GameStateMachine.ts';
import { DebugBridge } from '../../src/debug/DebugBridge.ts';
import { TimeScaleSystem } from '../../src/engine/TimeScaleSystem.ts';
import { AnimationRig, attachObjectToBone } from '../../src/entities/AnimationRig.ts';
import { BOSS_CLIPS, BossEntity } from '../../src/entities/BossEntity.ts';
import { PLAYER_CLIPS, PlayerEntity } from '../../src/entities/PlayerEntity.ts';
import {
  COMBAT_TUNING,
  UI_COPY,
  type ArenaInterface,
  type AudioInterface,
  type GamePhase,
  type HudSnapshot,
  type SfxId,
  type VfxInterface,
} from '../../src/types/game.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '../..');

const ALL_21_AUDIO_KEYS = [
  'bgm_phase1',
  'bgm_phase2',
  'bgm_victory',
  'sfx_sword_slash_1',
  'sfx_sword_slash_2',
  'sfx_sword_slash_3',
  'sfx_sword_slash_4',
  'sfx_sword_heavy',
  'sfx_knife_slice_1',
  'sfx_knife_slice_2',
  'sfx_impact_heavy_1',
  'sfx_impact_heavy_2',
  'sfx_impact_metal_1',
  'sfx_impact_metal_2',
  'sfx_dodge_cloth_1',
  'sfx_dodge_cloth_2',
  'sfx_chime_bell',
  'sfx_gong_heavy',
  'sfx_posture_break',
  'sfx_boss_roar',
  'sfx_boss_roar_2',
] as const;

const ALL_24_SFX_IDS: readonly SfxId[] = [
  'sword_slash_1',
  'sword_slash_2',
  'sword_slash_3',
  'sword_slash_4',
  'impact_light',
  'impact_heavy',
  'impact_counter_crit',
  'dodge_whoosh',
  'perfect_dodge_chime',
  'skill1_phantom_dash',
  'skill2_cleave_charge',
  'skill2_cleave_slam',
  'skill3_timestop_snap',
  'skill3_reality_slash',
  'skill3_detonation',
  'posture_break',
  'boss_roar',
  'boss_slam',
  'boss_lightning',
  'boss_sweep',
  'lotus_ward',
  'shield_recharge',
  'heal_chime',
  'ui_click',
];

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function assertOnlyNodeMaterials(root: THREE.Object3D): number {
  let checkedCount = 0;
  root.traverse((obj) => {
    const rawMat = (obj as { material?: THREE.Material | THREE.Material[] }).material;
    if (!rawMat) {
      return;
    }
    const materials = Array.isArray(rawMat) ? rawMat : [rawMat];
    for (const mat of materials) {
      checkedCount += 1;
      expect(
        mat instanceof THREE.ShaderMaterial,
        `${obj.name || obj.type} must not use ShaderMaterial`,
      ).toBe(false);
      expect(
        mat instanceof THREE.RawShaderMaterial,
        `${obj.name || obj.type} must not use RawShaderMaterial`,
      ).toBe(false);
      expect(
        mat instanceof NodeMaterial ||
          (mat as { isNodeMaterial?: boolean }).isNodeMaterial === true,
        `${obj.name || obj.type} material (${mat.type}) must be a NodeMaterial`,
      ).toBe(true);
    }
  });
  return checkedCount;
}

function makeClip(name: string, duration = 0.8): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack('.position', [0, duration], [0, 0, 0, 0, 0, 0]);
  return new THREE.AnimationClip(name, duration, [track]);
}

function createPlayerFixture(options?: { onError?: (msg: string) => void }): {
  player: PlayerEntity;
  cleanup: () => void;
} {
  const model = new THREE.Group();
  model.name = 'PlayerStubRoot';

  const pelvis = new THREE.Bone();
  pelvis.name = 'spine_01';
  const handR = new THREE.Bone();
  handR.name = 'hand_r';
  pelvis.add(handR);
  model.add(pelvis);

  const bodyGeom = new THREE.BoxGeometry(0.6, 1.7, 0.3);
  const bodyMat = new THREE.MeshStandardMaterial({ name: 'RobeMat', color: 0xdddddd });
  const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
  bodyMesh.name = 'PlayerBodyMesh';

  const eyeMat = new THREE.MeshStandardMaterial({ name: 'EyeGlowMat', color: 0xffffff });
  const eyeMesh = new THREE.Mesh(bodyGeom, eyeMat);
  eyeMesh.name = 'PlayerEyeMesh';
  model.add(bodyMesh, eyeMesh);

  const weaponModel = new THREE.Group();
  const katanaGeom = new THREE.BoxGeometry(0.05, 1.1, 0.05);
  const katanaMat = new THREE.MeshStandardMaterial({ name: 'KatanaMat', color: 0xcccccc });
  const katanaMesh = new THREE.Mesh(katanaGeom, katanaMat);
  katanaMesh.name = 'KatanaMesh';
  weaponModel.add(katanaMesh);

  const clips = [
    ...PLAYER_CLIPS.idle,
    ...PLAYER_CLIPS.jog,
    ...PLAYER_CLIPS.sprint,
    ...PLAYER_CLIPS.combo1,
    ...PLAYER_CLIPS.combo2,
    ...PLAYER_CLIPS.combo3,
    ...PLAYER_CLIPS.combo4,
    ...PLAYER_CLIPS.dodge,
    ...PLAYER_CLIPS.skill1,
    ...PLAYER_CLIPS.skill2,
    ...PLAYER_CLIPS.skill3Cast,
    ...PLAYER_CLIPS.skill3Strike,
    ...PLAYER_CLIPS.hit,
  ].map((name) => makeClip(name, 0.6));

  const player = new PlayerEntity({
    model,
    weaponModel,
    clips,
    onError: options?.onError,
  });

  return {
    player,
    cleanup: () => {
      player.dispose();
      bodyGeom.dispose();
      bodyMat.dispose();
      eyeMat.dispose();
      katanaGeom.dispose();
      katanaMat.dispose();
    },
  };
}

function createBossFixture(options?: {
  handBoneName?: string;
  deathClips?: readonly string[];
  onError?: (msg: string) => void;
}): {
  boss: BossEntity;
  cleanup: () => void;
} {
  const model = new THREE.Group();
  model.name = 'BossStubRoot';

  const handBone = new THREE.Bone();
  handBone.name = options?.handBoneName ?? 'handslot.r';
  model.add(handBone);

  const bodyGeom = new THREE.BoxGeometry(1.4, 2.4, 1.0);
  const bodyMat = new THREE.MeshStandardMaterial({ name: 'TitanArmorMat', color: 0x222222 });
  const eyeMat = new THREE.MeshStandardMaterial({ name: 'EyeGlowMat', color: 0xff3311 });
  const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
  bodyMesh.name = 'BossBodyMesh';
  const eyeMesh = new THREE.Mesh(bodyGeom, eyeMat);
  eyeMesh.name = 'BossEyeMesh';
  model.add(bodyMesh, eyeMesh);

  const weaponModel = new THREE.Group();
  const axeGeom = new THREE.BoxGeometry(0.4, 2.2, 0.2);
  const axeMat = new THREE.MeshStandardMaterial({ name: 'GoldTrimAxeMat', color: 0xc9932e });
  const axeMesh = new THREE.Mesh(axeGeom, axeMat);
  axeMesh.name = 'BossAxeMesh';
  weaponModel.add(axeMesh);

  const deathClipNames = options?.deathClips ?? BOSS_CLIPS.death;
  const clipNames = Array.from(
    new Set([
      ...BOSS_CLIPS.idle,
      ...BOSS_CLIPS.walk,
      ...BOSS_CLIPS.run,
      ...BOSS_CLIPS.intro,
      ...BOSS_CLIPS.transition,
      ...BOSS_CLIPS.stagger,
      ...deathClipNames,
      '2H_Melee_Attack_Slice',
      '2H_Melee_Attack_Chop',
      '2H_Melee_Attack_Stab',
      'Spellcast_Long',
      '2H_Melee_Attack_Spin',
      '1H_Melee_Attack_Jump_Chop',
      'Spellcast_Summon',
      '1H_Melee_Attack_Slice_Diagonal',
    ]),
  );
  const clips = clipNames.map((name) => makeClip(name, 0.9));

  const boss = new BossEntity({
    model,
    weaponModel,
    clips,
    onError: options?.onError,
  });

  return {
    boss,
    cleanup: () => {
      boss.dispose();
      bodyGeom.dispose();
      bodyMat.dispose();
      eyeMat.dispose();
      axeGeom.dispose();
      axeMat.dispose();
    },
  };
}

function createMockArena() {
  const setPhaseIntensity = vi.fn();
  const triggerLightningStrike = vi.fn();
  const update = vi.fn();
  const reset = vi.fn();
  const arena: ArenaInterface = {
    arenaRadius: COMBAT_TUNING.arenaRadius,
    setPhaseIntensity,
    triggerLightningStrike,
    update,
    reset,
  };
  return { arena, setPhaseIntensity, triggerLightningStrike, update, reset };
}

function createMockVfx() {
  const spawnSlashArc = vi.fn();
  const spawnImpactBurst = vi.fn();
  const showTelegraphRing = vi.fn();
  const showTelegraphArc = vi.fn();
  const showTelegraphLine = vi.fn();
  const showTelegraphPillar = vi.fn();
  const clearTelegraph = vi.fn();
  const clearAllTelegraphs = vi.fn();
  const triggerPostureBreakBurst = vi.fn();
  const triggerSkill3Domain = vi.fn();
  const triggerLotusWardBurst = vi.fn();
  const setPhaseIntensity = vi.fn();
  const update = vi.fn();
  const reset = vi.fn();

  const vfx: VfxInterface & {
    showTelegraphPillar: typeof showTelegraphPillar;
    setPhaseIntensity: typeof setPhaseIntensity;
  } = {
    spawnSlashArc,
    spawnImpactBurst,
    showTelegraphRing,
    showTelegraphArc,
    showTelegraphLine,
    showTelegraphPillar,
    clearTelegraph,
    clearAllTelegraphs,
    triggerPostureBreakBurst,
    triggerSkill3Domain,
    triggerLotusWardBurst,
    setPhaseIntensity,
    update,
    reset,
  };

  return {
    vfx,
    spawnSlashArc,
    spawnImpactBurst,
    showTelegraphRing,
    showTelegraphArc,
    showTelegraphLine,
    showTelegraphPillar,
    clearTelegraph,
    clearAllTelegraphs,
    triggerPostureBreakBurst,
    triggerSkill3Domain,
    triggerLotusWardBurst,
    setPhaseIntensity,
    update,
    reset,
  };
}

function createMockAudio() {
  let unlocked = false;
  let muted = false;
  let masterVolume = 0.85;
  let activeBgmState = 'title';
  let lastSfx: string | null = null;
  let paused = false;
  let bulletTimeFilter = false;

  const playedSfx: SfxId[] = [];
  const bgmPhases: GamePhase[] = [];

  const audio: AudioInterface & {
    setPaused: (p: boolean) => void;
    getMasterVolume: () => number;
  } = {
    unlock: vi.fn(async () => {
      unlocked = true;
    }),
    setBgmState: vi.fn((phase: GamePhase) => {
      bgmPhases.push(phase);
      const map: Record<GamePhase, string> = {
        TITLE: 'title',
        CINEMATIC_INTRO: 'intro',
        PHASE_1: 'phase1',
        CINEMATIC_TRANSITION: 'transition',
        PHASE_2: 'phase2',
        CINEMATIC_FINISHER: 'finisher',
        VICTORY: 'victory',
      };
      activeBgmState = map[phase];
    }),
    setBulletTimeFilter: vi.fn((active: boolean) => {
      bulletTimeFilter = active;
    }),
    playSfx: vi.fn((id: SfxId) => {
      lastSfx = id;
      playedSfx.push(id);
    }),
    setMuted: vi.fn((m: boolean) => {
      muted = m;
    }),
    setMasterVolume: vi.fn((vol: number) => {
      masterVolume = vol;
    }),
    setPaused: vi.fn((p: boolean) => {
      paused = p;
    }),
    getMasterVolume: () => masterVolume,
    getState: () => ({
      unlocked,
      muted,
      activeBgmState,
      lastSfx,
      errorCount: 0,
    }),
  };

  return {
    audio,
    playedSfx,
    bgmPhases,
    isBulletTimeFilterActive: () => bulletTimeFilter,
    isPaused: () => paused,
  };
}

function idleInput(overrides: Partial<PlayerInputFrame> = {}): PlayerInputFrame {
  return {
    moveX: 0,
    moveZ: 0,
    attackPressed: false,
    dodgePressed: false,
    skill1Pressed: false,
    skill2Pressed: false,
    skill3Pressed: false,
    isSprinting: false,
    ...overrides,
  };
}

function createCombatHarness() {
  const playerFx = createPlayerFixture();
  const bossFx = createBossFixture();
  const timeScaleSystem = new TimeScaleSystem();
  const arenaFx = createMockArena();
  const vfxFx = createMockVfx();
  const audioFx = createMockAudio();
  const callouts: Array<{ text: string; tone: string }> = [];

  const combat = new CombatSystem({
    player: playerFx.player,
    boss: bossFx.boss,
    timeScaleSystem,
    arena: arenaFx.arena,
    vfx: vfxFx.vfx,
    audio: audioFx.audio,
    onCallout: (text, tone) => {
      callouts.push({ text, tone });
    },
  });

  bossFx.boss.enterCombatPhase(1);
  // Position player within melee reach (3.5m from boss at z=-5)
  playerFx.player.position.set(0, 0, -1.5);
  playerFx.player.faceTarget(bossFx.boss.position);

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
  camera.position.set(0, 2.5, 5);
  camera.lookAt(0, 1.4, -5);
  camera.updateMatrixWorld();

  const stepFrame = (
    dt: number,
    input: PlayerInputFrame = idleInput(),
    combatPhase: 1 | 2 = 1,
  ) => {
    const step = timeScaleSystem.update(dt);
    combat.update(step.playerDt, step.worldDt, step.rawDt, camera, input, combatPhase);
    bossFx.boss.update(
      step.worldDt,
      step.rawDt,
      combatPhase,
      playerFx.player.position,
      vfxFx.vfx,
      combat.getBossTickCallbacks(),
    );
    combat.postBossTick(combatPhase);
    return step;
  };

  const stepDuration = (
    totalSeconds: number,
    stepSize = 0.05,
    combatPhase: 1 | 2 = 1,
    perStepInput?: (elapsed: number) => PlayerInputFrame,
  ) => {
    const steps = Math.round(totalSeconds / stepSize);
    for (let i = 0; i < steps; i += 1) {
      stepFrame(
        stepSize,
        perStepInput ? perStepInput(i * stepSize) : idleInput(),
        combatPhase,
      );
    }
  };

  return {
    player: playerFx.player,
    boss: bossFx.boss,
    combat,
    timeScaleSystem,
    arenaFx,
    vfxFx,
    audioFx,
    callouts,
    camera,
    stepFrame,
    stepDuration,
    cleanup: () => {
      playerFx.cleanup();
      bossFx.cleanup();
    },
  };
}

function createStateMachineHarness() {
  const playerFx = createPlayerFixture();
  const bossFx = createBossFixture();
  const timeScaleSystem = new TimeScaleSystem();
  const arenaFx = createMockArena();
  const vfxFx = createMockVfx();
  const audioFx = createMockAudio();
  const bridge = new DebugBridge();

  const gsm = new GameStateMachine({
    player: playerFx.player,
    boss: bossFx.boss,
    timeScaleSystem,
    arena: arenaFx.arena,
    vfx: vfxFx.vfx,
    audio: audioFx.audio,
    debugBridge: bridge,
    rendererBackend: 'webgpu',
    testMode: true,
  });

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
  camera.position.set(0, 2.5, 10);
  camera.lookAt(0, 1.4, -5);
  camera.updateMatrixWorld();

  const tick = (
    dt = 0.05,
    input: PlayerInputFrame = idleInput(),
  ) => {
    gsm.update(dt, camera, input);
  };

  const tickSeconds = (seconds: number, stepSize = 0.05) => {
    const count = Math.round(seconds / stepSize);
    for (let i = 0; i < count; i += 1) {
      tick(stepSize, idleInput());
    }
  };

  return {
    gsm,
    player: playerFx.player,
    boss: bossFx.boss,
    combat: gsm.combat,
    timeScaleSystem,
    arenaFx,
    vfxFx,
    audioFx,
    bridge,
    camera,
    tick,
    tickSeconds,
    cleanup: () => {
      gsm.dispose();
      bridge.dispose();
      playerFx.cleanup();
      bossFx.cleanup();
    },
  };
}

function createMockAudioContextSetup(options?: {
  rejectKeys?: ReadonlySet<string>;
  rawKeyOrder?: string[];
  onResume?: (instanceIndex: number, ctx: { state: AudioContextState }) => Promise<void>;
}) {
  const createdContexts: Array<{
    state: AudioContextState;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const createdSources: Array<{
    buffer: AudioBuffer | null;
    loop: boolean;
    playbackRate: { value: number };
    connectedTo: unknown[];
    started: boolean;
    stopped: boolean;
    onended: (() => void) | null;
    connect: (target: unknown) => unknown;
    disconnect: () => void;
    start: (when?: number) => void;
    stop: () => void;
  }> = [];

  const createdGains: Array<{
    gain: {
      value: number;
      setValueAtTime: (v: number, t: number) => void;
      setTargetAtTime: (v: number, t: number, tc: number) => void;
      cancelScheduledValues: (t: number) => void;
    };
    connectedTo: unknown[];
    connect: (target: unknown) => unknown;
    disconnect: () => void;
  }> = [];

  const createdFilters: Array<{
    type: BiquadFilterType;
    frequency: {
      value: number;
      setValueAtTime: (v: number, t: number) => void;
      setTargetAtTime: (v: number, t: number, tc: number) => void;
      cancelScheduledValues: (t: number) => void;
    };
    Q: { value: number };
    connectedTo: unknown[];
    connect: (target: unknown) => unknown;
    disconnect: () => void;
  }> = [];

  const decodeCalls: Array<{ byteLength: number; buffer: ArrayBuffer }> = [];
  let contextInstances = 0;
  let closed = false;

  const makeAudioParam = (initial = 1) => {
    const param = {
      value: initial,
      setValueAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      setTargetAtTime: vi.fn((v: number) => {
        param.value = v;
      }),
      cancelScheduledValues: vi.fn(),
    };
    return param;
  };

  class MockAudioContext {
    state: AudioContextState = 'suspended';
    sampleRate = 44100;
    currentTime = 0;
    destination = { kind: 'destination' };
    private readonly instanceIndex: number;

    constructor() {
      contextInstances += 1;
      this.instanceIndex = contextInstances;
      createdContexts.push(this);
    }

    resume = vi.fn(async () => {
      if (options?.onResume) {
        await options.onResume(this.instanceIndex, this);
        return;
      }
      this.state = 'running';
    });

    close = vi.fn(async () => {
      closed = true;
      this.state = 'closed';
    });

    createGain = vi.fn(() => {
      const node = {
        gain: makeAudioParam(1),
        connectedTo: [] as unknown[],
        connect: vi.fn((target: unknown) => {
          node.connectedTo.push(target);
          return target;
        }),
        disconnect: vi.fn(),
      };
      createdGains.push(node);
      return node;
    });

    createBiquadFilter = vi.fn(() => {
      const filter = {
        type: 'lowpass' as BiquadFilterType,
        frequency: makeAudioParam(20000),
        Q: makeAudioParam(0.707),
        connectedTo: [] as unknown[],
        connect: vi.fn((target: unknown) => {
          filter.connectedTo.push(target);
          return target;
        }),
        disconnect: vi.fn(),
      };
      createdFilters.push(filter);
      return filter;
    });

    createDynamicsCompressor = vi.fn(() => ({
      threshold: makeAudioParam(-14),
      knee: makeAudioParam(18),
      ratio: makeAudioParam(4),
      attack: makeAudioParam(0.003),
      release: makeAudioParam(0.25),
      connect: vi.fn((t: unknown) => t),
      disconnect: vi.fn(),
    }));

    createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
      const channelData = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => channelData,
      } as unknown as AudioBuffer;
    });

    createBufferSource = vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        loop: false,
        playbackRate: makeAudioParam(1),
        connectedTo: [] as unknown[],
        started: false,
        stopped: false,
        onended: null as (() => void) | null,
        connect: vi.fn((target: unknown) => {
          source.connectedTo.push(target);
          return target;
        }),
        disconnect: vi.fn(),
        start: vi.fn(() => {
          source.started = true;
        }),
        stop: vi.fn(() => {
          source.stopped = true;
        }),
      };
      createdSources.push(source);
      return source;
    });

    decodeAudioData = vi.fn(async (buf: ArrayBuffer) => {
      decodeCalls.push({ byteLength: buf.byteLength, buffer: buf });
      // Identify key via first byte tag when provider encodes index
      const view = new Uint8Array(buf);
      const tagIdx = view[0];
      const key =
        options?.rawKeyOrder && tagIdx !== undefined
          ? options.rawKeyOrder[tagIdx]
          : undefined;
      if (key && options?.rejectKeys?.has(key)) {
        throw new Error(`Unsupported codec for ${key}`);
      }
      return {
        numberOfChannels: 1,
        length: 2048,
        sampleRate: 44100,
        duration: 2048 / 44100,
        getChannelData: () => new Float32Array(2048),
      } as unknown as AudioBuffer;
    });
  }

  return {
    MockAudioContext,
    createdContexts,
    createdSources,
    createdGains,
    createdFilters,
    decodeCalls,
    getContextInstances: () => contextInstances,
    isClosed: () => closed,
  };
}

function createAudioBufferProvider(keys: readonly string[] = ALL_21_AUDIO_KEYS): {
  provider: AudioBufferProvider;
  rawBuffers: Map<string, ArrayBuffer>;
} {
  const rawBuffers = new Map<string, ArrayBuffer>();
  keys.forEach((key, idx) => {
    const ab = new ArrayBuffer(16);
    new Uint8Array(ab)[0] = idx;
    rawBuffers.set(key, ab);
  });
  return {
    provider: {
      getBundle: () => ({ audioBuffers: rawBuffers }),
    },
    rawBuffers,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
});

// ===========================================================================
// 1. Entities & Shader Hygiene
// ===========================================================================
describe('Entities & Shader Hygiene', () => {
  it('has zero ShaderMaterial or RawShaderMaterial references across src/entities, src/combat, and src/audio', () => {
    const entityFiles = collectTsFiles(path.join(PROJECT_ROOT, 'src/entities'));
    const combatFiles = collectTsFiles(path.join(PROJECT_ROOT, 'src/combat'));
    const audioFiles = collectTsFiles(path.join(PROJECT_ROOT, 'src/audio'));
    const allFiles = [...entityFiles, ...combatFiles, ...audioFiles];

    expect(allFiles.length).toBeGreaterThanOrEqual(6);

    for (const filePath of allFiles) {
      const source = readFileSync(filePath, 'utf8');
      expect(
        /\b(Raw)?ShaderMaterial\b/.test(source),
        `Forbidden ShaderMaterial reference found in ${filePath}`,
      ).toBe(false);
    }
  });

  it('converts PlayerEntity (including sash and weapon) and BossEntity (including weapon) meshes to NodeMaterial', () => {
    const playerFx = createPlayerFixture();
    const bossFx = createBossFixture();

    const playerMatCount = assertOnlyNodeMaterials(playerFx.player.rootGroup);
    const bossMatCount = assertOnlyNodeMaterials(bossFx.boss.rootGroup);

    const sashMesh = playerFx.player.model.getObjectByName('PlayerWaistSilkSashMesh');
    expect(sashMesh).toBeDefined();
    expect(assertOnlyNodeMaterials(sashMesh!)).toBe(1);

    expect(playerMatCount).toBeGreaterThanOrEqual(4);
    expect(bossMatCount).toBeGreaterThanOrEqual(3);

    playerFx.cleanup();
    bossFx.cleanup();
  });

  it('resolves AnimationRig clips synchronously, handles missing clips, and sets LoopOnce + clampWhenFinished on Boss death', () => {
    const root = new THREE.Group();
    const rig = new AnimationRig(
      root,
      [makeClip('Sword_Idle', 1.2), makeClip('Sword_Regular_A', 0.35), makeClip('Death01', 1.0)],
      ['Missing_Clip', 'Sword_Idle'],
    );

    expect(rig.activeClipName).toBe('Sword_Idle');
    expect(rig.hasClip('Sword_Regular_A')).toBe(true);
    expect(rig.hasClip('NonExistent')).toBe(false);
    expect(rig.getClipDuration('Sword_Regular_A')).toBeCloseTo(0.35, 5);
    expect(rig.getClipDuration('NonExistent')).toBe(0);

    const played = rig.play(['Missing', 'Sword_Regular_A'], { fadeSeconds: 0.05 });
    expect(played).toBe('Sword_Regular_A');
    expect(rig.activeClipName).toBe('Sword_Regular_A');

    // Unknown clip keeps current activeClipName synchronously
    expect(rig.play('DoesNotExist')).toBe('Sword_Regular_A');
    rig.update(0.05);
    rig.dispose();

    // Verify BossEntity.enterDead() plays Death_B (or Death_A) with LoopOnce & clampWhenFinished
    const clipActionSpy = vi.spyOn(THREE.AnimationMixer.prototype, 'clipAction');
    const bossB = createBossFixture({ deathClips: ['Death_B', 'Death_A'] });
    bossB.boss.enterDead();
    expect(bossB.boss.activeClip).toBe('Death_B');
    const lastActionB = clipActionSpy.mock.results.at(-1)?.value as THREE.AnimationAction;
    expect(lastActionB.loop).toBe(THREE.LoopOnce);
    expect(lastActionB.clampWhenFinished).toBe(true);
    bossB.cleanup();

    // Verify fallback to Death_A when Death_B is absent
    const bossA = createBossFixture({ deathClips: ['Death_A'] });
    bossA.boss.enterDead();
    expect(bossA.boss.activeClip).toBe('Death_A');
    const lastActionA = clipActionSpy.mock.results.at(-1)?.value as THREE.AnimationAction;
    expect(lastActionA.loop).toBe(THREE.LoopOnce);
    expect(lastActionA.clampWhenFinished).toBe(true);
    bossA.cleanup();
  });

  it('attaches objects via attachObjectToBone for raw hand_r and sanitized handslotr from handslot.r', () => {
    const parentRaw = new THREE.Group();
    const handR = new THREE.Bone();
    handR.name = 'hand_r';
    const handSlotDot = new THREE.Bone();
    handSlotDot.name = 'handslot.r';
    parentRaw.add(handR, handSlotDot);

    const katana = new THREE.Group();
    expect(attachObjectToBone(parentRaw, katana, ['hand_r'])).toBe(handR);
    expect(handR.children).toContain(katana);

    const axe1 = new THREE.Group();
    expect(attachObjectToBone(parentRaw, axe1, ['handslot.r'])).toBe(handSlotDot);
    expect(handSlotDot.children).toContain(axe1);

    // Sanitized bone name ('handslotr' resolved when looking up 'handslot.r')
    const parentSanitized = new THREE.Group();
    const handSlotSanitized = new THREE.Bone();
    handSlotSanitized.name = 'handslotr';
    parentSanitized.add(handSlotSanitized);

    const axe2 = new THREE.Group();
    expect(attachObjectToBone(parentSanitized, axe2, ['handslot.r'])).toBe(handSlotSanitized);
    expect(handSlotSanitized.children).toContain(axe2);

    // BossEntity with sanitized handslotr does not emit missing-bone error
    const errors: string[] = [];
    const bossFx = createBossFixture({
      handBoneName: 'handslotr',
      onError: (msg) => errors.push(msg),
    });
    expect(errors).toEqual([]);
    bossFx.cleanup();
  });

  it('computes orthogonal PlayerEntity camera basis, clamps camera floor >= 0.55, clamps arena R <= 25.0, and enforces Boss separation >= 1.6m', () => {
    const playerFx = createPlayerFixture();
    const { player } = playerFx;

    // Camera basis rightXZ = (-forwardXZ.z, forwardXZ.x)
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
    cam.position.set(10, 4, 10);
    cam.lookAt(0, 1, 0);
    cam.updateMatrixWorld();

    const basis = player.getCameraBasisXZ(cam);
    expect(Math.hypot(basis.forwardX, basis.forwardZ)).toBeCloseTo(1, 5);
    expect(basis.rightX).toBeCloseTo(-basis.forwardZ, 6);
    expect(basis.rightZ).toBeCloseTo(basis.forwardX, 6);
    expect(basis.forwardX * basis.rightX + basis.forwardZ * basis.rightZ).toBeCloseTo(0, 6);

    // Camera floor clamp y >= 0.55
    player.applyCameraOrbitDelta(0, -10000);
    player.updateCamera(cam, 0.05);
    expect(cam.position.y).toBeGreaterThanOrEqual(0.55);

    player.updateCamera(cam, 0.05, {
      position: new THREE.Vector3(0, -10, 8),
      lookAt: new THREE.Vector3(0, 1, 0),
      lerpAlpha: 1,
    });
    expect(cam.position.y).toBeGreaterThanOrEqual(0.55);

    // Arena clamp R <= 25.0 (margin 0.5 => <= 24.5)
    player.position.set(40, 0, 30);
    player.enforceBoundsAndSeparation();
    expect(Math.hypot(player.position.x, player.position.z)).toBeLessThanOrEqual(25.0);
    expect(Math.hypot(player.position.x, player.position.z)).toBeCloseTo(24.5, 5);

    // Boss separation >= 1.6m
    const bossPos = { x: 0, y: 0, z: -5 };
    player.position.set(0.2, 0, -4.6);
    player.enforceBoundsAndSeparation(bossPos);
    const sep = Math.hypot(player.position.x - bossPos.x, player.position.z - bossPos.z);
    expect(sep).toBeGreaterThanOrEqual(1.6 - 1e-6);

    playerFx.cleanup();
  });

  it('triggers all 8 Phase 1 & Phase 2 Boss attacks via triggerTestAttack regardless of active phase', () => {
    const bossFx = createBossFixture();
    const vfxFx = createMockVfx();
    const { boss } = bossFx;

    expect(COMBAT_TUNING.bossAttacks).toHaveLength(8);

    // Stay in Phase 1 and verify all 8 (including all 4 Phase 2 attacks) work immediately
    boss.enterCombatPhase(1);
    const playerPos = { x: 0, y: 0, z: -1.5 };

    for (const spec of COMBAT_TUNING.bossAttacks) {
      const triggered = boss.triggerTestAttack(spec.id, playerPos, vfxFx.vfx);
      expect(triggered).not.toBeNull();
      expect(triggered?.id).toBe(spec.id);
      expect(boss.currentAttack).toBe(spec.id);
      expect(boss.attackTelegraphActive).toBe(true);
      expect(boss.aiState).toBe('WINDUP');
    }

    // Also verify Phase 2 context triggers Phase 1 attacks seamlessly
    boss.enterCombatPhase(2);
    const p1InP2 = boss.triggerTestAttack('abyssal_sweep', playerPos, vfxFx.vfx);
    expect(p1InP2?.id).toBe('abyssal_sweep');
    expect(boss.currentAttack).toBe('abyssal_sweep');

    // Unknown attack returns null
    expect(boss.triggerTestAttack('nonexistent_attack', playerPos, vfxFx.vfx)).toBeNull();

    bossFx.cleanup();
  });

  it('sanitizes non-finite PlayerEntity.updateCamera overrides (NaN / ±Infinity position, lookAt, lerpAlpha) and preserves camera floor >= 0.55', () => {
    const playerFx = createPlayerFixture();
    const { player } = playerFx;
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
    cam.position.set(0, 2.5, 8);
    cam.lookAt(0, 1.38, 0);
    cam.updateMatrixWorld();

    // First call (uninitialized camera) with all non-finite override fields
    player.updateCamera(cam, 0.05, {
      position: new THREE.Vector3(Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY),
      lookAt: new THREE.Vector3(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
      lerpAlpha: Number.NaN,
    });
    cam.updateMatrixWorld();

    expect(Number.isFinite(cam.position.x)).toBe(true);
    expect(Number.isFinite(cam.position.y)).toBe(true);
    expect(Number.isFinite(cam.position.z)).toBe(true);
    expect(cam.position.y).toBeGreaterThanOrEqual(0.55);
    expect(cam.matrixWorld.elements.every((el) => Number.isFinite(el))).toBe(true);

    // Second call (initialized camera, lerp path) with partial NaN/Infinity and non-finite lerpAlpha + non-finite player position
    player.position.set(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    player.updateCamera(cam, 0.05, {
      position: new THREE.Vector3(Number.POSITIVE_INFINITY, -5, Number.NaN),
      lookAt: new THREE.Vector3(Number.NaN, 1.2, Number.NEGATIVE_INFINITY),
      lerpAlpha: Number.POSITIVE_INFINITY,
    });
    cam.updateMatrixWorld();

    expect(Number.isFinite(cam.position.x)).toBe(true);
    expect(Number.isFinite(cam.position.y)).toBe(true);
    expect(Number.isFinite(cam.position.z)).toBe(true);
    expect(cam.position.y).toBeGreaterThanOrEqual(0.55);
    expect(cam.matrixWorld.elements.every((el) => Number.isFinite(el))).toBe(true);

    // Third call with lerpAlpha: -Infinity (forces defaultAlpha < 1 lerp path) and non-finite lookAt
    player.position.set(0, 0, 0);
    player.updateCamera(cam, 0.016, {
      position: new THREE.Vector3(2, 0.1, 6),
      lookAt: new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN),
      lerpAlpha: Number.NEGATIVE_INFINITY,
    });
    cam.updateMatrixWorld();

    expect(Number.isFinite(cam.position.x)).toBe(true);
    expect(Number.isFinite(cam.position.y)).toBe(true);
    expect(Number.isFinite(cam.position.z)).toBe(true);
    expect(cam.position.y).toBeGreaterThanOrEqual(0.55);
    expect(cam.matrixWorld.elements.every((el) => Number.isFinite(el))).toBe(true);

    playerFx.cleanup();
  });

  it('restores Boss posture to 1,000 when BossEntity.triggerTestAttack interrupts staggered or posture <= 0 so a light hit does not immediately re-stagger', () => {
    const h = createCombatHarness();

    // Break Boss posture so Boss enters staggered with posture === 0
    h.combat.setBossPosture(0);
    expect(h.boss.staggered).toBe(true);
    expect(h.boss.posture).toBe(0);
    expect(h.combat.getStatsSnapshot().postureBreaks).toBe(1);

    // Interrupt stagger via triggerTestAttack -> posture must restore to 1,000
    const spec = h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    expect(spec?.id).toBe('cataclysmic_leap_slam');
    expect(h.boss.staggered).toBe(false);
    expect(h.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);

    // Subsequent light hit (40 posture damage) must NOT immediately re-trigger POSTURE BROKEN
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.1, 0.05);
    expect(h.boss.staggered).toBe(false);
    expect(h.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture - 40);
    expect(h.combat.getStatsSnapshot().postureBreaks).toBe(1);

    // Also verify posture <= 0 when not flagged staggered restores to 1,000, while partial positive posture stays intact
    h.boss.posture = 0;
    h.boss.staggered = false;
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    expect(h.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);

    h.boss.posture = 300;
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    expect(h.boss.posture).toBe(300);

    h.cleanup();
  });
});

// ===========================================================================
// 2. CombatSystem
// ===========================================================================
describe('CombatSystem', () => {
  it('executes 4-hit combo with exact DMG/Posture/Qi/Step-4 heal, single-slot buffer, 0.55s reset, auto-facing, and out-of-range miss', () => {
    const h = createCombatHarness();
    h.combat.qi = 0;
    h.combat.hp = 900;

    // Face player away from boss initially to verify auto-facing on attack
    h.player.rootGroup.rotation.y = 0;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);
    // Player at (0,0,-1.5) facing boss at (0,0,-5) => yaw ~ PI
    expect(Math.abs(h.player.facingYaw)).toBeCloseTo(Math.PI, 4);

    // Queue Step 2 mid-swing, and mash extra attack presses to verify single-slot buffer
    h.stepFrame(0.05, idleInput({ attackPressed: true })); // t=0.10: Step 1 hit delivered (160 DMG, 40 Posture, 6 Qi)
    expect(h.boss.hp).toBe(40_000 - 160);
    expect(h.boss.posture).toBe(1_000 - 40);
    expect(h.combat.qi).toBe(6);

    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);

    // Finish Step 1 (0.32s + 30ms hitstop -> advance 0.20s so buffered Step 2 starts)
    h.stepDuration(0.20, 0.05);
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(2);

    // Deliver Step 2 hit (190 DMG, 45 Posture, 7 Qi)
    h.stepDuration(0.10, 0.05);
    expect(h.boss.hp).toBe(40_000 - 160 - 190);
    expect(h.boss.posture).toBe(1_000 - 40 - 45);
    expect(h.combat.qi).toBe(6 + 7);

    // Finish Step 2 (0.34s + 35ms hitstop) and chain Step 3 (240 DMG, 60 Posture, 9 Qi)
    h.stepDuration(0.35, 0.05);
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(3);
    h.stepDuration(0.10, 0.05);
    expect(h.boss.hp).toBe(40_000 - 160 - 190 - 240);
    expect(h.boss.posture).toBe(1_000 - 40 - 45 - 60);
    expect(h.combat.qi).toBe(6 + 7 + 9);

    // Finish Step 3 (0.40s + 45ms hitstop) and chain Step 4 (380 DMG, 110 Posture, 15 Qi, +25 HP)
    h.stepDuration(0.40, 0.05);
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(4);
    h.stepDuration(0.10, 0.05);
    expect(h.boss.hp).toBe(40_000 - 160 - 190 - 240 - 380);
    expect(h.boss.posture).toBe(1_000 - 40 - 45 - 60 - 110);
    expect(h.combat.qi).toBe(6 + 7 + 9 + 15);
    expect(h.combat.hp).toBe(925);

    // Wait past Step 4 + 0.55s reset window -> comboStep resets to 0
    h.stepDuration(0.5 + 0.6, 0.05);
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(0);

    // Out of range (> 8m): advances comboStep and plays SFX without damage or Qi
    h.player.position.set(0, 0, 6); // 11m from boss at z=-5
    const hpBefore = h.boss.hp;
    const qiBefore = h.combat.qi;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.15, 0.05);
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);
    expect(h.boss.hp).toBe(hpBefore);
    expect(h.combat.qi).toBe(qiBefore);
    expect(h.audioFx.playedSfx).toContain('sword_slash_1');

    h.cleanup();
  });

  it('executes Dodge (0.52s duration, 0.42s i-frames, 5.5m distance, 0.77s CD so dodge > 0 at 550ms) and cancels combo', () => {
    const h = createCombatHarness();
    // Place player with open room behind (+Z) to measure dodge displacement cleanly
    h.player.position.set(0, 0, 2);

    // Start combo Step 1, then cancel with dodge at 100ms
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepFrame(0.05, idleInput());
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);

    const startZ = h.player.position.z;
    h.stepFrame(0.05, idleInput({ dodgePressed: true, moveZ: -1 }));
    let snap = h.combat.getPlayerDebugSnapshot();
    expect(snap.isDodging).toBe(true);
    expect(snap.invulnerable).toBe(true);
    expect(snap.skillCooldowns.dodge).toBeCloseTo(0.77, 5);

    // At 350ms (0.35s < 0.42s i-frames): still invulnerable
    h.stepDuration(0.35, 0.05);
    expect(h.combat.isPlayerInvulnerable()).toBe(true);

    // At 450ms (0.45s > 0.42s i-frames): i-frames ended, still dodging until 0.52s
    h.stepDuration(0.1, 0.05);
    expect(h.combat.isPlayerInvulnerable()).toBe(false);
    expect(h.combat.getPlayerDebugSnapshot().isDodging).toBe(true);

    // At 550ms total elapsed: dodge ended, dodge CD strictly > 0 (~0.22s), re-dodge blocked
    h.stepDuration(0.1, 0.05);
    snap = h.combat.getPlayerDebugSnapshot();
    expect(snap.isDodging).toBe(false);
    expect(snap.skillCooldowns.dodge).toBeGreaterThan(0);

    h.stepFrame(0.05, idleInput({ dodgePressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().isDodging).toBe(false);

    // Total displacement ~5.5m (discrete 0.05s frames move 0.50/0.52 * 5.5 ≈ 5.29m)
    const moved = Math.abs(h.player.position.z - startZ);
    expect(moved).toBeGreaterThan(5.2);
    expect(moved).toBeLessThanOrEqual(COMBAT_TUNING.dodgeDistance + 0.01);

    h.cleanup();
  });

  it('triggers Perfect Dodge Bullet-Time inside 0.35s window & radius+1.2m, grants sustain + 1.4x Counter Crit, and refreshes without stacking', () => {
    const h = createCombatHarness();
    h.combat.hp = 800;
    h.combat.shield = 100;
    h.combat.qi = 40;

    // 1. Too early (> 0.35s windup remaining) does NOT trigger Perfect Dodge
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx); // windup 1.1s
    h.stepFrame(0.05, idleInput({ dodgePressed: true }));
    expect(h.timeScaleSystem.bulletTimeActive).toBe(false);
    expect(h.combat.getStatsSnapshot().perfectDodges).toBe(0);

    // Wait for dodge CD + attack to finish
    h.stepDuration(2.5, 0.05);

    // 2. Out of proximity (> radius + 1.2m) does NOT trigger Perfect Dodge
    h.player.position.set(0, 0, 5); // 10m from boss; abyssal_sweep radius 6.8 + 1.2 = 8.0m
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    h.stepDuration(0.85, 0.05); // windupRemaining = 0.25s <= 0.35s
    h.stepFrame(0.05, idleInput({ dodgePressed: true }));
    expect(h.timeScaleSystem.bulletTimeActive).toBe(false);
    expect(h.combat.getStatsSnapshot().perfectDodges).toBe(0);

    h.stepDuration(2.0, 0.05);

    // 3. Inside <= 0.35s windup & <= radius + 1.2m triggers Perfect Dodge once per attack
    h.player.position.set(0, 0, -1.5); // 3.5m from boss
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    h.stepDuration(0.8, 0.05); // windupRemaining = 0.30s <= 0.35s

    h.combat.hp = 800;
    h.combat.shield = 100;
    h.combat.qi = 40;
    h.stepFrame(0.05, idleInput({ dodgePressed: true, moveZ: 1 }));
    expect(h.timeScaleSystem.bulletTimeActive).toBe(true);
    expect(h.timeScaleSystem.worldTimeScale).toBe(0.25);
    expect(h.timeScaleSystem.playerTimeScale).toBe(1.0);
    expect(h.combat.hp).toBe(850); // +50
    expect(h.combat.shield).toBeCloseTo(182.25, 2); // 100 + 2.25 (0.05s regen tick) + 80 Perfect Dodge restore
    expect(h.combat.qi).toBe(60); // +20
    expect(h.combat.getStatsSnapshot().perfectDodges).toBe(1);
    expect(h.audioFx.isBulletTimeFilterActive()).toBe(true);
    expect(h.audioFx.playedSfx).toContain('perfect_dodge_chime');
    expect(h.callouts.some((c) => c.text === UI_COPY.CALLOUT_PERFECT_DODGE)).toBe(true);

    // Consecutive Perfect Dodge on a new attack refreshes Bullet-Time without stacking worldTimeScale < 0.25
    h.stepDuration(0.8, 0.05); // finish dodge CD (0.77s) while Bullet-Time still active (~1.2s left)
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    // Fast-forward windupRemaining to <= 0.35s to test refresh
    h.boss.activeAttack!.windupRemaining = 0.2;
    h.stepFrame(0.05, idleInput({ dodgePressed: true, moveZ: 1 }));
    expect(h.combat.getStatsSnapshot().perfectDodges).toBe(2);
    expect(h.timeScaleSystem.worldTimeScale).toBe(0.25);
    expect(h.timeScaleSystem.bulletTimeRemaining).toBeCloseTo(2.0, 2);

    // Counter Crit 1.4x applies on next hit (160 * 1.4 = 224)
    h.stepDuration(0.55, 0.05); // finish dodge
    const bossHpBefore = h.boss.hp;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.1, 0.05);
    expect(bossHpBefore - h.boss.hp).toBe(Math.round(160 * 1.4));

    // Wait out Bullet-Time -> filter turns off & worldTimeScale returns to 1.0
    h.stepDuration(2.0, 0.05);
    expect(h.timeScaleSystem.bulletTimeActive).toBe(false);
    expect(h.timeScaleSystem.worldTimeScale).toBe(1.0);
    expect(h.audioFx.isBulletTimeFilterActive()).toBe(false);

    h.cleanup();
  });

  it('executes Skills 1, 2, 3, enforces T3-13 exact 450ms Skill 1 -> 450ms Skill 2 -> Skill 3 timing, and cleanly exits 2.6s Time-Stop', () => {
    const h = createCombatHarness();
    h.combat.hp = 800;
    h.combat.shield = 50;
    h.combat.qi = 30; // < 50 Qi

    // Skill 3 fails when Qi < 50
    h.stepFrame(0.05, idleInput({ skill3Pressed: true }));
    expect(h.combat.skill3Active).toBe(false);

    // Test Skill 1 standalone (6s CD, 4 hits = 960 DMG, 140 Posture, 16 Qi)
    const hp0 = h.boss.hp;
    const pos0 = h.boss.posture;
    h.stepFrame(0.05, idleInput({ skill1Pressed: true }));
    expect(h.combat.isPlayerInvulnerable()).toBe(true);
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.skill1).toBeCloseTo(6.0, 2);
    h.stepDuration(0.45, 0.05);
    expect(hp0 - h.boss.hp).toBe(960);
    expect(pos0 - h.boss.posture).toBe(140);
    expect(h.combat.qi).toBe(30 + 16);

    // Test Skill 2 standalone (10s CD, 780 DMG, 420 Posture, 18 Qi, 85ms hitstop)
    const hp1 = h.boss.hp;
    const pos1 = h.boss.posture;
    h.stepFrame(0.05, idleInput({ skill2Pressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.skill2).toBeCloseTo(10.0, 2);
    h.stepDuration(0.55, 0.05);
    expect(hp1 - h.boss.hp).toBe(780);
    expect(pos1 - h.boss.posture).toBe(420);
    expect(h.combat.qi).toBe(30 + 16 + 18); // 64 >= 50

    // Reset cooldowns & posture for T3-13 exact timing test:
    // Skill 1 -> 450ms -> Skill 2 -> 450ms -> Skill 3 => skill3Active === true!
    h.combat.readyAllSkills();
    h.boss.posture = 1_000;
    h.boss.staggered = false;
    h.combat.hp = 800;
    h.combat.shield = 50;
    h.combat.qi = 100;

    h.stepFrame(0.05, idleInput({ skill1Pressed: true }));
    h.stepDuration(0.45, 0.05); // 450ms after Skill 1

    h.stepFrame(0.05, idleInput({ skill2Pressed: true }));
    h.stepDuration(0.45, 0.05); // 450ms after Skill 2

    const bossHpBeforeSkill3 = h.boss.hp;
    const bossPostureBeforeSkill3 = h.boss.posture;
    h.stepFrame(0.05, idleInput({ skill3Pressed: true }));

    expect(h.combat.skill3Active).toBe(true);
    expect(h.timeScaleSystem.skill3Active).toBe(true);
    expect(h.timeScaleSystem.worldTimeScale).toBe(0.0);
    expect(h.timeScaleSystem.playerTimeScale).toBe(1.0);
    expect(h.combat.qi).toBe(50); // 100 - 50 cost
    expect(h.combat.hp).toBe(920); // +120 heal
    expect(h.combat.shield).toBe(250); // full shield
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.skill3).toBeCloseTo(20.0, 2);

    // Advance 2.65s through all 6 slashes (1,200 DMG / 210 Posture) + detonation (1,200 DMG / 140 Posture)
    h.stepDuration(2.65, 0.05);
    expect(bossHpBeforeSkill3 - h.boss.hp).toBe(2_400);
    expect(bossPostureBeforeSkill3 - h.boss.posture).toBe(350);
    expect(h.combat.skill3Active).toBe(false);
    expect(h.timeScaleSystem.skill3Active).toBe(false);
    expect(h.timeScaleSystem.worldTimeScale).toBe(1.0);

    h.cleanup();
  });

  it('triggers Posture Break at 0 posture (5.0s stagger, clears telegraphs, 1.6x crit, ignores posture damage while staggered/invulnerable, resets to 1,000)', () => {
    const h = createCombatHarness();

    h.boss.triggerTestAttack('shattered_earth_slam', h.player.position, h.vfxFx.vfx);
    expect(h.boss.attackTelegraphActive).toBe(true);

    // Break posture
    h.combat.setBossPosture(0);
    expect(h.boss.posture).toBe(0);
    expect(h.boss.staggered).toBe(true);
    expect(h.boss.staggerRemaining).toBeCloseTo(5.0, 5);
    expect(h.boss.attackTelegraphActive).toBe(false);
    expect(h.boss.currentAttack).toBeNull();
    expect(h.vfxFx.clearAllTelegraphs).toHaveBeenCalled();
    expect(h.combat.getStatsSnapshot().postureBreaks).toBe(1);

    // Attack while staggered deals 1.6x damage (160 * 1.6 = 256) and posture stays 0
    const hpBefore = h.boss.hp;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.1, 0.05);
    expect(hpBefore - h.boss.hp).toBe(Math.round(160 * 1.6));
    expect(h.boss.posture).toBe(0);

    // Invulnerable boss ignores damage & posture damage
    h.boss.invulnerable = true;
    h.stepDuration(0.3, 0.05);
    const hpWhileInvuln = h.boss.hp;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.1, 0.05);
    expect(h.boss.hp).toBe(hpWhileInvuln);
    expect(h.boss.posture).toBe(0);
    h.boss.invulnerable = false;

    // Wait remaining stagger duration -> resets posture to 1,000
    h.stepDuration(4.7, 0.05);
    expect(h.boss.staggered).toBe(false);
    expect(h.boss.posture).toBe(1_000);

    h.cleanup();
  });

  it('implements Forgiving Sustain: Shield absorption, 3.5s regen delay -> 45/s, 0.6s grace frames, <500 HP Lotus regen, Immortal Lotus Ward (30s CD, +350 HP, 1.5s i-frames), and overheal caps', () => {
    const h = createCombatHarness();

    // 1. Shield absorbs first, stats.damageTaken records raw damage, 0.6s grace frames block immediate second hit
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx); // 120 DMG
    h.stepDuration(1.2, 0.05); // windup 1.15s -> impact
    expect(h.combat.shield).toBe(250 - 120);
    expect(h.combat.hp).toBe(1_000);
    expect(h.combat.getStatsSnapshot().damageTaken).toBe(120);

    // Immediate second attack within 0.6s grace frames does 0 damage
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    h.boss.activeAttack!.windupRemaining = 0.02;
    h.boss.activeAttack!.elapsed = h.boss.activeAttack!.spec.windupSeconds - 0.02;
    h.stepFrame(0.05);
    expect(h.combat.shield).toBe(130);

    // 2. Shield regen delay 3.5s -> 45/s (place Boss far away so AI doesn't interrupt passive regen)
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.stepDuration(2.8, 0.05); // < 3.5s total -> no shield regen yet
    expect(h.combat.shield).toBe(130);
    h.stepDuration(1.7, 0.05); // past 3.5s delay -> ~1.0s of 45/s regen
    expect(h.combat.shield).toBeGreaterThan(130);
    expect(h.combat.shield).toBeLessThanOrEqual(250);

    // Wait for full shield
    h.stepDuration(3.0, 0.05);
    expect(h.combat.shield).toBe(250);

    // 3. Low-HP Lotus passive regen (< 500 HP -> 15/s, stops at 500)
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.combat.hp = 400;
    h.stepDuration(2.0, 0.05);
    expect(h.combat.hp).toBeCloseTo(430, 1);
    h.stepDuration(8.0, 0.05);
    expect(h.combat.hp).toBe(500);

    // 4. Immortal Lotus Ward on lethal damage: +350 HP, 1.5s i-frames, 'lotus_ward' lastSfx, 30s CD
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);
    h.combat.shield = 0;
    h.combat.hp = 50;
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx); // 120 DMG > 50 HP
    h.stepDuration(1.15, 0.05); // exact windup 1.15s impact frame
    expect(h.combat.hp).toBe(350);
    expect(h.combat.isPlayerInvulnerable()).toBe(true);
    expect(h.audioFx.audio.getState?.().lastSfx).toBe('lotus_ward');
    expect(h.combat.getHudSustainState().lotusWardReady).toBe(false);
    expect(h.combat.getHudSustainState().lotusWardCooldown).toBeGreaterThan(28);

    // During 1.5s i-frames, another attack deals 0 damage
    h.stepDuration(0.8, 0.05);
    expect(h.combat.isPlayerInvulnerable()).toBe(true);

    // 5. Overheal protection caps HP<=1000, Shield<=250, Qi<=100
    h.combat.hp = 990;
    h.combat.shield = 240;
    h.combat.qi = 95;
    h.combat.readyAllSkills();
    h.stepFrame(0.05, idleInput({ skill3Pressed: true }));
    expect(h.combat.hp).toBeLessThanOrEqual(1_000);
    expect(h.combat.shield).toBeLessThanOrEqual(250);
    expect(h.combat.qi).toBeLessThanOrEqual(100);

    h.cleanup();
  });

  it('ignores non-finite CombatSystem.setBossPosture(NaN | Infinity | -Infinity) without triggering stagger or incrementing postureBreaks', () => {
    const h = createCombatHarness();

    for (const invalidPosture of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      h.combat.setBossPosture(invalidPosture);
      expect(h.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
      expect(h.boss.staggered).toBe(false);
      expect(h.combat.getStatsSnapshot().postureBreaks).toBe(0);
    }

    // Partial posture also remains intact when non-finite values are supplied
    h.combat.setBossPosture(425);
    expect(h.boss.posture).toBe(425);
    h.combat.setBossPosture(Number.NaN);
    h.combat.setBossPosture(Number.NEGATIVE_INFINITY);
    expect(h.boss.posture).toBe(425);
    expect(h.boss.staggered).toBe(false);
    expect(h.combat.getStatsSnapshot().postureBreaks).toBe(0);

    h.cleanup();
  });

  it('executes Dodge with non-finite move inputs { moveX: Infinity, moveZ: NaN, dodgePressed: true } at full speed with finite velocity', () => {
    const h = createCombatHarness();
    h.player.position.set(0, 0, 2);

    // Non-finite movement input without dodge must keep velocity finite
    h.stepFrame(0.05, idleInput({ moveX: Number.POSITIVE_INFINITY, moveZ: Number.NaN }));
    expect(Number.isFinite(h.player.velocity.x)).toBe(true);
    expect(Number.isFinite(h.player.velocity.z)).toBe(true);
    expect(Number.isFinite(h.player.position.x)).toBe(true);
    expect(Number.isFinite(h.player.position.z)).toBe(true);

    // Dodge with { moveX: Infinity, moveZ: NaN, dodgePressed: true } executes at full dodge speed (> 0) with finite velocity
    const expectedDodgeSpeed = COMBAT_TUNING.dodgeDistance / COMBAT_TUNING.dodgeDurationSeconds;
    h.stepFrame(
      0.05,
      idleInput({ moveX: Number.POSITIVE_INFINITY, moveZ: Number.NaN, dodgePressed: true }),
    );
    const snap = h.combat.getPlayerDebugSnapshot();
    const speed = Math.hypot(h.player.velocity.x, h.player.velocity.z);

    expect(snap.isDodging).toBe(true);
    expect(Number.isFinite(h.player.velocity.x)).toBe(true);
    expect(Number.isFinite(h.player.velocity.z)).toBe(true);
    expect(Number.isFinite(h.player.position.x)).toBe(true);
    expect(Number.isFinite(h.player.position.z)).toBe(true);
    expect(speed).toBeGreaterThan(0);
    expect(speed).toBeCloseTo(expectedDodgeSpeed, 3);

    h.cleanup();
  });

  it('resets comboStep cleanly within 800ms after Hit 1 delivery at 60Hz (matching T1-F8-05) so next attack deals Hit 1 (160 DMG)', () => {
    const h = createCombatHarness();
    const dt60 = 1 / 60;

    // Trigger Hit 1 and step at 60Hz until Hit 1 damage (160 DMG) is delivered
    h.stepFrame(dt60, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);

    let framesToHit = 0;
    while (h.boss.hp === COMBAT_TUNING.bossMaxHp && framesToHit < 30) {
      h.stepFrame(dt60, idleInput());
      framesToHit += 1;
    }
    expect(h.boss.hp).toBe(COMBAT_TUNING.bossMaxHp - 160);

    // Wait 800ms (48 frames at 60Hz) after Hit 1 delivery
    for (let i = 0; i < 48; i += 1) {
      h.stepFrame(dt60, idleInput());
    }
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(0);

    // Next attack must execute Hit 1 (160 DMG, not Hit 2 190 DMG)
    const hpBeforeSecondAttack = h.boss.hp;
    h.stepFrame(dt60, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);
    for (let i = 0; i < 10; i += 1) {
      h.stepFrame(dt60, idleInput());
    }
    expect(hpBeforeSecondAttack - h.boss.hp).toBe(160);

    h.cleanup();
  });

  it('prevents a Perfect-Dodged Boss attack from hitting the player on Bullet-Time trailing active frames after 0.42s i-frames expire', () => {
    const h = createCombatHarness();
    h.player.position.set(0, 0, -1.5); // 3.5m from boss at z=-5 (inside abyssal_sweep 6.8m radius)

    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx); // 1.1s windup, 0.28s active
    h.stepDuration(0.85, 0.05); // windupRemaining = 0.25s <= 0.35s

    // Dodge directly toward boss (moveZ: -1) so player remains inside abyssal_sweep's 6.8m radius
    h.stepFrame(0.05, idleInput({ dodgePressed: true, moveZ: -1 }));
    expect(h.timeScaleSystem.bulletTimeActive).toBe(true);
    expect(h.boss.activeAttack?.perfectDodgeAwarded).toBe(true);
    expect(h.combat.getStatsSnapshot().perfectDodges).toBe(1);

    const hpAfterDodge = h.combat.hp;
    const shieldAfterDodge = h.combat.shield;
    const damageTakenAfterDodge = h.combat.getStatsSnapshot().damageTaken;

    // Advance 0.55s (> 0.42s dodge i-frames) so player is no longer invulnerable while attack is still winding up/active in 0.25x Bullet-Time
    h.stepDuration(0.55, 0.05);
    expect(h.combat.isPlayerInvulnerable()).toBe(false);

    // Reposition right inside melee/hitbox range and advance through the rest of the Bullet-Time-stretched active window + recovery
    h.player.position.set(0, 0, -1.5);
    h.stepDuration(2.5, 0.05);

    expect(h.boss.activeAttack).toBeNull();
    expect(h.combat.getStatsSnapshot().damageTaken).toBe(damageTakenAfterDodge);
    expect(h.combat.hp).toBe(hpAfterDodge);
    expect(h.combat.shield).toBeGreaterThanOrEqual(shieldAfterDodge);

    // Confirm a fresh non-Perfect-Dodged attack still deals damage normally
    h.boss.triggerTestAttack('abyssal_sweep', h.player.position, h.vfxFx.vfx);
    h.stepDuration(1.25, 0.05);
    expect(h.combat.getStatsSnapshot().damageTaken).toBeGreaterThan(damageTakenAfterDodge);

    h.cleanup();
  });
});

// ===========================================================================
// 3. GameStateMachine
// ===========================================================================
describe('GameStateMachine', () => {
  it('completes full 3-act flow TITLE -> CINEMATIC_INTRO -> PHASE_1 -> CINEMATIC_TRANSITION -> PHASE_2 -> CINEMATIC_FINISHER -> VICTORY (SSS)', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    expect(h.gsm.phase).toBe('TITLE');
    expect(h.boss.invulnerable).toBe(true);

    // Combat inputs ignored in TITLE
    h.tick(0.05, idleInput({ attackPressed: true, skill1Pressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(0);
    expect(h.gsm.elapsedCombatSeconds).toBe(0);

    // Start trial -> CINEMATIC_INTRO (6.0s)
    h.gsm.startTrial();
    expect(h.gsm.phase).toBe('CINEMATIC_INTRO');
    h.tickSeconds(6.05, 0.05);
    expect(h.gsm.phase).toBe('PHASE_1');
    expect(h.boss.invulnerable).toBe(false);

    // Deal damage in PHASE_1 until <= 22,000 -> clamps at 22,000 & enters CINEMATIC_TRANSITION
    api.setBossHp(22_100);
    expect(h.gsm.phase).toBe('PHASE_1');
    api.setBossHp(10_000);
    expect(h.boss.hp).toBe(22_000);
    expect(h.gsm.phase).toBe('CINEMATIC_TRANSITION');
    expect(h.boss.invulnerable).toBe(true);

    // Advance 5.0s transition -> PHASE_2
    h.tickSeconds(5.05, 0.05);
    expect(h.gsm.phase).toBe('PHASE_2');
    expect(h.boss.invulnerable).toBe(false);
    expect(h.arenaFx.setPhaseIntensity).toHaveBeenLastCalledWith(1);

    // Drain Boss HP to 0 in PHASE_2 -> CINEMATIC_FINISHER (4.5s) -> VICTORY (SSS)
    api.setBossHp(-500);
    expect(h.boss.hp).toBe(0);
    expect(h.gsm.phase).toBe('CINEMATIC_FINISHER');
    h.tickSeconds(4.55, 0.05);
    expect(h.gsm.phase).toBe('VICTORY');

    const snap = api.getState();
    expect(snap.stats.rank).toBe('SSS');
    expect(snap.audio.activeBgmState).toBe('victory');

    h.cleanup();
  });

  it('clamps massive PHASE_1 single hit at 22,000 HP and never skips PHASE_2', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    h.gsm.startTrial();
    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    // Place player in melee range and give massive damage multiplier
    h.player.position.set(0, 0, -1.5);
    api.setPlayerDamageMultiplier(500);
    h.tick(0.05, idleInput({ skill2Pressed: true }));
    h.tickSeconds(0.25, 0.05); // Skill 2 deals 780 * 500 = 390,000 -> must clamp to 22,000

    expect(h.boss.hp).toBe(22_000);
    expect(h.gsm.phase).toBe('CINEMATIC_TRANSITION');

    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_2');
    expect(h.boss.hp).toBe(22_000);

    // Lowering HP inside PHASE_2 never re-triggers CINEMATIC_TRANSITION
    api.setBossHp(15_000);
    expect(h.gsm.phase).toBe('PHASE_2');
    expect(h.boss.hp).toBe(15_000);

    h.cleanup();
  });

  it('cleanly resets timeScale === 1.0 and skill3Active === false when Skill 3 crosses 55% HP threshold (T3-16)', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    h.gsm.startTrial();
    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    h.player.position.set(0, 0, -1.5);
    api.setBossHp(22_150);

    h.tick(0.05, idleInput({ skill3Pressed: true }));
    expect(h.combat.skill3Active).toBe(true);
    expect(h.timeScaleSystem.worldTimeScale).toBe(0.0);

    // Advance until first reality slash (200 DMG) crosses 22,000 HP
    h.tickSeconds(0.35, 0.05);
    expect(h.gsm.phase).toBe('CINEMATIC_TRANSITION');
    expect(h.boss.hp).toBe(22_000);
    expect(h.combat.skill3Active).toBe(false);
    expect(h.timeScaleSystem.worldTimeScale).toBe(1.0);
    expect(h.audioFx.isBulletTimeFilterActive()).toBe(false);

    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_2');
    const snap = api.getState();
    expect(snap.skill3Active).toBe(false);
    expect(snap.timeScale).toBe(1.0);

    h.cleanup();
  });

  it('restores Boss posture to maxPosture when entering Phase 2 from a staggered (posture <= 0) state and preserves non-zero partial posture', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    h.gsm.startTrial();
    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    // Break Boss posture (staggered === true, posture === 0), then cross 55% HP threshold
    api.setBossPosture(0);
    expect(h.boss.staggered).toBe(true);
    expect(h.boss.posture).toBe(0);

    api.setBossHp(22_000);
    expect(h.gsm.phase).toBe('CINEMATIC_TRANSITION');
    api.skipCinematic();

    expect(h.gsm.phase).toBe('PHASE_2');
    expect(h.boss.staggered).toBe(false);
    expect(h.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    expect(api.getState().boss.postureRatio).toBe(1.0);

    // Non-zero partial posture should be preserved on enterCombatPhase(2)
    h.boss.posture = 450;
    h.boss.enterCombatPhase(2);
    expect(h.boss.staggered).toBe(false);
    expect(h.boss.posture).toBe(450);

    h.cleanup();
  });

  it('wires DebugBridge hooks, HudSnapshot subscribers, and full restartTrial() reset', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    const received: HudSnapshot[] = [];
    const unsubscribe = h.gsm.subscribeHud((snap) => received.push(snap));
    expect(received).toHaveLength(1);
    expect(received[0]!.phase).toBe('TITLE');

    // skipCinematic() is a no-op in TITLE
    api.skipCinematic();
    expect(h.gsm.phase).toBe('TITLE');

    h.gsm.startTrial();
    expect(h.gsm.phase).toBe('CINEMATIC_INTRO');
    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    // skipCinematic() is a no-op in PHASE_1
    api.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    // triggerBossTestAttack works with Phase 2 attack id in PHASE_1
    api.triggerBossTestAttack('cross_slash_wave');
    expect(api.getState().boss.currentAttack).toBe('cross_slash_wave');
    expect(api.getState().boss.attackTelegraphActive).toBe(true);

    // setBossPosture(0) breaks posture immediately
    api.setBossPosture(0);
    expect(api.getState().boss.staggered).toBe(true);

    // Spend resources & pause, then restartTrial() resets everything
    h.combat.hp = 350;
    h.combat.shield = 0;
    h.combat.qi = 10;
    h.tick(0.05, idleInput({ skill1Pressed: true }));
    h.gsm.setPaused(true);
    expect(h.gsm.paused).toBe(true);

    h.gsm.restartTrial();
    const resetSnap = api.getState();
    expect(resetSnap.phase).toBe('CINEMATIC_INTRO');
    expect(resetSnap.paused).toBe(false);
    expect(resetSnap.elapsedCombatSeconds).toBe(0);
    expect(resetSnap.player.hp).toBe(1_000);
    expect(resetSnap.player.shield).toBe(250);
    expect(resetSnap.player.qi).toBe(100);
    expect(resetSnap.player.skillCooldowns.skill1).toBe(0);
    expect(resetSnap.boss.hp).toBe(40_000);
    expect(resetSnap.boss.posture).toBe(1_000);
    expect(resetSnap.boss.staggered).toBe(false);
    expect(resetSnap.stats.totalDamageDealt).toBe(0);
    expect(resetSnap.stats.postureBreaks).toBe(0);
    expect(h.arenaFx.reset).toHaveBeenCalled();
    expect(h.vfxFx.reset).toHaveBeenCalled();

    const countBeforeUnsub = received.length;
    unsubscribe();
    h.tick(0.05);
    expect(received.length).toBe(countBeforeUnsub);

    h.cleanup();
  });

  it('unpauses cleanly when GameStateMachine.skipCinematic() is called while paused === true during CINEMATIC_FINISHER', () => {
    const h = createStateMachineHarness();
    const api = h.bridge.install();

    h.gsm.startTrial();
    h.gsm.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_1');

    api.setBossHp(22_000);
    expect(h.gsm.phase).toBe('CINEMATIC_TRANSITION');
    h.gsm.skipCinematic();
    expect(h.gsm.phase).toBe('PHASE_2');

    api.setBossHp(0);
    expect(h.gsm.phase).toBe('CINEMATIC_FINISHER');

    h.gsm.setPaused(true);
    expect(h.gsm.paused).toBe(true);
    expect(h.timeScaleSystem.paused).toBe(true);
    expect(h.audioFx.isPaused()).toBe(true);

    h.gsm.skipCinematic();
    expect(h.gsm.phase).toBe('VICTORY');
    expect(h.gsm.paused).toBe(false);
    expect(h.timeScaleSystem.paused).toBe(false);
    expect(h.audioFx.isPaused()).toBe(false);
    expect(api.getState().phase).toBe('VICTORY');
    expect(api.getState().paused).toBe(false);

    h.tick(0.05);
    expect(h.gsm.phase).toBe('VICTORY');
    expect(h.gsm.paused).toBe(false);

    h.cleanup();
  });
});

// ===========================================================================
// 4. AudioManager
// ===========================================================================
describe('AudioManager', () => {
  it('starts locked with zero errors before user gesture and decodes all 21 manifest keys via .slice(0) on unlock()', async () => {
    const mockCtx = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = mockCtx.MockAudioContext;

    const { provider } = createAudioBufferProvider();
    const audio = new AudioManager(provider);

    expect(audio.getState()).toEqual({
      unlocked: false,
      muted: false,
      activeBgmState: 'title',
      lastSfx: null,
      errorCount: 0,
    });

    // Pre-unlock playSfx records lastSfx without creating AudioContext or errors
    audio.playSfx('ui_click');
    expect(mockCtx.getContextInstances()).toBe(0);
    expect(audio.getState().lastSfx).toBe('ui_click');
    expect(audio.getState().errorCount).toBe(0);

    await audio.unlock();

    expect(mockCtx.getContextInstances()).toBe(1);
    expect(mockCtx.decodeCalls).toHaveLength(21);
    // Verify ArrayBuffers passed to decodeAudioData were cloned (.slice(0))
    for (const rawBuf of provider.getBundle().audioBuffers.values()) {
      expect(mockCtx.decodeCalls.some((c) => c.buffer === rawBuf)).toBe(false);
    }
    expect(audio.getState().unlocked).toBe(true);
    expect(audio.getState().errorCount).toBe(0);

    audio.dispose();
    expect(mockCtx.isClosed()).toBe(true);
  });

  it('falls back cleanly to procedural buffer with errorCount === 0 when decodeAudioData rejects (e.g. sfx_boss_roar.m4a)', async () => {
    const mockCtx = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
      rejectKeys: new Set(['sfx_boss_roar']),
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = mockCtx.MockAudioContext;

    const { provider } = createAudioBufferProvider();
    const audio = new AudioManager(provider);

    await audio.unlock();
    expect(audio.getState().unlocked).toBe(true);
    expect(audio.getState().errorCount).toBe(0);

    audio.playSfx('boss_roar');
    expect(audio.getState().lastSfx).toBe('boss_roar');
    expect(audio.getState().errorCount).toBe(0);
    expect(mockCtx.createdSources.some((s) => s.started)).toBe(true);

    audio.dispose();
  });

  it('maps all 7 GamePhase values to BgmState, sweeps Bullet-Time BiquadFilterNode, persists mute, and ducks on pause', async () => {
    const mockCtx = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = mockCtx.MockAudioContext;

    const { provider } = createAudioBufferProvider();
    const audio = new AudioManager(provider);
    await audio.unlock();

    const expectedMappings: ReadonlyArray<[GamePhase, string]> = [
      ['TITLE', 'title'],
      ['CINEMATIC_INTRO', 'intro'],
      ['PHASE_1', 'phase1'],
      ['CINEMATIC_TRANSITION', 'transition'],
      ['PHASE_2', 'phase2'],
      ['CINEMATIC_FINISHER', 'finisher'],
      ['VICTORY', 'victory'],
    ];

    for (const [phase, expectedBgm] of expectedMappings) {
      audio.setBgmState(phase);
      expect(audio.getState().activeBgmState).toBe(expectedBgm);
    }

    // Bullet-Time low-pass filter sweep (650 <-> 20000)
    expect(mockCtx.createdFilters).toHaveLength(1);
    const btFilter = mockCtx.createdFilters[0]!;
    expect(btFilter.type).toBe('lowpass');
    expect(btFilter.frequency.value).toBe(20000);

    audio.setBulletTimeFilter(true);
    expect(btFilter.frequency.value).toBe(650);
    audio.setBulletTimeFilter(false);
    expect(btFilter.frequency.value).toBe(20000);

    // Master gain is index 4 in buildAudioGraph (slotA, slotB, bgmDuck, sfxGain, masterGain)
    const bgmDuckGain = mockCtx.createdGains[2]!;
    const masterGain = mockCtx.createdGains[4]!;

    // Mute persistence across phase transitions
    audio.setMuted(true);
    expect(audio.getState().muted).toBe(true);
    expect(masterGain.gain.value).toBe(0);

    audio.setBgmState('PHASE_2');
    audio.setBgmState('VICTORY');
    expect(audio.getState().muted).toBe(true);
    expect(masterGain.gain.value).toBe(0);

    audio.setMuted(false);
    audio.setMasterVolume(0.6);
    expect(audio.getMasterVolume()).toBeCloseTo(0.6, 5);
    expect(masterGain.gain.value).toBeCloseTo(0.6, 5);

    // Pause ducking (0.25 <-> 1.0)
    expect(bgmDuckGain.gain.value).toBe(1.0);
    audio.setPaused(true);
    expect(bgmDuckGain.gain.value).toBe(0.25);
    audio.setPaused(false);
    expect(bgmDuckGain.gain.value).toBe(1.0);

    audio.dispose();
  });

  it('handles rapid 20-SFX burst with voice-cap eviction and per-ID throttling while keeping errorCount === 0', async () => {
    const mockCtx = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = mockCtx.MockAudioContext;

    const { provider } = createAudioBufferProvider();
    const audio = new AudioManager(provider);
    await audio.unlock();

    const sourcesBeforeSfx = mockCtx.createdSources.length;

    // Firing 20 distinct SFX IDs rapidly exceeds the 16-voice cap and evicts oldest voices cleanly
    for (let i = 0; i < 20; i += 1) {
      audio.playSfx(ALL_24_SFX_IDS[i]!);
    }

    const sfxSources = mockCtx.createdSources.slice(sourcesBeforeSfx);
    expect(sfxSources).toHaveLength(20);
    const stoppedCount = sfxSources.filter((s) => s.stopped).length;
    expect(stoppedCount).toBe(4); // 20 - 16 = 4 oldest voices evicted
    expect(audio.getState().errorCount).toBe(0);

    // Same-ID rapid burst within 20ms is throttled without errors
    const countBeforeRepeat = mockCtx.createdSources.length;
    audio.playSfx('ui_click');
    audio.playSfx('ui_click');
    audio.playSfx('ui_click');
    expect(mockCtx.createdSources.length - countBeforeRepeat).toBe(1);
    expect(audio.getState().errorCount).toBe(0);

    audio.dispose();
  });

  it('recovers when first ctx.resume() rejects (second unlock() decodes all 21 keys and spawns BGM/SFX sources) and closes cleanly with 0 graph nodes if disposed during pending resume()', async () => {
    // 1. First ctx.resume() rejects, second ctx.resume() succeeds
    const retryMock = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
      onResume: async (instanceIndex, ctx) => {
        if (instanceIndex === 1) {
          throw new Error('NotAllowedError: user gesture required');
        }
        ctx.state = 'running';
      },
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = retryMock.MockAudioContext;

    const { provider } = createAudioBufferProvider();
    const audioRetry = new AudioManager(provider);

    await audioRetry.unlock();
    expect(audioRetry.getState().unlocked).toBe(false);
    expect(retryMock.createdContexts).toHaveLength(1);
    expect(retryMock.createdContexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(retryMock.createdContexts[0]!.state).toBe('closed');
    expect(retryMock.createdGains).toHaveLength(0);
    expect(retryMock.createdFilters).toHaveLength(0);
    expect(retryMock.decodeCalls).toHaveLength(0);

    // Second unlock() recovers cleanly
    await audioRetry.unlock();
    expect(audioRetry.getState().unlocked).toBe(true);
    expect(retryMock.createdContexts).toHaveLength(2);
    expect(retryMock.decodeCalls).toHaveLength(21);
    expect(retryMock.createdGains.length).toBeGreaterThan(0);
    expect(retryMock.createdFilters).toHaveLength(1);
    expect(retryMock.createdSources).toHaveLength(1);
    expect(retryMock.createdSources[0]!.started).toBe(true);

    const sourcesBeforeActions = retryMock.createdSources.length;
    audioRetry.setBgmState('PHASE_2');
    audioRetry.playSfx('sword_slash_1');
    const spawnedSources = retryMock.createdSources.slice(sourcesBeforeActions);
    expect(spawnedSources).toHaveLength(2);
    expect(spawnedSources.every((s) => s.started)).toBe(true);

    audioRetry.dispose();
    expect(retryMock.createdContexts[1]!.close).toHaveBeenCalledTimes(1);
    expect(retryMock.createdContexts[1]!.state).toBe('closed');

    // 2. dispose() while ctx.resume() is pending closes context cleanly with 0 graph nodes
    let resolvePendingResume!: () => void;
    const pendingMock = createMockAudioContextSetup({
      rawKeyOrder: [...ALL_21_AUDIO_KEYS],
      onResume: () =>
        new Promise<void>((resolve) => {
          resolvePendingResume = resolve;
        }),
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = pendingMock.MockAudioContext;

    const audioPending = new AudioManager(provider);
    const unlockPromise = audioPending.unlock();

    // Yield one microtask so constructor + resume() have been invoked
    await Promise.resolve();
    expect(pendingMock.createdContexts).toHaveLength(1);
    expect(pendingMock.createdGains).toHaveLength(0);
    expect(pendingMock.createdFilters).toHaveLength(0);

    audioPending.dispose();
    resolvePendingResume();
    await unlockPromise;

    expect(audioPending.getState().unlocked).toBe(false);
    expect(pendingMock.createdGains).toHaveLength(0);
    expect(pendingMock.createdFilters).toHaveLength(0);
    expect(pendingMock.createdSources).toHaveLength(0);
    expect(pendingMock.decodeCalls).toHaveLength(0);
    expect(pendingMock.createdContexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(pendingMock.createdContexts[0]!.state).toBe('closed');
  });
});
