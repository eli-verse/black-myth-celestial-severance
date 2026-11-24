import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { NodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AssetLoader } from '../../src/engine/AssetLoader.ts';
import {
  ArenaScene,
  clampArenaPosition,
  groundObjectToY,
} from '../../src/scene/ArenaScene.ts';
import { AtmosphereController } from '../../src/scene/AtmosphereController.ts';
import { COMBAT_TUNING, type SlashColorPreset } from '../../src/types/game.ts';
import { VfxManager } from '../../src/vfx/VfxManager.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '../..');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function assertOnlyNodeMaterials(root: THREE.Object3D): number {
  let checkedCount = 0;
  root.traverse((obj) => {
    const renderable = obj as THREE.Mesh | THREE.Sprite;
    const rawMat = (renderable as { material?: THREE.Material | THREE.Material[] }).material;
    if (!rawMat) {
      return;
    }
    const materials = Array.isArray(rawMat) ? rawMat : [rawMat];
    for (const mat of materials) {
      checkedCount += 1;
      expect(
        mat instanceof THREE.ShaderMaterial,
        `${obj.name || obj.type} must not use ShaderMaterial`,
      ).toBe(false);
      expect(
        mat instanceof THREE.RawShaderMaterial,
        `${obj.name || obj.type} must not use RawShaderMaterial`,
      ).toBe(false);
      expect(
        mat instanceof NodeMaterial ||
          (mat as { isNodeMaterial?: boolean }).isNodeMaterial === true,
        `${obj.name || obj.type} material (${mat.type}) must be a TSL NodeMaterial`,
      ).toBe(true);
    }
  });
  return checkedCount;
}

describe('Zero ShaderMaterial / RawShaderMaterial Gate', () => {
  it('has zero ShaderMaterial or RawShaderMaterial references across src/scene and src/vfx', () => {
    const sceneFiles = collectTsFiles(path.join(PROJECT_ROOT, 'src/scene'));
    const vfxFiles = collectTsFiles(path.join(PROJECT_ROOT, 'src/vfx'));
    const allFiles = [...sceneFiles, ...vfxFiles];

    expect(allFiles.length).toBeGreaterThanOrEqual(6);

    for (const filePath of allFiles) {
      const source = readFileSync(filePath, 'utf8');
      expect(
        /\b(Raw)?ShaderMaterial\b/.test(source),
        `Forbidden ShaderMaterial reference found in ${filePath}`,
      ).toBe(false);
    }
  });

  it('uses only NodeMaterial instances across AtmosphereController, ArenaScene, and VfxManager', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });
    const arena = new ArenaScene({ scene, atmosphere });
    const vfx = new VfxManager(scene);

    const totalMaterials =
      assertOnlyNodeMaterials(atmosphere.rootGroup) +
      assertOnlyNodeMaterials(arena.rootGroup) +
      assertOnlyNodeMaterials(vfx.rootGroup);

    expect(totalMaterials).toBeGreaterThan(20);

    vfx.dispose();
    arena.dispose();
    atmosphere.dispose();
  });
});

describe('ArenaScene', () => {
  it('creates CircleGeometry(26, 96) mirror floor rotated -PI/2 with reflector target attached', () => {
    const scene = new THREE.Scene();
    const arena = new ArenaScene({ scene });

    expect(arena.arenaRadius).toBe(25.0);
    expect(arena.arenaRadius).toBe(COMBAT_TUNING.arenaRadius);
    expect(arena.floorMesh.geometry).toBeInstanceOf(THREE.CircleGeometry);

    const circleGeom = arena.floorMesh.geometry as THREE.CircleGeometry;
    expect(circleGeom.parameters.radius).toBe(26);
    expect(circleGeom.parameters.segments).toBe(96);
    expect(arena.floorMesh.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect(arena.floorMesh.children).toContain(arena.groundReflector.target);

    arena.dispose();
  });

  it('clamps outside vectors to <= arenaRadius - margin while preserving inside vectors', () => {
    const inside = clampArenaPosition({ x: 3, y: 1.5, z: -4 });
    expect(inside).toEqual({ x: 3, y: 1.5, z: -4 });

    const outside = clampArenaPosition({ x: 40, y: 2.2, z: -30 }, 25.0, 0.6);
    expect(Math.hypot(outside.x, outside.z)).toBeCloseTo(24.4, 5);
    expect(outside.y).toBe(2.2);

    const scene = new THREE.Scene();
    const arena = new ArenaScene({ scene });
    const clampedVec = arena.clampPosition({ x: 0, y: 0.5, z: 30 }, 1.0);
    expect(clampedVec.x).toBeCloseTo(0, 6);
    expect(clampedVec.y).toBe(0.5);
    expect(clampedVec.z).toBeCloseTo(24.0, 5);

    arena.dispose();
  });

  it('clamps setPhaseIntensity to [0, 1]', () => {
    const scene = new THREE.Scene();
    const arena = new ArenaScene({ scene });

    arena.setPhaseIntensity(-0.75);
    expect(arena.getPhaseIntensity()).toBe(0);

    arena.setPhaseIntensity(2.5);
    expect(arena.getPhaseIntensity()).toBe(1);

    arena.setPhaseIntensity(Number.NaN);
    expect(arena.getPhaseIntensity()).toBe(0);

    arena.setPhaseIntensity(0.65);
    expect(arena.getPhaseIntensity()).toBeCloseTo(0.65, 6);

    arena.dispose();
  });

  it('keeps all non-floor monument and colossi bounding boxes outside R < 29.0m', () => {
    const scene = new THREE.Scene();
    const arena = new ArenaScene({ scene });

    const initialClearances = arena.getMonumentClearances();
    expect(initialClearances.length).toBeGreaterThan(0);
    for (const entry of initialClearances) {
      expect(
        entry.minBoxRadius,
        `${entry.name} intruded into playable arena`,
      ).toBeGreaterThanOrEqual(29.0);
    }

    arena.update(5.0, 5.0);
    const updatedClearances = arena.getMonumentClearances();
    for (const entry of updatedClearances) {
      expect(
        entry.minBoxRadius,
        `${entry.name} intruded after update()`,
      ).toBeGreaterThanOrEqual(29.0);
    }

    arena.dispose();
  });

  it('resets and disposes cleanly', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });
    const arena = new ArenaScene({ scene, atmosphere });

    expect(scene.children).toContain(arena.rootGroup);
    arena.setPhaseIntensity(0.9);
    expect(arena.getPhaseIntensity()).toBeCloseTo(0.9, 6);

    arena.reset();
    expect(arena.getPhaseIntensity()).toBe(0);
    expect(atmosphere.getPhaseIntensity()).toBe(0);

    arena.dispose();
    expect(scene.children).not.toContain(arena.rootGroup);
    // Idempotent second dispose
    expect(() => arena.dispose()).not.toThrow();

    atmosphere.dispose();
  });

  it('sanitizes NaN, Infinity, -Infinity, and huge 1e200/1e308 inputs in clampArenaPosition', () => {
    const cases = [
      { x: Number.NaN, y: 0, z: 10 },
      { x: 5, y: 0, z: Number.NaN },
      { x: 5, y: Number.NaN, z: 5 },
      { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
      { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: 12 },
      { x: 1e200, y: 2, z: -1e200 },
      { x: -1e308, y: 1.5, z: 1e308 },
    ];

    for (const input of cases) {
      const out = clampArenaPosition(input);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.y)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
      expect(Math.hypot(out.x, out.z)).toBeLessThanOrEqual(24.4 + 1e-6);
    }

    const hugeDiag = clampArenaPosition({ x: 1e200, y: 3, z: -1e200 });
    expect(Math.hypot(hugeDiag.x, hugeDiag.z)).toBeCloseTo(24.4, 5);
    expect(hugeDiag.y).toBe(3);
  });

  it('grounds tilted meshes by actual transformed vertex minY and spans outer terrace across R = 29..42m below y = -0.02', () => {
    const geom = new THREE.CylinderGeometry(0.6, 0.6, 4.0, 24);
    const mat = new THREE.MeshBasicMaterial();
    const tilted = new THREE.Mesh(geom, mat);
    tilted.position.set(35, 5, 0);
    tilted.rotation.set(0.28, 0.4, -0.22);

    groundObjectToY(tilted, -0.14);
    tilted.updateWorldMatrix(true, true);

    const posAttr = tilted.geometry.attributes.position!;
    const v = new THREE.Vector3();
    let minVertY = Infinity;
    for (let i = 0; i < posAttr.count; i += 1) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(tilted.matrixWorld);
      if (v.y < minVertY) {
        minVertY = v.y;
      }
    }
    expect(minVertY).toBeCloseTo(-0.14, 5);

    geom.dispose();
    mat.dispose();

    const scene = new THREE.Scene();
    const arena = new ArenaScene({ scene });
    const terrace = arena.rootGroup.getObjectByName('OuterTempleTerrace') as THREE.Mesh | undefined;
    expect(terrace).toBeDefined();

    terrace!.updateWorldMatrix(true, true);
    const terraceBox = new THREE.Box3().setFromObject(terrace!);
    expect(terraceBox.max.y).toBeLessThanOrEqual(-0.025);
    expect(terraceBox.max.y).toBeGreaterThanOrEqual(-0.08);
    expect(terraceBox.min.x).toBeLessThanOrEqual(-42.0);
    expect(terraceBox.max.x).toBeGreaterThanOrEqual(42.0);
    expect(terraceBox.min.z).toBeLessThanOrEqual(-42.0);
    expect(terraceBox.max.z).toBeGreaterThanOrEqual(42.0);

    // Ensure no outer terrace vertex enters the R <= 26m playable floor
    const tPos = terrace!.geometry.attributes.position!;
    let minTerraceVertR = Infinity;
    for (let i = 0; i < tPos.count; i += 1) {
      v.fromBufferAttribute(tPos, i).applyMatrix4(terrace!.matrixWorld);
      const r = Math.hypot(v.x, v.z);
      if (r < minTerraceVertR) {
        minTerraceVertR = r;
      }
    }
    expect(minTerraceVertR).toBeGreaterThanOrEqual(28.0);

    arena.dispose();
  });

  it('ignores setPhaseIntensity, triggerLightningStrike, and reset after ArenaScene.dispose()', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });
    const arena = new ArenaScene({ scene, atmosphere });

    arena.setPhaseIntensity(0.4);
    arena.dispose();

    arena.setPhaseIntensity(0.95);
    arena.triggerLightningStrike({ x: 2, y: 0, z: 2 });
    arena.reset();

    expect(arena.getPhaseIntensity()).toBeCloseTo(0.4, 6);
    expect(atmosphere.getPhaseIntensity()).toBeCloseTo(0.4, 6);
    expect(atmosphere.getActiveLightningCount()).toBe(0);

    atmosphere.dispose();
  });

  it('prevents negative margin or negative radius in clampArenaPosition from exceeding radius', () => {
    const negMargin = clampArenaPosition({ x: 100, y: 0, z: 0 }, 25.0, -100);
    expect(Number.isFinite(negMargin.x)).toBe(true);
    expect(Number.isFinite(negMargin.z)).toBe(true);
    expect(Math.hypot(negMargin.x, negMargin.z)).toBeLessThanOrEqual(25.0 + 1e-6);

    const negRadius = clampArenaPosition({ x: 10, y: 0, z: 10 }, -10, -5);
    expect(negRadius.x).toBe(0);
    expect(negRadius.z).toBe(0);
  });

  it('keeps all 27 monument plinths inside [28.65m, 43.0m] with zero coplanar Y collisions against terrace trims or neighbors', () => {
    const loader = new AssetLoader();
    const glbGeoms: THREE.BufferGeometry[] = [];
    const glbMat = new THREE.MeshBasicMaterial();
    const registerStub = (key: string, w: number, h: number, d: number) => {
      const geom = new THREE.BoxGeometry(w, h, d);
      glbGeoms.push(geom);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geom, glbMat));
      const gltf = {
        scene: group,
        scenes: [group],
        animations: [],
        cameras: [],
        asset: {},
        parser: {} as GLTF['parser'],
        userData: {},
      } as GLTF;
      loader.getBundle().glbs.set(key, gltf);
    };

    registerStub('env_arch_banner', 5.2, 6.0, 0.59);
    registerStub('env_main_altar', 2.92, 4.0, 2.08);
    registerStub('env_bell_structure', 3.69, 5.0, 0.78);
    registerStub('env_column', 1.82, 6.0, 1.82);
    registerStub('env_column_broken', 1.5, 3.0, 1.5);
    registerStub('env_dragon_statue', 10.0, 12.0, 28.0);

    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });
    const arena = new ArenaScene({ scene, assetLoader: loader, atmosphere });

    expect(arena.monumentsGroup.children.length).toBe(27);
    expect(arena.plinthsGroup.children.length).toBe(54);

    // Check braziers sit flush on OuterTempleDaisTrim (y = -0.025)
    for (let i = 0; i < 8; i += 1) {
      const brazier = atmosphere.rootGroup.getObjectByName(`Brazier_${i}`);
      expect(brazier).toBeDefined();
      expect(brazier!.position.y).toBeCloseTo(-0.025, 6);
    }

    // Check radial bounds of every plinth/trim vertex
    const v = new THREE.Vector3();
    for (const child of arena.plinthsGroup.children) {
      expect(child).toBeInstanceOf(THREE.Mesh);
      const mesh = child as THREE.Mesh;
      mesh.updateWorldMatrix(true, true);
      const pos = mesh.geometry.attributes.position!;
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const r = Math.hypot(v.x, v.z);
        expect(r, `${mesh.name} vertex R < 28.65`).toBeGreaterThanOrEqual(28.65);
        expect(r, `${mesh.name} vertex R > 43.0`).toBeLessThanOrEqual(43.0);
      }
    }

    // Extract horizontal triangles and verify zero coplanar overlaps
    interface Tri2D {
      meshName: string;
      y: number;
      pts: [[number, number], [number, number], [number, number]];
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }
    const extractHorizontalTris = (root: THREE.Object3D): Tri2D[] => {
      const tris: Tri2D[] = [];
      root.updateWorldMatrix(true, true);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const ab = new THREE.Vector3();
      const ac = new THREE.Vector3();
      const n = new THREE.Vector3();
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const pos = obj.geometry.attributes.position;
        if (!pos) return;
        const idx = obj.geometry.index;
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i < count; i += 3) {
          const i0 = idx ? idx.getX(i) : i;
          const i1 = idx ? idx.getX(i + 1) : i + 1;
          const i2 = idx ? idx.getX(i + 2) : i + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
          b.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
          c.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          n.crossVectors(ab, ac).normalize();
          if (Math.abs(n.y) > 0.99 && Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y) < 1e-4) {
            tris.push({
              meshName: obj.name,
              y: a.y,
              pts: [
                [a.x, a.z],
                [b.x, b.z],
                [c.x, c.z],
              ],
              minX: Math.min(a.x, b.x, c.x),
              maxX: Math.max(a.x, b.x, c.x),
              minZ: Math.min(a.z, b.z, c.z),
              maxZ: Math.max(a.z, b.z, c.z),
            });
          }
        }
      });
      return tris;
    };
    const trisOverlapXZ = (t1: Tri2D, t2: Tri2D): boolean => {
      if (t1.maxX <= t2.minX + 1e-6 || t2.maxX <= t1.minX + 1e-6) return false;
      if (t1.maxZ <= t2.minZ + 1e-6 || t2.maxZ <= t1.minZ + 1e-6) return false;
      for (const poly of [t1.pts, t2.pts]) {
        for (let i = 0; i < 3; i += 1) {
          const p0 = poly[i]!;
          const p1 = poly[(i + 1) % 3]!;
          const nx = -(p1[1] - p0[1]);
          const nz = p1[0] - p0[0];
          let min1 = Infinity;
          let max1 = -Infinity;
          for (const p of t1.pts) {
            const d = p[0] * nx + p[1] * nz;
            if (d < min1) min1 = d;
            if (d > max1) max1 = d;
          }
          let min2 = Infinity;
          let max2 = -Infinity;
          for (const p of t2.pts) {
            const d = p[0] * nx + p[1] * nz;
            if (d < min2) min2 = d;
            if (d > max2) max2 = d;
          }
          if (max1 <= min2 + 1e-6 || max2 <= min1 + 1e-6) return false;
        }
      }
      return true;
    };

    const daisGroup = arena.rootGroup.getObjectByName('OuterTempleDais')!;
    const terraceTris = extractHorizontalTris(daisGroup);
    const plinthTris = extractHorizontalTris(arena.plinthsGroup);

    for (const pt of plinthTris) {
      for (const tt of terraceTris) {
        if (Math.abs(pt.y - tt.y) <= 0.0005) {
          expect(
            trisOverlapXZ(pt, tt),
            `Coplanar overlap between ${pt.meshName} and ${tt.meshName} at y=${pt.y}`,
          ).toBe(false);
        }
      }
    }

    for (let i = 0; i < plinthTris.length; i += 1) {
      for (let j = i + 1; j < plinthTris.length; j += 1) {
        const a = plinthTris[i]!;
        const b = plinthTris[j]!;
        if (a.meshName === b.meshName) continue;
        if (Math.abs(a.y - b.y) <= 0.0005) {
          expect(
            trisOverlapXZ(a, b),
            `Coplanar overlap between ${a.meshName} and ${b.meshName} at y=${a.y}`,
          ).toBe(false);
        }
      }
    }

    arena.dispose();
    atmosphere.dispose();
    for (const g of glbGeoms) g.dispose();
    glbMat.dispose();
  });
});

describe('AtmosphereController', () => {
  it('installs THREE.FogExp2 and interpolates fog color and density from Act I to Act II', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });

    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
    const fog = atmosphere.getFog();
    expect(scene.fog).toBe(fog);

    atmosphere.setPhaseIntensity(0);
    const act1Density = fog.density;
    const act1Color = fog.color.clone();

    atmosphere.setPhaseIntensity(1);
    const act2Density = fog.density;
    const act2Color = fog.color.clone();

    expect(act2Density).toBeGreaterThan(act1Density);
    expect(act2Color.r).toBeGreaterThan(act1Color.r);
    expect(act2Color.b).toBeLessThan(act1Color.b);

    atmosphere.setPhaseIntensity(0.5);
    expect(fog.density).toBeCloseTo((act1Density + act2Density) / 2, 6);

    atmosphere.dispose();
  });

  it('activates lightning bolt and flash light on triggerLightningStrike and decays to 0 after update(1.0)', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });

    expect(atmosphere.getActiveLightningCount()).toBe(0);
    expect(atmosphere.getFlashIntensity()).toBe(0);

    atmosphere.triggerLightningStrike({ x: 4, y: 0, z: -6 });
    expect(atmosphere.getActiveLightningCount()).toBe(1);
    expect(atmosphere.getFlashIntensity()).toBeGreaterThan(0);

    atmosphere.update(1.0);
    expect(atmosphere.getFlashIntensity()).toBe(0);
    expect(atmosphere.getActiveLightningCount()).toBe(0);

    atmosphere.dispose();
  });

  it('treats update(NaN), update(-1), and update(0) as safe no-ops', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });

    atmosphere.triggerLightningStrike({ x: 0, y: 0, z: 0 });
    const initialFlash = atmosphere.getFlashIntensity();
    const initialCount = atmosphere.getActiveLightningCount();

    atmosphere.update(Number.NaN);
    atmosphere.update(-1);
    atmosphere.update(0);

    expect(atmosphere.getFlashIntensity()).toBe(initialFlash);
    expect(atmosphere.getActiveLightningCount()).toBe(initialCount);

    atmosphere.dispose();
  });

  it('cleans up fog and detaches rootGroup on dispose()', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });

    expect(scene.children).toContain(atmosphere.rootGroup);
    expect(scene.fog).not.toBeNull();

    atmosphere.dispose();
    expect(scene.children).not.toContain(atmosphere.rootGroup);
    expect(scene.fog).toBeNull();
    expect(() => atmosphere.dispose()).not.toThrow();
  });

  it('sanitizes NaN/Infinity lightning positions and ignores mutators after dispose()', () => {
    const scene = new THREE.Scene();
    const atmosphere = new AtmosphereController({ scene });

    atmosphere.triggerLightningStrike({
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      z: Number.NEGATIVE_INFINITY,
    });
    expect(atmosphere.getActiveLightningCount()).toBe(1);
    atmosphere.rootGroup.traverse((obj) => {
      expect(Number.isFinite(obj.position.x)).toBe(true);
      expect(Number.isFinite(obj.position.y)).toBe(true);
      expect(Number.isFinite(obj.position.z)).toBe(true);
      expect(Number.isFinite(obj.rotation.y)).toBe(true);
    });

    atmosphere.setPhaseIntensity(0.3);
    atmosphere.dispose();

    atmosphere.setPhaseIntensity(0.9);
    atmosphere.triggerLightningStrike({ x: 3, y: 0, z: 4 });
    atmosphere.reset();

    expect(atmosphere.getPhaseIntensity()).toBeCloseTo(0.3, 6);
    expect(atmosphere.getActiveLightningCount()).toBe(0);
  });
});

describe('VfxManager', () => {
  it('spawns all 4 SlashColorPresets, enforces <= 16 active pool cap, and expires via update(1.0)', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    const presets: SlashColorPreset[] = [
      'ink_gold',
      'azure_cyan',
      'crimson_gold',
      'celestial_white',
    ];
    for (const preset of presets) {
      vfx.spawnSlashArc({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 0.3, preset, 1.2);
    }
    expect(vfx.getActiveSlashCount()).toBe(4);

    for (let i = 0; i < 32; i += 1) {
      vfx.spawnSlashArc(
        { x: i * 0.1, y: 1, z: 0 },
        { x: 1, y: 0, z: 0 },
        0,
        presets[i % presets.length]!,
        1,
      );
    }
    expect(vfx.getActiveSlashCount()).toBeLessThanOrEqual(16);
    expect(vfx.getActiveSlashCount()).toBe(16);

    vfx.update(1.0);
    expect(vfx.getActiveSlashCount()).toBe(0);

    vfx.dispose();
  });

  it('supports keyed showTelegraphRing/Arc/Line/Pillar update, clear, and clearAll', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    vfx.showTelegraphRing('ring_1', {
      center: { x: 0, y: 0, z: -4 },
      innerRadius: 2,
      outerRadius: 6,
      progress: 0.25,
      color: 'crimson_gold',
    });
    vfx.showTelegraphRing('ring_1', {
      center: { x: 0, y: 0, z: -4 },
      innerRadius: 2,
      outerRadius: 6,
      progress: 0.75,
      color: 'amber',
    });
    expect(vfx.getActiveTelegraphCount()).toBe(1);

    vfx.showTelegraphArc('arc_1', {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      radius: 7,
      arcAngleRad: Math.PI / 2,
      progress: 0.5,
    });
    vfx.showTelegraphLine('line_1', {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      length: 12,
      width: 2.5,
      progress: 0.4,
    });
    vfx.showTelegraphPillar('pillar_1', {
      center: { x: 4, y: 0, z: -3 },
      radius: 3,
      height: 16,
      progress: 0.6,
      color: 'violet',
    });
    expect(vfx.getActiveTelegraphCount()).toBe(4);

    vfx.clearTelegraph('arc_1');
    expect(vfx.getActiveTelegraphCount()).toBe(3);

    vfx.clearAllTelegraphs();
    expect(vfx.getActiveTelegraphCount()).toBe(0);

    vfx.dispose();
  });

  it('emits and decays burst particles for impact, posture break, and lotus ward', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    vfx.spawnImpactBurst({ x: 0, y: 1, z: 0 }, false);
    expect(vfx.getActiveBurstParticleCount()).toBe(18);

    vfx.spawnImpactBurst({ x: 0, y: 1, z: 0 }, true);
    expect(vfx.getActiveBurstParticleCount()).toBe(60);

    vfx.triggerPostureBreakBurst({ x: 0, y: 0, z: -5 });
    expect(vfx.getActiveBurstParticleCount()).toBe(124);

    vfx.triggerLotusWardBurst({ x: 0, y: 0, z: 4 });
    expect(vfx.getActiveBurstParticleCount()).toBe(160);

    vfx.update(1.5);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);

    vfx.dispose();
  });

  it('toggles Skill 3 domain and triggers shatter burst on exit', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    expect(vfx.isSkill3DomainActive()).toBe(false);

    vfx.triggerSkill3Domain(true, { x: 0, y: 0, z: -5 });
    expect(vfx.isSkill3DomainActive()).toBe(true);
    expect(vfx.particles.group.visible).toBe(true);

    vfx.triggerSkill3Domain(false);
    expect(vfx.isSkill3DomainActive()).toBe(false);
    expect(vfx.getActiveBurstParticleCount()).toBeGreaterThanOrEqual(72);

    vfx.update(1.5);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);

    vfx.dispose();
  });

  it('clears all active effects on reset() and detaches rootGroup on dispose()', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    expect(scene.children).toContain(vfx.rootGroup);

    vfx.spawnSlashArc({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0, 'ink_gold', 1);
    vfx.showTelegraphRing('r1', {
      center: { x: 0, y: 0, z: 0 },
      innerRadius: 1,
      outerRadius: 5,
      progress: 0.5,
    });
    vfx.spawnImpactBurst({ x: 0, y: 1, z: 0 }, true);
    vfx.triggerSkill3Domain(true, { x: 0, y: 0, z: 0 });

    vfx.reset();
    expect(vfx.getActiveSlashCount()).toBe(0);
    expect(vfx.getActiveTelegraphCount()).toBe(0);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);
    expect(vfx.isSkill3DomainActive()).toBe(false);

    vfx.dispose();
    expect(scene.children).not.toContain(vfx.rootGroup);
    expect(() => vfx.dispose()).not.toThrow();
  });

  it('does not emit shatter particles when triggerSkill3Domain(false) is called while inactive', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);

    expect(vfx.isSkill3DomainActive()).toBe(false);
    vfx.triggerSkill3Domain(false);
    expect(vfx.isSkill3DomainActive()).toBe(false);
    expect(vfx.getActiveBurstParticleCount()).toBe(0);

    vfx.dispose();
  });

  it('sanitizes NaN and Infinity Vec3Like coordinates across all VFX entry points', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);
    const badPos = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      z: Number.NEGATIVE_INFINITY,
    };
    const badDir = {
      x: Number.NaN,
      y: 0,
      z: Number.POSITIVE_INFINITY,
    };

    vfx.spawnSlashArc(badPos, badDir, Number.NaN, 'ink_gold', Number.NaN);
    vfx.showTelegraphRing('nan_ring', {
      center: badPos,
      innerRadius: 1,
      outerRadius: 4,
      progress: Number.NaN,
    });
    vfx.showTelegraphArc('nan_arc', {
      origin: badPos,
      direction: badDir,
      radius: 5,
      arcAngleRad: 1.2,
      progress: 0.5,
    });
    vfx.showTelegraphLine('nan_line', {
      origin: badPos,
      direction: { x: 1e308, y: 0, z: 1e308 },
      length: 8,
      width: 2,
      progress: 0.5,
    });
    vfx.showTelegraphPillar('nan_pillar', {
      center: badPos,
      radius: 2,
      height: 12,
      progress: 0.5,
    });
    vfx.spawnImpactBurst(badPos, true);
    vfx.triggerPostureBreakBurst(badPos);
    vfx.triggerLotusWardBurst(badPos);
    vfx.triggerSkill3Domain(true, badPos);
    vfx.triggerSkill3Domain(false, badPos);

    vfx.rootGroup.traverse((obj) => {
      expect(Number.isFinite(obj.position.x)).toBe(true);
      expect(Number.isFinite(obj.position.y)).toBe(true);
      expect(Number.isFinite(obj.position.z)).toBe(true);
      expect(Number.isFinite(obj.rotation.x)).toBe(true);
      expect(Number.isFinite(obj.rotation.y)).toBe(true);
      expect(Number.isFinite(obj.rotation.z)).toBe(true);
      expect(Number.isFinite(obj.scale.x)).toBe(true);
      expect(Number.isFinite(obj.scale.y)).toBe(true);
      expect(Number.isFinite(obj.scale.z)).toBe(true);
    });

    const particlesAny = vfx.particles as unknown as {
      posArray: Float32Array;
      scaleArray: Float32Array;
      rotArray: Float32Array;
      colorArray: Float32Array;
      alphaArray: Float32Array;
    };
    for (const arr of [
      particlesAny.posArray,
      particlesAny.scaleArray,
      particlesAny.rotArray,
      particlesAny.colorArray,
      particlesAny.alphaArray,
    ]) {
      for (let i = 0; i < arr.length; i += 1) {
        expect(Number.isFinite(arr[i]!)).toBe(true);
      }
    }

    vfx.dispose();
  });

  it('clamps extreme 1e308 inputs in ParticleVfx and TelegraphVfx to prevent Float32 Infinity overflow', () => {
    const scene = new THREE.Scene();
    const vfx = new VfxManager(scene);
    const hugePos = { x: 1.5e308, y: 1e308, z: -1.5e308 };

    vfx.spawnImpactBurst(hugePos, true);
    vfx.triggerPostureBreakBurst(hugePos);
    vfx.triggerLotusWardBurst(hugePos);
    vfx.triggerSkill3Domain(true, hugePos);
    vfx.triggerSkill3Domain(false, hugePos);

    vfx.showTelegraphLine('huge_line', {
      origin: hugePos,
      direction: { x: 1e308, y: 0, z: -1e308 },
      length: 1e308,
      width: 1e308,
      progress: 0.5,
    });
    vfx.showTelegraphRing('huge_ring', {
      center: hugePos,
      innerRadius: 1e308,
      outerRadius: 1e308,
      progress: 0.5,
    });
    vfx.showTelegraphArc('huge_arc', {
      origin: hugePos,
      direction: { x: 1, y: 0, z: 0 },
      radius: 1e308,
      arcAngleRad: 1.5,
      progress: 0.5,
    });
    vfx.showTelegraphPillar('huge_pillar', {
      center: hugePos,
      radius: 1e308,
      height: 1e308,
      progress: 0.5,
    });

    vfx.update(0.016);

    vfx.rootGroup.traverse((obj) => {
      expect(Number.isFinite(obj.position.x)).toBe(true);
      expect(Number.isFinite(obj.position.y)).toBe(true);
      expect(Number.isFinite(obj.position.z)).toBe(true);
      expect(Number.isFinite(obj.scale.x)).toBe(true);
      expect(Number.isFinite(obj.scale.y)).toBe(true);
      expect(Number.isFinite(obj.scale.z)).toBe(true);
    });

    const particlesAny = vfx.particles as unknown as {
      posArray: Float32Array;
    };
    for (let i = 0; i < particlesAny.posArray.length; i += 1) {
      expect(Number.isFinite(particlesAny.posArray[i]!)).toBe(true);
    }

    vfx.dispose();
  });
});
