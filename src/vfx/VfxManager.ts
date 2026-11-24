import * as THREE from 'three';
import type { AssetLoader } from '../engine/AssetLoader.ts';
import type {
  SlashColorPreset,
  TelegraphArcParams,
  TelegraphLineParams,
  TelegraphRingParams,
  Vec3Like,
  VfxInterface,
} from '../types/game.ts';
import { BossSpectacleVfx } from './BossSpectacleVfx.ts';
import { ParticleVfx } from './ParticleVfx.ts';
import { SlashTrailVfx } from './SlashTrailVfx.ts';
import { TelegraphVfx, type TelegraphPillarParams } from './TelegraphVfx.ts';
import { WukongSkillSpectacleVfx } from './WukongSkillSpectacleVfx.ts';

export class VfxManager implements VfxInterface {
  readonly rootGroup = new THREE.Group();
  readonly slashTrails: SlashTrailVfx;
  readonly telegraphs: TelegraphVfx;
  readonly particles: ParticleVfx;
  readonly bossSpectacles: BossSpectacleVfx;
  readonly wukongSkills: WukongSkillSpectacleVfx;

  private readonly scene: THREE.Scene;
  private disposed = false;

  constructor(scene: THREE.Scene, assetLoader?: AssetLoader) {
    this.scene = scene;
    this.rootGroup.name = 'VfxManagerRoot';

    this.slashTrails = new SlashTrailVfx();
    this.telegraphs = new TelegraphVfx();
    this.particles = new ParticleVfx();
    this.bossSpectacles = new BossSpectacleVfx();
    this.wukongSkills = new WukongSkillSpectacleVfx(assetLoader);

    this.rootGroup.add(
      this.slashTrails.group,
      this.telegraphs.group,
      this.particles.group,
      this.bossSpectacles.group,
      this.wukongSkills.group,
    );
    this.scene.add(this.rootGroup);
  }

  spawnSlashArc(
    origin: Vec3Like,
    dir: Vec3Like,
    angle: number,
    colorPreset: SlashColorPreset,
    scale = 1,
  ): void {
    if (this.disposed) {
      return;
    }
    this.slashTrails.spawn(origin, dir, angle, colorPreset, scale);
  }

  spawnImpactBurst(pos: Vec3Like, heavy: boolean): void {
    if (this.disposed) {
      return;
    }
    this.particles.spawnImpactBurst(pos, heavy);
  }

  showTelegraphRing(id: string, params: TelegraphRingParams): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.showRing(id, params);
  }

  showTelegraphArc(id: string, params: TelegraphArcParams): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.showArc(id, params);
  }

  showTelegraphLine(id: string, params: TelegraphLineParams): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.showLine(id, params);
  }

  showTelegraphPillar(id: string, params: TelegraphPillarParams): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.showPillar(id, params);
  }

  clearTelegraph(id: string): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.clear(id);
  }

  clearAllTelegraphs(): void {
    if (this.disposed) {
      return;
    }
    this.telegraphs.clearAll();
  }

  triggerPostureBreakBurst(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    this.particles.triggerPostureBreakBurst(pos);
  }

  triggerSkill3Domain(active: boolean, targetPos?: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    this.particles.triggerSkill3Domain(active, targetPos);
  }

  triggerLotusWardBurst(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    this.particles.triggerLotusWardBurst(pos);
  }

  spawnStaffDragSparks(pos: Vec3Like, dirX: number, dirZ: number): void {
    if (this.disposed) {
      return;
    }
    this.particles.spawnStaffDragSparks(pos, dirX, dirZ);
  }

  spawnDodgePhantomTrail(pos: Vec3Like, dirX: number, dirZ: number): void {
    if (this.disposed) {
      return;
    }
    this.particles.spawnDodgePhantomTrail(pos, dirX, dirZ);
  }

  spawnBossWingCrescent(
    origin: Vec3Like,
    dir: Vec3Like,
    radius = 12.0,
    tiltRad = 0.22,
  ): void {
    if (this.disposed) return;
    this.bossSpectacles.spawnWingBloodCrescent(origin, dir, radius, tiltRad);
  }

  spawnBossMeteorSlam(center: Vec3Like, radius = 9.5): void {
    if (this.disposed) return;
    this.bossSpectacles.spawnMeteorCataclysmSlam(center, radius);
  }

  updateBossChestBeamCharge(
    chestPos: Vec3Like,
    progress: number,
    active: boolean,
  ): void {
    if (this.disposed) return;
    this.bossSpectacles.updateChestBeamCharge(chestPos, progress, active);
  }

  fireBossChestBeam(chestPos: Vec3Like, dir: Vec3Like): void {
    if (this.disposed) return;
    this.bossSpectacles.fireChestAnnihilationBeam(chestPos, dir);
  }

  spawnBossHeavenfallPillars(center: Vec3Like, spreadRadius = 5.4): void {
    if (this.disposed) return;
    this.bossSpectacles.spawnHeavenfallVajraPillars(center, spreadRadius);
  }

  spawnBossCrossBladeStorm(origin: Vec3Like, dir: Vec3Like): void {
    if (this.disposed) return;
    this.bossSpectacles.spawnCrossBladeStorm(origin, dir);
  }

  spawnPlayerHitSparks(
    pos: Vec3Like,
    knockDirX: number,
    knockDirZ: number,
    heavy: boolean,
  ): void {
    if (this.disposed) return;
    this.wukongSkills.spawnPlayerHitSparks(pos, knockDirX, knockDirZ, heavy);
  }

  spawnSkill1CloneBlitz(
    startPos: Vec3Like,
    endPos: Vec3Like,
    bossPos: Vec3Like,
  ): void {
    if (this.disposed) return;
    this.wukongSkills.spawnSkill1CloneBlitz(startPos, endPos, bossPos);
  }

  triggerSkill1CloneSlash(bossPos: Vec3Like, hitIndex: number): void {
    if (this.disposed) return;
    this.wukongSkills.triggerSkill1CloneSlash(bossPos, hitIndex);
  }

  spawnSkill2PillarAscent(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    this.wukongSkills.spawnSkill2PillarAscent(playerPos, bossPos);
  }

  spawnSkill2DragonPillarSlam(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    this.wukongSkills.spawnSkill2DragonPillarSlam(playerPos, bossPos);
  }

  updateSkill3GreatSageDomain(
    active: boolean,
    playerPos?: Vec3Like,
    bossPos?: Vec3Like,
    facingYaw?: number,
  ): void {
    if (this.disposed) return;
    this.wukongSkills.updateSkill3GreatSageDomain(
      active,
      playerPos,
      bossPos,
      facingYaw,
    );
  }

  triggerSkill3CloneBlitzSlash(bossPos: Vec3Like, slashIndex: number): void {
    if (this.disposed) return;
    this.wukongSkills.triggerSkill3CloneBlitzSlash(bossPos, slashIndex);
  }

  triggerSkill3DharmakayaSlam(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    this.wukongSkills.triggerSkill3DharmakayaSlam(playerPos, bossPos);
  }

  updateIntroCinematicVfx(
    active: boolean,
    progress = 0,
    playerPos?: Vec3Like,
    earPos?: Vec3Like,
  ): void {
    if (this.disposed) return;
    this.wukongSkills.updateIntroCinematicVfx(
      active,
      progress,
      playerPos,
      earPos,
    );
  }

  triggerIntroClashShockwave(centerPos: Vec3Like): void {
    if (this.disposed) return;
    this.wukongSkills.triggerIntroClashShockwave(centerPos);
  }

  setPhaseIntensity(t: number): void {
    if (this.disposed) {
      return;
    }
    this.particles.setPhaseIntensity(t);
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }
    this.slashTrails.update(dt);
    this.telegraphs.update(dt);
    this.particles.update(dt);
    this.bossSpectacles.update(dt);
    this.wukongSkills.update(dt);
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.slashTrails.reset();
    this.telegraphs.reset();
    this.particles.reset();
    this.bossSpectacles.reset();
    this.wukongSkills.reset();
  }

  setPrewarmVisible(enabled: boolean): void {
    if (this.disposed) return;
    this.wukongSkills.setPrewarmVisible(enabled);
    this.bossSpectacles.setPrewarmVisible(enabled);
    if (!enabled) {
      this.reset();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.slashTrails.dispose();
    this.telegraphs.dispose();
    this.particles.dispose();
    this.bossSpectacles.dispose();
    this.wukongSkills.dispose();
    this.rootGroup.clear();
    this.rootGroup.removeFromParent();
  }

  getActiveSlashCount(): number {
    return this.slashTrails.getActiveCount();
  }

  getActiveTelegraphCount(): number {
    return this.telegraphs.getActiveCount();
  }

  getActiveBurstParticleCount(): number {
    return this.particles.getActiveBurstCount();
  }

  isSkill3DomainActive(): boolean {
    return this.particles.isSkill3DomainActive();
  }
}
