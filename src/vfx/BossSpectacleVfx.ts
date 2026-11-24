import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  atan,
  color,
  cos,
  dot,
  float,
  length,
  mix,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import type { Vec3Like } from '../types/game.ts';

function createFloatUniform(initial: number) {
  return uniform(initial);
}
type FloatUniform = ReturnType<typeof createFloatUniform>;

function sanitize(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

interface CrescentWaveSlot {
  group: THREE.Group;
  bladeMesh: THREE.Mesh;
  scorchMesh: THREE.Mesh;
  uProgress: FloatUniform;
  uScorchFade: FloatUniform;
  active: boolean;
  elapsed: number;
  bladeDuration: number;
  scorchDuration: number;
  maxRadius: number;
}

interface MeteorSlamSlot {
  group: THREE.Group;
  domeMesh: THREE.Mesh;
  cracksMesh: THREE.Mesh;
  boulders: Array<{
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    rx: number;
    ry: number;
  }>;
  uDomeProgress: FloatUniform;
  uCracksFade: FloatUniform;
  active: boolean;
  elapsed: number;
  domeDuration: number;
  cracksDuration: number;
  targetRadius: number;
}

interface LaserBeamState {
  chargeGroup: THREE.Group;
  beamGroup: THREE.Group;
  trenchMesh: THREE.Mesh;
  spiralRings: THREE.Mesh[];
  uCharge: FloatUniform;
  uBeamProgress: FloatUniform;
  uTrenchFade: FloatUniform;
  uTime: FloatUniform;
  firing: boolean;
  trenchActive: boolean;
  elapsed: number;
  beamDuration: number;
  trenchDuration: number;
}

interface VajraPillarSlot {
  group: THREE.Group;
  columns: THREE.Group[];
  uProgress: FloatUniform;
  uTime: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
}

interface CrossStormSlot {
  group: THREE.Group;
  waveGroup: THREE.Group;
  feathers: Array<{
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    delay: number;
  }>;
  uProgress: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  speed: number;
}

/**
 * Pre-allocated, 100% WebGPU TSL NodeMaterial Boss Cataclysmic Attack VFX System.
 * Implements the 5 GPT Image 2.6 signature attacks for Demon General Jiebo:
 * 1) 14m 3D Blood-Flame Wing Crescent Wave + Ground Lava Scorch
 * 2) Sky Meteor Hemispherical Shockwave Dome + Spiderweb Magma Cracks + 3D Flying Boulders
 * 3) 22m Chest Core Singularity Charge + Helical Annihilation Laser Cannon + Molten Trench
 * 4) 5-Constellation Corrupted Sanskrit Sigils + 22m Heavenfall Thunder-Magma Pillars
 * 5) Traveling 8m 3D X-Cross Blood-Moon Wave + Homing Razor Wing-Feather Barrage
 */
export class BossSpectacleVfx {
  readonly group = new THREE.Group();

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  private readonly crescentPool: CrescentWaveSlot[] = [];
  private readonly meteorPool: MeteorSlamSlot[] = [];
  private readonly laser: LaserBeamState;
  private readonly pillarPool: VajraPillarSlot[] = [];
  private readonly crossPool: CrossStormSlot[] = [];

  private globalTime = 0;
  private disposed = false;

  constructor() {
    this.group.name = 'BossSpectacleVfxGroup';

    for (let i = 0; i < 3; i += 1) {
      this.crescentPool.push(this.createCrescentSlot(i));
    }
    for (let i = 0; i < 2; i += 1) {
      this.meteorPool.push(this.createMeteorSlot(i));
    }
    this.laser = this.createLaserState();
    for (let i = 0; i < 2; i += 1) {
      this.pillarPool.push(this.createPillarSlot(i));
    }
    for (let i = 0; i < 2; i += 1) {
      this.crossPool.push(this.createCrossStormSlot(i));
    }
  }

  // -------------------------------------------------------------------------
  // 1. 14m 3D Blood-Flame Wing Crescent Wave + Smoldering Lava Scorch
  // -------------------------------------------------------------------------
  private createCrescentSlot(index: number): CrescentWaveSlot {
    const uProgress = uniform(0);
    const uScorchFade = uniform(0);

    // Wide 225-degree crescent ring geometry in XZ plane
    const arcSpan = Math.PI * 1.28;
    const bladeGeom = new THREE.RingGeometry(
      0.42,
      1.0,
      56,
      4,
      -Math.PI * 0.5 - arcSpan * 0.5,
      arcSpan,
    );
    bladeGeom.rotateX(-Math.PI * 0.5);
    // Remap RingGeometry UVs cleanly to (u = arc [0..1], v = radial [0..1])
    const pos = bladeGeom.attributes.position as THREE.BufferAttribute;
    const uvs = bladeGeom.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);
      const ang = Math.atan2(z, x); // centered around -PI/2 (-Z? wait: after rotateX(-PI/2), +Y became -Z!)
      // Let's orient so local +Z is forward!
      pos.setZ(i, -z);
      const uVal = (ang + Math.PI * 0.5 + arcSpan * 0.5) / arcSpan;
      const vVal = (r - 0.42) / 0.58;
      // Lift outer leading edge slightly upward into a 3D cupped wave!
      pos.setY(i, Math.sin(Math.max(0, Math.min(1, uVal)) * Math.PI) * vVal * 0.12);
      uvs.setXY(i, Math.max(0, Math.min(1, uVal)), Math.max(0, Math.min(1, vVal)));
    }
    bladeGeom.computeVertexNormals();
    this.ownedGeometries.push(bladeGeom);

    const bladeMat = new MeshBasicNodeMaterial({
      name: `BossBloodCrescentMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const uvN = uv();
    const arcTaper = sin(saturate(uvN.x).mul(Math.PI));
    const radialCore = smoothstep(0.18, 0.88, uvN.y).mul(smoothstep(1.0, 0.82, uvN.y));
    const flameStreak = sin(uvN.x.mul(38.0).sub(uProgress.mul(16.0)))
      .mul(0.28)
      .add(0.72);
    const bloodFlame = mix(
      color(0x3a0204),
      mix(color(0xd41008), color(0xff9c24), pow(radialCore, 1.8)),
      saturate(uvN.y.mul(1.15)),
    );
    bladeMat.colorNode = bloodFlame.mul(flameStreak).mul(float(1.95));
    bladeMat.opacityNode = arcTaper
      .mul(smoothstep(0.0, 0.25, uvN.y))
      .mul(pow(float(1.0).sub(uProgress), 1.35))
      .mul(0.9);
    this.ownedMaterials.push(bladeMat);

    // Smoldering ground lava arc scorch
    const scorchGeom = new THREE.RingGeometry(
      0.58,
      0.98,
      48,
      2,
      -Math.PI * 0.5 - arcSpan * 0.46,
      arcSpan * 0.92,
    );
    scorchGeom.rotateX(-Math.PI * 0.5);
    const sPos = scorchGeom.attributes.position as THREE.BufferAttribute;
    const sUv = scorchGeom.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < sPos.count; i += 1) {
      const x = sPos.getX(i);
      const z = sPos.getZ(i);
      sPos.setZ(i, -z);
      const r = Math.hypot(x, z);
      const ang = Math.atan2(z, x);
      sUv.setXY(
        i,
        Math.max(0, Math.min(1, (ang + Math.PI * 0.5 + arcSpan * 0.46) / (arcSpan * 0.92))),
        Math.max(0, Math.min(1, (r - 0.58) / 0.4)),
      );
    }
    this.ownedGeometries.push(scorchGeom);

    const scorchMat = new MeshBasicNodeMaterial({
      name: `BossBloodScorchMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const sUvN = uv();
    const sEdge = sin(saturate(sUvN.x).mul(Math.PI)).mul(
      sin(saturate(sUvN.y).mul(Math.PI)),
    );
    const emberNoise = sin(sUvN.x.mul(52.0)).mul(cos(sUvN.y.mul(18.0))).mul(0.35).add(0.65);
    scorchMat.colorNode = mix(color(0xff2e0e), color(0xffc648), sEdge.mul(emberNoise)).mul(float(2.4));
    scorchMat.opacityNode = sEdge.mul(emberNoise).mul(uScorchFade);
    this.ownedMaterials.push(scorchMat);

    const slotGroup = new THREE.Group();
    slotGroup.visible = false;

    const bladeMesh = new THREE.Mesh(bladeGeom, bladeMat);
    bladeMesh.frustumCulled = false;
    const scorchMesh = new THREE.Mesh(scorchGeom, scorchMat);
    scorchMesh.position.y = 0.05;
    scorchMesh.frustumCulled = false;
    setObjectLayerRecursive(scorchMesh, LAYER_MAIN_ONLY);

    slotGroup.add(bladeMesh, scorchMesh);
    this.group.add(slotGroup);

    return {
      group: slotGroup,
      bladeMesh,
      scorchMesh,
      uProgress,
      uScorchFade,
      active: false,
      elapsed: 0,
      bladeDuration: 0.44,
      scorchDuration: 1.35,
      maxRadius: 12.5,
    };
  }

  spawnWingBloodCrescent(
    origin: Vec3Like,
    dir: Vec3Like,
    radius = 12.0,
    tiltRad = 0.22,
  ): void {
    if (this.disposed) return;
    let slot = this.crescentPool.find((s) => !s.active);
    if (!slot) slot = this.crescentPool[0]!;

    const ox = sanitize(origin.x);
    const oz = sanitize(origin.z);
    const dx = sanitize(dir.x);
    const dz = sanitize(dir.z, 1);
    const yaw = Math.atan2(dx, dz);

    slot.active = true;
    slot.elapsed = 0;
    slot.maxRadius = Math.max(6.5, sanitize(radius, 12.0));
    slot.uProgress.value = 0;
    slot.uScorchFade.value = 1;

    slot.group.position.set(ox, 0, oz);
    slot.group.rotation.set(0, yaw, 0);

    slot.bladeMesh.position.set(0, 1.85, 0.6);
    slot.bladeMesh.rotation.set(0.14, 0, sanitize(tiltRad, 0.22));
    slot.bladeMesh.scale.setScalar(slot.maxRadius * 0.45);
    slot.bladeMesh.visible = true;

    slot.scorchMesh.scale.setScalar(slot.maxRadius * 0.92);
    slot.scorchMesh.visible = true;
    slot.group.visible = true;
  }

  // -------------------------------------------------------------------------
  // 2. Sky Meteor Hemispherical Dome + Spiderweb Magma Cracks + 3D Boulders
  // -------------------------------------------------------------------------
  private createMeteorSlot(index: number): MeteorSlamSlot {
    const uDomeProgress = uniform(0);
    const uCracksFade = uniform(0);

    const domeGeom = new THREE.SphereGeometry(
      1.0,
      32,
      16,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.5,
    );
    this.ownedGeometries.push(domeGeom);

    const domeMat = new MeshBasicNodeMaterial({
      name: `BossMeteorDomeMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const fresnel = pow(
      float(1.0).sub(saturate(abs(dot(normalView, positionViewDirection)))),
      1.75,
    );
    const baseRim = smoothstep(0.35, 0.0, uv().y);
    const plasmaBand = sin(uv().y.mul(22.0).sub(uDomeProgress.mul(14.0)))
      .mul(0.25)
      .add(0.75);
    const domeMask = saturate(fresnel.mul(0.95).add(baseRim.mul(0.55))).mul(plasmaBand);
    domeMat.colorNode = mix(color(0x9e0804), color(0xff841c), pow(fresnel, 1.5)).mul(float(1.55));
    domeMat.opacityNode = domeMask
      .mul(pow(float(1.0).sub(uDomeProgress), 1.45))
      .mul(0.72);
    this.ownedMaterials.push(domeMat);

    // Spiderweb radial + concentric magma ground cracks decal
    const cracksGeom = new THREE.CircleGeometry(1.0, 48);
    cracksGeom.rotateX(-Math.PI * 0.5);
    this.ownedGeometries.push(cracksGeom);

    const cracksMat = new MeshBasicNodeMaterial({
      name: `BossMagmaCracksMat_${index}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const p2 = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const rad = length(p2);
    const ang = atan(p2.y, p2.x);
    // Jagged radial lightning-like fissures + concentric fracture rings
    const spokeWave = abs(
      sin(ang.mul(9.0).add(sin(rad.mul(14.0)).mul(0.55))),
    );
    const spokeCrack = smoothstep(0.91, 0.995, spokeWave);
    const subSpoke = smoothstep(
      0.94,
      0.998,
      abs(sin(ang.mul(17.0).sub(cos(rad.mul(19.0)).mul(0.45)))),
    );
    const ringCrack = smoothstep(
      0.88,
      0.985,
      abs(sin(rad.mul(13.5).add(sin(ang.mul(6.0)).mul(0.35)))),
    );
    const centerCrater = smoothstep(0.24, 0.03, rad).mul(0.75);
    const outerFade = smoothstep(1.0, 0.72, rad);
    const totalFissure = saturate(
      spokeCrack.add(subSpoke.mul(0.7)).add(ringCrack.mul(0.55)).add(centerCrater),
    ).mul(outerFade);

    cracksMat.colorNode = mix(color(0xb80e04), color(0xffaa28), pow(totalFissure, 1.6)).mul(float(1.75));
    cracksMat.opacityNode = totalFissure.mul(uCracksFade).mul(0.88);
    this.ownedMaterials.push(cracksMat);

    // 12 Jagged 3D Rock Boulders with glowing magma veins
    const boulderGeom = new THREE.DodecahedronGeometry(0.38, 0);
    this.ownedGeometries.push(boulderGeom);
    const boulderMat = new MeshStandardNodeMaterial({
      name: `BossMeteorBoulderMat_${index}`,
      color: 0x26201e,
      roughness: 0.78,
      metalness: 0.15,
    });
    const bFres = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.2,
    );
    boulderMat.emissiveNode = color(0xff5214).mul(bFres.mul(1.8).add(0.22)).mul(uCracksFade);
    this.ownedMaterials.push(boulderMat);

    const slotGroup = new THREE.Group();
    slotGroup.visible = false;

    const domeMesh = new THREE.Mesh(domeGeom, domeMat);
    domeMesh.frustumCulled = false;
    const cracksMesh = new THREE.Mesh(cracksGeom, cracksMat);
    cracksMesh.position.y = 0.055;
    cracksMesh.frustumCulled = false;
    setObjectLayerRecursive(cracksMesh, LAYER_MAIN_ONLY);
    slotGroup.add(domeMesh, cracksMesh);

    const boulders: MeteorSlamSlot['boulders'] = [];
    for (let b = 0; b < 12; b += 1) {
      const bm = new THREE.Mesh(boulderGeom, boulderMat);
      bm.scale.set(0.8 + (b % 3) * 0.45, 0.65 + (b % 2) * 0.35, 0.9 + (b % 4) * 0.25);
      bm.frustumCulled = false;
      slotGroup.add(bm);
      boulders.push({ mesh: bm, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0 });
    }

    this.group.add(slotGroup);

    return {
      group: slotGroup,
      domeMesh,
      cracksMesh,
      boulders,
      uDomeProgress,
      uCracksFade,
      active: false,
      elapsed: 0,
      domeDuration: 0.56,
      cracksDuration: 1.75,
      targetRadius: 10.5,
    };
  }

  spawnMeteorCataclysmSlam(center: Vec3Like, radius = 9.5): void {
    if (this.disposed) return;
    let slot = this.meteorPool.find((s) => !s.active);
    if (!slot) slot = this.meteorPool[0]!;

    const cx = sanitize(center.x);
    const cz = sanitize(center.z);
    const r = Math.max(5.5, sanitize(radius, 9.5));

    slot.active = true;
    slot.elapsed = 0;
    slot.targetRadius = r * 1.18;
    slot.uDomeProgress.value = 0;
    slot.uCracksFade.value = 1;

    slot.group.position.set(cx, 0, cz);
    slot.domeMesh.scale.setScalar(1.2);
    slot.domeMesh.visible = true;
    slot.cracksMesh.scale.setScalar(r * 1.25);
    slot.cracksMesh.visible = true;

    for (let i = 0; i < slot.boulders.length; i += 1) {
      const b = slot.boulders[i]!;
      const ang = (i / slot.boulders.length) * Math.PI * 2 + (i % 2) * 0.24;
      const spd = 7.5 + (i % 4) * 2.6;
      b.mesh.position.set(Math.cos(ang) * 1.1, 0.35, Math.sin(ang) * 1.1);
      b.mesh.visible = true;
      b.vx = Math.cos(ang) * spd;
      b.vy = 6.8 + (i % 3) * 2.8;
      b.vz = Math.sin(ang) * spd;
      b.rx = 4.5 + (i % 3) * 2.2;
      b.ry = 5.2 - (i % 4) * 1.8;
    }

    slot.group.visible = true;
  }

  // -------------------------------------------------------------------------
  // 3. 22m Chest Core Singularity Charge + Helical Annihilation Laser Cannon
  // -------------------------------------------------------------------------
  private createLaserState(): LaserBeamState {
    const uCharge = uniform(0);
    const uBeamProgress = uniform(0);
    const uTrenchFade = uniform(0);
    const uTime = uniform(0);

    // A) Singularity Charge Orb + Imploding Halo Ring
    const chargeGroup = new THREE.Group();
    chargeGroup.visible = false;

    const orbGeom = new THREE.SphereGeometry(0.95, 20, 16);
    const ringGeom = new THREE.TorusGeometry(1.55, 0.08, 10, 32);
    this.ownedGeometries.push(orbGeom, ringGeom);

    const orbMat = new MeshBasicNodeMaterial({
      name: 'BossChestSingularityMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const orbFres = pow(
      float(1.0).sub(saturate(abs(dot(normalView, positionViewDirection)))),
      1.6,
    );
    orbMat.colorNode = mix(color(0xfff0aa), color(0xff1e0a), orbFres).mul(float(3.6));
    orbMat.opacityNode = uCharge.mul(0.92);
    this.ownedMaterials.push(orbMat);

    const orbMesh = new THREE.Mesh(orbGeom, orbMat);
    const chargeRingA = new THREE.Mesh(ringGeom, orbMat);
    const chargeRingB = new THREE.Mesh(ringGeom, orbMat);
    chargeRingB.rotation.x = Math.PI * 0.42;
    chargeGroup.add(orbMesh, chargeRingA, chargeRingB);
    this.group.add(chargeGroup);

    // B) 22m Cylindrical Laser Cannon (oriented along local +Z from 0 -> 22m!)
    const beamGroup = new THREE.Group();
    beamGroup.visible = false;

    const beamLen = 21.0;
    const coreGeom = new THREE.CylinderGeometry(0.26, 0.34, beamLen, 20, 1, true);
    coreGeom.rotateX(Math.PI * 0.5);
    coreGeom.translate(0, 0, beamLen * 0.5);

    const sheathGeom = new THREE.CylinderGeometry(0.68, 0.86, beamLen, 24, 1, true);
    sheathGeom.rotateX(Math.PI * 0.5);
    sheathGeom.translate(0, 0, beamLen * 0.5);

    const muzzleGeom = new THREE.SphereGeometry(1.05, 18, 14);
    const spiralTorusGeom = new THREE.TorusGeometry(1.18, 0.065, 10, 28);
    this.ownedGeometries.push(coreGeom, sheathGeom, muzzleGeom, spiralTorusGeom);

    const beamFade = pow(float(1.0).sub(uBeamProgress), 1.25);

    const coreMat = new MeshBasicNodeMaterial({
      name: 'BossLaserInnerCoreMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const coreTipFade = smoothstep(1.0, 0.85, uv().y);
    coreMat.colorNode = color(0xffaa32).mul(float(1.85));
    coreMat.opacityNode = beamFade.mul(coreTipFade).mul(0.88);
    this.ownedMaterials.push(coreMat);

    const sheathMat = new MeshBasicNodeMaterial({
      name: 'BossLaserPlasmaSheathMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const shUv = uv();
    const shTipFade = smoothstep(1.0, 0.82, shUv.y);
    const plasmaScroll = sin(shUv.y.mul(36.0).sub(uTime.mul(42.0)).add(shUv.x.mul(12.566)))
      .mul(0.32)
      .add(0.68);
    sheathMat.colorNode = mix(color(0x8f0404), color(0xff3810), plasmaScroll).mul(float(1.65));
    sheathMat.opacityNode = plasmaScroll.mul(beamFade).mul(shTipFade).mul(0.75);
    this.ownedMaterials.push(sheathMat);

    const coreMesh = new THREE.Mesh(coreGeom, coreMat);
    const sheathMesh = new THREE.Mesh(sheathGeom, sheathMat);
    const muzzleMesh = new THREE.Mesh(muzzleGeom, sheathMat);
    coreMesh.frustumCulled = false;
    sheathMesh.frustumCulled = false;
    muzzleMesh.frustumCulled = false;
    beamGroup.add(coreMesh, sheathMesh, muzzleMesh);

    const spiralRings: THREE.Mesh[] = [];
    for (let r = 0; r < 5; r += 1) {
      const rm = new THREE.Mesh(spiralTorusGeom, coreMat);
      rm.position.z = 2.5 + r * 4.2;
      rm.rotation.set(0.28 * (r % 2 === 0 ? 1 : -1), 0.22, 0);
      rm.frustumCulled = false;
      beamGroup.add(rm);
      spiralRings.push(rm);
    }
    this.group.add(beamGroup);

    // C) 22m Scorched Ground Molten Lava Trench
    const trenchGeom = new THREE.PlaneGeometry(2.6, beamLen);
    trenchGeom.rotateX(-Math.PI * 0.5);
    trenchGeom.translate(0, 0.055, beamLen * 0.5);
    this.ownedGeometries.push(trenchGeom);

    const trenchMat = new MeshBasicNodeMaterial({
      name: 'BossLaserLavaTrenchMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const trUv = uv();
    const trWidth = smoothstep(0.5, 0.08, abs(trUv.x.sub(0.5)));
    const trLen = smoothstep(0.0, 0.08, trUv.y).mul(smoothstep(1.0, 0.88, trUv.y));
    const trCrack = sin(trUv.y.mul(64.0)).mul(0.25).add(0.75);
    trenchMat.colorNode = mix(color(0xff2408), color(0xffe07a), trWidth).mul(trCrack).mul(float(2.8));
    trenchMat.opacityNode = trWidth.mul(trLen).mul(uTrenchFade);
    this.ownedMaterials.push(trenchMat);

    const trenchMesh = new THREE.Mesh(trenchGeom, trenchMat);
    trenchMesh.visible = false;
    trenchMesh.frustumCulled = false;
    setObjectLayerRecursive(trenchMesh, LAYER_MAIN_ONLY);
    this.group.add(trenchMesh);

    return {
      chargeGroup,
      beamGroup,
      trenchMesh,
      spiralRings,
      uCharge,
      uBeamProgress,
      uTrenchFade,
      uTime,
      firing: false,
      trenchActive: false,
      elapsed: 0,
      beamDuration: 0.52,
      trenchDuration: 1.65,
    };
  }

  updateChestBeamCharge(chestPos: Vec3Like, progress: number, active: boolean): void {
    if (this.disposed) return;
    if (!active || progress <= 0.01) {
      this.laser.chargeGroup.visible = false;
      this.laser.uCharge.value = 0;
      return;
    }
    const p = Math.max(0, Math.min(1, sanitize(progress)));
    this.laser.chargeGroup.position.set(
      sanitize(chestPos.x),
      sanitize(chestPos.y, 3.2),
      sanitize(chestPos.z),
    );
    const pulse = 0.45 + p * 0.95 + Math.sin(this.globalTime * 28.0) * 0.12;
    this.laser.chargeGroup.scale.setScalar(pulse);
    this.laser.chargeGroup.rotation.z = this.globalTime * 5.5;
    this.laser.chargeGroup.rotation.y = this.globalTime * 3.8;
    this.laser.uCharge.value = p;
    this.laser.chargeGroup.visible = true;
  }

  fireChestAnnihilationBeam(chestPos: Vec3Like, dir: Vec3Like): void {
    if (this.disposed) return;
    this.laser.chargeGroup.visible = false;
    this.laser.uCharge.value = 0;

    const cx = sanitize(chestPos.x);
    const cy = sanitize(chestPos.y, 3.1);
    const cz = sanitize(chestPos.z);
    const dx = sanitize(dir.x);
    const dz = sanitize(dir.z, 1);
    const yaw = Math.atan2(dx, dz);

    // Pitch slightly downward (-0.11 rad) so the 22m chest beam rakes through player chest height and scorches the courtyard!
    this.laser.beamGroup.position.set(cx, cy, cz);
    this.laser.beamGroup.rotation.set(0.11, yaw, 0, 'YXZ');
    this.laser.beamGroup.scale.set(1, 1, 1);
    this.laser.beamGroup.visible = true;

    this.laser.trenchMesh.position.set(cx, 0, cz);
    this.laser.trenchMesh.rotation.set(0, yaw, 0);
    this.laser.trenchMesh.visible = true;

    this.laser.firing = true;
    this.laser.trenchActive = true;
    this.laser.elapsed = 0;
    this.laser.uBeamProgress.value = 0;
    this.laser.uTrenchFade.value = 1;
  }

  // -------------------------------------------------------------------------
  // 4. 5-Constellation Corrupted Sanskrit Sigils + 22m Heavenfall Pillars
  // -------------------------------------------------------------------------
  private createPillarSlot(index: number): VajraPillarSlot {
    const uProgress = uniform(0);
    const uTime = uniform(0);

    const colGeom = new THREE.CylinderGeometry(0.82, 1.45, 22, 20, 1, true);
    colGeom.translate(0, 11.0, 0);
    const sigilGeom = new THREE.CircleGeometry(2.3, 36);
    sigilGeom.rotateX(-Math.PI * 0.5);
    sigilGeom.translate(0, 0.06, 0);
    this.ownedGeometries.push(colGeom, sigilGeom);

    const colMat = new MeshBasicNodeMaterial({
      name: `BossHeavenfallPillarMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cUv = uv();
    const vFade = smoothstep(0.0, 0.08, cUv.y).mul(smoothstep(1.0, 0.25, cUv.y));
    const spiralLightning = pow(
      abs(sin(cUv.x.mul(18.8495).add(cUv.y.mul(14.0)).sub(uTime.mul(22.0)))),
      3.0,
    );
    const pillarFade = pow(float(1.0).sub(uProgress), 1.3);
    colMat.colorNode = mix(
      color(0x8c0406),
      color(0xff7e1a),
      spiralLightning.mul(0.85).add(0.1),
    ).mul(float(1.65));
    colMat.opacityNode = vFade
      .mul(spiralLightning.mul(0.62).add(0.28))
      .mul(pillarFade)
      .mul(0.78);
    this.ownedMaterials.push(colMat);

    const sigilMat = new MeshBasicNodeMaterial({
      name: `BossSanskritSigilMat_${index}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const sp = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const sr = length(sp);
    const sa = atan(sp.y, sp.x).add(uTime.mul(2.4));
    const outerRing = smoothstep(0.05, 0.0, abs(sr.sub(0.88)));
    const innerRing = smoothstep(0.05, 0.0, abs(sr.sub(0.56)));
    const runeGlyphs = smoothstep(0.65, 0.95, abs(sin(sa.mul(8.0)))).mul(
      smoothstep(0.14, 0.0, abs(sr.sub(0.72))),
    );
    const starSpokes = smoothstep(0.92, 0.99, abs(sin(sa.mul(4.0)))).mul(
      smoothstep(0.88, 0.2, sr),
    );
    const sigilMask = saturate(
      outerRing.add(innerRing).add(runeGlyphs).add(starSpokes.mul(0.7)),
    );
    sigilMat.colorNode = mix(color(0xb81006), color(0xffa428), sigilMask).mul(float(1.85));
    sigilMat.opacityNode = sigilMask.mul(pillarFade).mul(0.88);
    this.ownedMaterials.push(sigilMat);

    const slotGroup = new THREE.Group();
    slotGroup.visible = false;

    const columns: THREE.Group[] = [];
    for (let c = 0; c < 5; c += 1) {
      const cg = new THREE.Group();
      const cm = new THREE.Mesh(colGeom, colMat);
      const sm = new THREE.Mesh(sigilGeom, sigilMat);
      cm.frustumCulled = false;
      sm.frustumCulled = false;
      setObjectLayerRecursive(sm, LAYER_MAIN_ONLY);
      cg.add(cm, sm);
      slotGroup.add(cg);
      columns.push(cg);
    }
    this.group.add(slotGroup);

    return {
      group: slotGroup,
      columns,
      uProgress,
      uTime,
      active: false,
      elapsed: 0,
      duration: 0.78,
    };
  }

  spawnHeavenfallVajraPillars(center: Vec3Like, spreadRadius = 5.4): void {
    if (this.disposed) return;
    let slot = this.pillarPool.find((s) => !s.active);
    if (!slot) slot = this.pillarPool[0]!;

    const cx = sanitize(center.x);
    const cz = sanitize(center.z);
    const sr = Math.max(3.2, sanitize(spreadRadius, 5.4));

    slot.active = true;
    slot.elapsed = 0;
    slot.uProgress.value = 0;
    slot.group.position.set(cx, 0, cz);

    // Column 0 at center; Columns 1..4 in surrounding sacred constellation!
    slot.columns[0]!.position.set(0, 0, 0);
    slot.columns[0]!.scale.set(1.25, 1.0, 1.25);
    for (let i = 1; i < 5; i += 1) {
      const ang = ((i - 1) / 4) * Math.PI * 2 + 0.38;
      slot.columns[i]!.position.set(Math.cos(ang) * sr, 0, Math.sin(ang) * sr);
      slot.columns[i]!.scale.set(0.88, 1.0, 0.88);
    }

    slot.group.visible = true;
  }

  // -------------------------------------------------------------------------
  // 5. Traveling 8m 3D X-Cross Blood-Moon Wave + Wing-Feather Dagger Storm
  // -------------------------------------------------------------------------
  private createCrossStormSlot(index: number): CrossStormSlot {
    const uProgress = uniform(0);

    // Curved 8.5m crescent blade plane for each arm of the giant X-Cross wave
    const armGeom = new THREE.PlaneGeometry(8.8, 1.85, 24, 4);
    const aPos = armGeom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < aPos.count; i += 1) {
      const x = aPos.getX(i);
      const normX = x / 4.4; // -1..+1
      // Curve forward at center (+Z) into a menacing sweeping crescent!
      aPos.setZ(i, (1 - normX * normX) * 1.65);
    }
    armGeom.computeVertexNormals();
    this.ownedGeometries.push(armGeom);

    const waveMat = new MeshBasicNodeMaterial({
      name: `BossCrossWaveMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const wUv = uv();
    const lenMask = sin(saturate(wUv.x).mul(Math.PI));
    const coreSpine = pow(
      float(1.0).sub(saturate(abs(wUv.y.sub(0.5)).mul(2.0))),
      2.6,
    );
    const rip = sin(wUv.x.mul(28.0).sub(uProgress.mul(18.0))).mul(0.22).add(0.78);
    const fade = smoothstep(1.0, 0.65, uProgress);
    waveMat.colorNode = mix(color(0x980406), color(0xff8e20), pow(coreSpine, 1.5))
      .mul(rip)
      .mul(float(1.85));
    waveMat.opacityNode = lenMask.mul(coreSpine).mul(fade).mul(0.85);
    this.ownedMaterials.push(waveMat);

    // Razor Wing-Feather Dagger geometry (elongated diamond spear)
    const featherGeom = new THREE.ConeGeometry(0.15, 2.2, 4);
    featherGeom.rotateX(Math.PI * 0.5);
    this.ownedGeometries.push(featherGeom);

    const featherMat = new MeshBasicNodeMaterial({
      name: `BossFeatherDaggerMat_${index}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    featherMat.colorNode = mix(color(0xb80808), color(0xff9c24), uv().y).mul(float(1.95));
    featherMat.opacityNode = fade.mul(0.9);
    this.ownedMaterials.push(featherMat);

    const slotGroup = new THREE.Group();
    slotGroup.visible = false;

    const waveGroup = new THREE.Group();
    const armA = new THREE.Mesh(armGeom, waveMat);
    armA.rotation.z = Math.PI * 0.23;
    const armB = new THREE.Mesh(armGeom, waveMat);
    armB.rotation.z = -Math.PI * 0.23;
    armA.frustumCulled = false;
    armB.frustumCulled = false;
    waveGroup.position.y = 2.6;
    waveGroup.add(armA, armB);
    slotGroup.add(waveGroup);

    const feathers: CrossStormSlot['feathers'] = [];
    for (let f = 0; f < 10; f += 1) {
      const fm = new THREE.Mesh(featherGeom, featherMat);
      fm.frustumCulled = false;
      slotGroup.add(fm);
      feathers.push({ mesh: fm, vx: 0, vy: 0, vz: 0, delay: (f % 5) * 0.025 });
    }

    this.group.add(slotGroup);

    return {
      group: slotGroup,
      waveGroup,
      feathers,
      uProgress,
      active: false,
      elapsed: 0,
      duration: 0.72,
      dirX: 0,
      dirZ: 1,
      speed: 24.0,
    };
  }

  spawnCrossBladeStorm(origin: Vec3Like, dir: Vec3Like): void {
    if (this.disposed) return;
    let slot = this.crossPool.find((s) => !s.active);
    if (!slot) slot = this.crossPool[0]!;

    const ox = sanitize(origin.x);
    const oz = sanitize(origin.z);
    const dx = sanitize(dir.x);
    const dz = sanitize(dir.z, 1);
    const len = Math.hypot(dx, dz);
    const nx = len > 1e-4 ? dx / len : 0;
    const nz = len > 1e-4 ? dz / len : 1;
    const yaw = Math.atan2(nx, nz);

    slot.active = true;
    slot.elapsed = 0;
    slot.dirX = nx;
    slot.dirZ = nz;
    slot.uProgress.value = 0;

    slot.group.position.set(ox, 0, oz);
    slot.waveGroup.position.set(nx * 1.4, 2.65, nz * 1.4);
    slot.waveGroup.rotation.set(0, yaw, 0);
    slot.waveGroup.scale.setScalar(1.0);

    const rightX = nz;
    const rightZ = -nx;
    for (let i = 0; i < slot.feathers.length; i += 1) {
      const f = slot.feathers[i]!;
      const side = (i - 4.5) * 0.92;
      const height = 2.2 + Math.abs(i - 4.5) * 0.35;
      f.mesh.position.set(rightX * side, height, rightZ * side);
      const fanYaw = yaw + (i - 4.5) * 0.045;
      f.vx = Math.sin(fanYaw) * 28.0;
      f.vy = -1.6;
      f.vz = Math.cos(fanYaw) * 28.0;
      f.mesh.rotation.set(0.06, fanYaw, 0, 'YXZ');
      f.mesh.visible = true;
    }

    slot.group.visible = true;
  }

  // -------------------------------------------------------------------------
  // Per-Frame Simulation Update, Reset & Clean Disposal
  // -------------------------------------------------------------------------
  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, 0.1);
    this.globalTime += step;
    this.laser.uTime.value = this.globalTime;

    // 1. Crescent Waves
    for (const slot of this.crescentPool) {
      if (!slot.active) continue;
      slot.elapsed += step;
      if (slot.elapsed < slot.bladeDuration) {
        const p = slot.elapsed / slot.bladeDuration;
        slot.uProgress.value = p;
        const expand = slot.maxRadius * (0.48 + 0.62 * (1 - Math.pow(1 - p, 2.6)));
        slot.bladeMesh.scale.setScalar(expand);
      } else {
        slot.bladeMesh.visible = false;
      }

      if (slot.elapsed < slot.scorchDuration) {
        const sp = slot.elapsed / slot.scorchDuration;
        slot.uScorchFade.value = Math.max(0, 1 - sp * sp);
      } else {
        slot.active = false;
        slot.group.visible = false;
      }
    }

    // 2. Meteor Cataclysm Domes, Magma Cracks & Boulders
    for (const slot of this.meteorPool) {
      if (!slot.active) continue;
      slot.elapsed += step;

      if (slot.elapsed < slot.domeDuration) {
        const p = slot.elapsed / slot.domeDuration;
        slot.uDomeProgress.value = p;
        const r = 1.2 + (slot.targetRadius - 1.2) * (1 - Math.pow(1 - p, 2.8));
        slot.domeMesh.scale.set(r, r * 0.78, r);
      } else {
        slot.domeMesh.visible = false;
      }

      for (const b of slot.boulders) {
        if (!b.mesh.visible) continue;
        b.vy -= 18.5 * step;
        b.mesh.position.x += b.vx * step;
        b.mesh.position.y += b.vy * step;
        b.mesh.position.z += b.vz * step;
        b.mesh.rotation.x += b.rx * step;
        b.mesh.rotation.y += b.ry * step;
        if (b.mesh.position.y < 0.22) {
          b.mesh.position.y = 0.22;
          b.vy = Math.abs(b.vy) * 0.32;
          b.vx *= 0.72;
          b.vz *= 0.72;
        }
      }

      if (slot.elapsed < slot.cracksDuration) {
        const cp = slot.elapsed / slot.cracksDuration;
        slot.uCracksFade.value = Math.max(0, 1 - Math.pow(cp, 1.6));
      } else {
        slot.active = false;
        slot.group.visible = false;
      }
    }

    // 3. Chest Annihilation Laser Beam & Molten Trench
    if (this.laser.firing || this.laser.trenchActive) {
      this.laser.elapsed += step;
      if (this.laser.firing) {
        if (this.laser.elapsed < this.laser.beamDuration) {
          const bp = this.laser.elapsed / this.laser.beamDuration;
          this.laser.uBeamProgress.value = bp;
          const girth = 1.0 + Math.sin(bp * Math.PI) * 0.35;
          this.laser.beamGroup.scale.set(girth, girth, 1.0);
          for (let i = 0; i < this.laser.spiralRings.length; i += 1) {
            const rm = this.laser.spiralRings[i]!;
            rm.position.z = ((2.2 + i * 4.2 + this.laser.elapsed * 34.0) % 21.0) + 0.8;
            rm.rotation.z += step * 14.0 * (i % 2 === 0 ? 1 : -1);
          }
        } else {
          this.laser.firing = false;
          this.laser.beamGroup.visible = false;
        }
      }
      if (this.laser.trenchActive) {
        if (this.laser.elapsed < this.laser.trenchDuration) {
          const tp = this.laser.elapsed / this.laser.trenchDuration;
          this.laser.uTrenchFade.value = Math.max(0, 1 - tp * tp);
        } else {
          this.laser.trenchActive = false;
          this.laser.trenchMesh.visible = false;
        }
      }
    }

    // 4. Heavenfall Vajra Pillars
    for (const slot of this.pillarPool) {
      if (!slot.active) continue;
      slot.elapsed += step;
      slot.uTime.value = this.globalTime;
      if (slot.elapsed < slot.duration) {
        const p = slot.elapsed / slot.duration;
        slot.uProgress.value = p;
        const swell = 0.65 + 0.55 * Math.sin(Math.min(1, p * 1.4) * Math.PI * 0.5);
        for (let i = 0; i < slot.columns.length; i += 1) {
          const base = i === 0 ? 1.25 : 0.88;
          slot.columns[i]!.scale.set(base * swell, 1.0, base * swell);
        }
      } else {
        slot.active = false;
        slot.group.visible = false;
      }
    }

    // 5. Traveling X-Cross Wave & Wing-Feather Daggers
    for (const slot of this.crossPool) {
      if (!slot.active) continue;
      slot.elapsed += step;
      if (slot.elapsed < slot.duration) {
        const p = slot.elapsed / slot.duration;
        slot.uProgress.value = p;
        slot.waveGroup.position.x += slot.dirX * slot.speed * step;
        slot.waveGroup.position.z += slot.dirZ * slot.speed * step;
        slot.waveGroup.scale.setScalar(1.0 + p * 0.45);
        for (const f of slot.feathers) {
          if (slot.elapsed >= f.delay) {
            f.mesh.position.x += f.vx * step;
            f.mesh.position.y = Math.max(0.25, f.mesh.position.y + f.vy * step);
            f.mesh.position.z += f.vz * step;
          }
        }
      } else {
        slot.active = false;
        slot.group.visible = false;
      }
    }
  }

  reset(): void {
    if (this.disposed) return;
    for (const s of this.crescentPool) {
      s.active = false;
      s.group.visible = false;
    }
    for (const s of this.meteorPool) {
      s.active = false;
      s.group.visible = false;
    }
    this.laser.chargeGroup.visible = false;
    this.laser.beamGroup.visible = false;
    this.laser.trenchMesh.visible = false;
    this.laser.firing = false;
    this.laser.trenchActive = false;
    for (const s of this.pillarPool) {
      s.active = false;
      s.group.visible = false;
    }
    for (const s of this.crossPool) {
      s.active = false;
      s.group.visible = false;
    }
  }

  setPrewarmVisible(enabled: boolean): void {
    if (this.disposed) return;
    if (enabled) {
      this.group.scale.setScalar(0.001);
      if (this.crescentPool[0]) this.crescentPool[0].group.visible = true;
      if (this.meteorPool[0]) this.meteorPool[0].group.visible = true;
      this.laser.chargeGroup.visible = true;
      this.laser.beamGroup.visible = true;
      this.laser.trenchMesh.visible = true;
      if (this.pillarPool[0]) this.pillarPool[0].group.visible = true;
      if (this.crossPool[0]) this.crossPool[0].group.visible = true;
    } else {
      this.group.scale.setScalar(1);
      this.reset();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.ownedGeometries) {
      g.dispose();
    }
    for (const m of this.ownedMaterials) {
      m.dispose();
    }
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.group.clear();
  }
}
