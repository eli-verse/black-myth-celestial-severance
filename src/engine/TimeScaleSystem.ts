import { COMBAT_TUNING } from '../types/game.ts';

export interface TimeScaleStep {
  readonly rawDt: number;
  readonly worldDt: number;
  readonly playerDt: number;
  readonly worldTimeScale: number;
  readonly playerTimeScale: number;
}

const TIMER_EPSILON = 1e-9;

function decrementTimer(current: number, dt: number): number {
  const next = current - dt;
  return next <= TIMER_EPSILON ? 0 : next;
}

export class TimeScaleSystem {
  private _paused = false;
  private _worldTimeScale = 1.0;
  private _playerTimeScale = 1.0;
  private _hitstopRemaining = 0;
  private _bulletTimeRemaining = 0;
  private _skill3Remaining = 0;

  get paused(): boolean {
    return this._paused;
  }

  get worldTimeScale(): number {
    return this._worldTimeScale;
  }

  get playerTimeScale(): number {
    return this._playerTimeScale;
  }

  get hitstopRemaining(): number {
    return this._hitstopRemaining;
  }

  get bulletTimeActive(): boolean {
    return this._bulletTimeRemaining > 0;
  }

  get bulletTimeRemaining(): number {
    return this._bulletTimeRemaining;
  }

  get skill3Active(): boolean {
    return this._skill3Remaining > 0;
  }

  get skill3Remaining(): number {
    return this._skill3Remaining;
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
    if (paused) {
      this._worldTimeScale = 0;
      this._playerTimeScale = 0;
    } else {
      this.recomputeScales();
    }
  }

  triggerHitstop(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const durationSec = durationMs / 1000;
    this._hitstopRemaining = Math.max(this._hitstopRemaining, durationSec);
    if (!this._paused) {
      this.recomputeScales();
    }
  }

  triggerBulletTime(
    durationSeconds: number = COMBAT_TUNING.bulletTimeDurationSeconds,
  ): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return;
    }
    this._bulletTimeRemaining = Math.max(this._bulletTimeRemaining, durationSeconds);
    if (!this._paused) {
      this.recomputeScales();
    }
  }

  triggerSkill3TimeStop(
    durationSeconds: number = COMBAT_TUNING.skill3TimeStopDurationSeconds,
  ): void {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return;
    }
    this._skill3Remaining = Math.max(this._skill3Remaining, durationSeconds);
    if (!this._paused) {
      this.recomputeScales();
    }
  }

  update(rawDtSeconds: number): TimeScaleStep {
    const rawDt = Number.isFinite(rawDtSeconds)
      ? Math.max(0, Math.min(rawDtSeconds, COMBAT_TUNING.maxDeltaSeconds))
      : 0;

    if (this._paused) {
      this._worldTimeScale = 0;
      this._playerTimeScale = 0;
      return {
        rawDt,
        worldDt: 0,
        playerDt: 0,
        worldTimeScale: 0,
        playerTimeScale: 0,
      };
    }

    // Determine active scale for THIS frame before decrementing timers,
    // and pause lower-priority timers while higher-priority freezes are active.
    let frameWorldTimeScale = 1.0;
    let framePlayerTimeScale = 1.0;
    if (this._hitstopRemaining > 0) {
      frameWorldTimeScale = 0.0;
      framePlayerTimeScale = 0.0;
      this._hitstopRemaining = decrementTimer(this._hitstopRemaining, rawDt);
    } else if (this._skill3Remaining > 0) {
      frameWorldTimeScale = COMBAT_TUNING.skill3WorldTimeScale;
      framePlayerTimeScale = 1.0;
      this._skill3Remaining = decrementTimer(this._skill3Remaining, rawDt);
    } else if (this._bulletTimeRemaining > 0) {
      frameWorldTimeScale = COMBAT_TUNING.bulletTimeWorldScale;
      framePlayerTimeScale = 1.0;
      this._bulletTimeRemaining = decrementTimer(this._bulletTimeRemaining, rawDt);
    }

    this.recomputeScales();

    return {
      rawDt,
      worldDt: rawDt * frameWorldTimeScale,
      playerDt: rawDt * framePlayerTimeScale,
      worldTimeScale: frameWorldTimeScale,
      playerTimeScale: framePlayerTimeScale,
    };
  }

  reset(): void {
    this._paused = false;
    this._hitstopRemaining = 0;
    this._bulletTimeRemaining = 0;
    this._skill3Remaining = 0;
    this._worldTimeScale = 1.0;
    this._playerTimeScale = 1.0;
  }

  private recomputeScales(): void {
    if (this._paused || this._hitstopRemaining > 0) {
      this._worldTimeScale = 0.0;
      this._playerTimeScale = 0.0;
    } else if (this._skill3Remaining > 0) {
      this._worldTimeScale = COMBAT_TUNING.skill3WorldTimeScale;
      this._playerTimeScale = 1.0;
    } else if (this._bulletTimeRemaining > 0) {
      this._worldTimeScale = COMBAT_TUNING.bulletTimeWorldScale;
      this._playerTimeScale = 1.0;
    } else {
      this._worldTimeScale = 1.0;
      this._playerTimeScale = 1.0;
    }
  }
}
