import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../../src/audio/AudioManager.ts';
import { GameStateMachine } from '../../src/combat/GameStateMachine.ts';
import { DebugBridge } from '../../src/debug/DebugBridge.ts';
import { TimeScaleSystem } from '../../src/engine/TimeScaleSystem.ts';
import { BOSS_CLIPS, BossEntity } from '../../src/entities/BossEntity.ts';
import { PLAYER_CLIPS, PlayerEntity } from '../../src/entities/PlayerEntity.ts';
import {
  COMBAT_TUNING,
  UI_COPY,
  type ArenaInterface,
  type HudSnapshot,
  type VfxInterface,
} from '../../src/types/game.ts';
import { HudOverlay } from '../../src/ui/HudOverlay.ts';
import { MenuScreens } from '../../src/ui/MenuScreens.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '../..');
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

// ---------------------------------------------------------------------------
// Pure-TypeScript Node DOM Mock (no jsdom / happy-dom dependency)
// ---------------------------------------------------------------------------

type MockEventListener = (event: { type: string; target: MockElement }) => void;

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
    return (
      this._textContent +
      this.children.map((child) => child.textContent).join('')
    );
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
    if (name === 'id') {
      this.id = String(value);
    } else if (name === 'type') {
      this.type = String(value);
    }
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
}

class MockDocument {
  readonly body = new MockElement('body');
  createElement(tag: string): MockElement {
    return new MockElement(tag);
  }
}

function isElementVisible(el: MockElement): boolean {
  let curr: MockElement | null = el;
  while (curr) {
    if (curr.hidden || curr.className.split(/\s+/).includes('is-hidden')) {
      return false;
    }
    curr = curr.parentNode;
  }
  return true;
}

function walkElements(root: MockElement): MockElement[] {
  const result: MockElement[] = [root];
  for (const child of root.children) {
    result.push(...walkElements(child));
  }
  return result;
}

function findByClass(root: MockElement, classToken: string): MockElement[] {
  return walkElements(root).filter((el) =>
    el.className.split(/\s+/).includes(classToken),
  );
}

function findLeafByExactText(
  root: MockElement,
  exactText: string,
  options?: { visibleOnly?: boolean },
): MockElement[] {
  return walkElements(root).filter((el) => {
    if (el.children.length > 0) {
      return false;
    }
    if (options?.visibleOnly && !isElementVisible(el)) {
      return false;
    }
    return el.textContent === exactText;
  });
}

function findButtonsByText(
  root: MockElement,
  exactText: string,
  options?: { visibleOnly?: boolean },
): MockElement[] {
  return walkElements(root).filter((el) => {
    if (el.tagName !== 'BUTTON') {
      return false;
    }
    if (options?.visibleOnly && !isElementVisible(el)) {
      return false;
    }
    return el.textContent === exactText;
  });
}

function collectVisibleText(root: MockElement): string {
  const parts: string[] = [];
  for (const el of walkElements(root)) {
    if (el.children.length === 0 && isElementVisible(el) && el.textContent) {
      parts.push(el.textContent);
    }
  }
  return parts.join(' ');
}

function makeSnapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
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
      clearTimeSeconds: 124.4,
      totalDamageDealt: 40_000,
      damageTaken: 180,
      perfectDodges: 4,
      postureBreaks: 2,
      maxCombo: 16,
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
// Minimal Entity & Arena/VFX Fixtures for GameStateMachine Integration Tests
// ---------------------------------------------------------------------------

function makeClip(name: string, duration = 0.6): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack(
    '.position',
    [0, duration],
    [0, 0, 0, 0, 0, 0],
  );
  return new THREE.AnimationClip(name, duration, [track]);
}

function createEntityFixtures(): {
  player: PlayerEntity;
  boss: BossEntity;
  arena: ArenaInterface;
  vfx: VfxInterface;
  cleanup: () => void;
} {
  const pGroup = new THREE.Group();
  const spine = new THREE.Bone();
  spine.name = 'spine_01';
  const handR = new THREE.Bone();
  handR.name = 'hand_r';
  spine.add(handR);
  pGroup.add(spine);
  const pGeom = new THREE.BoxGeometry(0.5, 1.6, 0.3);
  const pMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee });
  pGroup.add(new THREE.Mesh(pGeom, pMat));

  const weaponGroup = new THREE.Group();
  weaponGroup.add(new THREE.Mesh(pGeom, pMat));

  const playerClips = [
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
  ].map((name) => makeClip(name));

  const player = new PlayerEntity({
    model: pGroup,
    weaponModel: weaponGroup,
    clips: playerClips,
  });

  const bGroup = new THREE.Group();
  const handSlot = new THREE.Bone();
  handSlot.name = 'handslot.r';
  bGroup.add(handSlot);
  const bGeom = new THREE.BoxGeometry(1.2, 2.2, 0.8);
  const bMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  bGroup.add(new THREE.Mesh(bGeom, bMat));

  const bWeapon = new THREE.Group();
  bWeapon.add(new THREE.Mesh(bGeom, bMat));

  const bossClips = Array.from(
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
  ).map((name) => makeClip(name));

  const boss = new BossEntity({
    model: bGroup,
    weaponModel: bWeapon,
    clips: bossClips,
  });

  const arena: ArenaInterface = {
    arenaRadius: COMBAT_TUNING.arenaRadius,
    setPhaseIntensity: vi.fn(),
    triggerLightningStrike: vi.fn(),
    update: vi.fn(),
    reset: vi.fn(),
  };

  const vfx: VfxInterface = {
    spawnSlashArc: vi.fn(),
    spawnImpactBurst: vi.fn(),
    showTelegraphRing: vi.fn(),
    showTelegraphArc: vi.fn(),
    showTelegraphLine: vi.fn(),
    clearTelegraph: vi.fn(),
    clearAllTelegraphs: vi.fn(),
    triggerPostureBreakBurst: vi.fn(),
    triggerSkill3Domain: vi.fn(),
    triggerLotusWardBurst: vi.fn(),
    update: vi.fn(),
    reset: vi.fn(),
  };

  return {
    player,
    boss,
    arena,
    vfx,
    cleanup: () => {
      player.dispose();
      boss.dispose();
      pGeom.dispose();
      pMat.dispose();
      bGeom.dispose();
      bMat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Global Mock Setup / Teardown
// ---------------------------------------------------------------------------

describe('M4 UI & Application Integration', () => {
  let mockDoc: MockDocument;
  let originalDocumentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    mockDoc = new MockDocument();
    Object.defineProperty(globalThis, 'document', {
      value: mockDoc,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('enforces 100% English copy with zero CJK, external URLs, OpenMotion, or ShaderMaterial in UI & entry sources', () => {
    for (const [key, value] of Object.entries(UI_COPY)) {
      expect(CJK_REGEX.test(value), `UI_COPY.${key} contains CJK`).toBe(false);
    }

    const filesToScan = [
      path.join(PROJECT_ROOT, 'index.html'),
      path.join(PROJECT_ROOT, 'src/main.ts'),
      path.join(PROJECT_ROOT, 'src/ui/styles.css'),
      path.join(PROJECT_ROOT, 'src/ui/HudOverlay.ts'),
      path.join(PROJECT_ROOT, 'src/ui/MenuScreens.ts'),
    ];

    for (const filePath of filesToScan) {
      const content = readFileSync(filePath, 'utf8');
      const contentWithoutSvgNs = content.replace(
        /http:\/\/www\.w3\.org\/2000\/svg/g,
        '',
      );
      expect(CJK_REGEX.test(content), `${filePath} must have zero CJK`).toBe(
        false,
      );
      expect(
        /https?:\/\//i.test(contentWithoutSvgNs),
        `${filePath} must have zero external URLs`,
      ).toBe(false);
      expect(/openmotion/i.test(content), `${filePath} must not mention OpenMotion`).toBe(
        false,
      );
      expect(
        /\b(?:Raw)?ShaderMaterial\b/.test(content),
        `${filePath} must not use ShaderMaterial`,
      ).toBe(false);
    }

    // Verify rendered text across all screens contains zero CJK
    const container = mockDoc.createElement('div') as unknown as HTMLElement;
    const hud = new HudOverlay(container);
    const menus = new MenuScreens(container, {
      onBeginTrial: vi.fn(),
      onResume: vi.fn(),
      onRestartTrial: vi.fn(),
      onPlayAgain: vi.fn(),
      onToggleMute: vi.fn(),
      onMasterVolumeChange: vi.fn(),
    });

    const snapshots: HudSnapshot[] = [
      makeSnapshot({
        phase: 'TITLE',
        boss: { ...makeSnapshot().boss, visible: false },
        player: { ...makeSnapshot().player, visible: false },
      }),
      makeSnapshot({
        phase: 'PHASE_1',
        banner: {
          title: UI_COPY.BANNER_ACT_1,
          subtitle: UI_COPY.BOSS_NAME,
          accent: 'act1',
          visible: true,
        },
        boss: { ...makeSnapshot().boss, staggered: true, staggerRemaining: 3.4 },
        callouts: [
          {
            id: 1,
            text: UI_COPY.CALLOUT_PERFECT_DODGE,
            tone: 'cyan',
            remaining: 1.5,
            duration: 1.8,
          },
          {
            id: 2,
            text: UI_COPY.CALLOUT_POSTURE_BROKEN,
            tone: 'gold',
            remaining: 2.0,
            duration: 2.2,
          },
          {
            id: 3,
            text: UI_COPY.CALLOUT_AWAKENING_READY,
            tone: 'gold',
            remaining: 1.4,
            duration: 1.6,
          },
          {
            id: 4,
            text: UI_COPY.CALLOUT_LOTUS_WARD,
            tone: 'gold',
            remaining: 2.1,
            duration: 2.4,
          },
        ],
      }),
      makeSnapshot({
        phase: 'PHASE_2',
        paused: true,
        banner: {
          title: UI_COPY.BANNER_ACT_2,
          subtitle: UI_COPY.BOSS_NAME,
          accent: 'act2',
          visible: true,
        },
        audio: { unlocked: true, muted: true, masterVolume: 0.4 },
      }),
      makeSnapshot({
        phase: 'VICTORY',
        boss: { ...makeSnapshot().boss, visible: false },
        player: { ...makeSnapshot().player, visible: false },
        banner: null,
      }),
    ];

    for (const snap of snapshots) {
      hud.render(snap);
      menus.render(snap);
      const rendered = collectVisibleText(container as unknown as MockElement);
      expect(rendered.length).toBeGreaterThan(0);
      expect(CJK_REGEX.test(rendered)).toBe(false);
    }

    hud.dispose();
    menus.dispose();
  });

  it('renders HudOverlay Boss, Player, 4+1 Skill Bar, Combo, Banners, Callouts, Vignettes, and hides cleanly on TITLE/VICTORY', () => {
    const container = mockDoc.createElement('div');
    const hud = new HudOverlay(container as unknown as HTMLElement);

    // 1. TITLE: HUD panels hidden
    hud.render(
      makeSnapshot({
        phase: 'TITLE',
        boss: { ...makeSnapshot().boss, visible: false },
        player: { ...makeSnapshot().player, visible: false },
      }),
    );
    expect(
      findByClass(container, 'bm-boss-panel')[0]!.hidden,
    ).toBe(true);
    expect(
      findByClass(container, 'bm-player-panel')[0]!.hidden,
    ).toBe(true);
    expect(
      findByClass(container, 'bm-skill-bar')[0]!.hidden,
    ).toBe(true);
    expect(
      findByClass(container, 'bm-camera-hint')[0]!.hidden,
    ).toBe(true);

    // 2. Active PHASE_1 combat with stagger, combo, READY Qi, banner, callout, bullet time
    hud.render(
      makeSnapshot({
        phase: 'PHASE_1',
        banner: {
          title: UI_COPY.BANNER_ACT_1,
          subtitle: UI_COPY.BOSS_NAME,
          accent: 'act1',
          visible: true,
        },
        boss: {
          visible: true,
          name: UI_COPY.BOSS_NAME,
          hp: 24_000,
          maxHp: 40_000,
          hpRatio: 0.6,
          posture: 0,
          maxPosture: 1_000,
          postureRatio: 0,
          staggered: true,
          staggerRemaining: 4.2,
        },
        player: {
          visible: true,
          hp: 850,
          maxHp: 1_000,
          hpRatio: 0.85,
          shield: 125,
          maxShield: 250,
          shieldRatio: 0.5,
          qi: 75,
          maxQi: 100,
          qiRatio: 0.75,
          comboCount: 7,
          comboTimerRatio: 0.5,
          bulletTimeActive: true,
          bulletTimeRemaining: 1.8,
          skill3Active: false,
          lotusWardReady: false,
          lotusWardCooldown: 14.5,
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
            cooldownRemaining: 3.0,
            cooldownTotal: 6.0,
            ready: false,
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
            ready: false,
            active: true,
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
        callouts: [
          {
            id: 10,
            text: UI_COPY.CALLOUT_POSTURE_BROKEN,
            tone: 'gold',
            remaining: 2.0,
            duration: 2.2,
          },
        ],
      }),
    );

    // Exact-match leaf elements expected by E2E locators
    // Boss name appears in both Boss Bar and Act I banner subtitle while banner is active
    expect(findLeafByExactText(container, UI_COPY.BOSS_NAME, { visibleOnly: true })).toHaveLength(2);
    expect(findLeafByExactText(container, UI_COPY.BOSS_HP_LABEL, { visibleOnly: true })).toHaveLength(2);
    expect(findLeafByExactText(container, UI_COPY.BOSS_POSTURE_LABEL, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.PLAYER_SHIELD_LABEL, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.PLAYER_QI_LABEL, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.SKILL_COMBO_NAME, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.SKILL_DODGE_NAME, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.SKILL_1_NAME, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.SKILL_2_NAME, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.SKILL_3_NAME, { visibleOnly: true })).toHaveLength(1);

    // Boss HP / Posture / Stagger
    expect(findByClass(container, 'bm-boss-panel')[0]!.className).toContain('is-staggered');
    expect(findByClass(container, 'bm-boss-stagger-badge')[0]!.textContent).toBe('STAGGERED · 4.2s');
    expect(findByClass(container, 'is-boss-hp')[0]!.style.width).toBe('60.00%');
    expect(findByClass(container, 'is-boss-posture')[0]!.style.width).toBe('0.00%');

    // Player vitals, READY badge & Lotus Ward cooldown
    expect(findByClass(container, 'is-player-hp')[0]!.style.width).toBe('85.00%');
    expect(findByClass(container, 'is-player-shield')[0]!.style.width).toBe('50.00%');
    expect(findByClass(container, 'bm-qi-ready-badge')[0]!.hidden).toBe(false);
    expect(findByClass(container, 'bm-lotus-status')[0]!.textContent).toBe('14.5s');

    // Skill cards: 5 total (Flowing Combo + 4 active slots)
    const skillCards = findByClass(container, 'bm-skill-card');
    expect(skillCards).toHaveLength(5);
    expect(skillCards[2]!.className).toContain('is-cooldown');
    expect(findByClass(skillCards[2]!, 'bm-skill-state')[0]!.textContent).toBe('3.0s');
    expect(findByClass(skillCards[2]!, 'bm-skill-cd-fill')[0]!.style.height).toBe('50.0%');
    expect(skillCards[3]!.className).toContain('is-active');
    expect(findByClass(skillCards[3]!, 'bm-skill-state')[0]!.textContent).toBe('ACTIVE');

    // Combo counter
    const comboPanel = findByClass(container, 'bm-combo-panel')[0]!;
    expect(comboPanel.hidden).toBe(false);
    expect(findByClass(comboPanel, 'bm-combo-count')[0]!.textContent).toBe('7');
    expect(findByClass(comboPanel, 'bm-combo-fill')[0]!.style.width).toBe('50.00%');

    // Vignette, Banner, Callout, Camera Hint
    expect(findByClass(container, 'bm-vignette')[0]!.className).toContain('is-bullet-time');
    expect(findByClass(container, 'bm-banner-title')[0]!.textContent).toBe(UI_COPY.BANNER_ACT_1);
    expect(findByClass(container, 'bm-callout')[0]!.textContent).toBe(UI_COPY.CALLOUT_POSTURE_BROKEN);
    expect(findByClass(container, 'bm-camera-hint')[0]!.hidden).toBe(false);

    // 3. Skill 3 domain overrides bullet-time vignette, low Qi dims Skill 3, and paused hides camera hint
    hud.render(
      makeSnapshot({
        paused: true,
        player: {
          ...makeSnapshot().player,
          qi: 20,
          qiRatio: 0.2,
          comboCount: 0,
          bulletTimeActive: true,
          skill3Active: true,
        },
        skills: [
          ...makeSnapshot().skills.slice(0, 3),
          {
            id: 'skill3',
            keyLabel: '3',
            name: UI_COPY.SKILL_3_NAME,
            cooldownRemaining: 0,
            cooldownTotal: 20.0,
            ready: false,
            active: false,
            qiRequired: 50,
            qiSufficient: false,
          },
        ],
        banner: {
          title: UI_COPY.BANNER_FINISHER,
          subtitle: UI_COPY.VICTORY_HEADER,
          accent: 'finisher',
          visible: true,
        },
      }),
    );

    expect(findByClass(container, 'bm-vignette')[0]!.className).toContain('is-skill3');
    expect(findByClass(container, 'bm-vignette')[0]!.className).not.toContain('is-bullet-time');
    expect(findByClass(container, 'bm-qi-ready-badge')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-combo-panel')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-camera-hint')[0]!.hidden).toBe(true);
    expect(skillCards[4]!.className).toContain('is-low-qi');
    expect(findByClass(skillCards[4]!, 'bm-skill-state')[0]!.textContent).toBe('QI 50');

    // 4. VICTORY clears banner title/subtitle, active callouts, and bossStaggerBadge so nothing leaks
    hud.render(
      makeSnapshot({
        phase: 'VICTORY',
        banner: null,
        boss: { ...makeSnapshot().boss, visible: false, staggered: true, staggerRemaining: 3.1 },
        player: { ...makeSnapshot().player, visible: false },
        callouts: [
          {
            id: 99,
            text: UI_COPY.CALLOUT_POSTURE_BROKEN,
            tone: 'gold',
            remaining: 1.5,
            duration: 1.8,
          },
        ],
      }),
    );
    expect(findByClass(container, 'bm-banner')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-banner-title')[0]!.textContent).toBe('');
    expect(findByClass(container, 'bm-banner-subtitle')[0]!.textContent).toBe('');
    expect(findByClass(container, 'bm-vignette')[0]!.className).toBe('bm-vignette');
    expect(findByClass(container, 'bm-boss-stagger-badge')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-boss-stagger-badge')[0]!.className).toBe('bm-boss-stagger-badge is-hidden');
    expect(findByClass(container, 'bm-boss-stagger-badge')[0]!.textContent).toBe('');
    for (const calloutEl of findByClass(container, 'bm-callout')) {
      expect(calloutEl.hidden).toBe(true);
      expect(calloutEl.className).toBe('bm-callout is-hidden');
      expect(calloutEl.textContent).toBe('');
    }

    // 5. TITLE also suppresses callouts; Awakening READY gated on Skill 3 ready;
    //    0 < cd <= 0.05 -> '0.1s', !ready & cd === 0 -> 'LOCKED', non-finite timers -> '0.0s'
    hud.render(
      makeSnapshot({
        phase: 'TITLE',
        boss: { ...makeSnapshot().boss, visible: false },
        player: { ...makeSnapshot().player, visible: false },
        callouts: [
          {
            id: 100,
            text: UI_COPY.CALLOUT_PERFECT_DODGE,
            tone: 'cyan',
            remaining: 1.2,
            duration: 1.8,
          },
        ],
      }),
    );
    for (const calloutEl of findByClass(container, 'bm-callout')) {
      expect(calloutEl.hidden).toBe(true);
      expect(calloutEl.textContent).toBe('');
    }

    hud.render(
      makeSnapshot({
        phase: 'PHASE_2',
        boss: {
          ...makeSnapshot().boss,
          visible: true,
          staggered: true,
          staggerRemaining: Number.NaN,
        },
        player: {
          ...makeSnapshot().player,
          visible: true,
          qi: 100,
          lotusWardReady: false,
          lotusWardCooldown: Number.POSITIVE_INFINITY,
        },
        skills: [
          {
            id: 'dodge',
            keyLabel: 'SPACE',
            name: UI_COPY.SKILL_DODGE_NAME,
            cooldownRemaining: 0.04,
            cooldownTotal: 0.77,
            ready: false,
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
            ready: false,
            active: false,
            qiRequired: 0,
            qiSufficient: true,
          },
          {
            id: 'skill2',
            keyLabel: '2',
            name: UI_COPY.SKILL_2_NAME,
            cooldownRemaining: Number.POSITIVE_INFINITY,
            cooldownTotal: 10.0,
            ready: false,
            active: false,
            qiRequired: 0,
            qiSufficient: true,
          },
          {
            id: 'skill3',
            keyLabel: '3',
            name: UI_COPY.SKILL_3_NAME,
            cooldownRemaining: 12.0,
            cooldownTotal: 20.0,
            ready: false,
            active: false,
            qiRequired: 50,
            qiSufficient: true,
          },
        ],
      }),
    );
    expect(findByClass(container, 'bm-qi-ready-badge')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-boss-stagger-badge')[0]!.textContent).toBe('STAGGERED · 0.0s');
    expect(findByClass(container, 'bm-lotus-status')[0]!.textContent).toBe('0.0s');
    expect(findByClass(skillCards[1]!, 'bm-skill-state')[0]!.textContent).toBe('0.1s');
    expect(findByClass(skillCards[2]!, 'bm-skill-state')[0]!.textContent).toBe('LOCKED');
    expect(findByClass(skillCards[3]!, 'bm-skill-state')[0]!.textContent).toBe('0.0s');

    hud.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('renders MenuScreens Title, Pause, and Victory screens and fires all callbacks', () => {
    const container = mockDoc.createElement('div');
    const callbacks = {
      onBeginTrial: vi.fn(),
      onResume: vi.fn(),
      onRestartTrial: vi.fn(),
      onPlayAgain: vi.fn(),
      onToggleMute: vi.fn(),
      onMasterVolumeChange: vi.fn(),
    };
    const menus = new MenuScreens(
      container as unknown as HTMLElement,
      callbacks,
    );

    // 1. Title screen
    menus.render(
      makeSnapshot({
        phase: 'TITLE',
        audio: { unlocked: false, muted: false, masterVolume: 0.85 },
      }),
    );
    expect(findByClass(container, 'bm-title-screen')[0]!.hidden).toBe(false);
    expect(findByClass(container, 'bm-pause-screen')[0]!.hidden).toBe(true);
    expect(findByClass(container, 'bm-victory-screen')[0]!.hidden).toBe(true);
    expect(findLeafByExactText(container, UI_COPY.TITLE_MAIN, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.TITLE_CONTROLS, { visibleOnly: true })).toHaveLength(1);
    expect(findButtonsByText(container, 'SOUND: ON', { visibleOnly: true })).toHaveLength(1);

    findButtonsByText(container, 'SOUND: ON', { visibleOnly: true })[0]!.click();
    expect(callbacks.onToggleMute).toHaveBeenCalledTimes(1);

    menus.render(
      makeSnapshot({
        phase: 'TITLE',
        audio: { unlocked: true, muted: true, masterVolume: 0.85 },
      }),
    );
    expect(findButtonsByText(container, 'SOUND: OFF', { visibleOnly: true })).toHaveLength(1);

    findButtonsByText(container, UI_COPY.TITLE_START_CTA, { visibleOnly: true })[0]!.click();
    expect(callbacks.onBeginTrial).toHaveBeenCalledTimes(1);

    // 2. Pause screen (mute toggle & master volume slider)
    menus.render(
      makeSnapshot({
        phase: 'PHASE_1',
        paused: true,
        audio: { unlocked: true, muted: false, masterVolume: 0.85 },
      }),
    );
    expect(findByClass(container, 'bm-pause-screen')[0]!.hidden).toBe(false);
    expect(findLeafByExactText(container, UI_COPY.PAUSE_TITLE, { visibleOnly: true })).toHaveLength(1);
    expect(findButtonsByText(container, UI_COPY.PAUSE_MUTE, { visibleOnly: true })).toHaveLength(1);

    findButtonsByText(container, UI_COPY.PAUSE_MUTE, { visibleOnly: true })[0]!.click();
    expect(callbacks.onToggleMute).toHaveBeenCalledTimes(2);

    menus.render(
      makeSnapshot({
        phase: 'PHASE_1',
        paused: true,
        audio: { unlocked: true, muted: true, masterVolume: 0.85 },
      }),
    );
    expect(findButtonsByText(container, UI_COPY.PAUSE_UNMUTE, { visibleOnly: true })).toHaveLength(1);

    const slider = findByClass(container, 'bm-volume-slider')[0]!;
    slider.value = '0.42';
    slider.dispatchEvent({ type: 'input' });
    expect(callbacks.onMasterVolumeChange).toHaveBeenCalledWith(0.42);
    expect(findByClass(container, 'bm-volume-value')[0]!.textContent).toBe('42%');

    // Empty/whitespace volume input is ignored without resetting to 0%
    callbacks.onMasterVolumeChange.mockClear();
    slider.value = '';
    slider.dispatchEvent({ type: 'input' });
    slider.value = '   ';
    slider.dispatchEvent({ type: 'input' });
    expect(callbacks.onMasterVolumeChange).not.toHaveBeenCalled();
    expect(findByClass(container, 'bm-volume-value')[0]!.textContent).toBe('42%');

    findButtonsByText(container, UI_COPY.PAUSE_RESUME, { visibleOnly: true })[0]!.click();
    expect(callbacks.onResume).toHaveBeenCalledTimes(1);

    findButtonsByText(container, UI_COPY.PAUSE_RESTART, { visibleOnly: true })[0]!.click();
    expect(callbacks.onRestartTrial).toHaveBeenCalledTimes(1);

    // 3. Victory screen (SSS + all 6 stats + PLAY AGAIN + exact clear time rounding)
    menus.render(
      makeSnapshot({
        phase: 'VICTORY',
        paused: false,
        stats: {
          clearTimeSeconds: 95.3,
          totalDamageDealt: 41_250,
          damageTaken: 120,
          perfectDodges: 5,
          postureBreaks: 3,
          maxCombo: 22,
          rank: 'SSS',
        },
      }),
    );
    expect(findByClass(container, 'bm-victory-screen')[0]!.hidden).toBe(false);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_HEADER, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_RANK_LABEL, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, 'SSS', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_TIME, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '01:35.3', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_DAMAGE, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '41,250', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_DODGES, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '5', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_POSTURES, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '3', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_COMBO, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '22', { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, UI_COPY.VICTORY_STAT_TAKEN, { visibleOnly: true })).toHaveLength(1);
    expect(findLeafByExactText(container, '120', { visibleOnly: true })).toHaveLength(1);

    // Additional clearTimeSeconds edge cases (IEEE-754 tenths & non-finite/negative clamps)
    menus.render(
      makeSnapshot({
        phase: 'VICTORY',
        stats: { ...makeSnapshot().stats, clearTimeSeconds: 1.2 },
      }),
    );
    expect(findLeafByExactText(container, '00:01.2', { visibleOnly: true })).toHaveLength(1);

    menus.render(
      makeSnapshot({
        phase: 'VICTORY',
        stats: { ...makeSnapshot().stats, clearTimeSeconds: Number.NaN },
      }),
    );
    expect(findLeafByExactText(container, '00:00.0', { visibleOnly: true })).toHaveLength(1);

    menus.render(
      makeSnapshot({
        phase: 'VICTORY',
        stats: { ...makeSnapshot().stats, clearTimeSeconds: 95.5 },
      }),
    );
    expect(findLeafByExactText(container, '01:35.5', { visibleOnly: true })).toHaveLength(1);

    menus.render(
      makeSnapshot({
        phase: 'VICTORY',
        stats: { ...makeSnapshot().stats, clearTimeSeconds: -10 },
      }),
    );
    expect(findLeafByExactText(container, '00:00.0', { visibleOnly: true })).toHaveLength(1);

    findButtonsByText(container, UI_COPY.VICTORY_REPLAY_CTA, { visibleOnly: true })[0]!.click();
    expect(callbacks.onPlayAgain).toHaveBeenCalledTimes(1);

    menus.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('wires HudOverlay and MenuScreens end-to-end with GameStateMachine and AudioManager', () => {
    const { player, boss, arena, vfx, cleanup } = createEntityFixtures();
    const timeScaleSystem = new TimeScaleSystem();
    const audioManager = new AudioManager();
    const debugBridge = new DebugBridge();
    const gsm = new GameStateMachine({
      player,
      boss,
      timeScaleSystem,
      arena,
      vfx,
      audio: audioManager,
      debugBridge,
      rendererBackend: 'webgpu',
      testMode: true,
    });

    const container = mockDoc.createElement('div');
    const hud = new HudOverlay(container as unknown as HTMLElement);
    let menus!: MenuScreens;

    const renderUi = (snapshot: HudSnapshot): void => {
      hud.render(snapshot);
      menus.render(snapshot);
    };
    const refreshUi = (): void => {
      renderUi(gsm.getHudSnapshot('webgpu', false, true));
    };

    menus = new MenuScreens(container as unknown as HTMLElement, {
      onBeginTrial: () => {
        gsm.startTrial();
      },
      onResume: () => {
        gsm.setPaused(false);
      },
      onRestartTrial: () => {
        gsm.restartTrial();
      },
      onPlayAgain: () => {
        gsm.restartTrial();
      },
      onToggleMute: () => {
        audioManager.setMuted(!audioManager.getState().muted);
        refreshUi();
      },
      onMasterVolumeChange: (vol: number) => {
        audioManager.setMasterVolume(vol);
        refreshUi();
      },
    });

    const unsubscribe = gsm.subscribeHud(renderUi);

    try {
      // Initial TITLE state
      expect(gsm.phase).toBe('TITLE');
      expect(findByClass(container, 'bm-title-screen')[0]!.hidden).toBe(false);

      // Click BEGIN TRIAL -> CINEMATIC_INTRO -> skipCinematic -> PHASE_1
      findButtonsByText(container, UI_COPY.TITLE_START_CTA, { visibleOnly: true })[0]!.click();
      expect(gsm.phase).toBe('CINEMATIC_INTRO');
      expect(findByClass(container, 'bm-title-screen')[0]!.hidden).toBe(true);
      expect(findByClass(container, 'bm-boss-panel')[0]!.hidden).toBe(false);

      gsm.skipCinematic();
      expect(gsm.phase).toBe('PHASE_1');
      expect(findByClass(container, 'bm-banner-title')[0]!.textContent).toBe(UI_COPY.BANNER_ACT_1);

      // Pause -> Mute -> Volume -> Resume
      gsm.setPaused(true);
      expect(findByClass(container, 'bm-pause-screen')[0]!.hidden).toBe(false);

      findButtonsByText(container, UI_COPY.PAUSE_MUTE, { visibleOnly: true })[0]!.click();
      expect(audioManager.getState().muted).toBe(true);
      expect(findButtonsByText(container, UI_COPY.PAUSE_UNMUTE, { visibleOnly: true })).toHaveLength(1);

      const slider = findByClass(container, 'bm-volume-slider')[0]!;
      slider.value = '0.50';
      slider.dispatchEvent({ type: 'input' });
      expect(audioManager.getMasterVolume()).toBeCloseTo(0.5, 4);

      findButtonsByText(container, UI_COPY.PAUSE_RESUME, { visibleOnly: true })[0]!.click();
      expect(gsm.paused).toBe(false);
      expect(findByClass(container, 'bm-pause-screen')[0]!.hidden).toBe(true);

      // Restart via Pause
      gsm.setPaused(true);
      findButtonsByText(container, UI_COPY.PAUSE_RESTART, { visibleOnly: true })[0]!.click();
      expect(gsm.phase).toBe('CINEMATIC_INTRO');
      expect(gsm.paused).toBe(false);

      // Progress through Phase 1 -> Transition -> Phase 2 -> Finisher -> Victory
      gsm.skipCinematic();
      expect(gsm.phase).toBe('PHASE_1');

      const debugApi = debugBridge.install();
      debugApi.setBossHp(COMBAT_TUNING.bossPhase2HpThreshold);
      expect(gsm.phase).toBe('CINEMATIC_TRANSITION');
      gsm.skipCinematic();
      expect(gsm.phase).toBe('PHASE_2');
      expect(findByClass(container, 'bm-banner-title')[0]!.textContent).toBe(UI_COPY.BANNER_ACT_2);

      debugApi.setBossHp(0);
      expect(gsm.phase).toBe('CINEMATIC_FINISHER');
      gsm.skipCinematic();
      expect(gsm.phase).toBe('VICTORY');
      expect(findByClass(container, 'bm-victory-screen')[0]!.hidden).toBe(false);
      expect(findLeafByExactText(container, 'SSS', { visibleOnly: true })).toHaveLength(1);

      // Click PLAY AGAIN -> resets back into CINEMATIC_INTRO with full Boss HP
      findButtonsByText(container, UI_COPY.VICTORY_REPLAY_CTA, { visibleOnly: true })[0]!.click();
      expect(gsm.phase).toBe('CINEMATIC_INTRO');
      expect(boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    } finally {
      unsubscribe();
      hud.dispose();
      menus.dispose();
      gsm.dispose();
      audioManager.dispose();
      debugBridge.dispose();
      cleanup();
    }
  });
});
