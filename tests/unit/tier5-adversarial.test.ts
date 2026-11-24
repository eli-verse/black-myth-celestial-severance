import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager, type AudioBufferProvider } from '../../src/audio/AudioManager.ts';
import { CombatSystem, type PlayerInputFrame } from '../../src/combat/CombatSystem.ts';
import { GameStateMachine } from '../../src/combat/GameStateMachine.ts';
import { DebugBridge } from '../../src/debug/DebugBridge.ts';
import { AssetLoader, assertLocalAssetPath } from '../../src/engine/AssetLoader.ts';
import { RendererSystem } from '../../src/engine/RendererSystem.ts';
import { TimeScaleSystem } from '../../src/engine/TimeScaleSystem.ts';
import { AnimationRig } from '../../src/entities/AnimationRig.ts';
import { BOSS_CLIPS, BossEntity } from '../../src/entities/BossEntity.ts';
import { PLAYER_CLIPS, PlayerEntity } from '../../src/entities/PlayerEntity.ts';
import { ArenaScene } from '../../src/scene/ArenaScene.ts';
import { AtmosphereController } from '../../src/scene/AtmosphereController.ts';
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
import { HudOverlay } from '../../src/ui/HudOverlay.ts';
import { MenuScreens } from '../../src/ui/MenuScreens.ts';
import { VfxManager } from '../../src/vfx/VfxManager.ts';

// ---------------------------------------------------------------------------
// Shared Pure-TypeScript Test Helpers
// ---------------------------------------------------------------------------

function makeClip(name: string, duration = 0.8): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack('.position', [0, duration], [0, 0, 0, 0, 0, 0]);
  return new THREE.AnimationClip(name, duration, [track]);
}

function createPlayerFixture(options?: {
  omitHandBone?: boolean;
  onError?: (msg: string) => void;
}) {
  const model = new THREE.Group();
  const spine = new THREE.Bone();
  spine.name = 'spine_01';
  if (!options?.omitHandBone) {
    const handR = new THREE.Bone();
    handR.name = 'hand_r';
    spine.add(handR);
  }
  model.add(spine);

  const geom = new THREE.BoxGeometry(0.5, 1.6, 0.3);
  const mat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  model.add(new THREE.Mesh(geom, mat));

  const weaponModel = new THREE.Group();
  weaponModel.add(new THREE.Mesh(geom, mat));

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
      geom.dispose();
      mat.dispose();
    },
  };
}

function createBossFixture(options?: {
  omitHandBone?: boolean;
  onError?: (msg: string) => void;
}) {
  const model = new THREE.Group();
  if (!options?.omitHandBone) {
    const handBone = new THREE.Bone();
    handBone.name = 'handslot.r';
    model.add(handBone);
  }

  const geom = new THREE.BoxGeometry(1.2, 2.2, 0.8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  model.add(new THREE.Mesh(geom, mat));

  const weaponModel = new THREE.Group();
  weaponModel.add(new THREE.Mesh(geom, mat));

  const clipNames = Array.from(
    new Set([
      ...BOSS_CLIPS.idle,
      ...BOSS_CLIPS.walk,
      ...BOSS_CLIPS.run,
      ...BOSS_CLIPS.intro,
      ...BOSS_CLIPS.transition,
      ...BOSS_CLIPS.stagger,
      ...BOSS_CLIPS.death,
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
      geom.dispose();
      mat.dispose();
    },
  };
}

function createMockArena(): {
  arena: ArenaInterface;
  setPhaseIntensity: ReturnType<typeof vi.fn>;
  triggerLightningStrike: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
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

  const audio: AudioInterface & {
    setPaused: (p: boolean) => void;
    getMasterVolume: () => number;
  } = {
    unlock: vi.fn(async () => {
      unlocked = true;
    }),
    setBgmState: vi.fn((phase: GamePhase) => {
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
    const effectiveWorldDt = combat.skill3Active ? 0 : step.worldDt;
    bossFx.boss.update(
      effectiveWorldDt,
      step.rawDt,
      combatPhase,
      playerFx.player.position,
      vfxFx.vfx,
      combat.getBossTickCallbacks(),
    );
    combat.postBossTick(combatPhase);
    return step;
  };

  const stepDuration = (totalSeconds: number, stepSize = 0.05, combatPhase: 1 | 2 = 1) => {
    const steps = Math.round(totalSeconds / stepSize);
    for (let i = 0; i < steps; i += 1) {
      stepFrame(stepSize, idleInput(), combatPhase);
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

  const tick = (dt = 0.05, input: PlayerInputFrame = idleInput()) => {
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

// ---------------------------------------------------------------------------
// DOM & Window Mocks for UI & DebugBridge Tests
// ---------------------------------------------------------------------------

type MockEventListener = (event: { type: string; target: unknown }) => void;

class MockElement {
  readonly tagName: string;
  id = '';
  className = '';
  hidden = false;
  type = '';
  min = '';
  max = '';
  step = '';
  value = '';
  parentNode: MockElement | null = null;
  readonly children: MockElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  private _textContent = '';
  private readonly listeners = new Map<string, Set<MockEventListener>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this._textContent;
    }
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this._textContent = String(value ?? '');
    if (this.children.length > 0) {
      this.children.length = 0;
    }
  }

  appendChild(child: MockElement): MockElement {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'type') this.type = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: MockEventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: MockEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string }): boolean {
    const payload = { type: event.type, target: this };
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(payload);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  blur(): void {
    this.dispatchEvent({ type: 'blur' });
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class MockDocument {
  readonly body = new MockElement('body');
  createElement(tag: string): MockElement {
    return new MockElement(tag);
  }
}

function createMockWindow(search = '') {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  return {
    __GAME_DEBUG__: undefined as unknown,
    location: { search },
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener(type: string, listener: (ev: unknown) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: (ev: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, ev: unknown = { type }) {
      for (const listener of listeners.get(type) ?? []) {
        listener(ev);
      }
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function walkElements(root: MockElement): MockElement[] {
  const result: MockElement[] = [root];
  for (const child of root.children) {
    result.push(...walkElements(child));
  }
  return result;
}

function findByClass(root: MockElement, classToken: string): MockElement[] {
  return walkElements(root).filter((el) => el.className.split(/\s+/).includes(classToken));
}

function makeHudSnapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  const base: HudSnapshot = {
    phase: 'PHASE_1',
    paused: false,
    pointerLocked: false,
    rendererBackend: 'webgpu',
    testMode: true,
    cinematicSkippable: false,
    banner: null,
    boss: {
      visible: true,
      name: UI_COPY.BOSS_NAME,
      hp: 32_000,
      maxHp: 40_000,
      hpRatio: 0.8,
      posture: 650,
      maxPosture: 1_000,
      postureRatio: 0.65,
      staggered: false,
      staggerRemaining: 0,
    },
    player: {
      visible: true,
      hp: 900,
      maxHp: 1_000,
      hpRatio: 0.9,
      shield: 200,
      maxShield: 250,
      shieldRatio: 0.8,
      qi: 100,
      maxQi: 100,
      qiRatio: 1.0,
      comboCount: 0,
      comboTimerRatio: 0,
      bulletTimeActive: false,
      bulletTimeRemaining: 0,
      skill3Active: false,
      lotusWardReady: true,
      lotusWardCooldown: 0,
    },
    skills: [
      {
        id: 'dodge',
        keyLabel: 'SPACE',
        name: UI_COPY.SKILL_DODGE_NAME,
        cooldownRemaining: 0,
        cooldownTotal: 0.77,
        ready: true,
        active: false,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill1',
        keyLabel: '1',
        name: UI_COPY.SKILL_1_NAME,
        cooldownRemaining: 0,
        cooldownTotal: 6.0,
        ready: true,
        active: false,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill2',
        keyLabel: '2',
        name: UI_COPY.SKILL_2_NAME,
        cooldownRemaining: 0,
        cooldownTotal: 10.0,
        ready: true,
        active: false,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill3',
        keyLabel: '3',
        name: UI_COPY.SKILL_3_NAME,
        cooldownRemaining: 0,
        cooldownTotal: 20.0,
        ready: true,
        active: false,
        qiRequired: 50,
        qiSufficient: true,
      },
    ],
    callouts: [],
    audio: {
      unlocked: true,
      muted: false,
      masterVolume: 0.85,
    },
    stats: {
      clearTimeSeconds: 120,
      totalDamageDealt: 40_000,
      damageTaken: 100,
      perfectDodges: 3,
      postureBreaks: 2,
      maxCombo: 12,
      rank: 'SSS',
    },
  };

  return {
    ...base,
    ...overrides,
    boss: { ...base.boss, ...(overrides.boss ?? {}) },
    player: { ...base.player, ...(overrides.player ?? {}) },
    audio: { ...base.audio, ...(overrides.audio ?? {}) },
    stats: { ...base.stats, ...(overrides.stats ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Global Cleanup
// ---------------------------------------------------------------------------

const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
const originalWebkitAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'webkitAudioContext');
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;

  if (originalAudioContext) {
    Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
  } else {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
  }

  if (originalWebkitAudioContext) {
    Object.defineProperty(globalThis, 'webkitAudioContext', originalWebkitAudioContext);
  } else {
    delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
  }

  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
  } else {
    delete (globalThis as { document?: unknown }).document;
  }

  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

// ===========================================================================
// Partition A Adversarial Tests (Combat, State Machine, Entities, Audio, Engine)
// ===========================================================================

describe('Tier 5 Adversarial — CombatSystem & GameStateMachine', () => {
  it('enforces exact simultaneous multi-input priority: Skill 3 > Dodge > Skill 2 > Skill 1 > Attack', () => {
    const h = createCombatHarness();
    h.combat.qi = 100;

    // 1. All 5 pressed simultaneously -> only Skill 3 activates
    h.stepFrame(
      0.05,
      idleInput({
        attackPressed: true,
        dodgePressed: true,
        skill1Pressed: true,
        skill2Pressed: true,
        skill3Pressed: true,
      }),
    );
    let snap = h.combat.getPlayerDebugSnapshot();
    expect(h.combat.skill3Active).toBe(true);
    expect(snap.isDodging).toBe(false);
    expect(snap.skillCooldowns.skill1).toBe(0);
    expect(snap.skillCooldowns.skill2).toBe(0);
    expect(snap.comboStep).toBe(0);

    // Finish Skill 3 (now skill3Cooldown > 0)
    h.stepDuration(2.7, 0.05);
    expect(h.combat.skill3Active).toBe(false);

    // 2. Press attack + dodge + skill1 + skill2 while Skill 3 on CD -> only Dodge activates
    h.stepFrame(
      0.05,
      idleInput({
        attackPressed: true,
        dodgePressed: true,
        skill1Pressed: true,
        skill2Pressed: true,
      }),
    );
    snap = h.combat.getPlayerDebugSnapshot();
    expect(snap.isDodging).toBe(true);
    expect(snap.skillCooldowns.skill1).toBe(0);
    expect(snap.skillCooldowns.skill2).toBe(0);
    expect(snap.comboStep).toBe(0);

    // Advance past dodge duration while dodgeCooldown is still > 0
    h.stepDuration(0.55, 0.05);
    expect(h.combat.getPlayerDebugSnapshot().isDodging).toBe(false);
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.dodge).toBeGreaterThan(0);

    // 3. Press attack + skill1 + skill2 while Dodge on CD -> only Skill 2 activates
    h.stepFrame(
      0.05,
      idleInput({
        attackPressed: true,
        skill1Pressed: true,
        skill2Pressed: true,
      }),
    );
    snap = h.combat.getPlayerDebugSnapshot();
    expect(snap.skillCooldowns.skill2).toBeGreaterThan(0);
    expect(snap.skillCooldowns.skill1).toBe(0);
    expect(snap.comboStep).toBe(0);

    // Finish Skill 2 (now skill2Cooldown > 0, wait dodge CD too)
    h.stepDuration(0.5, 0.05);

    // 4. Press attack + skill1 while Skill 2 on CD -> only Skill 1 activates
    h.stepFrame(
      0.05,
      idleInput({
        attackPressed: true,
        skill1Pressed: true,
      }),
    );
    snap = h.combat.getPlayerDebugSnapshot();
    expect(snap.skillCooldowns.skill1).toBeGreaterThan(0);
    expect(snap.comboStep).toBe(0);

    h.cleanup();
  });

  it('handles Skill 2 -> Skill 3 windup buffering, dodge override, and prevents wasting Skill 3 across 55% threshold (Bug 1)', () => {
    // 1. Buffering Skill 3 during Skill 2 windup fires Skill 3 right after Skill 2 hit lands
    const h = createCombatHarness();
    h.combat.qi = 100;
    h.stepFrame(0.05, idleInput({ skill2Pressed: true }));
    expect(h.combat.skill3Active).toBe(false);

    // During 0..0.14s windup, press skill3 -> buffered, does NOT start yet
    h.stepFrame(0.05, idleInput({ skill3Pressed: true }));
    expect(h.combat.skill3Active).toBe(false);
    expect(h.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);

    // Advance past 0.14s windup -> Skill 2 hit (780 DMG) lands AND Skill 3 starts
    h.stepFrame(0.05, idleInput());
    expect(h.boss.hp).toBe(COMBAT_TUNING.bossMaxHp - COMBAT_TUNING.skill2Damage);
    expect(h.combat.skill3Active).toBe(true);
    h.cleanup();

    // 2. Pressing Dodge during Skill 2 windup cancels Skill 2 AND clears skill2BufferedSkill3
    const hDodge = createCombatHarness();
    hDodge.combat.qi = 100;
    hDodge.stepFrame(0.05, idleInput({ skill2Pressed: true }));
    hDodge.stepFrame(0.03, idleInput({ skill3Pressed: true }));
    hDodge.stepFrame(0.03, idleInput({ dodgePressed: true }));
    expect(hDodge.combat.getPlayerDebugSnapshot().isDodging).toBe(true);
    hDodge.stepDuration(0.6, 0.05);
    expect(hDodge.combat.skill3Active).toBe(false);
    expect(hDodge.combat.qi).toBe(100);
    hDodge.cleanup();

    // 3. Bug 1 regression: Skill 2 crossing 22,000 HP floor in PHASE_1 must NOT consume Skill 3 Qi/CD
    const sm = createStateMachineHarness();
    const api = sm.bridge.install();
    sm.gsm.startTrial();
    api.skipCinematic();
    sm.player.position.set(0, 0, -1.5);
    api.setBossHp(22_200);
    sm.combat.qi = 100;

    sm.tick(0.05, idleInput({ skill2Pressed: true }));
    sm.tick(0.05, idleInput({ skill3Pressed: true }));
    sm.tick(0.05, idleInput());

    expect(sm.gsm.phase).toBe('CINEMATIC_TRANSITION');
    expect(sm.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    expect(sm.combat.skill3Active).toBe(false);
    expect(sm.combat.qi).toBe(100);
    expect(sm.combat.getPlayerDebugSnapshot().skillCooldowns.skill3).toBe(0);
    sm.cleanup();
  });

  it('enforces Skill 1 tail cancel into Skill 2 boundary (skill1Elapsed >= 0.3s)', () => {
    const h = createCombatHarness();
    h.stepFrame(0.05, idleInput({ skill1Pressed: true })); // elapsed = 0.05
    h.stepDuration(0.15, 0.05); // elapsed = 0.20

    // At 0.25s < 0.30s -> Skill 2 is blocked
    h.stepFrame(0.05, idleInput({ skill2Pressed: true })); // elapsed = 0.25
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.skill2).toBe(0);

    // At 0.30s >= 0.30s -> Skill 2 starts immediately and all 4 Skill 1 hits (960 DMG) landed
    h.stepFrame(0.05, idleInput({ skill2Pressed: true })); // elapsed = 0.30 before processActionInputs?
    // processActionInputs runs before updateSkill1, so elapsed was 0.25 at processActionInputs -> 0.30 after updateSkill1.
    // Now at elapsed = 0.30, pressing skill2 cancels Skill 1 immediately:
    if (h.combat.getPlayerDebugSnapshot().skillCooldowns.skill2 === 0) {
      h.stepFrame(0.05, idleInput({ skill2Pressed: true }));
    }
    expect(h.combat.getPlayerDebugSnapshot().skillCooldowns.skill2).toBeGreaterThan(0);
    expect(COMBAT_TUNING.bossMaxHp - h.boss.hp).toBe(960);

    h.cleanup();
  });

  it('resets combo sequence when dodging out of combo Step 1 (Bug 2 regression)', () => {
    const h = createCombatHarness();

    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepFrame(0.05, idleInput()); // Hit 1 delivered (160 DMG)
    expect(COMBAT_TUNING.bossMaxHp - h.boss.hp).toBe(160);

    // Cancel combo with Dodge
    h.stepFrame(0.05, idleInput({ dodgePressed: true, moveZ: -1 }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(0);

    // Wait 0.60s for dodge to complete, move back to melee range, and attack again
    h.stepDuration(0.6, 0.05);
    h.player.position.set(0, 0, -1.5);
    const hpBefore = h.boss.hp;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    expect(h.combat.getPlayerDebugSnapshot().comboStep).toBe(1);
    h.stepDuration(0.1, 0.05);
    expect(hpBefore - h.boss.hp).toBe(160); // Step 1 (160), NOT Step 2 (190)

    h.cleanup();
  });

  it('enforces Immortal Lotus Ward 30s cooldown, clamps lethal hits to hp=1 during cooldown, and allows reuse after 30s', () => {
    const h = createCombatHarness();
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);

    // 1. Trigger Lotus Ward once
    h.combat.shield = 0;
    h.combat.hp = 50;
    const bossImpact = h.combat.getBossTickCallbacks().onAttackImpact!;
    const leapSpec = COMBAT_TUNING.bossAttacks.find((a) => a.id === 'cataclysmic_leap_slam')!;
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    bossImpact(leapSpec, h.boss.position.clone(), new THREE.Vector3(0, 0, 1));
    expect(h.combat.hp).toBe(350);
    expect(h.combat.isPlayerInvulnerable()).toBe(true);
    expect(h.combat.getHudSustainState().lotusWardReady).toBe(false);
    expect(h.combat.getHudSustainState().lotusWardCooldown).toBeCloseTo(30, 3);
    expect(h.audioFx.audio.getState?.().lastSfx).toBe('lotus_ward');

    // 2. Move boss out of melee range while advancing 1.6s so AI doesn't kill player early
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.stepDuration(1.6, 0.05);
    expect(h.combat.isPlayerInvulnerable()).toBe(false);
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);
    h.combat.shield = 0;
    h.combat.hp = 80;
    h.audioFx.playedSfx.length = 0;

    // Deal lethal damage while Lotus Ward is on cooldown -> clamps to hp = 1, no lotus_ward SFX
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    bossImpact(leapSpec, h.boss.position.clone(), new THREE.Vector3(0, 0, 1));
    expect(h.combat.hp).toBe(1);
    expect(h.audioFx.playedSfx).not.toContain('lotus_ward');

    // 3. Move apart and advance 30.0s so Lotus Ward comes off cooldown -> triggers a second time
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.stepDuration(30.0, 0.05);
    expect(h.combat.getHudSustainState().lotusWardReady).toBe(true);
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);
    h.combat.shield = 0;
    h.combat.hp = 40;
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    bossImpact(leapSpec, h.boss.position.clone(), new THREE.Vector3(0, 0, 1));
    expect(h.combat.hp).toBe(350);
    expect(h.audioFx.audio.getState?.().lastSfx).toBe('lotus_ward');

    h.cleanup();
  });

  it('resets shield regen delay on subsequent hit while continuous <500 HP Lotus regen heals regardless of shield delay', () => {
    const h = createCombatHarness();
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);
    const bossImpact = h.combat.getBossTickCallbacks().onAttackImpact!;
    const spec = COMBAT_TUNING.bossAttacks.find((a) => a.id === 'cataclysmic_leap_slam')!; // 120 DMG

    // First hit: shield 250 -> 130, delay = 3.5s
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    bossImpact(spec, h.boss.position.clone(), new THREE.Vector3(0, 0, 1));
    expect(h.combat.shield).toBe(130);

    // Move apart and advance 3.0s (< 3.5s) -> still 130 shield
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.stepDuration(3.0, 0.05);
    expect(h.combat.shield).toBe(130);

    // Second hit resets delay back to 3.5s and drops shield to 10
    h.boss.position.set(0, 0, -5);
    h.player.position.set(0, 0, -1.5);
    h.boss.triggerTestAttack('cataclysmic_leap_slam', h.player.position, h.vfxFx.vfx);
    bossImpact(spec, h.boss.position.clone(), new THREE.Vector3(0, 0, 1));
    expect(h.combat.shield).toBe(10);

    // Move apart, drop HP to 300 (< 500) and advance 3.0s -> shield still 10 (delay reset), HP healed by 3.0 * 15 = +45
    h.boss.position.set(0, 0, -22);
    h.player.position.set(0, 0, 22);
    h.combat.hp = 300;
    h.stepDuration(3.0, 0.05);
    expect(h.combat.shield).toBe(10);
    expect(h.combat.hp).toBeCloseTo(345, 2);

    // Advance 1.0s more (total 4.0s since 2nd hit -> 0.5s of 45/s shield regen = +22.5)
    h.stepDuration(1.0, 0.05);
    expect(h.combat.shield).toBeCloseTo(32.5, 2);
    expect(h.combat.hp).toBeCloseTo(360, 2);

    // Advance long enough to hit exact 500 low-HP cap
    h.stepDuration(12.0, 0.05);
    expect(h.combat.hp).toBe(500);

    h.cleanup();
  });

  it('emits Awakening Ready callout once upon reaching 50 Qi and keeps vitals finite under NaN/negative/Infinity dt & multiplier', () => {
    const h = createCombatHarness();
    h.combat.qi = 100;

    // Drain Qi below 50 via Skill 3
    h.stepFrame(0.05, idleInput({ skill3Pressed: true }));
    expect(h.combat.qi).toBe(50);
    h.combat.qi = 30;
    h.stepDuration(20.5, 0.05); // finish Skill 3 and its 20s cooldown
    h.callouts.length = 0;

    // Gain Qi back to >= 50 via basic combo hits -> Awakening Ready fires exactly once
    h.combat.qi = 45;
    h.stepFrame(0.05, idleInput({ attackPressed: true }));
    h.stepDuration(0.15, 0.05);
    expect(h.combat.qi).toBeGreaterThanOrEqual(50);
    expect(h.callouts.filter((c) => c.text === UI_COPY.CALLOUT_AWAKENING_READY)).toHaveLength(1);

    // Subsequent frames while ready do NOT re-emit Awakening Ready
    h.stepDuration(0.5, 0.05);
    expect(h.callouts.filter((c) => c.text === UI_COPY.CALLOUT_AWAKENING_READY)).toHaveLength(1);

    // Invalid multipliers are ignored
    h.combat.setPlayerDamageMultiplier(2.5);
    h.combat.setPlayerDamageMultiplier(Number.NaN);
    h.combat.setPlayerDamageMultiplier(-2);
    h.combat.setPlayerDamageMultiplier(Number.POSITIVE_INFINITY);
    expect(h.combat.playerDamageMultiplier).toBe(2.5);

    // Non-finite / negative dt never corrupts vitals or cooldowns
    h.combat.update(Number.NaN, -1, Number.POSITIVE_INFINITY, h.camera, idleInput(), 1);
    const snap = h.combat.getPlayerDebugSnapshot();
    expect(Number.isFinite(snap.hp)).toBe(true);
    expect(Number.isFinite(snap.shield)).toBe(true);
    expect(Number.isFinite(snap.qi)).toBe(true);
    expect(snap.hp).toBeGreaterThan(0);

    h.cleanup();
  });

  it('aligns Skill 3 TimeScaleSystem and CombatSystem without 1-frame cast/expiration desync (Bug 7 regression)', () => {
    const sm = createStateMachineHarness();
    sm.gsm.startTrial();
    sm.gsm.skipCinematic();
    sm.player.position.set(0, 0, -1.5);
    sm.combat.qi = 100;

    // Cast frame (frame 1): Boss & Arena must freeze on cast frame, skill3Elapsed === 0, tssRemaining === 2.6
    sm.tick(0.05, idleInput({ skill3Pressed: true }));
    expect(sm.combat.skill3Active).toBe(true);
    expect(sm.combat.getSkill3Elapsed()).toBe(0);
    expect(sm.timeScaleSystem.skill3Active).toBe(true);
    expect(sm.timeScaleSystem.skill3Remaining).toBeCloseTo(2.6, 6);
    expect(sm.boss.aiState).toBe('IDLE');
    // Arena update received 0 worldDt on cast frame
    expect(sm.arenaFx.update.mock.calls.at(-1)?.[0]).toBe(0);

    // Advance 51 * 0.05s = 2.55s -> both still active
    sm.tickSeconds(2.55, 0.05);
    expect(sm.combat.skill3Active).toBe(true);
    expect(sm.timeScaleSystem.skill3Active).toBe(true);

    // Frame 53 (exact 2.60s) -> BOTH CombatSystem and TimeScaleSystem expire on the same frame and worldTimeScale restores to 1.0
    sm.tick(0.05, idleInput());
    expect(sm.combat.skill3Active).toBe(false);
    expect(sm.timeScaleSystem.skill3Active).toBe(false);
    expect(sm.timeScaleSystem.skill3Remaining).toBe(0);
    expect(sm.timeScaleSystem.worldTimeScale).toBe(1.0);
    expect(sm.bridge.install().getState().timeScale).toBe(1.0);

    sm.cleanup();
  });

  it('guards GameStateMachine phase/pause/dispose invariants, clears staggered in transition (Bug 3), unpauses on skip (C2 Bug 4), and clamps setBossHp in PHASE_2 (Bug 5 / C2 Bug 3)', () => {
    const sm = createStateMachineHarness();
    const api = sm.bridge.install();

    // TITLE: setPaused(true) ignored
    sm.gsm.setPaused(true);
    expect(sm.gsm.paused).toBe(false);

    // Start trial -> CINEMATIC_INTRO, pause, then skipCinematic() unpauses cleanly
    sm.gsm.startTrial();
    expect(sm.gsm.phase).toBe('CINEMATIC_INTRO');
    sm.gsm.startTrial(); // ignored outside TITLE
    expect(sm.gsm.phase).toBe('CINEMATIC_INTRO');

    sm.gsm.setPaused(true);
    expect(sm.gsm.paused).toBe(true);
    api.skipCinematic();
    expect(sm.gsm.phase).toBe('PHASE_1');
    expect(sm.gsm.paused).toBe(false);
    expect(sm.timeScaleSystem.paused).toBe(false);
    expect(sm.audioFx.isPaused()).toBe(false);

    // Bug 3 regression: staggered Boss entering CINEMATIC_TRANSITION clears staggered immediately
    api.setBossPosture(0);
    expect(sm.boss.staggered).toBe(true);
    api.setBossHp(22_000);
    expect(sm.gsm.phase).toBe('CINEMATIC_TRANSITION');
    expect(sm.boss.staggered).toBe(false);
    expect(sm.boss.staggerRemaining).toBe(0);

    // Advance CINEMATIC_TRANSITION with rawDt = 1.0 (clamped to 0.05s) and verify all 3 lightning strikes fire
    for (let i = 0; i < 105; i += 1) {
      sm.tick(1.0, idleInput());
      if (sm.gsm.phase === 'PHASE_2') break;
    }
    expect(sm.gsm.phase).toBe('PHASE_2');
    expect(sm.arenaFx.triggerLightningStrike).toHaveBeenCalledTimes(3);
    expect(sm.audioFx.playedSfx.filter((s) => s === 'boss_lightning')).toHaveLength(3);

    // Re-enter CINEMATIC_TRANSITION via restart -> PHASE_1 -> pause during transition -> skipCinematic() unpauses into PHASE_2
    sm.gsm.restartTrial();
    api.skipCinematic();
    api.setBossHp(22_000);
    expect(sm.gsm.phase).toBe('CINEMATIC_TRANSITION');
    sm.gsm.setPaused(true);
    api.skipCinematic();
    expect(sm.gsm.phase).toBe('PHASE_2');
    expect(sm.gsm.paused).toBe(false);
    expect(sm.timeScaleSystem.paused).toBe(false);
    expect(sm.audioFx.isPaused()).toBe(false);

    // Bug 5 + C2 Bug 3 regression: setBossHp(NaN / Infinity) ignored; PHASE_2 clamps to [0, 22_000]
    api.setBossHp(15_000);
    expect(sm.boss.hp).toBe(15_000);
    api.setBossHp(Number.NaN);
    api.setBossHp(Number.POSITIVE_INFINITY);
    api.setBossHp(Number.NEGATIVE_INFINITY);
    expect(sm.boss.hp).toBe(15_000);
    api.setBossHp(999_999);
    expect(sm.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);

    // Non-finite/negative update dt keeps elapsed timers & positions finite
    sm.gsm.update(Number.NaN, sm.camera, idleInput());
    sm.gsm.update(-0.5, sm.camera, idleInput());
    sm.gsm.update(Number.POSITIVE_INFINITY, sm.camera, idleInput());
    expect(Number.isFinite(sm.gsm.elapsedCombatSeconds)).toBe(true);
    expect(Number.isFinite(sm.camera.position.x)).toBe(true);

    // VICTORY: setPaused(true) ignored
    api.setBossHp(0);
    api.skipCinematic();
    expect(sm.gsm.phase).toBe('VICTORY');
    sm.gsm.setPaused(true);
    expect(sm.gsm.paused).toBe(false);

    // dispose() unsubscribes all HUD listeners and turns all methods into safe no-ops
    const listener = vi.fn();
    sm.gsm.subscribeHud(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    sm.gsm.dispose();
    sm.gsm.restartTrial();
    sm.gsm.skipCinematic();
    sm.gsm.setPaused(true);
    sm.gsm.update(0.05, sm.camera, idleInput());
    expect(listener).toHaveBeenCalledTimes(1);

    sm.cleanup();
  });
});

describe('Tier 5 Adversarial — BossEntity, PlayerEntity & AnimationRig', () => {
  it('evaluates Boss hitbox geometry accurately (arc/line/ring/NaN) and clamps heavenfall_pillars', () => {
    const bossFx = createBossFixture();
    const vfxFx = createMockVfx();
    const { boss } = bossFx;
    boss.enterCombatPhase(1);
    boss.position.set(0, 0, 0);

    // Arc attack: origin=(0,0,0), direction=(0,0,1)
    boss.triggerTestAttack('abyssal_sweep', { x: 0, y: 0, z: 5 }, vfxFx.vfx);
    expect(boss.evaluatePlayerInHitbox({ x: Number.NaN, y: 0, z: 0 })).toBe(false);
    expect(boss.evaluatePlayerInHitbox({ x: 0, y: 0, z: 0 })).toBe(true); // dist === 0
    expect(boss.evaluatePlayerInHitbox({ x: 0, y: 0, z: -3.0 })).toBe(false); // behind boss

    // Line attack: forward <= radius, lateral <= 1.7m
    boss.triggerTestAttack('phantom_thrust', { x: 0, y: 0, z: 5 }, vfxFx.vfx);
    expect(boss.evaluatePlayerInHitbox({ x: 1.5, y: 0, z: 4.0 })).toBe(true);
    expect(boss.evaluatePlayerInHitbox({ x: 2.5, y: 0, z: 4.0 })).toBe(false);

    // Ring attack
    boss.triggerTestAttack('shattered_earth_slam', { x: 0, y: 0, z: 3 }, vfxFx.vfx);
    expect(boss.evaluatePlayerInHitbox({ x: 4.0, y: 0, z: 0 })).toBe(true);
    expect(boss.evaluatePlayerInHitbox({ x: 12.0, y: 0, z: 0 })).toBe(false);

    // heavenfall_pillars clamps out-of-bounds and NaN playerPos inside arenaRadius - 0.8
    boss.triggerTestAttack('heavenfall_pillars', { x: 100, y: 0, z: 100 }, vfxFx.vfx);
    expect(Math.hypot(boss.activeAttack!.origin.x, boss.activeAttack!.origin.z)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius - 0.79,
    );
    boss.triggerTestAttack('heavenfall_pillars', { x: Number.NaN, y: 0, z: Number.POSITIVE_INFINITY }, vfxFx.vfx);
    expect(Number.isFinite(boss.activeAttack!.origin.x)).toBe(true);
    expect(Number.isFinite(boss.activeAttack!.origin.z)).toBe(true);

    // DEAD state ignores enterStagger and update movement/attacks
    boss.enterDead(vfxFx.vfx);
    expect(boss.aiState).toBe('DEAD');
    expect(boss.invulnerable).toBe(true);
    expect(boss.staggered).toBe(false);
    boss.enterStagger(vfxFx.vfx);
    expect(boss.aiState).toBe('DEAD');
    expect(boss.staggered).toBe(false);
    const posBefore = boss.position.clone();
    boss.update(0.5, 0.5, 1, { x: 0, y: 0, z: 10 }, vfxFx.vfx);
    expect(boss.position.distanceTo(posBefore)).toBe(0);
    expect(boss.activeAttack).toBeNull();

    // dispose() is idempotent and makes update()/reset() no-ops
    boss.dispose();
    boss.dispose();
    expect(() => boss.update(0.1, 0.1, 1, { x: 0, y: 0, z: 0 }, vfxFx.vfx)).not.toThrow();
    expect(() => boss.reset(vfxFx.vfx)).not.toThrow();

    bossFx.cleanup();
  });

  it('handles AnimationRig empty clips, non-finite options, missing bones, vertical camera basis, huge move vectors, and PlayerEntity dispose', () => {
    // 1. AnimationRig empty clips & invalid options & post-dispose
    const emptyGroup = new THREE.Group();
    const emptyRig = new AnimationRig(emptyGroup, []);
    expect(emptyRig.activeClipName).toBe('Idle');

    const validRig = new AnimationRig(emptyGroup, [makeClip('Sword_Idle', 0.5)], ['Sword_Idle']);
    expect(() =>
      validRig.play('Sword_Idle', { fadeSeconds: Number.NaN, timeScale: -1, forceRestart: true }),
    ).not.toThrow();
    validRig.dispose();
    validRig.dispose();
    expect(() => validRig.play('Sword_Idle')).not.toThrow();
    expect(() => validRig.update(0.05)).not.toThrow();
    emptyRig.dispose();

    // 2. Missing hand_r / handslot.r emit onError without throwing
    const playerErrors: string[] = [];
    const noHandPlayer = createPlayerFixture({
      omitHandBone: true,
      onError: (m) => playerErrors.push(m),
    });
    expect(playerErrors.length).toBeGreaterThan(0);

    const bossErrors: string[] = [];
    const noHandBoss = createBossFixture({
      omitHandBone: true,
      onError: (m) => bossErrors.push(m),
    });
    expect(bossErrors.length).toBeGreaterThan(0);
    noHandBoss.cleanup();

    // 3. Vertical camera basis fallback when looking straight down
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
    cam.position.set(0, 10, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const basis = noHandPlayer.player.getCameraBasisXZ(cam);
    expect(basis).toEqual({ forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 });

    // 4. Huge / non-finite move directions yield finite velocity & position
    noHandPlayer.player.setMoveDirection(1e308, 1e308, 8.5);
    expect(Number.isFinite(noHandPlayer.player.velocity.x)).toBe(true);
    expect(Number.isFinite(noHandPlayer.player.velocity.z)).toBe(true);
    noHandPlayer.player.setMoveDirection(Number.NaN, Number.POSITIVE_INFINITY, -5);
    expect(Number.isFinite(noHandPlayer.player.velocity.x)).toBe(true);
    expect(Number.isFinite(noHandPlayer.player.velocity.z)).toBe(true);
    noHandPlayer.player.update(0.05, 0.05);
    expect(Number.isFinite(noHandPlayer.player.position.x)).toBe(true);
    expect(Number.isFinite(noHandPlayer.player.position.z)).toBe(true);

    // 5. PlayerEntity.dispose() idempotency & post-dispose safety
    noHandPlayer.player.dispose();
    noHandPlayer.player.dispose();
    expect(() => noHandPlayer.player.update(0.05, 0.05)).not.toThrow();
    expect(() => noHandPlayer.player.updateCamera(cam, 0.05)).not.toThrow();
    expect(() => noHandPlayer.player.reset()).not.toThrow();
    noHandPlayer.cleanup();
  });
});

describe('Tier 5 Adversarial — TimeScaleSystem, AudioManager, AssetLoader & RendererSystem', () => {
  it('handles TimeScaleSystem invalid triggers, 3-way overlap priority, and immediate setPaused(false) scale restoration', () => {
    const tss = new TimeScaleSystem();

    // Invalid trigger values ignored
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      tss.triggerHitstop(bad);
      tss.triggerBulletTime(bad);
      tss.triggerSkill3TimeStop(bad);
    }
    expect(tss.hitstopRemaining).toBe(0);
    expect(tss.bulletTimeActive).toBe(false);
    expect(tss.skill3Active).toBe(false);
    expect(tss.worldTimeScale).toBe(1.0);

    // 3-way overlap: Bullet-Time -> Skill 3 -> Hitstop
    tss.triggerBulletTime(2.0);
    tss.triggerSkill3TimeStop(0.1);
    tss.triggerHitstop(50);

    const s1 = tss.update(0.05);
    expect(s1.worldTimeScale).toBe(0);
    expect(s1.playerTimeScale).toBe(0);
    expect(tss.skill3Remaining).toBeCloseTo(0.1, 6);
    expect(tss.bulletTimeRemaining).toBeCloseTo(2.0, 6);

    const s2 = tss.update(0.05);
    expect(s2.worldTimeScale).toBe(0);
    expect(s2.playerTimeScale).toBe(1.0);
    expect(tss.bulletTimeRemaining).toBeCloseTo(2.0, 6);

    const s3 = tss.update(0.05);
    expect(s3.worldTimeScale).toBe(0);
    expect(s3.playerTimeScale).toBe(1.0);
    expect(tss.skill3Active).toBe(false);
    // Bullet-time immediately restored as active scale
    expect(tss.worldTimeScale).toBe(0.25);

    const s4 = tss.update(0.05);
    expect(s4.worldTimeScale).toBe(0.25);

    // setPaused(true) -> setPaused(false) immediately restores 0.25 without update()
    tss.setPaused(true);
    expect(tss.worldTimeScale).toBe(0);
    tss.setPaused(false);
    expect(tss.worldTimeScale).toBe(0.25);
  });

  it('handles AudioManager missing/throwing AudioContext, suspended retry, post-dispose guards (Bug 6), pre-unlock config, fake-timer crossfade races, and minimal AudioParam', async () => {
    // 1. Missing AudioContext & webkitAudioContext
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
    const audioMissing = new AudioManager();
    await audioMissing.unlock();
    expect(audioMissing.getState()).toMatchObject({ unlocked: false, errorCount: 0 });

    // 2. Synchronous constructor throw + recovery on next unlock
    let shouldThrow = true;
    let resumeResultState: AudioContextState = 'suspended';
    const createdSources: Array<{
      loop: boolean;
      started: boolean;
      stopped: boolean;
      disconnected: boolean;
      onended: (() => void) | null;
      connect: (t: unknown) => unknown;
      disconnect: () => void;
      start: () => void;
      stop: () => void;
      playbackRate: { value: number };
      buffer: AudioBuffer | null;
    }> = [];
    const createdGains: Array<{
      gain: { value: number; setValueAtTime?: unknown; setTargetAtTime?: unknown; cancelScheduledValues?: unknown };
      connect: (t: unknown) => unknown;
      disconnect: () => void;
    }> = [];
    const createdFilters: Array<{
      type: string;
      frequency: { value: number };
      Q: { value: number };
      connect: (t: unknown) => unknown;
      disconnect: () => void;
    }> = [];
    let ctxCount = 0;

    class EdgeMockAudioContext {
      state: AudioContextState = 'suspended';
      sampleRate = 44100;
      currentTime = 0;
      destination = {};
      constructor() {
        if (shouldThrow) {
          throw new Error('Sync AudioContext blocked');
        }
        ctxCount += 1;
      }
      resume = vi.fn(async () => {
        this.state = resumeResultState;
      });
      close = vi.fn(async () => {
        this.state = 'closed';
      });
      createGain = vi.fn(() => {
        // Omit setTargetAtTime / cancelScheduledValues to exercise minimal AudioParam fallback!
        const node = {
          gain: { value: 1 },
          connect: vi.fn((t: unknown) => t),
          disconnect: vi.fn(),
        };
        createdGains.push(node);
        return node;
      });
      createBiquadFilter = vi.fn(() => {
        const filter = {
          type: 'lowpass',
          frequency: { value: 20000 },
          Q: { value: 0.707 },
          connect: vi.fn((t: unknown) => t),
          disconnect: vi.fn(),
        };
        createdFilters.push(filter);
        return filter;
      });
      createDynamicsCompressor = vi.fn(() => ({
        threshold: { value: -14 },
        knee: { value: 18 },
        ratio: { value: 4 },
        attack: { value: 0.003 },
        release: { value: 0.25 },
        connect: vi.fn((t: unknown) => t),
        disconnect: vi.fn(),
      }));
      createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => ({
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }));
      createBufferSource = vi.fn(() => {
        const src = {
          buffer: null as AudioBuffer | null,
          loop: false,
          playbackRate: { value: 1 },
          started: false,
          stopped: false,
          disconnected: false,
          onended: null as (() => void) | null,
          connect: vi.fn((t: unknown) => t),
          disconnect: vi.fn(() => {
            src.disconnected = true;
          }),
          start: vi.fn(() => {
            src.started = true;
          }),
          stop: vi.fn(() => {
            src.stopped = true;
          }),
        };
        createdSources.push(src);
        return src;
      });
      // Return 0-length buffer to exercise procedural fallback with errorCount === 0
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        length: 0,
        sampleRate: 44100,
        duration: 0,
        getChannelData: () => new Float32Array(0),
      }));
    }

    (globalThis as { AudioContext?: unknown }).AudioContext = EdgeMockAudioContext;

    const rawBuffers = new Map<string, ArrayBuffer>([
      ['bgm_phase1', new ArrayBuffer(0)], // 0-byte raw buffer
      ['sfx_sword_slash_1', new ArrayBuffer(8)], // length===0 decoded buffer
    ]);
    const provider: AudioBufferProvider = {
      getBundle: () => ({ audioBuffers: rawBuffers }),
    };

    const audio = new AudioManager(provider);

    // Pre-unlock configuration persistence
    audio.setMuted(true);
    audio.setMasterVolume(0.35);
    audio.setMasterVolume(-0.5); // clamps to 0 -> let's set back to 0.35 after checking clamping
    expect(audio.getMasterVolume()).toBe(0);
    audio.setMasterVolume(2.5);
    expect(audio.getMasterVolume()).toBe(1);
    audio.setMasterVolume(Number.NaN);
    audio.setMasterVolume(Number.POSITIVE_INFINITY);
    expect(audio.getMasterVolume()).toBe(1);
    audio.setMasterVolume(0.35);
    audio.setBulletTimeFilter(true);
    audio.setPaused(true);
    audio.setBgmState('PHASE_2');

    // Sync throw increments errorCount to 1, unlocked remains false
    await audio.unlock();
    expect(audio.getState()).toMatchObject({ unlocked: false, errorCount: 1 });

    // Recovery when constructor succeeds, but ctx stays 'suspended' -> unlocked MUST stay false (Bug 6)
    shouldThrow = false;
    resumeResultState = 'suspended';
    await audio.unlock();
    expect(ctxCount).toBe(1);
    expect(audio.getState().unlocked).toBe(false);

    // Next user gesture transitions ctx.state to 'running' -> concurrent unlock() calls reuse 1 context
    resumeResultState = 'running';
    await Promise.all([audio.unlock(), audio.unlock()]);
    expect(ctxCount).toBe(1);
    expect(audio.getState().unlocked).toBe(true);
    expect(audio.getState().errorCount).toBe(1); // zero new errors from empty buffers

    // Pre-unlock config applied to audio graph
    const bgmDuckGain = createdGains[2]!;
    const masterGain = createdGains[4]!;
    expect(masterGain.gain.value).toBe(0); // muted
    expect(createdFilters[0]!.frequency.value).toBe(650); // bullet-time active
    expect(bgmDuckGain.gain.value).toBe(0.25); // paused
    expect(audio.getState().activeBgmState).toBe('phase2');

    // Changing volume while muted keeps masterGain at 0 until unmuted
    audio.setMasterVolume(0.72);
    expect(masterGain.gain.value).toBe(0);
    audio.setMuted(false);
    expect(masterGain.gain.value).toBeCloseTo(0.72, 5);

    // Rapid BGM crossfade race under fake timers
    vi.useFakeTimers();
    audio.setBgmState('TITLE');
    audio.setBgmState('PHASE_1');
    audio.setBgmState('PHASE_2');
    audio.setBgmState('VICTORY');
    audio.setBgmState('PHASE_1');
    vi.advanceTimersByTime(2000);
    const activeBgmSources = createdSources.filter((s) => s.loop && !s.stopped);
    expect(activeBgmSources).toHaveLength(1);
    expect(audio.getState().activeBgmState).toBe('phase1');

    // Natural SFX source.onended removes voice from pool so subsequent SFX don't evict it
    const beforeSfxIdx = createdSources.length;
    audio.playSfx('sword_slash_1');
    const firstSfxSource = createdSources[beforeSfxIdx]!;
    expect(firstSfxSource.onended).toBeTypeOf('function');
    firstSfxSource.onended?.();
    expect(firstSfxSource.disconnected).toBe(true);
    expect(firstSfxSource.stopped).toBe(false);

    // Post-dispose guards (Bug 6): mutators are complete no-ops
    const stateBeforeDispose = { ...audio.getState() };
    audio.dispose();
    audio.setBgmState('VICTORY');
    audio.playSfx('lotus_ward');
    audio.setMuted(true);
    audio.setMasterVolume(0.1);
    audio.setPaused(false);
    audio.setBulletTimeFilter(false);
    expect(audio.getState().activeBgmState).toBe(stateBeforeDispose.activeBgmState);
    expect(audio.getState().lastSfx).toBe(stateBeforeDispose.lastSfx);
    expect(audio.getState().muted).toBe(stateBeforeDispose.muted);
    expect(audio.getMasterVolume()).toBeCloseTo(0.72, 5);
  });

  it('handles AssetLoader cloneModel missing key, optional network/0-byte failures, retry loadAll(), and BASE_URL normalization', async () => {
    const loaderMissing = new AssetLoader({ manifest: [] });
    expect(() => loaderMissing.cloneModel('nonexistent')).toThrow(
      'GLB asset "nonexistent" is not loaded',
    );

    // BASE_URL normalization check via assertLocalAssetPath
    expect(assertLocalAssetPath('assets/audio/sfx/chime_bell.ogg')).toBe(
      '/assets/audio/sfx/chime_bell.ogg',
    );

    const errors: string[] = [];
    let attempt = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      attempt += 1;
      if (url.includes('opt_net_fail')) {
        throw new Error('ECONNRESET');
      }
      if (url.includes('opt_empty')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      }
      if (url.includes('opt_retry') && attempt <= 3) {
        return {
          ok: false,
          status: 500,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Response;
    }) as unknown as typeof fetch;

    const loader = new AssetLoader({
      manifest: [
        { key: 'opt_net_fail', kind: 'audio', path: 'assets/audio/sfx/opt_net_fail.ogg', requiredInM1: false },
        { key: 'opt_empty', kind: 'audio', path: 'assets/audio/sfx/opt_empty.ogg', requiredInM1: false },
        { key: 'opt_retry', kind: 'audio', path: 'assets/audio/sfx/opt_retry.ogg', requiredInM1: false },
        { key: 'opt_ok', kind: 'audio', path: 'assets/audio/sfx/opt_ok.ogg', requiredInM1: false },
      ],
      onError: (m) => errors.push(m),
    });

    const first = await loader.loadAll();
    expect(first.loadedCount).toBe(1);
    expect(first.failedCount).toBe(3);
    expect(first.errors).toHaveLength(3);
    expect(errors).toHaveLength(3);

    // Retry loadAll(): already-loaded opt_ok is NOT re-fetched, opt_retry succeeds now
    const callsBeforeRetry = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await loader.loadAll();
    const callsAfterRetry = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterRetry - callsBeforeRetry).toBe(3); // opt_ok skipped
    expect(second.loadedCount).toBe(2);
    expect(second.failedCount).toBe(2);
  });

  it('guards RendererSystem pre-init calls, resize(NaN/Infinity/<=0) (Bug 4), and idempotent dispose()', () => {
    const rs = new RendererSystem({ forceWebGL: true });

    // Pre-init calls are safe no-ops
    expect(() => rs.render()).not.toThrow();
    expect(() => rs.resize(800, 600)).not.toThrow();
    expect(() => rs.dispose()).not.toThrow();

    // Mock initialized renderer & renderPipeline to verify resize(NaN/Infinity/<=0)
    const setSizeSpy = vi.fn();
    const disposeSpy = vi.fn();
    const removeSpy = vi.fn();
    (rs as unknown as { renderer: unknown }).renderer = {
      setPixelRatio: vi.fn(),
      setSize: setSizeSpy,
      dispose: disposeSpy,
      domElement: { remove: removeSpy },
    };

    const cases: Array<[number | undefined, number | undefined]> = [
      [Number.NaN, Number.NaN],
      [-10, 0],
      [Number.POSITIVE_INFINITY, 500],
      [800, Number.NEGATIVE_INFINITY],
    ];
    for (const [w, h] of cases) {
      rs.resize(w, h);
      expect(Number.isFinite(rs.camera.aspect)).toBe(true);
      expect(rs.camera.aspect).toBeGreaterThan(0);
      const [passedW, passedH] = setSizeSpy.mock.calls.at(-1) as [number, number];
      expect(Number.isFinite(passedW) && passedW >= 1).toBe(true);
      expect(Number.isFinite(passedH) && passedH >= 1).toBe(true);
    }

    rs.dispose();
    rs.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(2); // safe on double dispose without throwing
  });
});

// ===========================================================================
// Partition B Adversarial Tests (VFX, Scene/Atmosphere, UI, DebugBridge)
// ===========================================================================

describe('Tier 5 Adversarial — VFX Pool Exhaustion, Float32 Clamping & Post-Dispose', () => {
  it('saturates SlashTrailVfx (16 cap), clamps 1e308 inputs (C2 Bug 1), and drains cleanly', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    for (let i = 0; i < 40; i += 1) {
      vfx.spawnSlashArc({ x: i, y: 1, z: -i }, { x: 1, y: 0, z: 0 }, 0.2, 'ink_gold', 1.2);
    }
    expect(vfx.getActiveSlashCount()).toBe(16);

    // C2 Bug 1 regression: 1e308 origin and scale must clamp <= 1e6 so Math.fround is finite
    vfx.spawnSlashArc(
      { x: 1.5e308, y: 1e308, z: -1.5e308 },
      { x: 1, y: 0, z: 0 },
      0,
      'crimson_gold',
      1e308,
    );
    vfx.slashTrails.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        expect(Number.isFinite(Math.fround(obj.position.x))).toBe(true);
        expect(Number.isFinite(Math.fround(obj.position.y))).toBe(true);
        expect(Number.isFinite(Math.fround(obj.position.z))).toBe(true);
        expect(Number.isFinite(Math.fround(obj.scale.x))).toBe(true);
        expect(Math.abs(obj.position.x)).toBeLessThanOrEqual(1e6);
        expect(obj.scale.x).toBeLessThanOrEqual(1e6);
      }
    });

    vfx.update(0.3);
    expect(vfx.getActiveSlashCount()).toBe(0);
    vfx.dispose();
  });

  it('saturates TelegraphVfx (8+6+6+8=28 cap), cleans evicted IDs, and switches same-ID kinds cleanly', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    for (let i = 0; i < 12; i += 1) {
      vfx.showTelegraphRing(`ring_${i}`, { center: { x: 0, y: 0, z: 0 }, innerRadius: 1, outerRadius: 4, progress: 0.5 });
    }
    for (let i = 0; i < 9; i += 1) {
      vfx.showTelegraphArc(`arc_${i}`, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radius: 5, arcAngleRad: 1.2, progress: 0.5 });
    }
    for (let i = 0; i < 9; i += 1) {
      vfx.showTelegraphLine(`line_${i}`, { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, length: 8, width: 2, progress: 0.5 });
    }
    for (let i = 0; i < 11; i += 1) {
      vfx.showTelegraphPillar(`pillar_${i}`, { center: { x: i, y: 0, z: 0 }, radius: 2, height: 10, progress: 0.5 });
    }
    expect(vfx.getActiveTelegraphCount()).toBe(28);
    expect(() => vfx.clearTelegraph('ring_0')).not.toThrow();

    // Same-ID kind switch: ring -> arc -> line -> pillar
    vfx.clearAllTelegraphs();
    vfx.showTelegraphRing('morph', { center: { x: 0, y: 0, z: 0 }, innerRadius: 1, outerRadius: 3, progress: 0.2 });
    expect(vfx.getActiveTelegraphCount()).toBe(1);
    vfx.showTelegraphArc('morph', { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, radius: 4, arcAngleRad: 1.0, progress: 0.4 });
    expect(vfx.getActiveTelegraphCount()).toBe(1);
    vfx.showTelegraphLine('morph', { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, length: 6, width: 2, progress: 0.6 });
    expect(vfx.getActiveTelegraphCount()).toBe(1);
    vfx.showTelegraphPillar('morph', { center: { x: 0, y: 0, z: 0 }, radius: 2, height: 12, progress: 0.8 });
    expect(vfx.getActiveTelegraphCount()).toBe(1);

    vfx.dispose();
  });

  it('saturates ParticleVfx burst/shockwave pools, resets Act II ambient palette on reset() (C2 Bug 2), and guards post-dispose mutators', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    const particlesAny = vfx.particles as unknown as {
      colorArray: Float32Array;
      posArray: Float32Array;
      uBeamProgress: { value: number };
      uDomainTime: { value: number };
    };
    const act1Color0 = particlesAny.colorArray[0];

    for (let i = 0; i < 10; i += 1) {
      vfx.triggerPostureBreakBurst({ x: i, y: 1, z: -i });
    }
    expect(vfx.getActiveBurstParticleCount()).toBeLessThanOrEqual(392);
    for (let i = 0; i < particlesAny.posArray.length; i += 1) {
      expect(Number.isFinite(particlesAny.posArray[i]!)).toBe(true);
    }

    vfx.update(1.5);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);

    // C2 Bug 2 regression: setPhaseIntensity(1.0) -> reset() restores Act I ambient palette & uniforms
    vfx.setPhaseIntensity(1.0);
    expect(particlesAny.colorArray[0]).not.toBeCloseTo(act1Color0!, 2);
    vfx.triggerSkill3Domain(true, { x: 0, y: 0, z: 0 });
    vfx.update(0.2);
    vfx.reset();
    expect(particlesAny.colorArray[0]).toBeCloseTo(act1Color0!, 5);
    expect(particlesAny.uBeamProgress.value).toBe(0);
    expect(particlesAny.uDomainTime.value).toBe(0);

    // Post-dispose mutator safety
    vfx.dispose();
    expect(() => {
      vfx.spawnSlashArc({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 0, 'ink_gold', 1);
      vfx.spawnImpactBurst({ x: 0, y: 1, z: 0 }, true);
      vfx.showTelegraphRing('x', { center: { x: 0, y: 0, z: 0 }, innerRadius: 1, outerRadius: 2, progress: 0.5 });
      vfx.showTelegraphArc('y', { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, radius: 2, arcAngleRad: 1, progress: 0.5 });
      vfx.showTelegraphLine('z', { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, length: 4, width: 1, progress: 0.5 });
      vfx.showTelegraphPillar('p', { center: { x: 0, y: 0, z: 0 }, radius: 1, height: 5, progress: 0.5 });
      vfx.triggerPostureBreakBurst({ x: 0, y: 0, z: 0 });
      vfx.triggerSkill3Domain(true, { x: 0, y: 0, z: 0 });
      vfx.triggerLotusWardBurst({ x: 0, y: 0, z: 0 });
      vfx.setPhaseIntensity(1);
      vfx.update(0.5);
      vfx.reset();
    }).not.toThrow();
    expect(vfx.getActiveSlashCount()).toBe(0);
    expect(vfx.getActiveTelegraphCount()).toBe(0);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);
  });
});

describe('Tier 5 Adversarial — ArenaScene & AtmosphereController', () => {
  it('transitions nightHdri/duskHdri across [0.42, 0.58] eclipse dip, clamps invalid intensities, saturates lightning pool, and handles NaN ArenaScene.update', () => {
    const scene = new THREE.Scene();
    const nightHdri = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const duskHdri = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const atmosphere = new AtmosphereController({ scene, nightHdri, duskHdri });
    const arena = new ArenaScene({ scene, atmosphere });

    expect(scene.environment).toBe(nightHdri);
    expect(scene.environmentIntensity).toBe(1.0);

    atmosphere.setPhaseIntensity(0.46);
    expect(scene.environment).toBe(nightHdri);
    expect(scene.environmentIntensity).toBeCloseTo(0.775, 5);

    atmosphere.setPhaseIntensity(0.5);
    expect(scene.environment).toBe(duskHdri);
    expect(scene.environmentIntensity).toBeCloseTo(0.55, 5);

    atmosphere.setPhaseIntensity(0.58);
    expect(scene.environment).toBe(duskHdri);
    expect(scene.environmentIntensity).toBeCloseTo(1.25, 5);

    atmosphere.reset();
    expect(scene.environment).toBe(nightHdri);
    expect(scene.environmentIntensity).toBe(1.0);

    // Clamping invalid intensities
    atmosphere.setPhaseIntensity(-5);
    expect(atmosphere.getPhaseIntensity()).toBe(0);
    atmosphere.setPhaseIntensity(5);
    expect(atmosphere.getPhaseIntensity()).toBe(1);
    atmosphere.setPhaseIntensity(Number.NaN);
    expect(atmosphere.getPhaseIntensity()).toBe(0);
    atmosphere.setPhaseIntensity(Number.POSITIVE_INFINITY);
    expect(atmosphere.getPhaseIntensity()).toBe(0);

    // Lightning pool saturation (>4) & decay
    for (let i = 0; i < 8; i += 1) {
      atmosphere.triggerLightningStrike({ x: i, y: 0, z: -i });
    }
    expect(atmosphere.getActiveLightningCount()).toBe(4);
    atmosphere.update(1.0);
    expect(atmosphere.getActiveLightningCount()).toBe(0);

    // ArenaScene.update NaN safety
    arena.update(0.016, Number.NaN);
    arena.update(Number.NaN, 1.0);
    const uTime = (arena as unknown as { uTime: { value: number } }).uTime.value;
    expect(Number.isFinite(uTime)).toBe(true);

    arena.dispose();
    atmosphere.dispose();
    nightHdri.dispose();
    duskHdri.dispose();
  });
});

describe('Tier 5 Adversarial — HudOverlay, MenuScreens & DebugBridge', () => {
  beforeEach(() => {
    const mockDoc = new MockDocument();
    Object.defineProperty(globalThis, 'document', {
      value: mockDoc,
      configurable: true,
      writable: true,
    });
  });

  it('sanitizes extreme/NaN/Infinity HudOverlay inputs (C2 Bug 5) and renders at most 4 callouts', () => {
    const container = (document as unknown as MockDocument).createElement('div');
    const hud = new HudOverlay(container as unknown as HTMLElement);

    hud.render(
      makeHudSnapshot({
        boss: {
          visible: true,
          name: UI_COPY.BOSS_NAME,
          hp: -100,
          maxHp: 40_000,
          hpRatio: -0.5,
          posture: 50_000,
          maxPosture: 1_000,
          postureRatio: 2.0,
          staggered: true,
          staggerRemaining: Number.NaN,
        },
        player: {
          visible: true,
          hp: Number.NaN,
          maxHp: 1_000,
          hpRatio: Number.NaN,
          shield: -5,
          maxShield: 250,
          shieldRatio: 1.5,
          qi: Number.POSITIVE_INFINITY,
          maxQi: 100,
          qiRatio: Number.NEGATIVE_INFINITY,
          comboCount: Number.POSITIVE_INFINITY,
          comboTimerRatio: 0.5,
          bulletTimeActive: false,
          bulletTimeRemaining: 0,
          skill3Active: false,
          lotusWardReady: false,
          lotusWardCooldown: Number.NaN,
        },
        skills: [],
        callouts: [1, 2, 3, 4, 5, 6].map((id) => ({
          id,
          text: `CALLOUT_${id}`,
          tone: 'gold',
          remaining: 1,
          duration: 1.5,
        })),
      }),
    );

    const fullText = container.textContent;
    expect(fullText).not.toContain('NaN');
    expect(fullText).not.toContain('Infinity');
    expect(findByClass(container, 'bm-qi-ready-badge')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-combo-panel')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'is-boss-hp')[0]!.style.width).toBe('0.00%');
    expect(findByClass(container, 'is-boss-posture')[0]!.style.width).toBe('100.00%');
    expect(fullText).toContain('CALLOUT_4');
    expect(fullText).not.toContain('CALLOUT_5');

    // Also verify negative & fractional comboCount
    hud.render(makeHudSnapshot({ player: { ...makeHudSnapshot().player, comboCount: -3 } }));
    expect(findByClass(container, 'bm-combo-panel')[0]!.hidden).toBe(true);
    hud.render(makeHudSnapshot({ player: { ...makeHudSnapshot().player, comboCount: 3.7 } }));
    expect(findByClass(container, 'bm-combo-count')[0]!.textContent).toBe('4');

    // Double dispose + post-dispose render no-op
    hud.dispose();
    hud.dispose();
    expect(() => hud.render(makeHudSnapshot())).not.toThrow();
  });

  it('clears stuck MenuScreens volume drag on window pointerup (C2 Bug 6) and removes all listeners on dispose()', () => {
    const mockWindow = createMockWindow('?testMode=1');
    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    const container = (document as unknown as MockDocument).createElement('div');
    const callbacks = {
      onBeginTrial: vi.fn(),
      onResume: vi.fn(),
      onRestartTrial: vi.fn(),
      onPlayAgain: vi.fn(),
      onToggleMute: vi.fn(),
      onMasterVolumeChange: vi.fn(),
    };
    const menus = new MenuScreens(container as unknown as HTMLElement, callbacks);

    menus.render(
      makeHudSnapshot({
        phase: 'PHASE_1',
        paused: true,
        audio: { unlocked: true, muted: false, masterVolume: 0.85 },
      }),
    );

    const slider = findByClass(container, 'bm-volume-slider')[0]!;
    slider.dispatchEvent({ type: 'pointerdown' });
    // Release pointer outside slider on window without changing value
    mockWindow.dispatch('pointerup');

    // External masterVolume sync must now apply to slider.value (not stuck!)
    menus.render(
      makeHudSnapshot({
        phase: 'PHASE_1',
        paused: true,
        audio: { unlocked: true, muted: false, masterVolume: 0.25 },
      }),
    );
    expect(slider.value).toBe('0.25');
    expect(findByClass(container, 'bm-volume-value')[0]!.textContent).toBe('25%');

    // Verify dispose removes all listeners on buttons, slider, and window
    expect(mockWindow.listenerCount('pointerup')).toBe(1);
    expect(mockWindow.listenerCount('mouseup')).toBe(1);
    expect(mockWindow.listenerCount('pointercancel')).toBe(1);

    const buttons = walkElements(container).filter((el) => el.tagName === 'BUTTON');
    menus.dispose();

    expect(mockWindow.listenerCount('pointerup')).toBe(0);
    expect(mockWindow.listenerCount('mouseup')).toBe(0);
    expect(mockWindow.listenerCount('pointercancel')).toBe(0);

    for (const btn of buttons) {
      btn.click();
    }
    slider.value = '0.9';
    slider.dispatchEvent({ type: 'input' });
    slider.dispatchEvent({ type: 'change' });

    expect(callbacks.onBeginTrial).not.toHaveBeenCalled();
    expect(callbacks.onResume).not.toHaveBeenCalled();
    expect(callbacks.onRestartTrial).not.toHaveBeenCalled();
    expect(callbacks.onPlayAgain).not.toHaveBeenCalled();
    expect(callbacks.onToggleMute).not.toHaveBeenCalled();
    expect(callbacks.onMasterVolumeChange).not.toHaveBeenCalled();
  });

  it('validates DebugBridge.isTestMode(), clearErrors(), double dispose(), and GameStateMachine hook boundary matrix', () => {
    // 1. isTestMode() only true for ?testMode=1
    for (const [search, expected] of [
      ['?testMode=1', true],
      ['', false],
      ['?testMode=0', false],
      ['?testMode=true', false],
      ['?foo=bar', false],
    ] as const) {
      Object.defineProperty(globalThis, 'window', {
        value: createMockWindow(search),
        configurable: true,
        writable: true,
      });
      const b = new DebugBridge();
      expect(b.isTestMode()).toBe(expected);
    }

    // 2. clearErrors() allows re-capturing up to 100 again & double dispose is safe
    const bridge = new DebugBridge();
    bridge.install();
    for (let i = 0; i < 105; i += 1) {
      bridge.pushError(`err_${i}`);
    }
    expect(bridge.getErrors()).toHaveLength(100);
    bridge.clearErrors();
    expect(bridge.getErrors()).toHaveLength(0);
    for (let i = 0; i < 105; i += 1) {
      bridge.pushError(`err2_${i}`);
    }
    expect(bridge.getErrors()).toHaveLength(100);
    bridge.dispose();
    bridge.dispose();

    // 3. Hook boundary matrix on GameStateMachine
    const sm = createStateMachineHarness();
    const api = sm.bridge.install();

    // TITLE: hooks ignored
    api.setBossHp(10_000);
    api.setBossPosture(0);
    api.triggerBossTestAttack('abyssal_sweep');
    expect(sm.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(sm.boss.staggered).toBe(false);
    expect(sm.boss.currentAttack).toBeNull();

    // Enter PHASE_1: setPlayerDamageMultiplier(0) deals 0 damage, no Qi/combo/hitstop
    sm.gsm.startTrial();
    api.skipCinematic();
    sm.player.position.set(0, 0, -1.5);
    const qiBefore = sm.combat.qi;
    api.setPlayerDamageMultiplier(0);
    sm.tick(0.05, idleInput({ attackPressed: true }));
    sm.tickSeconds(0.15, 0.05);
    expect(sm.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(sm.combat.qi).toBe(qiBefore);
    expect(sm.combat.getPlayerDebugSnapshot().comboCount).toBe(0);
    expect(sm.timeScaleSystem.hitstopRemaining).toBe(0);

    // Invalid multipliers ignored
    api.setPlayerDamageMultiplier(2);
    api.setPlayerDamageMultiplier(-1);
    api.setPlayerDamageMultiplier(Number.NaN);
    api.setPlayerDamageMultiplier(Number.POSITIVE_INFINITY);
    expect(sm.combat.playerDamageMultiplier).toBe(2);

    // Unknown attack ID in PHASE_1 returns cleanly without crashing
    api.triggerBossTestAttack('nonexistent_id');
    expect(sm.boss.currentAttack).toBeNull();

    // Invalid posture & posture update while staggered
    api.setBossPosture(0);
    expect(sm.boss.staggered).toBe(true);
    api.setBossPosture(500);
    expect(sm.boss.posture).toBe(500);
    api.setBossPosture(Number.NaN);
    api.setBossPosture(Number.POSITIVE_INFINITY);
    expect(sm.boss.posture).toBe(500);

    sm.cleanup();
  });
});
