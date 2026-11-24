import * as THREE from 'three';
import type { TimeScaleSystem } from '../engine/TimeScaleSystem.ts';
import {
  BossEntity,
  type BossAttackSpec,
  type BossTickCallbacks,
} from '../entities/BossEntity.ts';
import { PLAYER_CLIPS, PlayerEntity } from '../entities/PlayerEntity.ts';
import { clampArenaPosition } from '../scene/ArenaScene.ts';
import {
  COMBAT_TUNING,
  UI_COPY,
  type ArenaInterface,
  type AudioInterface,
  type ComboStep,
  type GameDebugSnapshot,
  type HudCalloutSnapshot,
  type HudSkillSlotSnapshot,
  type SfxId,
  type Vec3Like,
  type VfxInterface,
} from '../types/game.ts';

export interface PlayerInputFrame {
  /** Camera-relative strafe input: -1 left, +1 right. */
  moveX: number;
  /** Camera-relative forward/backward input: +1 forward (W), -1 backward (S). */
  moveZ: number;
  attackPressed: boolean;
  dodgePressed: boolean;
  skill1Pressed: boolean;
  skill2Pressed: boolean;
  skill3Pressed: boolean;
  isSprinting?: boolean;
}

export type CombatCalloutHandler = (
  text: string,
  tone: HudCalloutSnapshot['tone'],
  durationSeconds?: number,
) => void;

export interface CombatSystemOptions {
  player: PlayerEntity;
  boss: BossEntity;
  timeScaleSystem: TimeScaleSystem;
  arena: ArenaInterface;
  vfx: VfxInterface;
  audio: AudioInterface;
  onCallout?: CombatCalloutHandler;
}

const BASIC_MELEE_REACH = 6.2;
const BASIC_HIT_DELIVERY_SECONDS = 0.06;
const COMBO_STREAK_DURATION_SECONDS = 4.0;
const MAGNETIC_LUNGE_MAX_RANGE = 7.8;

const SKILL1_DURATION_SECONDS = 0.4;
const SKILL1_DASH_MOVE_SECONDS = 0.24;
const SKILL1_HIT_TIMES = [0.06, 0.14, 0.22, 0.3] as const;
const SKILL1_HIT_REACH = 6.0;

const SKILL2_WINDUP_SECONDS = 0.14;
const SKILL2_DURATION_SECONDS = 0.42;
const SKILL2_HIT_REACH = 7.2;

const SKILL3_HIT_REACH = 16.0;
const SKILL3_SLASH_TIMES = [0.25, 0.55, 0.85, 1.15, 1.45, 1.75] as const;
const SKILL3_DETONATION_TIME = 2.2;

const COMBO_SLASH_ANGLES: readonly number[] = [0.42, -0.52, 0.24, 1.38];
const COMBO_STAFF_EXT: readonly number[] = [1.14, 1.24, 1.38, 1.68];

const HEAVY_KNOCKDOWN_ATTACK_IDS = new Set<string>([
  'shattered_earth_slam',
  'phantom_thrust',
  'temple_shockwave',
  'cataclysmic_leap_slam',
  'heavenfall_pillars',
]);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function distanceXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function directionXZ(from: Vec3Like, to: Vec3Like, fallbackYaw: number): { x: number; y: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4) {
    return { x: dx / len, y: 0, z: dz / len };
  }
  return { x: Math.sin(fallbackYaw), y: 0, z: Math.cos(fallbackYaw) };
}

export class CombatSystem {
  private readonly player: PlayerEntity;
  private readonly boss: BossEntity;
  private readonly timeScaleSystem: TimeScaleSystem;
  private readonly arena: ArenaInterface;
  private readonly vfx: VfxInterface;
  private readonly audio: AudioInterface;
  private onCallout?: CombatCalloutHandler;

  // Player vitals & sustain
  hp: number = COMBAT_TUNING.playerMaxHp;
  shield: number = COMBAT_TUNING.playerMaxShield;
  qi: number = COMBAT_TUNING.playerInitialQi;
  private shieldRegenDelayTimer = 0;
  private postHitGraceRemaining = 0;
  private lotusWardCooldown = 0;
  private lotusWardInvulnTimer = 0;

  // Cooldowns
  private skill1Cooldown = 0;
  private skill2Cooldown = 0;
  private skill3Cooldown = 0;
  private dodgeCooldown = 0;

  // Combo state
  private comboStep: ComboStep = 0;
  private comboActionTimer = 0;
  private comboActionElapsed = 0;
  private comboHitDelivered = false;
  private comboResetTimer = 0;
  private comboQueued = false;
  private comboCount = 0;
  private comboStreakTimer = 0;

  // Dodge & Perfect Dodge state
  private isDodging = false;
  private dodgeTimer = 0;
  private dodgeIFrameTimer = 0;
  private dodgeDirX = 0;
  private dodgeDirZ = 1;
  private counterCritReady = false;
  private lastBulletTimeFilterState = false;

  // Skill 1 (Phantom Dash)
  private skill1Active = false;
  private skill1Elapsed = 0;
  private skill1HitsDelivered = 0;
  private readonly skill1StartPos = new THREE.Vector3();
  private readonly skill1EndPos = new THREE.Vector3();

  // Skill 2 (Heaven-Splitting Cleave)
  private skill2Active = false;
  private skill2Elapsed = 0;
  private skill2HitDelivered = false;
  private skill2BufferedSkill3 = false;

  // Skill 3 (Celestial Severance)
  private _skill3Active = false;
  private skill3Elapsed = 0;
  private skill3SlashesDelivered = 0;
  private skill3Detonated = false;
  private skill3StartedThisUpdate = false;

  // Awakening callout gate
  private awakeningReadyNotified = true;

  // Multiplier & Stats
  private _playerDamageMultiplier = 1.0;
  private readonly stats = {
    totalDamageDealt: 0,
    damageTaken: 0,
    perfectDodges: 0,
    postureBreaks: 0,
    maxCombo: 0,
  };

  private readonly bossTickCallbacks: BossTickCallbacks;

  constructor(options: CombatSystemOptions) {
    this.player = options.player;
    this.boss = options.boss;
    this.timeScaleSystem = options.timeScaleSystem;
    this.arena = options.arena;
    this.vfx = options.vfx;
    this.audio = options.audio;
    this.onCallout = options.onCallout;

    this.bossTickCallbacks = {
      onTelegraphSfx: (id: SfxId) => {
        this.audio.playSfx(id);
      },
      onAttackImpact: (attack: BossAttackSpec, origin: THREE.Vector3, dir: THREE.Vector3) => {
        this.handleBossAttackImpact(attack, origin, dir);
      },
    };
  }

  get skill3Active(): boolean {
    return this._skill3Active;
  }

  get playerDamageMultiplier(): number {
    return this._playerDamageMultiplier;
  }

  setCalloutHandler(handler?: CombatCalloutHandler): void {
    this.onCallout = handler;
  }

  setPlayerDamageMultiplier(mult: number): void {
    if (!Number.isFinite(mult) || mult < 0) {
      return;
    }
    this._playerDamageMultiplier = mult;
  }

  getSkill3Elapsed(): number {
    return this.skill3Elapsed;
  }

  getBossTickCallbacks(): BossTickCallbacks {
    return this.bossTickCallbacks;
  }

  isPlayerInvulnerable(): boolean {
    return (
      this.dodgeIFrameTimer > 0 ||
      this.skill1Active ||
      this._skill3Active ||
      this.lotusWardInvulnTimer > 0
    );
  }

  readyAllSkills(): void {
    this.skill1Cooldown = 0;
    this.skill2Cooldown = 0;
    this.skill3Cooldown = 0;
    this.dodgeCooldown = 0;
    this.lotusWardCooldown = 0;
    this.qi = COMBAT_TUNING.playerMaxQi;
    this.awakeningReadyNotified = true;
  }

  setBossPosture(posture: number): void {
    if (!Number.isFinite(posture)) {
      return;
    }
    const clamped = clamp(posture, 0, COMBAT_TUNING.bossMaxPosture);
    if (this.boss.aiState === 'DEAD') {
      return;
    }
    if (clamped <= 0) {
      this.boss.posture = 0;
      if (!this.boss.staggered) {
        this.triggerBossPostureBreak();
      }
      return;
    }
    this.boss.posture = clamped;
  }

  cancelSkill3IfActive(): void {
    if (!this._skill3Active) {
      return;
    }
    this._skill3Active = false;
    this.skill3Elapsed = 0;
    this.skill3SlashesDelivered = 0;
    this.skill3Detonated = false;
    this.player.setAuraIntensity(0);
    this.player.setStaffExtension?.(1.0);
    this.vfx.triggerSkill3Domain(false);
    this.vfx.updateSkill3GreatSageDomain?.(false);
  }

  private computeBossFrontImpactPoint(heightY = 1.85): Vec3Like {
    const towardPlayer = directionXZ(
      this.boss.position,
      this.player.position,
      0,
    );
    const dist = distanceXZ(this.player.position, this.boss.position);
    const offset = Math.min(1.45, Math.max(0.35, dist * 0.38));
    return {
      x: this.boss.position.x + towardPlayer.x * offset,
      y: heightY,
      z: this.boss.position.z + towardPlayer.z * offset,
    };
  }

  private applyMagneticStaffLunge(maxAdvance: number): void {
    const dist = distanceXZ(this.player.position, this.boss.position);
    const minStop = COMBAT_TUNING.actorSeparationRadius + 0.35;
    if (dist <= minStop || dist > MAGNETIC_LUNGE_MAX_RANGE) {
      return;
    }
    const dir = directionXZ(
      this.player.position,
      this.boss.position,
      this.player.facingYaw,
    );
    const step = Math.min(maxAdvance, Math.max(0, dist - minStop));
    const clampedPos = clampArenaPosition(
      {
        x: this.player.position.x + dir.x * step,
        y: 0,
        z: this.player.position.z + dir.z * step,
      },
      this.arena.arenaRadius,
      0.5,
    );
    this.player.position.set(clampedPos.x, 0, clampedPos.z);
  }

  cancelOngoingPlayerActions(): void {
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboQueued = false;
    this.comboResetTimer = 0;
    this.comboStep = 0;
    this.isDodging = false;
    this.dodgeTimer = 0;
    this.dodgeIFrameTimer = 0;
    this.skill1Active = false;
    this.skill1Elapsed = 0;
    this.skill2Active = false;
    this.skill2Elapsed = 0;
    this.skill2BufferedSkill3 = false;
    this.cancelSkill3IfActive();
    this.player.cancelHitReactionPose?.();
    this.player.setMoveDirection(0, 0, 0);
  }

  update(
    playerDt: number,
    _worldDt: number,
    _rawDt: number,
    camera: THREE.Camera,
    input: PlayerInputFrame,
    combatPhase: 1 | 2,
  ): void {
    const safePlayerDt = Number.isFinite(playerDt) && playerDt > 0 ? playerDt : 0;

    // Sync Bullet-Time audio low-pass filter with TimeScaleSystem
    const btActive = this.timeScaleSystem.bulletTimeActive;
    if (btActive !== this.lastBulletTimeFilterState) {
      this.lastBulletTimeFilterState = btActive;
      this.audio.setBulletTimeFilter(btActive);
    }

    // 1. Tick cooldowns & sustain timers
    if (safePlayerDt > 0) {
      this.skill1Cooldown = Math.max(0, this.skill1Cooldown - safePlayerDt);
      this.skill2Cooldown = Math.max(0, this.skill2Cooldown - safePlayerDt);
      this.skill3Cooldown = Math.max(0, this.skill3Cooldown - safePlayerDt);
      this.dodgeCooldown = Math.max(0, this.dodgeCooldown - safePlayerDt);

      this.postHitGraceRemaining = Math.max(0, this.postHitGraceRemaining - safePlayerDt);
      this.lotusWardInvulnTimer = Math.max(0, this.lotusWardInvulnTimer - safePlayerDt);
      this.lotusWardCooldown = Math.max(0, this.lotusWardCooldown - safePlayerDt);
      this.shieldRegenDelayTimer = Math.max(0, this.shieldRegenDelayTimer - safePlayerDt);

      if (
        this.shieldRegenDelayTimer <= 0 &&
        this.shield < COMBAT_TUNING.playerMaxShield
      ) {
        this.shield = Math.min(
          COMBAT_TUNING.playerMaxShield,
          this.shield + COMBAT_TUNING.shieldRegenRatePerSec * safePlayerDt,
        );
      }

      if (this.hp > 0 && this.hp < COMBAT_TUNING.lowHpThreshold) {
        this.hp = Math.min(
          COMBAT_TUNING.lowHpThreshold,
          this.hp + COMBAT_TUNING.lowHpLotusRegenPerSec * safePlayerDt,
        );
      }

      if (this.comboStreakTimer > 0) {
        this.comboStreakTimer = Math.max(0, this.comboStreakTimer - safePlayerDt);
        if (this.comboStreakTimer <= 0) {
          this.comboCount = 0;
        }
      }
    }

    // Check Awakening Ready callout notification state
    const awakeningReady =
      this.qi >= COMBAT_TUNING.skill3QiCost && this.skill3Cooldown <= 0;
    if (!awakeningReady) {
      this.awakeningReadyNotified = false;
    } else if (!this.awakeningReadyNotified) {
      this.awakeningReadyNotified = true;
      this.onCallout?.(UI_COPY.CALLOUT_AWAKENING_READY, 'gold', 1.6);
    }

    // 2. Handle player input actions (priority: Skill 3 > Dodge > Skill 2 > Skill 1 > Basic Attack)
    this.skill3StartedThisUpdate = false;
    this.processActionInputs(camera, input);

    // 3. Tick active player actions
    if (this._skill3Active) {
      if (!this.skill3StartedThisUpdate) {
        this.updateSkill3(safePlayerDt, combatPhase);
      }
    } else if (this.isDodging) {
      this.updateDodge(safePlayerDt);
    } else if (this.skill1Active) {
      this.updateSkill1(safePlayerDt, combatPhase);
    } else if (this.skill2Active) {
      this.updateSkill2(safePlayerDt, combatPhase);
    } else {
      this.updateComboAndMovement(safePlayerDt, camera, input, combatPhase);
    }

    // 4. Advance player physics/bounds/animation
    this.player.update(safePlayerDt, _rawDt, this.boss.position);

    // 5. Emit tiered hit-reaction bluestone skid sparks, ground knockdown crash, and Golden Lotus Kip-Up burst!
    if (safePlayerDt > 0) {
      if (this.player.isSkiddingFromLightHit?.()) {
        const yaw = this.player.facingYaw;
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        const fwdX = Math.sin(yaw);
        const fwdZ = Math.cos(yaw);
        this.vfx.spawnStaffDragSparks?.(
          {
            x: this.player.position.x + rightX * 0.28,
            y: 0.05,
            z: this.player.position.z + rightZ * 0.28,
          },
          fwdX,
          fwdZ,
        );
        this.vfx.spawnStaffDragSparks?.(
          {
            x: this.player.position.x - rightX * 0.28,
            y: 0.05,
            z: this.player.position.z - rightZ * 0.28,
          },
          fwdX,
          fwdZ,
        );
      }
      if (this.player.consumeKnockdownGroundCrash?.()) {
        this.vfx.spawnImpactBurst(
          {
            x: this.player.position.x,
            y: 0.28,
            z: this.player.position.z,
          },
          true,
        );
        this.player.triggerCameraImpact?.(1.12, 0, -1, 2.6);
      }
      if (this.player.consumeKnockdownKipUp?.()) {
        this.player.setAuraIntensity(1.55);
        this.vfx.spawnDodgePhantomTrail?.(
          this.player.position,
          Math.sin(this.player.facingYaw),
          Math.cos(this.player.facingYaw),
        );
      }
    }
  }

  postBossTick(_combatPhase: 1 | 2): void {
    const active = this.boss.activeAttack;
    if (
      active &&
      active.phase === 'active' &&
      !active.hitDelivered &&
      !active.perfectDodgeAwarded &&
      this.boss.evaluatePlayerInHitbox(this.player.position)
    ) {
      active.hitDelivered = true;
      this.applyDamageToPlayer(
        active.spec.damage,
        active.spec.id,
        active.origin,
      );
    }
  }

  private processActionInputs(camera: THREE.Camera, input: PlayerInputFrame): void {
    if (this._skill3Active) {
      return;
    }

    // Skill 3: Celestial Severance (can cancel combo, dodge, Skill 1, or Skill 2 recovery; buffers during Skill 2 windup)
    if (input.skill3Pressed) {
      if (this.canCastSkill3()) {
        if (this.skill2Active && !this.skill2HitDelivered) {
          this.skill2BufferedSkill3 = true;
          return;
        }
        this.startSkill3();
        return;
      }
    }

    // Dodge: Space / Shift (cancels combo swing/recovery, Skill 1, Skill 2)
    if (input.dodgePressed) {
      if (!this.isDodging && this.dodgeCooldown <= 0) {
        this.startDodge(camera, input);
        return;
      }
    }

    // Skill 2: Heaven-Splitting Cleave (cancels combo, dodge, or Skill 1 tail)
    if (input.skill2Pressed) {
      if (
        this.skill2Cooldown <= 0 &&
        !this.skill2Active &&
        (!this.skill1Active || this.skill1Elapsed >= 0.3)
      ) {
        this.startSkill2();
        return;
      }
    }

    // Skill 1: Phantom Dash (cancels combo or dodge)
    if (input.skill1Pressed) {
      if (this.skill1Cooldown <= 0 && !this.skill1Active && !this.skill2Active) {
        this.startSkill1();
        return;
      }
    }

    // Basic 4-hit combo (LMB / J)
    if (input.attackPressed) {
      if (!this.isDodging && !this.skill1Active && !this.skill2Active) {
        if (this.comboActionTimer <= 0) {
          const nextStep: 1 | 2 | 3 | 4 =
            this.comboStep >= 4 || this.comboResetTimer <= 0
              ? 1
              : ((this.comboStep + 1) as 1 | 2 | 3 | 4);
          this.startComboStep(nextStep);
        } else {
          this.comboQueued = true;
        }
      }
    }
  }

  private canCastSkill3(): boolean {
    return (
      !this._skill3Active &&
      this.skill3Cooldown <= 0 &&
      this.qi >= COMBAT_TUNING.skill3QiCost
    );
  }

  private startComboStep(step: 1 | 2 | 3 | 4): void {
    this.player.cancelHitReactionPose?.();
    this.player.faceTarget(this.boss.position);
    this.player.setMoveDirection(0, 0, 0);
    this.applyMagneticStaffLunge(step === 4 ? 1.55 : 0.95);

    const tuning = COMBAT_TUNING.comboSteps[step - 1]!;
    this.comboStep = step;
    this.comboActionTimer = tuning.durationSeconds;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboResetTimer = COMBAT_TUNING.comboResetWindowSeconds;
    this.comboQueued = false;

    this.player.setStaffExtension?.(COMBO_STAFF_EXT[step - 1] ?? 1.2);
    this.player.setAuraIntensity(step === 4 ? 1.45 : 0.45 + step * 0.16);
    const poseKinds = ['sweep1', 'sweep2', 'sweep3', 'heavy_leap'] as const;
    this.player.notifyAttackPose?.(poseKinds[step - 1]!, tuning.durationSeconds);

    const clipMap = [
      PLAYER_CLIPS.combo1,
      PLAYER_CLIPS.combo2,
      PLAYER_CLIPS.combo3,
      PLAYER_CLIPS.combo4,
    ] as const;
    const sfxMap: readonly SfxId[] = [
      'sword_slash_1',
      'sword_slash_2',
      'sword_slash_3',
      'sword_slash_4',
    ];

    this.player.playClip(clipMap[step - 1]!, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.05,
      timeScale: step === 4 ? 1.08 : 1.18,
      forceRestart: true,
    });
    this.audio.playSfx(sfxMap[step - 1]!);

    const dir = directionXZ(
      this.player.position,
      this.boss.position,
      this.player.facingYaw,
    );
    const origin = {
      x: this.player.position.x + dir.x * 0.45,
      y: step === 4 ? 1.55 : 1.28,
      z: this.player.position.z + dir.z * 0.45,
    };
    this.vfx.spawnSlashArc(
      origin,
      dir,
      COMBO_SLASH_ANGLES[step - 1] ?? 0.3,
      step >= 3 ? 'crimson_gold' : tuning.slashPreset,
      step === 4 ? 1.68 : 1.18 + step * 0.08,
    );
    if (step === 4) {
      // Heavy overhead pillar-smash secondary shock arc
      this.vfx.spawnSlashArc(origin, dir, -0.18, 'ink_gold', 1.48);
    }
  }

  private updateComboAndMovement(
    playerDt: number,
    camera: THREE.Camera,
    input: PlayerInputFrame,
    combatPhase: 1 | 2,
  ): void {
    if (this.comboActionTimer > 0) {
      this.comboActionElapsed += playerDt;
      this.comboActionTimer = Math.max(0, this.comboActionTimer - playerDt);
      this.player.setMoveDirection(0, 0, 0);

      if (
        !this.comboHitDelivered &&
        (this.comboActionElapsed >= BASIC_HIT_DELIVERY_SECONDS ||
          this.comboActionTimer <= 0)
      ) {
        this.comboHitDelivered = true;
        this.comboResetTimer = COMBAT_TUNING.comboResetWindowSeconds;
        this.deliverBasicComboHit(combatPhase);
      } else if (this.comboHitDelivered && this.comboResetTimer > 0) {
        this.comboResetTimer = Math.max(0, this.comboResetTimer - playerDt);
      }

      if (this.comboActionTimer <= 0) {
        if (this.comboQueued) {
          const nextStep: 1 | 2 | 3 | 4 =
            this.comboStep >= 4 ? 1 : ((this.comboStep + 1) as 1 | 2 | 3 | 4);
          this.startComboStep(nextStep);
        } else if (this.comboResetTimer <= 0) {
          this.comboStep = 0;
        }
      }
      return;
    }

    if (this.comboResetTimer > 0) {
      this.comboResetTimer = Math.max(0, this.comboResetTimer - playerDt);
      if (this.comboResetTimer <= 0) {
        this.comboStep = 0;
      }
    }

    // Reset Ruyi Jingu Bang extension & combat aura when back in neutral movement/idle
    this.player.setStaffExtension?.(1.0);
    this.player.setAuraIntensity(0);

    // Free WASD movement
    const basis = this.player.getCameraBasisXZ(camera);
    const moveX = Number.isFinite(input.moveX) ? input.moveX : 0;
    const moveZ = Number.isFinite(input.moveZ) ? input.moveZ : 0;
    const moveDirX = basis.forwardX * moveZ + basis.rightX * moveX;
    const moveDirZ = basis.forwardZ * moveZ + basis.rightZ * moveX;
    const moveLen = Math.hypot(moveDirX, moveDirZ);

    if (Number.isFinite(moveLen) && moveLen > 1e-4) {
      const speed = input.isSprinting
        ? COMBAT_TUNING.playerMoveSpeed * 1.25
        : COMBAT_TUNING.playerMoveSpeed;
      this.player.setMoveDirection(moveDirX, moveDirZ, speed);
      this.player.setMoveAnimation(true, Boolean(input.isSprinting));
      if (this.player.isDraggingStaffOnGround?.()) {
        const rearTip = this.player.getStaffRearTipWorldPosition?.();
        if (rearTip) {
          this.vfx.spawnStaffDragSparks?.(
            { x: rearTip.x, y: 0.05, z: rearTip.z },
            moveDirX,
            moveDirZ,
          );
        }
      }
    } else {
      this.player.setMoveDirection(0, 0, 0);
      this.player.setMoveAnimation(false);
    }
  }

  private deliverBasicComboHit(combatPhase: 1 | 2): void {
    if (this.comboStep < 1 || this.comboStep > 4) {
      return;
    }
    const dist = distanceXZ(this.player.position, this.boss.position);
    if (dist > BASIC_MELEE_REACH || this.boss.invulnerable) {
      return;
    }

    const tuning = COMBAT_TUNING.comboSteps[this.comboStep - 1]!;
    const result = this.applyDamageToBoss(
      tuning.damage,
      tuning.postureDamage,
      combatPhase,
    );

    if (result.dealt > 0) {
      this.gainQi(tuning.qiGain);
      if (tuning.healAmount > 0) {
        this.healPlayer(tuning.healAmount);
      }
      this.recordComboHit();
      this.timeScaleSystem.triggerHitstop(tuning.hitstopMs);

      const dir = directionXZ(
        this.player.position,
        this.boss.position,
        this.player.facingYaw,
      );
      const isHeavy = this.comboStep >= 3 || result.counterCrit;
      const impactScale =
        this.comboStep === 4 ? 1.45 : result.counterCrit ? 1.55 : 0.68 + this.comboStep * 0.16;
      this.player.triggerHitFreeze?.(this.comboStep === 4 ? 0.11 : 0.062);
      this.player.triggerCameraImpact?.(
        impactScale,
        dir.x,
        dir.z,
        this.comboStep === 4 ? 4.2 : result.counterCrit ? 4.6 : 1.6,
      );
      this.boss.triggerHitReaction?.(impactScale, dir.x, dir.z);

      this.vfx.spawnImpactBurst(
        this.computeBossFrontImpactPoint(this.comboStep === 4 ? 2.05 : 1.75),
        isHeavy,
      );
      this.audio.playSfx(
        result.counterCrit
          ? 'impact_counter_crit'
          : this.comboStep >= 3
            ? 'impact_heavy'
            : 'impact_light',
      );
    }
  }

  private startDodge(camera: THREE.Camera, input: PlayerInputFrame): void {
    // Cancel active combo, Skill 1, Skill 2, or active knockdown (Golden Ukemi Kip-Up!)
    const cancelledHit = this.player.cancelHitReactionPose?.() ?? 'none';
    if (cancelledHit === 'heavy') {
      this.vfx.triggerLotusWardBurst(this.player.position);
    }
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboQueued = false;
    this.comboResetTimer = 0;
    this.comboStep = 0;
    this.skill1Active = false;
    this.skill1Elapsed = 0;
    this.skill2Active = false;
    this.skill2Elapsed = 0;
    this.skill2BufferedSkill3 = false;

    this.isDodging = true;
    this.dodgeTimer = COMBAT_TUNING.dodgeDurationSeconds;
    this.dodgeIFrameTimer = COMBAT_TUNING.dodgeIFrameSeconds;
    this.dodgeCooldown =
      COMBAT_TUNING.dodgeDurationSeconds + COMBAT_TUNING.dodgeCooldownSeconds;

    const basis = this.player.getCameraBasisXZ(camera);
    const moveX = Number.isFinite(input.moveX) ? input.moveX : 0;
    const moveZ = Number.isFinite(input.moveZ) ? input.moveZ : 0;
    const moveDirX = basis.forwardX * moveZ + basis.rightX * moveX;
    const moveDirZ = basis.forwardZ * moveZ + basis.rightZ * moveX;
    const moveLen = Math.hypot(moveDirX, moveDirZ);

    if (Number.isFinite(moveLen) && moveLen > 1e-4) {
      this.dodgeDirX = moveDirX / moveLen;
      this.dodgeDirZ = moveDirZ / moveLen;
    } else {
      const away = directionXZ(
        this.boss.position,
        this.player.position,
        this.player.facingYaw + Math.PI,
      );
      this.dodgeDirX = away.x;
      this.dodgeDirZ = away.z;
    }

    const dodgeSpeed =
      COMBAT_TUNING.dodgeDistance / COMBAT_TUNING.dodgeDurationSeconds;
    this.player.triggerDodgePhantom?.();
    this.vfx.spawnDodgePhantomTrail?.(
      this.player.position,
      this.dodgeDirX,
      this.dodgeDirZ,
    );
    this.player.setMoveDirection(this.dodgeDirX, this.dodgeDirZ, dodgeSpeed);
    this.player.playClip(PLAYER_CLIPS.dodge, {
      loop: THREE.LoopOnce,
      clampWhenFinished: false,
      fadeSeconds: 0.06,
      forceRestart: true,
    });

    const triggeredPerfect = this.tryTriggerPerfectDodge();
    if (!triggeredPerfect) {
      this.audio.playSfx('dodge_whoosh');
    }
  }

  private updateDodge(playerDt: number): void {
    this.dodgeTimer = Math.max(0, this.dodgeTimer - playerDt);
    this.dodgeIFrameTimer = Math.max(0, this.dodgeIFrameTimer - playerDt);

    if (this.dodgeIFrameTimer > 0) {
      this.tryTriggerPerfectDodge();
    }

    const dodgeSpeed =
      COMBAT_TUNING.dodgeDistance / COMBAT_TUNING.dodgeDurationSeconds;
    this.player.setMoveDirection(this.dodgeDirX, this.dodgeDirZ, dodgeSpeed);

    if (this.dodgeTimer <= 0) {
      this.isDodging = false;
      this.dodgeIFrameTimer = 0;
      this.player.setMoveDirection(0, 0, 0);
    }
  }

  private tryTriggerPerfectDodge(): boolean {
    const activeAttack = this.boss.activeAttack;
    if (!activeAttack || activeAttack.perfectDodgeAwarded) {
      return false;
    }

    const timingValid =
      (activeAttack.phase === 'windup' &&
        activeAttack.windupRemaining <= COMBAT_TUNING.perfectDodgeWindowSeconds) ||
      activeAttack.phase === 'active';
    if (!timingValid) {
      return false;
    }

    const proximityValid =
      this.boss.evaluatePlayerInHitbox(
        this.player.position,
        COMBAT_TUNING.perfectDodgeProximityMargin,
      ) ||
      distanceXZ(this.player.position, activeAttack.origin) <=
        activeAttack.spec.radius + COMBAT_TUNING.perfectDodgeProximityMargin;
    if (!proximityValid) {
      return false;
    }

    activeAttack.perfectDodgeAwarded = true;
    this.stats.perfectDodges += 1;
    this.timeScaleSystem.triggerBulletTime(
      COMBAT_TUNING.bulletTimeDurationSeconds,
    );
    this.lastBulletTimeFilterState = true;
    this.audio.setBulletTimeFilter(true);

    this.healPlayer(COMBAT_TUNING.perfectDodgeHealAmount);
    this.restoreShield(COMBAT_TUNING.perfectDodgeShieldRestore);
    this.gainQi(COMBAT_TUNING.perfectDodgeQiRestore);
    this.counterCritReady = true;

    this.audio.playSfx('perfect_dodge_chime');
    this.onCallout?.(UI_COPY.CALLOUT_PERFECT_DODGE, 'cyan', 1.8);
    return true;
  }

  private startSkill1(): void {
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboQueued = false;
    this.comboResetTimer = 0;
    this.comboStep = 0;
    this.isDodging = false;
    this.dodgeTimer = 0;
    this.dodgeIFrameTimer = 0;

    this.player.cancelHitReactionPose?.();
    this.player.faceTarget(this.boss.position);
    this.player.setMoveDirection(0, 0, 0);
    this.player.setStaffExtension?.(1.42);
    this.player.setAuraIntensity(1.75);
    this.player.triggerDodgePhantom?.();
    this.player.notifyAttackPose?.('dash_strike', SKILL1_DURATION_SECONDS);

    this.skill1Cooldown = COMBAT_TUNING.skill1CooldownSeconds;
    this.skill1Active = true;
    this.skill1Elapsed = 0;
    this.skill1HitsDelivered = 0;

    this.skill1StartPos.copy(this.player.position);
    const dist = distanceXZ(this.player.position, this.boss.position);
    const dir = directionXZ(
      this.player.position,
      this.boss.position,
      this.player.facingYaw,
    );
    const targetStop = COMBAT_TUNING.actorSeparationRadius + 0.4;
    const dashDist = Math.min(
      COMBAT_TUNING.skill1MaxDashDistance,
      Math.max(0, dist - targetStop),
    );
    const rawEnd = {
      x: this.player.position.x + dir.x * dashDist,
      y: 0,
      z: this.player.position.z + dir.z * dashDist,
    };
    const clampedEnd = clampArenaPosition(rawEnd, this.arena.arenaRadius, 0.5);
    this.skill1EndPos.set(clampedEnd.x, 0, clampedEnd.z);

    // Summon 4 3D Golden Monkey King Clones converging on Boss Jiebo in a storm of golden staffs!
    this.vfx.spawnSkill1CloneBlitz?.(
      this.skill1StartPos,
      this.skill1EndPos,
      this.boss.position,
    );

    this.player.playClip(PLAYER_CLIPS.skill1, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.06,
      forceRestart: true,
    });
    this.audio.playSfx('skill1_phantom_dash');
    this.vfx.spawnSlashArc(
      { x: this.player.position.x, y: 1.25, z: this.player.position.z },
      dir,
      0.35,
      'crimson_gold',
      1.48,
    );
  }

  private updateSkill1(playerDt: number, combatPhase: 1 | 2): void {
    this.skill1Elapsed += playerDt;
    this.player.setMoveDirection(0, 0, 0);

    const moveT = clamp01(this.skill1Elapsed / SKILL1_DASH_MOVE_SECONDS);
    const eased = 1 - (1 - moveT) * (1 - moveT);
    this.player.position.lerpVectors(this.skill1StartPos, this.skill1EndPos, eased);

    while (
      this.skill1HitsDelivered < SKILL1_HIT_TIMES.length &&
      this.skill1Elapsed >= SKILL1_HIT_TIMES[this.skill1HitsDelivered]!
    ) {
      const hitIdx = this.skill1HitsDelivered;
      this.skill1HitsDelivered += 1;
      this.player.faceTarget(this.boss.position);

      const dir = directionXZ(
        this.player.position,
        this.boss.position,
        this.player.facingYaw,
      );
      this.vfx.triggerSkill1CloneSlash?.(this.boss.position, hitIdx);
      this.vfx.spawnSlashArc(
        { x: this.boss.position.x, y: 1.45 + (hitIdx % 2) * 0.45, z: this.boss.position.z },
        dir,
        hitIdx % 2 === 0 ? 0.62 : -0.62,
        hitIdx % 2 === 0 ? 'crimson_gold' : 'ink_gold',
        1.58,
      );

      if (
        distanceXZ(this.player.position, this.boss.position) <= SKILL1_HIT_REACH &&
        !this.boss.invulnerable
      ) {
        const posturePerHit =
          COMBAT_TUNING.skill1PostureDamage / COMBAT_TUNING.skill1HitCount;
        const qiPerHit = COMBAT_TUNING.skill1QiGain / COMBAT_TUNING.skill1HitCount;
        const result = this.applyDamageToBoss(
          COMBAT_TUNING.skill1DamagePerHit,
          posturePerHit,
          combatPhase,
        );
        if (result.dealt > 0) {
          this.gainQi(qiPerHit);
          this.recordComboHit();
          const isFinalHit = hitIdx === SKILL1_HIT_TIMES.length - 1;
          this.player.triggerCameraImpact?.(
            isFinalHit ? 0.85 : 0.42,
            dir.x,
            dir.z,
            isFinalHit ? 2.2 : 0.8,
          );
          this.boss.triggerHitReaction?.(isFinalHit ? 0.9 : 0.5, dir.x, dir.z);
          this.vfx.spawnImpactBurst(
            this.computeBossFrontImpactPoint(1.8),
            isFinalHit,
          );
          if (result.counterCrit) {
            this.audio.playSfx('impact_counter_crit');
          } else {
            this.audio.playSfx(isFinalHit ? 'impact_heavy' : 'skill1_phantom_dash');
          }
        }
      }
    }

    if (this.skill1Elapsed >= SKILL1_DURATION_SECONDS) {
      this.skill1Active = false;
      this.skill1Elapsed = 0;
    }
  }

  private startSkill2(): void {
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboQueued = false;
    this.comboResetTimer = 0;
    this.comboStep = 0;
    this.isDodging = false;
    this.dodgeTimer = 0;
    this.dodgeIFrameTimer = 0;
    this.skill1Active = false;
    this.skill1Elapsed = 0;

    this.player.cancelHitReactionPose?.();
    this.player.faceTarget(this.boss.position);
    this.player.setMoveDirection(0, 0, 0);
    this.applyMagneticStaffLunge(1.85);
    this.player.setStaffExtension?.(2.05);
    this.player.setAuraIntensity(2.2);
    this.player.notifyAttackPose?.('pillar_perch', SKILL2_DURATION_SECONDS);
    this.vfx.spawnSkill2PillarAscent?.(this.player.position, this.boss.position);

    this.skill2Cooldown = COMBAT_TUNING.skill2CooldownSeconds;
    this.skill2Active = true;
    this.skill2Elapsed = 0;
    this.skill2HitDelivered = false;
    this.skill2BufferedSkill3 = false;

    this.player.playClip(PLAYER_CLIPS.skill2, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.06,
      forceRestart: true,
    });
    this.audio.playSfx('skill2_cleave_charge');
  }

  private updateSkill2(playerDt: number, combatPhase: 1 | 2): void {
    this.skill2Elapsed += playerDt;
    this.player.setMoveDirection(0, 0, 0);

    if (!this.skill2HitDelivered && this.skill2Elapsed >= SKILL2_WINDUP_SECONDS) {
      this.skill2HitDelivered = true;
      this.player.faceTarget(this.boss.position);

      const dir = directionXZ(
        this.player.position,
        this.boss.position,
        this.player.facingYaw,
      );
      const arcOrigin = {
        x: this.player.position.x + dir.x * 0.65,
        y: 1.85,
        z: this.player.position.z + dir.z * 0.65,
      };
      this.vfx.spawnSkill2DragonPillarSlam?.(
        this.player.position,
        this.boss.position,
      );
      this.arena.triggerLightningStrike(this.boss.position);
      this.vfx.spawnSlashArc(arcOrigin, dir, 1.52, 'crimson_gold', 2.45);
      this.vfx.spawnSlashArc(arcOrigin, dir, 0.04, 'ink_gold', 2.15);
      this.audio.playSfx('skill2_cleave_slam');

      if (
        distanceXZ(this.player.position, this.boss.position) <= SKILL2_HIT_REACH &&
        !this.boss.invulnerable
      ) {
        const result = this.applyDamageToBoss(
          COMBAT_TUNING.skill2Damage,
          COMBAT_TUNING.skill2PostureDamage,
          combatPhase,
        );
        if (result.dealt > 0) {
          this.gainQi(COMBAT_TUNING.skill2QiGain);
          this.recordComboHit();
          this.timeScaleSystem.triggerHitstop(COMBAT_TUNING.skill2HitstopMs);
          this.player.triggerHitFreeze?.(0.13);
          this.player.triggerCameraImpact?.(1.75, dir.x, dir.z, 5.2);
          this.boss.triggerHitReaction?.(1.6, dir.x, dir.z);
          this.vfx.spawnImpactBurst(this.computeBossFrontImpactPoint(2.0), true);
          if (result.counterCrit) {
            this.audio.playSfx('impact_counter_crit');
          }
        }
      }

      const phaseFloorHp =
        combatPhase === 1 ? COMBAT_TUNING.bossPhase2HpThreshold : 0;
      if (
        this.skill2BufferedSkill3 &&
        this.boss.hp > phaseFloorHp &&
        this.canCastSkill3()
      ) {
        this.startSkill3();
        return;
      }
      this.skill2BufferedSkill3 = false;
    }

    if (this.skill2Elapsed >= SKILL2_DURATION_SECONDS) {
      this.skill2Active = false;
      this.skill2Elapsed = 0;
      this.skill2BufferedSkill3 = false;
    }
  }

  private startSkill3(): void {
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboQueued = false;
    this.comboResetTimer = 0;
    this.comboStep = 0;
    this.isDodging = false;
    this.dodgeTimer = 0;
    this.dodgeIFrameTimer = 0;
    this.skill1Active = false;
    this.skill1Elapsed = 0;
    this.skill2Active = false;
    this.skill2Elapsed = 0;
    this.skill2BufferedSkill3 = false;

    // Auto-close to Boss if within Skill 3 domain reach
    const dist = distanceXZ(this.player.position, this.boss.position);
    if (dist > 4.5 && dist <= SKILL3_HIT_REACH) {
      const fromBoss = directionXZ(
        this.boss.position,
        this.player.position,
        0,
      );
      const targetPos = clampArenaPosition(
        {
          x: this.boss.position.x + fromBoss.x * 3.2,
          y: 0,
          z: this.boss.position.z + fromBoss.z * 3.2,
        },
        this.arena.arenaRadius,
        0.5,
      );
      this.player.position.set(targetPos.x, 0, targetPos.z);
    }

    this.player.cancelHitReactionPose?.();
    this.player.faceTarget(this.boss.position);
    this.player.setMoveDirection(0, 0, 0);
    this.player.triggerDodgePhantom?.();
    this.player.notifyAttackPose?.(
      'dharmakaya_cast',
      COMBAT_TUNING.skill3TimeStopDurationSeconds,
    );

    this.qi = Math.max(0, this.qi - COMBAT_TUNING.skill3QiCost);
    this.skill3Cooldown = COMBAT_TUNING.skill3CooldownSeconds;
    this._skill3Active = true;
    this.skill3StartedThisUpdate = true;
    this.skill3Elapsed = 0;
    this.skill3SlashesDelivered = 0;
    this.skill3Detonated = false;

    this.healPlayer(COMBAT_TUNING.skill3HealAmount);
    this.shield = COMBAT_TUNING.playerMaxShield;

    this.timeScaleSystem.triggerSkill3TimeStop(
      COMBAT_TUNING.skill3TimeStopDurationSeconds,
    );
    this.player.setAuraIntensity(2.8);
    this.player.setStaffExtension?.(2.08);
    this.player.triggerCameraImpact?.(1.15, 0, -1, -3.8);
    this.vfx.triggerSkill3Domain(true, this.boss.position);
    this.vfx.updateSkill3GreatSageDomain?.(
      true,
      this.player.position,
      this.boss.position,
      this.player.facingYaw,
    );
    this.audio.playSfx('skill3_timestop_snap');
    this.player.playClip(PLAYER_CLIPS.skill3Cast, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.08,
      forceRestart: true,
    });
  }

  private updateSkill3(playerDt: number, combatPhase: 1 | 2): void {
    this.skill3Elapsed += playerDt;
    this.player.setMoveDirection(0, 0, 0);
    this.player.faceTarget(this.boss.position);

    const slashDamage = 200; // 6 * 200 = 1,200
    const slashPosture = 35; // 6 * 35 = 210

    while (
      this.skill3SlashesDelivered < SKILL3_SLASH_TIMES.length &&
      this.skill3Elapsed >= SKILL3_SLASH_TIMES[this.skill3SlashesDelivered]!
    ) {
      const idx = this.skill3SlashesDelivered;
      this.skill3SlashesDelivered += 1;

      const dir = directionXZ(
        this.player.position,
        this.boss.position,
        this.player.facingYaw,
      );
      this.vfx.triggerSkill3CloneBlitzSlash?.(this.boss.position, idx);
      this.vfx.spawnSlashArc(
        {
          x: this.boss.position.x,
          y: 1.85 + (idx % 3) * 0.48,
          z: this.boss.position.z,
        },
        dir,
        (idx % 2 === 0 ? 1 : -1) * (0.48 + idx * 0.16),
        idx % 3 === 0 ? 'crimson_gold' : idx % 3 === 1 ? 'ink_gold' : 'celestial_white',
        2.25,
      );
      this.player.triggerCameraImpact?.(0.55, dir.x, dir.z, 1.4);
      this.audio.playSfx('skill3_reality_slash');

      if (idx % 2 === 1) {
        this.player.playClip(PLAYER_CLIPS.skill3Strike, {
          loop: THREE.LoopOnce,
          clampWhenFinished: true,
          fadeSeconds: 0.05,
          forceRestart: true,
        });
      }

      if (
        distanceXZ(this.player.position, this.boss.position) <= SKILL3_HIT_REACH &&
        !this.boss.invulnerable
      ) {
        const result = this.applyDamageToBoss(
          slashDamage,
          slashPosture,
          combatPhase,
        );
        if (result.dealt > 0) {
          this.recordComboHit();
          this.vfx.spawnImpactBurst(
            { x: this.boss.position.x, y: 2.1, z: this.boss.position.z },
            idx % 2 === 1,
          );
        }
      }
    }

    if (!this.skill3Detonated && this.skill3Elapsed >= SKILL3_DETONATION_TIME) {
      this.skill3Detonated = true;
      const detonationDamage =
        COMBAT_TUNING.skill3TotalDamage - slashDamage * SKILL3_SLASH_TIMES.length; // 1,200
      const detonationPosture =
        COMBAT_TUNING.skill3PostureDamage -
        slashPosture * SKILL3_SLASH_TIMES.length; // 140

      const dir = directionXZ(
        this.player.position,
        this.boss.position,
        this.player.facingYaw,
      );
      this.vfx.triggerSkill3DharmakayaSlam?.(
        this.player.position,
        this.boss.position,
      );
      this.arena.triggerLightningStrike(this.boss.position);
      this.player.triggerCameraImpact?.(2.0, dir.x, dir.z, 6.2);
      this.boss.triggerHitReaction?.(1.85, dir.x, dir.z);
      this.audio.playSfx('skill3_detonation');
      this.vfx.spawnImpactBurst(
        { x: this.boss.position.x, y: 2.1, z: this.boss.position.z },
        true,
      );

      if (
        distanceXZ(this.player.position, this.boss.position) <= SKILL3_HIT_REACH &&
        !this.boss.invulnerable
      ) {
        const result = this.applyDamageToBoss(
          detonationDamage,
          detonationPosture,
          combatPhase,
        );
        if (result.dealt > 0) {
          this.recordComboHit();
        }
      }
    }

    if (this.skill3Elapsed >= COMBAT_TUNING.skill3TimeStopDurationSeconds - 1e-9) {
      this.cancelSkill3IfActive();
    }
  }

  private applyDamageToBoss(
    rawDamage: number,
    rawPostureDamage: number,
    combatPhase: 1 | 2,
  ): { dealt: number; counterCrit: boolean } {
    if (this.boss.invulnerable || this.boss.aiState === 'DEAD') {
      return { dealt: 0, counterCrit: false };
    }

    const staggerMult = this.boss.staggered
      ? COMBAT_TUNING.bossStaggerDamageMultiplier
      : 1.0;
    const counterCrit = this.counterCritReady;
    const counterMult = counterCrit
      ? COMBAT_TUNING.bulletTimeCounterMultiplier
      : 1.0;
    if (counterCrit) {
      this.counterCritReady = false;
      this.onCallout?.(UI_COPY.CALLOUT_COUNTER_CRIT, 'gold', 1.4);
    }

    const finalDamage = Math.max(
      0,
      Math.round(
        rawDamage * staggerMult * counterMult * this._playerDamageMultiplier,
      ),
    );

    const floorHp =
      combatPhase === 1 ? COMBAT_TUNING.bossPhase2HpThreshold : 0;
    const nextHp = Math.max(floorHp, this.boss.hp - finalDamage);
    const dealt = Math.max(0, this.boss.hp - nextHp);
    this.boss.hp = nextHp;
    this.stats.totalDamageDealt += dealt;

    if (
      rawPostureDamage > 0 &&
      !this.boss.staggered &&
      !this.boss.invulnerable
    ) {
      this.boss.posture = Math.max(0, this.boss.posture - rawPostureDamage);
      if (this.boss.posture <= 0) {
        this.triggerBossPostureBreak();
      }
    }

    return { dealt, counterCrit };
  }

  private triggerBossPostureBreak(): void {
    this.boss.enterStagger(this.vfx);
    this.stats.postureBreaks += 1;
    const dir = directionXZ(
      this.player.position,
      this.boss.position,
      this.player.facingYaw,
    );
    this.player.triggerCameraImpact?.(1.65, dir.x, dir.z, 5.2);
    this.boss.triggerHitReaction?.(1.55, dir.x, dir.z);
    this.vfx.triggerPostureBreakBurst({
      x: this.boss.position.x,
      y: 2.2,
      z: this.boss.position.z,
    });
    this.audio.playSfx('posture_break');
    this.onCallout?.(UI_COPY.CALLOUT_POSTURE_BROKEN, 'gold', 2.2);
  }

  private handleBossAttackImpact(
    attack: BossAttackSpec,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
  ): void {
    // Trigger the 5 GPT Image 2.6 Cataclysmic 3D Boss Spectacles + physical camera shock!
    switch (attack.id) {
      case 'abyssal_sweep': {
        this.vfx.spawnBossWingCrescent?.(origin, dir, attack.radius * 1.15, 0.22);
        this.vfx.spawnSlashArc(
          { x: origin.x, y: 2.2, z: origin.z },
          dir,
          0.26,
          'crimson_gold',
          2.6,
        );
        this.player.triggerCameraImpact?.(0.95, -dir.x, -dir.z, 2.4);
        break;
      }
      case 'twin_abyssal_cleave': {
        this.vfx.spawnBossWingCrescent?.(origin, dir, attack.radius * 1.22, 0.34);
        this.vfx.spawnBossWingCrescent?.(origin, dir, attack.radius * 1.08, -0.34);
        this.vfx.spawnSlashArc(
          { x: origin.x, y: 2.35, z: origin.z },
          dir,
          0.42,
          'crimson_gold',
          2.9,
        );
        this.player.triggerCameraImpact?.(1.35, -dir.x, -dir.z, 3.6);
        break;
      }
      case 'shattered_earth_slam':
      case 'cataclysmic_leap_slam': {
        const isPhase2Slam = attack.id === 'cataclysmic_leap_slam';
        this.vfx.spawnBossMeteorSlam?.(
          origin,
          isPhase2Slam ? attack.radius * 1.15 : attack.radius,
        );
        this.vfx.spawnImpactBurst({ x: origin.x, y: 0.6, z: origin.z }, true);
        if (isPhase2Slam) {
          this.arena.triggerLightningStrike(origin);
        }
        this.player.triggerCameraImpact?.(
          isPhase2Slam ? 1.85 : 1.45,
          -dir.x,
          -dir.z,
          isPhase2Slam ? 5.5 : 4.0,
        );
        break;
      }
      case 'phantom_thrust': {
        const chestPos = this.boss.getChestCoreWorldPosition?.() ?? {
          x: origin.x,
          y: 3.1,
          z: origin.z,
        };
        this.vfx.fireBossChestBeam?.(chestPos, dir);
        this.player.triggerCameraImpact?.(1.4, -dir.x, -dir.z, 3.8);
        break;
      }
      case 'temple_shockwave':
      case 'heavenfall_pillars': {
        const isPillars = attack.id === 'heavenfall_pillars';
        this.vfx.spawnBossHeavenfallPillars?.(
          origin,
          isPillars ? Math.max(3.8, attack.radius * 0.9) : Math.max(5.2, attack.radius * 0.72),
        );
        this.arena.triggerLightningStrike(origin);
        this.vfx.spawnImpactBurst({ x: origin.x, y: 0.5, z: origin.z }, true);
        this.player.triggerCameraImpact?.(1.5, 0, -1, 4.2);
        break;
      }
      case 'cross_slash_wave': {
        this.vfx.spawnBossCrossBladeStorm?.(origin, dir);
        this.vfx.spawnSlashArc(
          { x: origin.x, y: 2.4, z: origin.z },
          dir,
          0.78,
          'crimson_gold',
          2.7,
        );
        this.vfx.spawnSlashArc(
          { x: origin.x, y: 2.4, z: origin.z },
          dir,
          -0.78,
          'crimson_gold',
          2.7,
        );
        this.player.triggerCameraImpact?.(1.3, -dir.x, -dir.z, 3.4);
        break;
      }
      default: {
        this.vfx.spawnImpactBurst({ x: origin.x, y: 0.4, z: origin.z }, true);
        break;
      }
    }

    const active = this.boss.activeAttack;
    if (
      active &&
      !active.hitDelivered &&
      !active.perfectDodgeAwarded &&
      this.boss.evaluatePlayerInHitbox(this.player.position)
    ) {
      active.hitDelivered = true;
      this.applyDamageToPlayer(attack.damage, attack.id, origin);
    }
  }

  private applyDamageToPlayer(
    rawDamage: number,
    attackId?: string,
    hitOrigin?: Vec3Like,
  ): void {
    if (!Number.isFinite(rawDamage) || rawDamage <= 0) {
      return;
    }
    if (this.isPlayerInvulnerable() || this.postHitGraceRemaining > 0) {
      return;
    }

    const isHeavyKnockdown = attackId
      ? HEAVY_KNOCKDOWN_ATTACK_IDS.has(attackId)
      : rawDamage >= 95;

    this.stats.damageTaken += rawDamage;

    const shieldAbsorbed = Math.min(this.shield, rawDamage);
    this.shield = Math.max(0, this.shield - shieldAbsorbed);
    const hpDamage = rawDamage - shieldAbsorbed;
    this.hp -= hpDamage;

    this.shieldRegenDelayTimer = COMBAT_TUNING.shieldRegenDelaySeconds;
    this.postHitGraceRemaining = COMBAT_TUNING.playerPostHitGraceSeconds;

    // Play impact SFX before Lotus Ward so lastSfx === 'lotus_ward' on lethal interception
    this.audio.playSfx(isHeavyKnockdown ? 'impact_heavy' : 'impact_light');

    if (this.hp <= 0) {
      if (this.lotusWardCooldown <= 0) {
        this.hp = Math.min(
          COMBAT_TUNING.playerMaxHp,
          Math.round(
            COMBAT_TUNING.playerMaxHp * COMBAT_TUNING.lotusWardHealRatio,
          ),
        );
        this.lotusWardInvulnTimer = COMBAT_TUNING.lotusWardInvulnSeconds;
        this.lotusWardCooldown = COMBAT_TUNING.lotusWardCooldownSeconds;
        this.vfx.triggerLotusWardBurst(this.player.position);
        this.audio.playSfx('lotus_ward');
        this.onCallout?.(UI_COPY.CALLOUT_LOTUS_WARD, 'gold', 2.4);
        return;
      }
      this.hp = 1;
    }

    const knockDir = directionXZ(
      hitOrigin ?? this.boss.position,
      this.player.position,
      this.player.facingYaw + Math.PI,
    );

    if (isHeavyKnockdown && !this._skill3Active) {
      // Heavy Boss Attack -> Interrupt current melee & blast Wukong into a parabolic knockdown + Golden Kip-Up!
      this.comboActionTimer = 0;
      this.comboActionElapsed = 0;
      this.comboHitDelivered = false;
      this.comboQueued = false;
      this.comboResetTimer = 0;
      this.comboStep = 0;
      this.isDodging = false;
      this.dodgeTimer = 0;
      this.dodgeIFrameTimer = 0;
      this.skill1Active = false;
      this.skill1Elapsed = 0;
      this.skill2Active = false;
      this.skill2Elapsed = 0;
      this.skill2BufferedSkill3 = false;
      this.player.setMoveDirection(0, 0, 0);

      this.player.triggerHitReactionPose?.('heavy', knockDir.x, knockDir.z);
      this.vfx.spawnPlayerHitSparks?.(
        this.player.position,
        knockDir.x,
        knockDir.z,
        true,
      );
      this.player.triggerCameraImpact?.(1.35, -knockDir.x, -knockDir.z, 3.8);
      this.player.playClip(PLAYER_CLIPS.hit, {
        loop: THREE.LoopOnce,
        clampWhenFinished: false,
        fadeSeconds: 0.05,
        forceRestart: true,
      });
    } else if (
      !this.isDodging &&
      !this.skill1Active &&
      !this.skill2Active &&
      !this._skill3Active &&
      this.comboActionTimer <= 0
    ) {
      // Light Boss Attack -> Two-Handed Horizontal Ruyi Jingu Bang Chest-Brace + Bluestone Boot-Skid!
      this.player.triggerHitReactionPose?.('light', knockDir.x, knockDir.z);
      this.vfx.spawnPlayerHitSparks?.(
        this.player.position,
        knockDir.x,
        knockDir.z,
        false,
      );
      this.player.triggerCameraImpact?.(0.72, -knockDir.x, -knockDir.z, 1.8);
      this.player.playClip(PLAYER_CLIPS.block, {
        loop: THREE.LoopOnce,
        clampWhenFinished: false,
        fadeSeconds: 0.05,
        forceRestart: true,
      });
    }
  }

  private healPlayer(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.hp = Math.min(COMBAT_TUNING.playerMaxHp, this.hp + amount);
  }

  private restoreShield(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.shield = Math.min(COMBAT_TUNING.playerMaxShield, this.shield + amount);
  }

  private gainQi(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.qi = Math.min(COMBAT_TUNING.playerMaxQi, this.qi + amount);
  }

  private recordComboHit(): void {
    this.comboCount += 1;
    this.comboStreakTimer = COMBO_STREAK_DURATION_SECONDS;
    if (this.comboCount > this.stats.maxCombo) {
      this.stats.maxCombo = this.comboCount;
    }
  }

  getPlayerDebugSnapshot(): GameDebugSnapshot['player'] {
    const p = this.player.position;
    const v = this.player.velocity;
    return {
      hp: Math.round(this.hp * 100) / 100,
      maxHp: COMBAT_TUNING.playerMaxHp,
      shield: Math.round(this.shield * 100) / 100,
      maxShield: COMBAT_TUNING.playerMaxShield,
      qi: Math.round(this.qi * 100) / 100,
      maxQi: COMBAT_TUNING.playerMaxQi,
      position: [p.x, p.y, p.z],
      velocity: [v.x, v.y, v.z],
      comboStep: this.comboStep,
      comboCount: this.comboCount,
      isDodging: this.isDodging,
      invulnerable: this.isPlayerInvulnerable(),
      skillCooldowns: {
        skill1: Math.max(0, this.skill1Cooldown),
        skill2: Math.max(0, this.skill2Cooldown),
        skill3: Math.max(0, this.skill3Cooldown),
        dodge: Math.max(0, this.dodgeCooldown),
      },
      modelType: this.player.modelType,
      activeClip: this.player.activeClip,
    };
  }

  getStatsSnapshot(): Omit<GameDebugSnapshot['stats'], 'rank'> {
    return {
      totalDamageDealt: this.stats.totalDamageDealt,
      damageTaken: this.stats.damageTaken,
      perfectDodges: this.stats.perfectDodges,
      postureBreaks: this.stats.postureBreaks,
      maxCombo: this.stats.maxCombo,
    };
  }

  getHudSustainState(): {
    comboTimerRatio: number;
    lotusWardReady: boolean;
    lotusWardCooldown: number;
  } {
    return {
      comboTimerRatio:
        this.comboCount > 0
          ? clamp01(this.comboStreakTimer / COMBO_STREAK_DURATION_SECONDS)
          : 0,
      lotusWardReady: this.lotusWardCooldown <= 0,
      lotusWardCooldown: Math.max(0, this.lotusWardCooldown),
    };
  }

  getHudSkillSlots(): HudSkillSlotSnapshot[] {
    const dodgeTotal =
      COMBAT_TUNING.dodgeDurationSeconds + COMBAT_TUNING.dodgeCooldownSeconds;
    return [
      {
        id: 'dodge',
        keyLabel: 'SPACE',
        name: UI_COPY.SKILL_DODGE_NAME,
        cooldownRemaining: Math.max(0, this.dodgeCooldown),
        cooldownTotal: dodgeTotal,
        ready: this.dodgeCooldown <= 0 && !this.isDodging,
        active: this.isDodging,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill1',
        keyLabel: '1',
        name: UI_COPY.SKILL_1_NAME,
        cooldownRemaining: Math.max(0, this.skill1Cooldown),
        cooldownTotal: COMBAT_TUNING.skill1CooldownSeconds,
        ready: this.skill1Cooldown <= 0 && !this._skill3Active,
        active: this.skill1Active,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill2',
        keyLabel: '2',
        name: UI_COPY.SKILL_2_NAME,
        cooldownRemaining: Math.max(0, this.skill2Cooldown),
        cooldownTotal: COMBAT_TUNING.skill2CooldownSeconds,
        ready: this.skill2Cooldown <= 0 && !this._skill3Active,
        active: this.skill2Active,
        qiRequired: 0,
        qiSufficient: true,
      },
      {
        id: 'skill3',
        keyLabel: '3',
        name: UI_COPY.SKILL_3_NAME,
        cooldownRemaining: Math.max(0, this.skill3Cooldown),
        cooldownTotal: COMBAT_TUNING.skill3CooldownSeconds,
        ready:
          this.skill3Cooldown <= 0 &&
          !this._skill3Active &&
          this.qi >= COMBAT_TUNING.skill3QiCost,
        active: this._skill3Active,
        qiRequired: COMBAT_TUNING.skill3QiCost,
        qiSufficient: this.qi >= COMBAT_TUNING.skill3QiCost,
      },
    ];
  }

  reset(): void {
    this.hp = COMBAT_TUNING.playerMaxHp;
    this.shield = COMBAT_TUNING.playerMaxShield;
    this.qi = COMBAT_TUNING.playerInitialQi;
    this.shieldRegenDelayTimer = 0;
    this.postHitGraceRemaining = 0;
    this.lotusWardCooldown = 0;
    this.lotusWardInvulnTimer = 0;

    this.skill1Cooldown = 0;
    this.skill2Cooldown = 0;
    this.skill3Cooldown = 0;
    this.dodgeCooldown = 0;

    this.comboStep = 0;
    this.comboActionTimer = 0;
    this.comboActionElapsed = 0;
    this.comboHitDelivered = false;
    this.comboResetTimer = 0;
    this.comboQueued = false;
    this.comboCount = 0;
    this.comboStreakTimer = 0;

    this.isDodging = false;
    this.dodgeTimer = 0;
    this.dodgeIFrameTimer = 0;
    this.dodgeDirX = 0;
    this.dodgeDirZ = 1;
    this.counterCritReady = false;
    this.lastBulletTimeFilterState = false;

    this.skill1Active = false;
    this.skill1Elapsed = 0;
    this.skill1HitsDelivered = 0;

    this.skill2Active = false;
    this.skill2Elapsed = 0;
    this.skill2HitDelivered = false;
    this.skill2BufferedSkill3 = false;

    this._skill3Active = false;
    this.skill3Elapsed = 0;
    this.skill3SlashesDelivered = 0;
    this.skill3Detonated = false;

    this.awakeningReadyNotified = true;
    this._playerDamageMultiplier = 1.0;
    this.stats.totalDamageDealt = 0;
    this.stats.damageTaken = 0;
    this.stats.perfectDodges = 0;
    this.stats.postureBreaks = 0;
    this.stats.maxCombo = 0;

    this.player.setAuraIntensity(0);
    this.audio.setBulletTimeFilter(false);
  }
}
