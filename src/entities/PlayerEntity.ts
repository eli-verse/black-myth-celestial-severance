import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  clamp as tslClamp,
  color,
  dot,
  float,
  mix,
  normalView,
  positionLocal,
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
import { LAYER_MAIN_ONLY, setObjectLayerRecursive } from '../engine/RenderLayers.ts';
import { clampArenaPosition } from '../scene/ArenaScene.ts';
import {
  COMBAT_TUNING,
  type ModelType,
  type Vec3Like,
} from '../types/game.ts';
import {
  AnimationRig,
  attachObjectToBone,
  type PlayClipOptions,
} from './AnimationRig.ts';

export interface PlayerCameraFrameOverride {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  lerpAlpha?: number;
}

export interface PlayerEntityOptions {
  assetLoader?: AssetLoader;
  model?: THREE.Object3D;
  weaponModel?: THREE.Object3D;
  clips?: readonly THREE.AnimationClip[];
  arenaRadius?: number;
  onError?: (msg: string) => void;
}

export const PLAYER_CLIPS = {
  idle: ['Sword_Idle', 'Idle_Loop'] as const,
  jog: ['Jog_Fwd_Loop', 'Sprint_Loop'] as const,
  sprint: ['Sprint_Loop', 'Jog_Fwd_Loop'] as const,
  combo1: ['Sword_Regular_A', 'Sword_Attack'] as const,
  combo2: ['Sword_Regular_B', 'Sword_Attack'] as const,
  combo3: ['Sword_Regular_C', 'Sword_Regular_Combo', 'Sword_Attack'] as const,
  combo4: ['Sword_Attack', 'Sword_Regular_Combo'] as const,
  dodge: ['Roll', 'Slide_Start'] as const,
  slide: ['Slide_Start', 'Roll'] as const,
  skill1: ['Sword_Dash', 'Sprint_Loop'] as const,
  skill2: ['Sword_Heavy_Combo', 'Sword_Attack'] as const,
  skill3Cast: ['Spell_Simple_Shoot', 'Sword_Heavy_Combo'] as const,
  skill3Strike: ['Sword_Heavy_Combo', 'Sword_Attack'] as const,
  jump: ['NinjaJump_Start', 'Roll'] as const,
  hit: ['Hit_Knockback', 'Sword_Block'] as const,
  block: ['Sword_Block', 'Sword_Idle'] as const,
  death: ['Death01'] as const,
} as const;

const PLAYER_SPAWN_X = 0;
const PLAYER_SPAWN_Z = 4;
const PLAYER_INITIAL_YAW = Math.PI;
const CAMERA_ORBIT_SENSITIVITY = 0.0052;
const CAMERA_MIN_PITCH = -0.18;
const CAMERA_MAX_PITCH = 0.85;
const CAMERA_DEFAULT_PITCH = 0.038;
const CAMERA_DEFAULT_DISTANCE = 6.5;
const CAMERA_MIN_HEIGHT = 0.55;
const CAMERA_MAX_ARENA_RADIUS = 28.5;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-5, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function createFloatUniform(initial: number) {
  return uniform(initial);
}
type FloatUniform = ReturnType<typeof createFloatUniform>;

export function computeTitleCameraFrame(elapsedSeconds: number): PlayerCameraFrameOverride {
  const t = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const angle = t * 0.14;
  const radius = 14.5 + Math.sin(t * 0.22) * 1.1;
  const camX = Math.sin(angle) * radius * 0.52 + 2.4 * Math.cos(angle);
  const camY = Math.max(CAMERA_MIN_HEIGHT, 3.8 + Math.sin(t * 0.35) * 0.5);
  const camZ = Math.cos(angle) * radius * 0.84 + 2.4;
  const clamped = clampArenaPosition({ x: camX, y: camY, z: camZ }, CAMERA_MAX_ARENA_RADIUS, 0);
  return {
    position: new THREE.Vector3(clamped.x, Math.max(CAMERA_MIN_HEIGHT, clamped.y), clamped.z),
    lookAt: new THREE.Vector3(0, 2.0, -1.6),
    lerpAlpha: 1,
  };
}

export function computeIntroCameraFrame(
  progress: number,
  playerPos: Vec3Like,
  bossPos: Vec3Like,
): PlayerCameraFrameOverride {
  const p = clamp01(progress);

  // SHOT 1 (0.00..0.25): Demon General Jiebo's Sky-Meteor Crash onto the Obsidian Water-Mirror!
  if (p < 0.25) {
    const s1 = clamp01(p / 0.25);
    const dropTrack = smoothstepScalar(0.0, 0.42, s1);
    const dollyIn = smoothstepScalar(0.35, 1.0, s1);
    const rawPos = {
      x: 2.6 - dollyIn * 1.35,
      y: 1.28 + dollyIn * 0.28,
      z: 4.8 - dollyIn * 1.45,
    };
    const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
    return {
      position: new THREE.Vector3(
        clamped.x,
        Math.max(CAMERA_MIN_HEIGHT, clamped.y),
        clamped.z,
      ),
      lookAt: new THREE.Vector3(
        bossPos.x,
        9.2 * (1 - dropTrack) + 3.15 * dropTrack,
        bossPos.z,
      ),
      lerpAlpha: p < 0.03 ? 1.0 : 0.24,
    };
  }

  // SHOT 2 (0.25..0.52): Sun Wukong's Golden Somersault Cloud Dive & One-Knee Heroic Touchdown!
  if (p < 0.52) {
    const s2 = clamp01((p - 0.25) / 0.27);
    const trackDown = smoothstepScalar(0.0, 0.42, s2);
    const pushClose = smoothstepScalar(0.4, 1.0, s2);
    const rawPos = {
      x: 1.75 - pushClose * 0.72,
      y: 0.92 + pushClose * 0.18,
      z: 0.55 + pushClose * 0.95,
    };
    const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
    return {
      position: new THREE.Vector3(
        clamped.x,
        Math.max(CAMERA_MIN_HEIGHT, clamped.y),
        clamped.z,
      ),
      lookAt: new THREE.Vector3(
        playerPos.x * (1 - trackDown * 0.4),
        6.5 * (1 - trackDown) + 1.15 * trackDown,
        playerPos.z,
      ),
      lerpAlpha: p < 0.27 ? 1.0 : 0.28,
    };
  }

  // SHOT 3 (0.52..0.78): Plucking the Golden Sanskrit Needle from Right Ear -> Explosive Ruyi Jingu Bang Slam!
  if (p < 0.78) {
    const s3 = clamp01((p - 0.52) / 0.26);
    const whipPull = smoothstepScalar(0.42, 0.82, s3);
    // Angle toward Wukong's front-right (+X) & slightly higher so right-ear needle pluck + full 6.9m staff slam frame cleanly without floor glare
    const rawPos = {
      x: 2.35 + whipPull * 0.95,
      y: 1.52 + whipPull * 0.1,
      z: 1.85 + whipPull * 0.5,
    };
    const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
    return {
      position: new THREE.Vector3(
        clamped.x,
        Math.max(CAMERA_MIN_HEIGHT, clamped.y),
        clamped.z,
      ),
      lookAt: new THREE.Vector3(
        -0.06 + whipPull * 0.06,
        1.68 + whipPull * 0.04,
        3.85 - whipPull * 0.2,
      ),
      lerpAlpha: p < 0.54 ? 1.0 : 0.28,
    };
  }

  // SHOT 4 (0.78..1.00): Wide Side-Profile Golden-vs-Crimson Aura Clash -> One-Take Whip-Orbit into Live Gameplay!
  const s4 = clamp01((p - 0.78) / 0.22);
  const whipToGameplay = smoothstepScalar(0.42, 1.0, s4);

  // Orbit smoothly along a circular arc from (-10.6, 2.35, -0.4) right around behind Wukong to (0, 1.73, 10.5)!
  const standoffYaw = -Math.PI * 0.52;
  const gameplayYaw = 0.0;
  const orbitYaw = standoffYaw + (gameplayYaw - standoffYaw) * whipToGameplay;
  const pivotX = playerPos.x * whipToGameplay;
  const pivotZ = -0.4 * (1 - whipToGameplay) + playerPos.z * whipToGameplay;
  const orbitR = 10.6 * (1 - whipToGameplay) + CAMERA_DEFAULT_DISTANCE * Math.cos(CAMERA_DEFAULT_PITCH) * whipToGameplay;
  const camY =
    2.35 * (1 - whipToGameplay) +
    (1.48 + Math.sin(CAMERA_DEFAULT_PITCH) * CAMERA_DEFAULT_DISTANCE) * whipToGameplay;

  const rawPos = {
    x: pivotX + Math.sin(orbitYaw) * orbitR,
    y: camY,
    z: pivotZ + Math.cos(orbitYaw) * orbitR,
  };
  const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);

  const lookX = 0 * (1 - whipToGameplay) + playerPos.x * whipToGameplay;
  const lookY = 2.45 * (1 - whipToGameplay) + 1.48 * whipToGameplay;
  const lookZ = -0.65 * (1 - whipToGameplay) + playerPos.z * whipToGameplay;

  return {
    position: new THREE.Vector3(
      clamped.x,
      Math.max(CAMERA_MIN_HEIGHT, clamped.y),
      clamped.z,
    ),
    lookAt: new THREE.Vector3(lookX, lookY, lookZ),
    lerpAlpha: p < 0.8 ? 1.0 : 0.28 + whipToGameplay * 0.45,
  };
}

export function computeTransitionCameraFrame(
  progress: number,
  bossPos: Vec3Like,
): PlayerCameraFrameOverride {
  const p = clamp01(progress);
  const angle = p * 0.45;
  const dist = 10.5 - p * 1.4;
  const camX = bossPos.x + 4.2 * Math.cos(angle) - 2.0 * Math.sin(angle);
  const camY = Math.max(CAMERA_MIN_HEIGHT, 1.65 + p * 0.55);
  const camZ = bossPos.z + dist;
  const clamped = clampArenaPosition({ x: camX, y: camY, z: camZ }, CAMERA_MAX_ARENA_RADIUS, 0);
  return {
    position: new THREE.Vector3(clamped.x, Math.max(CAMERA_MIN_HEIGHT, clamped.y), clamped.z),
    lookAt: new THREE.Vector3(bossPos.x, 4.3, bossPos.z),
    lerpAlpha: 0.16,
  };
}

export function computeSkill3CameraFrame(
  elapsedSeconds: number,
  playerPos: Vec3Like,
  bossPos: Vec3Like,
): PlayerCameraFrameOverride {
  const t = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const midX = (playerPos.x + bossPos.x) * 0.5;
  const midZ = (playerPos.z + bossPos.z) * 0.5;
  const dx = bossPos.x - playerPos.x;
  const dz = bossPos.z - playerPos.z;
  const slamPull = smoothstepScalar(1.9, 2.25, t);
  // Heroic wide 3/4 rear-right angle framing the full 26m Mantra Circle + entire 14.5m Great Sage Dharmakaya (boots to crown plumes + 24m sky staff)!
  const baseYaw = Math.atan2(dx, dz) + Math.PI + 0.52 - t * 0.1;
  const dist = 19.2 + slamPull * 2.0;
  const rawPos = {
    x: midX + Math.sin(baseYaw) * dist,
    y: 3.6 + slamPull * 0.9,
    z: midZ + Math.cos(baseYaw) * dist,
  };
  const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
  return {
    position: new THREE.Vector3(clamped.x, Math.max(CAMERA_MIN_HEIGHT, clamped.y), clamped.z),
    lookAt: new THREE.Vector3(midX, 6.35 - slamPull * 1.35, midZ),
    lerpAlpha: 0.28,
  };
}

export function computeFinisherCameraFrame(
  progress: number,
  playerPos: Vec3Like,
  bossPos: Vec3Like,
): PlayerCameraFrameOverride {
  const p = clamp01(progress);
  const midX = (playerPos.x + bossPos.x) * 0.5;
  const midZ = (playerPos.z + bossPos.z) * 0.5;
  const angle = -0.6 + p * 1.4;
  const radius = 7.6;
  const rawPos = {
    x: midX + Math.sin(angle) * radius,
    y: 2.3 + Math.sin(p * Math.PI) * 0.8,
    z: midZ + Math.cos(angle) * radius,
  };
  const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
  return {
    position: new THREE.Vector3(clamped.x, Math.max(CAMERA_MIN_HEIGHT, clamped.y), clamped.z),
    lookAt: new THREE.Vector3(bossPos.x, 2.4, bossPos.z),
    lerpAlpha: 0.16,
  };
}

export function computeVictoryCameraFrame(
  elapsedSeconds: number,
  playerPos: Vec3Like,
): PlayerCameraFrameOverride {
  const t = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const angle = Math.PI + Math.sin(t * 0.2) * 0.32;
  const dist = 5.4;
  const rawPos = {
    x: playerPos.x - Math.sin(angle) * dist,
    y: 2.0,
    z: playerPos.z - Math.cos(angle) * dist,
  };
  const clamped = clampArenaPosition(rawPos, CAMERA_MAX_ARENA_RADIUS, 0);
  return {
    position: new THREE.Vector3(clamped.x, Math.max(CAMERA_MIN_HEIGHT, clamped.y), clamped.z),
    lookAt: new THREE.Vector3(playerPos.x, 1.4, playerPos.z - 2.0),
    lerpAlpha: 0.08,
  };
}

function stripBoneIndexSuffix(name: string): string {
  return name.replace(/_0*\d+$/, '').toLowerCase();
}

function retargetClipsToWukongRig(
  srcRoot: THREE.Object3D,
  srcClips: readonly THREE.AnimationClip[],
  dstRoot: THREE.Object3D,
): THREE.AnimationClip[] {
  srcRoot.updateMatrixWorld(true);
  dstRoot.updateMatrixWorld(true);

  const srcBones = new Map<string, THREE.Bone>();
  srcRoot.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      srcBones.set(stripBoneIndexSuffix(obj.name), obj as THREE.Bone);
    }
  });

  const dstBones = new Map<string, THREE.Bone>();
  const savedDstQuats = new Map<THREE.Bone, THREE.Quaternion>();
  dstRoot.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      const b = obj as THREE.Bone;
      dstBones.set(stripBoneIndexSuffix(b.name), b);
      savedDstQuats.set(b, b.quaternion.clone());
    }
  });

  // Normalize Wukong's 45-degree A-pose & wide-stance bind into Swordsman's clean T-pose
  // top-down so limb deltas never cross arms through ribs or splay knees into a crab squat!
  const alignLimbToSourceTPose = (
    parentKey: string,
    srcChildKey: string,
    dstChildKey = srcChildKey,
  ): void => {
    const sb = srcBones.get(parentKey);
    const sc = srcBones.get(srcChildKey);
    const db = dstBones.get(parentKey);
    const dc = dstBones.get(dstChildKey) ?? dstBones.get(srcChildKey);
    if (!sb || !sc || !db || !dc || !db.parent) return;

    srcRoot.updateMatrixWorld(true);
    dstRoot.updateMatrixWorld(true);

    const sDir = sc
      .getWorldPosition(new THREE.Vector3())
      .sub(sb.getWorldPosition(new THREE.Vector3()))
      .normalize();
    const dDir = dc
      .getWorldPosition(new THREE.Vector3())
      .sub(db.getWorldPosition(new THREE.Vector3()))
      .normalize();
    if (sDir.lengthSq() < 0.5 || dDir.lengthSq() < 0.5) return;

    const worldDelta = new THREE.Quaternion().setFromUnitVectors(dDir, sDir);
    const parentWQ = db.parent.getWorldQuaternion(new THREE.Quaternion());
    const curWQ = db.getWorldQuaternion(new THREE.Quaternion());
    const targetWQ = worldDelta.multiply(curWQ);
    db.quaternion.copy(parentWQ.invert().multiply(targetWQ)).normalize();
  };

  alignLimbToSourceTPose('thigh_l', 'calf_l');
  alignLimbToSourceTPose('calf_l', 'foot_l');
  alignLimbToSourceTPose('foot_l', 'ball_l', 'ball_l_01');
  alignLimbToSourceTPose('thigh_r', 'calf_r');
  alignLimbToSourceTPose('calf_r', 'foot_r');
  alignLimbToSourceTPose('foot_r', 'ball_r', 'ball_r_01');
  alignLimbToSourceTPose('upperarm_l', 'lowerarm_l');
  alignLimbToSourceTPose('lowerarm_l', 'hand_l');
  alignLimbToSourceTPose('upperarm_r', 'lowerarm_r');
  alignLimbToSourceTPose('lowerarm_r', 'hand_r');
  dstRoot.updateMatrixWorld(true);

  const srcWorldBind = new Map<string, THREE.Quaternion>();
  for (const [k, b] of srcBones) {
    srcWorldBind.set(k, b.getWorldQuaternion(new THREE.Quaternion()));
  }

  const dstWorldBind = new Map<string, THREE.Quaternion>();
  const dstParentWorldBind = new Map<string, THREE.Quaternion>();
  for (const [k, b] of dstBones) {
    dstWorldBind.set(k, b.getWorldQuaternion(new THREE.Quaternion()));
    const pwq = new THREE.Quaternion();
    if (b.parent) {
      b.parent.getWorldQuaternion(pwq);
    }
    dstParentWorldBind.set(k, pwq);
  }

  const uprightIdleDonor = srcClips.find((c) => c.name === 'Idle_Loop');
  const athleticSprintDonor = srcClips.find((c) => c.name === 'Sprint_Loop');
  const uprightDashDonor =
    srcClips.find((c) => c.name === 'Sword_Dash') ?? athleticSprintDonor;
  const outClips: THREE.AnimationClip[] = [];
  for (const clip of srcClips) {
    // 1) Use Idle_Loop's tall upright warrior stance instead of Sword_Idle's 70-degree deep crouch
    // 2) Use Sprint_Loop's explosive athletic knee drive for Jog_Fwd_Loop so WASD running matches Black Myth's dynamic stride
    // 3) Use Sword_Dash's upright phantom-step dash instead of Roll's 360-degree upside-down somersault (prevents inverted skirt armor!)
    let sourceClip = clip;
    if (clip.name === 'Sword_Idle' && uprightIdleDonor) {
      sourceClip = uprightIdleDonor;
    } else if (clip.name === 'Jog_Fwd_Loop' && athleticSprintDonor) {
      sourceClip = athleticSprintDonor;
    } else if (
      (clip.name === 'Roll' || clip.name === 'Slide_Start') &&
      uprightDashDonor
    ) {
      sourceClip = uprightDashDonor;
    }
    const newTracks: THREE.KeyframeTrack[] = [];
    for (const track of sourceClip.tracks) {
      const dotIdx = track.name.lastIndexOf('.');
      if (dotIdx < 0) continue;
      const rawNode = track.name.slice(0, dotIdx);
      const prop = track.name.slice(dotIdx + 1);
      const cleanNode = rawNode.split('|').pop() ?? rawNode;
      const key = stripBoneIndexSuffix(cleanNode);

      const dstBone = dstBones.get(key);
      const srcBone = srcBones.get(key);
      if (!dstBone || !srcBone) continue;

      if (prop === 'quaternion') {
        const srcParentWB = new THREE.Quaternion();
        if (srcBone.parent) {
          srcBone.parent.getWorldQuaternion(srcParentWB);
        }
        const invSrcWB = srcWorldBind.get(key)!.clone().invert();
        const dstWB = dstWorldBind.get(key)!;
        const invDstParentWB = dstParentWorldBind.get(key)!.clone().invert();

        const pre = invDstParentWB.clone().multiply(srcParentWB);
        const post = invSrcWB.clone().multiply(dstWB);

        const vals = new Float32Array(track.values.length);
        const q = new THREE.Quaternion();
        for (let i = 0; i < track.values.length; i += 4) {
          q.set(
            track.values[i]!,
            track.values[i + 1]!,
            track.values[i + 2]!,
            track.values[i + 3]!,
          );
          q.premultiply(pre).multiply(post).normalize();
          vals[i] = q.x;
          vals[i + 1] = q.y;
          vals[i + 2] = q.z;
          vals[i + 3] = q.w;
        }
        newTracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${dstBone.name}.quaternion`,
            track.times.slice(),
            vals,
          ),
        );
      } else if (prop === 'position' && (key === 'pelvis' || key === 'hips')) {
        const srcParentWB = new THREE.Quaternion();
        if (srcBone.parent) {
          srcBone.parent.getWorldQuaternion(srcParentWB);
        }
        const invDstParentWB = dstParentWorldBind.get(key)!.clone().invert();
        const srcRest = srcBone.position;
        const dstRest = dstBone.position;
        const ratio = dstRest.length() / Math.max(0.001, srcRest.length());
        const vals = new Float32Array(track.values.length);
        const deltaVec = new THREE.Vector3();
        for (let i = 0; i < track.values.length; i += 3) {
          deltaVec.set(
            track.values[i]! - srcRest.x,
            track.values[i + 1]! - srcRest.y,
            track.values[i + 2]! - srcRest.z,
          );
          // Transform source pelvis delta into world space, damp lateral wobble, then rotate into UE5 parent space
          deltaVec.applyQuaternion(srcParentWB);
          deltaVec.x *= 0.3;
          deltaVec.y *= 0.52;
          deltaVec.z *= 0.3;
          deltaVec.applyQuaternion(invDstParentWB).multiplyScalar(ratio);
          vals[i] = dstRest.x + deltaVec.x;
          vals[i + 1] = dstRest.y + deltaVec.y;
          vals[i + 2] = dstRest.z + deltaVec.z;
        }
        newTracks.push(
          new THREE.VectorKeyframeTrack(
            `${dstBone.name}.position`,
            track.times.slice(),
            vals,
          ),
        );
      }
    }
    if (newTracks.length > 0) {
      outClips.push(
        new THREE.AnimationClip(clip.name, sourceClip.duration, newTracks),
      );
    }
  }

  for (const [b, q] of savedDstQuats) {
    b.quaternion.copy(q);
  }
  dstRoot.updateMatrixWorld(true);

  return outClips;
}

function skeletonsMatch(a: THREE.Skeleton, b: THREE.Skeleton): boolean {
  if (a.bones.length !== b.bones.length || a.boneInverses.length !== b.boneInverses.length) {
    return false;
  }
  for (let i = 0; i < a.bones.length; i += 1) {
    if (a.bones[i] !== b.bones[i]) {
      return false;
    }
  }
  for (let i = 0; i < a.boneInverses.length; i += 1) {
    const ae = a.boneInverses[i]!.elements;
    const be = b.boneInverses[i]!.elements;
    for (let k = 0; k < 16; k += 1) {
      if (Math.abs(ae[k]! - be[k]!) > 1e-4) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Consolidates split Skeleton instances produced by SkeletonUtils.clone
 * into a single shared Skeleton per compatible bone hierarchy so skeleton.update()
 * runs once per frame instead of once per SkinnedMesh (23x -> 1x on Wukong, 6x -> 1x on Boss).
 */
export function consolidateModelSkeletons(root: THREE.Object3D): THREE.Skeleton | null {
  const canonicalSkeletons: THREE.Skeleton[] = [];

  root.traverse((obj) => {
    if (!(obj as THREE.SkinnedMesh).isSkinnedMesh) {
      return;
    }
    const skinned = obj as THREE.SkinnedMesh;
    const skel = skinned.skeleton;
    if (!skel || skel.bones.length === 0) {
      return;
    }

    const match = canonicalSkeletons.find((cand) => skeletonsMatch(cand, skel));
    if (match) {
      if (match !== skel) {
        skinned.bind(match, skinned.bindMatrix);
        skel.dispose();
      }
    } else {
      canonicalSkeletons.push(skel);
    }
  });

  return canonicalSkeletons[0] ?? null;
}

export class PlayerEntity {
  readonly rootGroup = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly rig: AnimationRig;
  readonly modelType: ModelType = 'glb';
  readonly velocity = new THREE.Vector3();

  cameraYaw = 0;
  cameraPitch = CAMERA_DEFAULT_PITCH;
  cameraDistance = CAMERA_DEFAULT_DISTANCE;

  private readonly arenaRadius: number;
  private readonly onError?: (msg: string) => void;
  private readonly isWukongHero: boolean;
  private readonly weaponModel: THREE.Object3D | null;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];

  private readonly uAuraBoost: FloatUniform = uniform(0);
  private readonly uSashTime: FloatUniform = uniform(0);
  private readonly uMoveSpeed: FloatUniform = uniform(0);

  private readonly tmpVec3 = new THREE.Vector3();
  private readonly camTargetVec = new THREE.Vector3();
  private readonly camDesiredVec = new THREE.Vector3();
  private readonly camLookAtVec = new THREE.Vector3(0, 1.38, 0);

  // Wukong 6-Pose Martial Choreography, 2-Bone Polearm IK, Telescopic Ruyi Jingu Bang & Hair-Clone Phantom
  private wkBones: {
    spine01?: THREE.Bone;
    spine02?: THREE.Bone;
    spine03?: THREE.Bone;
    neck01?: THREE.Bone;
    head?: THREE.Bone;
    clavicleL?: THREE.Bone;
    upperArmL?: THREE.Bone;
    lowerArmL?: THREE.Bone;
    handL?: THREE.Bone;
    clavicleR?: THREE.Bone;
    upperArmR?: THREE.Bone;
    lowerArmR?: THREE.Bone;
    handR?: THREE.Bone;
    thighL?: THREE.Bone;
    calfL?: THREE.Bone;
    thighR?: THREE.Bone;
    calfR?: THREE.Bone;
    weaponR?: THREE.Bone;
    weaponCr2?: THREE.Bone;
    weaponCr1?: THREE.Bone;
    staffTipA?: THREE.Object3D;
    staffTipB?: THREE.Object3D;
  } = {};
  private readonly wkStaffChainBones: THREE.Object3D[] = [];
  private readonly wkStaffExtendBones: Array<{
    bone: THREE.Bone;
    baseX: number;
    isFrontTip: boolean;
  }> = [];
  private readonly wkStaffMeshes: THREE.Mesh[] = [];
  private introActive = false;
  private introProgress = 0;
  private readonly wkPlumeLeft: Array<{ bone: THREE.Bone; restQuat: THREE.Quaternion }> = [];
  private readonly wkPlumeRight: Array<{ bone: THREE.Bone; restQuat: THREE.Quaternion }> = [];
  private readonly wkSashChains: Array<Array<{ bone: THREE.Bone; restQuat: THREE.Quaternion }>> = [];
  private readonly postSolvedSnapshots: Array<{ bone: THREE.Bone; animQuat: THREE.Quaternion }> = [];
  private postSolvedCount = 0;

  // Pre-allocated scratch math objects for zero-GC applyWukongMartialPosture()
  private readonly wkRootWQ = new THREE.Quaternion();
  private readonly wkInvRootWQ = new THREE.Quaternion();
  private readonly wkParentWQ = new THREE.Quaternion();
  private readonly wkCurWQ = new THREE.Quaternion();
  private readonly wkRotDelta = new THREE.Quaternion();
  private readonly wkBlendedQ = new THREE.Quaternion();
  private readonly wkEntityDelta = new THREE.Quaternion();
  private readonly wkWorldDelta = new THREE.Quaternion();
  private readonly wkTargetWQ = new THREE.Quaternion();
  private readonly wkEntityEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly wkPosA = new THREE.Vector3();
  private readonly wkPosB = new THREE.Vector3();
  private readonly wkCurDirW = new THREE.Vector3();
  private readonly wkTgtDirW = new THREE.Vector3();
  private readonly wkShoulderW = new THREE.Vector3();
  private readonly wkElbowW = new THREE.Vector3();
  private readonly wkWristW = new THREE.Vector3();
  private readonly wkStaffDirW = new THREE.Vector3();
  private readonly wkGripTargetW = new THREE.Vector3();
  private readonly wkToTarget = new THREE.Vector3();
  private readonly wkPoleHintW = new THREE.Vector3();
  private readonly wkBendAxis = new THREE.Vector3();
  private readonly wkDesiredElbowDirW = new THREE.Vector3();
  private readonly wkDesiredForearmDirW = new THREE.Vector3();

  // 3D Golden Hair-Clone Dodge Silhouette ("聚形散气 · 身外毫毛金影")
  private goldenCloneGroup: THREE.Group | null = null;
  private goldenCloneSkeleton: THREE.Skeleton | null = null;
  private goldenCloneBonePairs: Array<{ src: THREE.Bone; dst: THREE.Bone }> = [];
  private readonly uCloneOpacity: FloatUniform = uniform(0);
  private readonly goldenCloneWorldPos = new THREE.Vector3();
  private goldenCloneWorldYaw = 0;
  private goldenCloneTimer = 0;
  private goldenCloneDuration = 0.46;

  private staffExtCurrent = 1.0;
  private staffExtTarget = 1.0;
  private staffSlideCurrent = -16.0;
  private staffSlideTarget = -16.0;
  private idlePostureWeight = 1.0;
  private runPostureWeight = 0.0;
  private dodgePostureWeight = 0.0;
  private combatAlertBlend = 0.0;
  private combatAlertTimer = 0.0;
  private activeAttackKind:
    | 'none'
    | 'sweep1'
    | 'sweep2'
    | 'sweep3'
    | 'heavy_leap'
    | 'dash_strike'
    | 'pillar_perch'
    | 'dharmakaya_cast' = 'none';
  private activeAttackElapsed = 0;
  private activeAttackDuration = 0.4;
  private hitReactionKind: 'none' | 'light' | 'heavy' = 'none';
  private hitReactionElapsed = 0;
  private hitReactionDuration = 0;
  private hitKnockDirX = 0;
  private hitKnockDirZ = 1;
  private hitGroundCrashFired = false;
  private hitKipUpFired = false;
  private readonly lastSimulatedPos = new THREE.Vector3(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
  private visualOffsetY = 0;
  private postureTime = 0;
  private hitFreezeTimer = 0;

  // Physical Camera Impact Spring & Trauma Shake
  private camTrauma = 0;
  private camShakePhase = 0;
  private camKickOffset = new THREE.Vector3();
  private camKickVel = new THREE.Vector3();
  private camFovKick = 0;
  private camFovVel = 0;
  private baseCameraFov = 50;

  private _facingYaw = PLAYER_INITIAL_YAW;
  private targetMoveYaw = PLAYER_INITIAL_YAW;
  private cameraInitialized = false;
  private disposed = false;

  constructor(options?: PlayerEntityOptions) {
    this.arenaRadius = options?.arenaRadius ?? COMBAT_TUNING.arenaRadius;
    this.onError = options?.onError;

    this.rootGroup.name = 'PlayerEntityRoot';
    this.rootGroup.position.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
    this.rootGroup.rotation.set(0, PLAYER_INITIAL_YAW, 0);

    const loader = options?.assetLoader;
    const bundle = loader?.getBundle();

    this.isWukongHero = Boolean(
      !options?.model && loader && bundle?.glbs.has('hero_wukong'),
    );

    if (options?.model) {
      this.model = options.model;
    } else if (this.isWukongHero && loader) {
      const wukongWrapper = new THREE.Group();
      wukongWrapper.name = 'WukongHeroWrapper';
      const wkInner = loader.cloneModel('hero_wukong');
      consolidateModelSkeletons(wkInner);
      wkInner.updateMatrixWorld(true);

      let headBone: THREE.Object3D | null = null;
      let weaponRBone: THREE.Object3D | null = null;
      const staticHairGroups: THREE.Object3D[] = [];
      const plumeMap = new Map<number, THREE.Bone>();

      const sashBoneMap = new Map<string, THREE.Bone>();

      wkInner.traverse((obj) => {
        if ((obj as THREE.Bone).isBone) {
          const b = obj as THREE.Bone;
          const stripped = stripBoneIndexSuffix(b.name);
          if (b.name === 'head_011' || stripped === 'head') {
            headBone = b;
            this.wkBones.head = b;
          }
          if (b.name === 'weapon_r_0114' || stripped === 'weapon_r') {
            weaponRBone = b;
            this.wkBones.weaponR = b;
          }
          if (stripped === 'spine_01') this.wkBones.spine01 = b;
          if (stripped === 'spine_02') this.wkBones.spine02 = b;
          if (stripped === 'spine_03') this.wkBones.spine03 = b;
          if (stripped === 'neck_01') this.wkBones.neck01 = b;
          if (stripped === 'clavicle_l') this.wkBones.clavicleL = b;
          if (stripped === 'upperarm_l') this.wkBones.upperArmL = b;
          if (stripped === 'lowerarm_l') this.wkBones.lowerArmL = b;
          if (stripped === 'hand_l') this.wkBones.handL = b;
          if (stripped === 'clavicle_r') this.wkBones.clavicleR = b;
          if (stripped === 'upperarm_r') this.wkBones.upperArmR = b;
          if (stripped === 'lowerarm_r') this.wkBones.lowerArmR = b;
          if (stripped === 'hand_r') this.wkBones.handR = b;
          if (stripped === 'thigh_l') this.wkBones.thighL = b;
          if (stripped === 'calf_l') this.wkBones.calfL = b;
          if (stripped === 'thigh_r') this.wkBones.thighR = b;
          if (stripped === 'calf_r') this.wkBones.calfR = b;
          if (stripped === 'weapon_cr_2') this.wkBones.weaponCr2 = b;
          if (stripped === 'weapon_cr_1') this.wkBones.weaponCr1 = b;

          if (/^weapon_Index_0[2345]_|^weapon_Index_(0[789]|10)_/i.test(b.name)) {
            this.wkStaffExtendBones.push({
              bone: b,
              baseX: b.position.x,
              isFrontTip: /^weapon_Index_0[345]_/i.test(b.name),
            });
          }
          if (b.name.startsWith('FX_weapontrail_12_0')) {
            this.wkBones.staffTipA = b;
          }
          if (b.name.startsWith('FX_weapontrail_01_0')) {
            this.wkBones.staffTipB = b;
          } else if (!this.wkBones.staffTipB && b.name.startsWith('weapon_Index_10_')) {
            this.wkBones.staffTipB = b;
          }
          const maoMatch = /^mao_(\d+)_0/i.exec(b.name);
          if (maoMatch) {
            plumeMap.set(Number(maoMatch[1]), b);
          }
          if (/^p_02[345678]_/i.test(b.name)) {
            sashBoneMap.set(stripped, b);
          }
        }
        if (obj.name === 'SK_Wukong_head_born_static') {
          staticHairGroups.push(obj);
        }
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const matName = Array.isArray(mesh.material)
            ? mesh.material.map((m) => m?.name ?? '').join(' ')
            : (mesh.material?.name ?? '');
          if (
            /Invisible|weapon_fx/i.test(mesh.name) ||
            /Invisible/i.test(matName)
          ) {
            mesh.visible = false;
          } else {
            mesh.frustumCulled = false;
            if (/Weapon_DaSheng/i.test(mesh.name) || /weapon/i.test(matName)) {
              this.wkStaffMeshes.push(mesh);
            }
          }
        }
      });

      for (let i = 1; i <= 13; i += 1) {
        const b = plumeMap.get(i);
        if (b) this.wkPlumeLeft.push({ bone: b, restQuat: b.quaternion.clone() });
      }
      for (let i = 14; i <= 26; i += 1) {
        const b = plumeMap.get(i);
        if (b) this.wkPlumeRight.push({ bone: b, restQuat: b.quaternion.clone() });
      }
      for (const chainKeys of [
        ['p_023', 'p_024', 'p_025'],
        ['p_026', 'p_027', 'p_028'],
      ]) {
        const chain: Array<{ bone: THREE.Bone; restQuat: THREE.Quaternion }> = [];
        for (const k of chainKeys) {
          const sb = sashBoneMap.get(k);
          if (sb) chain.push({ bone: sb, restQuat: sb.quaternion.clone() });
        }
        if (chain.length > 0) this.wkSashChains.push(chain);
      }

      if (headBone) {
        for (const hairGrp of staticHairGroups) {
          (headBone as THREE.Object3D).attach(hairGrp);
        }
      }
      // Align Ruyi Jingu Bang (tipB -> tipA) 100.00% collinear with Swordsman's katana blade axis in T-pose!
      if (weaponRBone) {
        (weaponRBone as THREE.Object3D).position.set(10.0, 2.0, 0.0);
        (weaponRBone as THREE.Object3D).quaternion
          .set(0.17772, 0.67592, -0.00625, 0.7152)
          .normalize();
      }
      this.applyRuyiStaffScale(1.0);

      // Cache top-down ordered staff bone chain (weapon_r -> weapon_cr_2 -> weapon_cr_1 -> Index_01..05/tipA & 06..10/tipB)
      const staffSeen = new Set<THREE.Object3D>();
      const appendStaffAncestors = (leaf: THREE.Object3D | undefined): void => {
        if (!leaf) return;
        const path: THREE.Object3D[] = [];
        let cur: THREE.Object3D | null = leaf;
        while (cur && cur !== this.wkBones.handR && cur !== wkInner) {
          path.push(cur);
          cur = cur.parent;
        }
        path.reverse();
        for (const node of path) {
          if (!staffSeen.has(node)) {
            staffSeen.add(node);
            this.wkStaffChainBones.push(node);
          }
        }
      };
      appendStaffAncestors(this.wkBones.staffTipA);
      appendStaffAncestors(this.wkBones.staffTipB);

      // Orient raw Sketchfab +X forward to +Z forward in local entity space
      wkInner.rotation.y = -Math.PI / 2;
      wkInner.updateMatrixWorld(true);

      // Measure armored body height excluding the towering crown plumes & staff so Wukong stands at a heroic 2.04m!
      const wkBodyBox = new THREE.Box3();
      wkInner.traverse((obj) => {
        if (
          (obj as THREE.Mesh).isMesh &&
          obj.visible &&
          !/Weapon_DaSheng|weapon_fx|touguanmao/i.test(obj.name)
        ) {
          wkBodyBox.expandByObject(obj);
        }
      });
      const rawBodyHeight = Math.max(0.01, wkBodyBox.max.y - wkBodyBox.min.y);
      const targetBodyHeight = 2.04;
      const wkScale = targetBodyHeight / rawBodyHeight;
      wkInner.scale.setScalar(wkScale);
      wkInner.position.y = -wkBodyBox.min.y * wkScale;

      wukongWrapper.add(wkInner);
      this.model = wukongWrapper;

      // Build 3D Golden Hair-Clone Dodge Silhouette ("聚形散气 · 毫毛金身残影", Pose 3!)
      this.buildGoldenHairCloneSilhouette(loader, wkInner, wkScale, -wkBodyBox.min.y * wkScale);
    } else if (loader && bundle?.glbs.has('player_swordsman')) {
      this.model = loader.cloneModel('player_swordsman');
    } else {
      this.model = new THREE.Group();
      this.model.name = 'PlayerModelFallback';
      if (loader) {
        this.onError?.('Missing loaded GLB asset: player_swordsman');
      }
    }
    this.rootGroup.add(this.model);

    if (options?.weaponModel) {
      this.weaponModel = options.weaponModel;
    } else if (!this.isWukongHero && loader && bundle?.glbs.has('weapon_katana')) {
      this.weaponModel = loader.cloneModel('weapon_katana');
    } else {
      this.weaponModel = null;
    }

    if (this.weaponModel) {
      const attached = attachObjectToBone(
        this.model,
        this.weaponModel,
        ['hand_r'],
        new THREE.Vector3(0.02, 0.09, 0.02),
        new THREE.Euler(0, 0, -Math.PI / 2),
      );
      if (!attached) {
        this.onError?.('Missing player attachment bone: hand_r');
        this.model.add(this.weaponModel);
      }
    }

    this.applyDarkMythMaterials();
    if (!this.isWukongHero) {
      this.attachWaistSilkSash();
    }

    let clips: readonly THREE.AnimationClip[];
    if (options?.clips) {
      clips = options.clips;
    } else if (this.isWukongHero && bundle?.glbs.get('player_swordsman')) {
      const donorGltf = bundle.glbs.get('player_swordsman')!;
      // Ensure model sits at neutral 0 yaw during rest-pose world bind capture
      const prevRootRotY = this.rootGroup.rotation.y;
      this.rootGroup.rotation.y = 0;
      const retargeted = retargetClipsToWukongRig(
        donorGltf.scene,
        donorGltf.animations,
        this.model,
      );
      this.rootGroup.rotation.y = prevRootRotY;
      clips = retargeted;
    } else {
      clips = bundle?.glbs.get('player_swordsman')?.animations ?? [];
    }
    this.rig = new AnimationRig(this.model, clips, PLAYER_CLIPS.idle);
  }

  get position(): THREE.Vector3 {
    return this.rootGroup.position;
  }

  get activeClip(): string {
    return this.rig.activeClipName;
  }

  get facingYaw(): number {
    return this._facingYaw;
  }

  private convertToNodeMaterial(
    origMat: THREE.Material | undefined,
    isWeapon: boolean,
  ): MeshStandardNodeMaterial {
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

    if (this.isWukongHero) {
      const isStaffMesh = lowerName.includes('weapon');
      const isBlendFx =
        lowerName.includes('weapon_fx') || lowerName.includes('eyeao');
      const isArmorGold =
        lowerName.includes('touguan') ||
        lowerName.includes('jianjia') ||
        lowerName.includes('xiongjia') ||
        lowerName.includes('yaojia') ||
        lowerName.includes('qunjia') ||
        lowerName.includes('shoujiao');

      const wkMat = new MeshStandardNodeMaterial({
        name: matName || 'WukongPbrNodeMaterial',
        metalness:
          origMat && 'metalness' in origMat && typeof origMat.metalness === 'number'
            ? origMat.metalness
            : isStaffMesh
              ? 0.86
              : isArmorGold
                ? 0.62
                : 0.18,
        roughness:
          origMat && 'roughness' in origMat && typeof origMat.roughness === 'number'
            ? origMat.roughness
            : isStaffMesh
              ? 0.26
              : isArmorGold
                ? 0.36
                : 0.62,
        side: origSide,
        transparent: isBlendFx,
        depthWrite: !isBlendFx,
      });
      if (origNormalMap) wkMat.normalMap = origNormalMap;
      if (origRoughnessMap) wkMat.roughnessMap = origRoughnessMap;
      if (origMetalnessMap) wkMat.metalnessMap = origMetalnessMap;

      const baseSample = origMap ? texture(origMap) : color(origColor);
      wkMat.colorNode = baseSample;

      const fresnel = pow(
        float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
        2.8,
      );
      if (isStaffMesh) {
        const isGoldCaps = lowerName.includes('side');
        const staffFire = mix(
          color(isGoldCaps ? 0xffb428 : 0xff8c1a),
          color(0xfff4b8),
          saturate(fresnel.add(isGoldCaps ? 0.25 : 0.08)),
        );
        wkMat.emissiveNode = staffFire.mul(
          tslClamp(
            float(isBlendFx ? 0.68 : isGoldCaps ? 0.46 : 0.26).add(
              this.uAuraBoost.mul(0.85),
            ),
            0.0,
            1.85,
          ),
        );
        if (isBlendFx) {
          wkMat.opacityNode = tslClamp(
            float(0.28).add(this.uAuraBoost.mul(0.28)),
            0.0,
            0.85,
          );
        }
      } else {
        wkMat.emissiveNode = color(0xffb84d)
          .mul(fresnel)
          .mul(tslClamp(float(0.06).add(this.uAuraBoost.mul(0.55)), 0.0, 1.15));
      }

      this.ownedMaterials.push(wkMat);
      return wkMat;
    }

    if (isWeapon) {
      const weaponMat = new MeshStandardNodeMaterial({
        name: matName || 'KatanaNodeMaterial',
        metalness: 0.9,
        roughness: 0.22,
        side: origSide,
      });
      if (origNormalMap) weaponMat.normalMap = origNormalMap;
      if (origRoughnessMap) weaponMat.roughnessMap = origRoughnessMap;
      if (origMetalnessMap) weaponMat.metalnessMap = origMetalnessMap;

      const baseSample = origMap ? texture(origMap) : color(origColor);
      weaponMat.colorNode = mix(baseSample, color(0xd8e2ec), float(0.28));

      const fresnel = pow(
        float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
        2.4,
      );
      const edgeSweep = mix(
        color(0x52e0ff),
        color(0xd4a84f),
        smoothstep(0.15, 0.85, uv().x),
      );
      weaponMat.emissiveNode = edgeSweep
        .mul(fresnel.add(0.18))
        .mul(float(0.45).add(this.uAuraBoost.mul(1.35)));

      this.ownedMaterials.push(weaponMat);
      return weaponMat;
    }

    if (lowerName.includes('hair') || lowerName.includes('eye')) {
      const preserved = new MeshStandardNodeMaterial({
        name: matName || 'PlayerAccentNodeMaterial',
        metalness:
          origMat && 'metalness' in origMat && typeof origMat.metalness === 'number'
            ? origMat.metalness
            : 0.12,
        roughness:
          origMat && 'roughness' in origMat && typeof origMat.roughness === 'number'
            ? origMat.roughness
            : 0.55,
        side: origSide,
      });
      if (origNormalMap) preserved.normalMap = origNormalMap;
      if (origRoughnessMap) preserved.roughnessMap = origRoughnessMap;
      if (origMetalnessMap) preserved.metalnessMap = origMetalnessMap;

      const baseTex = origMap ? texture(origMap) : color(origColor);
      preserved.colorNode = lowerName.includes('hair')
        ? mix(baseTex, color(0x1a1714), float(0.45))
        : baseTex;

      if (lowerName.includes('eye')) {
        preserved.emissiveNode = color(0x6bdcff).mul(
          float(0.35).add(this.uAuraBoost.mul(0.9)),
        );
      }

      this.ownedMaterials.push(preserved);
      return preserved;
    }

    // Main Swordsman robe & armor material: pearl-white silk (#eceae4) + black-gold trim (#1a1714 / #d4a84f)
    const bodyMat = new MeshStandardNodeMaterial({
      name: matName || 'SwordsmanRobeNodeMaterial',
      metalness: 0.22,
      roughness: 0.44,
      side: origSide,
    });
    if (origNormalMap) bodyMat.normalMap = origNormalMap;
    if (origRoughnessMap) bodyMat.roughnessMap = origRoughnessMap;
    if (origMetalnessMap) bodyMat.metalnessMap = origMetalnessMap;

    const baseSample = origMap ? texture(origMap) : color(0xeceae4);
    const luma = dot(baseSample.rgb, vec3(0.299, 0.587, 0.114));
    const trimMask = smoothstep(0.32, 0.1, luma);
    const goldEdge = smoothstep(0.18, 0.28, luma).mul(
      smoothstep(0.38, 0.28, luma),
    );
    const silkPalette = mix(
      mix(baseSample, color(0xeceae4), float(0.72)),
      color(0x1a1714),
      trimMask.mul(0.78),
    );
    bodyMat.colorNode = mix(silkPalette, color(0xd4a84f), goldEdge.mul(0.82));

    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      3.4,
    );
    const auraColor = mix(color(0x6bdcff), color(0xd4a84f), goldEdge.mul(0.75));
    bodyMat.emissiveNode = auraColor
      .mul(fresnel.add(goldEdge.mul(0.28)))
      .mul(float(0.28).add(this.uAuraBoost.mul(1.3)));

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

  private attachWaistSilkSash(): void {
    const sashGeom = new THREE.PlaneGeometry(0.18, 0.92, 2, 10);
    sashGeom.translate(0, -0.46, 0);
    this.ownedGeometries.push(sashGeom);

    const sashMat = new MeshStandardNodeMaterial({
      name: 'PlayerWaistSilkSash',
      side: THREE.DoubleSide,
      roughness: 0.48,
      metalness: 0.1,
    });

    // PlaneGeometry UV.y is 1 at top (pinned waist) and 0 at bottom tip
    const pinFactor = float(1.0).sub(uv().y);
    const goldWaistBand = smoothstep(0.84, 0.96, uv().y);
    const darkGoldTip = smoothstep(0.16, 0.0, uv().y);

    const baseSilk = mix(color(0xeceae4), color(0xd4a84f), goldWaistBand);
    sashMat.colorNode = mix(baseSilk, color(0x1a1714), darkGoldTip.mul(0.65));

    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      3.0,
    );
    sashMat.emissiveNode = mix(color(0x6bdcff), color(0xd4a84f), goldWaistBand)
      .mul(fresnel.mul(0.45).add(0.08))
      .mul(float(0.45).add(this.uAuraBoost));

    const waveAmp = float(0.045).add(this.uMoveSpeed.mul(0.015));
    const wave = sin(this.uSashTime.mul(6.0).add(pinFactor.mul(5.0)))
      .mul(pinFactor)
      .mul(waveAmp);
    const swayX = sin(this.uSashTime.mul(3.7).add(pinFactor.mul(3.2)))
      .mul(pinFactor)
      .mul(waveAmp.mul(0.45));
    sashMat.positionNode = positionLocal.add(
      vec3(swayX, float(0), wave.sub(pinFactor.mul(0.04))),
    );

    this.ownedMaterials.push(sashMat);

    const sashMesh = new THREE.Mesh(sashGeom, sashMat);
    sashMesh.name = 'PlayerWaistSilkSashMesh';
    sashMesh.castShadow = true;

    const attached = attachObjectToBone(
      this.model,
      sashMesh,
      ['spine_01', 'pelvis'],
      new THREE.Vector3(0, 0.02, -0.14),
    );
    if (!attached) {
      sashMesh.position.set(0, 1.05, -0.14);
      this.model.add(sashMesh);
    }
  }

  getCameraBasisXZ(camera: THREE.Camera): {
    forwardX: number;
    forwardZ: number;
    rightX: number;
    rightZ: number;
  } {
    camera.getWorldDirection(this.tmpVec3);
    const fx = this.tmpVec3.x;
    const fz = this.tmpVec3.z;
    const len = Math.hypot(fx, fz);

    if (!Number.isFinite(len) || len < 1e-4) {
      return {
        forwardX: 0,
        forwardZ: -1,
        rightX: 1,
        rightZ: 0,
      };
    }

    const forwardX = fx / len;
    const forwardZ = fz / len;
    return {
      forwardX,
      forwardZ,
      rightX: -forwardZ,
      rightZ: forwardX,
    };
  }

  applyCameraOrbitDelta(dx: number, dy: number): void {
    const safeDx = Number.isFinite(dx) ? dx : 0;
    const safeDy = Number.isFinite(dy) ? dy : 0;
    this.cameraYaw -= safeDx * CAMERA_ORBIT_SENSITIVITY;
    this.cameraPitch = clamp(
      this.cameraPitch + safeDy * CAMERA_ORBIT_SENSITIVITY,
      CAMERA_MIN_PITCH,
      CAMERA_MAX_PITCH,
    );
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
      this._facingYaw = yaw;
      this.targetMoveYaw = yaw;
      this.rootGroup.rotation.y = yaw;
    }
  }

  setMoveDirection(
    dirX: number,
    dirZ: number,
    speed = COMBAT_TUNING.playerMoveSpeed,
  ): void {
    const sx = Number.isFinite(dirX) ? dirX : 0;
    const sz = Number.isFinite(dirZ) ? dirZ : 0;
    const safeSpeed =
      Number.isFinite(speed) && speed >= 0
        ? speed
        : COMBAT_TUNING.playerMoveSpeed;
    const len = Math.hypot(sx, sz);

    if (len > 1e-5 && safeSpeed > 0) {
      const nx = sx / len;
      const nz = sz / len;
      this.velocity.set(nx * safeSpeed, 0, nz * safeSpeed);
      this.targetMoveYaw = Math.atan2(nx, nz);
    } else {
      this.velocity.set(0, 0, 0);
    }
  }

  setMoveAnimation(isMoving: boolean, isSprinting = false): void {
    if (isMoving) {
      this.playClip(
        isSprinting ? PLAYER_CLIPS.sprint : PLAYER_CLIPS.jog,
        {
          fadeSeconds: 0.1,
          timeScale: this.isWukongHero ? (isSprinting ? 1.28 : 1.16) : 1.0,
        },
      );
    } else {
      this.playClip(PLAYER_CLIPS.idle, { fadeSeconds: 0.14 });
    }
  }

  playClip(
    nameOrCandidates: string | readonly string[],
    options?: PlayClipOptions,
  ): string {
    this.restorePostSolvedBones();
    return this.rig.play(nameOrCandidates, options);
  }

  /**
   * Restores every post-solved bone back to its un-mutated AnimationMixer quaternion
   * BEFORE the next mixer.update() so Three.js PropertyMixer's constant-track cache
   * never skips resetting a bone and NEVER accumulates rotation across frames!
   */
  private restorePostSolvedBones(): void {
    for (let i = this.postSolvedCount - 1; i >= 0; i -= 1) {
      const snap = this.postSolvedSnapshots[i]!;
      snap.bone.quaternion.copy(snap.animQuat);
    }
    this.postSolvedCount = 0;
  }

  /**
   * Freezes Wukong's attack animation right at the moment the staff bites into the Boss
   * for meaty, bone-crunching contact weight without altering deterministic combat timers.
   */
  triggerHitFreeze(durationSeconds: number): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    this.hitFreezeTimer = Math.max(
      this.hitFreezeTimer,
      clamp(durationSeconds, 0, 0.16),
    );
  }

  setAuraIntensity(intensity: number): void {
    this.uAuraBoost.value = clamp(intensity, 0, 3);
  }

  /**
   * Dynamically extends or retracts Wukong's telescopic Ruyi Jingu Bang
   * (1.0 = ~3.95m base divine polearm; up to 1.85 = ~6.7m heavy heaven-splitting pillar!).
   */
  setStaffExtension(multiplier: number): void {
    this.staffExtTarget = clamp(
      Number.isFinite(multiplier) ? multiplier : 1.0,
      0.9,
      2.1,
    );
  }

  private buildGoldenHairCloneSilhouette(
    loader: AssetLoader,
    srcInner: THREE.Object3D,
    wkScale: number,
    wkOffsetY: number,
  ): void {
    const cloneWrapper = new THREE.Group();
    cloneWrapper.name = 'WukongGoldenHairClone';
    cloneWrapper.visible = false;

    const cloneInner = loader.cloneModel('hero_wukong');
    this.goldenCloneSkeleton = consolidateModelSkeletons(cloneInner);
    cloneInner.rotation.y = -Math.PI / 2;
    cloneInner.scale.setScalar(wkScale);
    cloneInner.position.y = wkOffsetY;

    const cloneMat = new MeshStandardNodeMaterial({
      name: 'WukongGoldenHairCloneNodeMaterial',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      roughness: 0.35,
      metalness: 0.75,
    });
    const fresnel = pow(
      float(1.0).sub(saturate(dot(normalView, positionViewDirection))),
      2.1,
    );
    cloneMat.colorNode = color(0xffc84a);
    cloneMat.emissiveNode = mix(
      color(0xff8c1a),
      color(0xfff2b2),
      fresnel,
    ).mul(fresnel.mul(1.85).add(0.4));
    cloneMat.opacityNode = this.uCloneOpacity.mul(fresnel.mul(0.85).add(0.28));
    this.ownedMaterials.push(cloneMat);

    const srcBonesByName = new Map<string, THREE.Bone>();
    srcInner.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        srcBonesByName.set(o.name, o as THREE.Bone);
      }
    });

    let cloneHead: THREE.Object3D | null = null;
    const cloneHairGroups: THREE.Object3D[] = [];
    cloneInner.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        const dstB = o as THREE.Bone;
        if (dstB.name === 'head_011' || stripBoneIndexSuffix(dstB.name) === 'head') {
          cloneHead = dstB;
        }
        const srcB = srcBonesByName.get(dstB.name);
        if (srcB) {
          this.goldenCloneBonePairs.push({ src: srcB, dst: dstB });
        }
      }
      if (o.name === 'SK_Wukong_head_born_static') {
        cloneHairGroups.push(o);
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
          m.material = cloneMat;
          m.castShadow = false;
          m.receiveShadow = false;
          m.frustumCulled = false;
        }
      }
    });
    if (cloneHead) {
      for (const hg of cloneHairGroups) {
        (cloneHead as THREE.Object3D).attach(hg);
      }
    }

    cloneWrapper.add(cloneInner);
    // Render dodge phantom ONLY on main camera (excluded from groundReflector) and keep detached when inactive
    setObjectLayerRecursive(cloneWrapper, LAYER_MAIN_ONLY);
    this.goldenCloneGroup = cloneWrapper;
  }

  /**
   * Freezes a glowing 3D Golden Hair-Clone Afterimage ("聚形散气 · 身外毫毛残影") at Wukong's
   * departure world position & pose right as he dashes away (Pose 3!).
   */
  triggerDodgePhantom(): void {
    if (!this.isWukongHero || !this.goldenCloneGroup) return;
    this.combatAlertTimer = 4.2;
    this.goldenCloneWorldPos.copy(this.rootGroup.position);
    this.goldenCloneWorldYaw = this._facingYaw;
    for (const pair of this.goldenCloneBonePairs) {
      pair.dst.quaternion.copy(pair.src.quaternion);
      pair.dst.position.copy(pair.src.position);
    }
    this.goldenCloneTimer = this.goldenCloneDuration;
    this.uCloneOpacity.value = 0.85;

    const sceneParent = this.rootGroup.parent;
    if (sceneParent) {
      if (this.goldenCloneGroup.parent !== sceneParent) {
        sceneParent.add(this.goldenCloneGroup);
      }
      this.goldenCloneGroup.position.copy(this.goldenCloneWorldPos);
      this.goldenCloneGroup.rotation.set(0, this.goldenCloneWorldYaw, 0);
    } else {
      if (this.goldenCloneGroup.parent !== this.rootGroup) {
        this.rootGroup.add(this.goldenCloneGroup);
      }
      this.goldenCloneGroup.position.set(0, 0, 0);
      this.goldenCloneGroup.rotation.set(0, 0, 0);
    }

    this.goldenCloneGroup.visible = true;
    // Update pose & skeleton once at spawn (remains frozen during 0.46s fade)
    this.goldenCloneGroup.updateMatrixWorld(true);
    this.goldenCloneSkeleton?.update();
  }

  /**
   * Notifies Wukong's 6-pose choreographer of an active melee sweep, pillar-perch ascent, or leaping heavy smash.
   */
  notifyAttackPose(
    kind:
      | 'sweep1'
      | 'sweep2'
      | 'sweep3'
      | 'heavy_leap'
      | 'dash_strike'
      | 'pillar_perch'
      | 'dharmakaya_cast',
    durationSeconds: number,
  ): void {
    this.activeAttackKind = kind;
    this.activeAttackElapsed = 0;
    this.activeAttackDuration = Math.max(0.12, durationSeconds);
    this.combatAlertTimer = 4.5;
  }

  /**
   * Triggers tiered Wukong hit reaction choreography (GPT Image 2.6 Hit Reference):
   * - 'light': Two-handed horizontal Ruyi Jingu Bang chest-brace + bluestone boot-skid with sparks!
   * - 'heavy': Parabolic airborne knockback -> supine ground crash -> Golden Lotus Kip-Up vault!
   */
  triggerHitReactionPose(
    severity: 'light' | 'heavy',
    knockDirX: number,
    knockDirZ: number,
  ): void {
    const len = Math.hypot(knockDirX, knockDirZ);
    this.hitKnockDirX = len > 1e-4 ? knockDirX / len : -Math.sin(this._facingYaw);
    this.hitKnockDirZ = len > 1e-4 ? knockDirZ / len : -Math.cos(this._facingYaw);

    // Face toward the incoming Boss strike so Wukong braces or flies backward heroically
    const faceYaw = Math.atan2(-this.hitKnockDirX, -this.hitKnockDirZ);
    if (Number.isFinite(faceYaw)) {
      this._facingYaw = faceYaw;
      this.targetMoveYaw = faceYaw;
      this.rootGroup.rotation.y = faceYaw;
    }

    this.activeAttackKind = 'none';
    this.hitReactionKind = severity;
    this.hitReactionElapsed = 0;
    this.hitReactionDuration = severity === 'heavy' ? 0.92 : 0.36;
    this.hitGroundCrashFired = false;
    this.hitKipUpFired = false;
    this.combatAlertTimer = 4.2;
    this.lastSimulatedPos.copy(this.rootGroup.position);
  }

  /**
   * Immediately cancels an active hit-slide or knockdown (e.g., Space Ukemi Kip-Up Dodge or Skill cast).
   */
  cancelHitReactionPose(): 'none' | 'light' | 'heavy' {
    const prev = this.hitReactionKind;
    this.hitReactionKind = 'none';
    this.hitReactionElapsed = 0;
    this.hitGroundCrashFired = false;
    this.hitKipUpFired = false;
    this.model.rotation.x = 0;
    return prev;
  }

  getHitReactionState(): {
    kind: 'none' | 'light' | 'heavy';
    elapsed: number;
    duration: number;
  } {
    return {
      kind: this.hitReactionKind,
      elapsed: this.hitReactionElapsed,
      duration: this.hitReactionDuration,
    };
  }

  isSkiddingFromLightHit(): boolean {
    return (
      this.hitReactionKind === 'light' &&
      this.hitReactionElapsed < this.hitReactionDuration * 0.78
    );
  }

  consumeKnockdownGroundCrash(): boolean {
    if (
      this.hitReactionKind === 'heavy' &&
      !this.hitGroundCrashFired &&
      this.hitReactionElapsed >= 0.38
    ) {
      this.hitGroundCrashFired = true;
      return true;
    }
    return false;
  }

  consumeKnockdownKipUp(): boolean {
    if (
      this.hitReactionKind === 'heavy' &&
      !this.hitKipUpFired &&
      this.hitReactionElapsed >= 0.64
    ) {
      this.hitKipUpFired = true;
      return true;
    }
    return false;
  }

  private applyRuyiStaffScale(extMultiplier: number, slideOffset = 0): void {
    if (!this.isWukongHero) return;
    const safeExt = clamp(extMultiplier, 0.9, 2.1);
    const tipPillarSwell = 1.0 + Math.max(0, safeExt - 1.18) * 0.72;
    const jointFactor = 1.48 * safeExt;
    for (const entry of this.wkStaffExtendBones) {
      entry.bone.position.x = entry.baseX * jointFactor;
      if (entry.isFrontTip) {
        entry.bone.scale.set(1.0, tipPillarSwell, tipPillarSwell);
      }
    }
    if (this.wkBones.weaponCr1) {
      const girth = 1.26 + (safeExt - 1.0) * 0.28;
      const axial = 1.22 + (safeExt - 1.0) * 0.28;
      this.wkBones.weaponCr1.scale.set(axial, girth, girth);
      this.wkBones.weaponCr1.position.x = slideOffset;
    }
  }

  /**
   * Triggers physical directional camera kick, high-frequency hit shudder, and FOV punch.
   */
  triggerCameraImpact(
    intensity: number,
    dirX = 0,
    dirZ = -1,
    fovKickDeg = 0,
  ): void {
    if (!Number.isFinite(intensity) || intensity <= 0) return;
    const clamped = clamp(intensity, 0, 2.0);
    this.camTrauma = Math.min(1.4, this.camTrauma + clamped * 0.58);
    const len = Math.hypot(dirX, dirZ);
    const nx = len > 1e-4 ? dirX / len : 0;
    const nz = len > 1e-4 ? dirZ / len : -1;
    // Kick camera briskly along strike impulse so heavy staff blows feel thunderous
    this.camKickVel.x -= nx * clamped * 5.2;
    this.camKickVel.y += clamped * 2.1;
    this.camKickVel.z -= nz * clamped * 5.2;
    if (Number.isFinite(fovKickDeg) && fovKickDeg !== 0) {
      this.camFovVel -= clamp(fovKickDeg, -8, 8) * 28;
    }
  }

  getStaffTipWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.wkBones.staffTipA) {
      this.wkBones.staffTipA.updateWorldMatrix(true, false);
      return this.wkBones.staffTipA.getWorldPosition(out);
    }
    this.rootGroup.updateWorldMatrix(true, false);
    return out.set(
      this.rootGroup.position.x + Math.sin(this._facingYaw) * 2.2,
      1.35,
      this.rootGroup.position.z + Math.cos(this._facingYaw) * 2.2,
    );
  }

  getStaffRearTipWorldPosition(out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.isWukongHero || !this.wkBones.staffTipA) {
      return null;
    }
    this.wkBones.staffTipA.updateWorldMatrix(true, false);
    return this.wkBones.staffTipA.getWorldPosition(out);
  }

  isDraggingStaffOnGround(): boolean {
    return this.isWukongHero && this.runPostureWeight > 0.55 && this.uMoveSpeed.value > 2.5;
  }

  setWeaponMeshVisible(visible: boolean): void {
    for (const m of this.wkStaffMeshes) {
      m.visible = visible;
    }
    if (this.weaponModel) {
      this.weaponModel.visible = visible;
    }
  }

  getRightEarWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.wkBones.head) {
      this.wkBones.head.updateWorldMatrix(true, false);
      this.wkBones.head.getWorldPosition(out);
      const rightX = Math.cos(this._facingYaw);
      const rightZ = -Math.sin(this._facingYaw);
      out.x -= rightX * 0.16;
      out.y += 0.04;
      out.z -= rightZ * 0.16;
      return out;
    }
    this.rootGroup.updateWorldMatrix(true, false);
    return out.set(
      this.rootGroup.position.x - 0.16,
      1.68,
      this.rootGroup.position.z,
    );
  }

  /**
   * Drives Sun Wukong's 4-Shot Opening Cinematic choreography:
   * - Shot 1 (0.00..0.25): Hidden high on Somersault Cloud while Boss Jiebo crashes down
   * - Shot 2 (0.25..0.52): Golden Somersault Cloud dive -> Superhero One-Knee Ground-Touch Crouch!
   * - Shot 3 (0.52..0.78): Plucking Golden Needle from Right Ear -> Explosive Ruyi Jingu Bang Slam!
   * - Shot 4 (0.78..1.00): Two-Handed Dragon-Spear Standoff -> Smooth transition into live gameplay!
   */
  updateIntroChoreography(progress: number): void {
    const p = clamp01(progress);
    this.introActive = true;
    this.introProgress = p;
    this._facingYaw = PLAYER_INITIAL_YAW;
    this.targetMoveYaw = PLAYER_INITIAL_YAW;
    this.rootGroup.rotation.y = PLAYER_INITIAL_YAW;

    if (p < 0.25) {
      this.setWeaponMeshVisible(false);
      this.rootGroup.position.set(-3.6, 0, 10.5);
      this.lastSimulatedPos.copy(this.rootGroup.position);
      this.uAuraBoost.value = 0;
    } else if (p < 0.52) {
      // Shot 2: Somersault Cloud streak (-3.6, +10.5) -> (0, +4.0) touchdown at p = 0.36!
      this.setWeaponMeshVisible(false);
      const flyT = smoothstepScalar(0.25, 0.36, p);
      this.rootGroup.position.set(
        -3.6 * (1 - flyT),
        0,
        10.5 * (1 - flyT) + PLAYER_SPAWN_Z * flyT,
      );
      this.lastSimulatedPos.copy(this.rootGroup.position);
      this.uAuraBoost.value = p >= 0.36 ? 0.85 : 0.55;
    } else if (p < 0.78) {
      // Shot 3: Ear-Needle Pluck (0.52..0.625) -> Explosive Ruyi Jingu Bang Conjure & Slam (0.625..0.78)!
      this.rootGroup.position.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
      this.lastSimulatedPos.copy(this.rootGroup.position);
      if (p < 0.625) {
        this.setWeaponMeshVisible(false);
        this.staffExtCurrent = 0.2;
        this.staffExtTarget = 0.2;
        this.uAuraBoost.value = 0.65;
      } else {
        this.setWeaponMeshVisible(true);
        const growT = smoothstepScalar(0.625, 0.7, p);
        const settleT = smoothstepScalar(0.7, 0.78, p);
        const ext = 0.2 + growT * 1.55 - settleT * 0.5;
        this.staffExtCurrent = ext;
        this.staffExtTarget = ext;
        this.uAuraBoost.value = 1.1 - settleT * 0.35;
      }
    } else {
      // Shot 4: Dragon-Spear Standoff -> Smooth blend into ready stance at p = 1.0!
      this.setWeaponMeshVisible(true);
      this.rootGroup.position.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
      this.lastSimulatedPos.copy(this.rootGroup.position);
      const settle = smoothstepScalar(0.88, 1.0, p);
      const ext = 1.48 * (1 - settle) + 1.0 * settle;
      this.staffExtCurrent = ext;
      this.staffExtTarget = ext;
      this.uAuraBoost.value = 0.40 * (1 - settle);
    }
  }

  setPrewarmVisible(enabled: boolean): void {
    if (!this.goldenCloneGroup) return;
    if (enabled) {
      const targetParent = this.rootGroup.parent ?? this.rootGroup;
      if (this.goldenCloneGroup.parent !== targetParent) {
        targetParent.add(this.goldenCloneGroup);
      }
      this.goldenCloneGroup.position.copy(this.rootGroup.position);
      this.goldenCloneGroup.scale.setScalar(0.001);
      this.goldenCloneGroup.visible = true;
    } else {
      this.goldenCloneGroup.visible = false;
      this.goldenCloneGroup.scale.setScalar(1);
      this.goldenCloneGroup.removeFromParent();
    }
  }

  clearIntroChoreography(): void {
    if (!this.introActive && this.wkStaffMeshes.every((m) => m.visible)) {
      return;
    }
    this.introActive = false;
    this.introProgress = 0;
    this.setWeaponMeshVisible(true);
    this.staffExtCurrent = 1.0;
    this.staffExtTarget = 1.0;
    this.uAuraBoost.value = 0;
    this.visualOffsetY = 0;
    this.model.position.y = 0;
    this.model.rotation.x = 0;
    this.rootGroup.position.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
    this.lastSimulatedPos.copy(this.rootGroup.position);
  }

  private applyWukongMartialPosture(
    playerDt: number,
    rawDt: number,
    _bossPos?: Vec3Like,
  ): void {
    if (!this.isWukongHero) return;

    this.postureTime += rawDt;

    const clip = this.rig.activeClipName;
    const isIdleClip = clip === 'Sword_Idle' || clip === 'Idle_Loop';
    const isDodgeClip = clip === 'Roll' || clip === 'Slide_Start';
    const isRunClip =
      (clip === 'Jog_Fwd_Loop' || clip === 'Sprint_Loop') && !isDodgeClip;
    const isAttackClip =
      clip === 'Sword_Regular_A' ||
      clip === 'Sword_Regular_B' ||
      clip === 'Sword_Regular_C' ||
      clip === 'Sword_Regular_Combo' ||
      clip === 'Sword_Attack' ||
      clip === 'Sword_Heavy_Combo' ||
      clip === 'Sword_Dash' ||
      clip === 'Spell_Simple_Shoot';

    // Keep Shoulder-Rest Swagger (Pose 1A) as Wukong's signature default stance,
    // switching to Diagonal Martial Guard (Pose 1B) for 2.6s right after Wukong attacks or dodges!
    if (isAttackClip || isDodgeClip) {
      this.combatAlertTimer = 2.6;
    } else {
      this.combatAlertTimer = Math.max(0, this.combatAlertTimer - rawDt);
    }

    if (this.activeAttackKind !== 'none') {
      this.activeAttackElapsed += Math.max(playerDt, rawDt * 0.5);
      if (this.activeAttackElapsed >= this.activeAttackDuration || isIdleClip || isRunClip || isDodgeClip) {
        if (!isAttackClip) {
          this.activeAttackKind = 'none';
        }
      }
    }

    // Determine target Ruyi Jingu Bang grip slide along shaft:
    // - Pose 1A Shoulder-Rest Idle: -18 cm (balanced across shoulders)
    // - Pose 1B Combat-Ready Diagonal Guard: -42 cm (sweeping diagonally across back)
    // - Pose 2 Drag-Staff Sprint: +118 cm (short front grip, 3.1m trailing backward skimming stone!)
    // - Pose 3 Low Coiled Dodge: +58 cm (diagonal two-handed body guard)
    // - Pose 4 & 5 Two-Handed Sweep / Giant Pillar Smash: +126 cm (80% polearm reach!)
    if (this.introActive) {
      if (this.introProgress < 0.625) {
        this.staffSlideTarget = 0.0;
      } else if (this.introProgress < 0.78) {
        this.staffSlideTarget = 48.0;
      } else {
        const settle = smoothstepScalar(0.88, 1.0, this.introProgress);
        this.staffSlideTarget = 124.0 * (1 - settle) - 18.0 * settle;
      }
    } else if (this.hitReactionKind !== 'none') {
      this.staffSlideTarget = this.hitReactionKind === 'light' ? -12.0 : 34.0;
    } else if (this.activeAttackKind === 'pillar_perch') {
      this.staffSlideTarget = 68.0;
    } else if (isAttackClip || this.activeAttackKind !== 'none') {
      this.staffSlideTarget = 126.0;
    } else if (isDodgeClip) {
      this.staffSlideTarget = 58.0;
    } else if (isRunClip) {
      this.staffSlideTarget = 118.0;
    } else {
      this.staffSlideTarget = this.combatAlertTimer > 0.1 ? -42.0 : -18.0;
    }

    const extAlpha = 1 - Math.exp(-18 * Math.max(playerDt, rawDt, 0.008));
    this.staffExtCurrent += (this.staffExtTarget - this.staffExtCurrent) * extAlpha;
    this.staffSlideCurrent += (this.staffSlideTarget - this.staffSlideCurrent) * extAlpha;
    this.applyRuyiStaffScale(this.staffExtCurrent, this.staffSlideCurrent);

    const hitSuppress = this.hitReactionKind !== 'none' || (this.introActive && this.introProgress < 0.92);
    const blendRate = 1 - Math.exp(-15 * Math.max(playerDt, 0.008));
    this.idlePostureWeight +=
      ((isIdleClip && !hitSuppress ? 1 : 0) - this.idlePostureWeight) * blendRate;
    this.runPostureWeight +=
      ((isRunClip && !hitSuppress ? 1 : 0) - this.runPostureWeight) * blendRate;
    this.dodgePostureWeight +=
      ((isDodgeClip && !hitSuppress ? 1 : 0) - this.dodgePostureWeight) * blendRate;
    this.combatAlertBlend +=
      ((this.combatAlertTimer > 0.05 ? 1 : 0) - this.combatAlertBlend) *
      (1 - Math.exp(-6 * Math.max(rawDt, 0.008)));

    // Compute vertical visual offset & body pitch (Intro Cloud Dive, Heavy Knockdown, Kip-Up, Pillar-Perch!)
    let targetVisualY = 0;
    let targetBodyPitchX = 0;
    if (this.introActive) {
      const ip = this.introProgress;
      if (ip < 0.25) {
        targetVisualY = 24.0;
      } else if (ip < 0.36) {
        // Somersault Cloud front-flip descent from y = +9.5m -> -0.48m!
        const dT = clamp01((ip - 0.25) / 0.11);
        targetVisualY = 9.5 * (1 - dT * dT) - 0.48 * dT;
        targetBodyPitchX = (1 - smoothstepScalar(0.0, 0.95, dT)) * Math.PI * 2.0;
      } else if (ip < 0.52) {
        // Superhero One-Knee Ground-Touch Crouch!
        targetVisualY = -0.48;
        targetBodyPitchX = 0.08;
      } else if (ip < 0.625) {
        // Rising smoothly to pluck the Golden Needle from Right Ear
        const riseT = smoothstepScalar(0.52, 0.58, ip);
        targetVisualY = -0.48 * (1 - riseT);
      } else if (ip < 0.78) {
        targetVisualY = -0.08;
      } else {
        const settle = smoothstepScalar(0.88, 1.0, ip);
        targetVisualY = -0.14 * (1 - settle);
      }
      this.visualOffsetY = targetVisualY;
      this.model.position.y = targetVisualY;
      this.model.rotation.x = targetBodyPitchX;
    } else if (this.hitReactionKind === 'light') {
      targetVisualY = -0.22;
      targetBodyPitchX = 0.04;
    } else if (this.hitReactionKind === 'heavy') {
      const t = this.hitReactionElapsed;
      if (t < 0.38) {
        // Phase A: Parabolic airborne blast-back arc -> pitching backward onto Wukong's back!
        const pAir = clamp01(t / 0.38);
        targetVisualY = Math.sin(pAir * Math.PI) * 1.08 - pAir * 0.34;
        targetBodyPitchX = -1.26 * smoothstepScalar(0.0, 0.92, pAir);
      } else if (t < 0.64) {
        // Phase B: Supine bluestone crash & skid
        targetVisualY = -0.35;
        targetBodyPitchX = -1.32;
      } else {
        // Phase C: Golden Lotus Kip-Up Vault ("撑棍鲤鱼打挺·金莲弹起")!
        const pKip = clamp01((t - 0.64) / 0.28);
        targetVisualY =
          -0.35 * (1 - smoothstepScalar(0.0, 0.45, pKip)) +
          Math.sin(pKip * Math.PI) * 0.46;
        targetBodyPitchX = -1.32 * (1 - smoothstepScalar(0.0, 0.86, pKip));
      }
    } else if (this.activeAttackKind === 'pillar_perch') {
      const p = clamp01(this.activeAttackElapsed / this.activeAttackDuration);
      if (p < 0.36) {
        // Stage A: Vaulting crouched atop vertically rising Golden Ruyi Pillar!
        targetVisualY = smoothstepScalar(0.0, 1.0, p / 0.36) * 2.85;
      } else if (p < 0.74) {
        // Stage B: Front-flipping downward driving colossal 定海神针 onto Boss!
        const pDown = clamp01((p - 0.36) / 0.38);
        targetVisualY = 2.85 * (1 - pDown * pDown) - 0.14 * pDown;
        targetBodyPitchX = Math.sin(pDown * Math.PI) * 0.36;
      } else {
        targetVisualY = -0.14 * (1 - (p - 0.74) / 0.26);
      }
    } else if (this.activeAttackKind === 'heavy_leap' && isAttackClip) {
      const p = clamp01(this.activeAttackElapsed / this.activeAttackDuration);
      if (p < 0.72) {
        const jumpArc = Math.sin((p / 0.72) * Math.PI);
        targetVisualY = Math.pow(jumpArc, 0.78) * 1.32;
      } else {
        targetVisualY = -0.14 * (1 - (p - 0.72) / 0.28);
      }
    } else if (isDodgeClip) {
      targetVisualY = -0.26;
    } else if (isAttackClip) {
      targetVisualY = -0.14;
    } else if (isRunClip) {
      targetVisualY = -0.07;
    } else if (isIdleClip) {
      targetVisualY = -0.06 * this.combatAlertBlend;
    }
    if (!this.introActive) {
      const yLerp = 1 - Math.exp(-24 * Math.max(playerDt, rawDt, 0.008));
      this.visualOffsetY += (targetVisualY - this.visualOffsetY) * yLerp;
      this.model.position.y = this.visualOffsetY;
      this.model.rotation.x += (targetBodyPitchX - this.model.rotation.x) * yLerp;
    }

    this.rootGroup.updateWorldMatrix(true, false);
    this.model.updateMatrixWorld(true);
    const rootWQ = this.rootGroup.getWorldQuaternion(this.wkRootWQ);
    const invRootWQ = this.wkInvRootWQ.copy(rootWQ).invert();

    // Snapshot clean AnimationMixer bone quaternions BEFORE applying this frame's 6-pose solver!
    const snapshotBone = (b: THREE.Bone | undefined): void => {
      if (!b) return;
      for (let i = 0; i < this.postSolvedCount; i += 1) {
        if (this.postSolvedSnapshots[i]!.bone === b) return;
      }
      const existing = this.postSolvedSnapshots[this.postSolvedCount];
      if (existing) {
        existing.bone = b;
        existing.animQuat.copy(b.quaternion);
      } else {
        this.postSolvedSnapshots.push({ bone: b, animQuat: b.quaternion.clone() });
      }
      this.postSolvedCount += 1;
    };
    snapshotBone(this.wkBones.spine01);
    snapshotBone(this.wkBones.spine02);
    snapshotBone(this.wkBones.spine03);
    snapshotBone(this.wkBones.head);
    snapshotBone(this.wkBones.clavicleL);
    snapshotBone(this.wkBones.upperArmL);
    snapshotBone(this.wkBones.lowerArmL);
    snapshotBone(this.wkBones.handL);
    snapshotBone(this.wkBones.clavicleR);
    snapshotBone(this.wkBones.upperArmR);
    snapshotBone(this.wkBones.lowerArmR);
    snapshotBone(this.wkBones.handR);
    snapshotBone(this.wkBones.thighL);
    snapshotBone(this.wkBones.calfL);
    snapshotBone(this.wkBones.thighR);
    snapshotBone(this.wkBones.calfR);

    const tmpPosA = this.wkPosA;
    const tmpPosB = this.wkPosB;
    const curDirW = this.wkCurDirW;
    const tgtDirW = this.wkTgtDirW;
    const parentWQ = this.wkParentWQ;
    const curWQ = this.wkCurWQ;
    const rotDelta = this.wkRotDelta;
    const blendedQ = this.wkBlendedQ;

    const syncNodeWorld = (node: THREE.Object3D | undefined): void => {
      if (!node) return;
      node.updateMatrix();
      if (node.parent) {
        node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
      } else {
        node.matrixWorld.copy(node.matrix);
      }
      // Deliberately keep node.matrixWorldNeedsUpdate = true so the final
      // this.model.updateMatrixWorld(false) propagates force=true to unvisited children.
    };

    let spineDirty = false;
    let staffChainDirty = false;

    const flushSpineBridge = (): void => {
      if (!spineDirty) return;
      spineDirty = false;
      syncNodeWorld(this.wkBones.spine02);
      syncNodeWorld(this.wkBones.spine03);
      syncNodeWorld(this.wkBones.neck01);
      syncNodeWorld(this.wkBones.head);
      syncNodeWorld(this.wkBones.clavicleR);
      syncNodeWorld(this.wkBones.upperArmR);
      syncNodeWorld(this.wkBones.lowerArmR);
      syncNodeWorld(this.wkBones.handR);
      syncNodeWorld(this.wkBones.clavicleL);
      syncNodeWorld(this.wkBones.upperArmL);
      syncNodeWorld(this.wkBones.lowerArmL);
      syncNodeWorld(this.wkBones.handL);
      staffChainDirty = true;
    };

    const syncStaffChain = (): void => {
      for (let i = 0; i < this.wkStaffChainBones.length; i += 1) {
        syncNodeWorld(this.wkStaffChainBones[i]);
      }
      staffChainDirty = false;
    };

    const applyEntityEulerAdditive = (
      bone: THREE.Bone | undefined,
      rx: number,
      ry: number,
      rz: number,
      weight: number,
    ): void => {
      if (!bone || !bone.parent || weight <= 0.001) return;
      if (bone === this.wkBones.spine01) {
        // spine01 parent (pelvis) is already synced
      } else if (bone === this.wkBones.spine02) {
        if (spineDirty) syncNodeWorld(bone);
      } else if (bone === this.wkBones.spine03) {
        if (spineDirty) {
          syncNodeWorld(this.wkBones.spine02);
          syncNodeWorld(bone);
        }
      } else if (spineDirty) {
        flushSpineBridge();
      }
      bone.parent.getWorldQuaternion(parentWQ);
      bone.getWorldQuaternion(curWQ);
      this.wkEntityEuler.set(rx * weight, ry * weight, rz * weight, 'YXZ');
      this.wkEntityDelta.setFromEuler(this.wkEntityEuler);
      this.wkWorldDelta.copy(rootWQ).multiply(this.wkEntityDelta).multiply(invRootWQ);
      this.wkTargetWQ.copy(this.wkWorldDelta).multiply(curWQ);
      bone.quaternion.copy(parentWQ.invert().multiply(this.wkTargetWQ)).normalize();
      syncNodeWorld(bone);
      if (
        bone === this.wkBones.spine01 ||
        bone === this.wkBones.spine02 ||
        bone === this.wkBones.spine03
      ) {
        spineDirty = true;
      }
    };

    const aimBoneInEntitySpace = (
      bone: THREE.Bone | undefined,
      child: THREE.Object3D | undefined,
      ex: number,
      ey: number,
      ez: number,
      weight: number,
    ): void => {
      if (!bone || !child || !bone.parent || weight <= 0.001) return;
      if (spineDirty) flushSpineBridge();
      bone.getWorldPosition(tmpPosA);
      child.getWorldPosition(tmpPosB);
      curDirW.copy(tmpPosB).sub(tmpPosA).normalize();
      tgtDirW.set(ex, ey, ez).normalize().applyQuaternion(rootWQ);
      if (curDirW.lengthSq() < 0.5 || tgtDirW.lengthSq() < 0.5) return;
      rotDelta.setFromUnitVectors(curDirW, tgtDirW);
      bone.parent.getWorldQuaternion(parentWQ);
      bone.getWorldQuaternion(curWQ);
      this.wkTargetWQ.copy(rotDelta).multiply(curWQ);
      blendedQ.copy(curWQ).slerp(this.wkTargetWQ, clamp01(weight));
      bone.quaternion.copy(parentWQ.invert().multiply(blendedQ)).normalize();
      syncNodeWorld(bone);
      if (bone === this.wkBones.upperArmR) {
        syncNodeWorld(this.wkBones.lowerArmR);
        syncNodeWorld(this.wkBones.handR);
        staffChainDirty = true;
      } else if (bone === this.wkBones.lowerArmR) {
        syncNodeWorld(this.wkBones.handR);
        staffChainDirty = true;
      } else if (bone === this.wkBones.upperArmL) {
        syncNodeWorld(this.wkBones.lowerArmL);
        syncNodeWorld(this.wkBones.handL);
      } else if (bone === this.wkBones.lowerArmL) {
        syncNodeWorld(this.wkBones.handL);
      } else {
        syncNodeWorld(child);
      }
    };

    // Exact 0.00-degree Ruyi Jingu Bang shaft alignment using live (staffTipB -> staffTipA) world vector!
    const aimStaffInEntitySpace = (
      ex: number,
      ey: number,
      ez: number,
      weight: number,
    ): void => {
      const handBone = this.wkBones.handR;
      const tipA = this.wkBones.staffTipA;
      const tipB = this.wkBones.staffTipB;
      if (!handBone || !handBone.parent || !tipA || !tipB || weight <= 0.001) return;
      if (spineDirty) flushSpineBridge();
      if (staffChainDirty) syncStaffChain();
      tipA.getWorldPosition(tmpPosA);
      tipB.getWorldPosition(tmpPosB);
      curDirW.copy(tmpPosA).sub(tmpPosB).normalize();
      tgtDirW.set(ex, ey, ez).normalize().applyQuaternion(rootWQ);
      if (curDirW.lengthSq() < 0.5 || tgtDirW.lengthSq() < 0.5) return;
      rotDelta.setFromUnitVectors(curDirW, tgtDirW);
      handBone.parent.getWorldQuaternion(parentWQ);
      handBone.getWorldQuaternion(curWQ);
      this.wkTargetWQ.copy(rotDelta).multiply(curWQ);
      blendedQ.copy(curWQ).slerp(this.wkTargetWQ, clamp01(weight));
      handBone.quaternion.copy(parentWQ.invert().multiply(blendedQ)).normalize();
      syncNodeWorld(handBone);
      syncStaffChain();
    };

    // Exact 2-Bone Analytic Limb IK locking Left Hand onto the Ruyi Jingu Bang shaft ("双手握棍发力")!
    const solveLeftHandOntoStaffIK = (
      gripOffsetMeters: number,
      weight: number,
      poleEx = 0.68,
      poleEy = -0.32,
      poleEz = -0.25,
    ): void => {
      const uArm = this.wkBones.upperArmL;
      const lArm = this.wkBones.lowerArmL;
      const handL = this.wkBones.handL;
      const handR = this.wkBones.handR;
      const tipA = this.wkBones.staffTipA;
      const tipB = this.wkBones.staffTipB;
      if (!uArm || !lArm || !handL || !handR || !tipA || !tipB || !uArm.parent || !lArm.parent || weight <= 0.001) {
        return;
      }
      if (spineDirty) flushSpineBridge();
      if (staffChainDirty) syncStaffChain();

      const shoulderW = uArm.getWorldPosition(this.wkShoulderW);
      const elbowW = lArm.getWorldPosition(this.wkElbowW);
      const wristW = handL.getWorldPosition(this.wkWristW);
      const L1 = Math.max(0.08, shoulderW.distanceTo(elbowW));
      const L2 = Math.max(0.08, elbowW.distanceTo(wristW));

      tipA.getWorldPosition(tmpPosA);
      tipB.getWorldPosition(tmpPosB);
      const staffDirW = this.wkStaffDirW.copy(tmpPosA).sub(tmpPosB).normalize();
      handR.getWorldPosition(tmpPosA);
      const gripTargetW = this.wkGripTargetW.copy(tmpPosA).addScaledVector(staffDirW, gripOffsetMeters);

      const toTarget = this.wkToTarget.copy(gripTargetW).sub(shoulderW);
      const rawDist = toTarget.length();
      if (rawDist < 0.05) return;
      const clampedDist = clamp(rawDist, Math.abs(L1 - L2) + 0.03, (L1 + L2) * 0.985);
      const dirU = toTarget.normalize();

      // Law of Cosines for shoulder bend angle alpha
      const cosAlpha = clamp(
        (L1 * L1 + clampedDist * clampedDist - L2 * L2) / (2 * L1 * clampedDist),
        -1,
        1,
      );
      const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

      const poleHintW = this.wkPoleHintW
        .set(poleEx, poleEy, poleEz)
        .normalize()
        .applyQuaternion(rootWQ);
      const bendAxis = this.wkBendAxis
        .copy(poleHintW)
        .addScaledVector(dirU, -poleHintW.dot(dirU));
      if (bendAxis.lengthSq() < 1e-4) {
        bendAxis.set(1, 0, 0).applyQuaternion(rootWQ);
      }
      bendAxis.normalize();

      const desiredElbowDirW = this.wkDesiredElbowDirW
        .copy(dirU)
        .multiplyScalar(cosAlpha)
        .addScaledVector(bendAxis, sinAlpha)
        .normalize();

      // Aim upperArmL -> lowerArmL toward desiredElbowDirW
      curDirW.copy(elbowW).sub(shoulderW).normalize();
      rotDelta.setFromUnitVectors(curDirW, desiredElbowDirW);
      uArm.parent.getWorldQuaternion(parentWQ);
      uArm.getWorldQuaternion(curWQ);
      this.wkTargetWQ.copy(rotDelta).multiply(curWQ);
      blendedQ.copy(curWQ).slerp(this.wkTargetWQ, clamp01(weight));
      uArm.quaternion.copy(parentWQ.invert().multiply(blendedQ)).normalize();
      syncNodeWorld(uArm);
      syncNodeWorld(lArm);
      syncNodeWorld(handL);

      // Now aim lowerArmL -> handL directly at gripTargetW on the staff shaft!
      const newElbowW = lArm.getWorldPosition(this.wkElbowW);
      const newWristW = handL.getWorldPosition(this.wkWristW);
      curDirW.copy(newWristW).sub(newElbowW).normalize();
      const desiredForearmDirW = this.wkDesiredForearmDirW.copy(gripTargetW).sub(newElbowW).normalize();
      if (curDirW.lengthSq() > 0.5 && desiredForearmDirW.lengthSq() > 0.5) {
        rotDelta.setFromUnitVectors(curDirW, desiredForearmDirW);
        lArm.parent.getWorldQuaternion(parentWQ);
        lArm.getWorldQuaternion(curWQ);
        this.wkTargetWQ.copy(rotDelta).multiply(curWQ);
        blendedQ.copy(curWQ).slerp(this.wkTargetWQ, clamp01(weight));
        lArm.quaternion.copy(parentWQ.invert().multiply(blendedQ)).normalize();
        syncNodeWorld(lArm);
        syncNodeWorld(handL);
      }
    };

    // =========================================================================
    // POSE 1A & 1B: Dynamic Dual-Stance Standing Idle (GPT Pose 01 Left & Right!)
    // - Alert = 0 (Pose 1A): Swaggering Shoulder-Rest ("肩扛金箍棒桀骜傲立")
    // - Alert = 1 (Pose 1B): Side-Angled Diagonal Martial Guard ("侧身斜背长棍临战起势")
    // =========================================================================
    if (this.idlePostureWeight > 0.005) {
      const w = this.idlePostureWeight;
      const a = this.combatAlertBlend;
      const breath = Math.sin(this.postureTime * 2.1);

      // Subtle contrapposto (A) -> side-angled coiled martial stance (B)
      const spinePitch = (-0.045 * (1 - a) + 0.075 * a) + breath * 0.012;
      const spineYaw = -0.14 * (1 - a) - 0.36 * a;
      const spineRoll = 0.025 * (1 - a);
      applyEntityEulerAdditive(this.wkBones.spine01, spinePitch, spineYaw * 0.55, spineRoll, w);
      applyEntityEulerAdditive(this.wkBones.spine02, spinePitch * 0.85, spineYaw * 0.45, 0, w);
      applyEntityEulerAdditive(
        this.wkBones.head,
        -0.05 * (1 - a) - 0.06 * a,
        0.16 * (1 - a) + 0.36 * a,
        0,
        w,
      );

      // Grounded wider warrior legs
      aimBoneInEntitySpace(
        this.wkBones.thighL,
        this.wkBones.calfL,
        0.22 + 0.08 * a,
        -0.94,
        0.14 + 0.16 * a,
        w * 0.72,
      );
      aimBoneInEntitySpace(
        this.wkBones.thighR,
        this.wkBones.calfR,
        -0.22 - 0.06 * a,
        -0.95,
        -0.1 - 0.14 * a,
        w * 0.72,
      );

      // Right arm: raised high beside right pauldron resting wrist over horizontal shoulder-staff (A)
      // <-> low hip diagonal back-guard (B)
      const uRx = -0.84 * (1 - a) - 0.56 * a;
      const uRy = 0.26 * (1 - a) - 0.74 * a;
      const uRz = -0.14 * (1 - a) - 0.24 * a;
      const lRx = 0.56 * (1 - a) - 0.24 * a;
      const lRy = (0.76 + breath * 0.02) * (1 - a) - 0.56 * a;
      const lRz = -0.08 * (1 - a) + 0.58 * a;
      aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, uRx, uRy, uRz, w * 0.97);
      aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, lRx, lRy, lRz, w * 0.97);

      // Staff vector: crisp horizontal across back of shoulders (+0.992, +0.035, +0.09) (A)
      // <-> diagonal across back (+0.56, +0.64, -0.52) (B)
      const sDx = 0.992 * (1 - a) + 0.56 * a;
      const sDy = 0.035 * (1 - a) + 0.64 * a;
      const sDz = 0.09 * (1 - a) - 0.52 * a;
      aimStaffInEntitySpace(sDx, sDy, sDz, w * 0.99);

      // Left arm: relaxed swagger hang (A) <-> raised Monkey King Claw Guard ("猴爪问路") (B)
      const uLx = 0.36 * (1 - a) + 0.42 * a;
      const uLy = -0.9 * (1 - a) - 0.42 * a;
      const uLz = 0.12 * (1 - a) + 0.76 * a;
      const lLx = 0.16 * (1 - a) + 0.12 * a;
      const lLy = -0.86 * (1 - a) + (0.16 + breath * 0.03) * a;
      const lLz = 0.34 * (1 - a) + 0.96 * a;
      aimBoneInEntitySpace(this.wkBones.upperArmL, this.wkBones.lowerArmL, uLx, uLy, uLz, w * 0.92);
      aimBoneInEntitySpace(this.wkBones.lowerArmL, this.wkBones.handL, lLx, lLy, lLz, w * 0.92);
    }

    // =========================================================================
    // POSE 2: Iconic Low-Lean Drag-Staff Sprint ("斜身拖棍擦地火星疾奔", GPT Pose 02!)
    // - 36-deg forward torso lean, fierce forward gaze, 79% of Ruyi Jingu Bang trailing
    //   BACKWARD-DOWN-RIGHT behind right flank skimming the bluestone tiles!
    // =========================================================================
    if (this.runPostureWeight > 0.005) {
      const w = this.runPostureWeight;
      const strideBob = Math.sin(this.postureTime * 13.8);
      applyEntityEulerAdditive(this.wkBones.spine01, 0.22, -0.14 + strideBob * 0.045, 0, w);
      applyEntityEulerAdditive(this.wkBones.spine02, 0.18, -0.09 + strideBob * 0.045, 0, w);
      applyEntityEulerAdditive(this.wkBones.spine03, 0.13, 0, 0, w);
      // Counter-pitch head up so Wukong glares fiercely straight ahead!
      applyEntityEulerAdditive(this.wkBones.head, -0.48, 0.18, 0, w);

      // Right hand grips low at right hip while 3.1m rear shaft (tipB) drags backward-down-right!
      aimBoneInEntitySpace(
        this.wkBones.upperArmR,
        this.wkBones.lowerArmR,
        -0.46,
        -0.78,
        -0.38 + strideBob * 0.05,
        w * 0.96,
      );
      aimBoneInEntitySpace(
        this.wkBones.lowerArmR,
        this.wkBones.handR,
        -0.22,
        -0.68,
        0.58 + strideBob * 0.04,
        w * 0.96,
      );
      // With staffSlide = +118, tipA is the 3.15m long end and tipB is the 0.85m short front end!
      // Aiming (tipB -> tipA) toward (-0.16, -0.25, -0.955) trails 79% of Ruyi Jingu Bang
      // sleekly BACKWARD & skimming just above the bluestone tiles behind Wukong's right leg!
      aimStaffInEntitySpace(-0.16, -0.25 + strideBob * 0.018, -0.955, w * 0.98);

      // Left arm pumps forward dynamically in athletic balance (GPT Pose 02 Right!)
      aimBoneInEntitySpace(
        this.wkBones.upperArmL,
        this.wkBones.lowerArmL,
        0.38,
        -0.52 - strideBob * 0.14,
        0.72 - strideBob * 0.18,
        w * 0.92,
      );
      aimBoneInEntitySpace(
        this.wkBones.lowerArmL,
        this.wkBones.handL,
        0.08,
        0.24 - strideBob * 0.12,
        0.96,
        w * 0.92,
      );
    }

    // =========================================================================
    // POSE 3: Low Coiled Phantom-Step Dodge ("灵猴缩地闪身 + 双手斜护", GPT Pose 03!)
    // =========================================================================
    if (this.dodgePostureWeight > 0.005) {
      const w = this.dodgePostureWeight;
      applyEntityEulerAdditive(this.wkBones.spine01, 0.28, -0.32, 0.08, w);
      applyEntityEulerAdditive(this.wkBones.spine02, 0.22, -0.2, 0, w);
      applyEntityEulerAdditive(this.wkBones.head, -0.44, 0.42, 0, w);

      // Deep coiled lateral lunge knees
      aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.42, -0.58, 0.68, w * 0.85);
      aimBoneInEntitySpace(this.wkBones.calfL, this.wkBones.thighL, 0.18, 0.78, 0.58, 0); // keep mixer ankle, flex thigh!
      aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.48, -0.72, -0.45, w * 0.85);

      // Right hand at hip, staff tucked low-diagonal across chest, Left Hand locked via 2-Bone IK!
      aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.52, -0.68, -0.35, w * 0.95);
      aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.18, -0.42, 0.88, w * 0.95);
      aimStaffInEntitySpace(0.54, -0.14, 0.83, w * 0.96);
      solveLeftHandOntoStaffIK(0.58, w * 0.94, 0.65, -0.28, 0.32);
    }

    // =========================================================================
    // OPENING CINEMATIC 4-SHOT POSES: Cloud Crouch -> Ear-Needle Pluck -> Standoff!
    // =========================================================================
    if (this.introActive && this.introProgress >= 0.25 && this.introProgress < 0.94) {
      const ip = this.introProgress;
      if (ip < 0.52) {
        // SHOT 2: Superhero One-Knee Ground-Touch Crouch + Fiery Head-Up Glare (GPT Intro Shot 2!)
        const glareUp = smoothstepScalar(0.41, 0.5, ip);
        applyEntityEulerAdditive(this.wkBones.spine01, 0.44, -0.14, 0, 0.96);
        applyEntityEulerAdditive(this.wkBones.spine02, 0.28, -0.08, 0, 0.96);
        applyEntityEulerAdditive(
          this.wkBones.head,
          -0.25 - glareUp * 0.48,
          0.18,
          0,
          0.95,
        );
        // Left knee bent high forward, right leg knelt back
        aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.36, -0.22, 0.9, 0.94);
        aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.34, -0.82, -0.45, 0.94);
        // Right hand reaches straight down pressing fingers onto the mirror stone floor!
        aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.18, -0.88, 0.42, 0.96);
        aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.08, -0.95, 0.28, 0.96);
        // Left arm swept dynamically back-left for martial balance!
        aimBoneInEntitySpace(this.wkBones.upperArmL, this.wkBones.lowerArmL, 0.64, -0.42, -0.62, 0.92);
        aimBoneInEntitySpace(this.wkBones.lowerArmL, this.wkBones.handL, 0.48, -0.58, -0.65, 0.92);
      } else if (ip < 0.78) {
        // SHOT 3: Reaching Two Fingers to Right Ear (0.52..0.625) -> Whipping Out Full Ruyi Jingu Bang & Ground-Plant!
        if (ip < 0.625) {
          const reachT = smoothstepScalar(0.52, 0.57, ip);
          applyEntityEulerAdditive(this.wkBones.spine01, -0.06, -0.18 * reachT, 0, 0.92);
          applyEntityEulerAdditive(this.wkBones.head, -0.14 * reachT, 0.22 * reachT, 0.08 * reachT, 0.92);
          // Right elbow flares right-up (-X, +Y) while right forearm curls inward (+X, +Y) right to Wukong's right ear!
          aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.78, 0.48, 0.38, reachT * 0.98);
          aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.64, 0.72, -0.24, reachT * 0.98);
          // Left hand extended forward-outward ready to command the staff (GPT Intro Shot 3!)
          aimBoneInEntitySpace(this.wkBones.upperArmL, this.wkBones.lowerArmL, 0.48, 0.14, 0.86, reachT * 0.94);
          aimBoneInEntitySpace(this.wkBones.lowerArmL, this.wkBones.handL, 0.32, 0.26, 0.91, reachT * 0.94);
        } else {
          const slamT = smoothstepScalar(0.625, 0.69, ip);
          applyEntityEulerAdditive(this.wkBones.spine01, 0.14 * slamT, -0.22, 0, 0.94);
          applyEntityEulerAdditive(this.wkBones.head, -0.16, 0.24, 0, 0.92);
          aimBoneInEntitySpace(
            this.wkBones.upperArmR,
            this.wkBones.lowerArmR,
            -0.68,
            0.35 * (1 - slamT) - 0.22 * slamT,
            0.52,
            0.96,
          );
          aimBoneInEntitySpace(
            this.wkBones.lowerArmR,
            this.wkBones.handR,
            -0.38,
            0.42 * (1 - slamT) - 0.12 * slamT,
            0.84,
            0.96,
          );
          // Plant the blazing Ruyi Jingu Bang steeply butt-first into the mirror floor beside his right flank!
          aimStaffInEntitySpace(-0.18, -0.92 * slamT + 0.45 * (1 - slamT), 0.34, 0.98);
          aimBoneInEntitySpace(this.wkBones.upperArmL, this.wkBones.lowerArmL, 0.52, 0.08, 0.84, 0.92);
          aimBoneInEntitySpace(this.wkBones.lowerArmL, this.wkBones.handL, 0.36, 0.22, 0.9, 0.92);
        }
      } else {
        // SHOT 4: Fierce Two-Handed Horizontal Dragon-Spear Standoff Pointing Straight at Boss Jiebo!
        const w = 1 - smoothstepScalar(0.88, 0.94, ip);
        applyEntityEulerAdditive(this.wkBones.spine01, 0.24, -0.26, 0, w * 0.95);
        applyEntityEulerAdditive(this.wkBones.spine02, 0.16, -0.18, 0, w * 0.95);
        applyEntityEulerAdditive(this.wkBones.head, -0.34, 0.42, 0, w * 0.92);
        aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.36, -0.68, 0.64, w * 0.88);
        aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.38, -0.78, -0.48, w * 0.88);
        aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.52, -0.48, -0.32, w * 0.96);
        aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.12, -0.22, 0.94, w * 0.96);
        aimStaffInEntitySpace(0.02, -0.06, 0.998, w * 0.98);
        solveLeftHandOntoStaffIK(0.56, w * 0.95, 0.65, -0.25, 0.3);
      }
    }

    // =========================================================================
    // HIT REACTIONS: Light Horizontal Staff-Brace Skid vs Heavy Knockdown + Kip-Up!
    // =========================================================================
    if (this.hitReactionKind === 'light') {
      applyEntityEulerAdditive(this.wkBones.spine01, 0.26, -0.1, 0, 0.95);
      applyEntityEulerAdditive(this.wkBones.spine02, 0.2, 0, 0, 0.95);
      applyEntityEulerAdditive(this.wkBones.head, -0.38, 0.08, 0, 0.92);

      // Wide crouched boot-skid stance bracing against Boss blow (GPT Hit Sheet Left!)
      aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.36, -0.68, 0.62, 0.88);
      aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.34, -0.74, -0.52, 0.88);

      // Right & Left hands lock Ruyi Jingu Bang horizontally across chest in defensive guard!
      aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.58, -0.36, 0.48, 0.96);
      aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.28, 0.14, 0.92, 0.96);
      aimStaffInEntitySpace(0.97, 0.1, 0.21, 0.98);
      solveLeftHandOntoStaffIK(0.56, 0.96, 0.65, -0.24, 0.35);
    } else if (this.hitReactionKind === 'heavy') {
      const t = this.hitReactionElapsed;
      if (t < 0.64) {
        // Airborne knockback & supine ground crash (GPT Hit Sheet Right!)
        applyEntityEulerAdditive(this.wkBones.spine01, -0.18, 0.08, 0, 0.9);
        applyEntityEulerAdditive(this.wkBones.head, 0.28, 0, 0, 0.88);
        aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.32, -0.64, 0.68, 0.85);
        aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.34, -0.76, 0.45, 0.85);
        aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.72, -0.25, 0.52, 0.92);
        aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, -0.35, 0.22, 0.88, 0.92);
        aimStaffInEntitySpace(0.84, 0.28, 0.46, 0.94);
        aimBoneInEntitySpace(this.wkBones.upperArmL, this.wkBones.lowerArmL, 0.76, -0.18, 0.55, 0.88);
        aimBoneInEntitySpace(this.wkBones.lowerArmL, this.wkBones.handL, 0.52, 0.35, 0.76, 0.88);
      } else {
        // Golden Lotus Kip-Up Vault: tuck knees & plant Ruyi Jingu Bang to spring upright!
        const pKip = clamp01((t - 0.64) / 0.28);
        const coil = Math.sin(pKip * Math.PI);
        applyEntityEulerAdditive(this.wkBones.spine01, 0.32 * coil, 0, 0, 0.92);
        aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.32, -0.45, 0.82, coil * 0.9);
        aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.32, -0.52, 0.76, coil * 0.9);
        aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.45, -0.62, 0.48, 0.94);
        aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, 0.14, -0.42, 0.88, 0.94);
        aimStaffInEntitySpace(0.42, -0.72 * coil + 0.15 * (1 - coil), 0.52, 0.95);
        solveLeftHandOntoStaffIK(0.52, 0.92, 0.65, -0.2, 0.3);
      }
    }

    // =========================================================================
    // POSE 4, POSE 5 & SKILL 2/3: Sweeps, Pillar-Perch Ascent, & Giant Pillar Smash!
    // =========================================================================
    if (
      this.hitReactionKind === 'none' &&
      (isAttackClip || this.activeAttackKind === 'pillar_perch' || this.activeAttackKind === 'dharmakaya_cast') &&
      this.activeAttackKind !== 'none'
    ) {
      const p = clamp01(this.activeAttackElapsed / this.activeAttackDuration);

      if (this.activeAttackKind === 'pillar_perch') {
        // SKILL 2 (GPT Skill 2 Sheet!): Stage A Monkey Pillar-Perch -> Stage B Overhead Dragon-Pillar Slam!
        if (p < 0.36) {
          // Crouched Monkey King perched high atop vertical Ruyi Jingu Bang!
          applyEntityEulerAdditive(this.wkBones.spine01, 0.28, 0, 0, 0.95);
          applyEntityEulerAdditive(this.wkBones.head, -0.34, 0, 0, 0.92);
          aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.38, -0.32, 0.86, 0.94);
          aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.38, -0.36, 0.84, 0.94);
          aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.36, -0.48, 0.78, 0.95);
          aimBoneInEntitySpace(this.wkBones.lowerArmR, this.wkBones.handR, -0.06, -0.25, 0.96, 0.95);
          aimStaffInEntitySpace(0.02, -0.99, 0.08, 0.98);
          solveLeftHandOntoStaffIK(0.46, 0.95, 0.62, 0.15, 0.35);
        } else {
          const slamPhase = smoothstepScalar(0.36, 0.62, p);
          const torsoPitch = -0.24 * (1 - slamPhase) + 0.46 * slamPhase;
          applyEntityEulerAdditive(this.wkBones.spine01, torsoPitch, 0, 0, 0.94);
          applyEntityEulerAdditive(this.wkBones.spine02, torsoPitch * 0.9, 0, 0, 0.94);
          applyEntityEulerAdditive(this.wkBones.head, -torsoPitch * 1.1, 0, 0, 0.9);
          aimBoneInEntitySpace(
            this.wkBones.upperArmR,
            this.wkBones.lowerArmR,
            -0.22,
            0.84 * (1 - slamPhase) - 0.54 * slamPhase,
            -0.12 * (1 - slamPhase) + 0.84 * slamPhase,
            0.96,
          );
          aimBoneInEntitySpace(
            this.wkBones.lowerArmR,
            this.wkBones.handR,
            0.06,
            0.88 * (1 - slamPhase) - 0.38 * slamPhase,
            0.42 * (1 - slamPhase) + 0.92 * slamPhase,
            0.96,
          );
          aimStaffInEntitySpace(
            0.03,
            0.88 * (1 - slamPhase) - 0.42 * slamPhase,
            -0.44 * (1 - slamPhase) + 0.91 * slamPhase,
            0.98,
          );
          solveLeftHandOntoStaffIK(0.54, 0.96, 0.62, 0.25, 0.25);
        }
      } else if (this.activeAttackKind === 'heavy_leap' || this.activeAttackKind === 'dharmakaya_cast') {
        // POSE 5: Mid-Air Coiled Bow Arch + Two-Handed Overhead Giant Pillar Smash ("腾空劈山重棍")!
        const slamPhase = smoothstepScalar(0.24, 0.58, p);
        const torsoPitch = -0.26 * (1 - slamPhase) + 0.42 * slamPhase;
        applyEntityEulerAdditive(this.wkBones.spine01, torsoPitch, 0, 0, 0.92);
        applyEntityEulerAdditive(this.wkBones.spine02, torsoPitch * 0.9, 0, 0, 0.92);
        applyEntityEulerAdditive(this.wkBones.head, -torsoPitch * 1.15, 0, 0, 0.9);

        // Mid-air coiled knee tuck (p < 0.65) -> grounded landing brace
        const airCoil = Math.sin(clamp01(p / 0.72) * Math.PI);
        if (airCoil > 0.05) {
          aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.28, -0.48, 0.82, airCoil * 0.88);
          aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.28, -0.62, 0.72, airCoil * 0.88);
        }

        // Arms raise high overhead (windup) -> drive colossal golden pillar straight down into Boss!
        const armY = 0.82 * (1 - slamPhase) - 0.52 * slamPhase;
        const armZ = -0.15 * (1 - slamPhase) + 0.82 * slamPhase;
        aimBoneInEntitySpace(this.wkBones.upperArmR, this.wkBones.lowerArmR, -0.24, armY, armZ, 0.95);
        aimBoneInEntitySpace(
          this.wkBones.lowerArmR,
          this.wkBones.handR,
          0.08,
          0.88 * (1 - slamPhase) - 0.35 * slamPhase,
          0.45 * (1 - slamPhase) + 0.92 * slamPhase,
          0.95,
        );
        const staffY = 0.86 * (1 - slamPhase) - 0.34 * slamPhase;
        const staffZ = -0.48 * (1 - slamPhase) + 0.94 * slamPhase;
        aimStaffInEntitySpace(0.04, staffY, staffZ, 0.96);
        solveLeftHandOntoStaffIK(0.52, 0.95, 0.62, 0.25, 0.25);
      } else {
        // POSE 4: Grounded Wide Bow-Horse Stance + Two-Handed Full-Torque Sweep ("横扫千军")!
        const dirSign = this.activeAttackKind === 'sweep2' ? -1 : 1;
        const swing = smoothstepScalar(0.06, 0.56, p);
        const yawSweep = dirSign * (-0.82 + swing * 1.68);
        applyEntityEulerAdditive(this.wkBones.spine01, 0.18, yawSweep * 0.48, 0, 0.9);
        applyEntityEulerAdditive(this.wkBones.spine02, 0.14, yawSweep * 0.52, 0, 0.9);
        applyEntityEulerAdditive(this.wkBones.head, -0.26, -yawSweep * 0.55, 0, 0.88);

        // Wide martial bow-horse stance (GPT Pose 04!)
        aimBoneInEntitySpace(this.wkBones.thighL, this.wkBones.calfL, 0.38, -0.76, 0.52, 0.78);
        aimBoneInEntitySpace(this.wkBones.thighR, this.wkBones.calfR, -0.38, -0.82, -0.42, 0.78);

        const staffAzim = yawSweep * 1.12;
        const sx = Math.sin(staffAzim);
        const sz = Math.cos(staffAzim);
        const sy = this.activeAttackKind === 'sweep3' ? -0.22 + swing * 0.55 : 0.08 - swing * 0.14;
        aimBoneInEntitySpace(
          this.wkBones.upperArmR,
          this.wkBones.lowerArmR,
          -0.38 + sx * 0.35,
          -0.42,
          0.55 + sz * 0.25,
          0.92,
        );
        aimBoneInEntitySpace(
          this.wkBones.lowerArmR,
          this.wkBones.handR,
          sx * 0.48,
          -0.18,
          0.86,
          0.92,
        );
        aimStaffInEntitySpace(sx, sy, sz, 0.95);
        solveLeftHandOntoStaffIK(0.5, 0.94, 0.65, -0.25, 0.2);
      }
    }

    // =========================================================================
    // Live 26-Bone Crown Plume + Crimson Waist Sash Slipstream Physics
    // =========================================================================
    if (spineDirty) flushSpineBridge();
    const speedNorm = clamp01(
      Math.max(
        this.uMoveSpeed.value / (COMBAT_TUNING.playerMoveSpeed * 1.15),
        this.dodgePostureWeight * 0.95,
      ),
    );
    const applyPlumeChain = (
      chain: ReadonlyArray<{ bone: THREE.Bone; restQuat: THREE.Quaternion }>,
      sideSign: number,
    ): void => {
      for (let i = 0; i < chain.length; i += 1) {
        const seg = chain[i]!;
        const t = (i + 1) / chain.length;
        seg.bone.quaternion.copy(seg.restQuat);
        syncNodeWorld(seg.bone);
        const backSweep = -(0.095 + speedNorm * 0.085) * (0.65 + t * 0.8);
        const flutter =
          Math.sin(this.postureTime * (4.4 + speedNorm * 6.2) - i * 0.55 + sideSign * 0.6) *
          (0.022 + speedNorm * 0.036) *
          t;
        const flareOut = sideSign * (0.02 + speedNorm * 0.014);
        applyEntityEulerAdditive(seg.bone, backSweep + flutter, flareOut, flareOut * 0.5, 1.0);
      }
    };
    applyPlumeChain(this.wkPlumeLeft, 1);
    applyPlumeChain(this.wkPlumeRight, -1);

    for (let cIdx = 0; cIdx < this.wkSashChains.length; cIdx += 1) {
      const chain = this.wkSashChains[cIdx]!;
      const side = cIdx === 0 ? 1 : -1;
      for (let i = 0; i < chain.length; i += 1) {
        const seg = chain[i]!;
        seg.bone.quaternion.copy(seg.restQuat);
        syncNodeWorld(seg.bone);
        const wave =
          Math.sin(this.postureTime * (5.2 + speedNorm * 6.5) - i * 0.8 + side) *
          (0.05 + speedNorm * 0.09);
        applyEntityEulerAdditive(seg.bone, -(0.08 + speedNorm * 0.24) + wave, side * 0.05, 0, 1.0);
      }
    }

    // Single final propagation to unvisited leaf nodes (fingers, twist bones, head hair)
    this.model.updateMatrixWorld(false);
  }

  enforceBoundsAndSeparation(bossPos?: Vec3Like): void {
    const pos = this.rootGroup.position;

    if (
      bossPos &&
      Number.isFinite(bossPos.x) &&
      Number.isFinite(bossPos.z)
    ) {
      const dx = pos.x - bossPos.x;
      const dz = pos.z - bossPos.z;
      const dist = Math.hypot(dx, dz);
      const minSep = COMBAT_TUNING.actorSeparationRadius;

      if (Number.isFinite(dist) && dist < minSep) {
        let nx = 0;
        let nz = 1;
        if (dist > 1e-5) {
          nx = dx / dist;
          nz = dz / dist;
        }
        pos.x = bossPos.x + nx * minSep;
        pos.z = bossPos.z + nz * minSep;
      }
    }

    const clamped = clampArenaPosition(pos, this.arenaRadius, 0.5);
    pos.set(clamped.x, 0, clamped.z);
  }

  update(playerDt: number, rawDt: number, bossPos?: Vec3Like): void {
    if (this.disposed) {
      return;
    }

    const safePlayerDt =
      Number.isFinite(playerDt) && playerDt > 0 ? playerDt : 0;
    const safeRawDt = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : 0;

    this.uSashTime.value += safeRawDt;

    // Detect external position teleports (e.g., test harness or Skill 3 blink) so hit-skid never drifts teleported coordinates
    if (this.hitReactionKind !== 'none') {
      const jumpSq =
        (this.rootGroup.position.x - this.lastSimulatedPos.x) ** 2 +
        (this.rootGroup.position.z - this.lastSimulatedPos.z) ** 2;
      if (jumpSq > 10.0) {
        this.cancelHitReactionPose();
      }
    }

    if (safePlayerDt > 0) {
      if (this.hitReactionKind !== 'none') {
        this.hitReactionElapsed += safePlayerDt;
        let slideSpeed = 0;
        if (this.hitReactionKind === 'light') {
          const p = clamp01(this.hitReactionElapsed / this.hitReactionDuration);
          slideSpeed = p < 0.8 ? 5.6 * Math.pow(1 - p / 0.8, 1.75) : 0;
        } else {
          const t = this.hitReactionElapsed;
          if (t < 0.38) {
            const pAir = clamp01(t / 0.38);
            slideSpeed = 7.8 * (1 - pAir * 0.42);
          } else if (t < 0.64) {
            const pLie = clamp01((t - 0.38) / 0.26);
            slideSpeed = 2.1 * (1 - pLie);
          }
        }
        this.rootGroup.position.x += this.hitKnockDirX * slideSpeed * safePlayerDt;
        this.rootGroup.position.z += this.hitKnockDirZ * slideSpeed * safePlayerDt;

        if (this.hitReactionElapsed >= this.hitReactionDuration) {
          this.cancelHitReactionPose();
        }
      }

      this.rootGroup.position.x += this.velocity.x * safePlayerDt;
      this.rootGroup.position.z += this.velocity.z * safePlayerDt;

      if (this.velocity.lengthSq() > 1e-4) {
        const diff = Math.atan2(
          Math.sin(this.targetMoveYaw - this._facingYaw),
          Math.cos(this.targetMoveYaw - this._facingYaw),
        );
        const turnAlpha = 1 - Math.exp(-16 * safePlayerDt);
        this._facingYaw += diff * turnAlpha;
        this.rootGroup.rotation.y = this._facingYaw;
      }
    }

    this.uMoveSpeed.value = Math.hypot(this.velocity.x, this.velocity.z);
    this.enforceBoundsAndSeparation(bossPos);
    this.lastSimulatedPos.copy(this.rootGroup.position);

    // Restore clean pre-posture AnimationMixer quaternions BEFORE mixer.update()
    this.restorePostSolvedBones();

    if (this.hitFreezeTimer > 0) {
      this.hitFreezeTimer = Math.max(0, this.hitFreezeTimer - safeRawDt);
    } else {
      this.rig.update(safePlayerDt);
    }
    this.applyWukongMartialPosture(safePlayerDt, safeRawDt, bossPos);

    // Keep 3D Golden Hair-Clone Dodge Silhouette pinned in world space while shimmering/dissolving!
    if (this.goldenCloneGroup && this.goldenCloneTimer > 0) {
      this.goldenCloneTimer = Math.max(0, this.goldenCloneTimer - safeRawDt);
      if (this.goldenCloneTimer <= 0) {
        this.goldenCloneGroup.visible = false;
        this.uCloneOpacity.value = 0;
        this.goldenCloneGroup.removeFromParent();
      } else {
        const lifeRatio = this.goldenCloneTimer / this.goldenCloneDuration;
        this.uCloneOpacity.value = lifeRatio * lifeRatio * 0.85;
        if (this.goldenCloneGroup.parent === this.rootGroup) {
          const dxW = this.goldenCloneWorldPos.x - this.rootGroup.position.x;
          const dzW = this.goldenCloneWorldPos.z - this.rootGroup.position.z;
          const cosR = Math.cos(-this._facingYaw);
          const sinR = Math.sin(-this._facingYaw);
          this.goldenCloneGroup.position.set(
            dxW * cosR + dzW * sinR,
            0,
            -dxW * sinR + dzW * cosR,
          );
          this.goldenCloneGroup.rotation.y = this.goldenCloneWorldYaw - this._facingYaw;
        }
      }
    }
  }

  private stepCameraImpactSpring(
    camera: THREE.Camera,
    dt: number,
  ): { shakeX: number; shakeY: number; shakeZ: number } {
    if (dt <= 0) {
      return { shakeX: 0, shakeY: 0, shakeZ: 0 };
    }
    const stepDt = Math.min(dt, 0.05);

    // Damped spring for directional hit-kick displacement
    const stiffness = 140;
    const damping = 18;
    this.camKickVel.x += (-stiffness * this.camKickOffset.x - damping * this.camKickVel.x) * stepDt;
    this.camKickVel.y += (-stiffness * this.camKickOffset.y - damping * this.camKickVel.y) * stepDt;
    this.camKickVel.z += (-stiffness * this.camKickOffset.z - damping * this.camKickVel.z) * stepDt;
    this.camKickOffset.addScaledVector(this.camKickVel, stepDt);

    // Damped spring for punchy FOV snap on heavy blows
    this.camFovVel += (-180 * this.camFovKick - 20 * this.camFovVel) * stepDt;
    this.camFovKick = clamp(this.camFovKick + this.camFovVel * stepDt, -6.5, 6.5);
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pCam = camera as THREE.PerspectiveCamera;
      if (this.baseCameraFov <= 0) {
        this.baseCameraFov = pCam.fov || 50;
      }
      const nextFov = clamp(this.baseCameraFov + this.camFovKick, 38, 65);
      if (Math.abs(pCam.fov - nextFov) > 0.01) {
        pCam.fov = nextFov;
        pCam.updateProjectionMatrix();
      }
    }

    // High-frequency trauma shudder
    this.camTrauma = Math.max(0, this.camTrauma - stepDt * 3.4);
    const shakeMag = this.camTrauma * this.camTrauma * 0.26;
    this.camShakePhase += stepDt * 54;
    return {
      shakeX:
        this.camKickOffset.x + Math.sin(this.camShakePhase * 1.13) * shakeMag,
      shakeY:
        this.camKickOffset.y + Math.cos(this.camShakePhase * 1.71) * shakeMag * 0.85,
      shakeZ:
        this.camKickOffset.z + Math.sin(this.camShakePhase * 0.89) * shakeMag * 0.65,
    };
  }

  updateCamera(
    camera: THREE.Camera,
    rawDt: number,
    override?: PlayerCameraFrameOverride | null,
  ): void {
    if (this.disposed) {
      return;
    }

    const safeRawDt = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : 0;
    const impact = this.stepCameraImpactSpring(camera, safeRawDt);
    const defaultAlpha = this.cameraInitialized
      ? 1 - Math.exp(-10 * safeRawDt)
      : 1;

    if (override) {
      const alpha =
        typeof override.lerpAlpha === 'number' &&
        Number.isFinite(override.lerpAlpha)
          ? clamp01(override.lerpAlpha)
          : defaultAlpha;

      const clampedOverride = clampArenaPosition(
        override.position,
        CAMERA_MAX_ARENA_RADIUS,
        0,
      );
      this.camDesiredVec.set(
        clampedOverride.x,
        Math.max(CAMERA_MIN_HEIGHT, clampedOverride.y),
        clampedOverride.z,
      );

      const fallbackX = Number.isFinite(this.position.x) ? this.position.x : 0;
      const fallbackY = Number.isFinite(this.position.y)
        ? this.position.y + 1.38
        : 1.38;
      const fallbackZ = Number.isFinite(this.position.z) ? this.position.z : 0;
      const lookX =
        override.lookAt && Number.isFinite(override.lookAt.x)
          ? override.lookAt.x
          : fallbackX;
      const lookY =
        override.lookAt && Number.isFinite(override.lookAt.y)
          ? override.lookAt.y
          : fallbackY;
      const lookZ =
        override.lookAt && Number.isFinite(override.lookAt.z)
          ? override.lookAt.z
          : fallbackZ;
      this.tmpVec3.set(lookX, lookY, lookZ);

      const canLerpPos =
        this.cameraInitialized &&
        alpha < 1 &&
        Number.isFinite(camera.position.x) &&
        Number.isFinite(camera.position.y) &&
        Number.isFinite(camera.position.z);
      if (!canLerpPos) {
        camera.position.copy(this.camDesiredVec);
      } else {
        camera.position.lerp(this.camDesiredVec, alpha);
      }

      const canLerpLookAt =
        this.cameraInitialized &&
        alpha < 1 &&
        Number.isFinite(this.camLookAtVec.x) &&
        Number.isFinite(this.camLookAtVec.y) &&
        Number.isFinite(this.camLookAtVec.z);
      if (!canLerpLookAt) {
        this.camLookAtVec.copy(this.tmpVec3);
      } else {
        this.camLookAtVec.lerp(this.tmpVec3, alpha);
      }

      camera.position.x += impact.shakeX * 0.5;
      camera.position.y = Math.max(
        CAMERA_MIN_HEIGHT,
        camera.position.y + impact.shakeY * 0.5,
      );
      camera.position.z += impact.shakeZ * 0.5;
      camera.lookAt(this.camLookAtVec);
      this.cameraInitialized = true;
      return;
    }

    const pos = this.rootGroup.position;
    this.camTargetVec.set(pos.x, 1.48, pos.z);

    const cosP = Math.cos(this.cameraPitch);
    const sinP = Math.sin(this.cameraPitch);
    const sinY = Math.sin(this.cameraYaw);
    const cosY = Math.cos(this.cameraYaw);

    const rawCamX =
      this.camTargetVec.x + sinY * cosP * this.cameraDistance + impact.shakeX;
    const rawCamY = Math.max(
      CAMERA_MIN_HEIGHT,
      this.camTargetVec.y + sinP * this.cameraDistance + impact.shakeY,
    );
    const rawCamZ =
      this.camTargetVec.z + cosY * cosP * this.cameraDistance + impact.shakeZ;

    const clampedCam = clampArenaPosition(
      { x: rawCamX, y: rawCamY, z: rawCamZ },
      CAMERA_MAX_ARENA_RADIUS,
      0,
    );
    this.camDesiredVec.set(
      clampedCam.x,
      Math.max(CAMERA_MIN_HEIGHT, clampedCam.y),
      clampedCam.z,
    );

    if (!this.cameraInitialized || defaultAlpha >= 1) {
      camera.position.copy(this.camDesiredVec);
      this.camLookAtVec.copy(this.camTargetVec);
    } else {
      camera.position.lerp(this.camDesiredVec, defaultAlpha);
      this.camLookAtVec.lerp(this.camTargetVec, defaultAlpha);
    }

    camera.position.y = Math.max(CAMERA_MIN_HEIGHT, camera.position.y);
    camera.lookAt(this.camLookAtVec);
    this.cameraInitialized = true;
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.rootGroup.position.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
    this.velocity.set(0, 0, 0);
    this._facingYaw = PLAYER_INITIAL_YAW;
    this.targetMoveYaw = PLAYER_INITIAL_YAW;
    this.rootGroup.rotation.set(0, PLAYER_INITIAL_YAW, 0);
    this.cameraYaw = 0;
    this.cameraPitch = CAMERA_DEFAULT_PITCH;
    this.cameraDistance = CAMERA_DEFAULT_DISTANCE;
    this.cameraInitialized = false;
    this.uAuraBoost.value = 0;
    this.uMoveSpeed.value = 0;
    this.staffExtCurrent = 1.0;
    this.staffExtTarget = 1.0;
    this.staffSlideCurrent = -18.0;
    this.staffSlideTarget = -18.0;
    this.idlePostureWeight = 1.0;
    this.runPostureWeight = 0.0;
    this.dodgePostureWeight = 0.0;
    this.combatAlertBlend = 0.0;
    this.combatAlertTimer = 0.0;
    this.activeAttackKind = 'none';
    this.activeAttackElapsed = 0;
    this.introActive = false;
    this.introProgress = 0;
    this.setWeaponMeshVisible(true);
    this.hitReactionKind = 'none';
    this.hitReactionElapsed = 0;
    this.hitGroundCrashFired = false;
    this.hitKipUpFired = false;
    this.lastSimulatedPos.set(PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z);
    this.visualOffsetY = 0;
    this.model.position.y = 0;
    this.model.rotation.x = 0;
    if (this.goldenCloneGroup) {
      this.goldenCloneGroup.visible = false;
      this.goldenCloneTimer = 0;
      this.uCloneOpacity.value = 0;
      this.goldenCloneGroup.removeFromParent();
    }
    this.camTrauma = 0;
    this.camKickOffset.set(0, 0, 0);
    this.camKickVel.set(0, 0, 0);
    this.camFovKick = 0;
    this.camFovVel = 0;
    this.hitFreezeTimer = 0;
    this.restorePostSolvedBones();
    this.applyRuyiStaffScale(1.0, -18.0);
    this.rig.play(PLAYER_CLIPS.idle, { fadeSeconds: 0, forceRestart: true });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rig.dispose();
    if (this.goldenCloneGroup) {
      this.goldenCloneGroup.removeFromParent();
      this.goldenCloneGroup.clear();
    }
    if (this.goldenCloneSkeleton) {
      this.goldenCloneSkeleton.dispose();
      this.goldenCloneSkeleton = null;
    }
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
