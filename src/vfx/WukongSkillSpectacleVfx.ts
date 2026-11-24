import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
import type { AssetLoader } from '../engine/AssetLoader.ts';
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import { consolidateModelSkeletons } from '../entities/PlayerEntity.ts';
import type { Vec3Like } from '../types/game.ts';

function createFloatUniform(initial: number) {
  return uniform(initial);
}
type FloatUniform = ReturnType<typeof createFloatUniform>;

function sanitize(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-5, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

interface GoldenCloneSlot {
  group: THREE.Group;
  staffGroup: THREE.Group;
  uOpacity: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  startX: number;
  startY: number;
  startZ: number;
  endX: number;
  endY: number;
  endZ: number;
  targetX: number;
  targetZ: number;
  swingSign: number;
}

interface GoldenArcWebSlot {
  group: THREE.Group;
  uProgress: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  baseScale: number;
}

interface LightningBoltSlot {
  mesh: THREE.Mesh;
  uProgress: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
}

interface HitSparkRingSlot {
  group: THREE.Group;
  shards: Array<{
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    rx: number;
    rz: number;
  }>;
  uProgress: FloatUniform;
  active: boolean;
  elapsed: number;
  duration: number;
  heavy: boolean;
}

/**
 * Pre-allocated, Zero-GC, 100% WebGPU TSL NodeMaterial Divine Skill & Hit VFX System
 * for Great Sage Sun Wukong (implementing all GPT Image 2.6 V7 Reference Sheets):
 * - Light-Hit Staff-Brace Spark Flash & Heavy Knockdown Shatter Burst
 * - Skill 1: 身外身法 · 毫毛四猴金身齐袭 (4 3D Golden Wukong Clones + Crisscrossing Golden Staff-Cage Web)
 * - Skill 2: 立棍风云 · 定海神针劈山 (Vertical Ascent Pillar + Cloud Vortex -> 16.5m Carved Dragon-Pillar + 21m S-Curve Golden Dragon Ground Fissure)
 * - Skill 3: 法天象地 · 万钧金箍伏魔大阵 (26m Rotating Sanskrit Mantra Circle + 15.5m Colossal Molten-Gold Great Sage Dharmakaya + 24m Sky-Spanning Pillar Slam)
 */
export class WukongSkillSpectacleVfx {
  readonly group = new THREE.Group();

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  // Shared Wukong hero scale cache & baked static clone geometry
  private wukongRawScale = 1.0;
  private wukongRawGroundY = 0.0;
  private readonly hasWukongGlb: boolean;
  private bakedGoldenCloneGeom: THREE.BufferGeometry | null = null;

  // Pool 0: Player Hit Spark / Guard Flash & Heavy Knockdown Shards
  private readonly hitRingPool: HitSparkRingSlot[] = [];

  // Skill 1: 4 3D Golden Monkey King Clones + 8 Golden Staff-Web Arcs + Dash Lightning
  private readonly goldenClones: GoldenCloneSlot[] = [];
  private readonly goldenArcWeb: GoldenArcWebSlot[] = [];
  private readonly lightningPool: LightningBoltSlot[] = [];
  private arcCursor = 0;

  // Skill 2: Stage A Ascent Pillar + Stage B 16.5m Carved Dragon-Pillar & 21m S-Curve Dragon Fissure
  private readonly skill2AscentGroup = new THREE.Group();
  private readonly uSkill2AscentProgress: FloatUniform = uniform(0);
  private skill2AscentActive = false;
  private skill2AscentElapsed = 0;
  private readonly skill2AscentDuration = 0.34;

  private readonly skill2SlamGroup = new THREE.Group();
  private readonly skill2DragonPillarPivot = new THREE.Group();
  private readonly skill2FissureMesh: THREE.Mesh;
  private readonly skill2DomeMesh: THREE.Mesh;
  private readonly uSkill2PillarFade: FloatUniform = uniform(0);
  private readonly uSkill2FissureFade: FloatUniform = uniform(0);
  private readonly uSkill2DomeProgress: FloatUniform = uniform(0);
  private skill2SlamActive = false;
  private skill2SlamElapsed = 0;
  private readonly skill2PillarDuration = 0.95;
  private readonly skill2FissureDuration = 1.55;

  // Skill 3: 26m Golden Sanskrit Mantra Array + 15.5m Towering Great Sage Dharmakaya + 24m Finisher Beam
  private readonly skill3MantraGroup = new THREE.Group();
  private readonly skill3MantraMesh: THREE.Mesh;
  private readonly skill3SkyBolts: THREE.Mesh[] = [];
  private readonly dharmakayaRoot = new THREE.Group();
  private readonly dharmakayaArmPivot = new THREE.Group();
  private dharmakayaLimbs: {
    upperArmL?: THREE.Bone;
    lowerArmL?: THREE.Bone;
    handL?: THREE.Bone;
    upperArmR?: THREE.Bone;
    lowerArmR?: THREE.Bone;
    handR?: THREE.Bone;
    restQuats: Array<{ bone: THREE.Bone; quat: THREE.Quaternion }>;
  } = { restQuats: [] };
  private readonly dharmakayaArmAncestors: THREE.Object3D[] = [];
  private dharmakayaSkeleton: THREE.Skeleton | null = null;
  private readonly dkRootWQ = new THREE.Quaternion();
  private readonly dkPosA = new THREE.Vector3();
  private readonly dkPosB = new THREE.Vector3();
  private readonly dkCurDir = new THREE.Vector3();
  private readonly dkTgtDir = new THREE.Vector3();
  private readonly dkParentWQ = new THREE.Quaternion();
  private readonly dkCurWQ = new THREE.Quaternion();
  private readonly dkDeltaQ = new THREE.Quaternion();
  private readonly dkTargetWQ = new THREE.Quaternion();
  private readonly tmpBoltDir = new THREE.Vector3();
  private readonly tmpBoltUp = new THREE.Vector3(0, 1, 0);
  private readonly uMantraOpacity: FloatUniform = uniform(0);
  private readonly uDharmakayaOpacity: FloatUniform = uniform(0);
  private readonly uTime: FloatUniform = uniform(0);

  private skill3DomainActive = false;
  private dharmakayaLingerTimer = 0;
  private dharmakayaSlamTriggered = false;
  private dharmakayaSlamElapsed = 0;

  private readonly skill3FinisherGroup = new THREE.Group();
  private readonly uFinisherProgress: FloatUniform = uniform(0);
  private skill3FinisherActive = false;
  private skill3FinisherElapsed = 0;
  private readonly skill3FinisherDuration = 1.15;

  // Opening Cinematic (8.0s Director's Cut): Golden Somersault Cloud + Ear-Needle Glint + Twin Dragon-vs-Abyss Clash!
  private readonly introCloudGroup = new THREE.Group();
  private readonly introEarNeedleGroup = new THREE.Group();
  private readonly introDragonAuraGroup = new THREE.Group();
  private readonly introClashGroup = new THREE.Group();
  private readonly uIntroCloudAlpha: FloatUniform = uniform(0);
  private readonly uIntroNeedleAlpha: FloatUniform = uniform(0);
  private readonly uIntroDragonAlpha: FloatUniform = uniform(0);
  private readonly uIntroClashProgress: FloatUniform = uniform(0);
  private introClashActive = false;
  private introClashElapsed = 0;
  private readonly introClashDuration = 1.15;

  private disposed = false;

  constructor(assetLoader?: AssetLoader) {
    this.group.name = 'WukongSkillSpectacleVfxGroup';

    const bundle = assetLoader?.getBundle();
    this.hasWukongGlb = Boolean(assetLoader && bundle?.glbs.has('hero_wukong'));
    if (this.hasWukongGlb && assetLoader) {
      this.measureWukongScale(assetLoader);
      this.bakedGoldenCloneGeom = this.buildBakedGoldenCloneGeometry(assetLoader);
    }

    for (let i = 0; i < 3; i += 1) {
      this.hitRingPool.push(this.createHitRingSlot(i));
    }
    for (let i = 0; i < 4; i += 1) {
      this.goldenClones.push(this.createGoldenCloneSlot(i));
    }
    for (let i = 0; i < 8; i += 1) {
      this.goldenArcWeb.push(this.createGoldenArcWebSlot(i));
    }
    for (let i = 0; i < 4; i += 1) {
      this.lightningPool.push(this.createLightningBoltSlot(i));
    }

    this.buildSkill2AscentVfx();
    const slamBuilt = this.buildSkill2DragonPillarVfx();
    this.skill2FissureMesh = slamBuilt.fissureMesh;
    this.skill2DomeMesh = slamBuilt.domeMesh;

    this.skill3MantraMesh = this.buildSkill3MantraAndDharmakaya(assetLoader);
    this.buildSkill3FinisherVfx();
    this.buildIntroCinematicVfx();
  }

  private measureWukongScale(loader: AssetLoader): void {
    const rawGltf = loader.getBundle().glbs.get('hero_wukong');
    if (!rawGltf?.scene) return;
    rawGltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    rawGltf.scene.traverse((obj) => {
      if (
        (obj as THREE.Mesh).isMesh &&
        !/Invisible|Weapon_DaSheng|weapon_fx|touguanmao/i.test(obj.name)
      ) {
        box.expandByObject(obj);
      }
    });
    const rawH = Math.max(0.05, box.max.y - box.min.y);
    this.wukongRawScale = 2.04 / rawH;
    this.wukongRawGroundY = -box.min.y * this.wukongRawScale;
  }

  private buildBakedGoldenCloneGeometry(
    loader: AssetLoader,
  ): THREE.BufferGeometry | null {
    const wkClone = loader.cloneModel('hero_wukong');
    const tempSkel = consolidateModelSkeletons(wkClone);
    wkClone.rotation.y = -Math.PI / 2;
    wkClone.rotation.x = 0.28; // athletic forward martial lunge!
    wkClone.scale.setScalar(this.wukongRawScale);
    wkClone.position.y = this.wukongRawGroundY;

    let headBone: THREE.Object3D | null = null;
    const hairGroups: THREE.Object3D[] = [];
    wkClone.traverse((o) => {
      if ((o as THREE.Bone).isBone && /^head/i.test(o.name)) {
        headBone = o;
      }
      if (o.name === 'SK_Wukong_head_born_static') {
        hairGroups.push(o);
      }
    });
    if (headBone) {
      for (const hg of hairGroups) {
        (headBone as THREE.Object3D).attach(hg);
      }
    }

    wkClone.updateMatrixWorld(true);
    const updatedSkels = new Set<THREE.Skeleton>();
    wkClone.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const sk = (o as THREE.SkinnedMesh).skeleton;
        if (sk && !updatedSkels.has(sk)) {
          updatedSkels.add(sk);
          sk.update();
        }
      }
    });

    const parts: THREE.BufferGeometry[] = [];
    const v3 = new THREE.Vector3();
    const v4 = new THREE.Vector4();
    const normalMat = new THREE.Matrix3();

    wkClone.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const m = o as THREE.Mesh;
      if (
        /Invisible|weapon_fx|Weapon_DaSheng|Hair_KajiyaKai|Haircard|Teeth|EyeAO/i.test(
          m.name,
        )
      ) {
        return;
      }
      const posAttr = m.geometry.attributes.position;
      if (!posAttr || posAttr.count === 0) return;

      const normAttr = m.geometry.attributes.normal;
      const uvAttr = m.geometry.attributes.uv;
      const vertCount = posAttr.count;
      const bakedPos = new Float32Array(vertCount * 3);
      const bakedNorm = new Float32Array(vertCount * 3);
      const bakedUv = new Float32Array(vertCount * 2);
      normalMat.getNormalMatrix(m.matrixWorld);

      const skinned = m as THREE.SkinnedMesh;
      const isSkinned = Boolean(skinned.isSkinnedMesh && skinned.skeleton);

      for (let i = 0; i < vertCount; i += 1) {
        if (isSkinned) {
          skinned.getVertexPosition(i, v3).applyMatrix4(m.matrixWorld);
        } else {
          v3.fromBufferAttribute(posAttr, i).applyMatrix4(m.matrixWorld);
        }
        const off = i * 3;
        bakedPos[off] = v3.x;
        bakedPos[off + 1] = v3.y;
        bakedPos[off + 2] = v3.z;

        if (normAttr) {
          if (isSkinned) {
            v4.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i), 0);
            skinned.applyBoneTransform(i, v4);
            v3.set(v4.x, v4.y, v4.z).applyMatrix3(normalMat).normalize();
          } else {
            v3.fromBufferAttribute(normAttr, i).applyMatrix3(normalMat).normalize();
          }
          bakedNorm[off] = v3.x;
          bakedNorm[off + 1] = v3.y;
          bakedNorm[off + 2] = v3.z;
        }

        if (uvAttr) {
          const uvOff = i * 2;
          bakedUv[uvOff] = uvAttr.getX(i);
          bakedUv[uvOff + 1] = uvAttr.getY(i);
        }
      }

      const srcIndex = m.geometry.index;
      const rawIdxCount = srcIndex ? srcIndex.count : vertCount;
      const rawIdx = new Uint32Array(rawIdxCount);
      if (srcIndex) {
        for (let j = 0; j < rawIdxCount; j += 1) {
          rawIdx[j] = srcIndex.getX(j);
        }
      } else {
        for (let j = 0; j < rawIdxCount; j += 1) {
          rawIdx[j] = j;
        }
      }

      const triCount = Math.floor(rawIdxCount / 3);
      let finalPos = bakedPos;
      let finalNorm = bakedNorm;
      let finalUv = bakedUv;
      let finalIdx = rawIdx;

      if (triCount > 1500) {
        const cellSize = /touguanmao|head/i.test(m.name) ? 0.024 : 0.045;
        const invCell = 1 / cellSize;
        const clusterMap = new Map<string, number>();
        const vertexToCluster = new Uint32Array(vertCount);
        const sumPos: number[] = [];
        const sumNorm: number[] = [];
        const sumUv: number[] = [];
        const counts: number[] = [];
        let clusterCount = 0;

        for (let i = 0; i < vertCount; i += 1) {
          const off = i * 3;
          const uvOff = i * 2;
          const gx = Math.round(bakedPos[off]! * invCell);
          const gy = Math.round(bakedPos[off + 1]! * invCell);
          const gz = Math.round(bakedPos[off + 2]! * invCell);
          const key = `${gx},${gy},${gz}`;
          let cid = clusterMap.get(key);
          if (cid === undefined) {
            cid = clusterCount;
            clusterCount += 1;
            clusterMap.set(key, cid);
            sumPos.push(bakedPos[off]!, bakedPos[off + 1]!, bakedPos[off + 2]!);
            sumNorm.push(bakedNorm[off]!, bakedNorm[off + 1]!, bakedNorm[off + 2]!);
            sumUv.push(bakedUv[uvOff]!, bakedUv[uvOff + 1]!);
            counts.push(1);
          } else {
            sumPos[cid * 3]! += bakedPos[off]!;
            sumPos[cid * 3 + 1]! += bakedPos[off + 1]!;
            sumPos[cid * 3 + 2]! += bakedPos[off + 2]!;
            sumNorm[cid * 3]! += bakedNorm[off]!;
            sumNorm[cid * 3 + 1]! += bakedNorm[off + 1]!;
            sumNorm[cid * 3 + 2]! += bakedNorm[off + 2]!;
            sumUv[cid * 2]! += bakedUv[uvOff]!;
            sumUv[cid * 2 + 1]! += bakedUv[uvOff + 1]!;
            counts[cid]! += 1;
          }
          vertexToCluster[i] = cid;
        }

        const decPos = new Float32Array(clusterCount * 3);
        const decNorm = new Float32Array(clusterCount * 3);
        const decUv = new Float32Array(clusterCount * 2);
        for (let c = 0; c < clusterCount; c += 1) {
          const invC = 1 / Math.max(1, counts[c]!);
          const o3 = c * 3;
          const o2 = c * 2;
          decPos[o3] = sumPos[o3]! * invC;
          decPos[o3 + 1] = sumPos[o3 + 1]! * invC;
          decPos[o3 + 2] = sumPos[o3 + 2]! * invC;

          const nx = sumNorm[o3]!;
          const ny = sumNorm[o3 + 1]!;
          const nz = sumNorm[o3 + 2]!;
          const nLen = Math.hypot(nx, ny, nz);
          if (nLen > 1e-5) {
            decNorm[o3] = nx / nLen;
            decNorm[o3 + 1] = ny / nLen;
            decNorm[o3 + 2] = nz / nLen;
          } else {
            decNorm[o3 + 1] = 1;
          }

          decUv[o2] = sumUv[o2]! * invC;
          decUv[o2 + 1] = sumUv[o2 + 1]! * invC;
        }

        const remappedIdx: number[] = [];
        for (let t = 0; t + 2 < rawIdxCount; t += 3) {
          const c0 = vertexToCluster[rawIdx[t]!]!;
          const c1 = vertexToCluster[rawIdx[t + 1]!]!;
          const c2 = vertexToCluster[rawIdx[t + 2]!]!;
          if (c0 !== c1 && c1 !== c2 && c2 !== c0) {
            remappedIdx.push(c0, c1, c2);
          }
        }

        if (remappedIdx.length >= 3) {
          finalPos = decPos;
          finalNorm = decNorm;
          finalUv = decUv;
          finalIdx = new Uint32Array(remappedIdx);
        }
      }

      const part = new THREE.BufferGeometry();
      part.setAttribute('position', new THREE.BufferAttribute(finalPos, 3));
      part.setAttribute('normal', new THREE.BufferAttribute(finalNorm, 3));
      part.setAttribute('uv', new THREE.BufferAttribute(finalUv, 2));
      part.setIndex(new THREE.BufferAttribute(finalIdx, 1));
      if (!normAttr) {
        part.computeVertexNormals();
      }
      parts.push(part);
    });

    for (const sk of updatedSkels) {
      sk.dispose();
    }
    if (tempSkel && !updatedSkels.has(tempSkel)) {
      tempSkel.dispose();
    }
    wkClone.clear();

    if (parts.length === 0) return null;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) {
      p.dispose();
    }
    if (merged) {
      this.ownedGeometries.push(merged);
    }
    return merged;
  }

  private createOrnateGoldenStaffMesh(
    lengthMeters: number,
    radiusMeters: number,
    uOpacity: FloatUniform,
    addDragonCoils: boolean,
  ): THREE.Group {
    const staffGrp = new THREE.Group();

    // Core divine crimson-gold shaft aligned along +Z (0 .. lengthMeters)
    const shaftGeo = new THREE.CylinderGeometry(
      radiusMeters,
      radiusMeters,
      lengthMeters,
      20,
      1,
      false,
    );
    shaftGeo.rotateX(Math.PI / 2);
    this.ownedGeometries.push(shaftGeo);

    const shaftMat = new MeshStandardNodeMaterial({
      name: 'WukongDivinePillarShaftMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.25,
      metalness: 0.85,
    });
    const vUv = uv();
    const endBand = smoothstep(0.24, 0.02, vUv.y).add(smoothstep(0.76, 0.98, vUv.y));
    const runeRings = smoothstep(
      0.65,
      0.98,
      abs(sin(vUv.y.mul(28.0).add(this.uTime.mul(4.0)))),
    );
    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.0,
    );
    const basePalette = mix(color(0xa8260c), color(0xffbe36), saturate(endBand.add(runeRings.mul(0.55))));
    shaftMat.colorNode = basePalette;
    shaftMat.emissiveNode = mix(color(0xd8580e), color(0xffd86e), saturate(endBand.add(fresnel)))
      .mul(float(0.75).add(endBand.mul(0.45)));
    shaftMat.opacityNode = uOpacity.mul(float(0.86));
    this.ownedMaterials.push(shaftMat);

    const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
    shaftMesh.frustumCulled = false;
    staffGrp.add(shaftMesh);

    // Ornate carved golden end-caps (箍圈)
    const capLen = lengthMeters * 0.18;
    const capGeo = new THREE.CylinderGeometry(
      radiusMeters * 1.24,
      radiusMeters * 1.18,
      capLen,
      20,
    );
    capGeo.rotateX(Math.PI / 2);
    this.ownedGeometries.push(capGeo);

    const goldMat = new MeshStandardNodeMaterial({
      name: 'WukongDivinePillarGoldCapMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.2,
      metalness: 0.92,
    });
    goldMat.colorNode = color(0xffc844);
    goldMat.emissiveNode = mix(color(0xe87c12), color(0xffe694), fresnel).mul(float(1.12));
    goldMat.opacityNode = uOpacity.mul(float(0.92));
    this.ownedMaterials.push(goldMat);

    for (const zSign of [-1, 1]) {
      const capMesh = new THREE.Mesh(capGeo, goldMat);
      capMesh.position.z = zSign * (lengthMeters * 0.5 - capLen * 0.48);
      capMesh.frustumCulled = false;
      staffGrp.add(capMesh);
    }

    if (addDragonCoils) {
      // Twin 3D Helical Golden Dragon-Relief Coils spiraling around the colossal 定海神针!
      for (let strand = 0; strand < 2; strand += 1) {
        const pts: THREE.Vector3[] = [];
        const steps = 44;
        const phaseOffset = strand * Math.PI;
        for (let s = 0; s <= steps; s += 1) {
          const t = s / steps;
          const angle = t * Math.PI * 6.5 + phaseOffset;
          const coilR = radiusMeters * 1.16;
          pts.push(
            new THREE.Vector3(
              Math.cos(angle) * coilR,
              Math.sin(angle) * coilR,
              (t - 0.5) * lengthMeters * 0.88,
            ),
          );
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        const tubeGeo = new THREE.TubeGeometry(
          curve,
          48,
          radiusMeters * 0.16,
          8,
          false,
        );
        this.ownedGeometries.push(tubeGeo);
        const coilMesh = new THREE.Mesh(tubeGeo, goldMat);
        coilMesh.frustumCulled = false;
        staffGrp.add(coilMesh);
      }
    }

    return staffGrp;
  }

  private createHitRingSlot(index: number): HitSparkRingSlot {
    const group = new THREE.Group();
    group.name = `WukongPlayerHitVfx_${index}`;
    group.visible = false;

    const uProgress = uniform(0);
    const ringGeo = new THREE.RingGeometry(0.72, 1.12, 36);
    this.ownedGeometries.push(ringGeo);

    const ringMat = new MeshBasicNodeMaterial({
      name: `WukongHitGuardFlashMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const rUv = uv();
    const rimBand = smoothstep(0.0, 0.35, rUv.y).mul(smoothstep(1.0, 0.65, rUv.y));
    const fade = pow(float(1.0).sub(uProgress), 1.8);
    ringMat.colorNode = mix(color(0xff8c1a), color(0xffeaa8), rimBand).mul(float(1.55));
    ringMat.opacityNode = rimBand.mul(fade).mul(float(0.85));
    this.ownedMaterials.push(ringMat);

    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.frustumCulled = false;
    group.add(ringMesh);

    const shardGeo = new THREE.OctahedronGeometry(0.038, 0);
    this.ownedGeometries.push(shardGeo);
    const shards: HitSparkRingSlot['shards'] = [];
    for (let s = 0; s < 8; s += 1) {
      const m = new THREE.Mesh(shardGeo, ringMat);
      m.frustumCulled = false;
      group.add(m);
      shards.push({ mesh: m, vx: 0, vy: 0, vz: 0, rx: 4 + s, rz: 3 + s });
    }

    setObjectLayerRecursive(group, LAYER_MAIN_ONLY);
    this.group.add(group);
    return {
      group,
      shards,
      uProgress,
      active: false,
      elapsed: 0,
      duration: 0.32,
      heavy: false,
    };
  }

  private createGoldenCloneSlot(index: number): GoldenCloneSlot {
    const group = new THREE.Group();
    group.name = `WukongSkill1GoldenClone_${index}`;
    group.visible = false;

    const uOpacity = uniform(0);
    const cloneMat = new MeshStandardNodeMaterial({
      name: `WukongGoldenCloneArmorMat_${index}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.32,
      metalness: 0.85,
    });
    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.1,
    );
    cloneMat.colorNode = color(0xd88c22);
    cloneMat.emissiveNode = mix(color(0xd9680e), color(0xffde7a), fresnel).mul(
      fresnel.mul(1.05).add(0.24),
    );
    cloneMat.opacityNode = uOpacity.mul(fresnel.mul(0.75).add(0.28));
    this.ownedMaterials.push(cloneMat);

    if (this.hasWukongGlb && this.bakedGoldenCloneGeom) {
      const staticMesh = new THREE.Mesh(this.bakedGoldenCloneGeom, cloneMat);
      staticMesh.name = `WukongBakedGoldenCloneMesh_${index}`;
      staticMesh.castShadow = false;
      staticMesh.receiveShadow = false;
      staticMesh.frustumCulled = false;
      group.add(staticMesh);
    } else {
      // NodeMaterial procedural golden warrior silhouette for headless unit tests without GLBs
      const bodyGeo = new THREE.CapsuleGeometry(0.32, 1.25, 6, 12);
      this.ownedGeometries.push(bodyGeo);
      const bodyMesh = new THREE.Mesh(bodyGeo, cloneMat);
      bodyMesh.position.y = 1.05;
      bodyMesh.frustumCulled = false;
      group.add(bodyMesh);
    }

    const staffGroup = this.createOrnateGoldenStaffMesh(4.6, 0.068, uOpacity, false);
    staffGroup.position.set(0.18, 1.25, 0.95);
    group.add(staffGroup);

    // Excluded from groundReflector and detached from scene graph when inactive
    setObjectLayerRecursive(group, LAYER_MAIN_ONLY);
    return {
      group,
      staffGroup,
      uOpacity,
      active: false,
      elapsed: 0,
      duration: 0.62,
      startX: 0,
      startY: 0,
      startZ: 0,
      endX: 0,
      endY: 0,
      endZ: 0,
      targetX: 0,
      targetZ: 0,
      swingSign: index % 2 === 0 ? 1 : -1,
    };
  }

  private createGoldenArcWebSlot(index: number): GoldenArcWebSlot {
    const group = new THREE.Group();
    group.name = `WukongGoldenStaffWebArc_${index}`;
    group.visible = false;

    const uProgress = uniform(0);
    const arcGeo = new THREE.RingGeometry(1.85, 3.15, 40, 1, -Math.PI * 0.68, Math.PI * 1.36);
    this.ownedGeometries.push(arcGeo);

    const arcMat = new MeshBasicNodeMaterial({
      name: `WukongGoldenStaffWebMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const aUv = uv();
    const radialBlade = pow(
      sin(saturate(aUv.y).mul(Math.PI)),
      1.35,
    );
    const sweepHead = smoothstep(0.0, 0.18, aUv.x).mul(
      smoothstep(1.0, 0.65, aUv.x),
    );
    const fade = pow(float(1.0).sub(uProgress), 1.45);
    arcMat.colorNode = mix(color(0xff9218), color(0xfff6cf), radialBlade).mul(float(2.25));
    arcMat.opacityNode = radialBlade.mul(sweepHead).mul(fade).mul(float(0.95));
    this.ownedMaterials.push(arcMat);

    const arcMesh = new THREE.Mesh(arcGeo, arcMat);
    arcMesh.rotation.x = -Math.PI / 2;
    arcMesh.frustumCulled = false;
    group.add(arcMesh);

    this.group.add(group);
    return {
      group,
      uProgress,
      active: false,
      elapsed: 0,
      duration: 0.36,
      baseScale: 1.0,
    };
  }

  private createLightningBoltSlot(index: number): LightningBoltSlot {
    const uProgress = uniform(0);
    const boltGeo = new THREE.PlaneGeometry(1.1, 1.0, 1, 16);
    boltGeo.translate(0, 0.5, 0);
    this.ownedGeometries.push(boltGeo);

    const boltMat = new MeshBasicNodeMaterial({
      name: `WukongGoldenLightningMat_${index}`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const bUv = uv();
    const zig = sin(bUv.y.mul(34.0).add(this.uTime.mul(22.0))).mul(0.18);
    const coreDist = abs(bUv.x.sub(0.5).sub(zig)).mul(2.0);
    const boltLine = smoothstep(0.42, 0.0, coreDist);
    const endFade = smoothstep(0.0, 0.08, bUv.y).mul(smoothstep(1.0, 0.92, bUv.y));
    const fade = pow(float(1.0).sub(uProgress), 1.5);
    boltMat.colorNode = mix(color(0xffae24), color(0xffffff), boltLine).mul(float(2.4));
    boltMat.opacityNode = boltLine.mul(endFade).mul(fade);
    this.ownedMaterials.push(boltMat);

    const mesh = new THREE.Mesh(boltGeo, boltMat);
    mesh.name = `WukongGoldenLightningMesh_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);

    return {
      mesh,
      uProgress,
      active: false,
      elapsed: 0,
      duration: 0.32,
    };
  }

  private buildSkill2AscentVfx(): void {
    this.skill2AscentGroup.name = 'WukongSkill2AscentPillarGroup';
    this.skill2AscentGroup.visible = false;

    const fade = float(1.0).sub(pow(this.uSkill2AscentProgress, 1.6));
    const pillarGeo = new THREE.CylinderGeometry(0.15, 0.2, 6.2, 18);
    pillarGeo.translate(0, 3.1, 0);
    this.ownedGeometries.push(pillarGeo);

    const pillarMat = new MeshStandardNodeMaterial({
      name: 'WukongSkill2AscentPillarMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.22,
      metalness: 0.9,
    });
    const pUv = uv();
    const capMask = smoothstep(0.22, 0.02, pUv.y).add(smoothstep(0.78, 0.98, pUv.y));
    pillarMat.colorNode = mix(color(0xd84218), color(0xffd862), capMask);
    pillarMat.emissiveNode = mix(color(0xff941c), color(0xfff6cf), capMask).mul(float(1.95));
    pillarMat.opacityNode = fade.mul(float(0.92));
    this.ownedMaterials.push(pillarMat);

    const pillarMesh = new THREE.Mesh(pillarGeo, pillarMat);
    pillarMesh.frustumCulled = false;
    this.skill2AscentGroup.add(pillarMesh);

    // Swirling Golden Cloud Vortex Rings rising around Wukong's perched pillar!
    const cloudGeo = new THREE.TorusGeometry(1.45, 0.16, 10, 32);
    cloudGeo.rotateX(Math.PI / 2);
    this.ownedGeometries.push(cloudGeo);

    const cloudMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill2GoldenCloudMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cUv = uv();
    const wisp = smoothstep(0.25, 0.95, sin(cUv.x.mul(18.0).add(this.uTime.mul(10.0))).mul(0.5).add(0.5));
    cloudMat.colorNode = mix(color(0xffa424), color(0xfff3c4), wisp).mul(float(1.85));
    cloudMat.opacityNode = fade.mul(wisp).mul(float(0.78));
    this.ownedMaterials.push(cloudMat);

    for (let i = 0; i < 3; i += 1) {
      const ring = new THREE.Mesh(cloudGeo, cloudMat);
      ring.position.y = 0.6 + i * 1.15;
      ring.scale.setScalar(1.15 - i * 0.18);
      ring.frustumCulled = false;
      this.skill2AscentGroup.add(ring);
    }

    this.group.add(this.skill2AscentGroup);
  }

  private buildSkill2DragonPillarVfx(): {
    fissureMesh: THREE.Mesh;
    domeMesh: THREE.Mesh;
  } {
    this.skill2SlamGroup.name = 'WukongSkill2DragonPillarSlamGroup';
    this.skill2SlamGroup.visible = false;

    // 1. Colossal 16.5m x 1.28m Carved Golden Dragon-Coiled Pillar ("定海神针巨柱")!
    const giantPillar = this.createOrnateGoldenStaffMesh(
      16.5,
      0.64,
      this.uSkill2PillarFade,
      true,
    );
    // Align +Z shaft so 0 is at impact ground pivot and 16.5m extends skyward along +Y before tilting!
    giantPillar.rotation.x = -Math.PI / 2;
    giantPillar.position.y = 8.0;
    this.skill2DragonPillarPivot.add(giantPillar);
    this.skill2SlamGroup.add(this.skill2DragonPillarPivot);

    // 2. 21-Meter Sinuous S-Curve Glowing Golden Dragon Ground Fissure ("金色游龙裂地熔金沟壑")!
    const fissureGeo = new THREE.PlaneGeometry(8.6, 21.5, 1, 1);
    fissureGeo.rotateX(-Math.PI / 2);
    this.ownedGeometries.push(fissureGeo);

    const fissureMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill2DragonFissureMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const fUv = uv();
    const lenFade = smoothstep(0.0, 0.12, fUv.y).mul(smoothstep(1.0, 0.85, fUv.y));
    const dragonWave = sin(fUv.y.mul(11.5).sub(this.uTime.mul(2.5))).mul(0.16);
    const branchWave = sin(fUv.y.mul(31.0)).mul(0.06);
    const distFromSpine = abs(fUv.x.sub(0.5).sub(dragonWave));
    const mainCrack = smoothstep(0.11, 0.008, distFromSpine);
    const hotCore = smoothstep(0.035, 0.0, distFromSpine);
    const sideVeins = smoothstep(
      0.26,
      0.04,
      abs(distFromSpine.sub(0.09).sub(branchWave)),
    ).mul(smoothstep(0.42, 0.08, distFromSpine));
    const totalMask = saturate(mainCrack.add(sideVeins.mul(0.58))).mul(lenFade);

    fissureMat.colorNode = mix(
      color(0xd94e14),
      mix(color(0xffcb3d), color(0xfffbe0), hotCore),
      saturate(mainCrack.add(hotCore)),
    ).mul(float(2.05));
    fissureMat.opacityNode = totalMask.mul(this.uSkill2FissureFade).mul(float(0.95));
    this.ownedMaterials.push(fissureMat);

    const fissureMesh = new THREE.Mesh(fissureGeo, fissureMat);
    fissureMesh.position.y = 0.055;
    fissureMesh.frustumCulled = false;
    setObjectLayerRecursive(fissureMesh, LAYER_MAIN_ONLY);
    this.skill2SlamGroup.add(fissureMesh);

    // 3. Expanding Ground-Hugging Golden Shockwave Torus (never obscures camera view of the 16.5m Dragon-Pillar!)
    const domeGeo = new THREE.TorusGeometry(1.0, 0.08, 12, 48);
    domeGeo.rotateX(Math.PI / 2);
    this.ownedGeometries.push(domeGeo);

    const domeMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill2GoldenDomeMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const dUv = uv();
    const rim = sin(dUv.y.mul(Math.PI));
    const domeFade = pow(float(1.0).sub(this.uSkill2DomeProgress), 1.65);
    domeMat.colorNode = mix(color(0xff8e18), color(0xffe89c), rim).mul(float(1.55));
    domeMat.opacityNode = rim.mul(domeFade).mul(float(0.85));
    this.ownedMaterials.push(domeMat);

    const domeMesh = new THREE.Mesh(domeGeo, domeMat);
    domeMesh.position.y = 0.22;
    domeMesh.frustumCulled = false;
    this.skill2SlamGroup.add(domeMesh);

    this.group.add(this.skill2SlamGroup);
    return { fissureMesh, domeMesh };
  }

  private buildSkill3MantraAndDharmakaya(assetLoader?: AssetLoader): THREE.Mesh {
    this.skill3MantraGroup.name = 'WukongSkill3GreatSageDomainGroup';
    this.skill3MantraGroup.visible = false;

    // 1. 26-Meter Rotating Golden Sanskrit Tightening-Spell Mantra Array ("26米金色紧箍咒八重神阵")!
    const mantraGeo = new THREE.PlaneGeometry(27.0, 27.0, 1, 1);
    mantraGeo.rotateX(-Math.PI / 2);
    this.ownedGeometries.push(mantraGeo);

    const mantraMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill3GoldenMantraMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const p = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const r = length(p);
    const theta = atan(p.y, p.x);

    const outerDoubleRing = smoothstep(0.028, 0.004, abs(r.sub(0.92))).add(
      smoothstep(0.022, 0.003, abs(r.sub(0.83))),
    );
    const sanskritBand = smoothstep(0.045, 0.008, abs(r.sub(0.875))).mul(
      smoothstep(0.25, 0.85, cos(theta.mul(24.0).add(this.uTime.mul(2.4)))),
    );
    const midWheelRing = smoothstep(0.024, 0.004, abs(r.sub(0.58))).add(
      smoothstep(0.036, 0.006, abs(r.sub(0.52))).mul(
        smoothstep(0.3, 0.85, cos(theta.mul(16.0).sub(this.uTime.mul(3.1)))),
      ),
    );
    const innerLotusRing = smoothstep(0.024, 0.004, abs(r.sub(0.28))).add(
      smoothstep(0.05, 0.01, abs(r.sub(0.22).sub(cos(theta.mul(8.0).add(this.uTime.mul(1.8))).mul(0.035)))),
    );
    const eightSpokes = smoothstep(0.94, 0.995, abs(cos(theta.mul(4.0).add(this.uTime.mul(0.45)))))
      .mul(smoothstep(0.22, 0.3, r))
      .mul(smoothstep(0.92, 0.84, r));
    const warmDiscGlow = smoothstep(0.96, 0.05, r).mul(float(0.16));

    const pattern = saturate(
      outerDoubleRing
        .add(sanskritBand.mul(0.9))
        .add(midWheelRing.mul(0.85))
        .add(innerLotusRing.mul(0.9))
        .add(eightSpokes.mul(0.75))
        .add(warmDiscGlow),
    );
    const outerClip = smoothstep(0.98, 0.9, r);

    mantraMat.colorNode = mix(color(0xff8e18), color(0xfff5c8), pattern).mul(float(1.85));
    mantraMat.opacityNode = pattern.mul(outerClip).mul(this.uMantraOpacity).mul(float(0.92));
    this.ownedMaterials.push(mantraMat);

    const mantraMesh = new THREE.Mesh(mantraGeo, mantraMat);
    mantraMesh.position.y = 0.06;
    mantraMesh.frustumCulled = false;
    setObjectLayerRecursive(mantraMesh, LAYER_MAIN_ONLY);
    this.skill3MantraGroup.add(mantraMesh);

    // 2. 6 Golden Sky-Lightning Pillars ringing the 26m Mantra Circle!
    const skyBoltGeo = new THREE.PlaneGeometry(1.5, 22.0, 1, 16);
    skyBoltGeo.translate(0, 11.0, 0);
    this.ownedGeometries.push(skyBoltGeo);

    const skyBoltMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill3SkyLightningMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const sbUv = uv();
    const sbZig = sin(sbUv.y.mul(28.0).add(this.uTime.mul(16.0))).mul(0.2);
    const sbCore = smoothstep(0.36, 0.0, abs(sbUv.x.sub(0.5).sub(sbZig)).mul(2.0));
    const sbFadeY = smoothstep(0.0, 0.06, sbUv.y).mul(smoothstep(1.0, 0.72, sbUv.y));
    skyBoltMat.colorNode = mix(color(0xffa822), color(0xfffbe4), sbCore).mul(float(2.1));
    skyBoltMat.opacityNode = sbCore.mul(sbFadeY).mul(this.uMantraOpacity).mul(float(0.82));
    this.ownedMaterials.push(skyBoltMat);

    for (let i = 0; i < 6; i += 1) {
      const bolt = new THREE.Mesh(skyBoltGeo, skyBoltMat);
      const ang = (i / 6) * Math.PI * 2 + 0.35;
      bolt.position.set(Math.cos(ang) * 11.2, 0, Math.sin(ang) * 11.2);
      bolt.rotation.y = -ang + Math.PI * 0.5;
      bolt.frustumCulled = false;
      this.skill3SkyBolts.push(bolt);
      this.skill3MantraGroup.add(bolt);
    }

    // 3. Colossal 14.5-Meter Molten-Gold Great Sage Dharmakaya ("法天象地 · 齐天大圣巨型金身法相")!
    this.dharmakayaRoot.name = 'WukongGreatSageDharmakaya15m';
    const avatarScaleFactor = 5.5; // 11.2m armored body + 3.4m pheasant crown plumes = 14.6m total towering height!

    const avatarMat = new MeshStandardNodeMaterial({
      name: 'WukongDharmakayaAvatarMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.34,
      metalness: 0.88,
    });
    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.15,
    );
    avatarMat.colorNode = color(0xc97b18);
    avatarMat.emissiveNode = mix(color(0xc8580a), color(0xffdc78), fresnel).mul(
      fresnel.mul(1.28).add(0.22),
    );
    avatarMat.opacityNode = this.uDharmakayaOpacity.mul(fresnel.mul(0.76).add(0.22));
    this.ownedMaterials.push(avatarMat);

    if (this.hasWukongGlb && assetLoader) {
      const giantWk = assetLoader.cloneModel('hero_wukong');
      this.dharmakayaSkeleton = consolidateModelSkeletons(giantWk);
      giantWk.rotation.y = -Math.PI / 2;
      giantWk.scale.setScalar(this.wukongRawScale * avatarScaleFactor);
      giantWk.position.y = this.wukongRawGroundY * avatarScaleFactor;

      let headBone: THREE.Object3D | null = null;
      const hairGroups: THREE.Object3D[] = [];
      giantWk.traverse((o) => {
        if ((o as THREE.Bone).isBone) {
          const b = o as THREE.Bone;
          const clean = b.name.replace(/_0*\d+$/, '').toLowerCase();
          if (clean === 'head') headBone = b;
          if (clean === 'upperarm_l') this.dharmakayaLimbs.upperArmL = b;
          if (clean === 'lowerarm_l') this.dharmakayaLimbs.lowerArmL = b;
          if (clean === 'hand_l') this.dharmakayaLimbs.handL = b;
          if (clean === 'upperarm_r') this.dharmakayaLimbs.upperArmR = b;
          if (clean === 'lowerarm_r') this.dharmakayaLimbs.lowerArmR = b;
          if (clean === 'hand_r') this.dharmakayaLimbs.handR = b;
        }
        if (o.name === 'SK_Wukong_head_born_static') {
          hairGroups.push(o);
        }
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          if (!m.geometry.attributes.uv && m.geometry.attributes.position) {
            m.geometry.setAttribute(
              'uv',
              new THREE.BufferAttribute(
                new Float32Array(m.geometry.attributes.position.count * 2),
                2,
              ),
            );
          }
          if (/Invisible|weapon_fx|Weapon_DaSheng/i.test(m.name)) {
            m.visible = false;
          } else {
            m.material = avatarMat;
            m.castShadow = false;
            m.receiveShadow = false;
            m.frustumCulled = false;
          }
        }
      });
      if (headBone) {
        for (const hg of hairGroups) {
          (headBone as THREE.Object3D).attach(hg);
        }
      }
      for (const b of [
        this.dharmakayaLimbs.upperArmL,
        this.dharmakayaLimbs.lowerArmL,
        this.dharmakayaLimbs.upperArmR,
        this.dharmakayaLimbs.lowerArmR,
      ]) {
        if (b) {
          this.dharmakayaLimbs.restQuats.push({ bone: b, quat: b.quaternion.clone() });
        }
      }
      this.dharmakayaRoot.add(giantWk);

      // Cache top-down ancestor chain for poseDharmakayaArms() without full-subtree updateMatrixWorld(true)
      const seenAnc = new Set<THREE.Object3D>();
      const addAncestors = (leaf: THREE.Object3D | undefined): void => {
        if (!leaf) return;
        const chain: THREE.Object3D[] = [];
        let cur: THREE.Object3D | null = leaf;
        while (cur && cur !== this.dharmakayaRoot) {
          chain.push(cur);
          cur = cur.parent;
        }
        chain.reverse();
        for (const n of chain) {
          if (!seenAnc.has(n)) {
            seenAnc.add(n);
            this.dharmakayaArmAncestors.push(n);
          }
        }
      };
      addAncestors(this.dharmakayaLimbs.handR);
      addAncestors(this.dharmakayaLimbs.handL);
    } else {
      const giantBodyGeo = new THREE.CapsuleGeometry(1.8, 7.8, 8, 16);
      this.ownedGeometries.push(giantBodyGeo);
      const giantBodyMesh = new THREE.Mesh(giantBodyGeo, avatarMat);
      giantBodyMesh.position.y = 6.2;
      giantBodyMesh.frustumCulled = false;
      this.dharmakayaRoot.add(giantBodyMesh);
    }

    // Sky-spanning 22-meter x 1.25-meter Golden Ruyi Jingu Bang gripped overhead by both giant golden hands!
    this.dharmakayaArmPivot.position.set(0, 10.6, 1.4);
    const skyStaff = this.createOrnateGoldenStaffMesh(
      22.0,
      0.62,
      this.uDharmakayaOpacity,
      true,
    );
    skyStaff.position.set(0, 0, 5.2);
    this.dharmakayaArmPivot.add(skyStaff);
    this.dharmakayaRoot.add(this.dharmakayaArmPivot);

    this.skill3MantraGroup.add(this.dharmakayaRoot);
    // Keep skill3MantraGroup detached from scene graph when inactive
    return mantraMesh;
  }

  private buildSkill3FinisherVfx(): void {
    this.skill3FinisherGroup.name = 'WukongSkill3FinisherExplosionGroup';
    this.skill3FinisherGroup.visible = false;

    const fade = pow(float(1.0).sub(this.uFinisherProgress), 1.5);

    // 1. 28-Meter Celestial Golden Heaven-Pillar Beam ("贯日金光神柱", balanced HDR so Dharmakaya & Boss remain crisp inside!)
    const beamGeo = new THREE.CylinderGeometry(0.95, 1.95, 28.0, 28, 1, true);
    beamGeo.translate(0, 14.0, 0);
    this.ownedGeometries.push(beamGeo);

    const beamMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill3FinisherBeamMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const bUv = uv();
    const vertFade = smoothstep(0.0, 0.05, bUv.y).mul(smoothstep(1.0, 0.18, bUv.y));
    const spiral = sin(bUv.x.mul(18.85).add(bUv.y.mul(14.0)).sub(this.uTime.mul(14.0)))
      .mul(0.5)
      .add(0.5);
    beamMat.colorNode = mix(color(0xff8c16), color(0xffeaa0), spiral).mul(float(1.42));
    beamMat.opacityNode = vertFade.mul(fade).mul(float(0.62));
    this.ownedMaterials.push(beamMat);

    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.frustumCulled = false;
    this.skill3FinisherGroup.add(beamMesh);

    // 2. 24-Meter Radial Golden Reality-Shatter Ground Star ("万钧碎界金裂神纹")!
    const craterGeo = new THREE.PlaneGeometry(24.0, 24.0, 1, 1);
    craterGeo.rotateX(-Math.PI / 2);
    this.ownedGeometries.push(craterGeo);

    const craterMat = new MeshBasicNodeMaterial({
      name: 'WukongSkill3FinisherCraterMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cP = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const cR = length(cP);
    const cAng = atan(cP.y, cP.x);
    const rays = pow(abs(cos(cAng.mul(9.0).add(sin(cR.mul(12.0)).mul(0.45)))), 8.0);
    const shockRing = smoothstep(
      0.08,
      0.008,
      abs(cR.sub(mix(float(0.12), float(0.95), this.uFinisherProgress))),
    );
    const coreFlash = smoothstep(0.38, 0.0, cR);
    const cMask = saturate(rays.mul(smoothstep(0.95, 0.1, cR)).add(shockRing).add(coreFlash));
    craterMat.colorNode = mix(color(0xff8416), color(0xfffbe2), saturate(coreFlash.add(shockRing))).mul(float(2.1));
    craterMat.opacityNode = cMask.mul(smoothstep(0.98, 0.88, cR)).mul(fade).mul(float(0.95));
    this.ownedMaterials.push(craterMat);

    const craterMesh = new THREE.Mesh(craterGeo, craterMat);
    craterMesh.position.y = 0.075;
    craterMesh.frustumCulled = false;
    setObjectLayerRecursive(craterMesh, LAYER_MAIN_ONLY);
    this.skill3FinisherGroup.add(craterMesh);

    this.group.add(this.skill3FinisherGroup);
  }

  private buildIntroCinematicVfx(): void {
    // 1. Shot 2: Sleek Layered Golden Somersault Cloud Ribbons ("金色筋斗云流 + 流云彩带", elevated >= 0.45m)!
    this.introCloudGroup.name = 'WukongIntroSomersaultCloudGroup';
    this.introCloudGroup.visible = false;

    const cloudMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroCloudMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const cUv = uv();
    const acrossFade = pow(sin(cUv.y.mul(Math.PI)), 1.65);
    const endFade = smoothstep(0.0, 0.14, cUv.x).mul(smoothstep(1.0, 0.78, cUv.x));
    const wisp = sin(cUv.x.mul(16.0).sub(this.uTime.mul(7.5)))
      .mul(0.22)
      .add(0.78);
    cloudMat.colorNode = mix(color(0xd87618), color(0xffe69c), wisp).mul(float(1.12));
    cloudMat.opacityNode = this.uIntroCloudAlpha
      .mul(acrossFade)
      .mul(endFade)
      .mul(wisp)
      .mul(float(0.56));
    this.ownedMaterials.push(cloudMat);

    // 3 Sweeping Golden Cloud-Scroll Ribbons trailing behind/above Wukong's dive arc (strictly y >= 0.55m)
    const ribbonSpecs: ReadonlyArray<{ xOff: number; zOff: number; radius: number; phase: number; amp: number }> = [
      { xOff: -0.95, zOff: 0.9, radius: 0.16, phase: 0.0, amp: 0.42 },
      { xOff: -1.45, zOff: 1.35, radius: 0.12, phase: 1.9, amp: 0.55 },
      { xOff: -0.6, zOff: 1.65, radius: 0.09, phase: 3.6, amp: 0.36 },
    ];
    for (const spec of ribbonSpecs) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i += 1) {
        const t = i / 24;
        pts.push(
          new THREE.Vector3(
            spec.xOff - t * 3.8 + Math.sin(t * 7.2 + spec.phase) * spec.amp,
            0.65 + t * t * 9.8 + Math.sin(t * Math.PI * 2 + spec.phase) * 0.14,
            spec.zOff + t * 6.4 + Math.cos(t * 5.8 + spec.phase) * spec.amp * 0.8,
          ),
        );
      }
      const tailGeo = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(pts),
        32,
        spec.radius,
        8,
        false,
      );
      this.ownedGeometries.push(tailGeo);
      const tailMesh = new THREE.Mesh(tailGeo, cloudMat);
      tailMesh.frustumCulled = false;
      this.introCloudGroup.add(tailMesh);
    }

    // 3 Layered Soft Cloud-Wisp Scroll Planes framing the skyward trail (elevated above y >= 0.65m)
    for (let i = 0; i < 3; i += 1) {
      const wispGeo = new THREE.PlaneGeometry(3.2 - i * 0.35, 0.78 - i * 0.08, 16, 1);
      const posAttr = wispGeo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < posAttr.count; v += 1) {
        const vx = posAttr.getX(v);
        const vy = posAttr.getY(v);
        const curveZ = Math.sin(vx * 0.9 + i * 1.1) * 0.42;
        const liftY = vx * vx * 0.14 + (vx + 1.6) * 0.22;
        posAttr.setXYZ(v, vx, Math.max(-0.2, vy) + liftY, curveZ);
      }
      posAttr.needsUpdate = true;
      wispGeo.computeVertexNormals();
      this.ownedGeometries.push(wispGeo);

      const wispMesh = new THREE.Mesh(wispGeo, cloudMat);
      wispMesh.position.set(-1.35 - i * 0.75, 0.95 + i * 0.85, 1.45 + i * 1.15);
      wispMesh.rotation.set(0.22 + i * 0.08, -0.58 + i * 0.18, 0.28);
      wispMesh.frustumCulled = false;
      this.introCloudGroup.add(wispMesh);
    }
    this.group.add(this.introCloudGroup);

    // 2. Shot 3: Blinding Miniature Golden Sanskrit Ear-Needle Starburst ("耳畔微缩梵文金针")!
    this.introEarNeedleGroup.name = 'WukongIntroEarNeedleGroup';
    this.introEarNeedleGroup.visible = false;

    const needleMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroEarNeedleMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const nUv = uv();
    const spike = pow(
      float(1.0).sub(saturate(abs(nUv.x.sub(0.5)).mul(2.0))),
      1.5,
    ).mul(pow(float(1.0).sub(saturate(abs(nUv.y.sub(0.5)).mul(2.0))), 2.6));
    needleMat.colorNode = mix(color(0xffa41c), color(0xffffff), spike).mul(float(2.25));
    needleMat.opacityNode = spike.mul(this.uIntroNeedleAlpha);
    this.ownedMaterials.push(needleMat);

    const needleGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.34, 10);
    needleGeo.rotateZ(Math.PI * 0.46);
    this.ownedGeometries.push(needleGeo);
    const needleCoreMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroEarNeedleCoreMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    needleCoreMat.colorNode = color(0xfff4c2).mul(float(2.4));
    needleCoreMat.opacityNode = this.uIntroNeedleAlpha;
    this.ownedMaterials.push(needleCoreMat);
    const needleMesh = new THREE.Mesh(needleGeo, needleCoreMat);
    needleMesh.frustumCulled = false;
    this.introEarNeedleGroup.add(needleMesh);

    const flareGeo = new THREE.PlaneGeometry(1.15, 0.18);
    this.ownedGeometries.push(flareGeo);
    for (const [rx, ry, rz] of [
      [0, 0, 0.15],
      [0, 0, 1.72],
      [0, Math.PI * 0.5, 0.25],
    ] as const) {
      const f = new THREE.Mesh(flareGeo, needleMat);
      f.rotation.set(rx, ry, rz);
      f.frustumCulled = false;
      this.introEarNeedleGroup.add(f);
    }
    this.group.add(this.introEarNeedleGroup);

    // 3. Shot 4: Coiling 3D Golden Dragon Aura behind Wukong + Twin Gold-vs-Crimson Clash Wall!
    this.introDragonAuraGroup.name = 'WukongIntroDragonAuraGroup';
    this.introDragonAuraGroup.visible = false;

    const dragonPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i += 1) {
      const t = i / 32;
      dragonPts.push(
        new THREE.Vector3(
          Math.sin(t * Math.PI * 3.0) * 0.85,
          0.6 + t * 3.6 + Math.cos(t * Math.PI * 2.0) * 0.35,
          2.2 - t * 4.4,
        ),
      );
    }
    const dragonGeo = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(dragonPts),
      40,
      0.22,
      10,
      false,
    );
    this.ownedGeometries.push(dragonGeo);
    const dragonMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroDragonAuraMat',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const drUv = uv();
    const scalePulse = sin(drUv.x.mul(28.0).sub(this.uTime.mul(12.0))).mul(0.25).add(0.75);
    dragonMat.colorNode = mix(color(0xff8c18), color(0xfff0b2), scalePulse).mul(float(1.65));
    dragonMat.opacityNode = this.uIntroDragonAlpha.mul(
      smoothstep(0.0, 0.12, drUv.x).mul(smoothstep(1.0, 0.85, drUv.x)),
    );
    this.ownedMaterials.push(dragonMat);
    const dragonMesh = new THREE.Mesh(dragonGeo, dragonMat);
    dragonMesh.frustumCulled = false;
    this.introDragonAuraGroup.add(dragonMesh);
    this.group.add(this.introDragonAuraGroup);

    // Twin Clash Ground Wave & Vertical Collision Curtain (Gold +Z vs Blood-Crimson -Z)
    this.introClashGroup.name = 'WukongIntroTwinClashGroup';
    this.introClashGroup.visible = false;

    const clashPlaneGeo = new THREE.PlaneGeometry(18.0, 18.0, 1, 1);
    clashPlaneGeo.rotateX(-Math.PI / 2);
    this.ownedGeometries.push(clashPlaneGeo);

    const cp = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const cr = length(cp);
    const fade = pow(float(1.0).sub(this.uIntroClashProgress), 1.45);
    const sideSplit = smoothstep(-0.08, 0.08, cp.y);
    const dualColor = mix(color(0xd91e2a), color(0xffbe36), sideSplit);

    // Crisp hollow expanding shockwave ring (strictly 0 inside r < 0.65 and outside r > 0.96)
    const clashFloorMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroTwinClashFloorMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const hollowMask = smoothstep(0.65, 0.70, cr).mul(smoothstep(0.96, 0.91, cr));
    const floorRingTarget = mix(float(0.68), float(0.92), this.uIntroClashProgress);
    const floorRing = smoothstep(0.085, 0.008, abs(cr.sub(floorRingTarget))).mul(hollowMask);
    clashFloorMat.colorNode = dualColor.mul(float(0.55));
    clashFloorMat.opacityNode = floorRing.mul(fade).mul(float(0.68));
    this.ownedMaterials.push(clashFloorMat);

    const clashFloor = new THREE.Mesh(clashPlaneGeo, clashFloorMat);
    clashFloor.position.y = 0.065;
    clashFloor.frustumCulled = false;
    setObjectLayerRecursive(clashFloor, LAYER_MAIN_ONLY);
    this.introClashGroup.add(clashFloor);

    const clashMat = new MeshBasicNodeMaterial({
      name: 'WukongIntroTwinClashMat',
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const ring = smoothstep(
      0.11,
      0.008,
      abs(cr.sub(mix(float(0.08), float(0.95), this.uIntroClashProgress))),
    );
    const centerFault = smoothstep(0.14, 0.0, abs(cp.y)).mul(smoothstep(0.95, 0.1, abs(cp.x)));
    clashMat.colorNode = mix(dualColor, color(0xfff8dc), centerFault).mul(float(0.55));
    clashMat.opacityNode = saturate(ring.add(centerFault)).mul(fade).mul(float(0.46));
    this.ownedMaterials.push(clashMat);

    const curtainGeo = new THREE.PlaneGeometry(14.0, 7.5, 1, 1);
    curtainGeo.translate(0, 3.75, 0);
    this.ownedGeometries.push(curtainGeo);
    const curtainMesh = new THREE.Mesh(curtainGeo, clashMat);
    curtainMesh.rotation.y = Math.PI * 0.5;
    curtainMesh.frustumCulled = false;
    this.introClashGroup.add(curtainMesh);

    this.group.add(this.introClashGroup);
  }

  // ===========================================================================
  // Public Triggers
  // ===========================================================================

  spawnPlayerHitSparks(
    pos: Vec3Like,
    knockDirX: number,
    knockDirZ: number,
    heavy: boolean,
  ): void {
    if (this.disposed) return;
    let slot = this.hitRingPool.find((s) => !s.active);
    if (!slot) slot = this.hitRingPool[0]!;

    slot.active = true;
    slot.elapsed = 0;
    slot.duration = heavy ? 0.52 : 0.3;
    slot.heavy = heavy;
    slot.uProgress.value = 0;

    const px = sanitize(pos.x);
    const py = sanitize(pos.y);
    const pz = sanitize(pos.z);
    slot.group.position.set(px, py + (heavy ? 0.95 : 1.18), pz);
    slot.group.rotation.y = Math.atan2(-knockDirX, -knockDirZ);
    slot.group.scale.setScalar(heavy ? 1.35 : 0.82);
    slot.group.visible = true;

    for (let i = 0; i < slot.shards.length; i += 1) {
      const sh = slot.shards[i]!;
      const ang = (i / slot.shards.length) * Math.PI * 2;
      const spd = (heavy ? 6.5 : 3.8) + (i % 3) * 1.6;
      sh.mesh.position.set(0, 0, 0);
      sh.vx = Math.cos(ang) * spd + knockDirX * 2.5;
      sh.vy = (heavy ? 3.8 : 2.1) + (i % 2) * 1.5;
      sh.vz = Math.sin(ang) * spd + knockDirZ * 2.5;
    }
  }

  private spawnLightningSegment(from: Vec3Like, to: Vec3Like, duration = 0.32): void {
    let bolt = this.lightningPool.find((b) => !b.active);
    if (!bolt) bolt = this.lightningPool[0]!;

    const dx = sanitize(to.x) - sanitize(from.x);
    const dy = sanitize(to.y) - sanitize(from.y);
    const dz = sanitize(to.z) - sanitize(from.z);
    const dist = Math.max(0.5, Math.hypot(dx, dy, dz));

    bolt.active = true;
    bolt.elapsed = 0;
    bolt.duration = duration;
    bolt.uProgress.value = 0;
    bolt.mesh.position.set(sanitize(from.x), sanitize(from.y) + 1.05, sanitize(from.z));
    bolt.mesh.scale.set(1.1, dist, 1.0);

    const dir = this.tmpBoltDir.set(dx, dy, dz).normalize();
    bolt.mesh.quaternion.setFromUnitVectors(this.tmpBoltUp, dir);
    bolt.mesh.visible = true;
  }

  spawnSkill1CloneBlitz(
    startPos: Vec3Like,
    endPos: Vec3Like,
    bossPos: Vec3Like,
  ): void {
    if (this.disposed) return;

    this.spawnLightningSegment(startPos, endPos, 0.36);

    const bx = sanitize(bossPos.x);
    const bz = sanitize(bossPos.z);
    const baseYaw = Math.atan2(
      bx - sanitize(startPos.x),
      bz - sanitize(startPos.z),
    );

    // 4 Flanking Golden Monkey Clones: Left (-72°), Right (+72°), Overhead-Front (0°, y=+2.75m), Rear (+162°)
    const offsets: ReadonlyArray<{ angleOffset: number; startR: number; endR: number; startY: number }> = [
      { angleOffset: -1.26, startR: 5.8, endR: 2.15, startY: 0.1 },
      { angleOffset: 1.26, startR: 5.8, endR: 2.15, startY: 0.1 },
      { angleOffset: 0.12, startR: 5.2, endR: 2.05, startY: 2.75 },
      { angleOffset: 2.82, startR: 5.5, endR: 2.25, startY: 0.25 },
    ];

    for (let i = 0; i < this.goldenClones.length; i += 1) {
      const clone = this.goldenClones[i]!;
      const cfg = offsets[i]!;
      const worldAng = baseYaw + Math.PI + cfg.angleOffset;
      clone.active = true;
      clone.elapsed = 0;
      clone.duration = 0.62;
      clone.startX = bx + Math.sin(worldAng) * cfg.startR;
      clone.startY = cfg.startY;
      clone.startZ = bz + Math.cos(worldAng) * cfg.startR;
      clone.endX = bx + Math.sin(worldAng) * cfg.endR;
      clone.endY = 0;
      clone.endZ = bz + Math.cos(worldAng) * cfg.endR;
      clone.targetX = bx;
      clone.targetZ = bz;
      clone.uOpacity.value = 0.95;
      clone.group.position.set(clone.startX, clone.startY, clone.startZ);
      clone.group.rotation.y = Math.atan2(bx - clone.startX, bz - clone.startZ);
      if (clone.group.parent !== this.group) {
        this.group.add(clone.group);
      }
      clone.group.visible = true;
    }
  }

  triggerSkill1CloneSlash(bossPos: Vec3Like, hitIndex: number): void {
    if (this.disposed) return;
    const slot = this.goldenArcWeb[this.arcCursor % this.goldenArcWeb.length]!;
    this.arcCursor += 1;

    const tilts: ReadonlyArray<[number, number, number]> = [
      [0.48, 0.25, -0.56],
      [-0.48, 1.35, 0.58],
      [0.82, 2.45, -0.34],
      [-0.76, -0.85, 0.72],
    ];
    const [rx, ry, rz] = tilts[hitIndex % tilts.length]!;

    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 0.42;
    slot.baseScale = 1.25 + (hitIndex % 2) * 0.22;
    slot.uProgress.value = 0;
    slot.group.position.set(
      sanitize(bossPos.x),
      1.65 + (hitIndex % 3) * 0.42,
      sanitize(bossPos.z),
    );
    slot.group.rotation.set(rx, ry, rz);
    slot.group.scale.setScalar(slot.baseScale * 0.75);
    slot.group.visible = true;
  }

  spawnSkill2PillarAscent(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    this.skill2AscentActive = true;
    this.skill2AscentElapsed = 0;
    this.uSkill2AscentProgress.value = 0;
    this.skill2AscentGroup.position.set(sanitize(playerPos.x), 0, sanitize(playerPos.z));
    this.skill2AscentGroup.rotation.y = Math.atan2(
      sanitize(bossPos.x) - sanitize(playerPos.x),
      sanitize(bossPos.z) - sanitize(playerPos.z),
    );
    this.skill2AscentGroup.visible = true;
  }

  spawnSkill2DragonPillarSlam(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    const px = sanitize(playerPos.x);
    const pz = sanitize(playerPos.z);
    const bx = sanitize(bossPos.x);
    const bz = sanitize(bossPos.z);
    const yaw = Math.atan2(bx - px, bz - pz);

    this.skill2SlamActive = true;
    this.skill2SlamElapsed = 0;
    this.uSkill2PillarFade.value = 1.0;
    this.uSkill2FissureFade.value = 1.0;
    this.uSkill2DomeProgress.value = 0;

    this.skill2SlamGroup.position.set(bx, 0, bz);
    this.skill2SlamGroup.rotation.y = yaw;
    this.skill2DragonPillarPivot.rotation.set(-0.95, 0, 0);
    this.skill2FissureMesh.position.set(0, 0.055, 2.2);
    this.skill2DomeMesh.scale.setScalar(1.2);
    this.skill2DomeMesh.visible = true;
    this.skill2SlamGroup.visible = true;
  }

  updateSkill3GreatSageDomain(
    active: boolean,
    playerPos?: Vec3Like,
    bossPos?: Vec3Like,
    facingYaw?: number,
  ): void {
    if (this.disposed) return;

    if (!active) {
      this.skill3DomainActive = false;
      // If detonation just slammed, let the 15.5m Dharmakaya & Golden Mantra linger smoothly for 0.85s!
      if (!this.dharmakayaSlamTriggered) {
        this.dharmakayaLingerTimer = 0;
        this.skill3MantraGroup.visible = false;
        this.skill3MantraGroup.removeFromParent();
      } else {
        this.dharmakayaLingerTimer = Math.max(this.dharmakayaLingerTimer, 0.85);
      }
      return;
    }

    const px = sanitize(playerPos?.x ?? 0);
    const pz = sanitize(playerPos?.z ?? 4);
    const bx = sanitize(bossPos?.x ?? 0);
    const bz = sanitize(bossPos?.z ?? -5);
    const yaw = Number.isFinite(facingYaw)
      ? (facingYaw as number)
      : Math.atan2(bx - px, bz - pz);
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);

    this.skill3DomainActive = true;
    this.dharmakayaSlamTriggered = false;
    this.dharmakayaSlamElapsed = 0;
    this.dharmakayaLingerTimer = 0.85;
    this.uMantraOpacity.value = 1.0;
    this.uDharmakayaOpacity.value = 0.95;

    // Center the 26m Golden Sanskrit Mantra Array between Wukong and Boss Jiebo
    const midX = (px + bx) * 0.5;
    const midZ = (pz + bz) * 0.5;
    this.skill3MantraGroup.position.set(midX, 0, midZ);

    // Rise the colossal 15m Great Sage Dharmakaya 3.2m behind Wukong & slightly left-flank so the 3/4 camera frames 100% of Wukong + Giant Dharmakaya + Boss Jiebo!
    const rightX = dirZ;
    const rightZ = -dirX;
    const avatarWorldX = px - dirX * 3.2 - rightX * 2.4;
    const avatarWorldZ = pz - dirZ * 3.2 - rightZ * 2.4;
    this.dharmakayaRoot.position.set(
      avatarWorldX - midX,
      0,
      avatarWorldZ - midZ,
    );
    this.dharmakayaRoot.rotation.y = Math.atan2(bx - avatarWorldX, bz - avatarWorldZ);
    // Raise the 24m Golden Ruyi Jingu Bang diagonally overhead during the 6 reality slashes!
    this.dharmakayaArmPivot.rotation.set(-0.92, 0, -0.22);

    if (this.skill3MantraGroup.parent !== this.group) {
      this.group.add(this.skill3MantraGroup);
    }
    this.skill3MantraGroup.visible = true;
  }

  triggerSkill3CloneBlitzSlash(bossPos: Vec3Like, slashIndex: number): void {
    if (this.disposed) return;
    const bx = sanitize(bossPos.x);
    const bz = sanitize(bossPos.z);

    // Cycle a Golden Monkey Clone streaking right across the frozen Boss on each slash!
    const clone = this.goldenClones[slashIndex % this.goldenClones.length]!;
    const ang = (slashIndex / 6) * Math.PI * 2 + 0.4;
    clone.active = true;
    clone.elapsed = 0;
    clone.duration = 0.48;
    clone.startX = bx + Math.cos(ang) * 5.6;
    clone.startY = slashIndex % 2 === 0 ? 0.25 : 2.1;
    clone.startZ = bz + Math.sin(ang) * 5.6;
    clone.endX = bx - Math.cos(ang) * 2.8;
    clone.endY = 0;
    clone.endZ = bz - Math.sin(ang) * 2.8;
    clone.targetX = bx;
    clone.targetZ = bz;
    clone.uOpacity.value = 0.98;
    clone.group.position.set(clone.startX, clone.startY, clone.startZ);
    clone.group.rotation.y = Math.atan2(bx - clone.startX, bz - clone.startZ);
    if (clone.group.parent !== this.group) {
      this.group.add(clone.group);
    }
    clone.group.visible = true;

    this.triggerSkill1CloneSlash(bossPos, slashIndex);
  }

  triggerSkill3DharmakayaSlam(playerPos: Vec3Like, bossPos: Vec3Like): void {
    if (this.disposed) return;
    const bx = sanitize(bossPos.x);
    const bz = sanitize(bossPos.z);

    this.dharmakayaSlamTriggered = true;
    this.dharmakayaSlamElapsed = 0;
    this.dharmakayaLingerTimer = 1.05;

    this.skill3FinisherActive = true;
    this.skill3FinisherElapsed = 0;
    this.uFinisherProgress.value = 0;
    this.skill3FinisherGroup.position.set(bx, 0, bz);
    this.skill3FinisherGroup.rotation.y = Math.atan2(
      bx - sanitize(playerPos.x),
      bz - sanitize(playerPos.z),
    );
    this.skill3FinisherGroup.visible = true;
  }

  updateIntroCinematicVfx(
    active: boolean,
    progress = 0,
    playerPos?: Vec3Like,
    earPos?: Vec3Like,
  ): void {
    if (this.disposed) return;
    if (!active) {
      this.introCloudGroup.visible = false;
      this.introEarNeedleGroup.visible = false;
      this.introDragonAuraGroup.visible = false;
      return;
    }

    const p = clamp01(progress);
    const px = sanitize(playerPos?.x ?? 0);
    const pz = sanitize(playerPos?.z ?? 4);

    // Shot 2 (0.25..0.52): Golden Somersault Cloud trail & swirling ground cloud!
    if (p >= 0.25 && p < 0.52) {
      const fadeOut = 1 - smoothstepScalar(0.42, 0.52, p);
      this.uIntroCloudAlpha.value = 0.92 * fadeOut;
      this.introCloudGroup.position.set(px, 0, pz);
      this.introCloudGroup.visible = true;
    } else {
      this.introCloudGroup.visible = false;
    }

    // Shot 3 (0.53..0.635): Gleaming Golden Sanskrit Ear-Needle Starburst!
    if (p >= 0.53 && p < 0.64 && earPos) {
      const pulse = Math.sin(((p - 0.53) / 0.11) * Math.PI);
      this.uIntroNeedleAlpha.value = Math.min(1, pulse * 1.35);
      this.introEarNeedleGroup.position.set(
        sanitize(earPos.x),
        sanitize(earPos.y),
        sanitize(earPos.z),
      );
      this.introEarNeedleGroup.rotation.z = p * 18.0;
      this.introEarNeedleGroup.visible = true;
    } else {
      this.introEarNeedleGroup.visible = false;
    }

    // Shot 4 (0.78..0.94): Coiling 3D Golden Dragon Aura rising behind Wukong!
    if (p >= 0.78 && p < 0.94) {
      const drFade = Math.sin(((p - 0.78) / 0.16) * Math.PI);
      this.uIntroDragonAlpha.value = drFade * 0.88;
      this.introDragonAuraGroup.position.set(px, 0, pz);
      this.introDragonAuraGroup.visible = true;
    } else {
      this.introDragonAuraGroup.visible = false;
    }
  }

  triggerIntroClashShockwave(centerPos: Vec3Like): void {
    if (this.disposed) return;
    this.introClashActive = true;
    this.introClashElapsed = 0;
    this.uIntroClashProgress.value = 0;
    this.introClashGroup.position.set(
      sanitize(centerPos.x),
      0,
      sanitize(centerPos.z),
    );
    this.introClashGroup.visible = true;
  }

  private syncNodeWorld(node: THREE.Object3D | undefined): void {
    if (!node) return;
    node.updateMatrix();
    if (node.parent) {
      node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
    } else {
      node.matrixWorld.copy(node.matrix);
    }
  }

  private poseDharmakayaArms(slamProgress: number): void {
    if (this.dharmakayaLimbs.restQuats.length === 0) return;

    // Reset giant arms to rest bind before solving current overhead/slam pose
    for (const entry of this.dharmakayaLimbs.restQuats) {
      entry.bone.quaternion.copy(entry.quat);
    }

    // Update only Dharmakaya root + arm ancestor chain (no full 499-node subtree recursion)
    this.dharmakayaRoot.updateWorldMatrix(true, false);
    for (let i = 0; i < this.dharmakayaArmAncestors.length; i += 1) {
      this.syncNodeWorld(this.dharmakayaArmAncestors[i]);
    }

    const rootWQ = this.dharmakayaRoot.getWorldQuaternion(this.dkRootWQ);
    const posA = this.dkPosA;
    const posB = this.dkPosB;
    const curDir = this.dkCurDir;
    const tgtDir = this.dkTgtDir;
    const parentWQ = this.dkParentWQ;
    const curWQ = this.dkCurWQ;
    const deltaQ = this.dkDeltaQ;

    const aimGiantLimb = (
      bone: THREE.Bone | undefined,
      child: THREE.Bone | undefined,
      ex: number,
      ey: number,
      ez: number,
    ): void => {
      if (!bone || !child || !bone.parent) return;
      bone.getWorldPosition(posA);
      child.getWorldPosition(posB);
      curDir.copy(posB).sub(posA).normalize();
      tgtDir.set(ex, ey, ez).normalize().applyQuaternion(rootWQ);
      if (curDir.lengthSq() < 0.5 || tgtDir.lengthSq() < 0.5) return;
      deltaQ.setFromUnitVectors(curDir, tgtDir);
      bone.parent.getWorldQuaternion(parentWQ);
      bone.getWorldQuaternion(curWQ);
      this.dkTargetWQ.copy(deltaQ).multiply(curWQ);
      bone.quaternion.copy(parentWQ.invert().multiply(this.dkTargetWQ)).normalize();
      this.syncNodeWorld(bone);
      this.syncNodeWorld(child);
      if (bone === this.dharmakayaLimbs.upperArmR && this.dharmakayaLimbs.handR) {
        this.syncNodeWorld(this.dharmakayaLimbs.handR);
      } else if (bone === this.dharmakayaLimbs.upperArmL && this.dharmakayaLimbs.handL) {
        this.syncNodeWorld(this.dharmakayaLimbs.handL);
      }
    };

    const s = clamp01(slamProgress);
    const uY = 0.85 * (1 - s) - 0.36 * s;
    const uZ = 0.34 * (1 - s) + 0.88 * s;
    const fY = 0.88 * (1 - s) - 0.44 * s;
    const fZ = 0.42 * (1 - s) + 0.88 * s;

    // Both giant golden arms raised heroically overhead -> swinging down in unison onto Boss Jiebo!
    aimGiantLimb(this.dharmakayaLimbs.upperArmR, this.dharmakayaLimbs.lowerArmR, -0.34, uY, uZ);
    aimGiantLimb(this.dharmakayaLimbs.lowerArmR, this.dharmakayaLimbs.handR, 0.22, fY, fZ);
    aimGiantLimb(this.dharmakayaLimbs.upperArmL, this.dharmakayaLimbs.lowerArmL, 0.34, uY, uZ);
    aimGiantLimb(this.dharmakayaLimbs.lowerArmL, this.dharmakayaLimbs.handL, -0.22, fY, fZ);

    // Anchor the 22m Golden Dragon-Pillar right between the Dharmakaya's raised hands!
    this.dharmakayaArmPivot.position.set(
      0,
      10.8 * (1 - s) + 6.8 * s,
      1.2 + s * 2.4,
    );
    this.dharmakayaArmPivot.rotation.set(-0.88 + s * 1.32, 0, 0);

    // Single propagation pass for unvisited leaf/finger/pillar children
    this.dharmakayaRoot.updateMatrixWorld(false);
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;

    this.uTime.value += dt;

    // 0. Player Hit Guard Flash & Knockdown Shards
    for (const slot of this.hitRingPool) {
      if (!slot.active) continue;
      slot.elapsed += dt;
      const p = clamp01(slot.elapsed / slot.duration);
      slot.uProgress.value = p;
      const base = slot.heavy ? 1.35 : 0.82;
      slot.group.scale.setScalar(base * (0.75 + p * 1.45));
      for (const sh of slot.shards) {
        sh.mesh.position.x += sh.vx * dt;
        sh.mesh.position.y += sh.vy * dt;
        sh.mesh.position.z += sh.vz * dt;
        sh.vy -= 12.0 * dt;
        sh.mesh.rotation.x += sh.rx * dt;
        sh.mesh.rotation.z += sh.rz * dt;
      }
      if (slot.elapsed >= slot.duration) {
        slot.active = false;
        slot.group.visible = false;
      }
    }

    // 1. Skill 1 & 3: 4 3D Golden Monkey King Clones
    for (const clone of this.goldenClones) {
      if (!clone.active) continue;
      clone.elapsed += dt;
      const p = clamp01(clone.elapsed / clone.duration);
      const lunge = 1 - Math.pow(1 - Math.min(1, p / 0.55), 2.4);
      const curX = clone.startX + (clone.endX - clone.startX) * lunge;
      const curY = clone.startY * (1 - lunge);
      const curZ = clone.startZ + (clone.endZ - clone.startZ) * lunge;
      clone.group.position.set(curX, curY, curZ);
      clone.group.rotation.y = Math.atan2(
        clone.targetX - curX,
        clone.targetZ - curZ,
      );
      clone.staffGroup.rotation.set(
        0.18,
        clone.swingSign * (-1.15 + smoothstepScalar(0.08, 0.72, p) * 2.3),
        0.24 * clone.swingSign,
      );
      clone.uOpacity.value = (1 - p * p) * 0.95;

      if (clone.elapsed >= clone.duration) {
        clone.active = false;
        clone.group.visible = false;
        clone.group.removeFromParent();
      }
    }

    // Golden Staff-Cage Web Arcs
    for (const arc of this.goldenArcWeb) {
      if (!arc.active) continue;
      arc.elapsed += dt;
      const p = clamp01(arc.elapsed / arc.duration);
      arc.uProgress.value = p;
      arc.group.scale.setScalar(arc.baseScale * (0.78 + p * 0.52));
      if (arc.elapsed >= arc.duration) {
        arc.active = false;
        arc.group.visible = false;
      }
    }

    // Golden Dash Lightning Bolts
    for (const bolt of this.lightningPool) {
      if (!bolt.active) continue;
      bolt.elapsed += dt;
      bolt.uProgress.value = clamp01(bolt.elapsed / bolt.duration);
      if (bolt.elapsed >= bolt.duration) {
        bolt.active = false;
        bolt.mesh.visible = false;
      }
    }

    // 2. Skill 2 Stage A: Ascent Pillar & Cloud Vortex
    if (this.skill2AscentActive) {
      this.skill2AscentElapsed += dt;
      const p = clamp01(this.skill2AscentElapsed / this.skill2AscentDuration);
      this.uSkill2AscentProgress.value = p;
      this.skill2AscentGroup.rotation.y += dt * 4.5;
      if (this.skill2AscentElapsed >= this.skill2AscentDuration) {
        this.skill2AscentActive = false;
        this.skill2AscentGroup.visible = false;
      }
    }

    // Skill 2 Stage B: Colossal 16.5m Carved Dragon-Pillar & 21m S-Curve Golden Dragon Ground Fissure
    if (this.skill2SlamActive) {
      this.skill2SlamElapsed += dt;
      const slamDrop = smoothstepScalar(0.0, 0.12, this.skill2SlamElapsed);
      // Plunge diagonally from -0.95 rad overhead to -0.18 rad towering 16.5m above Boss Jiebo!
      this.skill2DragonPillarPivot.rotation.set(
        -0.95 + slamDrop * 0.77,
        0,
        0.22,
      );

      const pPillar = clamp01(this.skill2SlamElapsed / this.skill2PillarDuration);
      this.uSkill2PillarFade.value = Math.pow(1 - pPillar, 1.45);
      this.skill2DragonPillarPivot.visible = pPillar < 1.0;

      const pDome = clamp01(this.skill2SlamElapsed / 0.52);
      this.uSkill2DomeProgress.value = pDome;
      const ringScale = 1.2 + (1 - Math.pow(1 - pDome, 2.2)) * 9.8;
      this.skill2DomeMesh.scale.set(ringScale, 1.0, ringScale);
      this.skill2DomeMesh.visible = pDome < 1.0;

      const pFissure = clamp01(this.skill2SlamElapsed / this.skill2FissureDuration);
      this.uSkill2FissureFade.value = Math.pow(1 - pFissure, 1.35);

      if (this.skill2SlamElapsed >= this.skill2FissureDuration) {
        this.skill2SlamActive = false;
        this.skill2SlamGroup.visible = false;
      }
    }

    // 3. Skill 3: 26m Golden Mantra Circle + 14.5m Great Sage Dharmakaya
    if (this.skill3MantraGroup.visible) {
      this.skill3MantraMesh.rotation.z += dt * 0.28;

      if (this.dharmakayaSlamTriggered) {
        this.dharmakayaSlamElapsed += dt;
        const slamT = smoothstepScalar(0.0, 0.18, this.dharmakayaSlamElapsed);
        this.poseDharmakayaArms(slamT);
      } else {
        this.poseDharmakayaArms(0);
      }

      if (!this.skill3DomainActive) {
        this.dharmakayaLingerTimer = Math.max(0, this.dharmakayaLingerTimer - dt);
        const fade = clamp01(this.dharmakayaLingerTimer / 0.85);
        this.uMantraOpacity.value = fade;
        this.uDharmakayaOpacity.value = fade * 0.95;
        if (this.dharmakayaLingerTimer <= 0) {
          this.skill3MantraGroup.visible = false;
          this.skill3MantraGroup.removeFromParent();
          this.dharmakayaSlamTriggered = false;
        }
      }
    }

    // Skill 3: 28m Finisher Heaven-Pillar & Radial Reality-Shatter Crater
    if (this.skill3FinisherActive) {
      this.skill3FinisherElapsed += dt;
      const p = clamp01(this.skill3FinisherElapsed / this.skill3FinisherDuration);
      this.uFinisherProgress.value = p;
      if (this.skill3FinisherElapsed >= this.skill3FinisherDuration) {
        this.skill3FinisherActive = false;
        this.skill3FinisherGroup.visible = false;
      }
    }

    // Opening Cinematic Shot 4 Twin Clash Wave
    if (this.introClashActive) {
      this.introClashElapsed += dt;
      const p = clamp01(this.introClashElapsed / this.introClashDuration);
      this.uIntroClashProgress.value = p;
      if (this.introClashElapsed >= this.introClashDuration) {
        this.introClashActive = false;
        this.introClashGroup.visible = false;
      }
    }
  }

  reset(): void {
    if (this.disposed) return;
    for (const slot of this.hitRingPool) {
      slot.active = false;
      slot.group.visible = false;
    }
    for (const clone of this.goldenClones) {
      clone.active = false;
      clone.group.visible = false;
      clone.group.removeFromParent();
    }
    for (const arc of this.goldenArcWeb) {
      arc.active = false;
      arc.group.visible = false;
    }
    for (const bolt of this.lightningPool) {
      bolt.active = false;
      bolt.mesh.visible = false;
    }
    this.skill2AscentActive = false;
    this.skill2AscentGroup.visible = false;
    this.skill2SlamActive = false;
    this.skill2SlamGroup.visible = false;
    this.skill3DomainActive = false;
    this.dharmakayaLingerTimer = 0;
    this.dharmakayaSlamTriggered = false;
    this.skill3MantraGroup.visible = false;
    this.skill3MantraGroup.removeFromParent();
    this.skill3FinisherActive = false;
    this.skill3FinisherGroup.visible = false;
    this.introCloudGroup.visible = false;
    this.introEarNeedleGroup.visible = false;
    this.introDragonAuraGroup.visible = false;
    this.introClashActive = false;
    this.introClashGroup.visible = false;
  }

  setPrewarmVisible(enabled: boolean): void {
    if (this.disposed) return;
    if (enabled) {
      const clone0 = this.goldenClones[0];
      if (clone0) {
        if (clone0.group.parent !== this.group) {
          this.group.add(clone0.group);
        }
        clone0.group.scale.setScalar(0.001);
        clone0.group.visible = true;
      }
      if (this.skill3MantraGroup.parent !== this.group) {
        this.group.add(this.skill3MantraGroup);
      }
      this.skill3MantraGroup.scale.setScalar(0.001);
      this.skill3MantraGroup.visible = true;
      if (this.hitRingPool[0]) this.hitRingPool[0].group.visible = true;
      if (this.goldenArcWeb[0]) this.goldenArcWeb[0].group.visible = true;
      if (this.lightningPool[0]) this.lightningPool[0].mesh.visible = true;
      this.skill2AscentGroup.scale.setScalar(0.001);
      this.skill2AscentGroup.visible = true;
      this.skill2SlamGroup.scale.setScalar(0.001);
      this.skill2SlamGroup.visible = true;
      this.skill3FinisherGroup.scale.setScalar(0.001);
      this.skill3FinisherGroup.visible = true;
      this.introCloudGroup.scale.setScalar(0.001);
      this.introCloudGroup.visible = true;
      this.introEarNeedleGroup.scale.setScalar(0.001);
      this.introEarNeedleGroup.visible = true;
      this.introDragonAuraGroup.scale.setScalar(0.001);
      this.introDragonAuraGroup.visible = true;
      this.introClashGroup.scale.setScalar(0.001);
      this.introClashGroup.visible = true;
    } else {
      const clone0 = this.goldenClones[0];
      if (clone0) {
        clone0.group.scale.setScalar(1);
      }
      this.skill3MantraGroup.scale.setScalar(1);
      this.skill2AscentGroup.scale.setScalar(1);
      this.skill2SlamGroup.scale.setScalar(1);
      this.skill3FinisherGroup.scale.setScalar(1);
      this.introCloudGroup.scale.setScalar(1);
      this.introEarNeedleGroup.scale.setScalar(1);
      this.introDragonAuraGroup.scale.setScalar(1);
      this.introClashGroup.scale.setScalar(1);
      this.reset();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    for (const clone of this.goldenClones) {
      clone.group.clear();
    }
    this.skill3MantraGroup.clear();
    if (this.dharmakayaSkeleton) {
      this.dharmakayaSkeleton.dispose();
      this.dharmakayaSkeleton = null;
    }
    for (const geo of this.ownedGeometries) {
      geo.dispose();
    }
    for (const mat of this.ownedMaterials) {
      mat.dispose();
    }
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.group.clear();
  }
}
