import * as THREE from 'three';

export interface PlayClipOptions {
  loop?: THREE.AnimationActionLoopStyles;
  fadeSeconds?: number;
  timeScale?: number;
  clampWhenFinished?: boolean;
  forceRestart?: boolean;
  startTime?: number;
}

export function attachObjectToBone(
  parent: THREE.Object3D,
  child: THREE.Object3D,
  boneNames: readonly string[],
  offset?: THREE.Vector3,
  rotationEuler?: THREE.Euler,
): THREE.Object3D | null {
  let targetBone: THREE.Object3D | undefined;

  for (const rawName of boneNames) {
    if (!rawName) {
      continue;
    }
    targetBone = parent.getObjectByName(rawName);
    if (targetBone) {
      break;
    }
    const sanitized = THREE.PropertyBinding.sanitizeNodeName(rawName);
    if (sanitized && sanitized !== rawName) {
      targetBone = parent.getObjectByName(sanitized);
      if (targetBone) {
        break;
      }
    }
  }

  if (!targetBone) {
    return null;
  }

  if (offset) {
    child.position.copy(offset);
  }
  if (rotationEuler) {
    child.rotation.copy(rotationEuler);
  }
  targetBone.add(child);
  return targetBone;
}

export class AnimationRig {
  private readonly modelRoot: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly clipsMap = new Map<string, THREE.AnimationClip>();

  private currentClip: THREE.AnimationClip | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private _activeClipName = '';
  private disposed = false;

  constructor(
    modelRoot: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    defaultClipCandidates: readonly string[] = [],
  ) {
    this.modelRoot = modelRoot;
    this.mixer = new THREE.AnimationMixer(modelRoot);

    for (const clip of clips) {
      if (clip && clip.name && !this.clipsMap.has(clip.name)) {
        this.clipsMap.set(clip.name, clip);
      }
    }

    if (this.clipsMap.size > 0) {
      let played = '';
      if (defaultClipCandidates.length > 0) {
        played = this.play(defaultClipCandidates, { fadeSeconds: 0 });
      }
      if (!played) {
        const firstClip = this.clipsMap.values().next().value;
        if (firstClip) {
          this.play(firstClip.name, { fadeSeconds: 0 });
        }
      }
    } else if (defaultClipCandidates.length > 0) {
      this._activeClipName = defaultClipCandidates[0] ?? 'Idle';
    } else {
      this._activeClipName = 'Idle';
    }
  }

  get activeClipName(): string {
    return this._activeClipName;
  }

  hasClip(name: string): boolean {
    return this.clipsMap.has(name);
  }

  getClipDuration(name: string): number {
    const clip = this.clipsMap.get(name);
    if (!clip || !Number.isFinite(clip.duration)) {
      return 0;
    }
    return clip.duration;
  }

  play(
    nameOrCandidates: string | readonly string[],
    options?: PlayClipOptions,
  ): string {
    if (this.disposed) {
      return this._activeClipName;
    }

    const candidates = Array.isArray(nameOrCandidates)
      ? nameOrCandidates
      : [nameOrCandidates];

    let targetClip: THREE.AnimationClip | undefined;
    for (const candidate of candidates) {
      const found = this.clipsMap.get(candidate);
      if (found) {
        targetClip = found;
        break;
      }
    }

    if (!targetClip) {
      return this._activeClipName;
    }

    const loop = options?.loop ?? THREE.LoopRepeat;
    const repetitions = loop === THREE.LoopOnce ? 1 : Infinity;
    const clampWhenFinished =
      options?.clampWhenFinished ?? loop === THREE.LoopOnce;
    const rawFade = options?.fadeSeconds;
    const fadeSeconds =
      rawFade !== undefined && Number.isFinite(rawFade) && rawFade >= 0
        ? rawFade
        : 0.12;
    const rawScale = options?.timeScale;
    const timeScale =
      rawScale !== undefined && Number.isFinite(rawScale) && rawScale >= 0
        ? rawScale
        : 1;
    const forceRestart = options?.forceRestart ?? false;

    if (
      targetClip === this.currentClip &&
      this.currentAction &&
      !forceRestart
    ) {
      this.currentAction.setLoop(loop, repetitions);
      this.currentAction.clampWhenFinished = clampWhenFinished;
      this.currentAction.setEffectiveTimeScale(timeScale);
      return this._activeClipName;
    }

    const nextAction = this.mixer.clipAction(targetClip);
    nextAction.reset();
    nextAction.setLoop(loop, repetitions);
    nextAction.clampWhenFinished = clampWhenFinished;
    nextAction.setEffectiveTimeScale(timeScale);
    nextAction.setEffectiveWeight(1);
    nextAction.enabled = true;
    if (
      options?.startTime !== undefined &&
      Number.isFinite(options.startTime) &&
      options.startTime > 0
    ) {
      nextAction.time = Math.min(
        Math.max(0, targetClip.duration - 0.05),
        options.startTime,
      );
    }
    nextAction.play();

    if (this.currentAction && this.currentAction !== nextAction) {
      if (fadeSeconds > 0) {
        this.currentAction.enabled = true;
        this.currentAction.crossFadeTo(nextAction, fadeSeconds, false);
      } else {
        this.currentAction.stop();
      }
    }

    this.currentClip = targetClip;
    this.currentAction = nextAction;
    this._activeClipName = targetClip.name;
    return this._activeClipName;
  }

  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }
    this.mixer.update(dt);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.modelRoot);
    this.currentAction = null;
    this.currentClip = null;
    this.clipsMap.clear();
  }
}
