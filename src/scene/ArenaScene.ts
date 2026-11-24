import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  atan,
  color,
  cos,
  dot,
  float,
  fract,
  fwidth,
  length,
  max,
  mix,
  normalView,
  positionViewDirection,
  pow,
  reflector,
  saturate,
  screenUV,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import type { AssetLoader } from '../engine/AssetLoader.ts';
import {
  LAYER_DEFAULT,
  LAYER_MAIN_ONLY,
  setObjectLayerRecursive,
} from '../engine/RenderLayers.ts';
import type { AtmosphereController } from './AtmosphereController.ts';
import {
  COMBAT_TUNING,
  type ArenaInterface,
  type Vec3Like,
} from '../types/game.ts';

export interface ArenaSceneOptions {
  scene: THREE.Scene;
  assetLoader?: AssetLoader;
  atmosphere?: AtmosphereController;
}

export interface MonumentClearance {
  name: string;
  minCenterDist: number;
  minBoxRadius: number;
}

const MIN_MONUMENT_CLEARANCE_RADIUS = 29.0;
const FLOOR_GEOMETRY_RADIUS = 26.0;
const PLINTH_INNER_MIN_R = 28.95;
const PLINTH_OUTER_MAX_R = 42.2;
const PLINTH_BOTTOM_SCALE = 1.15;
const PLINTH_CLEARANCE_GAP = 0.06;
const PLINTH_MIN_RADIUS = 0.25;

interface PlinthFootprintSpec {
  name: string;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
}

function getPlinthOctagonVertices(
  spec: PlinthFootprintSpec,
  pad = 0,
): Array<[number, number]> {
  const ax = spec.rx * PLINTH_BOTTOM_SCALE + pad;
  const az = spec.rz * PLINTH_BOTTOM_SCALE + pad;
  const verts: Array<[number, number]> = [];
  for (let k = 0; k < 8; k += 1) {
    const theta = (k / 8) * Math.PI * 2;
    verts.push([
      spec.cx + Math.sin(theta) * ax,
      spec.cz + Math.cos(theta) * az,
    ]);
  }
  return verts;
}

function isPlinthWithinTerrace(spec: PlinthFootprintSpec): boolean {
  const verts = getPlinthOctagonVertices(spec, 0);
  for (let k = 0; k < 8; k += 1) {
    const [x0, z0] = verts[k]!;
    const [x1, z1] = verts[(k + 1) % 8]!;
    const r0 = Math.hypot(x0, z0);
    if (r0 < PLINTH_INNER_MIN_R || r0 > PLINTH_OUTER_MAX_R) {
      return false;
    }
    const midR = Math.hypot((x0 + x1) * 0.5, (z0 + z1) * 0.5);
    if (midR < PLINTH_INNER_MIN_R || midR > PLINTH_OUTER_MAX_R) {
      return false;
    }
  }
  return true;
}

function clampPlinthToTerrace(spec: PlinthFootprintSpec): void {
  for (let iter = 0; iter < 80; iter += 1) {
    if (isPlinthWithinTerrace(spec)) {
      return;
    }
    if (spec.rx <= PLINTH_MIN_RADIUS && spec.rz <= PLINTH_MIN_RADIUS) {
      return;
    }
    spec.rx = Math.max(PLINTH_MIN_RADIUS, spec.rx * 0.96);
    spec.rz = Math.max(PLINTH_MIN_RADIUS, spec.rz * 0.96);
  }
}

function hasSeparatingAxis(
  vertsA: Array<[number, number]>,
  vertsB: Array<[number, number]>,
  edgeSource: Array<[number, number]>,
): boolean {
  for (let i = 0; i < edgeSource.length; i += 1) {
    const [x0, z0] = edgeSource[i]!;
    const [x1, z1] = edgeSource[(i + 1) % edgeSource.length]!;
    const nx = -(z1 - z0);
    const nz = x1 - x0;

    let minA = Infinity;
    let maxA = -Infinity;
    for (const [vx, vz] of vertsA) {
      const p = vx * nx + vz * nz;
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }

    let minB = Infinity;
    let maxB = -Infinity;
    for (const [vx, vz] of vertsB) {
      const p = vx * nx + vz * nz;
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }

    if (maxA <= minB || maxB <= minA) {
      return true;
    }
  }
  return false;
}

function plinthsOverlapXZ(
  a: PlinthFootprintSpec,
  b: PlinthFootprintSpec,
  pad: number,
): boolean {
  const ax = a.rx * PLINTH_BOTTOM_SCALE + pad;
  const az = a.rz * PLINTH_BOTTOM_SCALE + pad;
  const bx = b.rx * PLINTH_BOTTOM_SCALE + pad;
  const bz = b.rz * PLINTH_BOTTOM_SCALE + pad;
  if (Math.abs(a.cx - b.cx) >= ax + bx || Math.abs(a.cz - b.cz) >= az + bz) {
    return false;
  }
  const vertsA = getPlinthOctagonVertices(a, pad);
  const vertsB = getPlinthOctagonVertices(b, pad);
  if (hasSeparatingAxis(vertsA, vertsB, vertsA)) {
    return false;
  }
  if (hasSeparatingAxis(vertsA, vertsB, vertsB)) {
    return false;
  }
  return true;
}

export function clampArenaPosition(
  pos: Vec3Like,
  radius = COMBAT_TUNING.arenaRadius,
  margin = 0.6,
): Vec3Like {
  const sx = Number.isFinite(pos.x) ? pos.x : 0;
  const sy = Number.isFinite(pos.y) ? pos.y : 0;
  const sz = Number.isFinite(pos.z) ? pos.z : 0;
  const safeRadius = Number.isFinite(radius)
    ? Math.max(0, radius)
    : COMBAT_TUNING.arenaRadius;
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0.6;
  const maxR = Math.max(0, safeRadius - safeMargin);

  const maxAbs = Math.max(Math.abs(sx), Math.abs(sz));
  if (maxAbs === 0) {
    return { x: 0, y: sy, z: 0 };
  }

  const len = Math.hypot(sx, sz);
  if (Number.isFinite(len) && len <= maxR) {
    return { x: sx, y: sy, z: sz };
  }

  let rx: number;
  let rz: number;
  if (Number.isFinite(len) && len > 0) {
    rx = (sx / len) * maxR;
    rz = (sz / len) * maxR;
  } else {
    // Fallback for huge finite components where Math.hypot overflows to Infinity
    const ux = sx / maxAbs;
    const uz = sz / maxAbs;
    const uLen = Math.hypot(ux, uz);
    if (!Number.isFinite(uLen) || uLen <= 0) {
      return { x: 0, y: sy, z: 0 };
    }
    rx = (ux / uLen) * maxR;
    rz = (uz / uLen) * maxR;
  }

  if (!Number.isFinite(rx) || !Number.isFinite(rz)) {
    return { x: 0, y: sy, z: 0 };
  }
  return { x: rx, y: sy, z: rz };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function computeMinBoxRadiusXZ(obj: THREE.Object3D): number {
  obj.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) {
    return Math.hypot(obj.position.x, obj.position.z);
  }
  const closestX = Math.max(box.min.x, Math.min(0, box.max.x));
  const closestZ = Math.max(box.min.z, Math.min(0, box.max.z));
  return Math.hypot(closestX, closestZ);
}

export function groundObjectToY(obj: THREE.Object3D, targetY = 0): void {
  const safeTargetY = Number.isFinite(targetY) ? targetY : 0;
  obj.updateWorldMatrix(true, true);

  let minVertexY = Infinity;
  const vertex = new THREE.Vector3();
  const fallbackBox = new THREE.Box3();

  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const geom = child.geometry as THREE.BufferGeometry | undefined;
    const posAttr = geom?.attributes?.position as
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute
      | undefined;

    if (posAttr && posAttr.count > 0) {
      for (let i = 0; i < posAttr.count; i += 1) {
        vertex.fromBufferAttribute(posAttr, i).applyMatrix4(child.matrixWorld);
        if (Number.isFinite(vertex.y) && vertex.y < minVertexY) {
          minVertexY = vertex.y;
        }
      }
    } else {
      fallbackBox.setFromObject(child);
      if (
        !fallbackBox.isEmpty() &&
        Number.isFinite(fallbackBox.min.y) &&
        fallbackBox.min.y < minVertexY
      ) {
        minVertexY = fallbackBox.min.y;
      }
    }
  });

  if (!Number.isFinite(minVertexY)) {
    fallbackBox.setFromObject(obj);
    if (!fallbackBox.isEmpty() && Number.isFinite(fallbackBox.min.y)) {
      minVertexY = fallbackBox.min.y;
    }
  }

  if (Number.isFinite(minVertexY)) {
    obj.position.y += safeTargetY - minVertexY;
    obj.updateWorldMatrix(true, true);
  }
}

function enforceRadialClearance(
  obj: THREE.Object3D,
  minClearance = MIN_MONUMENT_CLEARANCE_RADIUS,
): void {
  const currentClearance = computeMinBoxRadiusXZ(obj);
  if (currentClearance >= minClearance) {
    return;
  }
  const horizDist = Math.hypot(obj.position.x, obj.position.z);
  const dirX = horizDist > 1e-4 ? obj.position.x / horizDist : 0;
  const dirZ = horizDist > 1e-4 ? obj.position.z / horizDist : -1;
  const push = minClearance - currentClearance + 0.25;
  obj.position.x += dirX * push;
  obj.position.z += dirZ * push;
  obj.updateMatrixWorld(true);
}

export class ArenaScene implements ArenaInterface {
  readonly arenaRadius = COMBAT_TUNING.arenaRadius;
  readonly rootGroup = new THREE.Group();
  readonly monumentsGroup = new THREE.Group();
  readonly plinthsGroup = new THREE.Group();
  readonly colossiGroup = new THREE.Group();
  readonly floorMesh: THREE.Mesh;
  readonly groundReflector: ReturnType<typeof reflector>;

  private readonly scene: THREE.Scene;
  private readonly assetLoader?: AssetLoader;
  private readonly atmosphere?: AtmosphereController;

  private readonly uTime = uniform(0);
  private readonly uPhaseIntensity = uniform(0);

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly floatingRingPivots: Array<{ group: THREE.Group; speed: number }> = [];

  private daisBodyMat!: MeshStandardNodeMaterial;
  private daisTrimMat!: MeshStandardNodeMaterial;
  private plinthBodyGeom?: THREE.CylinderGeometry;
  private plinthTrimGeom?: THREE.CylinderGeometry;

  private phaseIntensity = 0;
  private disposed = false;
  private readonly configuredReflectorCameras = new WeakSet<THREE.Camera>();

  constructor(options: ArenaSceneOptions) {
    this.scene = options.scene;
    this.assetLoader = options.assetLoader;
    this.atmosphere = options.atmosphere;

    this.rootGroup.name = 'ArenaSceneRoot';
    this.monumentsGroup.name = 'ArenaMonuments';
    this.plinthsGroup.name = 'ArenaMonumentPlinths';
    this.colossiGroup.name = 'ArenaColossi';

    this.scene.add(this.rootGroup);

    // 1. Mirror-Reflective Obsidian Temple Floor
    this.groundReflector = reflector({
      resolutionScale: 0.75,
      bounces: false,
      generateMipmaps: true,
      samples: 4,
    });
    this.installReflectorShadowDeduplication();
    this.floorMesh = this.buildMirrorFloor();
    this.rootGroup.add(this.floorMesh);

    // 2. Outer Temple Dais Rim & Outer Stone Terrace (R = 26.0m..43.0m, strictly below y = 0)
    this.buildOuterDaisRim();
    this.rootGroup.add(this.plinthsGroup);

    // 3. Perimeter Temple Monuments (R >= 29.0m) reflected in the Obsidian Water-Mirror Floor
    const hasJinshanHall = false;
    this.rootGroup.add(this.monumentsGroup);
    this.buildPerimeterMonuments(hasJinshanHall);
    this.buildMonumentPlinths();
    setObjectLayerRecursive(this.plinthsGroup, LAYER_MAIN_ONLY);

    // 4. Distant Colossal Wonders (R = 45m..110m)
    this.rootGroup.add(this.colossiGroup);
    this.buildDistantColossi(hasJinshanHall);
  }

  public configureReflectorLayers(camera: THREE.Camera): void {
    const virtualCamera = this.groundReflector?.reflector?.getVirtualCamera?.(camera);
    if (virtualCamera) {
      virtualCamera.layers.set(LAYER_DEFAULT);
      this.configuredReflectorCameras.add(camera);
    }
  }

  private installReflectorShadowDeduplication(): void {
    const reflectorBase = this.groundReflector?.reflector as unknown as
      | { updateBefore?: (frame: unknown) => unknown }
      | undefined;
    if (!reflectorBase || typeof reflectorBase.updateBefore !== 'function') {
      return;
    }
    const origUpdateBefore = reflectorBase.updateBefore.bind(reflectorBase);
    reflectorBase.updateBefore = (frame: unknown): unknown => {
      const frameObj = frame as { camera?: THREE.Camera } | null | undefined;
      if (frameObj?.camera && !this.configuredReflectorCameras.has(frameObj.camera)) {
        this.configureReflectorLayers(frameObj.camera);
      }
      this.atmosphere?.setShadowAutoUpdate(false);
      try {
        return origUpdateBefore(frame);
      } finally {
        this.atmosphere?.setShadowAutoUpdate(true);
      }
    };
  }

  private buildMirrorFloor(): THREE.Mesh {
    const floorGeom = new THREE.CircleGeometry(FLOOR_GEOMETRY_RADIUS, 96);
    this.ownedGeometries.push(floorGeom);

    const worldXZ = uv().sub(0.5).mul(FLOOR_GEOMETRY_RADIUS * 2.0);
    const r = length(worldXZ);
    const theta = atan(worldXZ.y, worldXZ.x);

    // Shallow-water surface ripples modulating both reflector UV and roughness
    const ripple1 = sin(
      r.mul(3.2).sub(this.uTime.mul(2.1)).add(sin(theta.mul(6.0)).mul(0.35)),
    );
    const ripple2 = cos(worldXZ.x.mul(1.6).add(this.uTime.mul(1.2))).mul(
      sin(worldXZ.y.mul(1.8).sub(this.uTime.mul(1.1))),
    );
    const rippleOffset = vec2(ripple1, ripple2)
      .mul(0.0022)
      .mul(smoothstep(FLOOR_GEOMETRY_RADIUS, 2.5, r));

    // CRITICAL: Preserve screenUV.flipX() on ReflectorNode UV
    this.groundReflector.uvNode = screenUV.flipX().add(rippleOffset);

    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      3.2,
    );
    const reflectWeight = mix(float(0.42), float(0.88), fresnel);

    // Screen-space derivative widths for crisp, stair-step-free procedural lines
    const rFw = max(fwidth(r), float(0.002));
    const sectorFw = length(fwidth(worldXZ))
      .div(max(r, float(0.25)))
      .mul(8.0 / (Math.PI * 2))
      .max(float(0.0005));
    const ringSeamFw = max(rFw.mul(0.25), float(0.001));

    // Obsidian stone tile seams
    const ringSeam = smoothstep(
      float(0.025).add(ringSeamFw),
      max(float(0.0), float(0.025).sub(ringSeamFw)),
      abs(fract(r.mul(0.25)).sub(0.5)),
    );
    const radialSeam = smoothstep(
      float(0.012).add(sectorFw),
      max(float(0.0), float(0.012).sub(sectorFw)),
      abs(fract(theta.mul(8.0 / (Math.PI * 2))).sub(0.5)),
    );
    const seamMask = saturate(ringSeam.add(radialSeam)).mul(
      smoothstep(2.0, 5.0, r),
    );

    const floorMat = new MeshStandardNodeMaterial({
      metalness: 0.28,
    });
    floorMat.envNode = color(0x050810);
    this.ownedMaterials.push(floorMat);

    floorMat.colorNode = mix(color(0x090c13), color(0x030407), seamMask.mul(0.75));
    floorMat.roughnessNode = mix(
      float(0.26),
      float(0.38),
      ripple1.mul(0.5).add(0.5),
    );

    // Bagua & Concentric Temple Rune Rings (r = 6.5, 14.0, 21.5, 25.0)
    const ringBand = (radiusVal: number, halfWidth: number) =>
      smoothstep(
        float(halfWidth).add(rFw),
        max(float(0.0), float(halfWidth).sub(rFw)),
        abs(r.sub(radiusVal)),
      );

    const ringInner = ringBand(6.5, 0.085);
    const ringMid = ringBand(14.0, 0.105);
    const ringOuter = ringBand(21.5, 0.115);
    const ringPerimeter = ringBand(25.0, 0.17);

    const sectorPhase = abs(fract(theta.mul(8.0 / (Math.PI * 2))).sub(0.5));
    const spokeMask = smoothstep(
      float(0.024).add(sectorFw),
      max(float(0.0), float(0.024).sub(sectorFw)),
      sectorPhase,
    )
      .mul(smoothstep(6.5, 7.2, r))
      .mul(smoothstep(14.0, 13.3, r));
    const trigramFw = max(rFw.mul(1.25), float(0.004));
    const trigramBars = smoothstep(
      float(0.18).add(trigramFw),
      max(float(0.0), float(0.18).sub(trigramFw)),
      abs(fract(r.mul(1.25)).sub(0.5)),
    )
      .mul(smoothstep(8.5, 8.9, r))
      .mul(smoothstep(12.8, 12.4, r))
      .mul(
        smoothstep(
          float(0.08).sub(sectorFw),
          float(0.08).add(sectorFw),
          sectorPhase,
        ),
      )
      .mul(
        smoothstep(
          float(0.42).add(sectorFw),
          float(0.42).sub(sectorFw),
          sectorPhase,
        ),
      );

    const runeMask = saturate(
      ringInner
        .add(ringMid)
        .add(ringOuter)
        .add(ringPerimeter)
        .add(spokeMask.mul(0.7))
        .add(trigramBars.mul(0.85)),
    );

    const runeTint = mix(
      color(0xd4af37),
      color(0xff4228),
      this.uPhaseIntensity.mul(0.68),
    );
    const runePulse = float(0.85)
      .add(this.uPhaseIntensity.mul(1.15))
      .add(
        sin(
          this.uTime
            .mul(mix(1.6, 4.2, this.uPhaseIntensity))
            .sub(r.mul(0.35)),
        ).mul(0.18),
      );

    floorMat.emissiveNode = this.groundReflector.rgb
      .mul(reflectWeight.mul(0.68))
      .add(runeTint.mul(runeMask).mul(runePulse).mul(0.95));

    const floorMesh = new THREE.Mesh(floorGeom, floorMat);
    floorMesh.name = 'ArenaMirrorFloor';
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    floorMesh.add(this.groundReflector.target);

    return floorMesh;
  }

  private buildOuterDaisRim(): void {
    const daisGroup = new THREE.Group();
    daisGroup.name = 'OuterTempleDais';

    const daisBodyGeom = new THREE.CylinderGeometry(28.8, 29.6, 1.4, 64);
    const daisTrimGeom = new THREE.RingGeometry(25.95, 28.75, 96);

    // Solid outer stone terrace ring supporting all perimeter monuments (R = 28.5m..43.0m)
    const outerTerraceShape = new THREE.Shape();
    outerTerraceShape.absarc(0, 0, 43.0, 0, Math.PI * 2, false);
    const terraceInnerHole = new THREE.Path();
    terraceInnerHole.absarc(0, 0, 28.5, 0, Math.PI * 2, true);
    outerTerraceShape.holes.push(terraceInnerHole);

    const outerTerraceGeom = new THREE.ExtrudeGeometry(outerTerraceShape, {
      depth: 1.5,
      bevelEnabled: false,
      curveSegments: 72,
    });
    const terraceInnerTrimGeom = new THREE.RingGeometry(28.5, 28.9, 96);
    const terraceOuterTrimGeom = new THREE.RingGeometry(42.25, 43.0, 96);

    this.ownedGeometries.push(
      daisBodyGeom,
      daisTrimGeom,
      outerTerraceGeom,
      terraceInnerTrimGeom,
      terraceOuterTrimGeom,
    );

    const daisBodyMat = new MeshStandardNodeMaterial({
      color: 0x10121a,
      metalness: 0.35,
      roughness: 0.68,
    });
    const daisTrimMat = new MeshStandardNodeMaterial({
      color: 0x3b2c15,
      metalness: 0.78,
      roughness: 0.38,
    });
    daisTrimMat.emissiveNode = mix(
      color(0x1f1606),
      color(0x521208),
      this.uPhaseIntensity,
    ).mul(0.55);

    this.daisBodyMat = daisBodyMat;
    this.daisTrimMat = daisTrimMat;
    this.ownedMaterials.push(daisBodyMat, daisTrimMat);

    const daisBody = new THREE.Mesh(daisBodyGeom, daisBodyMat);
    daisBody.name = 'OuterTempleDaisBody';
    daisBody.position.y = -0.73;
    daisBody.receiveShadow = true;

    const daisTrim = new THREE.Mesh(daisTrimGeom, daisTrimMat);
    daisTrim.name = 'OuterTempleDaisTrim';
    daisTrim.rotation.x = -Math.PI / 2;
    daisTrim.position.y = -0.025;
    daisTrim.receiveShadow = true;

    const outerTerrace = new THREE.Mesh(outerTerraceGeom, daisBodyMat);
    outerTerrace.name = 'OuterTempleTerrace';
    outerTerrace.rotation.x = -Math.PI / 2;
    outerTerrace.position.y = -1.53;
    outerTerrace.receiveShadow = true;

    const terraceInnerTrim = new THREE.Mesh(terraceInnerTrimGeom, daisTrimMat);
    terraceInnerTrim.name = 'OuterTerraceInnerTrim';
    terraceInnerTrim.rotation.x = -Math.PI / 2;
    terraceInnerTrim.position.y = -0.026;
    terraceInnerTrim.receiveShadow = true;

    const terraceOuterTrim = new THREE.Mesh(terraceOuterTrimGeom, daisTrimMat);
    terraceOuterTrim.name = 'OuterTerraceOuterTrim';
    terraceOuterTrim.rotation.x = -Math.PI / 2;
    terraceOuterTrim.position.y = -0.026;
    terraceOuterTrim.receiveShadow = true;

    daisGroup.add(
      daisBody,
      daisTrim,
      outerTerrace,
      terraceInnerTrim,
      terraceOuterTrim,
    );
    setObjectLayerRecursive(daisGroup, LAYER_MAIN_ONLY);
    this.rootGroup.add(daisGroup);
  }

  private createDarkMythMaterial(originalName: string): MeshStandardNodeMaterial {
    const lower = originalName.toLowerCase();

    if (lower.includes('trim')) {
      const mat = new MeshStandardNodeMaterial({
        color: 0x8e6b28,
        metalness: 0.82,
        roughness: 0.34,
      });
      mat.emissiveNode = mix(
        color(0x1a1104),
        color(0x4d1408),
        this.uPhaseIntensity,
      ).mul(0.5);
      this.ownedMaterials.push(mat);
      return mat;
    }

    if (lower.includes('boson') || lower.includes('green') || lower.includes('jade')) {
      const mat = new MeshStandardNodeMaterial({
        color: 0x265c4f,
        metalness: 0.45,
        roughness: 0.35,
      });
      mat.emissiveNode = mix(
        color(0x38d9a9),
        color(0xff6633),
        this.uPhaseIntensity,
      ).mul(0.85);
      this.ownedMaterials.push(mat);
      return mat;
    }

    const mat = new MeshStandardNodeMaterial({
      color: 0x171922,
      metalness: 0.25,
      roughness: 0.72,
    });
    mat.emissiveNode = mix(
      color(0x04060d),
      color(0x280808),
      this.uPhaseIntensity,
    ).mul(0.45);
    this.ownedMaterials.push(mat);
    return mat;
  }

  private applyDarkMythMonumentMaterial(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      if (!child.geometry.attributes.uv && child.geometry.attributes.position) {
        child.geometry.setAttribute(
          'uv',
          new THREE.BufferAttribute(
            new Float32Array(child.geometry.attributes.position.count * 2),
            2,
          ),
        );
      }
      child.castShadow = false;
      child.receiveShadow = true;

      if (Array.isArray(child.material)) {
        child.material = child.material.map((m) =>
          this.createDarkMythMaterial(m?.name ?? ''),
        );
      } else {
        child.material = this.createDarkMythMaterial(child.material?.name ?? '');
      }
    });
  }

  private tryCloneMonument(key: string): THREE.Object3D | null {
    if (!this.assetLoader) {
      return null;
    }
    const bundle = this.assetLoader.getBundle();
    if (!bundle.glbs.has(key)) {
      return null;
    }
    return this.assetLoader.cloneModel(key);
  }

  private buildMonumentPlinths(): void {
    const specs: PlinthFootprintSpec[] = [];

    for (const obj of this.monumentsGroup.children) {
      obj.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) {
        continue;
      }

      const cx = (box.min.x + box.max.x) * 0.5;
      const cz = (box.min.z + box.max.z) * 0.5;
      const halfX = (box.max.x - box.min.x) * 0.5;
      const halfZ = (box.max.z - box.min.z) * 0.5;

      const minHalf = Math.max(0.1, Math.min(halfX, halfZ));
      const maxHalf = Math.max(halfX, halfZ);
      let rx: number;
      let rz: number;
      if (maxHalf / minHalf > 2.0) {
        rx = Math.max(0.55, halfX * 0.95 + 0.25);
        rz = Math.max(0.55, halfZ * 0.92 + 0.25);
      } else {
        const r = Math.max(1.25, maxHalf * 0.92 + 0.35);
        rx = r;
        rz = r;
      }

      const spec: PlinthFootprintSpec = {
        name: obj.name || 'Monument',
        cx,
        cz,
        rx,
        rz,
      };
      clampPlinthToTerrace(spec);
      specs.push(spec);
    }

    if (specs.length === 0) {
      return;
    }

    // Iteratively shrink colliding plinth pairs so zero plinths overlap in XZ
    const halfGap = PLINTH_CLEARANCE_GAP * 0.5;
    for (let iter = 0; iter < 80; iter += 1) {
      let anyOverlap = false;
      for (let i = 0; i < specs.length; i += 1) {
        for (let j = i + 1; j < specs.length; j += 1) {
          const a = specs[i]!;
          const b = specs[j]!;
          if (!plinthsOverlapXZ(a, b, halfGap)) {
            continue;
          }
          anyOverlap = true;

          const dx = Math.abs(a.cx - b.cx);
          const dz = Math.abs(a.cz - b.cz);
          const normX = a.rx + b.rx > 0 ? dx / (a.rx + b.rx) : 0;
          const normZ = a.rz + b.rz > 0 ? dz / (a.rz + b.rz) : 0;

          if (normX > normZ * 1.35) {
            a.rx = Math.max(PLINTH_MIN_RADIUS, a.rx * 0.94);
            b.rx = Math.max(PLINTH_MIN_RADIUS, b.rx * 0.94);
          } else if (normZ > normX * 1.35) {
            a.rz = Math.max(PLINTH_MIN_RADIUS, a.rz * 0.94);
            b.rz = Math.max(PLINTH_MIN_RADIUS, b.rz * 0.94);
          } else {
            const sizeA = Math.max(a.rx, a.rz);
            const sizeB = Math.max(b.rx, b.rz);
            if (sizeA > sizeB * 1.1) {
              a.rx = Math.max(PLINTH_MIN_RADIUS, a.rx * 0.94);
              a.rz = Math.max(PLINTH_MIN_RADIUS, a.rz * 0.94);
            } else if (sizeB > sizeA * 1.1) {
              b.rx = Math.max(PLINTH_MIN_RADIUS, b.rx * 0.94);
              b.rz = Math.max(PLINTH_MIN_RADIUS, b.rz * 0.94);
            } else {
              a.rx = Math.max(PLINTH_MIN_RADIUS, a.rx * 0.95);
              a.rz = Math.max(PLINTH_MIN_RADIUS, a.rz * 0.95);
              b.rx = Math.max(PLINTH_MIN_RADIUS, b.rx * 0.95);
              b.rz = Math.max(PLINTH_MIN_RADIUS, b.rz * 0.95);
            }
          }
        }
      }
      if (!anyOverlap) {
        break;
      }
    }

    if (!this.plinthBodyGeom) {
      this.plinthBodyGeom = new THREE.CylinderGeometry(1, 1.15, 0.44, 8);
      this.plinthTrimGeom = new THREE.CylinderGeometry(1.03, 1.07, 0.05, 8);
      this.ownedGeometries.push(this.plinthBodyGeom, this.plinthTrimGeom);
    }

    const placed: Array<{ spec: PlinthFootprintSpec; yOffset: number }> = [];
    for (const spec of specs) {
      clampPlinthToTerrace(spec);

      // Defensive non-coplanar vertical offset if any two synthetic centers coincide
      let layer = 0;
      while (
        layer < 2 &&
        placed.some(
          (prev) =>
            prev.yOffset === layer * -0.0015 &&
            plinthsOverlapXZ(prev.spec, spec, 0.005),
        )
      ) {
        layer += 1;
      }
      const yOffset = layer * -0.0015;
      placed.push({ spec, yOffset });

      // Default plinthBody top = -0.025 (height 0.44 -> center y = -0.245),
      // plinthTrim top = -0.028 (height 0.05 -> center y = -0.053),
      // keeping both strictly distinct from OuterTempleTerrace (-0.030) and trims (-0.026).
      const plinth = new THREE.Mesh(this.plinthBodyGeom, this.daisBodyMat);
      plinth.name = `${spec.name}_Plinth`;
      plinth.position.set(spec.cx, -0.245 + yOffset, spec.cz);
      plinth.scale.set(spec.rx, 1, spec.rz);
      plinth.receiveShadow = true;

      const trim = new THREE.Mesh(this.plinthTrimGeom!, this.daisTrimMat);
      trim.name = `${spec.name}_PlinthTrim`;
      trim.position.set(spec.cx, -0.053 + yOffset, spec.cz);
      trim.scale.set(spec.rx, 1, spec.rz);
      trim.receiveShadow = true;

      this.plinthsGroup.add(plinth, trim);
    }
  }

  private placePerimeterMonument(
    key: string,
    name: string,
    x: number,
    z: number,
    scale: number,
    lookAtCenter: boolean,
    extraRotY = 0,
    tiltX = 0,
    tiltZ = 0,
    groundY = -0.03,
    mainOnly = false,
  ): void {
    const obj = this.tryCloneMonument(key);
    if (!obj) {
      return;
    }
    obj.name = name;
    this.applyDarkMythMonumentMaterial(obj);
    obj.scale.setScalar(scale);
    obj.position.set(x, 0, z);
    if (lookAtCenter) {
      obj.lookAt(0, 0, 0);
    }
    obj.rotation.y += extraRotY;
    obj.rotation.x += tiltX;
    obj.rotation.z += tiltZ;

    groundObjectToY(obj, groundY);
    enforceRadialClearance(obj, MIN_MONUMENT_CLEARANCE_RADIUS);
    groundObjectToY(obj, groundY);

    if (mainOnly) {
      setObjectLayerRecursive(obj, LAYER_MAIN_ONLY);
    }

    this.monumentsGroup.add(obj);
  }

  private buildPerimeterMonuments(hasJinshanHall = false): void {
    if (hasJinshanHall) {
      // With Jinshan Mahavira Hall active, skip low-poly placeholder gates/pillars
      // and retain only flanking guardian dragon statues outside R >= 36.5m.
      const dragonOffsets = [-38, 38];
      dragonOffsets.forEach((degOffset, idx) => {
        const rad = -Math.PI * 0.5 + (degOffset * Math.PI) / 180;
        const rx = Math.cos(rad) * 36.5;
        const rz = Math.sin(rad) * 36.5;
        const tangentYaw =
          rad + (degOffset < 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
        this.placePerimeterMonument(
          'env_dragon_statue',
          `PerimeterDragonStatue_${idx}`,
          rx,
          rz,
          0.34,
          false,
          tangentYaw,
        );
      });
      return;
    }

    // 1. 4 Cardinal Arch Banners at R = 31.8m
    const cardinalAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
    cardinalAngles.forEach((angle, idx) => {
      this.placePerimeterMonument(
        'env_arch_banner',
        `PerimeterArchBanner_${idx}`,
        Math.cos(angle) * 31.8,
        Math.sin(angle) * 31.8,
        1.45,
        true,
      );
    });

    // 2. Main Altar at North (0, 0, -35.5)
    this.placePerimeterMonument(
      'env_main_altar',
      'PerimeterMainAltar',
      0,
      -35.5,
      1.8,
      true,
    );

    // 3. 2 Temple Bell Structures at East/West (±33.5, 0, 0)
    this.placePerimeterMonument(
      'env_bell_structure',
      'PerimeterBell_East',
      33.5,
      0,
      1.45,
      true,
    );
    this.placePerimeterMonument(
      'env_bell_structure',
      'PerimeterBell_West',
      -33.5,
      0,
      1.45,
      true,
    );

    // 4. 12 Perimeter Columns at R = 30.8m avoiding cardinal gate axes
    const columnAnglesDeg = [
      15, 45, 75, 105, 135, 165, -15, -45, -75, -105, -135, -165,
    ];
    columnAnglesDeg.forEach((deg, idx) => {
      const rad = (deg * Math.PI) / 180;
      this.placePerimeterMonument(
        'env_column',
        `PerimeterColumn_${idx}`,
        Math.cos(rad) * 30.8,
        Math.sin(rad) * 30.8,
        1.55,
        true,
        0,
        0,
        0,
        -0.03,
        true,
      );
    });

    // 5. 6 Broken Columns scattered at R = 34m..38m
    const brokenSpecs = [
      { deg: 28, r: 34.8, tx: 0.16, tz: -0.14 },
      { deg: 62, r: 36.2, tx: -0.22, tz: 0.18 },
      { deg: 118, r: 35.4, tx: 0.25, tz: 0.12 },
      { deg: 152, r: 37.5, tx: -0.18, tz: -0.24 },
      { deg: -28, r: 35.1, tx: 0.19, tz: 0.21 },
      { deg: -152, r: 37.0, tx: -0.28, tz: 0.15 },
    ];
    brokenSpecs.forEach((spec, idx) => {
      const rad = (spec.deg * Math.PI) / 180;
      this.placePerimeterMonument(
        'env_column_broken',
        `PerimeterBrokenColumn_${idx}`,
        Math.cos(rad) * spec.r,
        Math.sin(rad) * spec.r,
        2.8,
        false,
        rad,
        spec.tx,
        spec.tz,
        -0.14,
        true,
      );
    });

    // 6. 2 Perimeter Dragon Statues flanking North Altar (scale = 0.34 at R = 36.5m)
    const dragonOffsets = [-38, 38];
    dragonOffsets.forEach((degOffset, idx) => {
      const rad = -Math.PI * 0.5 + (degOffset * Math.PI) / 180;
      const rx = Math.cos(rad) * 36.5;
      const rz = Math.sin(rad) * 36.5;
      const tangentYaw = rad + (degOffset < 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
      this.placePerimeterMonument(
        'env_dragon_statue',
        `PerimeterDragonStatue_${idx}`,
        rx,
        rz,
        0.34,
        false,
        tangentYaw,
      );
    });
  }

  private buildDistantColossi(hasJinshanHall = false): void {
    // Shared materials for procedural megastructures
    const monolithMat = new MeshStandardNodeMaterial({
      color: 0x11131b,
      metalness: 0.35,
      roughness: 0.65,
    });
    const runeVeinMat = new MeshStandardNodeMaterial({
      color: 0x8a6d28,
      metalness: 0.8,
      roughness: 0.25,
    });
    const pulse = float(0.8).add(
      sin(this.uTime.mul(1.8).add(this.uPhaseIntensity.mul(2.0))).mul(0.25),
    );
    runeVeinMat.emissiveNode = mix(
      color(0xc89b32),
      color(0xff3d24),
      this.uPhaseIntensity,
    )
      .mul(pulse)
      .mul(1.25);

    const bladeSteelMat = new MeshStandardNodeMaterial({
      color: 0x1b1f2a,
      metalness: 0.85,
      roughness: 0.28,
    });

    const ringMat = new MeshStandardNodeMaterial({
      color: 0x705622,
      metalness: 0.85,
      roughness: 0.3,
    });
    ringMat.emissiveNode = mix(
      color(0xd4af37),
      color(0xff4726),
      this.uPhaseIntensity,
    ).mul(1.1);

    this.ownedMaterials.push(monolithMat, runeVeinMat, bladeSteelMat, ringMat);

    if (!hasJinshanHall) {
      // 1. 6 Colossal Obsidian Monolith Spires (R = 56m..98m)
      const spireGeom = new THREE.CylinderGeometry(2.2, 4.8, 72, 6);
      const veinGeom = new THREE.BoxGeometry(0.45, 54, 5.1);
      this.ownedGeometries.push(spireGeom, veinGeom);

      const spireCoords = [
        { angle: -1.9, r: 64, y: 4, scaleY: 1.05 },
        { angle: -1.25, r: 82, y: 8, scaleY: 1.2 },
        { angle: -0.65, r: 60, y: 2, scaleY: 0.95 },
        { angle: 0.55, r: 74, y: 0, scaleY: 1.0 },
        { angle: 1.65, r: 92, y: 5, scaleY: 1.15 },
        { angle: 2.55, r: 68, y: 1, scaleY: 0.98 },
      ];

      spireCoords.forEach((spec, idx) => {
        const spireGroup = new THREE.Group();
        spireGroup.name = `ColossalMonolith_${idx}`;
        spireGroup.position.set(
          Math.cos(spec.angle) * spec.r,
          spec.y,
          Math.sin(spec.angle) * spec.r,
        );
        spireGroup.lookAt(0, spec.y, 0);

        const shaft = new THREE.Mesh(spireGeom, monolithMat);
        shaft.scale.y = spec.scaleY;
        spireGroup.add(shaft);

        const vein = new THREE.Mesh(veinGeom, runeVeinMat);
        vein.position.y = 4;
        spireGroup.add(vein);

        this.colossiGroup.add(spireGroup);
      });

      // 2. 3 Giant Broken Celestial Blades embedded in the abyss (R = 62m..95m)
      const bladeGeom = new THREE.CylinderGeometry(0.18, 2.4, 48, 4);
      const guardGeom = new THREE.BoxGeometry(10.5, 1.4, 2.2);
      const hiltGeom = new THREE.CylinderGeometry(0.55, 0.7, 10, 8);
      this.ownedGeometries.push(bladeGeom, guardGeom, hiltGeom);

      const bladeSpecs = [
        { angle: -2.25, r: 68, tiltX: 0.34, tiltZ: -0.42 },
        { angle: -0.88, r: 88, tiltX: -0.28, tiltZ: 0.36 },
        { angle: 1.15, r: 76, tiltX: 0.32, tiltZ: 0.45 },
      ];

      bladeSpecs.forEach((spec, idx) => {
        const bladeGroup = new THREE.Group();
        bladeGroup.name = `ColossalCelestialBlade_${idx}`;
        bladeGroup.position.set(
          Math.cos(spec.angle) * spec.r,
          4,
          Math.sin(spec.angle) * spec.r,
        );
        bladeGroup.rotation.set(spec.tiltX, spec.angle, spec.tiltZ);

        const blade = new THREE.Mesh(bladeGeom, bladeSteelMat);
        blade.rotation.x = Math.PI; // Tip buried downward into the abyss
        bladeGroup.add(blade);

        const guard = new THREE.Mesh(guardGeom, runeVeinMat);
        guard.position.y = 24;
        bladeGroup.add(guard);

        const hilt = new THREE.Mesh(hiltGeom, monolithMat);
        hilt.position.y = 29;
        bladeGroup.add(hilt);

        this.colossiGroup.add(bladeGroup);
      });

      // 3. Colossal GLB Guardians & Gate Ruins (if AssetLoader loaded them)
      const colossalDragons = [
        { angle: -Math.PI * 0.5 - 0.58, r: 82 },
        { angle: -Math.PI * 0.5 + 0.58, r: 82 },
      ];
      colossalDragons.forEach((spec, idx) => {
        const dragon = this.tryCloneMonument('env_dragon_statue');
        if (!dragon) {
          return;
        }
        dragon.name = `ColossalDragon_${idx}`;
        this.applyDarkMythMonumentMaterial(dragon);
        dragon.scale.setScalar(1.35);
        dragon.position.set(
          Math.cos(spec.angle) * spec.r,
          6,
          Math.sin(spec.angle) * spec.r,
        );
        dragon.lookAt(0, 6, 0);
        enforceRadialClearance(dragon, 45.0);
        setObjectLayerRecursive(dragon, LAYER_MAIN_ONLY);
        this.colossiGroup.add(dragon);
      });

      const colossalGates = [
        { angle: -Math.PI * 0.5 - 0.25, r: 58 },
        { angle: -Math.PI * 0.5 + 0.25, r: 58 },
      ];
      colossalGates.forEach((spec, idx) => {
        const gate = this.tryCloneMonument('env_arch_banner');
        if (!gate) {
          return;
        }
        gate.name = `ColossalGateRuin_${idx}`;
        this.applyDarkMythMonumentMaterial(gate);
        gate.scale.setScalar(3.2);
        gate.position.set(
          Math.cos(spec.angle) * spec.r,
          -2,
          Math.sin(spec.angle) * spec.r,
        );
        gate.lookAt(0, -2, 0);
        enforceRadialClearance(gate, 45.0);
        setObjectLayerRecursive(gate, LAYER_MAIN_ONLY);
        this.colossiGroup.add(gate);
      });
    }

    // 4. 2 Massive Floating Concentric Celestial Rune Rings (segmented arcs so every mesh Box3 stays at R >= 42m)
    const ringConfigs = [
      {
        name: 'FloatingCelestialRing_Inner',
        radius: 46,
        tube: 0.28,
        y: 24,
        tiltX: Math.PI * 0.5 + 0.22,
        tiltZ: 0.14,
        speed: 0.04,
      },
      {
        name: 'FloatingCelestialRing_Outer',
        radius: 62,
        tube: 0.35,
        y: 32,
        tiltX: Math.PI * 0.5 - 0.18,
        tiltZ: -0.16,
        speed: -0.025,
      },
    ];

    const segmentCount = 12;
    const arcStep = (Math.PI * 2) / segmentCount;
    const arcSpan = arcStep - 0.04;

    for (const cfg of ringConfigs) {
      const segGeom = new THREE.TorusGeometry(cfg.radius, cfg.tube, 8, 16, arcSpan);
      this.ownedGeometries.push(segGeom);

      const tiltWrapper = new THREE.Group();
      tiltWrapper.name = `${cfg.name}_Tilt`;
      tiltWrapper.position.set(0, cfg.y, 0);
      tiltWrapper.rotation.set(cfg.tiltX, 0, cfg.tiltZ);

      const spinPivot = new THREE.Group();
      spinPivot.name = cfg.name;

      for (let s = 0; s < segmentCount; s++) {
        const segMesh = new THREE.Mesh(segGeom, ringMat);
        segMesh.name = `${cfg.name}_Seg_${s}`;
        segMesh.rotation.z = s * arcStep;
        spinPivot.add(segMesh);
      }

      tiltWrapper.add(spinPivot);
      this.colossiGroup.add(tiltWrapper);
      this.floatingRingPivots.push({ group: spinPivot, speed: cfg.speed });
    }
  }

  setPhaseIntensity(t: number): void {
    if (this.disposed) {
      return;
    }
    const clamped = clamp01(t);
    this.phaseIntensity = clamped;
    this.uPhaseIntensity.value = clamped;
    this.atmosphere?.setPhaseIntensity(clamped);
  }

  triggerLightningStrike(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }
    this.atmosphere?.triggerLightningStrike(pos);
  }

  update(dt: number, elapsedSeconds: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    if (Number.isFinite(elapsedSeconds)) {
      this.uTime.value = elapsedSeconds;
    }

    for (const ring of this.floatingRingPivots) {
      ring.group.rotation.z += ring.speed * dt;
    }

    this.atmosphere?.update(dt);
  }

  clampPosition(pos: Vec3Like, margin = 0.6): THREE.Vector3 {
    const clamped = clampArenaPosition(pos, this.arenaRadius, margin);
    return new THREE.Vector3(clamped.x, clamped.y, clamped.z);
  }

  getMonumentClearances(): MonumentClearance[] {
    const clearances: MonumentClearance[] = [];

    for (const child of this.monumentsGroup.children) {
      clearances.push({
        name: child.name || 'PerimeterMonument',
        minCenterDist: Math.hypot(child.position.x, child.position.z),
        minBoxRadius: computeMinBoxRadiusXZ(child),
      });
    }

    for (const child of this.colossiGroup.children) {
      if (child.name.startsWith('FloatingCelestialRing_')) {
        // Check each arc segment individually so the surrounding ring's empty center isn't counted
        child.traverse((descendant) => {
          if (descendant instanceof THREE.Mesh) {
            clearances.push({
              name: descendant.name || child.name,
              minCenterDist: Math.hypot(descendant.position.x, descendant.position.z),
              minBoxRadius: computeMinBoxRadiusXZ(descendant),
            });
          }
        });
      } else {
        clearances.push({
          name: child.name || 'Colossus',
          minCenterDist: Math.hypot(child.position.x, child.position.z),
          minBoxRadius: computeMinBoxRadiusXZ(child),
        });
      }
    }

    return clearances;
  }

  getPhaseIntensity(): number {
    return this.phaseIntensity;
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.uTime.value = 0;
    this.setPhaseIntensity(0);
    this.atmosphere?.reset();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (typeof this.groundReflector.dispose === 'function') {
      this.groundReflector.dispose();
    }

    for (const geom of this.ownedGeometries) {
      geom.dispose();
    }
    this.ownedGeometries.length = 0;

    for (const mat of this.ownedMaterials) {
      mat.dispose();
    }
    this.ownedMaterials.length = 0;

    this.rootGroup.removeFromParent();
  }
}
