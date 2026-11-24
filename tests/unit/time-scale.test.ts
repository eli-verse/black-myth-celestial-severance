import { describe, expect, it } from 'vitest';
import { TimeScaleSystem } from '../../src/engine/TimeScaleSystem.ts';
import { COMBAT_TUNING } from '../../src/types/game.ts';

describe('TimeScaleSystem', () => {
  it('advances normally at 1.0x scale', () => {
    const tss = new TimeScaleSystem();
    const step = tss.update(0.016);
    expect(step.rawDt).toBeCloseTo(0.016, 6);
    expect(step.worldDt).toBeCloseTo(0.016, 6);
    expect(step.playerDt).toBeCloseTo(0.016, 6);
    expect(step.worldTimeScale).toBe(1.0);
    expect(step.playerTimeScale).toBe(1.0);
  });

  it('clamps large, negative, and NaN rawDt safely', () => {
    const tss = new TimeScaleSystem();
    expect(tss.update(1.0).rawDt).toBe(COMBAT_TUNING.maxDeltaSeconds);
    expect(tss.update(-0.5).rawDt).toBe(0);
    expect(tss.update(Number.NaN).rawDt).toBe(0);
    expect(tss.update(Number.POSITIVE_INFINITY).rawDt).toBe(0);
  });

  it('gives hitstop highest active priority and freezes both world and player', () => {
    const tss = new TimeScaleSystem();
    tss.triggerHitstop(50);

    const frozen = tss.update(0.03);
    expect(frozen.worldTimeScale).toBe(0);
    expect(frozen.playerTimeScale).toBe(0);
    expect(frozen.worldDt).toBe(0);
    expect(frozen.playerDt).toBe(0);

    // Finish remaining 20ms of hitstop
    const stillFrozen = tss.update(0.03);
    expect(stillFrozen.worldTimeScale).toBe(0);
    expect(stillFrozen.playerTimeScale).toBe(0);

    // Next frame resumes normal 1.0x
    const resumed = tss.update(0.016);
    expect(resumed.worldTimeScale).toBe(1.0);
    expect(resumed.playerTimeScale).toBe(1.0);
    expect(resumed.worldDt).toBeCloseTo(0.016, 6);
  });

  it('never lets shorter hitstop truncate a heavier active hitstop', () => {
    const tss = new TimeScaleSystem();
    tss.triggerHitstop(80);
    tss.triggerHitstop(20);
    expect(tss.hitstopRemaining).toBeCloseTo(0.08, 6);
  });

  it('dilates world to 0.25x while keeping player at 1.0x during Bullet-Time', () => {
    const tss = new TimeScaleSystem();
    tss.triggerBulletTime(2.0);
    expect(tss.bulletTimeActive).toBe(true);

    const step = tss.update(0.04);
    expect(step.worldTimeScale).toBe(0.25);
    expect(step.playerTimeScale).toBe(1.0);
    expect(step.worldDt).toBeCloseTo(0.01, 6);
    expect(step.playerDt).toBeCloseTo(0.04, 6);
  });

  it('pauses Bullet-Time decay during hitstop and restores 0.25x afterward', () => {
    const tss = new TimeScaleSystem();
    tss.triggerBulletTime(2.0);
    tss.triggerHitstop(50);

    const frozen = tss.update(0.05);
    expect(frozen.worldTimeScale).toBe(0);
    expect(frozen.playerTimeScale).toBe(0);
    // Bullet-Time timer was preserved while hitstop ticked down
    expect(tss.bulletTimeRemaining).toBeCloseTo(2.0, 6);

    const afterHitstop = tss.update(0.04);
    expect(afterHitstop.worldTimeScale).toBe(0.25);
    expect(afterHitstop.playerTimeScale).toBe(1.0);
    expect(tss.bulletTimeRemaining).toBeCloseTo(1.96, 6);
  });

  it('prioritizes Skill 3 time-stop (0.0x world, 1.0x player) over Bullet-Time', () => {
    const tss = new TimeScaleSystem();
    tss.triggerBulletTime(2.0);
    tss.triggerSkill3TimeStop(2.6);

    expect(tss.skill3Active).toBe(true);
    const step = tss.update(0.05);
    expect(step.worldTimeScale).toBe(0.0);
    expect(step.playerTimeScale).toBe(1.0);
    expect(step.worldDt).toBe(0);
    expect(step.playerDt).toBeCloseTo(0.05, 6);
    // Bullet-Time preserved behind Skill 3
    expect(tss.bulletTimeRemaining).toBeCloseTo(2.0, 6);
  });

  it('freezes all timers and deltas while paused', () => {
    const tss = new TimeScaleSystem();
    tss.triggerBulletTime(2.0);
    tss.triggerHitstop(50);
    tss.setPaused(true);

    const pausedStep = tss.update(0.05);
    expect(pausedStep.worldDt).toBe(0);
    expect(pausedStep.playerDt).toBe(0);
    expect(tss.hitstopRemaining).toBeCloseTo(0.05, 6);
    expect(tss.bulletTimeRemaining).toBeCloseTo(2.0, 6);

    tss.setPaused(false);
    expect(tss.worldTimeScale).toBe(0);
    tss.update(0.05); // finish hitstop
    const resumed = tss.update(0.02);
    expect(resumed.worldTimeScale).toBe(0.25);
  });

  it('resets all active states cleanly', () => {
    const tss = new TimeScaleSystem();
    tss.triggerHitstop(80);
    tss.triggerBulletTime(2.0);
    tss.triggerSkill3TimeStop(2.6);
    tss.setPaused(true);

    tss.reset();
    expect(tss.paused).toBe(false);
    expect(tss.hitstopRemaining).toBe(0);
    expect(tss.bulletTimeActive).toBe(false);
    expect(tss.skill3Active).toBe(false);
    expect(tss.worldTimeScale).toBe(1.0);
    expect(tss.playerTimeScale).toBe(1.0);
  });

  it('expires 2.6s Skill 3 cleanly at 0 after 52 * 0.05s steps without IEEE-754 lingering', () => {
    const tss = new TimeScaleSystem();
    tss.triggerSkill3TimeStop(2.6);
    expect(tss.skill3Active).toBe(true);

    for (let i = 0; i < 52; i += 1) {
      const step = tss.update(0.05);
      expect(step.worldTimeScale).toBe(0.0);
      expect(step.playerTimeScale).toBe(1.0);
    }

    expect(tss.skill3Remaining).toBe(0);
    expect(tss.skill3Active).toBe(false);

    const next = tss.update(0.016);
    expect(next.worldTimeScale).toBe(1.0);
    expect(next.playerTimeScale).toBe(1.0);
  });
});
