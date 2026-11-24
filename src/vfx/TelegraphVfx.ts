import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  atan,
  clamp,
  float,
  fract,
  length,
  max,
  mix,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import type {
  TelegraphArcParams,
  TelegraphLineParams,
  TelegraphRingParams,
  Vec3Like,
} from '../types/game.ts';

const RING_POOL_SIZE = 8;
const ARC_POOL_SIZE = 6;
const LINE_POOL_SIZE = 6;
const PILLAR_POOL_SIZE = 8;
const MAX_VFX_COORD = 1e6;

function sanitizeCoord(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-MAX_VFX_COORD, Math.min(MAX_VFX_COORD, value));
}

function sanitizePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(MAX_VFX_COORD, value);
}

const makeFloatUniform = (v: number) => uniform(v);
const makeColorUniform = (v: THREE.Color) => uniform(v);
type FloatUniform = ReturnType<typeof makeFloatUniform>;
type ColorUniform = ReturnType<typeof makeColorUniform>;

export type TelegraphColorKey = 'crimson_gold' | 'amber' | 'violet';

export interface TelegraphPillarParams {
  center: Vec3Like;
  radius: number;
  height?: number;
  progress: number; // 0..1
  color?: TelegraphColorKey;
}

interface TelegraphPalette {
  readonly base: number;
  readonly accent: number;
}

const TELEGRAPH_PALETTES: Record<TelegraphColorKey, TelegraphPalette> = {
  crimson_gold: { base: 0xd92626, accent: 0xffb44c },
  amber: { base: 0xe8821c, accent: 0xffe28a },
  violet: { base: 0x8c3be8, accent: 0xdcb4ff },
};

type TelegraphKind = 'ring' | 'arc' | 'line' | 'pillar';

interface RingSlot {
  readonly kind: 'ring';
  readonly mesh: THREE.Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uInnerRatio: FloatUniform;
  readonly uTime: FloatUniform;
  readonly uBaseColor: ColorUniform;
  readonly uAccentColor: ColorUniform;
  activeId: string | null;
  spawnOrder: number;
}

interface ArcSlot {
  readonly kind: 'arc';
  readonly mesh: THREE.Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uHalfAngle: FloatUniform;
  readonly uTime: FloatUniform;
  readonly uBaseColor: ColorUniform;
  readonly uAccentColor: ColorUniform;
  activeId: string | null;
  spawnOrder: number;
}

interface LineSlot {
  readonly kind: 'line';
  readonly mesh: THREE.Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uTime: FloatUniform;
  readonly uBaseColor: ColorUniform;
  readonly uAccentColor: ColorUniform;
  activeId: string | null;
  spawnOrder: number;
}

interface PillarSlot {
  readonly kind: 'pillar';
  readonly container: THREE.Group;
  readonly beamMesh: THREE.Mesh;
  readonly baseMesh: THREE.Mesh;
  readonly beamMaterial: MeshBasicNodeMaterial;
  readonly baseMaterial: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uTime: FloatUniform;
  readonly uBaseColor: ColorUniform;
  readonly uAccentColor: ColorUniform;
  activeId: string | null;
  spawnOrder: number;
}

type AnyTelegraphSlot = RingSlot | ArcSlot | LineSlot | PillarSlot;

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeDirectionXZ(dir: Vec3Like): { nx: number; nz: number; yaw: number } {
  const dx = Number.isFinite(dir.x) ? dir.x : 0;
  const dz = Number.isFinite(dir.z) ? dir.z : 0;
  const maxAbs = Math.max(Math.abs(dx), Math.abs(dz));
  if (maxAbs <= 1e-4) {
    return { nx: 0, nz: 1, yaw: 0 };
  }
  const len = Math.hypot(dx, dz);
  let nx: number;
  let nz: number;
  if (Number.isFinite(len) && len > 0) {
    nx = dx / len;
    nz = dz / len;
  } else {
    const ux = dx / maxAbs;
    const uz = dz / maxAbs;
    const uLen = Math.hypot(ux, uz);
    if (!Number.isFinite(uLen) || uLen <= 0) {
      return { nx: 0, nz: 1, yaw: 0 };
    }
    nx = ux / uLen;
    nz = uz / uLen;
  }
  if (!Number.isFinite(nx) || !Number.isFinite(nz)) {
    return { nx: 0, nz: 1, yaw: 0 };
  }
  const yaw = Math.atan2(nx, nz);
  return { nx, nz, yaw: Number.isFinite(yaw) ? yaw : 0 };
}

function getPalette(colorKey?: TelegraphColorKey): TelegraphPalette {
  if (colorKey && colorKey in TELEGRAPH_PALETTES) {
    return TELEGRAPH_PALETTES[colorKey];
  }
  return TELEGRAPH_PALETTES.crimson_gold;
}

export class TelegraphVfx {
  readonly group = new THREE.Group();

  private readonly plane2x2Geometry: THREE.PlaneGeometry;
  private readonly plane1x1Geometry: THREE.PlaneGeometry;
  private readonly pillarCylinderGeometry: THREE.CylinderGeometry;

  private readonly ringSlots: RingSlot[] = [];
  private readonly arcSlots: ArcSlot[] = [];
  private readonly lineSlots: LineSlot[] = [];
  private readonly pillarSlots: PillarSlot[] = [];
  private readonly activeById = new Map<string, AnyTelegraphSlot>();

  private spawnCounter = 0;
  private disposed = false;

  constructor() {
    this.group.name = 'TelegraphVfxGroup';
    this.plane2x2Geometry = new THREE.PlaneGeometry(2, 2);
    this.plane1x1Geometry = new THREE.PlaneGeometry(1, 1);
    this.pillarCylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);

    for (let i = 0; i < RING_POOL_SIZE; i += 1) {
      this.ringSlots.push(this.createRingSlot(i));
    }
    for (let i = 0; i < ARC_POOL_SIZE; i += 1) {
      this.arcSlots.push(this.createArcSlot(i));
    }
    for (let i = 0; i < LINE_POOL_SIZE; i += 1) {
      this.lineSlots.push(this.createLineSlot(i));
    }
    for (let i = 0; i < PILLAR_POOL_SIZE; i += 1) {
      this.pillarSlots.push(this.createPillarSlot(i));
    }
  }

  private createRingSlot(index: number): RingSlot {
    const uProgress = uniform(0);
    const uInnerRatio = uniform(0);
    const uTime = uniform(0);
    const uBaseColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.base));
    const uAccentColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.accent));

    const p = uv().sub(0.5).mul(2.0);
    const r = length(p);
    const clampedP = clamp(uProgress, 0.0, 1.0);

    const outerMask = smoothstep(1.0, 0.96, r);
    const innerMask = smoothstep(uInnerRatio.sub(0.025), uInnerRatio.add(0.015), r);
    const ringMask = outerMask.mul(innerMask);

    const outerRim = smoothstep(0.91, 0.965, r).mul(outerMask);
    const innerRim = smoothstep(uInnerRatio.add(0.065), uInnerRatio.add(0.015), r)
      .mul(innerMask)
      .mul(smoothstep(0.0, 0.05, uInnerRatio));

    const fillEdge = mix(uInnerRatio, float(1.0), clampedP);
    const fillMask = smoothstep(fillEdge.add(0.02), fillEdge.sub(0.04), r).mul(ringMask);
    const waveFront = smoothstep(0.07, 0.0, abs(r.sub(fillEdge))).mul(ringMask);

    const urgent = smoothstep(0.85, 1.0, clampedP);
    const pulse = float(1.0).add(
      urgent.mul(sin(uTime.mul(24.0)).mul(0.32).add(0.32)),
    );

    const rimBoost = max(outerRim, max(innerRim, waveFront));
    const finalColor = mix(uBaseColor, uAccentColor, rimBoost)
      .mul(float(1.3).add(urgent.mul(0.85)))
      .mul(pulse);
    const finalOpacity = ringMask
      .mul(
        float(0.16)
          .add(fillMask.mul(0.32))
          .add(outerRim.mul(0.68))
          .add(innerRim.mul(0.45))
          .add(waveFront.mul(0.6)),
      )
      .mul(pulse);

    const material = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = finalColor;
    material.opacityNode = finalOpacity;

    const mesh = new THREE.Mesh(this.plane2x2Geometry, material);
    mesh.name = `TelegraphRing_${index}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.frustumCulled = false;
    setObjectLayerRecursive(mesh, LAYER_MAIN_ONLY);
    this.group.add(mesh);

    return {
      kind: 'ring',
      mesh,
      material,
      uProgress,
      uInnerRatio,
      uTime,
      uBaseColor,
      uAccentColor,
      activeId: null,
      spawnOrder: 0,
    };
  }

  private createArcSlot(index: number): ArcSlot {
    const uProgress = uniform(0);
    const uHalfAngle = uniform(Math.PI / 3);
    const uTime = uniform(0);
    const uBaseColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.base));
    const uAccentColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.accent));

    const coord = uv();
    // After rotation (-PI/2 around X, yaw around Y), local +Z forward maps to (0.5 - uv.y)
    const px = coord.x.sub(0.5).mul(2.0);
    const forwardZ = float(0.5).sub(coord.y).mul(2.0);
    const p = vec2(px, forwardZ);
    const r = length(p);
    const ang = abs(atan(p.x, p.y));
    const clampedP = clamp(uProgress, 0.0, 1.0);

    const radialMask = smoothstep(1.0, 0.96, r).mul(smoothstep(0.04, 0.1, r));
    const angularMask = smoothstep(uHalfAngle.add(0.03), uHalfAngle.sub(0.03), ang);
    const sectorMask = radialMask.mul(angularMask);

    const outerRim = smoothstep(0.91, 0.965, r).mul(sectorMask);
    const sideRim = smoothstep(uHalfAngle.sub(0.075), uHalfAngle.sub(0.015), ang).mul(
      sectorMask,
    );

    const fillMask = smoothstep(clampedP.add(0.025), clampedP.sub(0.035), r).mul(
      sectorMask,
    );
    const waveFront = smoothstep(0.07, 0.0, abs(r.sub(clampedP))).mul(sectorMask);

    const urgent = smoothstep(0.85, 1.0, clampedP);
    const pulse = float(1.0).add(
      urgent.mul(sin(uTime.mul(24.0)).mul(0.32).add(0.32)),
    );

    const rimBoost = max(max(outerRim, sideRim), waveFront);
    const finalColor = mix(uBaseColor, uAccentColor, rimBoost)
      .mul(float(1.3).add(urgent.mul(0.85)))
      .mul(pulse);
    const finalOpacity = sectorMask
      .mul(
        float(0.18)
          .add(fillMask.mul(0.34))
          .add(outerRim.mul(0.65))
          .add(sideRim.mul(0.55))
          .add(waveFront.mul(0.55)),
      )
      .mul(pulse);

    const material = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = finalColor;
    material.opacityNode = finalOpacity;

    const mesh = new THREE.Mesh(this.plane2x2Geometry, material);
    mesh.name = `TelegraphArc_${index}`;
    mesh.rotation.order = 'YXZ';
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.frustumCulled = false;
    setObjectLayerRecursive(mesh, LAYER_MAIN_ONLY);
    this.group.add(mesh);

    return {
      kind: 'arc',
      mesh,
      material,
      uProgress,
      uHalfAngle,
      uTime,
      uBaseColor,
      uAccentColor,
      activeId: null,
      spawnOrder: 0,
    };
  }

  private createLineSlot(index: number): LineSlot {
    const uProgress = uniform(0);
    const uTime = uniform(0);
    const uBaseColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.base));
    const uAccentColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.accent));

    const coord = uv();
    // Forward along +Z after R_x(-PI/2) corresponds to (1 - uv.y)
    const sideOffset = abs(coord.x.sub(0.5).mul(2.0)); // 0 center .. 1 side edge
    const fwd = float(1.0).sub(coord.y); // 0 origin .. 1 tip
    const clampedP = clamp(uProgress, 0.0, 1.0);

    const edgeFade = smoothstep(1.0, 0.9, sideOffset);
    const lengthFade = smoothstep(0.0, 0.04, fwd).mul(smoothstep(1.0, 0.94, fwd));
    const bodyMask = edgeFade.mul(lengthFade);

    const sideBorder = smoothstep(0.76, 0.9, sideOffset).mul(edgeFade).mul(lengthFade);
    const tipBorder = smoothstep(0.9, 0.95, fwd).mul(bodyMask);

    const chevronPhase = fract(fwd.mul(6.0).sub(uTime.mul(2.4)).add(sideOffset.mul(0.85)));
    const chevronBand = smoothstep(0.2, 0.45, chevronPhase).mul(
      smoothstep(0.8, 0.5, chevronPhase),
    );

    const chargeFill = smoothstep(clampedP.add(0.03), clampedP.sub(0.05), fwd).mul(
      bodyMask,
    );
    const chargeFront = smoothstep(0.07, 0.0, abs(fwd.sub(clampedP))).mul(bodyMask);

    const urgent = smoothstep(0.85, 1.0, clampedP);
    const pulse = float(1.0).add(
      urgent.mul(sin(uTime.mul(24.0)).mul(0.3).add(0.3)),
    );

    const accentMask = max(max(sideBorder, tipBorder), max(chargeFront, chevronBand.mul(0.5)));
    const finalColor = mix(uBaseColor, uAccentColor, accentMask)
      .mul(float(1.25).add(urgent.mul(0.85)))
      .mul(pulse);
    const finalOpacity = bodyMask
      .mul(
        float(0.18)
          .add(chargeFill.mul(0.34))
          .add(sideBorder.mul(0.7))
          .add(tipBorder.mul(0.5))
          .add(chevronBand.mul(0.28))
          .add(chargeFront.mul(0.6)),
      )
      .mul(pulse);

    const material = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = finalColor;
    material.opacityNode = finalOpacity;

    const mesh = new THREE.Mesh(this.plane1x1Geometry, material);
    mesh.name = `TelegraphLine_${index}`;
    mesh.rotation.order = 'YXZ';
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    mesh.frustumCulled = false;
    setObjectLayerRecursive(mesh, LAYER_MAIN_ONLY);
    this.group.add(mesh);

    return {
      kind: 'line',
      mesh,
      material,
      uProgress,
      uTime,
      uBaseColor,
      uAccentColor,
      activeId: null,
      spawnOrder: 0,
    };
  }

  private createPillarSlot(index: number): PillarSlot {
    const uProgress = uniform(0);
    const uTime = uniform(0);
    const uBaseColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.base));
    const uAccentColor = uniform(new THREE.Color(TELEGRAPH_PALETTES.crimson_gold.accent));

    const clampedP = clamp(uProgress, 0.0, 1.0);
    const urgent = smoothstep(0.85, 1.0, clampedP);
    const pulse = float(1.0).add(
      urgent.mul(sin(uTime.mul(26.0)).mul(0.32).add(0.32)),
    );

    // Vertical beam shader
    const beamUv = uv();
    const verticalFade = smoothstep(1.0, 0.2, beamUv.y).mul(
      smoothstep(0.0, 0.04, beamUv.y),
    );
    const baseFlare = smoothstep(0.22, 0.0, beamUv.y);
    const verticalStreaks = sin(
      beamUv.x.mul(Math.PI * 16).add(uTime.mul(4.5)),
    )
      .mul(0.28)
      .add(0.72);
    const beamIntensity = float(0.45).add(clampedP.mul(1.65)).add(baseFlare.mul(0.8));

    const beamMaterial = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    beamMaterial.colorNode = mix(uBaseColor, uAccentColor, max(baseFlare, clampedP))
      .mul(beamIntensity)
      .mul(pulse);
    beamMaterial.opacityNode = verticalFade
      .mul(verticalStreaks)
      .mul(float(0.14).add(clampedP.mul(0.48)).add(baseFlare.mul(0.32)))
      .mul(pulse);

    // Base ground warning ring shader
    const baseP = uv().sub(0.5).mul(2.0);
    const baseR = length(baseP);
    const baseMask = smoothstep(1.0, 0.94, baseR);
    const baseRim = smoothstep(0.86, 0.94, baseR).mul(baseMask);
    const baseFill = smoothstep(clampedP.add(0.03), clampedP.sub(0.05), baseR).mul(
      baseMask,
    );

    const baseMaterial = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    baseMaterial.colorNode = mix(uBaseColor, uAccentColor, baseRim)
      .mul(float(1.35).add(urgent.mul(0.8)))
      .mul(pulse);
    baseMaterial.opacityNode = baseMask
      .mul(float(0.2).add(baseFill.mul(0.38)).add(baseRim.mul(0.65)))
      .mul(pulse);

    const container = new THREE.Group();
    container.name = `TelegraphPillar_${index}`;
    container.visible = false;

    const beamMesh = new THREE.Mesh(this.pillarCylinderGeometry, beamMaterial);
    beamMesh.frustumCulled = false;

    const baseMesh = new THREE.Mesh(this.plane2x2Geometry, baseMaterial);
    baseMesh.rotation.x = -Math.PI / 2;
    baseMesh.position.y = 0.035;
    baseMesh.frustumCulled = false;
    setObjectLayerRecursive(baseMesh, LAYER_MAIN_ONLY);

    container.add(beamMesh, baseMesh);
    this.group.add(container);

    return {
      kind: 'pillar',
      container,
      beamMesh,
      baseMesh,
      beamMaterial,
      baseMaterial,
      uProgress,
      uTime,
      uBaseColor,
      uAccentColor,
      activeId: null,
      spawnOrder: 0,
    };
  }

  private acquireSlot<T extends AnyTelegraphSlot>(
    id: string,
    kind: TelegraphKind,
    pool: T[],
  ): T {
    const existing = this.activeById.get(id);
    if (existing) {
      if (existing.kind === kind) {
        return existing as T;
      }
      this.releaseSlot(existing);
    }

    let slot = pool.find((entry) => entry.activeId === null);
    if (!slot) {
      slot = pool.reduce((oldest, candidate) =>
        candidate.spawnOrder < oldest.spawnOrder ? candidate : oldest,
      );
      if (slot.activeId !== null) {
        this.activeById.delete(slot.activeId);
      }
    }

    this.spawnCounter += 1;
    slot.activeId = id;
    slot.spawnOrder = this.spawnCounter;
    this.activeById.set(id, slot);
    return slot;
  }

  private releaseSlot(slot: AnyTelegraphSlot): void {
    if (slot.activeId !== null) {
      this.activeById.delete(slot.activeId);
      slot.activeId = null;
    }
    if (slot.kind === 'pillar') {
      slot.container.visible = false;
    } else {
      slot.mesh.visible = false;
    }
  }

  showRing(id: string, params: TelegraphRingParams): void {
    if (this.disposed) {
      return;
    }
    const slot = this.acquireSlot(id, 'ring', this.ringSlots);
    const outerRadius = sanitizePositive(params.outerRadius, 1);
    const innerRadius =
      Number.isFinite(params.innerRadius) && params.innerRadius > 0
        ? Math.min(params.innerRadius, outerRadius * 0.95)
        : 0;
    const cx = sanitizeCoord(params.center.x);
    const cy = sanitizeCoord(params.center.y);
    const cz = sanitizeCoord(params.center.z);
    const palette = getPalette(params.color);

    slot.uBaseColor.value.setHex(palette.base);
    slot.uAccentColor.value.setHex(palette.accent);
    slot.uInnerRatio.value = innerRadius / outerRadius;
    slot.uProgress.value = clampProgress(params.progress);

    slot.mesh.position.set(cx, cy + 0.03, cz);
    slot.mesh.scale.set(outerRadius, outerRadius, 1);
    slot.mesh.visible = true;
  }

  showArc(id: string, params: TelegraphArcParams): void {
    if (this.disposed) {
      return;
    }
    const slot = this.acquireSlot(id, 'arc', this.arcSlots);
    const radius = sanitizePositive(params.radius, 1);
    const arcAngle =
      Number.isFinite(params.arcAngleRad) && params.arcAngleRad > 0
        ? Math.min(params.arcAngleRad, Math.PI * 2)
        : Math.PI / 2;
    const ox = sanitizeCoord(params.origin.x);
    const oy = sanitizeCoord(params.origin.y);
    const oz = sanitizeCoord(params.origin.z);
    const { yaw: safeYaw } = normalizeDirectionXZ(params.direction);
    const palette = getPalette(params.color);

    slot.uBaseColor.value.setHex(palette.base);
    slot.uAccentColor.value.setHex(palette.accent);
    slot.uHalfAngle.value = arcAngle * 0.5;
    slot.uProgress.value = clampProgress(params.progress);

    slot.mesh.position.set(ox, oy + 0.035, oz);
    slot.mesh.rotation.set(-Math.PI / 2, safeYaw, 0);
    slot.mesh.scale.set(radius, radius, 1);
    slot.mesh.visible = true;
  }

  showLine(id: string, params: TelegraphLineParams): void {
    if (this.disposed) {
      return;
    }
    const slot = this.acquireSlot(id, 'line', this.lineSlots);
    const lengthVal = sanitizePositive(params.length, 1);
    const widthVal = sanitizePositive(params.width, 1);

    const ox = sanitizeCoord(params.origin.x);
    const oy = sanitizeCoord(params.origin.y);
    const oz = sanitizeCoord(params.origin.z);
    const { nx, nz, yaw } = normalizeDirectionXZ(params.direction);
    const palette = getPalette(params.color);

    slot.uBaseColor.value.setHex(palette.base);
    slot.uAccentColor.value.setHex(palette.accent);
    slot.uProgress.value = clampProgress(params.progress);

    slot.mesh.position.set(
      ox + nx * (lengthVal * 0.5),
      oy + 0.035,
      oz + nz * (lengthVal * 0.5),
    );
    slot.mesh.rotation.set(-Math.PI / 2, yaw, 0);
    slot.mesh.scale.set(widthVal, lengthVal, 1);
    slot.mesh.visible = true;
  }

  showPillar(id: string, params: TelegraphPillarParams): void {
    if (this.disposed) {
      return;
    }
    const slot = this.acquireSlot(id, 'pillar', this.pillarSlots);
    const radius = sanitizePositive(params.radius, 1);
    const height =
      params.height !== undefined ? sanitizePositive(params.height, 18) : 18;
    const cx = sanitizeCoord(params.center.x);
    const cy = sanitizeCoord(params.center.y);
    const cz = sanitizeCoord(params.center.z);
    const palette = getPalette(params.color);

    slot.uBaseColor.value.setHex(palette.base);
    slot.uAccentColor.value.setHex(palette.accent);
    slot.uProgress.value = clampProgress(params.progress);

    slot.container.position.set(cx, cy, cz);
    slot.beamMesh.position.set(0, height * 0.5, 0);
    slot.beamMesh.scale.set(radius * 0.85, height, radius * 0.85);
    slot.baseMesh.scale.set(radius, radius, 1);
    slot.container.visible = true;
  }

  clear(id: string): void {
    if (this.disposed) {
      return;
    }
    const slot = this.activeById.get(id);
    if (slot) {
      this.releaseSlot(slot);
    }
  }

  clearAll(): void {
    if (this.disposed) {
      return;
    }
    for (const slot of this.activeById.values()) {
      slot.activeId = null;
      if (slot.kind === 'pillar') {
        slot.container.visible = false;
      } else {
        slot.mesh.visible = false;
      }
    }
    this.activeById.clear();
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }
    for (const slot of this.activeById.values()) {
      slot.uTime.value += dt;
    }
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.clearAll();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.clearAll();
    this.disposed = true;
    this.plane2x2Geometry.dispose();
    this.plane1x1Geometry.dispose();
    this.pillarCylinderGeometry.dispose();

    for (const slot of this.ringSlots) {
      slot.material.dispose();
    }
    for (const slot of this.arcSlots) {
      slot.material.dispose();
    }
    for (const slot of this.lineSlots) {
      slot.material.dispose();
    }
    for (const slot of this.pillarSlots) {
      slot.beamMaterial.dispose();
      slot.baseMaterial.dispose();
    }
    this.group.clear();
  }

  getActiveCount(): number {
    return this.activeById.size;
  }
}
