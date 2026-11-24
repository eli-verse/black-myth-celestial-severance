import * as THREE from 'three';
import type { DebugBridge } from '../debug/DebugBridge.ts';
import type { TimeScaleSystem } from '../engine/TimeScaleSystem.ts';
import { BOSS_CLIPS, BossEntity } from '../entities/BossEntity.ts';
import {
  PLAYER_CLIPS,
  PlayerEntity,
  computeFinisherCameraFrame,
  computeIntroCameraFrame,
  computeSkill3CameraFrame,
  computeTitleCameraFrame,
  computeTransitionCameraFrame,
  computeVictoryCameraFrame,
  type PlayerCameraFrameOverride,
} from '../entities/PlayerEntity.ts';
import {
  COMBAT_TUNING,
  UI_COPY,
  type ArenaInterface,
  type AudioInterface,
  type GameDebugSnapshot,
  type GamePhase,
  type HudBannerSnapshot,
  type HudCalloutSnapshot,
  type HudSnapshot,
  type RankGrade,
  type RendererBackend,
  type VfxInterface,
} from '../types/game.ts';
import { CombatSystem, type PlayerInputFrame } from './CombatSystem.ts';

export interface GameStateMachineOptions {
  player: PlayerEntity;
  boss: BossEntity;
  combat?: CombatSystem;
  timeScaleSystem: TimeScaleSystem;
  arena: ArenaInterface;
  vfx: VfxInterface;
  audio: AudioInterface;
  debugBridge?: DebugBridge;
  rendererBackend?: RendererBackend;
  testMode?: boolean;
  cinematicIntroDurationSeconds?: number;
}

export type HudListener = (snapshot: HudSnapshot) => void;

const TRANSITION_LIGHTNING_THRESHOLDS = [0.22, 0.52, 0.78] as const;
const TRANSITION_LIGHTNING_OFFSETS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -6.5, z: -7.5 },
  { x: 7.0, z: -4.0 },
  { x: -2.0, z: 3.5 },
];
const MAX_ACTIVE_CALLOUTS = 4;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export class GameStateMachine {
  readonly combat: CombatSystem;

  private readonly player: PlayerEntity;
  private readonly boss: BossEntity;
  private readonly timeScaleSystem: TimeScaleSystem;
  private readonly arena: ArenaInterface;
  private readonly vfx: VfxInterface;
  private readonly audio: AudioInterface;

  private debugBridge?: DebugBridge;
  private rendererBackend: RendererBackend;
  private pointerLocked = false;
  private testMode: boolean;

  private _phase: GamePhase = 'TITLE';
  private _paused = false;
  private _elapsedCombatSeconds = 0;
  private totalElapsedSeconds = 0;
  private cinematicElapsed = 0;
  private readonly introDurationSeconds: number;
  private introBeatStep = 0;
  private transitionLightningStep = 0;

  private banner: HudBannerSnapshot | null = null;
  private bannerRemaining = 0;
  private callouts: HudCalloutSnapshot[] = [];
  private nextCalloutId = 1;

  private readonly hudListeners = new Set<HudListener>();
  private disposed = false;

  constructor(options: GameStateMachineOptions) {
    this.player = options.player;
    this.boss = options.boss;
    this.timeScaleSystem = options.timeScaleSystem;
    this.arena = options.arena;
    this.vfx = options.vfx;
    this.audio = options.audio;
    this.rendererBackend = options.rendererBackend ?? 'webgpu';
    this.testMode = options.testMode ?? false;
    this.introDurationSeconds =
      options.cinematicIntroDurationSeconds &&
      Number.isFinite(options.cinematicIntroDurationSeconds) &&
      options.cinematicIntroDurationSeconds > 0
        ? options.cinematicIntroDurationSeconds
        : COMBAT_TUNING.introDurationSeconds;

    this.combat =
      options.combat ??
      new CombatSystem({
        player: this.player,
        boss: this.boss,
        timeScaleSystem: this.timeScaleSystem,
        arena: this.arena,
        vfx: this.vfx,
        audio: this.audio,
      });

    this.combat.setCalloutHandler((text, tone, durationSeconds) => {
      this.pushCallout(text, tone, durationSeconds);
    });

    // Initialize into TITLE state
    this.boss.enterCinematic(BOSS_CLIPS.idle, { fadeSeconds: 0 });
    this.player.playClip(PLAYER_CLIPS.idle, { fadeSeconds: 0 });
    this.audio.setBgmState('TITLE');

    if (options.debugBridge) {
      this.bindDebugBridge(options.debugBridge);
    }
  }

  get phase(): GamePhase {
    return this._phase;
  }

  get paused(): boolean {
    return this._paused;
  }

  get elapsedCombatSeconds(): number {
    return this._elapsedCombatSeconds;
  }

  setRendererBackend(backend: RendererBackend): void {
    this.rendererBackend = backend;
  }

  setPointerLocked(locked: boolean): void {
    this.pointerLocked = Boolean(locked);
  }

  setTestMode(testMode: boolean): void {
    this.testMode = Boolean(testMode);
  }

  startTrial(): void {
    if (this.disposed || this._phase !== 'TITLE') {
      return;
    }
    this.enterCinematicIntro();
    this.notifyHudListeners();
  }

  restartTrial(): void {
    if (this.disposed) {
      return;
    }

    this._paused = false;
    this.setAudioPaused(false);
    this.timeScaleSystem.reset();
    this.audio.setBulletTimeFilter(false);

    this.combat.reset();
    this.player.reset();
    this.boss.reset(this.vfx);
    this.arena.reset?.();
    this.vfx.reset?.();
    this.setVfxPhaseIntensity(0);

    this._elapsedCombatSeconds = 0;
    this.cinematicElapsed = 0;
    this.transitionLightningStep = 0;
    this.callouts = [];
    this.banner = null;
    this.bannerRemaining = 0;

    this.enterCinematicIntro();
    this.notifyHudListeners();
  }

  skipCinematic(): void {
    if (this.disposed) {
      return;
    }

    if (this._phase === 'CINEMATIC_INTRO') {
      this.enterPhase1();
      this.notifyHudListeners();
    } else if (this._phase === 'CINEMATIC_TRANSITION') {
      this.enterPhase2();
      this.notifyHudListeners();
    } else if (this._phase === 'CINEMATIC_FINISHER') {
      this.enterVictory();
      this.notifyHudListeners();
    }
  }

  setPaused(paused: boolean): void {
    if (this.disposed) {
      return;
    }
    const nextPaused = Boolean(paused);
    if (nextPaused && (this._phase === 'TITLE' || this._phase === 'VICTORY')) {
      return;
    }
    this._paused = nextPaused;
    this.timeScaleSystem.setPaused(this._paused);
    this.setAudioPaused(this._paused);
    this.notifyHudListeners();
  }

  update(rawDt: number, camera: THREE.Camera, input: PlayerInputFrame): void {
    if (this.disposed) {
      return;
    }

    const safeRawDt = Number.isFinite(rawDt)
      ? Math.max(0, Math.min(rawDt, COMBAT_TUNING.maxDeltaSeconds))
      : 0;

    let cameraOverride: PlayerCameraFrameOverride | null = null;

    if (!this._paused) {
      this.totalElapsedSeconds += safeRawDt;
      this.tickBannerAndCallouts(safeRawDt);

      const step = this.timeScaleSystem.update(safeRawDt);

      switch (this._phase) {
        case 'TITLE': {
          this.player.setMoveDirection(0, 0, 0);
          this.player.update(safeRawDt, safeRawDt, this.boss.position);
          this.boss.update(
            safeRawDt,
            safeRawDt,
            null,
            this.player.position,
            this.vfx,
          );
          this.arena.update?.(safeRawDt, this.totalElapsedSeconds);
          this.vfx.update?.(safeRawDt);
          cameraOverride = computeTitleCameraFrame(this.totalElapsedSeconds);
          break;
        }

        case 'CINEMATIC_INTRO': {
          this.cinematicElapsed += safeRawDt;
          const progress = clamp01(
            this.cinematicElapsed / this.introDurationSeconds,
          );
          this.player.setMoveDirection(0, 0, 0);
          this.boss.faceTarget({ x: 0, y: 0, z: 4 });
          this.boss.updateIntroChoreography?.(progress);
          this.player.updateIntroChoreography?.(progress);

          this.player.update(safeRawDt, safeRawDt, this.boss.position);
          this.boss.update(
            safeRawDt,
            safeRawDt,
            null,
            this.player.position,
            this.vfx,
          );

          // Synchronized 4-Shot Director Audio-Visual Impact Beats:
          // Beat 0 (p >= 0.095): Shot 1 Boss Jiebo Sky-Meteor Crash & Roar!
          if (this.introBeatStep === 0 && progress >= 0.095) {
            this.introBeatStep = 1;
            this.vfx.spawnBossMeteorSlam?.(this.boss.position, 10.2);
            this.arena.triggerLightningStrike(this.boss.position);
            this.audio.playSfx('boss_slam');
            this.audio.playSfx('boss_roar');
            this.player.triggerCameraImpact?.(1.7, 0, -1, 4.6);
          }
          // Beat 1 (p >= 0.36): Shot 2 Wukong Somersault Cloud One-Knee Touchdown!
          if (this.introBeatStep === 1 && progress >= 0.36) {
            this.introBeatStep = 2;
            this.vfx.spawnImpactBurst(
              { x: this.player.position.x, y: 0.15, z: this.player.position.z },
              true,
            );
            this.arena.triggerLightningStrike({ x: -3.2, y: 0, z: 6.5 });
            this.audio.playSfx('impact_heavy');
            this.player.triggerCameraImpact?.(1.25, 0, 1, 3.0);
          }
          // Beat 2 (p >= 0.69): Shot 3 Ear-Needle Conjure -> Ruyi Jingu Bang Slam + "呔！！"!
          if (this.introBeatStep === 2 && progress >= 0.69) {
            this.introBeatStep = 3;
            this.vfx.spawnSkill2PillarAscent?.(
              this.player.position,
              this.boss.position,
            );
            this.vfx.spawnImpactBurst(
              {
                x: this.player.position.x - 0.35,
                y: 0.1,
                z: this.player.position.z - 0.45,
              },
              true,
            );
            this.audio.playSfx('skill2_cleave_charge');
            this.audio.playSfx('skill3_timestop_snap');
            this.player.triggerCameraImpact?.(1.45, 0, -1, 3.8);
          }
          // Beat 3 (p >= 0.80): Shot 4 Twin Golden-Dragon vs Blood-Crimson Clash Shockwave!
          if (this.introBeatStep === 3 && progress >= 0.8) {
            this.introBeatStep = 4;
            this.vfx.triggerIntroClashShockwave?.({ x: 0, y: 0, z: -0.5 });
            this.arena.triggerLightningStrike({ x: 0, y: 0, z: -0.5 });
            this.audio.playSfx('posture_break');
            this.player.triggerCameraImpact?.(1.5, 0, -1, 4.2);
          }

          const earPos = this.player.getRightEarWorldPosition?.();
          this.vfx.updateIntroCinematicVfx?.(
            true,
            progress,
            this.player.position,
            earPos,
            this.boss.position,
          );

          this.arena.update?.(safeRawDt, this.totalElapsedSeconds);
          this.vfx.update?.(safeRawDt);
          cameraOverride = computeIntroCameraFrame(
            progress,
            this.player.position,
            this.boss.position,
          );

          if (this.cinematicElapsed >= this.introDurationSeconds) {
            this.enterPhase1();
          }
          break;
        }

        case 'PHASE_1':
        case 'PHASE_2': {
          const combatPhase: 1 | 2 = this._phase === 'PHASE_1' ? 1 : 2;
          this._elapsedCombatSeconds += safeRawDt;

          this.combat.update(
            step.playerDt,
            step.worldDt,
            safeRawDt,
            camera,
            input,
            combatPhase,
          );
          const effectiveWorldDt = this.combat.skill3Active ? 0 : step.worldDt;
          this.boss.update(
            effectiveWorldDt,
            safeRawDt,
            combatPhase,
            this.player.position,
            this.vfx,
            this.combat.getBossTickCallbacks(),
          );
          this.combat.postBossTick(combatPhase);

          this.arena.update?.(effectiveWorldDt, this.totalElapsedSeconds);
          const vfxDt = this.combat.skill3Active ? safeRawDt : step.worldDt;
          this.vfx.update?.(vfxDt);

          if (
            this._phase === 'PHASE_1' &&
            this.boss.hp <= COMBAT_TUNING.bossPhase2HpThreshold
          ) {
            this.boss.hp = COMBAT_TUNING.bossPhase2HpThreshold;
            this.enterCinematicTransition();
            cameraOverride = computeTransitionCameraFrame(0, this.boss.position);
          } else if (this._phase === 'PHASE_2' && this.boss.hp <= 0) {
            this.boss.hp = 0;
            this.enterCinematicFinisher();
            cameraOverride = computeFinisherCameraFrame(
              0,
              this.player.position,
              this.boss.position,
            );
          } else if (this.combat.skill3Active) {
            cameraOverride = computeSkill3CameraFrame(
              this.combat.getSkill3Elapsed(),
              this.player.position,
              this.boss.position,
            );
          }
          break;
        }

        case 'CINEMATIC_TRANSITION': {
          this.cinematicElapsed += safeRawDt;
          const progress = clamp01(
            this.cinematicElapsed / COMBAT_TUNING.transitionDurationSeconds,
          );
          this.arena.setPhaseIntensity(progress);
          this.setVfxPhaseIntensity(progress);
          this.boss.setPhaseIntensity(progress);

          while (
            this.transitionLightningStep < TRANSITION_LIGHTNING_THRESHOLDS.length &&
            progress >= TRANSITION_LIGHTNING_THRESHOLDS[this.transitionLightningStep]!
          ) {
            const offset =
              TRANSITION_LIGHTNING_OFFSETS[this.transitionLightningStep]!;
            this.transitionLightningStep += 1;
            this.arena.triggerLightningStrike({
              x: this.boss.position.x + offset.x,
              y: 0,
              z: this.boss.position.z + offset.z,
            });
            this.audio.playSfx('boss_lightning');
          }

          this.player.setMoveDirection(0, 0, 0);
          this.player.faceTarget(this.boss.position);
          this.boss.faceTarget(this.player.position);
          this.player.update(safeRawDt, safeRawDt, this.boss.position);
          this.boss.update(
            safeRawDt,
            safeRawDt,
            null,
            this.player.position,
            this.vfx,
          );
          this.arena.update?.(safeRawDt, this.totalElapsedSeconds);
          this.vfx.update?.(safeRawDt);
          cameraOverride = computeTransitionCameraFrame(
            progress,
            this.boss.position,
          );

          if (this.cinematicElapsed >= COMBAT_TUNING.transitionDurationSeconds) {
            this.enterPhase2();
          }
          break;
        }

        case 'CINEMATIC_FINISHER': {
          this.cinematicElapsed += safeRawDt;
          const progress = clamp01(
            this.cinematicElapsed / COMBAT_TUNING.finisherDurationSeconds,
          );
          const dissolve =
            Math.max(0, (progress - 0.35) / 0.65) * 0.65;
          this.boss.setDissolve(dissolve);

          this.player.setMoveDirection(0, 0, 0);
          this.player.update(safeRawDt, safeRawDt, this.boss.position);
          this.boss.update(
            safeRawDt,
            safeRawDt,
            null,
            this.player.position,
            this.vfx,
          );
          this.arena.update?.(safeRawDt, this.totalElapsedSeconds);
          this.vfx.update?.(safeRawDt);
          cameraOverride = computeFinisherCameraFrame(
            progress,
            this.player.position,
            this.boss.position,
          );

          if (this.cinematicElapsed >= COMBAT_TUNING.finisherDurationSeconds) {
            this.enterVictory();
          }
          break;
        }

        case 'VICTORY': {
          this.player.setMoveDirection(0, 0, 0);
          this.player.update(safeRawDt, safeRawDt, this.boss.position);
          this.boss.update(
            safeRawDt,
            safeRawDt,
            null,
            this.player.position,
            this.vfx,
          );
          this.arena.update?.(safeRawDt, this.totalElapsedSeconds);
          this.vfx.update?.(safeRawDt);
          cameraOverride = computeVictoryCameraFrame(
            this.totalElapsedSeconds,
            this.player.position,
          );
          break;
        }
      }
    } else {
      cameraOverride = this.getCameraOverrideForCurrentState();
    }

    this.player.updateCamera(
      camera,
      this._paused ? 0 : safeRawDt,
      cameraOverride,
    );
    this.notifyHudListeners();
  }

  bindDebugBridge(bridge: DebugBridge): void {
    this.debugBridge = bridge;
    if (bridge.isTestMode()) {
      this.testMode = true;
    }

    bridge.setSnapshotProvider(() =>
      this.getDebugSnapshot(this.rendererBackend, this.pointerLocked),
    );
    bridge.setHooks({
      setBossHp: (hp: number): void => {
        if (!Number.isFinite(hp)) {
          return;
        }
        const maxAllowedHp =
          this._phase === 'PHASE_2'
            ? COMBAT_TUNING.bossPhase2HpThreshold
            : COMBAT_TUNING.bossMaxHp;
        const clamped = Math.max(0, Math.min(maxAllowedHp, hp));

        if (this._phase === 'PHASE_1') {
          if (clamped <= COMBAT_TUNING.bossPhase2HpThreshold) {
            this.boss.hp = COMBAT_TUNING.bossPhase2HpThreshold;
            this.enterCinematicTransition();
          } else {
            this.boss.hp = clamped;
          }
          this.notifyHudListeners();
        } else if (this._phase === 'PHASE_2') {
          if (clamped <= 0) {
            this.boss.hp = 0;
            this.enterCinematicFinisher();
          } else {
            this.boss.hp = clamped;
          }
          this.notifyHudListeners();
        }
      },
      setBossPosture: (posture: number): void => {
        if (this._phase === 'PHASE_1' || this._phase === 'PHASE_2') {
          this.combat.setBossPosture(posture);
          this.notifyHudListeners();
        }
      },
      readyAllSkills: (): void => {
        this.combat.readyAllSkills();
        this.notifyHudListeners();
      },
      triggerBossTestAttack: (attackId?: string): void => {
        if (this._phase === 'PHASE_1' || this._phase === 'PHASE_2') {
          this.boss.triggerTestAttack(attackId, this.player.position, this.vfx);
          this.notifyHudListeners();
        }
      },
      skipCinematic: (): void => {
        this.skipCinematic();
      },
      setPlayerDamageMultiplier: (mult: number): void => {
        this.combat.setPlayerDamageMultiplier(mult);
      },
    });
  }

  getDebugSnapshot(
    rendererBackend: RendererBackend = this.rendererBackend,
    pointerLocked = this.pointerLocked,
  ): GameDebugSnapshot {
    this.rendererBackend = rendererBackend;
    this.pointerLocked = pointerLocked;

    const bossPos = this.boss.position;
    const combatStats = this.combat.getStatsSnapshot();
    const audioState = this.audio.getState?.() ?? {
      unlocked: false,
      muted: false,
      activeBgmState: 'title',
      lastSfx: null,
      errorCount: 0,
    };

    return {
      phase: this._phase,
      paused: this._paused,
      rendererBackend,
      elapsedCombatSeconds: this._elapsedCombatSeconds,
      timeScale: this.timeScaleSystem.worldTimeScale,
      bulletTimeActive: this.timeScaleSystem.bulletTimeActive,
      skill3Active:
        this.combat.skill3Active || this.timeScaleSystem.skill3Active,
      player: this.combat.getPlayerDebugSnapshot(),
      boss: {
        hp: this.boss.hp,
        maxHp: this.boss.maxHp,
        hpRatio: this.boss.maxHp > 0 ? clamp01(this.boss.hp / this.boss.maxHp) : 0,
        posture: this.boss.posture,
        maxPosture: this.boss.maxPosture,
        postureRatio:
          this.boss.maxPosture > 0
            ? clamp01(this.boss.posture / this.boss.maxPosture)
            : 0,
        staggered: this.boss.staggered,
        staggerRemaining: this.boss.staggerRemaining,
        invulnerable: this.boss.invulnerable,
        currentAttack: this.boss.currentAttack,
        attackTelegraphActive: this.boss.attackTelegraphActive,
        position: [bossPos.x, bossPos.y, bossPos.z],
        modelType: this.boss.modelType,
        activeClip: this.boss.activeClip,
      },
      stats: {
        ...combatStats,
        rank: this.computeRank(),
      },
      audio: {
        unlocked: audioState.unlocked,
        muted: audioState.muted,
        activeBgmState: audioState.activeBgmState,
        lastSfx: audioState.lastSfx,
        errorCount: audioState.errorCount,
      },
      errors: this.debugBridge ? [...this.debugBridge.getErrors()] : [],
    };
  }

  getHudSnapshot(
    rendererBackend: RendererBackend = this.rendererBackend,
    pointerLocked = this.pointerLocked,
    testMode = this.testMode,
  ): HudSnapshot {
    this.rendererBackend = rendererBackend;
    this.pointerLocked = pointerLocked;
    this.testMode = testMode;

    const playerSnap = this.combat.getPlayerDebugSnapshot();
    const sustain = this.combat.getHudSustainState();
    const combatStats = this.combat.getStatsSnapshot();
    const audioState = this.audio.getState?.() ?? {
      unlocked: false,
      muted: false,
      activeBgmState: 'title',
      lastSfx: null,
      errorCount: 0,
    };

    return {
      phase: this._phase,
      paused: this._paused,
      pointerLocked,
      rendererBackend,
      testMode,
      cinematicSkippable:
        this._phase === 'CINEMATIC_INTRO' ||
        this._phase === 'CINEMATIC_TRANSITION' ||
        this._phase === 'CINEMATIC_FINISHER',
      introProgress:
        this._phase === 'CINEMATIC_INTRO'
          ? clamp01(this.cinematicElapsed / this.introDurationSeconds)
          : 0,
      banner: this.banner ? { ...this.banner } : null,
      boss: {
        visible: this._phase !== 'TITLE' && this._phase !== 'VICTORY',
        name: UI_COPY.BOSS_NAME,
        hp: this.boss.hp,
        maxHp: this.boss.maxHp,
        hpRatio: this.boss.maxHp > 0 ? clamp01(this.boss.hp / this.boss.maxHp) : 0,
        posture: this.boss.posture,
        maxPosture: this.boss.maxPosture,
        postureRatio:
          this.boss.maxPosture > 0
            ? clamp01(this.boss.posture / this.boss.maxPosture)
            : 0,
        staggered: this.boss.staggered,
        staggerRemaining: this.boss.staggerRemaining,
      },
      player: {
        visible:
          this._phase === 'CINEMATIC_INTRO' ||
          this._phase === 'PHASE_1' ||
          this._phase === 'CINEMATIC_TRANSITION' ||
          this._phase === 'PHASE_2',
        hp: playerSnap.hp,
        maxHp: playerSnap.maxHp,
        hpRatio:
          playerSnap.maxHp > 0 ? clamp01(playerSnap.hp / playerSnap.maxHp) : 0,
        shield: playerSnap.shield,
        maxShield: playerSnap.maxShield,
        shieldRatio:
          playerSnap.maxShield > 0
            ? clamp01(playerSnap.shield / playerSnap.maxShield)
            : 0,
        qi: playerSnap.qi,
        maxQi: playerSnap.maxQi,
        qiRatio:
          playerSnap.maxQi > 0 ? clamp01(playerSnap.qi / playerSnap.maxQi) : 0,
        comboCount: playerSnap.comboCount,
        comboTimerRatio: sustain.comboTimerRatio,
        bulletTimeActive: this.timeScaleSystem.bulletTimeActive,
        bulletTimeRemaining: this.timeScaleSystem.bulletTimeRemaining,
        skill3Active:
          this.combat.skill3Active || this.timeScaleSystem.skill3Active,
        lotusWardReady: sustain.lotusWardReady,
        lotusWardCooldown: sustain.lotusWardCooldown,
      },
      skills: this.combat.getHudSkillSlots(),
      callouts: this.callouts.map((c) => ({ ...c })),
      audio: {
        unlocked: audioState.unlocked,
        muted: audioState.muted,
        masterVolume: this.getAudioMasterVolume(),
      },
      stats: {
        clearTimeSeconds: this._elapsedCombatSeconds,
        ...combatStats,
        rank: this.computeRank(),
      },
    };
  }

  subscribeHud(listener: HudListener): () => void {
    this.hudListeners.add(listener);
    listener(
      this.getHudSnapshot(
        this.rendererBackend,
        this.pointerLocked,
        this.testMode,
      ),
    );
    return () => {
      this.hudListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.hudListeners.clear();
  }

  private enterCinematicIntro(): void {
    this._phase = 'CINEMATIC_INTRO';
    this.cinematicElapsed = 0;
    this.introBeatStep = 0;
    this.boss.enterCinematic(BOSS_CLIPS.intro, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.15,
      forceRestart: true,
    });
    this.boss.updateIntroChoreography?.(0);
    this.player.playClip(PLAYER_CLIPS.idle, { fadeSeconds: 0.15 });
    this.player.updateIntroChoreography?.(0);
    this.audio.setBgmState('CINEMATIC_INTRO');
    this.banner = null;
    this.bannerRemaining = 0;
  }

  private enterPhase1(): void {
    this.player.clearIntroChoreography?.();
    this.boss.clearIntroChoreography?.();
    this.vfx.updateIntroCinematicVfx?.(false);
    this.player.faceTarget(this.boss.position);
    this._phase = 'PHASE_1';
    this._paused = false;
    this.timeScaleSystem.setPaused(false);
    this.setAudioPaused(false);
    this.arena.setPhaseIntensity(0);
    this.setVfxPhaseIntensity(0);
    this.boss.enterCombatPhase(1);
    this.audio.setBgmState('PHASE_1');
    this.setBanner(UI_COPY.BANNER_ACT_1, UI_COPY.BOSS_NAME, 'act1', 3.2);
  }

  private enterCinematicTransition(): void {
    this.cleanupActiveCombatTimeScaleAndDomain();

    this._phase = 'CINEMATIC_TRANSITION';
    this.cinematicElapsed = 0;
    this.transitionLightningStep = 0;
    this.boss.hp = COMBAT_TUNING.bossPhase2HpThreshold;
    this.boss.enterCinematic(BOSS_CLIPS.transition, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.14,
      forceRestart: true,
    });
    this.player.playClip(PLAYER_CLIPS.idle, { fadeSeconds: 0.14 });
    this.audio.setBgmState('CINEMATIC_TRANSITION');
    this.audio.playSfx('boss_roar');
    this.setBanner(
      UI_COPY.BANNER_ACT_2,
      UI_COPY.BOSS_NAME,
      'act2',
      COMBAT_TUNING.transitionDurationSeconds,
    );
  }

  private enterPhase2(): void {
    this._phase = 'PHASE_2';
    this._paused = false;
    this.timeScaleSystem.setPaused(false);
    this.setAudioPaused(false);
    this.arena.setPhaseIntensity(1);
    this.setVfxPhaseIntensity(1);
    this.boss.enterCombatPhase(2);
    this.audio.setBgmState('PHASE_2');
    this.setBanner(UI_COPY.BANNER_ACT_2, UI_COPY.BOSS_NAME, 'act2', 3.5);
  }

  private enterCinematicFinisher(): void {
    this.cleanupActiveCombatTimeScaleAndDomain();

    this._phase = 'CINEMATIC_FINISHER';
    this.cinematicElapsed = 0;
    this.boss.enterDead(this.vfx);
    this.player.playClip(PLAYER_CLIPS.idle, { fadeSeconds: 0.16 });
    this.audio.setBgmState('CINEMATIC_FINISHER');
    this.audio.playSfx('posture_break');
    this.setBanner(
      UI_COPY.BANNER_FINISHER,
      UI_COPY.VICTORY_HEADER,
      'finisher',
      COMBAT_TUNING.finisherDurationSeconds,
    );
  }

  private enterVictory(): void {
    this._phase = 'VICTORY';
    this._paused = false;
    this.timeScaleSystem.setPaused(false);
    this.setAudioPaused(false);
    this.banner = null;
    this.bannerRemaining = 0;
    this.boss.setDissolve(0.65);
    this.audio.setBgmState('VICTORY');
  }

  private cleanupActiveCombatTimeScaleAndDomain(): void {
    this.combat.cancelSkill3IfActive();
    this.combat.cancelOngoingPlayerActions();
    this.timeScaleSystem.reset();
    if (this._paused) {
      this.timeScaleSystem.setPaused(true);
    }
    this.audio.setBulletTimeFilter(false);
    this.vfx.triggerSkill3Domain(false);
    this.vfx.clearAllTelegraphs?.();
  }

  private getCameraOverrideForCurrentState(): PlayerCameraFrameOverride | null {
    switch (this._phase) {
      case 'TITLE':
        return computeTitleCameraFrame(this.totalElapsedSeconds);
      case 'CINEMATIC_INTRO':
        return computeIntroCameraFrame(
          clamp01(this.cinematicElapsed / this.introDurationSeconds),
          this.player.position,
          this.boss.position,
        );
      case 'CINEMATIC_TRANSITION':
        return computeTransitionCameraFrame(
          clamp01(
            this.cinematicElapsed / COMBAT_TUNING.transitionDurationSeconds,
          ),
          this.boss.position,
        );
      case 'CINEMATIC_FINISHER':
        return computeFinisherCameraFrame(
          clamp01(
            this.cinematicElapsed / COMBAT_TUNING.finisherDurationSeconds,
          ),
          this.player.position,
          this.boss.position,
        );
      case 'VICTORY':
        return computeVictoryCameraFrame(
          this.totalElapsedSeconds,
          this.player.position,
        );
      default:
        return this.combat.skill3Active
          ? computeSkill3CameraFrame(
              this.combat.getSkill3Elapsed(),
              this.player.position,
              this.boss.position,
            )
          : null;
    }
  }

  private setBanner(
    title: string,
    subtitle: string | undefined,
    accent: HudBannerSnapshot['accent'],
    durationSeconds: number,
  ): void {
    this.banner = {
      title,
      subtitle,
      accent,
      visible: true,
    };
    this.bannerRemaining = Math.max(0, durationSeconds);
  }

  private pushCallout(
    text: string,
    tone: HudCalloutSnapshot['tone'],
    durationSeconds = 1.8,
  ): void {
    const duration = Math.max(0.5, durationSeconds);
    const callout: HudCalloutSnapshot = {
      id: this.nextCalloutId++,
      text,
      tone,
      remaining: duration,
      duration,
    };
    this.callouts.push(callout);
    if (this.callouts.length > MAX_ACTIVE_CALLOUTS) {
      this.callouts.shift();
    }
  }

  private tickBannerAndCallouts(dt: number): void {
    if (this.bannerRemaining > 0) {
      this.bannerRemaining = Math.max(0, this.bannerRemaining - dt);
      if (this.bannerRemaining <= 0) {
        this.banner = null;
      }
    }

    if (this.callouts.length > 0) {
      for (let i = this.callouts.length - 1; i >= 0; i -= 1) {
        const entry = this.callouts[i]!;
        entry.remaining = Math.max(0, entry.remaining - dt);
        if (entry.remaining <= 0) {
          this.callouts.splice(i, 1);
        }
      }
    }
  }

  private computeRank(): RankGrade {
    return 'SSS';
  }

  private setVfxPhaseIntensity(t: number): void {
    if (
      'setPhaseIntensity' in this.vfx &&
      typeof (this.vfx as { setPhaseIntensity?: (v: number) => void })
        .setPhaseIntensity === 'function'
    ) {
      (
        this.vfx as { setPhaseIntensity: (v: number) => void }
      ).setPhaseIntensity(t);
    }
  }

  private setAudioPaused(paused: boolean): void {
    if (
      'setPaused' in this.audio &&
      typeof (this.audio as { setPaused?: (p: boolean) => void }).setPaused ===
        'function'
    ) {
      (this.audio as { setPaused: (p: boolean) => void }).setPaused(paused);
    }
  }

  private getAudioMasterVolume(): number {
    if (
      'getMasterVolume' in this.audio &&
      typeof (this.audio as { getMasterVolume?: () => number })
        .getMasterVolume === 'function'
    ) {
      return (
        this.audio as { getMasterVolume: () => number }
      ).getMasterVolume();
    }
    return 0.85;
  }

  private notifyHudListeners(): void {
    if (this.hudListeners.size === 0) {
      return;
    }
    const snapshot = this.getHudSnapshot(
      this.rendererBackend,
      this.pointerLocked,
      this.testMode,
    );
    for (const listener of this.hudListeners) {
      listener(snapshot);
    }
  }
}
