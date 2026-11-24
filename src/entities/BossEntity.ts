import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  clamp as tslClamp,
  color,
  cos,
  dot,
  float,
  mix,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { AssetLoader } from '../engine/AssetLoader.ts';
import { clampArenaPosition } from '../scene/ArenaScene.ts';
import {
  COMBAT_TUNING,
  type BossAttackId,
  type BossAttackTuning,
  type ModelType,
  type SfxId,
  type Vec3Like,
  type VfxInterface,
} from '../types/game.ts';
import {
  AnimationRig,
  attachObjectToBone,
  type PlayClipOptions,
} from './AnimationRig.ts';
import { consolidateModelSkeletons } from './PlayerEntity.ts';

export type BossAttackSpec = BossAttackTuning;

export type BossAiState =
  | 'CINEMATIC'
  | 'IDLE'
  | 'CHASE'
  | 'WINDUP'
  | 'ACTIVE'
  | 'RECOVERY'
  | 'STAGGERED'
  | 'DEAD';

export interface ActiveBossAttackState {
  spec: BossAttackSpec;
  phase: 'windup' | 'active' | 'recovery';
  elapsed: number;
  windupRemaining: number;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  hitDelivered: boolean;
  perfectDodgeAwarded: boolean;
  telegraphId: string;
}

export interface BossEntityOptions {
  assetLoader?: AssetLoader;
  model?: THREE.Object3D;
  weaponModel?: THREE.Object3D;
  clips?: readonly THREE.AnimationClip[];
  arenaRadius?: number;
  onError?: (msg: string) => void;
}

export interface BossTickCallbacks {
  onTelegraphSfx?: (id: SfxId) => void;
  onAttackImpact?: (
    attack: BossAttackSpec,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
  ) => void;
  onStaggerEnd?: () => void;
}

export const BOSS_CLIPS = {
  idle: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Bstd_01',
    'Idle_Combat',
    '2H_Melee_Idle',
    'Idle',
  ] as const,
  walk: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Bstd_01',
    'Walking_A',
    'Running_A',
  ] as const,
  run: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Bstd_01',
    'Running_A',
    'Walking_A',
  ] as const,
  intro: [
    'SK_LYS_Mo2|AS_LYS_Mo2_enter',
    'SK_LYS_Mo2|AS_LYS_Mo2_preenter',
    'Skeletons_Awaken_Standing',
    'Idle_Combat',
  ] as const,
  transition: [
    'SK_LYS_Mo2|AS_LYS_Mo2_PhaseChange',
    'Skeletons_Taunt_Longer',
    'Taunt_Longer',
    'Taunt',
  ] as const,
  stagger: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Ct_01',
    'SK_LYS_Mo2|AS_LYS_Mo2_Ct_02',
    'Hit_B',
    'Block_Hit',
    'Hit_A',
  ] as const,
  death: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Die_Gen_01',
    'Death_B',
    'Death_A',
  ] as const,
} as const;

const BOSS_SPAWN_X = 0;
const BOSS_SPAWN_Z = -5;
const BOSS_TELEGRAPH_ID = 'boss_telegraph';
const BOSS_PILLAR_ID = 'boss_pillar_0';
const BOSS_ARC_HALF_ANGLE_RAD = (130 * Math.PI) / 360;
const BOSS_LINE_HALF_WIDTH = 1.7;

const ATTACK_CLIP_MAP: Record<BossAttackId, readonly string[]> = {
  abyssal_sweep: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_01',
    '2H_Melee_Attack_Slice',
    '2H_Melee_Attack_Chop',
  ],
  shattered_earth_slam: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_04',
    '2H_Melee_Attack_Chop',
    '2H_Melee_Attack_Slice',
  ],
  phantom_thrust: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_05',
    '2H_Melee_Attack_Stab',
    '2H_Melee_Attack_Slice',
  ],
  temple_shockwave: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_06',
    'Spellcast_Long',
    '2H_Melee_Attack_Chop',
  ],
  twin_abyssal_cleave: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_08',
    '2H_Melee_Attack_Spin',
    '2H_Melee_Attack_Slice',
  ],
  cataclysmic_leap_slam: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_09',
    '1H_Melee_Attack_Jump_Chop',
    '2H_Melee_Attack_Chop',
  ],
  heavenfall_pillars: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_10',
    'Spellcast_Summon',
    'Spellcast_Long',
  ],
  cross_slash_wave: [
    'SK_LYS_Mo2|AS_LYS_Mo2_Atk_11',
    '1H_Melee_Attack_Slice_Diagonal',
    '2H_Melee_Attack_Slice',
  ],
};

// Measured native peak-velocity impact timestamps inside boss_jiebo.glb's 11 attack clips!
const JIEBO_CLIP_PEAK_SECONDS: Record<BossAttackId, number> = {
  abyssal_sweep: 2.63,
  shattered_earth_slam: 4.13,
  phantom_thrust: 3.13,
  temple_shockwave: 3.13,
  twin_abyssal_cleave: 5.88,
  cataclysmic_leap_slam: 7.13,
  heavenfall_pillars: 3.88,
  cross_slash_wave: 6.63,
};

const ATTACK_SFX_MAP: Record<BossAttackId, SfxId> = {
  abyssal_sweep: 'boss_sweep',
  shattered_earth_slam: 'boss_slam',
  phantom_thrust: 'boss_sweep',
  temple_shockwave: 'boss_slam',
  twin_abyssal_cleave: 'boss_sweep',
  cataclysmic_leap_slam: 'boss_slam',
  heavenfall_pillars: 'boss_lightning',
  cross_slash_wave: 'boss_sweep',
};

interface PillarCapableVfx extends VfxInterface {
  showTelegraphPillar(
    id: string,
    params: {
      center: Vec3Like;
      radius: number;
      height?: number;
      progress: number;
      color?: 'crimson_gold' | 'amber' | 'violet';
    },
  ): void;
}

function hasPillarTelegraph(vfx: VfxInterface): vfx is PillarCapableVfx {
  return (
    'showTelegraphPillar' in vfx &&
    typeof (vfx as Partial<PillarCapableVfx>).showTelegraphPillar === 'function'
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function createFloatUniform(initial: number) {
  return uniform(initial);
}
type FloatUniform = ReturnType<typeof createFloatUniform>;

export class BossEntity {
  readonly rootGroup = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly rig: AnimationRig;
  readonly modelType: ModelType = 'glb';

  hp: number = COMBAT_TUNING.bossMaxHp;
  readonly maxHp: number = COMBAT_TUNING.bossMaxHp;
  posture: number = COMBAT_TUNING.bossMaxPosture;
  readonly maxPosture: number = COMBAT_TUNING.bossMaxPosture;

  staggered = false;
  staggerRemaining = 0;
  invulnerable = true;
  aiState: BossAiState = 'CINEMATIC';
  activeAttack: ActiveBossAttackState | null = null;

  private readonly arenaRadius: number;
  private readonly onError?: (msg: string) => void;
  private readonly isJieboBoss: boolean;
  private readonly weaponModel: THREE.Object3D | null;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  private readonly uPhaseIntensity: FloatUniform = uniform(0);
  private readonly uTime: FloatUniform = uniform(0);
  private readonly uTelegraphPulse: FloatUniform = uniform(0);
  private readonly uDissolve: FloatUniform = uniform(0);
  private readonly uHitFlash: FloatUniform = uniform(0);
  private readonly uGreatswordGlow: FloatUniform = uniform(0);
  private readonly uMeteorConeAlpha: FloatUniform = uniform(0);

  private dharmaHaloOuter: THREE.Group | null = null;
  private dharmaHaloInner: THREE.Group | null = null;
  private greatswordPivot: THREE.Group | null = null;
  private meteorFireCone: THREE.Mesh | null = null;
  private visualAltitudeY = 0;

  private hitShudderTimer = 0;
  private hitShudderDuration = 0.16;
  private hitShudderIntensity = 0;
  private hitKnockDirX = 0;
  private hitKnockDirZ = 0;

  private currentCombatPhase: 1 | 2 = 1;
  private attackCooldown = 1.0;
  private attackCycleIndex = 0;
  private facingYaw = 0;
  private disposed = false;

  constructor(options?: BossEntityOptions) {
    this.arenaRadius = options?.arenaRadius ?? COMBAT_TUNING.arenaRadius;
    this.onError = options?.onError;

    this.rootGroup.name = 'BossEntityRoot';
    this.rootGroup.position.set(BOSS_SPAWN_X, 0, BOSS_SPAWN_Z);
    this.rootGroup.rotation.set(0, 0, 0);

    const loader = options?.assetLoader;
    const bundle = loader?.getBundle();

    this.isJieboBoss = Boolean(
      !options?.model && loader && bundle?.glbs.has('boss_jiebo'),
    );

    if (options?.model) {
      this.model = options.model;
      this.model.scale.setScalar(COMBAT_TUNING.bossScale);
    } else if (this.isJieboBoss && loader) {
      const jieboWrapper = new THREE.Group();
      jieboWrapper.name = 'BossJieboWrapper';
      const jieboInner = loader.cloneModel('boss_jiebo');
      consolidateModelSkeletons(jieboInner);
      jieboInner.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          (obj as THREE.Mesh).frustumCulled = false;
        }
      });
      // Orient raw Sketchfab +X forward to +Z forward in BossEntityRoot space
      jieboInner.rotation.y = -Math.PI / 2;
      jieboInner.updateMatrixWorld(true);
      const rawBox = new THREE.Box3().setFromObject(jieboInner);
      const rawH = Math.max(0.01, rawBox.max.y - rawBox.min.y);
      const targetHeight = 5.9;
      const jbScale = targetHeight / rawH;
      jieboInner.scale.setScalar(jbScale);
      jieboInner.position.y = -rawBox.min.y * jbScale;
      jieboWrapper.add(jieboInner);
      this.model = jieboWrapper;
    } else if (loader && bundle?.glbs.has('boss_titan')) {
      this.model = loader.cloneModel('boss_titan');
      this.model.scale.setScalar(COMBAT_TUNING.bossScale);
    } else {
      this.model = new THREE.Group();
      this.model.name = 'BossModelFallback';
      if (loader) {
        this.onError?.('Missing loaded GLB asset: boss_titan');
      }
      this.model.scale.setScalar(COMBAT_TUNING.bossScale);
    }
    this.rootGroup.add(this.model);

    if (options?.weaponModel) {
      this.weaponModel = options.weaponModel;
    } else if (!this.isJieboBoss && loader && bundle?.glbs.has('boss_weapon')) {
      this.weaponModel = loader.cloneModel('boss_weapon');
    } else {
      this.weaponModel = null;
    }

    if (this.weaponModel) {
      const attached = attachObjectToBone(
        this.model,
        this.weaponModel,
        ['handslot.r'],
        new THREE.Vector3(0, 0, 0),
        new THREE.Euler(0, 0, 0),
      );
      if (!attached) {
        this.onError?.('Missing boss attachment bone: handslot.r');
        this.model.add(this.weaponModel);
      }
    }

    this.applyDarkMythMaterials();
    if (this.isJieboBoss) {
      this.attachJieboMythicRegalia();
    }

    const clips =
      options?.clips ??
      (this.isJieboBoss
        ? bundle?.glbs.get('boss_jiebo')?.animations
        : bundle?.glbs.get('boss_titan')?.animations) ??
      [];
    this.rig = new AnimationRig(this.model, clips, BOSS_CLIPS.idle);
  }

  get position(): THREE.Vector3 {
    return this.rootGroup.position;
  }

  get activeClip(): string {
    return this.rig.activeClipName;
  }

  get currentAttack(): string | null {
    return this.activeAttack ? this.activeAttack.spec.id : null;
  }

  get attackTelegraphActive(): boolean {
    return (
      this.aiState === 'WINDUP' &&
      this.activeAttack !== null &&
      this.activeAttack.phase === 'windup'
    );
  }

  private convertToNodeMaterial(
    origMat: THREE.Material | undefined,
    isWeapon: boolean,
  ): THREE.Material {
    const matName = origMat?.name ?? '';
    const lowerName = matName.toLowerCase();

    const origMap =
      origMat && 'map' in origMat
        ? ((origMat as THREE.MeshStandardMaterial).map ?? null)
        : null;
    const origNormalMap =
      origMat && 'normalMap' in origMat
        ? ((origMat as THREE.MeshStandardMaterial).normalMap ?? null)
        : null;
    const origRoughnessMap =
      origMat && 'roughnessMap' in origMat
        ? ((origMat as THREE.MeshStandardMaterial).roughnessMap ?? null)
        : null;
    const origMetalnessMap =
      origMat && 'metalnessMap' in origMat
        ? ((origMat as THREE.MeshStandardMaterial).metalnessMap ?? null)
        : null;
    const origColor =
      origMat && 'color' in origMat && origMat.color instanceof THREE.Color
        ? origMat.color
        : new THREE.Color(0xffffff);
    const origSide = origMat?.side ?? THREE.FrontSide;

    const magmaWave = sin(uv().y.mul(22.0).add(this.uTime.mul(3.5)))
      .mul(0.5)
      .add(0.5);
    const dissolveMask = tslClamp(
      float(1.0)
        .sub(this.uDissolve.mul(1.35))
        .add(magmaWave.mul(0.35)),
      0.0,
      1.0,
    );
    const dissolveEmber = smoothstep(0.05, 0.24, dissolveMask).mul(
      smoothstep(0.0, 0.08, this.uDissolve),
    );

    if (this.isJieboBoss) {
      const jbMat = new MeshStandardNodeMaterial({
        name: matName || 'BossJieboPbrNodeMaterial',
        metalness:
          origMat && 'metalness' in origMat && typeof origMat.metalness === 'number'
            ? origMat.metalness
            : 0.42,
        roughness:
          origMat && 'roughness' in origMat && typeof origMat.roughness === 'number'
            ? origMat.roughness
            : 0.52,
        side: origSide,
        alphaTest: 0.05,
      });
      if (origNormalMap) jbMat.normalMap = origNormalMap;
      if (origRoughnessMap) jbMat.roughnessMap = origRoughnessMap;
      if (origMetalnessMap) jbMat.metalnessMap = origMetalnessMap;

      const baseSample = origMap ? texture(origMap) : color(origColor);
      jbMat.colorNode = baseSample;

      const fresnel = pow(
        float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
        2.4,
      );
      // Procedural Blood-Moon Magma Veins + Roaring Hellfire Wing Tips (GPT Boss Sheet 01!)
      const veinPattern = pow(
        abs(
          sin(uv().x.mul(34.0).add(sin(uv().y.mul(27.0)).mul(1.8))).mul(
            cos(uv().y.mul(39.0).sub(this.uTime.mul(1.8))),
          ),
        ),
        4.0,
      );
      const awakenPower = saturate(
        this.uPhaseIntensity.mul(0.95).add(this.uTelegraphPulse.mul(0.85)),
      );
      const magmaVeins = color(0xff3810)
        .mul(veinPattern)
        .mul(awakenPower.mul(2.4).add(0.12));

      const enrageRim = mix(
        color(0xd89e38),
        color(0xff2c10),
        saturate(this.uPhaseIntensity.add(this.uTelegraphPulse.mul(0.6))),
      );
      jbMat.emissiveNode = enrageRim
        .mul(fresnel)
        .mul(
          float(0.32)
            .add(this.uPhaseIntensity.mul(1.25))
            .add(this.uTelegraphPulse.mul(1.15)),
        )
        .add(magmaVeins)
        .add(
          color(0xff7b1c)
            .mul(fresnel.mul(1.4).add(0.22))
            .mul(this.uHitFlash),
        )
        .add(color(0xff4a1c).mul(dissolveEmber.mul(2.5)));
      jbMat.opacityNode = dissolveMask;

      this.ownedMaterials.push(jbMat);
      return jbMat;
    }

    if (!isWeapon && (lowerName.includes('glow') || lowerName.includes('eye'))) {
      const eyeMat = new MeshBasicNodeMaterial({
        name: matName || 'BossEyeGlowNodeMaterial',
        side: origSide,
        alphaTest: 0.05,
      });
      const eyeColor = mix(
        color(0x55d8ff),
        color(0xff381c),
        this.uPhaseIntensity,
      );
      const heartbeat = sin(this.uTime.mul(mix(2.5, 6.0, this.uPhaseIntensity)))
        .mul(0.2)
        .add(1.0);
      eyeMat.colorNode = eyeColor
        .mul(float(2.6).add(this.uTelegraphPulse.mul(1.2)))
        .mul(heartbeat);
      eyeMat.opacityNode = dissolveMask;
      this.ownedMaterials.push(eyeMat);
      return eyeMat;
    }

    if (isWeapon) {
      const isGoldTrim = lowerName.includes('gold');
      const weaponMat = new MeshStandardNodeMaterial({
        name: matName || 'BossWeaponNodeMaterial',
        metalness: isGoldTrim ? 0.88 : 0.75,
        roughness: isGoldTrim ? 0.24 : 0.35,
        side: origSide,
        alphaTest: 0.05,
      });
      if (origNormalMap) weaponMat.normalMap = origNormalMap;
      if (origRoughnessMap) weaponMat.roughnessMap = origRoughnessMap;
      if (origMetalnessMap) weaponMat.metalnessMap = origMetalnessMap;

      const baseColor = isGoldTrim
        ? mix(color(origColor), color(0xc9932e), float(0.6))
        : mix(color(origColor), color(0x161820), float(0.72));
      weaponMat.colorNode = origMap
        ? mix(texture(origMap), baseColor, float(0.65))
        : baseColor;

      const fresnel = pow(
        float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
        2.5,
      );
      const glowTint = mix(
        color(0xc9932e),
        color(0xff3818),
        this.uPhaseIntensity,
      );
      weaponMat.emissiveNode = glowTint
        .mul(fresnel.mul(0.75).add(0.15))
        .mul(
          float(0.32)
            .add(this.uPhaseIntensity.mul(0.95))
            .add(this.uTelegraphPulse.mul(0.9)),
        )
        .add(color(0xff4a1c).mul(dissolveEmber.mul(2.4)));
      weaponMat.opacityNode = dissolveMask;

      this.ownedMaterials.push(weaponMat);
      return weaponMat;
    }

    // Cracked obsidian (#14161e, roughness 0.35, metalness 0.75) + tarnished gold trim + pulsing crimson-magma core
    const bodyMat = new MeshStandardNodeMaterial({
      name: matName || 'BossTitanNodeMaterial',
      metalness: 0.75,
      roughness: 0.35,
      side: origSide,
      alphaTest: 0.05,
    });
    if (origNormalMap) bodyMat.normalMap = origNormalMap;
    if (origRoughnessMap) bodyMat.roughnessMap = origRoughnessMap;
    if (origMetalnessMap) bodyMat.metalnessMap = origMetalnessMap;

    const baseSample = origMap ? texture(origMap) : color(origColor);
    const luma = dot(baseSample.rgb, vec3(0.299, 0.587, 0.114));
    const goldTrimMask = smoothstep(0.42, 0.78, luma);
    const obsidianBase = mix(baseSample, color(0x14161e), float(0.76));
    bodyMat.colorNode = mix(obsidianBase, color(0xb8892e), goldTrimMask.mul(0.72));

    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.6,
    );
    const crackBands = pow(magmaWave, 3.0);
    const corePulse = sin(this.uTime.mul(mix(2.2, 5.4, this.uPhaseIntensity)))
      .mul(0.25)
      .add(0.85);
    const rimColor = mix(
      color(0xc9932e),
      color(0xff3418),
      this.uPhaseIntensity,
    );
    const magmaColor = color(0xff3418);

    bodyMat.emissiveNode = rimColor
      .mul(fresnel)
      .mul(float(0.55).add(this.uPhaseIntensity.mul(1.1)).add(this.uTelegraphPulse))
      .add(
        magmaColor
          .mul(crackBands)
          .mul(corePulse)
          .mul(float(0.18).add(this.uPhaseIntensity.mul(1.35)).add(this.uTelegraphPulse.mul(0.85))),
      )
      .add(color(0xff4a1c).mul(dissolveEmber.mul(2.5)));
    bodyMat.opacityNode = dissolveMask;

    this.ownedMaterials.push(bodyMat);
    return bodyMat;
  }

  private applyDarkMythMaterials(): void {
    const ensureUv = (mesh: THREE.Mesh): void => {
      if (!mesh.geometry.attributes.uv && mesh.geometry.attributes.position) {
        mesh.geometry.setAttribute(
          'uv',
          new THREE.BufferAttribute(
            new Float32Array(mesh.geometry.attributes.position.count * 2),
            2,
          ),
        );
      }
    };

    this.model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      if (/Invisible/i.test(child.name)) {
        child.visible = false;
      }
      ensureUv(child);
      child.castShadow = true;
      child.receiveShadow = true;

      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) =>
          this.convertToNodeMaterial(m, false),
        );
      } else {
        child.material = this.convertToNodeMaterial(child.material, false);
      }
    });

    if (this.weaponModel) {
      this.weaponModel.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) {
          return;
        }
        if (/Invisible/i.test(child.name)) {
          child.visible = false;
        }
        ensureUv(child);
        child.castShadow = true;
        child.receiveShadow = true;

        if (Array.isArray(child.material)) {
          child.material = child.material.map((m) =>
            this.convertToNodeMaterial(m, true),
          );
        } else {
          child.material = this.convertToNodeMaterial(child.material, true);
        }
      });
    }
  }

  /**
   * Attaches Demon General Jiebo's signature Dark-Myth Regalia (GPT Boss Sheets 01-06):
   * 1) Floating Shattered Dark-Gold Corrupted Buddhist Halo Wheel (8 carved dharma tablets + 16 vajra spikes)
   * 2) Conjured 6.6m Blood-Gold Vajra Demon Greatsword (flashes on cleave attacks, permanently ignited in Phase II!)
   * 3) Sky-Dive Meteor Fireball Shroud Cone (visible when diving from the heavens!)
   */
  private attachJieboMythicRegalia(): void {
    const dissolveMask = tslClamp(
      float(1.0).sub(this.uDissolve.mul(1.3)),
      0.0,
      1.0,
    );

    // 1. Floating Shattered Dark-Gold Corrupted Buddhist Halo Wheel
    const haloRoot = new THREE.Group();
    haloRoot.name = 'JieboShatteredDharmaHalo';
    haloRoot.position.set(0, 4.45, -0.58);

    const haloOuter = new THREE.Group();
    const haloInner = new THREE.Group();
    haloRoot.add(haloOuter, haloInner);

    const bronzeHaloMat = new MeshStandardNodeMaterial({
      name: 'JieboDharmaBronzeNodeMaterial',
      color: 0x1c130c,
      metalness: 0.9,
      roughness: 0.3,
    });
    const hFres = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.2,
    );
    const haloRune = pow(
      abs(sin(uv().x.mul(18.0)).mul(cos(uv().y.mul(24.0)))),
      2.5,
    );
    const haloFire = mix(
      color(0xd89628),
      color(0xe61c08),
      saturate(this.uPhaseIntensity.add(this.uTelegraphPulse.mul(0.65))),
    );
    bronzeHaloMat.emissiveNode = haloFire.mul(
      hFres
        .mul(1.25)
        .add(haloRune.mul(0.55))
        .add(0.14)
        .mul(
          float(0.65)
            .add(this.uPhaseIntensity.mul(0.85))
            .add(this.uTelegraphPulse.mul(0.75)),
        ),
    );
    bronzeHaloMat.opacityNode = dissolveMask;
    this.ownedMaterials.push(bronzeHaloMat);

    const ringEnergyMat = new MeshBasicNodeMaterial({
      name: 'JieboHaloEnergyThreadMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    ringEnergyMat.colorNode = mix(
      color(0xd89628),
      color(0xff220a),
      this.uPhaseIntensity,
    ).mul(float(1.55));
    ringEnergyMat.opacityNode = dissolveMask.mul(0.78);
    this.ownedMaterials.push(ringEnergyMat);

    const outerTorusGeom = new THREE.TorusGeometry(1.95, 0.065, 10, 48);
    const innerTorusGeom = new THREE.TorusGeometry(1.28, 0.048, 10, 40);
    const tabletGeom = new THREE.BoxGeometry(0.56, 0.72, 0.09);
    const spikeGeom = new THREE.ConeGeometry(0.085, 0.58, 4);
    this.ownedGeometries.push(outerTorusGeom, innerTorusGeom, tabletGeom, spikeGeom);

    haloOuter.add(new THREE.Mesh(outerTorusGeom, ringEnergyMat));
    haloInner.add(new THREE.Mesh(innerTorusGeom, bronzeHaloMat));

    // 7 Shattered Corrupted Dharma Relief Tablets orbiting on outer halo
    for (let i = 0; i < 7; i += 1) {
      const ang = -Math.PI * 0.15 + (i / 6) * Math.PI * 1.3;
      const tab = new THREE.Mesh(tabletGeom, bronzeHaloMat);
      tab.position.set(Math.cos(ang) * 1.88, Math.sin(ang) * 1.88, 0);
      tab.rotation.z = ang - Math.PI * 0.5;
      tab.castShadow = false;
      haloOuter.add(tab);
    }

    // 12 Radial Vajra Spikes on inner counter-spinning wheel
    for (let i = 0; i < 12; i += 1) {
      const ang = (i / 12) * Math.PI * 2;
      const sp = new THREE.Mesh(spikeGeom, bronzeHaloMat);
      sp.position.set(Math.cos(ang) * 1.52, Math.sin(ang) * 1.52, 0);
      sp.rotation.z = ang - Math.PI * 0.5;
      haloInner.add(sp);
    }

    this.dharmaHaloOuter = haloOuter;
    this.dharmaHaloInner = haloInner;
    this.model.add(haloRoot);

    // 2. Conjured 6.6m Blood-Gold Vajra Demon Greatsword ("凝血金罡巨刃", GPT Boss Sheet 01 Right & 02!)
    const swordPivot = new THREE.Group();
    swordPivot.name = 'JieboConjuredDemonGreatsword';
    swordPivot.position.set(-1.45, 2.65, 0.55);
    swordPivot.rotation.set(0.42, -0.22, -0.52);

    const bladeGeom = new THREE.ConeGeometry(0.52, 5.4, 4);
    bladeGeom.scale(1.0, 1.0, 0.18);
    bladeGeom.translate(0, -2.55, 0);
    // Swept jagged demonic V-horn crossguard instead of round torus
    const hornLGeom = new THREE.ConeGeometry(0.16, 1.35, 4);
    hornLGeom.rotateZ(Math.PI * 0.36);
    hornLGeom.translate(0.52, 0.18, 0);
    const hornRGeom = new THREE.ConeGeometry(0.16, 1.35, 4);
    hornRGeom.rotateZ(-Math.PI * 0.36);
    hornRGeom.translate(-0.52, 0.18, 0);
    const hiltGeom = new THREE.CylinderGeometry(0.08, 0.11, 1.35, 8);
    hiltGeom.translate(0, 0.72, 0);
    this.ownedGeometries.push(bladeGeom, hornLGeom, hornRGeom, hiltGeom);

    const swordMat = new MeshStandardNodeMaterial({
      name: 'JieboBloodGoldGreatswordMat',
      color: 0x160908,
      metalness: 0.9,
      roughness: 0.26,
      transparent: true,
    });
    const swUv = uv();
    const swVein = pow(
      abs(sin(swUv.y.mul(32.0).sub(this.uTime.mul(4.5)).add(sin(swUv.x.mul(18.0))))),
      3.2,
    );
    const swFres = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.1,
    );
    const swordAlpha = saturate(
      this.uPhaseIntensity.add(this.uGreatswordGlow),
    ).mul(dissolveMask);
    // Dark obsidian fuller core + razor-hot blood-crimson & molten-gold blade edge!
    swordMat.emissiveNode = mix(
      color(0xb81006),
      color(0xff9d24),
      saturate(swFres.mul(0.9).add(swVein.mul(0.5))),
    ).mul(swFres.mul(1.85).add(swVein.mul(0.95)).add(0.22));
    swordMat.opacityNode = swordAlpha;
    this.ownedMaterials.push(swordMat);

    swordPivot.add(
      new THREE.Mesh(bladeGeom, swordMat),
      new THREE.Mesh(hornLGeom, swordMat),
      new THREE.Mesh(hornRGeom, swordMat),
      new THREE.Mesh(hiltGeom, swordMat),
    );
    swordPivot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.frustumCulled = false;
      }
    });
    this.greatswordPivot = swordPivot;
    this.model.add(swordPivot);

    // 3. Sky-Dive Meteor Fireball Shroud Cone (sheer crimson wind streaks so Boss silhouette stays crisp!)
    const coneGeom = new THREE.ConeGeometry(2.2, 6.4, 24, 1, true);
    coneGeom.translate(0, 2.6, 0);
    this.ownedGeometries.push(coneGeom);

    const coneMat = new MeshBasicNodeMaterial({
      name: 'JieboMeteorShroudMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cUv = uv();
    const cFade = smoothstep(1.0, 0.12, cUv.y).mul(smoothstep(0.0, 0.18, cUv.y));
    const cStreaks = pow(abs(sin(cUv.x.mul(25.1327).add(this.uTime.mul(16.0)))), 2.4);
    const cFres = pow(
      float(1.0).sub(saturate(abs(dot(normalView, positionViewDirection)))),
      1.5,
    );
    coneMat.colorNode = mix(color(0x9e0804), color(0xff6814), cStreaks).mul(float(1.55));
    coneMat.opacityNode = cFade.mul(cStreaks.mul(0.65).add(cFres.mul(0.55))).mul(this.uMeteorConeAlpha).mul(0.68);
    this.ownedMaterials.push(coneMat);

    const coneMesh = new THREE.Mesh(coneGeom, coneMat);
    coneMesh.visible = false;
    coneMesh.frustumCulled = false;
    this.meteorFireCone = coneMesh;
    this.model.add(coneMesh);
  }

  getChestCoreWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(
      this.rootGroup.position.x + Math.sin(this.facingYaw) * 0.95,
      3.05 + this.visualAltitudeY,
      this.rootGroup.position.z + Math.cos(this.facingYaw) * 0.95,
    );
  }

  setPhaseIntensity(t: number): void {
    this.uPhaseIntensity.value = clamp01(t);
  }

  setDissolve(amount: number): void {
    this.uDissolve.value = clamp01(amount);
  }

  /**
   * Triggers visceral 65Hz impact shudder and molten-gold armor flash when struck by Wukong's staff.
   * Driven by rawDt so the Boss visibly vibrates even while frozen inside hitstop!
   */
  triggerHitReaction(intensity: number, dirX = 0, dirZ = 0): void {
    if (this.disposed || this.aiState === 'DEAD') return;
    const clamped = clamp(intensity, 0.2, 1.6);
    this.uHitFlash.value = Math.max(this.uHitFlash.value, Math.min(1.35, clamped * 0.85));
    this.hitShudderDuration = clamped > 0.9 ? 0.2 : 0.13;
    this.hitShudderTimer = this.hitShudderDuration;
    this.hitShudderIntensity = clamped;
    const len = Math.hypot(dirX, dirZ);
    this.hitKnockDirX = len > 1e-4 ? dirX / len : 0;
    this.hitKnockDirZ = len > 1e-4 ? dirZ / len : -1;
  }

  private updateHitReactionVisuals(rawDt: number): void {
    if (rawDt <= 0) return;
    if (this.uHitFlash.value > 0) {
      this.uHitFlash.value = Math.max(0, this.uHitFlash.value - rawDt * 7.5);
    }
    if (this.hitShudderTimer > 0) {
      this.hitShudderTimer = Math.max(0, this.hitShudderTimer - rawDt);
      const t = this.hitShudderTimer / Math.max(0.01, this.hitShudderDuration);
      const buzz = Math.sin(this.uTime.value * 78) * 0.14 * this.hitShudderIntensity * t;
      const recoil = Math.sin(t * Math.PI) * 0.18 * this.hitShudderIntensity;
      // Convert world knock direction into rootGroup local XZ
      const cosY = Math.cos(-this.facingYaw);
      const sinY = Math.sin(-this.facingYaw);
      const lx = this.hitKnockDirX * cosY - this.hitKnockDirZ * sinY;
      const lz = this.hitKnockDirX * sinY + this.hitKnockDirZ * cosY;
      this.model.position.x = lx * recoil + lz * buzz;
      this.model.position.z = lz * recoil - lx * buzz;
    } else if (this.model.position.x !== 0 || this.model.position.z !== 0) {
      this.model.position.x = 0;
      this.model.position.z = 0;
    }
  }

  faceTarget(targetPos: Vec3Like): void {
    const dx = targetPos.x - this.rootGroup.position.x;
    const dz = targetPos.z - this.rootGroup.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) {
      return;
    }
    if (dx * dx + dz * dz <= 1e-6) {
      return;
    }
    const yaw = Math.atan2(dx, dz);
    if (Number.isFinite(yaw)) {
      this.facingYaw = yaw;
      this.rootGroup.rotation.y = yaw;
    }
  }

  private rotateTowardTarget(targetPos: Vec3Like, dt: number, turnRate: number): void {
    const dx = targetPos.x - this.rootGroup.position.x;
    const dz = targetPos.z - this.rootGroup.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || dx * dx + dz * dz <= 1e-6) {
      return;
    }
    const targetYaw = Math.atan2(dx, dz);
    const diff = Math.atan2(
      Math.sin(targetYaw - this.facingYaw),
      Math.cos(targetYaw - this.facingYaw),
    );
    const maxStep = turnRate * dt;
    if (Math.abs(diff) <= maxStep) {
      this.facingYaw = targetYaw;
    } else {
      this.facingYaw += Math.sign(diff) * maxStep;
    }
    this.rootGroup.rotation.y = this.facingYaw;
  }

  playClip(
    nameOrCandidates: string | readonly string[],
    options?: PlayClipOptions,
  ): string {
    return this.rig.play(nameOrCandidates, options);
  }

  enterCinematic(
    clipName?: string | readonly string[],
    options?: PlayClipOptions,
  ): void {
    this.cancelCurrentAttack();
    this.invulnerable = true;
    this.staggered = false;
    this.staggerRemaining = 0;
    this.aiState = 'CINEMATIC';
    this.uTelegraphPulse.value = 0;
    if (clipName) {
      this.playClip(clipName, options);
    }
  }

  /**
   * Drives Boss Jiebo's Shot 1 Sky-Meteor Descent & Shot 4 Aura Standoff during the Opening Cinematic.
   */
  updateIntroChoreography(progress: number): void {
    const p = clamp01(progress);
    if (p < 0.095) {
      // Shot 1A: Plunging from y = +19.5m out of the storm clouds wrapped in blood-crimson meteor fire!
      const dropT = clamp01(p / 0.095);
      const eased = dropT * dropT;
      this.visualAltitudeY = (1 - eased) * 19.5;
      this.model.position.y = this.visualAltitudeY;
      this.uTelegraphPulse.value = 1.0;
      if (this.meteorFireCone) {
        this.meteorFireCone.visible = true;
        this.uMeteorConeAlpha.value = 0.92;
      }
    } else {
      this.visualAltitudeY = 0;
      this.model.position.y = 0;
      if (this.meteorFireCone) {
        this.meteorFireCone.visible = false;
        this.uMeteorConeAlpha.value = 0;
      }
      // Blaze crimson-gold aura during Shot 1 roar (0.095..0.25) and Shot 4 clash standoff (0.78..0.95)
      if (p < 0.25) {
        this.uTelegraphPulse.value = 0.85 * (1 - (p - 0.095) / 0.155);
      } else if (p >= 0.78 && p < 0.96) {
        this.uTelegraphPulse.value = 0.82 * Math.sin(((p - 0.78) / 0.18) * Math.PI);
      } else {
        this.uTelegraphPulse.value = 0;
      }
    }
  }

  clearIntroChoreography(): void {
    this.visualAltitudeY = 0;
    this.model.position.y = 0;
    this.uTelegraphPulse.value = 0;
    this.uMeteorConeAlpha.value = 0;
    if (this.meteorFireCone) {
      this.meteorFireCone.visible = false;
    }
  }

  enterCombatPhase(phaseNum: 1 | 2): void {
    this.currentCombatPhase = phaseNum;
    this.invulnerable = false;
    this.staggered = false;
    this.staggerRemaining = 0;
    if (this.posture <= 0) {
      this.posture = this.maxPosture;
    }
    this.setPhaseIntensity(phaseNum === 2 ? 1 : 0);
    if (this.aiState !== 'DEAD') {
      this.aiState = 'IDLE';
      this.attackCooldown = phaseNum === 2 ? 0.65 : 0.9;
      this.playClip(BOSS_CLIPS.idle, { fadeSeconds: 0.16 });
    }
  }

  enterStagger(vfx?: VfxInterface): void {
    if (this.aiState === 'DEAD') {
      return;
    }
    this.cancelCurrentAttack(vfx);
    vfx?.clearAllTelegraphs?.();
    this.posture = 0;
    this.staggered = true;
    this.staggerRemaining = COMBAT_TUNING.bossStaggerDurationSeconds;
    this.aiState = 'STAGGERED';
    this.uTelegraphPulse.value = 0;
    this.playClip(BOSS_CLIPS.stagger, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.08,
      forceRestart: true,
    });
  }

  enterDead(vfx?: VfxInterface): void {
    this.cancelCurrentAttack(vfx);
    vfx?.clearAllTelegraphs?.();
    this.hp = 0;
    this.staggered = false;
    this.staggerRemaining = 0;
    this.invulnerable = true;
    this.aiState = 'DEAD';
    this.uTelegraphPulse.value = 0;
    this.playClip(BOSS_CLIPS.death, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.1,
      forceRestart: true,
    });
  }

  cancelCurrentAttack(vfx?: VfxInterface): void {
    if (this.activeAttack) {
      vfx?.clearTelegraph(this.activeAttack.telegraphId);
      vfx?.clearTelegraph(BOSS_PILLAR_ID);
      this.activeAttack = null;
    } else {
      vfx?.clearTelegraph(BOSS_TELEGRAPH_ID);
      vfx?.clearTelegraph(BOSS_PILLAR_ID);
    }
    vfx?.updateBossChestBeamCharge?.({ x: 0, y: 3, z: 0 }, 0, false);
    this.uTelegraphPulse.value = 0;
    this.uMeteorConeAlpha.value = 0;
    if (this.meteorFireCone) this.meteorFireCone.visible = false;
    this.visualAltitudeY = 0;
    this.model.position.y = 0;
    if (this.aiState === 'WINDUP' || this.aiState === 'ACTIVE' || this.aiState === 'RECOVERY') {
      this.aiState = 'IDLE';
    }
  }

  private renderTelegraph(
    state: ActiveBossAttackState,
    progress: number,
    vfx?: VfxInterface,
  ): void {
    if (!vfx) {
      return;
    }
    const tint =
      this.currentCombatPhase === 2 || state.spec.phase === 2
        ? 'crimson_gold'
        : 'amber';

    if (state.spec.id === 'heavenfall_pillars') {
      vfx.showTelegraphRing(state.telegraphId, {
        center: state.origin,
        innerRadius: 0.6,
        outerRadius: state.spec.radius,
        progress,
        color: 'crimson_gold',
      });
      if (hasPillarTelegraph(vfx)) {
        vfx.showTelegraphPillar(BOSS_PILLAR_ID, {
          center: state.origin,
          radius: state.spec.radius,
          height: 18,
          progress,
          color: 'crimson_gold',
        });
      }
      return;
    }

    if (state.spec.telegraphType === 'arc') {
      vfx.showTelegraphArc(state.telegraphId, {
        origin: state.origin,
        direction: state.direction,
        radius: state.spec.radius,
        arcAngleRad: BOSS_ARC_HALF_ANGLE_RAD * 2,
        progress,
        color: tint,
      });
    } else if (state.spec.telegraphType === 'line') {
      vfx.showTelegraphLine(state.telegraphId, {
        origin: state.origin,
        direction: state.direction,
        length: state.spec.radius,
        width: BOSS_LINE_HALF_WIDTH * 2,
        progress,
        color: tint,
      });
    } else {
      vfx.showTelegraphRing(state.telegraphId, {
        center: state.origin,
        innerRadius: state.spec.id === 'temple_shockwave' ? 1.8 : 0.8,
        outerRadius: state.spec.radius,
        progress,
        color: tint,
      });
    }
  }

  private beginAttack(
    spec: BossAttackSpec,
    playerPos: Vec3Like,
    vfx?: VfxInterface,
    callbacks?: BossTickCallbacks,
  ): void {
    this.faceTarget(playerPos);

    const dx = playerPos.x - this.rootGroup.position.x;
    const dz = playerPos.z - this.rootGroup.position.z;
    const dist = Math.hypot(dx, dz);
    const dirX = dist > 1e-4 ? dx / dist : Math.sin(this.facingYaw);
    const dirZ = dist > 1e-4 ? dz / dist : Math.cos(this.facingYaw);

    let origin: THREE.Vector3;
    if (spec.id === 'heavenfall_pillars') {
      const clampedTarget = clampArenaPosition(playerPos, this.arenaRadius, 0.8);
      origin = new THREE.Vector3(clampedTarget.x, 0, clampedTarget.z);
    } else {
      origin = new THREE.Vector3(
        this.rootGroup.position.x,
        0,
        this.rootGroup.position.z,
      );
    }

    const attackState: ActiveBossAttackState = {
      spec,
      phase: 'windup',
      elapsed: 0,
      windupRemaining: spec.windupSeconds,
      origin,
      direction: new THREE.Vector3(dirX, 0, dirZ),
      hitDelivered: false,
      perfectDodgeAwarded: false,
      telegraphId: BOSS_TELEGRAPH_ID,
    };

    this.activeAttack = attackState;
    this.aiState = 'WINDUP';
    this.uTelegraphPulse.value = 0.05;

    const clipCandidates = ATTACK_CLIP_MAP[spec.id];
    const primaryClip = clipCandidates[0];
    const rawDuration = this.rig.getClipDuration(primaryClip);
    let timeScale = 1.0;
    let startTime = 0;

    if (this.isJieboBoss && rawDuration > 3.5) {
      // Seek directly to the pre-strike coiling window so Boss Jiebo's peak 3D wing-whip / slam / roar
      // hits at the exact millisecond windupRemaining reaches 0!
      timeScale = 1.65;
      const peakSec = JIEBO_CLIP_PEAK_SECONDS[spec.id] ?? 3.2;
      startTime = Math.max(0, peakSec - spec.windupSeconds * timeScale);
    } else {
      const targetDuration = spec.windupSeconds + spec.activeSeconds * 0.7;
      timeScale =
        rawDuration > 0 && targetDuration > 0
          ? clamp(rawDuration / targetDuration, 0.65, 2.2)
          : 1.0;
    }

    this.playClip(clipCandidates, {
      loop: THREE.LoopOnce,
      clampWhenFinished: true,
      fadeSeconds: 0.1,
      timeScale,
      startTime,
      forceRestart: true,
    });

    this.renderTelegraph(attackState, 0, vfx);
    callbacks?.onTelegraphSfx?.('boss_roar');
  }

  triggerTestAttack(
    attackId?: string,
    playerPos?: Vec3Like,
    vfx?: VfxInterface,
  ): BossAttackSpec | null {
    const targetId =
      attackId ??
      (this.currentCombatPhase === 2 ? 'twin_abyssal_cleave' : 'abyssal_sweep');

    const spec = COMBAT_TUNING.bossAttacks.find(
      (entry) => entry.id === targetId,
    );
    if (!spec) {
      return null;
    }

    if (this.staggered || this.posture <= 0 || !Number.isFinite(this.posture)) {
      this.posture = this.maxPosture;
    }
    this.staggered = false;
    this.staggerRemaining = 0;
    this.invulnerable = false;
    this.cancelCurrentAttack(vfx);

    const target = playerPos ?? {
      x: this.rootGroup.position.x + Math.sin(this.facingYaw) * 4,
      y: 0,
      z: this.rootGroup.position.z + Math.cos(this.facingYaw) * 4,
    };
    this.beginAttack(spec, target, vfx);
    return spec;
  }

  evaluatePlayerInHitbox(playerPos: Vec3Like, extraMargin = 0): boolean {
    if (!this.activeAttack) {
      return false;
    }
    if (!Number.isFinite(playerPos.x) || !Number.isFinite(playerPos.z)) {
      return false;
    }

    const margin = Number.isFinite(extraMargin) ? Math.max(0, extraMargin) : 0;
    const { spec, origin, direction } = this.activeAttack;
    const dx = playerPos.x - origin.x;
    const dz = playerPos.z - origin.z;
    const dist = Math.hypot(dx, dz);

    if (spec.telegraphType === 'ring') {
      return dist <= spec.radius + margin;
    }

    if (spec.telegraphType === 'arc') {
      if (dist > spec.radius + margin) {
        return false;
      }
      if (dist <= 1.2 + margin) {
        return true;
      }
      const dirLen = Math.hypot(direction.x, direction.z);
      const nx = dirLen > 1e-5 ? direction.x / dirLen : 0;
      const nz = dirLen > 1e-5 ? direction.z / dirLen : 1;
      const dotVal = clamp((dx / dist) * nx + (dz / dist) * nz, -1, 1);
      const angle = Math.acos(dotVal);
      return angle <= BOSS_ARC_HALF_ANGLE_RAD + (margin > 0 ? 0.14 : 0);
    }

    // Line attack
    const dirLen = Math.hypot(direction.x, direction.z);
    const nx = dirLen > 1e-5 ? direction.x / dirLen : 0;
    const nz = dirLen > 1e-5 ? direction.z / dirLen : 1;
    const forward = dx * nx + dz * nz;
    const lateral = Math.abs(dx * -nz + dz * nx);
    return (
      forward >= -1.0 - margin &&
      forward <= spec.radius + margin &&
      lateral <= BOSS_LINE_HALF_WIDTH + margin
    );
  }

  private selectNextAttack(
    combatPhase: 1 | 2,
    distToPlayer: number,
  ): BossAttackSpec {
    const phaseAttacks = COMBAT_TUNING.bossAttacks.filter(
      (a) => a.phase === combatPhase,
    );
    const pool =
      phaseAttacks.length > 0 ? phaseAttacks : COMBAT_TUNING.bossAttacks;

    const inRange = pool.filter((a) => a.radius + 1.0 >= distToPlayer);
    const candidates = inRange.length > 0 ? inRange : pool;
    const chosen = candidates[this.attackCycleIndex % candidates.length]!;
    this.attackCycleIndex += 1;
    return chosen;
  }

  update(
    worldDt: number,
    rawDt: number,
    combatPhase: 1 | 2 | null,
    playerPos: Vec3Like,
    vfx?: VfxInterface,
    callbacks?: BossTickCallbacks,
  ): void {
    if (this.disposed) {
      return;
    }

    const safeWorldDt = Number.isFinite(worldDt) && worldDt > 0 ? worldDt : 0;
    const safeRawDt = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : 0;

    this.uTime.value += safeRawDt;
    this.updateHitReactionVisuals(safeRawDt);
    this.updateMythicRegaliaAndFlight(safeWorldDt, safeRawDt, vfx);

    if (this.aiState === 'DEAD') {
      this.rig.update(safeWorldDt);
      return;
    }

    if (this.aiState === 'CINEMATIC' || combatPhase === null) {
      this.rig.update(safeWorldDt);
      const clamped = clampArenaPosition(
        this.rootGroup.position,
        this.arenaRadius,
        1.0,
      );
      this.rootGroup.position.set(clamped.x, 0, clamped.z);
      return;
    }

    this.currentCombatPhase = combatPhase;

    if (this.aiState === 'STAGGERED') {
      this.staggerRemaining = Math.max(0, this.staggerRemaining - safeWorldDt);
      if (this.staggerRemaining <= 0) {
        this.staggered = false;
        this.posture = this.maxPosture;
        this.aiState = 'IDLE';
        this.attackCooldown = combatPhase === 2 ? 0.6 : 0.85;
        this.playClip(BOSS_CLIPS.idle, { fadeSeconds: 0.16 });
        callbacks?.onStaggerEnd?.();
      }
      this.rig.update(safeWorldDt);
      return;
    }

    if (this.activeAttack) {
      const active = this.activeAttack;
      active.elapsed += safeWorldDt;

      if (active.phase === 'windup') {
        active.windupRemaining = Math.max(
          0,
          active.spec.windupSeconds - active.elapsed,
        );
        const progress =
          active.spec.windupSeconds > 0
            ? clamp01(active.elapsed / active.spec.windupSeconds)
            : 1;
        this.uTelegraphPulse.value = progress;

        // Gentle tracking in first 30% of windup before locking trajectory
        if (progress < 0.3 && active.spec.id !== 'heavenfall_pillars') {
          this.rotateTowardTarget(playerPos, safeWorldDt, 4.0);
          const dx = playerPos.x - this.rootGroup.position.x;
          const dz = playerPos.z - this.rootGroup.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 1e-4) {
            active.direction.set(dx / dist, 0, dz / dist);
          }
        }

        this.renderTelegraph(active, progress, vfx);

        if (active.elapsed >= active.spec.windupSeconds) {
          vfx?.clearTelegraph(active.telegraphId);
          vfx?.clearTelegraph(BOSS_PILLAR_ID);
          vfx?.updateBossChestBeamCharge?.({ x: 0, y: 3, z: 0 }, 0, false);
          this.uTelegraphPulse.value = 0;
          this.uMeteorConeAlpha.value = 0;
          if (this.meteorFireCone) this.meteorFireCone.visible = false;

          active.phase = 'active';
          active.elapsed = 0;
          active.windupRemaining = 0;
          this.aiState = 'ACTIVE';

          callbacks?.onTelegraphSfx?.(ATTACK_SFX_MAP[active.spec.id]);
          callbacks?.onAttackImpact?.(
            active.spec,
            active.origin,
            active.direction,
          );
        }
      } else if (active.phase === 'active') {
        if (active.elapsed >= active.spec.activeSeconds) {
          active.phase = 'recovery';
          active.elapsed = 0;
          this.aiState = 'RECOVERY';
        }
      } else {
        if (active.elapsed >= active.spec.recoverySeconds) {
          this.activeAttack = null;
          this.aiState = 'IDLE';
          this.attackCooldown = combatPhase === 2 ? 1.0 : 1.4;
          this.playClip(BOSS_CLIPS.idle, { fadeSeconds: 0.18 });
        }
      }

      const clamped = clampArenaPosition(
        this.rootGroup.position,
        this.arenaRadius,
        1.0,
      );
      this.rootGroup.position.set(clamped.x, 0, clamped.z);
      this.rig.update(safeWorldDt);
      return;
    }

    // IDLE / CHASE state
    const turnRate = combatPhase === 2 ? 6.0 : 4.5;
    this.rotateTowardTarget(playerPos, safeWorldDt, turnRate);

    const dx = playerPos.x - this.rootGroup.position.x;
    const dz = playerPos.z - this.rootGroup.position.z;
    const dist = Math.hypot(dx, dz);
    this.attackCooldown = Math.max(0, this.attackCooldown - safeWorldDt);

    if (this.attackCooldown <= 0 && dist <= 15.0) {
      const nextSpec = this.selectNextAttack(combatPhase, dist);
      this.beginAttack(nextSpec, playerPos, vfx, callbacks);
    } else if (dist > 5.2 && safeWorldDt > 0) {
      this.aiState = 'CHASE';
      const moveSpeed = combatPhase === 2 ? 4.8 : 3.6;
      const nx = dx / dist;
      const nz = dz / dist;
      this.rootGroup.position.x += nx * moveSpeed * safeWorldDt;
      this.rootGroup.position.z += nz * moveSpeed * safeWorldDt;
      this.playClip(combatPhase === 2 ? BOSS_CLIPS.run : BOSS_CLIPS.walk, {
        fadeSeconds: 0.16,
      });
    } else {
      this.aiState = 'IDLE';
      this.playClip(BOSS_CLIPS.idle, { fadeSeconds: 0.18 });
    }

    const clamped = clampArenaPosition(
      this.rootGroup.position,
      this.arenaRadius,
      1.0,
    );
    this.rootGroup.position.set(clamped.x, 0, clamped.z);
    this.rig.update(safeWorldDt);
  }

  private updateMythicRegaliaAndFlight(
    worldDt: number,
    rawDt: number,
    vfx?: VfxInterface,
  ): void {
    const dt = Math.max(worldDt, rawDt * 0.35);
    const spinMult =
      1.0 + this.uPhaseIntensity.value * 1.85 + this.uTelegraphPulse.value * 2.4;
    if (this.dharmaHaloOuter) {
      this.dharmaHaloOuter.rotation.z += dt * 0.48 * spinMult;
    }
    if (this.dharmaHaloInner) {
      this.dharmaHaloInner.rotation.z -= dt * 0.82 * spinMult;
    }

    let targetAltY = 0;
    let targetSwordGlow = this.uPhaseIntensity.value;
    let swordSweepAngle = 0;
    let meteorCone = 0;

    if (this.activeAttack) {
      const { spec, phase, elapsed } = this.activeAttack;
      const isMeteorSlam =
        spec.id === 'shattered_earth_slam' || spec.id === 'cataclysmic_leap_slam';
      const isSkyLevitate =
        spec.id === 'heavenfall_pillars' || spec.id === 'temple_shockwave';
      const isSwordCleave =
        spec.id === 'abyssal_sweep' ||
        spec.id === 'twin_abyssal_cleave' ||
        spec.id === 'cross_slash_wave';
      const isChestLaser = spec.id === 'phantom_thrust';

      if (phase === 'windup') {
        const p =
          spec.windupSeconds > 0 ? clamp01(elapsed / spec.windupSeconds) : 1;

        if (isMeteorSlam) {
          // Ascend 8.2m into the sky (0..0.76), then rocket straight down like a blazing meteor (0.76..1.0)!
          if (p < 0.76) {
            const upT = p / 0.76;
            targetAltY = Math.sin(upT * Math.PI * 0.5) * 8.2;
            meteorCone = upT * 0.55;
          } else {
            const diveT = (p - 0.76) / 0.24;
            targetAltY = (1 - diveT * diveT) * 8.2;
            meteorCone = 0.95;
          }
        } else if (isSkyLevitate) {
          targetAltY = Math.sin(Math.min(1, p * 1.4) * Math.PI * 0.5) * 3.4;
        }

        if (isSwordCleave) {
          targetSwordGlow = 1.0;
          swordSweepAngle = -1.15 * p;
        }

        if (isChestLaser) {
          vfx?.updateBossChestBeamCharge?.(
            this.getChestCoreWorldPosition(),
            p,
            true,
          );
        }
      } else if (phase === 'active') {
        const ap =
          spec.activeSeconds > 0 ? clamp01(elapsed / spec.activeSeconds) : 1;
        if (isSkyLevitate) {
          targetAltY = 3.4 * (1 - ap * 0.65);
        }
        if (isSwordCleave) {
          targetSwordGlow = 1.0;
          swordSweepAngle = -1.15 + Math.min(1, ap * 2.4) * 2.55;
        }
      }
    }

    const altLerp = 1 - Math.exp(-18 * Math.max(dt, 0.008));
    this.visualAltitudeY += (targetAltY - this.visualAltitudeY) * altLerp;
    this.model.position.y = this.visualAltitudeY;

    this.uGreatswordGlow.value +=
      (targetSwordGlow - this.uGreatswordGlow.value) * altLerp;
    if (this.greatswordPivot) {
      this.greatswordPivot.rotation.set(
        0.45 + swordSweepAngle * 0.35,
        -0.25 + swordSweepAngle * 0.88,
        -0.58 - swordSweepAngle * 0.42,
      );
    }

    this.uMeteorConeAlpha.value = meteorCone;
    if (this.meteorFireCone) {
      this.meteorFireCone.visible = meteorCone > 0.02;
    }
  }

  reset(vfx?: VfxInterface): void {
    if (this.disposed) {
      return;
    }
    this.cancelCurrentAttack(vfx);
    vfx?.clearAllTelegraphs?.();
    this.rootGroup.position.set(BOSS_SPAWN_X, 0, BOSS_SPAWN_Z);
    this.facingYaw = 0;
    this.rootGroup.rotation.set(0, 0, 0);
    this.hp = this.maxHp;
    this.posture = this.maxPosture;
    this.staggered = false;
    this.staggerRemaining = 0;
    this.invulnerable = true;
    this.aiState = 'CINEMATIC';
    this.activeAttack = null;
    this.currentCombatPhase = 1;
    this.attackCooldown = 1.0;
    this.attackCycleIndex = 0;
    this.uPhaseIntensity.value = 0;
    this.uTelegraphPulse.value = 0;
    this.uDissolve.value = 0;
    this.uHitFlash.value = 0;
    this.uGreatswordGlow.value = 0;
    this.uMeteorConeAlpha.value = 0;
    this.visualAltitudeY = 0;
    this.hitShudderTimer = 0;
    this.model.position.set(0, 0, 0);
    if (this.meteorFireCone) this.meteorFireCone.visible = false;
    this.rig.play(BOSS_CLIPS.idle, { fadeSeconds: 0, forceRestart: true });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rig.dispose();
    for (const geom of this.ownedGeometries) {
      geom.dispose();
    }
    for (const mat of this.ownedMaterials) {
      mat.dispose();
    }
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.rootGroup.clear();
    this.rootGroup.removeFromParent();
  }
}
