import { expect, test } from '@playwright/test';
import {
  clickCanvasCenter,
  COMBAT_TUNING,
  debugReadyAllSkills,
  debugSetBossHp,
  debugSetBossPosture,
  debugSkipCinematic,
  distanceXZ,
  enterCombat,
  getDebugState,
  holdKey,
  launchGame,
  moveIntoMeleeRange,
  orbitCameraDrag,
  performPerfectDodge,
  takeBossHit,
  UI_COPY,
  waitForPhase,
} from './helpers/gameHarness.ts';

test.describe('Tier 1 — F6: 3-Act Boss Fight State Machine & Cinematics', () => {
  test('T1-F6-01 Initial load starts in phase === TITLE', async ({ page }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    expect(snapshot.phase).toBe('TITLE');
    await expect(
      page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }),
    ).toBeVisible();
    guards.assertClean(snapshot);
  });

  test('T1-F6-02 Clicking BEGIN TRIAL enters CINEMATIC_INTRO then PHASE_1', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();

    await waitForPhase(page, 'CINEMATIC_INTRO', 5_000);
    const phase1 = await waitForPhase(page, 'PHASE_1', 12_000);
    expect(phase1.phase).toBe('PHASE_1');
    guards.assertClean(phase1);
  });

  test('T1-F6-03 Dropping Boss HP to <= 55% (22,000) triggers CINEMATIC_TRANSITION then PHASE_2', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    const transition = await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    expect(transition.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    expect(transition.boss.hpRatio).toBeCloseTo(
      COMBAT_TUNING.bossPhase2ThresholdRatio,
      3,
    );

    const phase2 = await waitForPhase(page, 'PHASE_2', 12_000);
    expect(phase2.phase).toBe('PHASE_2');
    guards.assertClean(phase2);
  });

  test('T1-F6-04 Dropping Boss HP to 0 triggers CINEMATIC_FINISHER then VICTORY', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    const victory = await waitForPhase(page, 'VICTORY', 12_000);
    expect(victory.boss.hp).toBe(0);
    guards.assertClean(victory);
  });

  test('T1-F6-05 Clicking PLAY AGAIN on VICTORY resets cleanly to intro/PHASE_1 with 100% Boss HP', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY', 5_000);

    const replayBtn = page.getByRole('button', {
      name: UI_COPY.VICTORY_REPLAY_CTA,
    });
    await expect(replayBtn).toBeVisible({ timeout: 5_000 });
    await replayBtn.click();

    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && (s.phase === 'CINEMATIC_INTRO' || s.phase === 'PHASE_1'),
        );
      },
      undefined,
      { timeout: 5_000 },
    );

    const snap = await getDebugState(page);
    if (snap.phase === 'CINEMATIC_INTRO') {
      await debugSkipCinematic(page);
    }
    const resetSnap = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(resetSnap.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(resetSnap.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    expect(resetSnap.stats.totalDamageDealt).toBe(0);
    guards.assertClean(resetSnap);
  });
});

test.describe('Tier 1 — F7: Player WASD Movement & Orbit Camera', () => {
  test('T1-F7-01 Holding W moves player forward (> 1m)', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyW', 350);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F7-02 Holding A strafes left (> 1m)', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyA', 350);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F7-03 Holding S moves backward (> 1m)', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyS', 350);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F7-04 Holding D strafes right (> 1m)', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyD', 350);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F7-05 Mouse drag orbits camera smoothly without errors or floor clipping', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const p0 = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyW', 220);
    const p1 = await getDebugState(page);
    const v1x = p1.player.position[0] - p0.player.position[0];
    const v1z = p1.player.position[2] - p0.player.position[2];

    await orbitCameraDrag(page, 220, 30, 10);

    await holdKey(page, 'KeyW', 220);
    const p2 = await getDebugState(page);
    const v2x = p2.player.position[0] - p1.player.position[0];
    const v2z = p2.player.position[2] - p1.player.position[2];

    const len1 = Math.hypot(v1x, v1z);
    const len2 = Math.hypot(v2x, v2z);
    expect(len1).toBeGreaterThan(0.5);
    expect(len2).toBeGreaterThan(0.5);
    const cosTheta = (v1x * v2x + v1z * v2z) / (len1 * len2);
    expect(cosTheta).toBeLessThan(0.95);
    expect(p2.player.position[1]).toBeGreaterThanOrEqual(-0.05);
    guards.assertClean(p2);
  });
});

test.describe('Tier 1 — F8: 4-Hit Flowing Sword Combo', () => {
  test('T1-F8-01 Single KeyJ executes comboStep === 1 and deals Boss HP damage', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 3.2);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.player.comboStep >= 1 && s.boss.hp < prevHp);
      },
      before.boss.hp,
      { timeout: 2_500 },
    );

    const after = await getDebugState(page);
    expect(after.player.comboStep).toBe(1);
    expect(after.boss.hp).toBeLessThan(before.boss.hp);
    guards.assertClean(after);
  });

  test('T1-F8-02 Chaining 2 attacks advances comboStep to 2', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= 1,
      undefined,
      { timeout: 2_000 },
    );
    await page.waitForTimeout(220);
    await page.keyboard.press('KeyJ');

    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= 2,
      undefined,
      { timeout: 2_500 },
    );

    const after = await getDebugState(page);
    expect(after.player.comboStep).toBe(2);
    guards.assertClean(after);
  });

  test('T1-F8-03 Chaining 4 attacks completes 4-hit sequence (comboStep === 4) and increases totalDamageDealt', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 3.2);

    let maxStepSeen = 0;
    for (let step = 1; step <= 4; step += 1) {
      await page.keyboard.press('KeyJ');
      await page.waitForFunction(
        (expected) =>
          (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= expected,
        step,
        { timeout: 2_500 },
      );
      const cur = await getDebugState(page);
      maxStepSeen = Math.max(maxStepSeen, cur.player.comboStep);
      if (step < 4) {
        await page.waitForTimeout(240);
      }
    }

    const after = await getDebugState(page);
    expect(maxStepSeen).toBe(4);
    expect(after.stats.totalDamageDealt).toBeGreaterThan(
      before.stats.totalDamageDealt,
    );
    guards.assertClean(after);
  });

  test('T1-F8-04 Combo hits drain Boss Posture and build Player Qi', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    // Spend 50 Qi on Skill 3 first so Qi gain from combo hits is directly observable
    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === true,
      undefined,
      { timeout: 2_500 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === false,
      undefined,
      { timeout: 5_000 },
    );

    const before = await moveIntoMeleeRange(page, 3.2);
    expect(before.player.qi).toBeLessThan(COMBAT_TUNING.playerMaxQi);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      ({ prevPosture, prevQi }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.boss.posture < prevPosture && s.player.qi > prevQi,
        );
      },
      { prevPosture: before.boss.posture, prevQi: before.player.qi },
      { timeout: 2_500 },
    );

    const after = await getDebugState(page);
    expect(after.boss.posture).toBeLessThan(before.boss.posture);
    expect(after.player.qi).toBeGreaterThan(before.player.qi);
    guards.assertClean(after);
  });

  test('T1-F8-05 Both LMB click and KeyJ trigger the basic combo equivalently', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const beforeLmb = await moveIntoMeleeRange(page, 3.2);

    await clickCanvasCenter(page);
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.player.comboStep >= 1 && s.boss.hp < prevHp);
      },
      beforeLmb.boss.hp,
      { timeout: 2_500 },
    );
    const afterLmb = await getDebugState(page);
    const lmbDamage = beforeLmb.boss.hp - afterLmb.boss.hp;
    expect(lmbDamage).toBeGreaterThan(0);

    // Wait for combo reset window (> 0.55s) then verify KeyJ produces same Hit 1 damage
    await page.waitForTimeout(800);
    await moveIntoMeleeRange(page, 3.2);
    const beforeKeyJ = await getDebugState(page);
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.player.comboStep >= 1 && s.boss.hp < prevHp);
      },
      beforeKeyJ.boss.hp,
      { timeout: 2_500 },
    );
    const afterKeyJ = await getDebugState(page);
    const keyJDamage = beforeKeyJ.boss.hp - afterKeyJ.boss.hp;
    expect(keyJDamage).toBe(lmbDamage);
    guards.assertClean(afterKeyJ);
  });
});

test.describe('Tier 1 — F9: Generous I-Frame Dodge & Perfect Dodge Bullet-Time', () => {
  test('T1-F9-01 Space triggers dodge (isDodging === true and horizontal displacement)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === true,
      undefined,
      { timeout: 1_500 },
    );
    await page.waitForTimeout(250);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F9-02 ShiftLeft triggers dodge equivalently', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('ShiftLeft');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === true,
      undefined,
      { timeout: 1_500 },
    );
    await page.waitForTimeout(250);
    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T1-F9-03 Dodge grants invulnerable === true window', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().player;
        return Boolean(p && p.isDodging && p.invulnerable);
      },
      undefined,
      { timeout: 1_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.player.invulnerable).toBe(true);
    guards.assertClean(snap);
  });

  test('T1-F9-04 Dodging during triggerBossTestAttack triggers Bullet-Time and increments perfectDodges', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    const { before, after } = await performPerfectDodge(page, 'abyssal_sweep');
    expect(after.bulletTimeActive).toBe(true);
    expect(after.timeScale).toBeLessThanOrEqual(0.3);
    expect(after.stats.perfectDodges).toBe(before.stats.perfectDodges + 1);
    guards.assertClean(after);
  });

  test('T1-F9-05 Perfect Dodge restores Qi/Shield and buffs next counter hit (1.4x)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Drain shield first so Perfect Dodge shield restore is observable
    await takeBossHit(page, 'shattered_earth_slam');
    await page.waitForTimeout(700);
    const preDodge = await getDebugState(page);
    expect(preDodge.player.shield).toBeLessThan(COMBAT_TUNING.playerMaxShield);

    const { after: duringBulletTime } = await performPerfectDodge(
      page,
      'abyssal_sweep',
    );
    expect(duringBulletTime.player.shield).toBeGreaterThan(preDodge.player.shield);

    // Execute counter hit during Bullet-Time -> expects 1.4x counter crit on Hit 1
    await moveIntoMeleeRange(page, 3.2);
    const beforeCounter = await getDebugState(page);
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevHp) => (window.__GAME_DEBUG__?.getState().boss.hp ?? prevHp) < prevHp,
      beforeCounter.boss.hp,
      { timeout: 2_000 },
    );
    const afterCounter = await getDebugState(page);
    const damageDealt = beforeCounter.boss.hp - afterCounter.boss.hp;
    const expectedCounterDamage = Math.round(
      COMBAT_TUNING.comboSteps[0].damage * COMBAT_TUNING.bulletTimeCounterMultiplier,
    );
    expect(damageDealt).toBeGreaterThanOrEqual(expectedCounterDamage - 5);
    guards.assertClean(afterCounter);
  });
});

test.describe('Tier 1 — F10: Active Skills 1, 2, 3', () => {
  test('T1-F10-01 Digit1 triggers Phantom Dash, closes distance, deals multi-hit damage, starts skill1 CD', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    const initialDist = distanceXZ(start.player.position, start.boss.position);

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.player.skillCooldowns.skill1 > 0 && s.boss.hp < prevHp,
        );
      },
      start.boss.hp,
      { timeout: 3_000 },
    );

    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill1).toBeGreaterThan(0);
    expect(after.boss.hp).toBeLessThan(start.boss.hp);
    if (initialDist > 4) {
      expect(distanceXZ(after.player.position, after.boss.position)).toBeLessThan(
        initialDist,
      );
    }
    guards.assertClean(after);
  });

  test('T1-F10-02 Digit2 triggers Heaven Cleave, deals heavy HP & Posture damage, starts skill2 CD', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 3.6);

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.player.skillCooldowns.skill2 > 0 && s.boss.hp < prevHp,
        );
      },
      before.boss.hp,
      { timeout: 3_000 },
    );

    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill2).toBeGreaterThan(0);
    expect(before.boss.hp - after.boss.hp).toBeGreaterThanOrEqual(700);
    expect(before.boss.posture - after.boss.posture).toBeGreaterThanOrEqual(400);
    guards.assertClean(after);
  });

  test('T1-F10-03 Digit3 (with >= 50 Qi) triggers skill3Active === true and timeScale === 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 4.0);
    expect(before.player.qi).toBeGreaterThanOrEqual(COMBAT_TUNING.skill3QiCost);

    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.skill3Active && s.timeScale === 0);
      },
      undefined,
      { timeout: 2_500 },
    );

    const during = await getDebugState(page);
    expect(during.skill3Active).toBe(true);
    expect(during.timeScale).toBe(0);
    guards.assertClean(during);
  });

  test('T1-F10-04 Skill 3 deals massive severance damage and sets skillCooldowns.skill3 > 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 4.0);

    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === true,
      undefined,
      { timeout: 2_500 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === false,
      undefined,
      { timeout: 6_000 },
    );

    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill3).toBeGreaterThan(0);
    expect(before.boss.hp - after.boss.hp).toBeGreaterThanOrEqual(2_000);
    guards.assertClean(after);
  });

  test('T1-F10-05 Skill cooldowns count down monotonically over elapsed seconds back to 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 4.0);

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.skillCooldowns.skill1 ?? 0) > 0,
      undefined,
      { timeout: 2_000 },
    );
    const cdStart = (await getDebugState(page)).player.skillCooldowns.skill1;

    await page.waitForTimeout(1_200);
    const cdMid = (await getDebugState(page)).player.skillCooldowns.skill1;
    expect(cdMid).toBeLessThan(cdStart);

    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.skillCooldowns.skill1 ?? 1) === 0,
      undefined,
      { timeout: 7_500 },
    );
    const cdEnd = (await getDebugState(page)).player.skillCooldowns.skill1;
    expect(cdEnd).toBe(0);
    guards.assertClean(await getDebugState(page));
  });
});

test.describe('Tier 1 — F11: Boss Posture & Extended Stagger', () => {
  test('T1-F11-01 Boss starts at full Posture (postureRatio === 1.0, 1,000)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const snap = await enterCombat(page, { skipIntro: true });
    expect(snap.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    expect(snap.boss.postureRatio).toBe(1.0);
    expect(snap.boss.staggered).toBe(false);
    guards.assertClean(snap);
  });

  test('T1-F11-02 Player attacks and Skill 2 visibly reduce boss.posture', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await moveIntoMeleeRange(page, 3.4);

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      (prevPosture) =>
        (window.__GAME_DEBUG__?.getState().boss.posture ?? prevPosture) <
        prevPosture,
      before.boss.posture,
      { timeout: 2_500 },
    );

    const after = await getDebugState(page);
    expect(after.boss.posture).toBeLessThan(before.boss.posture);
    expect(after.boss.postureRatio).toBeLessThan(1.0);
    guards.assertClean(after);
  });

  test('T1-F11-03 Draining boss.posture to 0 sets staggered === true and increments postureBreaks', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossPosture(page, 300);
    const before = await getDebugState(page);

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      (prevBreaks) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.boss.staggered && s.stats.postureBreaks > prevBreaks,
        );
      },
      before.stats.postureBreaks,
      { timeout: 3_000 },
    );

    const after = await getDebugState(page);
    expect(after.boss.posture).toBe(0);
    expect(after.boss.staggered).toBe(true);
    expect(after.stats.postureBreaks).toBe(before.stats.postureBreaks + 1);
    guards.assertClean(after);
  });

  test('T1-F11-04 Attacks while boss.staggered === true deal ~1.6x amplified damage', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);
    await debugSetBossPosture(page, 0);

    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );
    await debugReadyAllSkills(page);
    const beforeHit = await getDebugState(page);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevHp) => (window.__GAME_DEBUG__?.getState().boss.hp ?? prevHp) < prevHp,
      beforeHit.boss.hp,
      { timeout: 2_500 },
    );

    const afterHit = await getDebugState(page);
    const dmg = beforeHit.boss.hp - afterHit.boss.hp;
    const expected = Math.round(
      COMBAT_TUNING.comboSteps[0].damage * COMBAT_TUNING.bossStaggerDamageMultiplier,
    );
    expect(dmg).toBeGreaterThanOrEqual(expected - 5);
    guards.assertClean(afterHit);
  });

  test('T1-F11-05 After stagger expires (~5s), staggered === false and Posture resets to 1,000', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossPosture(page, 0);

    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );

    await page.waitForFunction(
      (maxPosture) => {
        const b = window.__GAME_DEBUG__?.getState().boss;
        return Boolean(
          b && !b.staggered && b.posture === maxPosture,
        );
      },
      COMBAT_TUNING.bossMaxPosture,
      { timeout: 8_000 },
    );

    const recovered = await getDebugState(page);
    expect(recovered.boss.staggered).toBe(false);
    expect(recovered.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    guards.assertClean(recovered);
  });
});
