// src/types/game.ts

export type GamePhase =
  | 'TITLE'
  | 'CINEMATIC_INTRO'
  | 'PHASE_1'
  | 'CINEMATIC_TRANSITION'
  | 'PHASE_2'
  | 'CINEMATIC_FINISHER'
  | 'VICTORY';

export type RendererBackend = 'webgpu' | 'webgl2';
export type ModelType = 'glb';
export type RankGrade = 'SSS' | 'SS' | 'S' | 'A';
export type ComboStep = 0 | 1 | 2 | 3 | 4;

export type SlashColorPreset =
  | 'ink_gold'
  | 'azure_cyan'
  | 'crimson_gold'
  | 'celestial_white';

export type BgmState =
  | 'title'
  | 'intro'
  | 'phase1'
  | 'transition'
  | 'phase2'
  | 'finisher'
  | 'victory';

export type Vec3Tuple = [number, number, number];

/** Structural match for THREE.Vector3 and plain { x, y, z } literals without runtime Three.js dependency. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type SfxId =
  // 4-hit basic combo slashes
  | 'sword_slash_1'
  | 'sword_slash_2'
  | 'sword_slash_3'
  | 'sword_slash_4'
  // Hit impacts
  | 'impact_light'
  | 'impact_heavy'
  | 'impact_counter_crit'
  // Dodge & Bullet-Time
  | 'dodge_whoosh'
  | 'perfect_dodge_chime'
  // Active Skills 1, 2, 3
  | 'skill1_phantom_dash'
  | 'skill2_cleave_charge'
  | 'skill2_cleave_slam'
  | 'skill3_timestop_snap'
  | 'skill3_reality_slash'
  | 'skill3_detonation'
  // Posture Break
  | 'posture_break'
  // Boss Actions
  | 'boss_roar'
  | 'boss_slam'
  | 'boss_lightning'
  | 'boss_sweep'
  // Sustain & UI
  | 'lotus_ward'
  | 'shield_recharge'
  | 'heal_chime'
  | 'ui_click';

export interface GamePerfSnapshot {
  drawCalls: number;
  triangles: number;
  frameCalls: number;
  cpuTickMs: number;
  fps: number;
}

export interface GameDebugSnapshot {
  phase: GamePhase;
  paused: boolean;
  rendererBackend: RendererBackend;
  elapsedCombatSeconds: number;
  timeScale: number; // 1.0 normal, ~0.25 bullet-time, 0.0 skill-3 time-stop (or hitstop)
  bulletTimeActive: boolean;
  skill3Active: boolean;
  player: {
    hp: number;
    maxHp: number;
    shield: number;
    maxShield: number;
    qi: number; // 0..100 Awakening / Ultimate energy
    maxQi: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    comboStep: ComboStep;
    comboCount: number; // Total hit streak
    isDodging: boolean;
    invulnerable: boolean; // True during i-frames / Skill 1 dash / Skill 3 / Lotus Ward
    skillCooldowns: {
      skill1: number; // Seconds remaining
      skill2: number;
      skill3: number;
      dodge: number;
    };
    modelType: ModelType; // Must confirm loaded skeletal GLB, never primitive fallback
    activeClip: string;
  };
  boss: {
    hp: number;
    maxHp: number;
    hpRatio: number; // 0..1
    posture: number;
    maxPosture: number;
    postureRatio: number; // 0..1
    staggered: boolean;
    staggerRemaining: number;
    invulnerable: boolean; // True during cinematics
    currentAttack: string | null;
    attackTelegraphActive: boolean;
    position: Vec3Tuple;
    modelType: ModelType;
    activeClip: string;
  };
  stats: {
    totalDamageDealt: number;
    damageTaken: number;
    perfectDodges: number;
    postureBreaks: number;
    maxCombo: number;
    rank: RankGrade;
  };
  audio: {
    unlocked: boolean;
    muted: boolean;
    activeBgmState: string;
    lastSfx: string | null;
    errorCount: number;
  };
  errors: string[]; // Captured runtime/shader/asset errors
  perf?: GamePerfSnapshot;
}

export interface GameDebugAPI {
  getState(): GameDebugSnapshot;
  // Deterministic test-only hooks (must NOT auto-run during normal play):
  setBossHp(hp: number): void; // Triggers 55% or 0% phase check cleanly
  setBossPosture(posture: number): void; // Allows deterministic stagger verification
  readyAllSkills(): void; // Resets player skill CDs + fills Qi
  triggerBossTestAttack(attackId?: string): void; // Forces immediate telegraphed Boss swing
  skipCinematic(): void; // Advances active intro/transition/finisher cinematic
  setPlayerDamageMultiplier(mult: number): void; // Optional fast-run pacing helper for E2E
}

export type DebugTestHooks = Partial<Omit<GameDebugAPI, 'getState'>>;

export type SkillSlotId = 'dodge' | 'skill1' | 'skill2' | 'skill3';

export interface HudSkillSlotSnapshot {
  id: SkillSlotId;
  keyLabel: string;
  name: string;
  cooldownRemaining: number;
  cooldownTotal: number;
  ready: boolean;
  active: boolean;
  qiRequired: number;
  qiSufficient: boolean;
}

export interface HudCalloutSnapshot {
  id: number;
  text: string;
  tone: 'gold' | 'cyan' | 'crimson';
  remaining: number;
  duration: number;
}

export interface HudBannerSnapshot {
  title: string;
  subtitle?: string;
  accent: 'act1' | 'act2' | 'finisher';
  visible: boolean;
}

export interface HudSnapshot {
  phase: GamePhase;
  paused: boolean;
  pointerLocked: boolean;
  rendererBackend: RendererBackend;
  testMode: boolean;
  cinematicSkippable: boolean;
  introProgress?: number;
  banner: HudBannerSnapshot | null;
  boss: {
    visible: boolean;
    name: string;
    hp: number;
    maxHp: number;
    hpRatio: number;
    posture: number;
    maxPosture: number;
    postureRatio: number;
    staggered: boolean;
    staggerRemaining: number;
  };
  player: {
    visible: boolean;
    hp: number;
    maxHp: number;
    hpRatio: number;
    shield: number;
    maxShield: number;
    shieldRatio: number;
    qi: number;
    maxQi: number;
    qiRatio: number;
    comboCount: number;
    comboTimerRatio: number;
    bulletTimeActive: boolean;
    bulletTimeRemaining: number;
    skill3Active: boolean;
    lotusWardReady: boolean;
    lotusWardCooldown: number;
  };
  skills: readonly HudSkillSlotSnapshot[];
  callouts: readonly HudCalloutSnapshot[];
  audio: {
    unlocked: boolean;
    muted: boolean;
    masterVolume: number;
  };
  stats: {
    clearTimeSeconds: number;
    totalDamageDealt: number;
    damageTaken: number;
    perfectDodges: number;
    postureBreaks: number;
    maxCombo: number;
    rank: RankGrade;
  };
}

export interface ComboStepTuning {
  readonly step: 1 | 2 | 3 | 4;
  readonly durationSeconds: number;
  readonly damage: number;
  readonly postureDamage: number;
  readonly qiGain: number;
  readonly hitstopMs: number;
  readonly healAmount: number;
  readonly slashPreset: SlashColorPreset;
}

export type BossAttackId =
  // Phase 1
  | 'abyssal_sweep'
  | 'shattered_earth_slam'
  | 'phantom_thrust'
  | 'temple_shockwave'
  // Phase 2
  | 'twin_abyssal_cleave'
  | 'cataclysmic_leap_slam'
  | 'heavenfall_pillars'
  | 'cross_slash_wave';

export interface BossAttackTuning {
  readonly id: BossAttackId;
  readonly phase: 1 | 2;
  readonly telegraphType: 'arc' | 'ring' | 'line';
  readonly windupSeconds: number;
  readonly activeSeconds: number;
  readonly recoverySeconds: number;
  readonly damage: number;
  readonly radius: number;
}

export interface CombatTuning {
  // Arena & Simulation
  readonly arenaRadius: number;
  readonly actorSeparationRadius: number;
  readonly maxDeltaSeconds: number;
  readonly playerMoveSpeed: number;

  // Boss Core
  readonly bossMaxHp: number;
  readonly bossPhase2ThresholdRatio: number;
  readonly bossPhase2HpThreshold: number;
  readonly bossMaxPosture: number;
  readonly bossStaggerDurationSeconds: number;
  readonly bossStaggerDamageMultiplier: number;
  readonly bossDamageMin: number;
  readonly bossDamageMax: number;
  readonly bossScale: number;

  // Player Health, Shield & Sustain
  readonly playerMaxHp: number;
  readonly playerMaxShield: number;
  readonly shieldRegenRatePerSec: number;
  readonly shieldRegenDelaySeconds: number;
  readonly playerMaxQi: number;
  readonly playerInitialQi: number;
  readonly playerPostHitGraceSeconds: number;
  readonly combo4HealAmount: number;
  readonly perfectDodgeHealAmount: number;
  readonly perfectDodgeShieldRestore: number;
  readonly perfectDodgeQiRestore: number;
  readonly skill3HealAmount: number;
  readonly lowHpThreshold: number;
  readonly lowHpLotusRegenPerSec: number;
  readonly lotusWardCooldownSeconds: number;
  readonly lotusWardHealRatio: number;
  readonly lotusWardInvulnSeconds: number;

  // 4-Hit Basic Combo
  readonly comboResetWindowSeconds: number;
  readonly comboSteps: readonly [
    ComboStepTuning,
    ComboStepTuning,
    ComboStepTuning,
    ComboStepTuning,
  ];

  // Dodge & Bullet-Time
  readonly dodgeDistance: number;
  readonly dodgeDurationSeconds: number;
  readonly dodgeIFrameSeconds: number;
  readonly dodgeCooldownSeconds: number;
  readonly perfectDodgeWindowSeconds: number;
  readonly perfectDodgeProximityMargin: number;
  readonly bulletTimeDurationSeconds: number;
  readonly bulletTimeWorldScale: number;
  readonly bulletTimeCounterMultiplier: number;

  // Active Skills
  readonly skill1CooldownSeconds: number;
  readonly skill1MaxDashDistance: number;
  readonly skill1HitCount: number;
  readonly skill1DamagePerHit: number;
  readonly skill1TotalDamage: number;
  readonly skill1PostureDamage: number;
  readonly skill1QiGain: number;

  readonly skill2CooldownSeconds: number;
  readonly skill2Damage: number;
  readonly skill2PostureDamage: number;
  readonly skill2QiGain: number;
  readonly skill2HitstopMs: number;

  readonly skill3CooldownSeconds: number;
  readonly skill3QiCost: number;
  readonly skill3TimeStopDurationSeconds: number;
  readonly skill3WorldTimeScale: number;
  readonly skill3SlashCount: number;
  readonly skill3TotalDamage: number;
  readonly skill3PostureDamage: number;

  // Cinematics
  readonly introDurationSeconds: number;
  readonly transitionDurationSeconds: number;
  readonly finisherDurationSeconds: number;

  // Boss Attacks
  readonly bossAttacks: readonly BossAttackTuning[];
}

export const COMBAT_TUNING: CombatTuning = {
  arenaRadius: 25.0,
  actorSeparationRadius: 1.6,
  maxDeltaSeconds: 0.05,
  playerMoveSpeed: 8.5,

  bossMaxHp: 40_000,
  bossPhase2ThresholdRatio: 0.55,
  bossPhase2HpThreshold: 22_000,
  bossMaxPosture: 1_000,
  bossStaggerDurationSeconds: 5.0,
  bossStaggerDamageMultiplier: 1.6,
  bossDamageMin: 60,
  bossDamageMax: 120,
  bossScale: 3.2,

  playerMaxHp: 1_000,
  playerMaxShield: 250,
  shieldRegenRatePerSec: 45,
  shieldRegenDelaySeconds: 3.5,
  playerMaxQi: 100,
  playerInitialQi: 100,
  playerPostHitGraceSeconds: 0.6,
  combo4HealAmount: 25,
  perfectDodgeHealAmount: 50,
  perfectDodgeShieldRestore: 80,
  perfectDodgeQiRestore: 20,
  skill3HealAmount: 120,
  lowHpThreshold: 500,
  lowHpLotusRegenPerSec: 15,
  lotusWardCooldownSeconds: 30.0,
  lotusWardHealRatio: 0.35,
  lotusWardInvulnSeconds: 1.5,

  comboResetWindowSeconds: 0.55,
  comboSteps: [
    {
      step: 1,
      durationSeconds: 0.32,
      damage: 160,
      postureDamage: 40,
      qiGain: 6,
      hitstopMs: 30,
      healAmount: 0,
      slashPreset: 'ink_gold',
    },
    {
      step: 2,
      durationSeconds: 0.34,
      damage: 190,
      postureDamage: 45,
      qiGain: 7,
      hitstopMs: 35,
      healAmount: 0,
      slashPreset: 'ink_gold',
    },
    {
      step: 3,
      durationSeconds: 0.4,
      damage: 240,
      postureDamage: 60,
      qiGain: 9,
      hitstopMs: 45,
      healAmount: 0,
      slashPreset: 'azure_cyan',
    },
    {
      step: 4,
      durationSeconds: 0.52,
      damage: 380,
      postureDamage: 110,
      qiGain: 15,
      hitstopMs: 65,
      healAmount: 25,
      slashPreset: 'ink_gold',
    },
  ],

  dodgeDistance: 5.5,
  dodgeDurationSeconds: 0.52,
  dodgeIFrameSeconds: 0.42,
  dodgeCooldownSeconds: 0.25,
  perfectDodgeWindowSeconds: 0.35,
  perfectDodgeProximityMargin: 1.2,
  bulletTimeDurationSeconds: 2.0,
  bulletTimeWorldScale: 0.25,
  bulletTimeCounterMultiplier: 1.4,

  skill1CooldownSeconds: 6.0,
  skill1MaxDashDistance: 12.0,
  skill1HitCount: 4,
  skill1DamagePerHit: 240,
  skill1TotalDamage: 960,
  skill1PostureDamage: 140,
  skill1QiGain: 16,

  skill2CooldownSeconds: 10.0,
  skill2Damage: 780,
  skill2PostureDamage: 420,
  skill2QiGain: 18,
  skill2HitstopMs: 85,

  skill3CooldownSeconds: 20.0,
  skill3QiCost: 50,
  skill3TimeStopDurationSeconds: 2.6,
  skill3WorldTimeScale: 0.0,
  skill3SlashCount: 6,
  skill3TotalDamage: 2_400,
  skill3PostureDamage: 350,

  introDurationSeconds: 6.0,
  transitionDurationSeconds: 5.0,
  finisherDurationSeconds: 4.5,

  bossAttacks: [
    {
      id: 'abyssal_sweep',
      phase: 1,
      telegraphType: 'arc',
      windupSeconds: 1.1,
      activeSeconds: 0.28,
      recoverySeconds: 0.9,
      damage: 75,
      radius: 6.8,
    },
    {
      id: 'shattered_earth_slam',
      phase: 1,
      telegraphType: 'ring',
      windupSeconds: 1.3,
      activeSeconds: 0.3,
      recoverySeconds: 1.1,
      damage: 100,
      radius: 5.8,
    },
    {
      id: 'phantom_thrust',
      phase: 1,
      telegraphType: 'line',
      windupSeconds: 1.0,
      activeSeconds: 0.32,
      recoverySeconds: 0.85,
      damage: 80,
      radius: 10.5,
    },
    {
      id: 'temple_shockwave',
      phase: 1,
      telegraphType: 'ring',
      windupSeconds: 1.4,
      activeSeconds: 0.45,
      recoverySeconds: 1.0,
      damage: 90,
      radius: 11.0,
    },
    {
      id: 'twin_abyssal_cleave',
      phase: 2,
      telegraphType: 'arc',
      windupSeconds: 0.95,
      activeSeconds: 0.45,
      recoverySeconds: 0.75,
      damage: 85,
      radius: 7.4,
    },
    {
      id: 'cataclysmic_leap_slam',
      phase: 2,
      telegraphType: 'ring',
      windupSeconds: 1.15,
      activeSeconds: 0.35,
      recoverySeconds: 0.95,
      damage: 120,
      radius: 7.5,
    },
    {
      id: 'heavenfall_pillars',
      phase: 2,
      telegraphType: 'ring',
      windupSeconds: 1.1,
      activeSeconds: 0.4,
      recoverySeconds: 0.85,
      damage: 95,
      radius: 4.5,
    },
    {
      id: 'cross_slash_wave',
      phase: 2,
      telegraphType: 'line',
      windupSeconds: 0.9,
      activeSeconds: 0.5,
      recoverySeconds: 0.8,
      damage: 85,
      radius: 14.0,
    },
  ],
} as const;

/** Authoritative 100% English UI Copy Catalog (R4). Zero CJK characters allowed. */
export const UI_COPY = {
  TITLE_MAIN: 'BLACK MYTH: CELESTIAL SEVERANCE',
  TITLE_SUBTITLE: 'Trial of the Fallen Titan',
  TITLE_START_CTA: 'BEGIN TRIAL',
  TITLE_CONTROLS:
    'WASD Move · Mouse Camera · LMB / J Attack · Space / Shift Dodge · 1 / 2 / 3 Skills · Esc Pause',

  BOSS_NAME: 'XUANMING, FALLEN TITAN OF THE ABYSS',
  BOSS_HP_LABEL: 'HP',
  BOSS_POSTURE_LABEL: 'POSTURE',

  BANNER_ACT_1: 'ACT I — TRIAL OF THE BLADE',
  BANNER_ACT_2: 'ACT II — CLIMAX OF THE GODS',
  BANNER_FINISHER: 'CELESTIAL EXECUTION',

  PLAYER_HP_LABEL: 'HP',
  PLAYER_SHIELD_LABEL: 'SHIELD',
  PLAYER_QI_LABEL: 'AWAKENING',
  PLAYER_COMBO_SUFFIX: 'HITS',

  SKILL_COMBO_NAME: 'Flowing Combo',
  SKILL_DODGE_NAME: 'Shadow Step',
  SKILL_1_NAME: 'Phantom Dash',
  SKILL_2_NAME: 'Heaven Cleave',
  SKILL_3_NAME: 'Celestial Severance',

  CALLOUT_PERFECT_DODGE: 'PERFECT DODGE · BULLET TIME',
  CALLOUT_POSTURE_BROKEN: 'POSTURE BROKEN!',
  CALLOUT_AWAKENING_READY: 'AWAKENING READY',
  CALLOUT_LOTUS_WARD: 'LOTUS WARD ACTIVATED',
  CALLOUT_COUNTER_CRIT: 'COUNTER CRIT',

  CAMERA_HINT: 'Click arena to lock camera · Press ESC to pause',

  PAUSE_TITLE: 'PAUSED',
  PAUSE_RESUME: 'RESUME',
  PAUSE_MUTE: 'MUTE AUDIO',
  PAUSE_UNMUTE: 'UNMUTE AUDIO',
  PAUSE_VOLUME: 'MASTER VOLUME',
  PAUSE_RESTART: 'RESTART TRIAL',

  VICTORY_HEADER: 'VICTORY — TITAN VANQUISHED',
  VICTORY_RANK_LABEL: 'RANK',
  VICTORY_STAT_TIME: 'CLEAR TIME',
  VICTORY_STAT_DAMAGE: 'DAMAGE DEALT',
  VICTORY_STAT_DODGES: 'PERFECT DODGES',
  VICTORY_STAT_POSTURES: 'POSTURE BREAKS',
  VICTORY_STAT_COMBO: 'MAX COMBO',
  VICTORY_STAT_TAKEN: 'DAMAGE TAKEN',
  VICTORY_REPLAY_CTA: 'PLAY AGAIN',
} as const;

// ---------------------------------------------------------------------------
// Cross-Milestone Subsystem Contracts (M1 <-> M2 <-> M3 <-> M4)
// ---------------------------------------------------------------------------

export interface RendererInterface {
  readonly backend: RendererBackend;
  init(container: HTMLElement): Promise<void>;
  render(): void;
  resize(width?: number, height?: number): void;
  dispose?(): void;
}

export interface ArenaInterface {
  readonly arenaRadius: number; // 25.0
  /** 0 = Act I dark moonlit twilight, 1 = Act II crimson-gold storm */
  setPhaseIntensity(t: number): void;
  triggerLightningStrike(pos: Vec3Like): void;
  update?(dt: number, elapsedSeconds: number): void;
  reset?(): void;
}

export interface TelegraphRingParams {
  center: Vec3Like;
  innerRadius: number;
  outerRadius: number;
  progress: number; // 0..1
  color?: 'crimson_gold' | 'amber' | 'violet';
}

export interface TelegraphArcParams {
  origin: Vec3Like;
  direction: Vec3Like;
  radius: number;
  arcAngleRad: number;
  progress: number; // 0..1
  color?: 'crimson_gold' | 'amber';
}

export interface TelegraphLineParams {
  origin: Vec3Like;
  direction: Vec3Like;
  length: number;
  width: number;
  progress: number; // 0..1
  color?: 'crimson_gold' | 'amber';
}

export interface VfxInterface {
  spawnSlashArc(
    origin: Vec3Like,
    dir: Vec3Like,
    angle: number,
    colorPreset: SlashColorPreset,
    scale: number,
  ): void;
  spawnImpactBurst(pos: Vec3Like, heavy: boolean): void;
  showTelegraphRing(id: string, params: TelegraphRingParams): void;
  showTelegraphArc(id: string, params: TelegraphArcParams): void;
  showTelegraphLine(id: string, params: TelegraphLineParams): void;
  clearTelegraph(id: string): void;
  clearAllTelegraphs?(): void;
  triggerPostureBreakBurst(pos: Vec3Like): void;
  triggerSkill3Domain(active: boolean, targetPos?: Vec3Like): void;
  triggerLotusWardBurst(pos: Vec3Like): void;
  spawnStaffDragSparks?(pos: Vec3Like, dirX: number, dirZ: number): void;
  spawnDodgePhantomTrail?(pos: Vec3Like, dirX: number, dirZ: number): void;
  spawnBossWingCrescent?(
    origin: Vec3Like,
    dir: Vec3Like,
    radius?: number,
    tiltRad?: number,
  ): void;
  spawnBossMeteorSlam?(center: Vec3Like, radius?: number): void;
  updateBossChestBeamCharge?(
    chestPos: Vec3Like,
    progress: number,
    active: boolean,
  ): void;
  fireBossChestBeam?(chestPos: Vec3Like, dir: Vec3Like): void;
  spawnBossHeavenfallPillars?(center: Vec3Like, spreadRadius?: number): void;
  spawnBossCrossBladeStorm?(origin: Vec3Like, dir: Vec3Like): void;
  spawnPlayerHitSparks?(
    pos: Vec3Like,
    knockDirX: number,
    knockDirZ: number,
    heavy: boolean,
  ): void;
  spawnSkill1CloneBlitz?(
    startPos: Vec3Like,
    endPos: Vec3Like,
    bossPos: Vec3Like,
  ): void;
  triggerSkill1CloneSlash?(bossPos: Vec3Like, hitIndex: number): void;
  spawnSkill2PillarAscent?(playerPos: Vec3Like, bossPos: Vec3Like): void;
  spawnSkill2DragonPillarSlam?(playerPos: Vec3Like, bossPos: Vec3Like): void;
  updateSkill3GreatSageDomain?(
    active: boolean,
    playerPos?: Vec3Like,
    bossPos?: Vec3Like,
    facingYaw?: number,
  ): void;
  triggerSkill3CloneBlitzSlash?(bossPos: Vec3Like, slashIndex: number): void;
  triggerSkill3DharmakayaSlam?(playerPos: Vec3Like, bossPos: Vec3Like): void;
  updateIntroCinematicVfx?(
    active: boolean,
    progress?: number,
    playerPos?: Vec3Like,
    earPos?: Vec3Like,
    bossPos?: Vec3Like,
  ): void;
  triggerIntroClashShockwave?(centerPos: Vec3Like): void;
  update?(dt: number): void;
  reset?(): void;
}

export interface AudioInterface {
  unlock(): Promise<void>;
  setBgmState(phase: GamePhase): void;
  setBulletTimeFilter(active: boolean): void;
  playSfx(id: SfxId): void;
  setMuted(muted: boolean): void;
  setMasterVolume(vol: number): void;
  getState?(): GameDebugSnapshot['audio'];
}
