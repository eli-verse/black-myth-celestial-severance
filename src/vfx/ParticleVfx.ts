import * as THREE from 'three';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import {
  abs,
  clamp,
  float,
  instancedDynamicBufferAttribute,
  length,
  mix,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import type { Vec3Like } from '../types/game.ts';

const MAX_PARTICLES = 512;
const AMBIENT_COUNT = 120;
const BURST_START = AMBIENT_COUNT;
const SHOCKWAVE_POOL_SIZE = 8;
const REALITY_SEAM_COUNT = 6;
const MAX_VFX_COORD = 1e6;
interface HitFlashStarSlot {
  readonly group: THREE.Group;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uColor: ColorUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  maxScale: number;
  spawnOrder: number;
}

const HIT_STAR_POOL_SIZE = 6;

function sanitizeCoord(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-MAX_VFX_COORD, Math.min(MAX_VFX_COORD, value));
}

const makeFloatUniform = (v: number) => uniform(v);
const makeColorUniform = (v: THREE.Color) => uniform(v);
type FloatUniform = ReturnType<typeof makeFloatUniform>;
type ColorUniform = ReturnType<typeof makeColorUniform>;

interface ParticleSimState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
  life: number;
  maxLife: number;
  startScaleX: number;
  startScaleY: number;
  endScaleX: number;
  endScaleY: number;
  rotation: number;
  rotSpeed: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  // Ambient-only orbital motion parameters
  ambientRadius: number;
  ambientAngle: number;
  ambientAngularSpeed: number;
  ambientBaseY: number;
  ambientPhase: number;
  isWisp: boolean;
}

interface ShockwaveSlot {
  readonly mesh: THREE.Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uColor: ColorUniform;
  readonly uOpacity: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  delay: number;
  startScale: number;
  endScale: number;
  spawnOrder: number;
}

function createInitialSimState(): ParticleSimState {
  return {
    active: false,
    x: 0,
    y: -100,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    drag: 0,
    life: 0,
    maxLife: 1,
    startScaleX: 0,
    startScaleY: 0,
    endScaleX: 0,
    endScaleY: 0,
    rotation: 0,
    rotSpeed: 0,
    r: 1,
    g: 1,
    b: 1,
    alpha: 0,
    ambientRadius: 10,
    ambientAngle: 0,
    ambientAngularSpeed: 0.1,
    ambientBaseY: 1,
    ambientPhase: 0,
    isWisp: false,
  };
}

// Deterministic pseudo-random helper seeded per slot/spawn to stay smooth & predictable
function hash01(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export class ParticleVfx {
  readonly group = new THREE.Group();

  private readonly posArray = new Float32Array(MAX_PARTICLES * 3);
  private readonly scaleArray = new Float32Array(MAX_PARTICLES * 2);
  private readonly rotArray = new Float32Array(MAX_PARTICLES);
  private readonly colorArray = new Float32Array(MAX_PARTICLES * 3);
  private readonly alphaArray = new Float32Array(MAX_PARTICLES);

  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly scaleAttr: THREE.InstancedBufferAttribute;
  private readonly rotAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;

  private readonly spriteMat: SpriteNodeMaterial;
  private readonly sprite: THREE.Sprite;
  private readonly particles: ParticleSimState[] = [];

  private readonly shockwaveGeometry: THREE.PlaneGeometry;
  private readonly shockwaves: ShockwaveSlot[] = [];
  private readonly hitStarBeamGeom: THREE.PlaneGeometry;
  private readonly hitStarCoreGeom: THREE.SphereGeometry;
  private readonly hitStars: HitFlashStarSlot[] = [];

  private readonly postureBeamGeometry: THREE.CylinderGeometry;
  private readonly postureBeamMat: MeshBasicNodeMaterial;
  private readonly postureBeamMesh: THREE.Mesh;
  private readonly uBeamProgress: FloatUniform;
  private postureBeamElapsed = 0;
  private postureBeamDuration = 0.55;
  private postureBeamActive = false;

  private readonly domainGroup = new THREE.Group();
  private readonly domeGeometry: THREE.SphereGeometry;
  private readonly domeMaterial: MeshBasicNodeMaterial;
  private readonly domeMesh: THREE.Mesh;
  private readonly seamGeometry: THREE.PlaneGeometry;
  private readonly seamMaterial: MeshBasicNodeMaterial;
  private readonly seamMeshes: THREE.Mesh[] = [];
  private readonly uDomainTime: FloatUniform;
  private readonly lastTargetPos = new THREE.Vector3(0, 1.2, 0);
  private skill3DomainActive = false;

  private phaseIntensity = 0;
  private elapsedSeconds = 0;
  private burstCursor = BURST_START;
  private spawnCounter = 0;
  private disposed = false;

  constructor() {
    this.group.name = 'ParticleVfxGroup';

    this.posAttr = new THREE.InstancedBufferAttribute(this.posArray, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.InstancedBufferAttribute(this.scaleArray, 2);
    this.scaleAttr.setUsage(THREE.DynamicDrawUsage);
    this.rotAttr = new THREE.InstancedBufferAttribute(this.rotArray, 1);
    this.rotAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArray, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArray, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);

    const aPos = instancedDynamicBufferAttribute(
      this.posAttr,
      'vec3',
    ) as unknown as ReturnType<typeof vec3>;
    const aScale = instancedDynamicBufferAttribute(
      this.scaleAttr,
      'vec2',
    ) as unknown as ReturnType<typeof vec2>;
    const aRot = instancedDynamicBufferAttribute(
      this.rotAttr,
      'float',
    ) as unknown as ReturnType<typeof float>;
    const aColor = instancedDynamicBufferAttribute(
      this.colorAttr,
      'vec3',
    ) as unknown as ReturnType<typeof vec3>;
    const aAlpha = instancedDynamicBufferAttribute(
      this.alphaAttr,
      'float',
    ) as unknown as ReturnType<typeof float>;

    const p = uv().sub(0.5).mul(2.0);
    const dist = length(p);
    const radialMask = pow(clamp(float(1.0).sub(dist), 0.0, 1.0), 1.85);

    this.spriteMat = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.spriteMat.positionNode = aPos;
    this.spriteMat.scaleNode = aScale;
    this.spriteMat.rotationNode = aRot;
    this.spriteMat.colorNode = aColor;
    this.spriteMat.opacityNode = radialMask.mul(aAlpha);

    this.sprite = new THREE.Sprite(this.spriteMat);
    this.sprite.name = 'GpuInstancedParticles';
    this.sprite.count = MAX_PARTICLES;
    this.sprite.frustumCulled = false;
    setObjectLayerRecursive(this.sprite, LAYER_MAIN_ONLY);
    this.group.add(this.sprite);

    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      this.particles.push(createInitialSimState());
    }
    this.initAmbientParticles();

    // Shockwave pool (8)
    this.shockwaveGeometry = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < SHOCKWAVE_POOL_SIZE; i += 1) {
      this.shockwaves.push(this.createShockwaveSlot(i));
    }

    // 3D On-Hit Starburst & Tight Fiery Heart Pool (6) — razor-sharp explosive contact flares!
    this.hitStarBeamGeom = new THREE.PlaneGeometry(3.2, 0.36);
    this.hitStarCoreGeom = new THREE.SphereGeometry(0.15, 12, 8);
    for (let i = 0; i < HIT_STAR_POOL_SIZE; i += 1) {
      this.hitStars.push(this.createHitStarSlot(i));
    }

    // Posture Break vertical light column (pre-allocated)
    this.uBeamProgress = uniform(0);
    const beamUv = uv();
    const beamFadeY = smoothstep(1.0, 0.15, beamUv.y).mul(
      smoothstep(0.0, 0.05, beamUv.y),
    );
    const beamCore = smoothstep(1.0, 0.0, this.uBeamProgress);
    this.postureBeamMat = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.postureBeamMat.colorNode = mix(
      uniform(new THREE.Color(0x46e8d4)),
      uniform(new THREE.Color(0xffe178)),
      smoothstep(0.0, 0.6, beamUv.y),
    ).mul(float(2.4));
    this.postureBeamMat.opacityNode = beamFadeY.mul(beamCore).mul(0.85);

    this.postureBeamGeometry = new THREE.CylinderGeometry(0.45, 1.05, 16, 20, 1, true);
    this.postureBeamMesh = new THREE.Mesh(
      this.postureBeamGeometry,
      this.postureBeamMat,
    );
    this.postureBeamMesh.name = 'PostureBreakColumn';
    this.postureBeamMesh.visible = false;
    this.postureBeamMesh.frustumCulled = false;
    this.group.add(this.postureBeamMesh);

    // Skill 3 Time-Stop Domain (inverted ink-wash dome + 6 reality-slash seam planes)
    this.domainGroup.name = 'Skill3DomainGroup';
    this.domainGroup.visible = false;
    this.uDomainTime = uniform(0);

    const domeUv = uv();
    const domeCenterDist = abs(domeUv.y.sub(0.5)).mul(2.0);
    const crackWave = abs(
      sin(domeUv.x.mul(36.0).add(domeUv.y.mul(18.0)).add(this.uDomainTime.mul(1.4))),
    );
    const crackLine = smoothstep(0.96, 1.0, crackWave);
    const vignette = pow(domeCenterDist, 1.6);

    this.domeMaterial = new MeshBasicNodeMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.domeMaterial.colorNode = mix(
      uniform(new THREE.Color(0x110b04)),
      uniform(new THREE.Color(0xffcf62)),
      crackLine.mul(0.58),
    );
    this.domeMaterial.opacityNode = clamp(
      float(0.24).add(vignette.mul(0.32)).add(crackLine.mul(0.24)),
      0.0,
      0.74,
    );

    this.domeGeometry = new THREE.SphereGeometry(32, 24, 16);
    this.domeMesh = new THREE.Mesh(this.domeGeometry, this.domeMaterial);
    this.domeMesh.name = 'Skill3DomainDome';
    this.domeMesh.frustumCulled = false;
    this.domainGroup.add(this.domeMesh);

    const seamUv = uv();
    const seamCross = smoothstep(1.0, 0.35, abs(seamUv.y.sub(0.5)).mul(2.0)).mul(
      smoothstep(0.0, 0.14, seamUv.x).mul(smoothstep(1.0, 0.86, seamUv.x)),
    );
    const seamCore = pow(seamCross, 2.0);
    this.seamMaterial = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.seamMaterial.colorNode = mix(
      uniform(new THREE.Color(0xff9c20)),
      uniform(new THREE.Color(0xfff7dc)),
      seamCore,
    ).mul(float(2.4));
    this.seamMaterial.opacityNode = seamCross.mul(0.92);

    this.seamGeometry = new THREE.PlaneGeometry(14, 0.36);
    const seamAngles = [
      [0.25, 0.2, 0.48],
      [-0.35, 1.15, -0.52],
      [0.42, 2.05, 0.32],
      [-0.22, -0.85, 0.68],
      [0.18, 2.75, -0.4],
      [-0.48, 0.65, 0.18],
    ];
    for (let i = 0; i < REALITY_SEAM_COUNT; i += 1) {
      const seam = new THREE.Mesh(this.seamGeometry, this.seamMaterial);
      seam.name = `Skill3RealitySeam_${i}`;
      const [rx, ry, rz] = seamAngles[i]!;
      seam.rotation.set(rx, ry, rz);
      seam.frustumCulled = false;
      this.seamMeshes.push(seam);
      this.domainGroup.add(seam);
    }

    this.group.add(this.domainGroup);
    this.syncAllBuffers();
  }

  private createShockwaveSlot(index: number): ShockwaveSlot {
    const uProgress = uniform(0);
    const uColor = uniform(new THREE.Color(0xffd778));
    const uOpacity = uniform(1);

    const p = uv().sub(0.5).mul(2.0);
    const r = length(p);
    const clampedP = clamp(uProgress, 0.0, 1.0);
    const ringRadius = mix(float(0.14), float(0.95), clampedP);
    const ringBand = smoothstep(0.11, 0.0, abs(r.sub(ringRadius)));
    const fadeOut = smoothstep(1.0, 0.35, clampedP);

    const material = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = uColor.mul(float(2.2));
    material.opacityNode = ringBand.mul(fadeOut).mul(uOpacity);

    const mesh = new THREE.Mesh(this.shockwaveGeometry, material);
    mesh.name = `ParticleShockwave_${index}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.frustumCulled = false;
    setObjectLayerRecursive(mesh, LAYER_MAIN_ONLY);
    this.group.add(mesh);

    return {
      mesh,
      material,
      uProgress,
      uColor,
      uOpacity,
      active: false,
      elapsed: 0,
      duration: 0.45,
      delay: 0,
      startScale: 1,
      endScale: 5,
      spawnOrder: 0,
    };
  }

  private createHitStarSlot(index: number): HitFlashStarSlot {
    const uProgress = uniform(0);
    const uColor = uniform(new THREE.Color(0xffb830));

    const coord = uv();
    const dx = abs(coord.x.sub(0.5)).mul(2.0);
    const dy = abs(coord.y.sub(0.5)).mul(2.0);
    const spikeMask = pow(clamp(float(1.0).sub(dx), 0.0, 1.0), 1.45).mul(
      pow(clamp(float(1.0).sub(dy), 0.0, 1.0), 2.4),
    );
    const fadeOut = pow(clamp(float(1.0).sub(uProgress), 0.0, 1.0), 1.65);

    const material = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = mix(uColor, uniform(new THREE.Color(0xffffff)), spikeMask).mul(float(3.4));
    material.opacityNode = spikeMask.mul(fadeOut);

    const group = new THREE.Group();
    group.name = `ImpactHitStarburst_${index}`;
    group.visible = false;

    // 3D 6-axis crossed razor flares + glowing impact shock core visible from every camera angle!
    const angles: Array<[number, number, number]> = [
      [0, 0, 0.35],
      [0, 0, -1.22],
      [0, Math.PI * 0.5, 0.42],
      [0, Math.PI * 0.5, -1.15],
      [Math.PI * 0.5, 0, 0.78],
    ];
    for (const [rx, ry, rz] of angles) {
      const m = new THREE.Mesh(this.hitStarBeamGeom, material);
      m.rotation.set(rx, ry, rz);
      m.frustumCulled = false;
      group.add(m);
    }
    const core = new THREE.Mesh(this.hitStarCoreGeom, material);
    core.frustumCulled = false;
    group.add(core);

    setObjectLayerRecursive(group, LAYER_MAIN_ONLY);
    this.group.add(group);

    return {
      group,
      material,
      uProgress,
      uColor,
      active: false,
      elapsed: 0,
      duration: 0.22,
      maxScale: 2.2,
      spawnOrder: 0,
    };
  }

  private spawnHitStarburst(pos: Vec3Like, heavy: boolean): void {
    let slot = this.hitStars.find((s) => !s.active);
    if (!slot) {
      slot = this.hitStars.reduce((oldest, cand) =>
        cand.spawnOrder < oldest.spawnOrder ? cand : oldest,
      );
    }
    this.spawnCounter += 1;
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = heavy ? 0.26 : 0.18;
    slot.maxScale = heavy ? 3.4 : 2.1;
    slot.spawnOrder = this.spawnCounter;
    slot.uProgress.value = 0;
    slot.uColor.value.setHex(heavy ? 0xff5a18 : 0xffbe2e);
    slot.group.position.set(
      sanitizeCoord(pos.x),
      sanitizeCoord(pos.y),
      sanitizeCoord(pos.z),
    );
    slot.group.rotation.set(
      (this.spawnCounter * 0.47) % Math.PI,
      (this.spawnCounter * 0.83) % Math.PI,
      (this.spawnCounter * 0.61) % Math.PI,
    );
    slot.group.scale.setScalar(heavy ? 0.9 : 0.55);
    slot.group.visible = true;
  }

  private initAmbientParticles(): void {
    for (let i = 0; i < AMBIENT_COUNT; i += 1) {
      const state = this.particles[i]!;
      const h1 = hash01(i * 3.1 + 1);
      const h2 = hash01(i * 7.3 + 2);
      const h3 = hash01(i * 11.7 + 3);
      const h4 = hash01(i * 17.9 + 4);

      state.active = true;
      state.isWisp = i >= 84;
      state.ambientRadius = 4.0 + h1 * 24.0;
      state.ambientAngle = h2 * Math.PI * 2;
      state.ambientAngularSpeed = (0.04 + h3 * 0.09) * (i % 2 === 0 ? 1 : -1);
      state.ambientBaseY = state.isWisp ? 0.8 + h4 * 4.5 : 0.4 + h4 * 9.5;
      state.ambientPhase = h3 * Math.PI * 2;
      state.vy = state.isWisp ? 0.15 : 0.45 + h1 * 0.55;
      state.startScaleX = state.isWisp ? 0.9 + h2 * 0.8 : 0.16 + h2 * 0.16;
      state.startScaleY = state.startScaleX;
      state.endScaleX = state.startScaleX;
      state.endScaleY = state.startScaleY;
      state.rotation = h4 * Math.PI * 2;
      state.rotSpeed = (h1 - 0.5) * 0.8;

      this.updateAmbientSlotPosition(i, state, 0);
      this.applyAmbientPalette(state);
    }
  }

  private applyAmbientPalette(state: ParticleSimState): void {
    const t = this.phaseIntensity;
    if (state.isWisp) {
      // Mist wisp: moonlit azure -> crimson-violet storm
      state.r = 0.25 * (1 - t) + 0.85 * t;
      state.g = 0.58 * (1 - t) + 0.22 * t;
      state.b = 0.95 * (1 - t) + 0.35 * t;
      state.alpha = 0.18 + 0.12 * t;
    } else {
      // Temple ember: warm gold -> burning crimson-gold
      state.r = 1.65 * (1 - t) + 2.3 * t;
      state.g = 1.05 * (1 - t) + 0.65 * t;
      state.b = 0.35 * (1 - t) + 0.22 * t;
      state.alpha = 0.55 + 0.28 * t;
    }
  }

  private updateAmbientSlotPosition(
    index: number,
    state: ParticleSimState,
    dt: number,
  ): void {
    state.ambientAngle += state.ambientAngularSpeed * dt;
    state.ambientBaseY += state.vy * dt;
    const maxY = state.isWisp ? 5.8 : 11.2;
    if (state.ambientBaseY > maxY) {
      state.ambientBaseY = 0.35;
    }

    const bob =
      Math.sin(this.elapsedSeconds * 1.4 + state.ambientPhase) *
      (state.isWisp ? 0.35 : 0.18);
    state.x = Math.cos(state.ambientAngle) * state.ambientRadius;
    state.y = state.ambientBaseY + bob;
    state.z = Math.sin(state.ambientAngle) * state.ambientRadius;
    state.rotation += state.rotSpeed * dt;

    this.writeSlotToBuffers(index, state, state.startScaleX, state.startScaleY, state.alpha);
  }

  private acquireBurstSlot(): ParticleSimState {
    for (let offset = 0; offset < MAX_PARTICLES - BURST_START; offset += 1) {
      const idx =
        BURST_START + ((this.burstCursor - BURST_START + offset) % (MAX_PARTICLES - BURST_START));
      const candidate = this.particles[idx]!;
      if (!candidate.active) {
        this.burstCursor = BURST_START + ((idx - BURST_START + 1) % (MAX_PARTICLES - BURST_START));
        return candidate;
      }
    }
    const fallbackIdx = this.burstCursor;
    this.burstCursor =
      BURST_START + ((this.burstCursor - BURST_START + 1) % (MAX_PARTICLES - BURST_START));
    return this.particles[fallbackIdx]!;
  }

  private spawnShockwave(
    pos: Vec3Like,
    hexColor: number,
    startScale: number,
    endScale: number,
    duration: number,
    delay = 0,
    opacity = 0.9,
  ): void {
    let slot = this.shockwaves.find((entry) => !entry.active);
    if (!slot) {
      slot = this.shockwaves.reduce((oldest, candidate) =>
        candidate.spawnOrder < oldest.spawnOrder ? candidate : oldest,
      );
    }

    this.spawnCounter += 1;
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = duration;
    slot.delay = delay;
    slot.startScale = startScale;
    slot.endScale = endScale;
    slot.spawnOrder = this.spawnCounter;

    slot.uProgress.value = 0;
    slot.uColor.value.setHex(hexColor);
    slot.uOpacity.value = opacity;

    const px = sanitizeCoord(pos.x);
    const py = sanitizeCoord(pos.y);
    const pz = sanitizeCoord(pos.z);
    slot.mesh.position.set(px, py + 0.06, pz);
    slot.mesh.scale.set(startScale, startScale, 1);
    slot.mesh.visible = delay <= 0;
  }

  private emitBurstParticles(
    count: number,
    pos: Vec3Like,
    config: {
      speedMin: number;
      speedMax: number;
      upBias: number;
      gravity: number;
      drag: number;
      lifeMin: number;
      lifeMax: number;
      scaleX: number;
      scaleY: number;
      r: number;
      g: number;
      b: number;
      alpha: number;
      spreadRadius?: number;
    },
  ): void {
    const baseSeed = ++this.spawnCounter * 31.7;
    const spreadR = config.spreadRadius ?? 0.25;
    const px = sanitizeCoord(pos.x);
    const py = sanitizeCoord(pos.y);
    const pz = sanitizeCoord(pos.z);

    for (let i = 0; i < count; i += 1) {
      const slot = this.acquireBurstSlot();
      const h1 = hash01(baseSeed + i * 5.1);
      const h2 = hash01(baseSeed + i * 9.3 + 1);
      const h3 = hash01(baseSeed + i * 13.7 + 2);
      const h4 = hash01(baseSeed + i * 19.1 + 3);

      const theta = h1 * Math.PI * 2;
      const phi = (h2 - 0.35) * Math.PI * 0.85;
      const cosPhi = Math.cos(phi);
      const dx = Math.cos(theta) * cosPhi;
      const dy = Math.sin(phi) + config.upBias;
      const dz = Math.sin(theta) * cosPhi;
      const speed = config.speedMin + h3 * (config.speedMax - config.speedMin);

      slot.active = true;
      slot.x = px + dx * spreadR * h4;
      slot.y = py + 0.15 + h2 * 0.35;
      slot.z = pz + dz * spreadR * h4;
      slot.vx = dx * speed;
      slot.vy = dy * speed;
      slot.vz = dz * speed;
      slot.gravity = config.gravity;
      slot.drag = config.drag;
      slot.life = 0;
      slot.maxLife = config.lifeMin + h4 * (config.lifeMax - config.lifeMin);
      slot.startScaleX = config.scaleX * (0.75 + h1 * 0.5);
      slot.startScaleY = config.scaleY * (0.75 + h2 * 0.5);
      slot.endScaleX = slot.startScaleX * 0.15;
      slot.endScaleY = slot.startScaleY * 0.2;
      slot.rotation = theta;
      slot.rotSpeed = (h3 - 0.5) * 6.0;
      slot.r = config.r;
      slot.g = config.g;
      slot.b = config.b;
      slot.alpha = config.alpha;
    }

    this.syncAllBuffers();
  }

  spawnImpactBurst(pos: Vec3Like, heavy: boolean): void {
    if (this.disposed) {
      return;
    }
    const safePos = {
      x: sanitizeCoord(pos.x),
      y: sanitizeCoord(pos.y),
      z: sanitizeCoord(pos.z),
    };
    const sparkCount = heavy ? 42 : 18;
    this.emitBurstParticles(sparkCount, safePos, {
      speedMin: heavy ? 9.5 : 6.0,
      speedMax: heavy ? 21.5 : 14.5,
      upBias: heavy ? 0.62 : 0.42,
      gravity: 13.5,
      drag: 2.2,
      lifeMin: heavy ? 0.34 : 0.24,
      lifeMax: heavy ? 0.68 : 0.48,
      scaleX: heavy ? 0.28 : 0.19,
      scaleY: heavy ? 0.92 : 0.58,
      r: heavy ? 3.1 : 2.5,
      g: heavy ? 1.75 : 1.9,
      b: heavy ? 0.42 : 0.72,
      alpha: 1.0,
      spreadRadius: heavy ? 0.48 : 0.3,
    });

    this.spawnHitStarburst(safePos, heavy);
    this.spawnShockwave(
      safePos,
      heavy ? 0xff9d2e : 0xffe299,
      heavy ? 0.85 : 0.52,
      heavy ? 6.8 : 3.8,
      heavy ? 0.42 : 0.28,
      0,
      heavy ? 1.0 : 0.85,
    );
    if (heavy) {
      this.spawnShockwave(
        safePos,
        0xfff4c2,
        0.45,
        4.2,
        0.26,
        0.03,
        0.95,
      );
    }
  }

  spawnStaffDragSparks(pos: Vec3Like, dirX: number, dirZ: number): void {
    if (this.disposed) {
      return;
    }
    const safePos = {
      x: sanitizeCoord(pos.x),
      y: Math.max(0.04, sanitizeCoord(pos.y)),
      z: sanitizeCoord(pos.z),
    };
    const len = Math.hypot(dirX, dirZ);
    const backX = len > 1e-4 ? -dirX / len : 0;
    const backZ = len > 1e-4 ? -dirZ / len : 1;

    // Emit 2 fiery stone-scraping golden sparks kicking backward along the bluestone tiles
    for (let k = 0; k < 2; k += 1) {
      const st = this.acquireBurstSlot();
      const h1 = hash01(this.spawnCounter * 3.7 + k * 5.3);
      const h2 = hash01(this.spawnCounter * 7.1 + k * 2.9);
      const spread = (h1 - 0.5) * 0.75;
      const sideX = -backZ;
      const sideZ = backX;
      const spd = 3.2 + h2 * 4.5;

      st.active = true;
      st.x = safePos.x + (h1 - 0.5) * 0.12;
      st.y = safePos.y;
      st.z = safePos.z + (h2 - 0.5) * 0.12;
      st.vx = (backX + sideX * spread) * spd;
      st.vy = 1.4 + h1 * 2.6;
      st.vz = (backZ + sideZ * spread) * spd;
      st.gravity = 12.0;
      st.drag = 1.8;
      st.life = 0;
      st.maxLife = 0.22 + h2 * 0.2;
      st.startScaleX = 0.12;
      st.startScaleY = 0.42;
      st.endScaleX = 0.03;
      st.endScaleY = 0.12;
      st.rotation = Math.atan2(st.vx, st.vz);
      st.rotSpeed = (h1 - 0.5) * 6.0;
      st.r = 3.2;
      st.g = 2.05;
      st.b = 0.48;
      st.alpha = 0.95;
    }
    this.syncAllBuffers();
  }

  spawnDodgePhantomTrail(pos: Vec3Like, _dirX: number, _dirZ: number): void {
    if (this.disposed) {
      return;
    }
    const safePos = {
      x: sanitizeCoord(pos.x),
      y: sanitizeCoord(pos.y) + 0.85,
      z: sanitizeCoord(pos.z),
    };
    this.emitBurstParticles(24, safePos, {
      speedMin: 2.2,
      speedMax: 6.8,
      upBias: 0.45,
      gravity: 4.2,
      drag: 2.6,
      lifeMin: 0.28,
      lifeMax: 0.52,
      scaleX: 0.18,
      scaleY: 0.46,
      r: 3.1,
      g: 2.15,
      b: 0.55,
      alpha: 0.95,
      spreadRadius: 0.55,
    });
    this.spawnShockwave(
      { x: safePos.x, y: 0.04, z: safePos.z },
      0xffbe3b,
      0.42,
      2.6,
      0.32,
      0,
      0.75,
    );
  }

  triggerPostureBreakBurst(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    const safePos = {
      x: sanitizeCoord(pos.x),
      y: sanitizeCoord(pos.y),
      z: sanitizeCoord(pos.z),
    };
    this.emitBurstParticles(64, safePos, {
      speedMin: 8.0,
      speedMax: 19.0,
      upBias: 0.75,
      gravity: 10.5,
      drag: 1.8,
      lifeMin: 0.45,
      lifeMax: 0.95,
      scaleX: 0.32,
      scaleY: 0.85,
      r: 2.4,
      g: 2.0,
      b: 0.75,
      alpha: 1.0,
      spreadRadius: 0.6,
    });

    this.spawnHitStarburst(safePos, true);
    this.spawnShockwave(safePos, 0xffe178, 0.8, 8.5, 0.55, 0, 1.0);
    this.spawnShockwave(safePos, 0x46e8d4, 0.5, 11.2, 0.68, 0.08, 0.85);

    this.postureBeamActive = true;
    this.postureBeamElapsed = 0;
    this.postureBeamDuration = 0.55;
    this.uBeamProgress.value = 0;
    this.postureBeamMesh.position.set(safePos.x, safePos.y + 8.0, safePos.z);
    this.postureBeamMesh.visible = true;
  }

  triggerLotusWardBurst(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    const safePos = {
      x: sanitizeCoord(pos.x),
      y: sanitizeCoord(pos.y),
      z: sanitizeCoord(pos.z),
    };
    this.emitBurstParticles(36, safePos, {
      speedMin: 2.5,
      speedMax: 7.0,
      upBias: 1.35,
      gravity: -1.8,
      drag: 1.5,
      lifeMin: 0.55,
      lifeMax: 1.05,
      scaleX: 0.34,
      scaleY: 0.34,
      r: 0.55,
      g: 2.35,
      b: 1.95,
      alpha: 0.95,
      spreadRadius: 0.9,
    });

    this.spawnShockwave(safePos, 0x4af7d6, 0.5, 5.2, 0.52, 0, 0.9);
  }

  triggerSkill3Domain(active: boolean, targetPos?: Vec3Like): void {
    if (this.disposed) {
      return;
    }

    if (active) {
      if (targetPos) {
        const tx = sanitizeCoord(targetPos.x);
        const ty = sanitizeCoord(targetPos.y);
        const tz = sanitizeCoord(targetPos.z);
        this.lastTargetPos.set(tx, ty, tz);
      }
      this.skill3DomainActive = true;
      this.domainGroup.visible = true;
      this.domeMesh.position.set(0, 0, 0);
      for (let i = 0; i < this.seamMeshes.length; i += 1) {
        const seam = this.seamMeshes[i]!;
        const jitterY = ((i % 3) - 1) * 0.55;
        seam.position.set(
          this.lastTargetPos.x,
          this.lastTargetPos.y + 1.1 + jitterY,
          this.lastTargetPos.z,
        );
      }
      return;
    }

    if (!this.skill3DomainActive) {
      return;
    }

    if (targetPos) {
      const tx = sanitizeCoord(targetPos.x);
      const ty = sanitizeCoord(targetPos.y);
      const tz = sanitizeCoord(targetPos.z);
      this.lastTargetPos.set(tx, ty, tz);
    }

    this.skill3DomainActive = false;
    this.domainGroup.visible = false;

    // Shatter burst on domain exit
    this.emitBurstParticles(72, this.lastTargetPos, {
      speedMin: 10.0,
      speedMax: 22.0,
      upBias: 0.45,
      gravity: 8.5,
      drag: 2.0,
      lifeMin: 0.45,
      lifeMax: 0.92,
      scaleX: 0.28,
      scaleY: 0.92,
      r: 2.95,
      g: 2.1,
      b: 0.65,
      alpha: 1.0,
      spreadRadius: 0.85,
    });
    this.spawnHitStarburst(this.lastTargetPos, true);
    this.spawnShockwave(this.lastTargetPos, 0xffcf58, 0.9, 14.5, 0.65, 0, 1.0);
  }

  setPhaseIntensity(t: number): void {
    if (this.disposed) {
      return;
    }
    const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    this.phaseIntensity = clamped;
    for (let i = 0; i < AMBIENT_COUNT; i += 1) {
      this.applyAmbientPalette(this.particles[i]!);
    }
    this.syncAllBuffers();
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    this.elapsedSeconds += dt;
    if (this.skill3DomainActive) {
      this.uDomainTime.value += dt;
    }

    // Ambient slots 0..119
    for (let i = 0; i < AMBIENT_COUNT; i += 1) {
      this.updateAmbientSlotPosition(i, this.particles[i]!, dt);
    }

    // Burst slots 120..511
    for (let i = BURST_START; i < MAX_PARTICLES; i += 1) {
      const state = this.particles[i]!;
      if (!state.active) {
        this.writeSlotToBuffers(i, state, 0, 0, 0);
        continue;
      }

      state.life += dt;
      if (state.life >= state.maxLife) {
        state.active = false;
        this.writeSlotToBuffers(i, state, 0, 0, 0);
        continue;
      }

      const damp = Math.exp(-state.drag * dt);
      state.vx *= damp;
      state.vy = state.vy * damp - state.gravity * dt;
      state.vz *= damp;

      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.z += state.vz * dt;
      if (state.y < 0.04) {
        state.y = 0.04;
        state.vy = Math.abs(state.vy) * 0.28;
      }
      state.rotation += state.rotSpeed * dt;

      const t = state.life / state.maxLife;
      const sx = state.startScaleX + (state.endScaleX - state.startScaleX) * t;
      const sy = state.startScaleY + (state.endScaleY - state.startScaleY) * t;
      const alpha = state.alpha * (1 - t * t);
      this.writeSlotToBuffers(i, state, sx, sy, alpha);
    }

    // Shockwaves
    for (const slot of this.shockwaves) {
      if (!slot.active) {
        continue;
      }
      slot.elapsed += dt;
      if (slot.elapsed < slot.delay) {
        slot.mesh.visible = false;
        continue;
      }
      const activeElapsed = slot.elapsed - slot.delay;
      const t = Math.min(1, activeElapsed / slot.duration);
      const scale = slot.startScale + (slot.endScale - slot.startScale) * (1 - (1 - t) * (1 - t));
      slot.uProgress.value = t;
      slot.mesh.scale.set(scale, scale, 1);
      slot.mesh.visible = true;

      if (activeElapsed >= slot.duration) {
        slot.active = false;
        slot.mesh.visible = false;
      }
    }

    // 3D On-Hit Starbursts
    for (const star of this.hitStars) {
      if (!star.active) continue;
      star.elapsed += dt;
      const t = Math.min(1, star.elapsed / star.duration);
      star.uProgress.value = t;
      const pop = 0.35 + 0.65 * (1 - Math.pow(1 - t, 3));
      star.group.scale.setScalar(star.maxScale * pop);
      if (star.elapsed >= star.duration) {
        star.active = false;
        star.group.visible = false;
      }
    }

    // Posture Break vertical column
    if (this.postureBeamActive) {
      this.postureBeamElapsed += dt;
      const p = Math.min(1, this.postureBeamElapsed / this.postureBeamDuration);
      this.uBeamProgress.value = p;
      const radialScale = 1.0 + p * 0.7;
      this.postureBeamMesh.scale.set(radialScale, 1, radialScale);
      if (this.postureBeamElapsed >= this.postureBeamDuration) {
        this.postureBeamActive = false;
        this.postureBeamMesh.visible = false;
      }
    }

    this.markAttributesDirty();
  }

  private writeSlotToBuffers(
    index: number,
    state: ParticleSimState,
    scaleX: number,
    scaleY: number,
    alpha: number,
  ): void {
    const i3 = index * 3;
    const i2 = index * 2;

    this.posArray[i3] = state.x;
    this.posArray[i3 + 1] = state.y;
    this.posArray[i3 + 2] = state.z;

    this.scaleArray[i2] = scaleX;
    this.scaleArray[i2 + 1] = scaleY;

    this.rotArray[index] = state.rotation;

    this.colorArray[i3] = state.r;
    this.colorArray[i3 + 1] = state.g;
    this.colorArray[i3 + 2] = state.b;

    this.alphaArray[index] = alpha;
  }

  private syncAllBuffers(): void {
    for (let i = 0; i < AMBIENT_COUNT; i += 1) {
      const state = this.particles[i]!;
      this.writeSlotToBuffers(i, state, state.startScaleX, state.startScaleY, state.alpha);
    }
    for (let i = BURST_START; i < MAX_PARTICLES; i += 1) {
      const state = this.particles[i]!;
      if (!state.active) {
        this.writeSlotToBuffers(i, state, 0, 0, 0);
      } else {
        const t = state.life / state.maxLife;
        const sx = state.startScaleX + (state.endScaleX - state.startScaleX) * t;
        const sy = state.startScaleY + (state.endScaleY - state.startScaleY) * t;
        this.writeSlotToBuffers(i, state, sx, sy, state.alpha * (1 - t * t));
      }
    }
    this.markAttributesDirty();
  }

  private markAttributesDirty(): void {
    this.posAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.rotAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    for (let i = BURST_START; i < MAX_PARTICLES; i += 1) {
      const state = this.particles[i]!;
      state.active = false;
      this.writeSlotToBuffers(i, state, 0, 0, 0);
    }
    for (const slot of this.shockwaves) {
      slot.active = false;
      slot.mesh.visible = false;
    }
    for (const star of this.hitStars) {
      star.active = false;
      star.group.visible = false;
    }
    this.postureBeamActive = false;
    this.postureBeamElapsed = 0;
    this.uBeamProgress.value = 0;
    this.postureBeamMesh.visible = false;
    this.skill3DomainActive = false;
    this.uDomainTime.value = 0;
    this.domainGroup.visible = false;
    this.setPhaseIntensity(0);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.reset();
    this.disposed = true;

    // NEVER call this.sprite.geometry.dispose() — Sprite shares an internal geometry singleton
    this.spriteMat.dispose();

    this.shockwaveGeometry.dispose();
    for (const slot of this.shockwaves) {
      slot.material.dispose();
    }
    this.hitStarBeamGeom.dispose();
    this.hitStarCoreGeom.dispose();
    for (const star of this.hitStars) {
      star.material.dispose();
    }

    this.postureBeamGeometry.dispose();
    this.postureBeamMat.dispose();

    this.domeGeometry.dispose();
    this.domeMaterial.dispose();
    this.seamGeometry.dispose();
    this.seamMaterial.dispose();

    this.group.clear();
  }

  getActiveBurstCount(): number {
    let count = 0;
    for (let i = BURST_START; i < MAX_PARTICLES; i += 1) {
      if (this.particles[i]!.active) {
        count += 1;
      }
    }
    return count;
  }

  isSkill3DomainActive(): boolean {
    return this.skill3DomainActive;
  }
}
