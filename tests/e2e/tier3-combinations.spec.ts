import { expect, test } from '@playwright/test';
import {
  ALL_EXPECTED_ASSETS,
  assertCanvasRendered,
  assertNoCjkInDom,
  COMBAT_TUNING,
  debugSetBossHp,
  debugSetBossPosture,
  debugSetPlayerDamageMultiplier,
  debugSkipCinematic,
  debugTriggerBossTestAttack,
  distanceXZ,
  enterCombat,
  getDebugState,
  holdKey,
  launchGame,
  moveIntoMeleeRange,
  orbitCameraDrag,
  performPerfectDodge,
  radiusXZ,
  takeBossHit,
  UI_COPY,
  waitForGameReady,
  waitForPhase,
} from './helpers/gameHarness.ts';

test.describe('Tier 3 — Cross-Feature Pairwise & Multi-Feature Combinations', () => {
  test('T3-01 (F8+F9) Combo recovery cancel into Dodge triggers Perfect Dodge Bullet-Time', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);

    await debugTriggerBossTestAttack(page, 'abyssal_sweep');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.attackTelegraphActive === true,
      undefined,
      { timeout: 2_500 },
    );

    // Start combo mid-windup, then cancel recovery into Space inside the Perfect Dodge window
    await page.waitForTimeout(550);
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');

    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.bulletTimeActive && s.stats.perfectDodges >= 1);
      },
      undefined,
      { timeout: 2_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.bulletTimeActive).toBe(true);
    expect(snap.timeScale).toBeLessThanOrEqual(0.3);
    guards.assertClean(snap);
  });

  test('T3-02 (F9+F10) Perfect Dodge Bullet-Time followed by Counter Crit Skill 1', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await performPerfectDodge(page, 'abyssal_sweep');
    const beforeSkill1 = await getDebugState(page);
    expect(beforeSkill1.bulletTimeActive).toBe(true);

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.player.skillCooldowns.skill1 > 0 && s.boss.hp < prevHp,
        );
      },
      beforeSkill1.boss.hp,
      { timeout: 3_000 },
    );
    await page.waitForFunction(
      ({ prevHp, minExpectedDamage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && prevHp - s.boss.hp > minExpectedDamage);
      },
      {
        prevHp: beforeSkill1.boss.hp,
        minExpectedDamage: COMBAT_TUNING.skill1TotalDamage,
      },
      { timeout: 3_000 },
    );

    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill1).toBeGreaterThan(0);
    const damage = beforeSkill1.boss.hp - after.boss.hp;
    expect(damage).toBeGreaterThan(COMBAT_TUNING.skill1TotalDamage);
    guards.assertClean(after);
  });

  test('T3-03 (F10+F11) Skill 2 Posture Break -> 1.6x Stagger -> Skill 3 Time-Stop', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossPosture(page, 300);

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 3_000 },
    );

    const beforeUlt = await getDebugState(page);
    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.skill3Active && s.timeScale === 0);
      },
      undefined,
      { timeout: 2_500 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === false,
      undefined,
      { timeout: 6_000 },
    );

    const afterUlt = await getDebugState(page);
    const ultDmg = beforeUlt.boss.hp - afterUlt.boss.hp;
    expect(ultDmg).toBeGreaterThan(COMBAT_TUNING.skill3TotalDamage);
    expect(afterUlt.player.skillCooldowns.skill3).toBeGreaterThan(0);
    guards.assertClean(afterUlt);
  });

  test('T3-04 (F6+F5+F14) Phase 1 -> 55% real attack Transition -> Act II Sky & BGM Switch', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const p1 = await enterCombat(page, { skipIntro: true });
    const bgmP1 = p1.audio.activeBgmState;

    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold + 250);
    await page.keyboard.press('Digit2');

    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);

    await expect(page.getByText(UI_COPY.BANNER_ACT_2)).toBeVisible({
      timeout: 5_000,
    });
    expect(p2.audio.activeBgmState).not.toBe(bgmP1);
    expect(p2.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    guards.assertClean(p2);
  });

  test('T3-05 (F6+F12) Phase 2 Boss attacks -> Shield absorb & Sustain recovery', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    const { before, after: hit } = await takeBossHit(page, 'twin_abyssal_cleave');
    expect(hit.player.shield).toBeLessThan(before.player.shield);

    await performPerfectDodge(page, 'cataclysmic_leap_slam');
    const recovered = await getDebugState(page);
    expect(recovered.player.shield).toBeGreaterThan(hit.player.shield);
    guards.assertClean(recovered);
  });

  test('T3-06 (F6+F13+F15) Real 0% Finisher -> SSS Victory Screen -> Replay Clean Reset', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossHp(page, 300);
    await page.keyboard.press('Digit2');

    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    const vic = await waitForPhase(page, 'VICTORY', 5_000);
    await expect(page.getByText(UI_COPY.VICTORY_HEADER)).toBeVisible();
    await expect(page.getByText(/\bSSS\b/).first()).toBeVisible();

    await page.getByRole('button', { name: UI_COPY.VICTORY_REPLAY_CTA }).click();
    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().phase;
        return p === 'CINEMATIC_INTRO' || p === 'PHASE_1';
      },
      undefined,
      { timeout: 5_000 },
    );
    if ((await getDebugState(page)).phase === 'CINEMATIC_INTRO') {
      await debugSkipCinematic(page);
    }
    const reset = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(reset.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(reset.stats.totalDamageDealt).toBe(0);
    expect(vic.stats.rank).toBe('SSS');
    guards.assertClean(reset);
  });

  test('T3-07 (F2+F4+F7) WebGL2 fallback + Arena Clamp + WASD/Orbit', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, {
      forceWebGL: true,
      testMode: true,
    });
    const p1 = await enterCombat(page, { skipIntro: true });
    expect(p1.rendererBackend).toBe('webgl2');

    await orbitCameraDrag(page, 180, 20, 8);
    await holdKey(page, 'KeyW', 3_000);
    const edge = await getDebugState(page);
    expect(radiusXZ(edge.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.05,
    );
    await assertCanvasRendered(page);
    guards.assertClean(edge);
  });

  test('T3-08 (F7+F8+F10) Strafe/Approach -> 4-Hit Combo -> Skill 1 Chaser', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyA', 250);
    await moveIntoMeleeRange(page, 3.2);

    const before = await getDebugState(page);
    const expectedComboDamage = COMBAT_TUNING.comboSteps.reduce(
      (sum, stepTuning) => sum + stepTuning.damage,
      0,
    );
    for (let step = 1; step <= 4; step += 1) {
      await page.keyboard.press('KeyJ');
      await page.waitForFunction(
        (expected) =>
          (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= expected,
        step,
        { timeout: 2_500 },
      );
      if (step < 4) {
        await page.waitForTimeout(240);
      }
    }
    await page.waitForFunction(
      ({ prevHp, minComboDamage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.comboStep === 4 &&
            prevHp - s.boss.hp >= minComboDamage,
        );
      },
      { prevHp: before.boss.hp, minComboDamage: expectedComboDamage },
      { timeout: 2_500 },
    );
    const afterCombo = await getDebugState(page);
    expect(afterCombo.player.comboStep).toBe(4);

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && s.player.skillCooldowns.skill1 > 0 && s.boss.hp < prevHp,
        );
      },
      afterCombo.boss.hp,
      { timeout: 3_000 },
    );
    await page.waitForFunction(
      ({ prevHp, minSkill1Damage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill1 > 0 &&
            prevHp - s.boss.hp >= minSkill1Damage,
        );
      },
      {
        prevHp: afterCombo.boss.hp,
        minSkill1Damage: COMBAT_TUNING.skill1TotalDamage,
      },
      { timeout: 3_000 },
    );
    const after = await getDebugState(page);
    expect(after.stats.totalDamageDealt).toBeGreaterThan(
      before.stats.totalDamageDealt + 800,
    );
    guards.assertClean(after);
  });

  test('T3-09 (F10+F12) Low HP Sustain via Skill 3 (+120 HP & full 250 Shield)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    for (let i = 0; i < 3; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
    }
    const low = await getDebugState(page);
    expect(low.player.hp).toBeLessThan(COMBAT_TUNING.playerMaxHp);
    expect(low.player.shield).toBe(0);

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
    const healed = await getDebugState(page);
    expect(healed.player.hp).toBeGreaterThan(low.player.hp);
    expect(healed.player.shield).toBe(COMBAT_TUNING.playerMaxShield);
    guards.assertClean(healed);
  });

  test('T3-10 (F9+F12) Lotus Ward Trigger + Perfect Dodge Comeback', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    for (let i = 0; i < 16; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
      const s = await getDebugState(page);
      expect(s.player.hp).toBeGreaterThan(0);
      if (s.audio.lastSfx === 'lotus_ward') {
        break;
      }
    }

    const postWard = await getDebugState(page);
    expect(postWard.player.hp).toBeGreaterThan(0);

    const { after: comeback } = await performPerfectDodge(page, 'abyssal_sweep');
    expect(comeback.bulletTimeActive).toBe(true);
    expect(comeback.player.hp).toBeGreaterThanOrEqual(postWard.player.hp);
    guards.assertClean(comeback);
  });

  test('T3-11 (F13+F14+F6) Pause / Mute mid-combat -> Resume -> Phase 2 Transition', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 2_500 },
    );
    await page.getByRole('button', { name: UI_COPY.PAUSE_MUTE }).click();
    await page.getByRole('button', { name: UI_COPY.PAUSE_RESUME }).click();

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(p2.paused).toBe(false);
    expect(p2.audio.muted).toBe(true);
    guards.assertClean(p2);
  });

  test('T3-12 (F13+F6) Pause -> Restart Trial -> Fresh Intro/Act I', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(400);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 2_500 },
    );
    await page.getByRole('button', { name: UI_COPY.PAUSE_RESTART }).click();
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            !s.paused &&
            (s.phase === 'CINEMATIC_INTRO' || s.phase === 'PHASE_1'),
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    if ((await getDebugState(page)).phase === 'CINEMATIC_INTRO') {
      await debugSkipCinematic(page);
    }
    const fresh = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(fresh.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(fresh.stats.totalDamageDealt).toBe(0);
    expect(fresh.player.skillCooldowns.skill1).toBe(0);
    guards.assertClean(fresh);
  });

  test('T3-13 (F3+F8+F10) Skeletal clip continuity across full ability rotation', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await holdKey(page, 'KeyW', 250);
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);

    await moveIntoMeleeRange(page, 3.2);
    const beforeCombo = await getDebugState(page);
    const expectedComboDamage = COMBAT_TUNING.comboSteps.reduce(
      (sum, stepTuning) => sum + stepTuning.damage,
      0,
    );
    for (let step = 1; step <= 4; step += 1) {
      await page.keyboard.press('KeyJ');
      await page.waitForFunction(
        (expected) =>
          (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= expected,
        step,
        { timeout: 2_500 },
      );
      expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(
        0,
      );
      if (step < 4) {
        await page.waitForTimeout(240);
      }
    }
    await page.waitForFunction(
      ({ prevDmg, minComboDamage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.comboStep === 4 &&
            s.stats.totalDamageDealt >= prevDmg + minComboDamage,
        );
      },
      {
        prevDmg: beforeCombo.stats.totalDamageDealt,
        minComboDamage: expectedComboDamage,
      },
      { timeout: 2_500 },
    );

    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);

    const beforeSkill1 = await getDebugState(page);
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      ({ prevDmg, minSkill1Damage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill1 > 0 &&
            s.stats.totalDamageDealt >= prevDmg + minSkill1Damage,
        );
      },
      {
        prevDmg: beforeSkill1.stats.totalDamageDealt,
        minSkill1Damage: COMBAT_TUNING.skill1TotalDamage,
      },
      { timeout: 3_000 },
    );
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);

    const beforeSkill2 = await getDebugState(page);
    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      ({ prevDmg, minSkill2Damage }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill2 > 0 &&
            s.stats.totalDamageDealt >= prevDmg + minSkill2Damage,
        );
      },
      {
        prevDmg: beforeSkill2.stats.totalDamageDealt,
        minSkill2Damage: COMBAT_TUNING.skill2Damage,
      },
      { timeout: 3_000 },
    );
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);

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
    const end = await getDebugState(page);
    expect(end.player.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(end);
  });

  test('T3-14 (F1+F2+F14) Offline asset bundle with external-network blocker + audio unlock', async ({
    page,
  }) => {
    const blockedExternal: string[] = [];
    await page.route('**/*', (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
        return route.continue();
      }
      const parsed = new URL(reqUrl);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return route.continue();
      }
      blockedExternal.push(reqUrl);
      return route.abort('blockedbyclient');
    });

    const { guards } = await launchGame(page, { testMode: true });
    for (const assetPath of ALL_EXPECTED_ASSETS) {
      expect(guards.assetResponseMap.get(assetPath)).toContain(200);
    }
    const combat = await enterCombat(page, { skipIntro: true });
    expect(blockedExternal).toEqual([]);
    expect(combat.audio.unlocked).toBe(true);
    guards.assertClean(combat);
  });

  test('T3-15 (F8+F11+F6) Posture break just above 55% HP followed by push across 55% boundary', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold + 200);
    await debugSetBossPosture(page, 0);
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );

    await page.keyboard.press('KeyJ');
    const trans = await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    expect(trans.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(p2.phase).toBe('PHASE_2');
    guards.assertClean(p2);
  });

  test('T3-16 (F10+F6) Skill 3 activation right before 55% transition resolves without freezing timeScale at 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 4.0);
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold + 500);
    await debugSetPlayerDamageMultiplier(page, 2);

    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === true,
      undefined,
      { timeout: 2_500 },
    );

    const trans = await waitForPhase(page, 'CINEMATIC_TRANSITION', 8_000);
    expect(trans.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(p2.timeScale).toBeCloseTo(1.0, 2);
    expect(p2.skill3Active).toBe(false);
    guards.assertClean(p2);
  });

  test('T3-17 (F4+F11) Boss stagger near arena perimeter keeps Boss in-bounds and hits connect', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Lure toward perimeter and break posture
    await holdKey(page, 'KeyS', 1_800);
    await page.waitForTimeout(1_000);
    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossPosture(page, 0);
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );

    const beforeHits = await getDebugState(page);
    expect(radiusXZ(beforeHits.boss.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.05,
    );
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevHp) => (window.__GAME_DEBUG__?.getState().boss.hp ?? prevHp) < prevHp,
      beforeHits.boss.hp,
      { timeout: 2_500 },
    );
    const after = await getDebugState(page);
    expect(distanceXZ(after.player.position, after.boss.position)).toBeGreaterThanOrEqual(
      1.0,
    );
    guards.assertClean(after);
  });

  test('T3-18 (F2+F13) Dual-backend HUD and English text parity (WebGPU vs ?forceWebGL=1)', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page1 = await ctx1.newPage();
    const { guards: g1, snapshot: s1 } = await launchGame(page1, {
      testMode: true,
    });
    await enterCombat(page1, { skipIntro: true });
    await assertNoCjkInDom(page1);
    const text1 = await page1.locator('body').innerText();
    expect(text1).toContain(UI_COPY.BOSS_NAME);
    expect(text1).toContain(UI_COPY.SKILL_3_NAME);
    g1.assertClean(s1);
    await ctx1.close();

    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page2 = await ctx2.newPage();
    const { guards: g2, snapshot: s2 } = await launchGame(page2, {
      forceWebGL: true,
      testMode: true,
    });
    expect(s2.rendererBackend).toBe('webgl2');
    await enterCombat(page2, { skipIntro: true });
    await assertNoCjkInDom(page2);
    const text2 = await page2.locator('body').innerText();
    expect(text2).toContain(UI_COPY.BOSS_NAME);
    expect(text2).toContain(UI_COPY.SKILL_3_NAME);
    g2.assertClean(await waitForGameReady(page2));
    await ctx2.close();
  });
});
