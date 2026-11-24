import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, mix, pow, sin, smoothstep, uniform, uv } from 'three/tsl';
import type { SlashColorPreset, Vec3Like } from '../types/game.ts';

const SLASH_POOL_SIZE = 16;
const SLASH_SEGMENTS = 56;
const SLASH_ARC_RAD = (212 * Math.PI) / 180;
const SLASH_DURATION_SECONDS = 0.28;
const MAX_VFX_COORD = 1e6;

function sanitizeCoord(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-MAX_VFX_COORD, Math.min(MAX_VFX_COORD, value));
}

interface SlashPalette {
  readonly core: number;
  readonly trail: number;
}

const SLASH_PALETTES: Record<SlashColorPreset, SlashPalette> = {
  ink_gold: { core: 0xfff7cf, trail: 0xff8418 },
  azure_cyan: { core: 0xeaffff, trail: 0x22c8ff },
  crimson_gold: { core: 0xfff0b5, trail: 0xff2c12 },
  celestial_white: { core: 0xffffff, trail: 0xffd97d },
};

const makeFloatUniform = (v: number) => uniform(v);
const makeColorUniform = (v: THREE.Color) => uniform(v);
type FloatUniform = ReturnType<typeof makeFloatUniform>;
type ColorUniform = ReturnType<typeof makeColorUniform>;

interface SlashSlot {
  readonly mesh: THREE.Mesh;
  readonly material: MeshBasicNodeMaterial;
  readonly uProgress: FloatUniform;
  readonly uCoreColor: ColorUniform;
  readonly uTrailColor: ColorUniform;
  readonly uOpacity: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  spawnOrder: number;
}

function buildCrescentGeometry(): THREE.BufferGeometry {
  const vertexCount = (SLASH_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  const baseInnerRadius = 1.18;
  const maxWidth = 1.48;

  for (let i = 0; i <= SLASH_SEGMENTS; i += 1) {
    const u = i / SLASH_SEGMENTS;
    const theta = (u - 0.5) * SLASH_ARC_RAD;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    const taper = Math.pow(Math.sin(u * Math.PI), 0.72);
    const innerR = baseInnerRadius + (1 - taper) * 0.22;
    const outerR = innerR + maxWidth * taper;

    const innerIdx = i * 2;
    const outerIdx = innerIdx + 1;

    // Crescent oriented forward along +Z in the local XZ plane
    positions[innerIdx * 3] = sinT * innerR;
    positions[innerIdx * 3 + 1] = 0;
    positions[innerIdx * 3 + 2] = cosT * innerR;

    positions[outerIdx * 3] = sinT * outerR;
    positions[outerIdx * 3 + 1] = 0;
    positions[outerIdx * 3 + 2] = cosT * outerR;

    normals[innerIdx * 3] = 0;
    normals[innerIdx * 3 + 1] = 1;
    normals[innerIdx * 3 + 2] = 0;

    normals[outerIdx * 3] = 0;
    normals[outerIdx * 3 + 1] = 1;
    normals[outerIdx * 3 + 2] = 0;

    uvs[innerIdx * 2] = u;
    uvs[innerIdx * 2 + 1] = 0;

    uvs[outerIdx * 2] = u;
    uvs[outerIdx * 2 + 1] = 1;

    if (i < SLASH_SEGMENTS) {
      const a = innerIdx;
      const b = outerIdx;
      const c = innerIdx + 2;
      const d = outerIdx + 2;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export class SlashTrailVfx {
  readonly group = new THREE.Group();
  private readonly sharedGeometry: THREE.BufferGeometry;
  private readonly slots: SlashSlot[] = [];
  private spawnCounter = 0;
  private disposed = false;

  constructor() {
    this.group.name = 'SlashTrailVfxGroup';
    this.sharedGeometry = buildCrescentGeometry();

    for (let i = 0; i < SLASH_POOL_SIZE; i += 1) {
      const uProgress = uniform(0);
      const uCoreColor = uniform(new THREE.Color(SLASH_PALETTES.ink_gold.core));
      const uTrailColor = uniform(new THREE.Color(SLASH_PALETTES.ink_gold.trail));
      const uOpacity = uniform(1);

      const coord = uv();
      const headPos = uProgress.mul(1.28);
      const tailPos = uProgress.mul(1.22).sub(0.38);

      const wipeHead = smoothstep(headPos, headPos.sub(0.16), coord.x);
      const wipeTail = smoothstep(tailPos.sub(0.14), tailPos.add(0.12), coord.x);
      const arcWipe = wipeHead.mul(wipeTail);
      const fadeOut = smoothstep(1.0, 0.72, uProgress);

      const outerGlow = pow(coord.y, 2.2);
      const razorCore = pow(coord.y, 4.5);
      const streak = sin(
        coord.x.mul(28.0).add(coord.y.mul(6.0)).sub(uProgress.mul(10.0)),
      )
        .mul(0.22)
        .add(0.78);

      const bladeColor = mix(uTrailColor, uCoreColor, outerGlow);
      // HDR > 2.4 emissive output drives blazing golden staff bloom and mirror-floor reflection
      const hdrIntensity = float(2.45)
        .add(outerGlow.mul(1.45))
        .add(razorCore.mul(1.85));

      const material = new MeshBasicNodeMaterial({
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      material.colorNode = bladeColor.mul(hdrIntensity).mul(streak);
      material.opacityNode = arcWipe
        .mul(pow(coord.y, 0.65))
        .mul(streak)
        .mul(fadeOut)
        .mul(uOpacity);

      const mesh = new THREE.Mesh(this.sharedGeometry, material);
      mesh.name = `SlashTrail_${i}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.rotation.order = 'YXZ';
      this.group.add(mesh);

      this.slots.push({
        mesh,
        material,
        uProgress,
        uCoreColor,
        uTrailColor,
        uOpacity,
        active: false,
        elapsed: 0,
        duration: SLASH_DURATION_SECONDS,
        spawnOrder: 0,
      });
    }
  }

  spawn(
    origin: Vec3Like,
    dir: Vec3Like,
    angle: number,
    colorPreset: SlashColorPreset,
    scale = 1,
  ): void {
    if (this.disposed) {
      return;
    }

    let slot = this.slots.find((entry) => !entry.active);
    if (!slot) {
      slot = this.slots.reduce((oldest, candidate) =>
        candidate.spawnOrder < oldest.spawnOrder ? candidate : oldest,
      );
    }

    const palette = SLASH_PALETTES[colorPreset] ?? SLASH_PALETTES.ink_gold;
    slot.uCoreColor.value.setHex(palette.core);
    slot.uTrailColor.value.setHex(palette.trail);
    slot.uProgress.value = 0;
    slot.uOpacity.value = 1;

    const ox = sanitizeCoord(origin.x);
    const oy = sanitizeCoord(origin.y);
    const oz = sanitizeCoord(origin.z);

    const dx = Number.isFinite(dir.x) ? dir.x : 0;
    const dz = Number.isFinite(dir.z) ? dir.z : 0;
    const dirMaxAbs = Math.max(Math.abs(dx), Math.abs(dz));
    const rawYaw = dirMaxAbs > 1e-4 ? Math.atan2(dx, dz) : 0;
    const yaw = Number.isFinite(rawYaw) ? rawYaw : 0;
    const safeScale =
      Number.isFinite(scale) && scale > 0
        ? Math.min(MAX_VFX_COORD, scale)
        : 1;
    const safeAngle = Number.isFinite(angle) ? angle : 0;

    slot.mesh.position.set(ox, oy, oz);
    slot.mesh.rotation.set(0, yaw, safeAngle);
    slot.mesh.scale.set(safeScale, safeScale, safeScale);
    slot.mesh.visible = true;

    this.spawnCounter += 1;
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = SLASH_DURATION_SECONDS;
    slot.spawnOrder = this.spawnCounter;
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    for (const slot of this.slots) {
      if (!slot.active) {
        continue;
      }
      slot.elapsed += dt;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      slot.uProgress.value = progress;

      if (slot.elapsed >= slot.duration) {
        slot.active = false;
        slot.mesh.visible = false;
      }
    }
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    for (const slot of this.slots) {
      slot.active = false;
      slot.elapsed = 0;
      slot.uProgress.value = 0;
      slot.mesh.visible = false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.reset();
    this.disposed = true;
    this.sharedGeometry.dispose();
    for (const slot of this.slots) {
      slot.material.dispose();
    }
    this.group.clear();
  }

  getActiveCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.active) {
        count += 1;
      }
    }
    return count;
  }
}
