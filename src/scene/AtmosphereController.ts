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
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { RendererSystem } from '../engine/RendererSystem.ts';
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import type { Vec3Like } from '../types/game.ts';

function createScalarUniform(initial: number) {
  return uniform(initial);
}

type ScalarUniform = ReturnType<typeof createScalarUniform>;

export interface AtmosphereControllerOptions {
  scene: THREE.Scene;
  rendererSystem?: RendererSystem;
  nightHdri?: THREE.DataTexture;
  duskHdri?: THREE.DataTexture;
}

interface LightningSlot {
  group: THREE.Group;
  boltMesh: THREE.Mesh;
  discMesh: THREE.Mesh;
  uAlpha: ScalarUniform;
  active: boolean;
  life: number;
  maxLife: number;
}

const LIGHTNING_POOL_SIZE = 4;
const LIGHTNING_DURATION = 0.38;
const LIGHTNING_FLASH_PEAK = 2.8;
const GOD_RAY_COUNT = 8;
const BRAZIER_COUNT = 8;
const BRAZIER_RADIUS = 27.6;

const ACT1_FOG_COLOR = new THREE.Color(0x090b14);
const ACT2_FOG_COLOR = new THREE.Color(0x1e070c);
const ACT1_HEMI_SKY = new THREE.Color(0x6f8cc8);
const ACT2_HEMI_SKY = new THREE.Color(0xb84e3c);
const ACT1_HEMI_GROUND = new THREE.Color(0x121018);
const ACT2_HEMI_GROUND = new THREE.Color(0x1c0a0e);
const ACT1_KEY_COLOR = new THREE.Color(0xdce8ff);
const ACT2_KEY_COLOR = new THREE.Color(0xff9a62);
const ACT1_RIM_COLOR = new THREE.Color(0x4c92ff);
const ACT2_RIM_COLOR = new THREE.Color(0xff3524);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function createLightningBoltGeometry(seed: number): THREE.BufferGeometry {
  const segments = 16;
  const totalHeight = 56;
  const points: THREE.Vector3[] = [];

  for (let i = 0; i <= segments; i++) {
    const frac = i / segments;
    const y = totalHeight * (1 - frac);
    const envelope = Math.sin(frac * Math.PI);
    const jx =
      (Math.sin(i * 2.7 + seed * 3.1) * 1.65 +
        Math.cos(i * 5.3 + seed * 1.9) * 0.75) *
      envelope;
    const jz =
      (Math.cos(i * 3.1 + seed * 2.3) * 1.65 +
        Math.sin(i * 4.7 + seed * 4.1) * 0.75) *
      envelope;
    points.push(new THREE.Vector3(jx, y, jz));
  }

  // Build two crossed ribbon strips so the jagged bolt reads cleanly from any azimuth
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ribbonAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];

  let vertexCursor = 0;
  for (const axis of ribbonAxes) {
    for (let i = 0; i <= segments; i++) {
      const p = points[i];
      const frac = i / segments;
      const halfWidth = 0.28 * (1 - frac * 0.45) + 0.08;
      positions.push(
        p.x - axis.x * halfWidth,
        p.y,
        p.z - axis.z * halfWidth,
        p.x + axis.x * halfWidth,
        p.y,
        p.z + axis.z * halfWidth,
      );
      uvs.push(0, 1 - frac, 1, 1 - frac);
    }
    for (let i = 0; i < segments; i++) {
      const row0 = vertexCursor + i * 2;
      const row1 = row0 + 2;
      indices.push(row0, row0 + 1, row1, row0 + 1, row1 + 1, row1);
    }
    vertexCursor += (segments + 1) * 2;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export class AtmosphereController {
  private readonly scene: THREE.Scene;
  private readonly rendererSystem?: RendererSystem;
  private readonly nightHdri?: THREE.DataTexture;
  private readonly duskHdri?: THREE.DataTexture;

  readonly rootGroup = new THREE.Group();
  private readonly fog: THREE.FogExp2;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly flashLight: THREE.PointLight;

  private readonly uTime = uniform(0);
  private readonly uPhaseIntensity = uniform(0);
  private readonly uFlashIntensity = uniform(0);

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly lightningPool: LightningSlot[] = [];
  private brazierGroup?: THREE.Group;
  private godRayGroup?: THREE.Group;
  private photogrammetryMode = false;

  private phaseIntensity = 0;
  private elapsedTime = 0;
  private flashIntensity = 0;
  private lightningCursor = 0;
  private currentHdriMode: 'night' | 'dusk' | null = null;
  private disposed = false;

  constructor(options: AtmosphereControllerOptions) {
    this.scene = options.scene;
    this.rendererSystem = options.rendererSystem;
    this.nightHdri = options.nightHdri;
    this.duskHdri = options.duskHdri;

    this.rootGroup.name = 'AtmosphereRoot';
    this.scene.add(this.rootGroup);

    // 1. Abyss exponential fog
    this.fog = new THREE.FogExp2(ACT1_FOG_COLOR.getHex(), 0.0082);
    this.scene.fog = this.fog;

    // 2. Three-point mythic temple lighting
    this.hemisphereLight = new THREE.HemisphereLight(
      ACT1_HEMI_SKY.getHex(),
      ACT1_HEMI_GROUND.getHex(),
      0.55,
    );
    this.rootGroup.add(this.hemisphereLight);

    this.keyLight = new THREE.DirectionalLight(ACT1_KEY_COLOR.getHex(), 2.2);
    this.keyLight.position.set(8, 20, 12);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 55;
    this.keyLight.shadow.camera.left = -16;
    this.keyLight.shadow.camera.right = 16;
    this.keyLight.shadow.camera.top = 16;
    this.keyLight.shadow.camera.bottom = -16;
    this.keyLight.shadow.bias = -0.0005;
    this.rootGroup.add(this.keyLight);
    this.rootGroup.add(this.keyLight.target);

    this.rimLight = new THREE.DirectionalLight(ACT1_RIM_COLOR.getHex(), 1.3);
    this.rimLight.position.set(-12, 10, -16);
    this.rootGroup.add(this.rimLight);
    this.rootGroup.add(this.rimLight.target);

    // 3. TSL Sky Dome (BackSide, fog: false)
    this.buildSkyDome();

    // 4. 8 Volumetric God-Ray Cones
    this.buildGodRays();

    // 5. 8 Perimeter Temple Braziers (R = 27.6m)
    this.buildBraziers();

    // 6. Pooled Lightning Strikes (4 pre-allocated slots + shared flash light)
    this.flashLight = new THREE.PointLight(0xff9a44, 0, 28, 2.0);
    this.flashLight.position.set(0, 7.5, 0);
    this.rootGroup.add(this.flashLight);
    this.buildLightningPool();

    // Apply initial Act I state & HDRI
    this.setPhaseIntensity(0);
  }

  private buildSkyDome(): void {
    const skyGeom = new THREE.SphereGeometry(220, 32, 20);
    this.ownedGeometries.push(skyGeom);

    const skyMat = new MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.ownedMaterials.push(skyMat);

    const dir = positionLocal.normalize();
    const horizon = saturate(dir.y);
    const horizonBand = pow(float(1.0).sub(horizon), 2.4);

    const act1Grad = mix(color(0x16243d), color(0x5c4c3e), horizonBand);
    const act2Grad = mix(color(0x18050a), color(0x681c14), horizonBand);
    const baseSky = mix(act1Grad, act2Grad, this.uPhaseIntensity);

    // Animated swirling storm cloud streaks across upper dome
    const azim = atan(dir.z, dir.x);
    const swirl1 = sin(
      azim.mul(4.0).add(this.uTime.mul(0.08)).add(dir.y.mul(8.0)),
    );
    const swirl2 = cos(
      azim.mul(7.0).sub(this.uTime.mul(0.13)).add(dir.y.mul(13.0)),
    );
    const cloudMask = saturate(swirl1.mul(0.5).add(swirl2.mul(0.5)).mul(0.5).add(0.5))
      .mul(smoothstep(0.04, 0.55, dir.y))
      .mul(smoothstep(0.96, 0.35, dir.y));
    const cloudTint = mix(color(0x182542), color(0x6e1a18), this.uPhaseIntensity);
    const skyWithClouds = baseSky.add(
      cloudTint.mul(cloudMask).mul(float(0.28).add(this.uPhaseIntensity.mul(0.35))),
    );

    // Celestial moon -> eclipsed blood-gold sun corona
    const moonDir = vec3(0.28, 0.42, -0.86).normalize();
    const moonDot = saturate(dot(dir, moonDir));
    const moonDisc = smoothstep(0.9962, 0.9982, moonDot);
    const eclipseCenter = smoothstep(0.9974, 0.9988, moonDot);
    const moonHalo = pow(moonDot, 28.0);
    const moonGlowColor = mix(color(0xdde8ff), color(0xff6b35), this.uPhaseIntensity);
    const moonCore = moonDisc.sub(eclipseCenter.mul(this.uPhaseIntensity).mul(0.92));

    const flashBoost = color(0xffb677).mul(this.uFlashIntensity.mul(0.35));

    skyMat.colorNode = skyWithClouds
      .add(moonGlowColor.mul(moonCore).mul(1.6))
      .add(moonGlowColor.mul(moonHalo).mul(0.45))
      .add(flashBoost);

    const skyMesh = new THREE.Mesh(skyGeom, skyMat);
    skyMesh.name = 'SkyDome';
    skyMesh.frustumCulled = false;
    this.rootGroup.add(skyMesh);
  }

  private buildGodRays(): void {
    const rayGeom = new THREE.CylinderGeometry(0.7, 5.2, 40, 24, 1, true);
    this.ownedGeometries.push(rayGeom);

    const rayMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ownedMaterials.push(rayMat);

    const fresnel = pow(abs(dot(normalView, positionViewDirection)), 1.9);
    const verticalFade = smoothstep(0.0, 0.25, uv().y).mul(
      smoothstep(1.0, 0.3, uv().y),
    );
    const shimmer = float(0.85).add(
      sin(uv().x.mul(18.84955).add(this.uTime.mul(0.85))).mul(0.15),
    );
    const rayColor = mix(color(0x5a7fb8), color(0xff5e36), this.uPhaseIntensity);

    rayMat.colorNode = rayColor.mul(1.35);
    rayMat.opacityNode = fresnel
      .mul(verticalFade)
      .mul(shimmer)
      .mul(float(0.09).add(this.uPhaseIntensity.mul(0.05)));

    const rayGroup = new THREE.Group();
    rayGroup.name = 'VolumetricGodRays';

    for (let i = 0; i < GOD_RAY_COUNT; i++) {
      const angle = (i / GOD_RAY_COUNT) * Math.PI * 2 + 0.18;
      const radius = 29.5 + (i % 3) * 3.0;
      const rayMesh = new THREE.Mesh(rayGeom, rayMat);
      rayMesh.name = `GodRay_${i}`;
      rayMesh.position.set(
        Math.cos(angle) * radius,
        19.0,
        Math.sin(angle) * radius,
      );
      // Tilt inward ~16 degrees toward the arena center
      rayMesh.lookAt(0, 0, 0);
      rayMesh.rotateX(Math.PI * 0.5 - 0.28);
      rayGroup.add(rayMesh);
    }

    this.godRayGroup = rayGroup;
    setObjectLayerRecursive(rayGroup, LAYER_MAIN_ONLY);
    this.rootGroup.add(rayGroup);
  }

  private buildBraziers(): void {
    const bowlGeom = new THREE.CylinderGeometry(0.65, 0.42, 0.95, 12);
    const emberGeom = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 12);
    const flameGeom = new THREE.ConeGeometry(0.42, 1.4, 10, 1, true);
    const glowDecalGeom = new THREE.CircleGeometry(3.8, 24);
    glowDecalGeom.rotateX(-Math.PI * 0.5);
    this.ownedGeometries.push(bowlGeom, emberGeom, flameGeom, glowDecalGeom);

    const bowlMat = new MeshStandardNodeMaterial({
      color: 0x1a171c,
      metalness: 0.75,
      roughness: 0.36,
    });
    bowlMat.emissiveNode = mix(color(0x4a1d06), color(0x781808), this.uPhaseIntensity).mul(0.7);
    this.ownedMaterials.push(bowlMat);

    const emberMat = new MeshBasicNodeMaterial({
      fog: false,
    });
    emberMat.colorNode = mix(color(0xff8c2a), color(0xff3818), this.uPhaseIntensity).mul(1.65);
    this.ownedMaterials.push(emberMat);

    const glowDecalMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const glowDist = length(uv().sub(vec2(0.5, 0.5)).mul(2.0));
    const glowRadial = pow(saturate(float(1.0).sub(glowDist)), 2.35);
    const glowFlicker = float(0.88).add(sin(this.uTime.mul(6.5)).mul(0.12));
    const glowColor = mix(color(0xff9a3c), color(0xff4222), this.uPhaseIntensity);
    glowDecalMat.colorNode = glowColor.mul(1.25);
    glowDecalMat.opacityNode = glowRadial
      .mul(glowFlicker)
      .mul(float(0.32).add(this.uPhaseIntensity.mul(0.14)));
    this.ownedMaterials.push(glowDecalMat);

    const brazierGroup = new THREE.Group();
    brazierGroup.name = 'TempleBraziers';

    for (let i = 0; i < BRAZIER_COUNT; i++) {
      const angle = ((i + 0.5) / BRAZIER_COUNT) * Math.PI * 2;
      const bx = Math.cos(angle) * BRAZIER_RADIUS;
      const bz = Math.sin(angle) * BRAZIER_RADIUS;

      const unit = new THREE.Group();
      unit.name = `Brazier_${i}`;
      unit.position.set(bx, -0.025, bz);

      const bowl = new THREE.Mesh(bowlGeom, bowlMat);
      bowl.position.y = 0.475;
      bowl.castShadow = false;
      bowl.receiveShadow = true;
      unit.add(bowl);

      const ember = new THREE.Mesh(emberGeom, emberMat);
      ember.position.y = 0.92;
      unit.add(ember);

      // Pooled/shared additive fake-glow ground decal replacing dynamic PointLights
      if (i % 2 === 0) {
        const glowDecal = new THREE.Mesh(glowDecalGeom, glowDecalMat);
        glowDecal.name = `BrazierGlowDecal_${i}`;
        glowDecal.position.y = 0.03;
        unit.add(glowDecal);
      }

      // Per-brazier flame material with distinct flicker phase
      const flameMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      this.ownedMaterials.push(flameMat);

      const phaseVal = float(i * 1.37);
      const flameWave = sin(
        this.uTime.mul(7.5).add(phaseVal).sub(uv().y.mul(5.2)),
      )
        .mul(0.25)
        .add(0.75);
      const vFade = smoothstep(0.0, 0.2, uv().y).mul(smoothstep(1.0, 0.15, uv().y));
      const flameColor = mix(color(0xffaa3b), color(0xff3b1d), this.uPhaseIntensity);

      flameMat.colorNode = flameColor.mul(1.85);
      flameMat.opacityNode = vFade.mul(flameWave).mul(0.88);

      const flame = new THREE.Mesh(flameGeom, flameMat);
      flame.position.y = 1.55;
      unit.add(flame);

      brazierGroup.add(unit);
    }

    this.brazierGroup = brazierGroup;
    setObjectLayerRecursive(brazierGroup, LAYER_MAIN_ONLY);
    this.rootGroup.add(brazierGroup);
  }

  /**
   * Switches lighting & props to showcase the real photogrammetry Jinshan Temple Courtyard
   * without procedural cone braziers or heavy abyss fog obscuring the architecture.
   */
  setPhotogrammetrySceneMode(enabled: boolean): void {
    this.photogrammetryMode = enabled;
    if (this.brazierGroup) {
      this.brazierGroup.visible = !enabled;
    }
    if (this.godRayGroup) {
      this.godRayGroup.visible = !enabled;
    }
    if (enabled) {
      this.fog.density = 0.0024;
      this.fog.color.setHex(0x26211e);
      this.hemisphereLight.intensity = 0.48;
      this.hemisphereLight.color.setHex(0xd2dff2);
      this.hemisphereLight.groundColor.setHex(0x241f1b);
      this.keyLight.intensity = 1.32;
      this.keyLight.color.setHex(0xffdfba);
      this.keyLight.position.set(16, 26, 18);
      if (this.scene.environment) {
        this.scene.environmentIntensity = 0.55;
      }
    }
  }

  private buildLightningPool(): void {
    const discGeom = new THREE.CircleGeometry(3.4, 24);
    this.ownedGeometries.push(discGeom);

    const lightningGroup = new THREE.Group();
    lightningGroup.name = 'LightningPool';

    for (let i = 0; i < LIGHTNING_POOL_SIZE; i++) {
      const uAlpha = uniform(0);

      const boltGeom = createLightningBoltGeometry(i + 1);
      this.ownedGeometries.push(boltGeom);

      const boltMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      this.ownedMaterials.push(boltMat);

      const coreMask = smoothstep(0.5, 0.0, abs(uv().x.sub(0.5)));
      boltMat.colorNode = mix(color(0xff7426), color(0xfff1c9), coreMask).mul(1.85);
      boltMat.opacityNode = uAlpha.mul(smoothstep(0.0, 0.08, uv().y));

      const boltMesh = new THREE.Mesh(boltGeom, boltMat);
      boltMesh.name = `LightningBolt_${i}`;
      boltMesh.frustumCulled = false;

      const discMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      this.ownedMaterials.push(discMat);

      const dist = length(uv().sub(vec2(0.5, 0.5)).mul(2.0));
      const discFade = pow(saturate(float(1.0).sub(dist)), 2.2);
      discMat.colorNode = color(0xff9a44).mul(0.70);
      discMat.opacityNode = discFade.mul(uAlpha).mul(0.85);

      const discMesh = new THREE.Mesh(discGeom, discMat);
      discMesh.name = `LightningGroundDisc_${i}`;
      discMesh.rotation.x = -Math.PI / 2;
      discMesh.position.y = 0.04;
      setObjectLayerRecursive(discMesh, LAYER_MAIN_ONLY);

      const slotGroup = new THREE.Group();
      slotGroup.visible = false;
      slotGroup.add(boltMesh);
      slotGroup.add(discMesh);
      lightningGroup.add(slotGroup);

      this.lightningPool.push({
        group: slotGroup,
        boltMesh,
        discMesh,
        uAlpha,
        active: false,
        life: 0,
        maxLife: LIGHTNING_DURATION,
      });
    }

    this.rootGroup.add(lightningGroup);
  }

  private applyHdriForPhase(t: number): void {
    // Eclipse dip across t in [0.42, 0.58]: 1.0 -> 0.55 at 0.5 -> 1.25 at >= 0.58
    let envIntensity = 1.0;
    if (t >= 0.42 && t < 0.5) {
      const k = (t - 0.42) / 0.08;
      envIntensity = 1.0 - 0.45 * k;
    } else if (t >= 0.5 && t <= 0.58) {
      const k = (t - 0.5) / 0.08;
      envIntensity = 0.55 + 0.7 * k;
    } else if (t > 0.58) {
      envIntensity = 1.25;
    }

    const useDusk = t >= 0.5 && Boolean(this.duskHdri);
    const targetMode: 'night' | 'dusk' | null = useDusk
      ? 'dusk'
      : this.nightHdri
        ? 'night'
        : null;
    const targetHdri = useDusk ? this.duskHdri : this.nightHdri;

    if (targetHdri && targetMode) {
      const scaledEnv = this.photogrammetryMode ? envIntensity * 0.55 : envIntensity;
      if (targetMode !== this.currentHdriMode) {
        this.currentHdriMode = targetMode;
        if (this.rendererSystem) {
          this.rendererSystem.applyEnvironment(targetHdri, scaledEnv);
        } else {
          targetHdri.mapping = THREE.EquirectangularReflectionMapping;
          this.scene.environment = targetHdri;
        }
      }
      this.scene.environmentIntensity = scaledEnv;
    }
  }

  setPhaseIntensity(t: number): void {
    if (this.disposed) {
      return;
    }
    const clamped = clamp01(t);
    this.phaseIntensity = clamped;
    this.uPhaseIntensity.value = clamped;

    if (this.photogrammetryMode) {
      this.fog.color
        .setHex(0x26211e)
        .lerp(new THREE.Color(0x2c0e0c), clamped);
      this.fog.density = 0.0024 + 0.0022 * clamped;
      this.hemisphereLight.color
        .setHex(0xd2dff2)
        .lerp(new THREE.Color(0xc45840), clamped);
      this.hemisphereLight.groundColor
        .setHex(0x241f1b)
        .lerp(new THREE.Color(0x1e0d0c), clamped);
      this.hemisphereLight.intensity = 0.48 + 0.08 * clamped;
      this.keyLight.color
        .setHex(0xffdfba)
        .lerp(new THREE.Color(0xff7a48), clamped);
      this.keyLight.intensity = 1.32 + 0.24 * clamped;
    } else {
      // Interpolate fog
      this.fog.color.copy(ACT1_FOG_COLOR).lerp(ACT2_FOG_COLOR, clamped);
      this.fog.density = 0.0082 + (0.0112 - 0.0082) * clamped;

      // Interpolate lights
      this.hemisphereLight.color.copy(ACT1_HEMI_SKY).lerp(ACT2_HEMI_SKY, clamped);
      this.hemisphereLight.groundColor
        .copy(ACT1_HEMI_GROUND)
        .lerp(ACT2_HEMI_GROUND, clamped);
      this.hemisphereLight.intensity = 0.55 + (0.68 - 0.55) * clamped;

      this.keyLight.color.copy(ACT1_KEY_COLOR).lerp(ACT2_KEY_COLOR, clamped);
      this.keyLight.intensity = 2.2 + (2.6 - 2.2) * clamped;
    }

    this.rimLight.color.copy(ACT1_RIM_COLOR).lerp(ACT2_RIM_COLOR, clamped);
    this.rimLight.intensity = 1.3 + (1.9 - 1.3) * clamped;

    this.applyHdriForPhase(clamped);
  }

  public setShadowAutoUpdate(enabled: boolean): void {
    this.keyLight.shadow.autoUpdate = enabled;
  }

  triggerLightningStrike(pos: Vec3Like): void {
    if (this.disposed) {
      return;
    }

    const px = Number.isFinite(pos.x) ? pos.x : 0;
    const py = Number.isFinite(pos.y) ? pos.y : 0;
    const pz = Number.isFinite(pos.z) ? pos.z : 0;

    let slot = this.lightningPool.find((item) => !item.active);
    if (!slot) {
      slot = this.lightningPool[this.lightningCursor % this.lightningPool.length];
      this.lightningCursor = (this.lightningCursor + 1) % this.lightningPool.length;
    }

    slot.active = true;
    slot.life = LIGHTNING_DURATION;
    slot.maxLife = LIGHTNING_DURATION;
    slot.uAlpha.value = 1.0;

    slot.group.position.set(px, py, pz);
    slot.boltMesh.rotation.y = (this.lightningCursor * 1.17 + px * 0.3) % (Math.PI * 2);
    slot.group.visible = true;

    this.flashLight.position.set(px, py + 7.5, pz);
    this.flashIntensity = LIGHTNING_FLASH_PEAK;
    this.flashLight.intensity = LIGHTNING_FLASH_PEAK;
    this.uFlashIntensity.value = 1.0;
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    this.elapsedTime += dt;
    this.uTime.value = this.elapsedTime;

    // Decay flash light exponentially
    if (this.flashIntensity > 0) {
      this.flashIntensity *= Math.exp(-dt * 11.0);
      if (this.flashIntensity < 0.01) {
        this.flashIntensity = 0;
      }
      this.flashLight.intensity = this.flashIntensity;
      this.uFlashIntensity.value = Math.min(1, this.flashIntensity / LIGHTNING_FLASH_PEAK);
    }

    // Update active lightning bolts
    for (const slot of this.lightningPool) {
      if (!slot.active) {
        continue;
      }
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.active = false;
        slot.life = 0;
        slot.uAlpha.value = 0;
        slot.group.visible = false;
      } else {
        const norm = slot.life / slot.maxLife;
        slot.uAlpha.value = norm;
      }
    }
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.flashIntensity = 0;
    this.flashLight.intensity = 0;
    this.uFlashIntensity.value = 0;
    for (const slot of this.lightningPool) {
      slot.active = false;
      slot.life = 0;
      slot.uAlpha.value = 0;
      slot.group.visible = false;
    }
    this.setPhaseIntensity(0);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.flashIntensity = 0;
    this.flashLight.intensity = 0;
    this.uFlashIntensity.value = 0;
    for (const slot of this.lightningPool) {
      slot.active = false;
      slot.life = 0;
      slot.uAlpha.value = 0;
      slot.group.visible = false;
    }

    for (const geom of this.ownedGeometries) {
      geom.dispose();
    }
    this.ownedGeometries.length = 0;

    for (const mat of this.ownedMaterials) {
      mat.dispose();
    }
    this.ownedMaterials.length = 0;

    this.hemisphereLight.dispose();
    this.keyLight.dispose();
    this.rimLight.dispose();
    this.flashLight.dispose();

    if (this.scene.fog === this.fog) {
      this.scene.fog = null;
    }
    this.rootGroup.removeFromParent();
  }

  getPhaseIntensity(): number {
    return this.phaseIntensity;
  }

  getFog(): THREE.FogExp2 {
    return this.fog;
  }

  getActiveLightningCount(): number {
    let count = 0;
    for (const slot of this.lightningPool) {
      if (slot.active) {
        count += 1;
      }
    }
    return count;
  }

  getFlashIntensity(): number {
    return this.flashIntensity;
  }
}
