import { expect, test, type Page } from '@playwright/test';
import {
  ALL_EXPECTED_ASSETS,
  COMBAT_TUNING,
  UI_COPY,
  assertCanvasRendered,
  assertNoCjkInDom,
  assertOpenMotionBaselineClean,
  attachRuntimeGuards,
  debugReadyAllSkills,
  debugSetBossHp,
  debugSetBossPosture,
  debugSetPlayerDamageMultiplier,
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
  triggerBasicAttack,
  waitForGameReady,
  waitForPhase,
  waitForRafFrames,
  type GameDebugSnapshot,
} from './helpers/gameHarness';

async function ensureQiForSkill3(page: Page): Promise<void> {
  await moveIntoMeleeRange(page, 3.2);
  let snap = await getDebugState(page);
  for (let i = 0; i < 8 && snap.player.qi < 50; i += 1) {
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForTimeout(220);
    snap = await getDebugState(page);
  }
}

async function advancePhase1ToPhase2(page: Page): Promise<GameDebugSnapshot> {
  await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold + 200);
  await debugSetPlayerDamageMultiplier(page, 4);
  try {
    await moveIntoMeleeRange(page, 3.2);
    await triggerBasicAttack(page, 'KeyJ');
    await waitForRafFrames(page, 4);

    const afterHit = await getDebugState(page);
    if (afterHit.phase === 'PHASE_1') {
      await triggerBasicAttack(page, 'KeyJ');
      await waitForRafFrames(page, 4);
    }

    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().phase;
        return p === 'CINEMATIC_TRANSITION' || p === 'PHASE_2';
      },
      undefined,
      { timeout: 10_000 },
    );

    const mid = await getDebugState(page);
    if (mid.phase === 'CINEMATIC_TRANSITION') {
      await debugSkipCinematic(page);
    }
    return await waitForPhase(page, 'PHASE_2', 15_000);
  } finally {
    await debugSetPlayerDamageMultiplier(page, 1);
  }
}

async function finishPhase2ToVictory(page: Page): Promise<GameDebugSnapshot> {
  await debugSetBossHp(page, 25);
  await debugSetPlayerDamageMultiplier(page, 5);
  try {
    await moveIntoMeleeRange(page, 3.2);
    await triggerBasicAttack(page, 'KeyJ');

    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().phase;
        return p === 'CINEMATIC_FINISHER' || p === 'VICTORY';
      },
      undefined,
      { timeout: 10_000 },
    );

    const mid = await getDebugState(page);
    if (mid.phase === 'CINEMATIC_FINISHER') {
      await debugSkipCinematic(page);
    }
    return await waitForPhase(page, 'VICTORY', 15_000);
  } finally {
    await debugSetPlayerDamageMultiplier(page, 1);
  }
}

test.describe('Tier 4 — Real-World Application Scenarios', () => {
  test('T4-01: Full 3-Act E2E Playthrough (Title -> Intro -> Phase 1 -> 55% Transition -> Phase 2 -> 0% Finisher -> SSS Victory -> Replay)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { guards, snapshot: titleSnap } = await launchGame(page, {
      testMode: true,
    });

    expect(titleSnap.phase).toBe('TITLE');
    await assertCanvasRendered(page);
    await assertNoCjkInDom(page);

    const startBtn = page.getByRole('button', { name: UI_COPY.TITLE_START_CTA });
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().phase;
        return p === 'CINEMATIC_INTRO' || p === 'PHASE_1';
      },
      undefined,
      { timeout: 10_000 },
    );

    const introSnap = await getDebugState(page);
    if (introSnap.phase === 'CINEMATIC_INTRO') {
      await assertNoCjkInDom(page);
      await debugSkipCinematic(page);
    }

    const phase1Snap = await waitForPhase(page, 'PHASE_1', 15_000);
    expect(phase1Snap.boss.hp).toBe(phase1Snap.boss.maxHp);
    await assertNoCjkInDom(page);

    // Real combat hits in Phase 1 (verify basic attacks and Skill 1 individually reduce Boss HP)
    await moveIntoMeleeRange(page, 3.2);
    const beforeBasicP1 = await getDebugState(page);
    await triggerBasicAttack(page, 'LMB');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.boss.hp < prevHp);
      },
      beforeBasicP1.boss.hp,
      { timeout: 3_000 },
    );
    const afterLmbP1 = await getDebugState(page);
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.boss.hp < prevHp);
      },
      afterLmbP1.boss.hp,
      { timeout: 3_000 },
    );
    const afterBasicP1 = await getDebugState(page);
    expect(afterBasicP1.boss.hp).toBeLessThan(beforeBasicP1.boss.hp);

    await moveIntoMeleeRange(page, 4.0);
    const beforeS1P1 = await getDebugState(page);
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      ({ prevHp, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.boss.hp < prevHp &&
            s.player.skillCooldowns.skill1 > 0 &&
            s.player.skillCooldowns.skill1 <= cdMax - 0.42,
        );
      },
      { prevHp: beforeS1P1.boss.hp, cdMax: COMBAT_TUNING.skill1CooldownSeconds },
      { timeout: 3_000 },
    );
    const afterS1P1 = await getDebugState(page);
    expect(afterS1P1.boss.hp).toBeLessThan(beforeS1P1.boss.hp);

    // Cross 55% HP threshold -> CINEMATIC_TRANSITION -> PHASE_2
    const phase2Snap = await advancePhase1ToPhase2(page);
    expect(phase2Snap.phase).toBe('PHASE_2');
    expect(phase2Snap.boss.hp).toBeLessThanOrEqual(
      Math.ceil(phase2Snap.boss.maxHp * 0.55),
    );
    await assertNoCjkInDom(page);

    // Real combat in Phase 2 (verify Skill 2 and Skill 3 individually reduce Boss HP)
    await debugReadyAllSkills(page);
    await ensureQiForSkill3(page);
    await moveIntoMeleeRange(page, 3.4);
    const beforeP2S2 = await getDebugState(page);
    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      ({ prevHp, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.boss.hp < prevHp &&
            s.player.skillCooldowns.skill2 > 0 &&
            s.player.skillCooldowns.skill2 <= cdMax - 0.45,
        );
      },
      { prevHp: beforeP2S2.boss.hp, cdMax: COMBAT_TUNING.skill2CooldownSeconds },
      { timeout: 3_000 },
    );
    const afterP2S2 = await getDebugState(page);
    expect(afterP2S2.boss.hp).toBeLessThan(beforeP2S2.boss.hp);

    await moveIntoMeleeRange(page, 4.0);
    const beforeP2S3 = await getDebugState(page);
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
    const afterP2S3 = await getDebugState(page);
    expect(afterP2S3.boss.hp).toBeLessThan(beforeP2S3.boss.hp);

    // Drop Boss HP to 0 -> CINEMATIC_FINISHER -> VICTORY
    const victorySnap = await finishPhase2ToVictory(page);
    expect(victorySnap.phase).toBe('VICTORY');
    expect(victorySnap.boss.hp).toBe(0);
    await assertNoCjkInDom(page);

    const victoryBody = await page.locator('body').innerText();
    expect(victoryBody).toContain('SSS');

    // Replay reset
    const replayBtn = page.getByRole('button', { name: /play again/i });
    await expect(replayBtn).toBeVisible({ timeout: 10_000 });
    await replayBtn.click();

    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return (
          s !== undefined &&
          (s.phase === 'TITLE' ||
            s.phase === 'CINEMATIC_INTRO' ||
            s.phase === 'PHASE_1') &&
          s.boss.hp === s.boss.maxHp &&
          s.player.hp === s.player.maxHp
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    const resetSnap = await getDebugState(page);
    expect(resetSnap.boss.hp).toBe(resetSnap.boss.maxHp);
    expect(resetSnap.player.hp).toBe(resetSnap.player.maxHp);
    expect(resetSnap.stats.damageTaken).toBe(0);
    guards.assertClean(resetSnap);
  });

  test('T4-02: Dual-Backend Parity Run (Metal 3 WebGPU vs ?forceWebGL=1)', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const runBackendCheck = async (
      forceWebGL: boolean,
    ): Promise<{
      backend: string;
      phase1HpDrop: number;
      phase2Reached: boolean;
      canvasSize: { width: number; height: number };
    }> => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      try {
        const { guards, snapshot } = await launchGame(page, {
          testMode: true,
          forceWebGL,
        });
        const expectedBackend = forceWebGL ? 'webgl2' : 'webgpu';
        expect(snapshot.rendererBackend).toBe(expectedBackend);

        const canvasSize = await assertCanvasRendered(page);
        await enterCombat(page, { skipIntro: true });

        await moveIntoMeleeRange(page, 3.2);
        const before = await getDebugState(page);
        await triggerBasicAttack(page, 'KeyJ');
        await page.waitForFunction(
          (prevHp) => {
            const s = window.__GAME_DEBUG__?.getState();
            return Boolean(s && s.boss.hp < prevHp);
          },
          before.boss.hp,
          { timeout: 3_000 },
        );
        const afterBasic = await getDebugState(page);
        expect(afterBasic.boss.hp).toBeLessThan(before.boss.hp);

        await moveIntoMeleeRange(page, 4.0);
        await page.keyboard.press('Digit1');
        await page.waitForFunction(
          ({ prevHp, cdMax }) => {
            const s = window.__GAME_DEBUG__?.getState();
            return Boolean(
              s &&
                s.boss.hp < prevHp &&
                s.player.skillCooldowns.skill1 > 0 &&
                s.player.skillCooldowns.skill1 <= cdMax - 0.42,
            );
          },
          { prevHp: afterBasic.boss.hp, cdMax: COMBAT_TUNING.skill1CooldownSeconds },
          { timeout: 3_000 },
        );
        const afterS1 = await getDebugState(page);
        expect(afterS1.boss.hp).toBeLessThan(afterBasic.boss.hp);

        await moveIntoMeleeRange(page, 3.4);
        await page.keyboard.press('Digit2');
        await page.waitForFunction(
          ({ prevHp, cdMax }) => {
            const s = window.__GAME_DEBUG__?.getState();
            return Boolean(
              s &&
                s.boss.hp < prevHp &&
                s.player.skillCooldowns.skill2 > 0 &&
                s.player.skillCooldowns.skill2 <= cdMax - 0.45,
            );
          },
          { prevHp: afterS1.boss.hp, cdMax: COMBAT_TUNING.skill2CooldownSeconds },
          { timeout: 3_000 },
        );
        const afterS2 = await getDebugState(page);
        expect(afterS2.boss.hp).toBeLessThan(afterS1.boss.hp);

        await ensureQiForSkill3(page);
        await moveIntoMeleeRange(page, 4.0);
        const beforeS3 = await getDebugState(page);
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
        const afterSkills = await getDebugState(page);
        expect(afterSkills.boss.hp).toBeLessThan(beforeS3.boss.hp);
        const phase1HpDrop = before.boss.hp - afterSkills.boss.hp;
        expect(phase1HpDrop).toBeGreaterThan(0);

        const p2 = await advancePhase1ToPhase2(page);
        expect(p2.phase).toBe('PHASE_2');
        await assertCanvasRendered(page);
        guards.assertClean(p2);

        return {
          backend: snapshot.rendererBackend,
          phase1HpDrop,
          phase2Reached: p2.phase === 'PHASE_2',
          canvasSize,
        };
      } finally {
        await context.close();
      }
    };

    const webgpuResult = await runBackendCheck(false);
    const webglResult = await runBackendCheck(true);

    expect(webgpuResult.backend).toBe('webgpu');
    expect(webglResult.backend).toBe('webgl2');
    expect(webgpuResult.phase2Reached).toBe(true);
    expect(webglResult.phase2Reached).toBe(true);
    expect(webgpuResult.canvasSize).toEqual(webglResult.canvasSize);
  });

  test('T4-03: Keyboard + Mouse Full Combat & Mechanics Suite', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // 1. WASD movement + mouse orbit
    const startSnap = await getDebugState(page);
    await holdKey(page, 'KeyW', 220);
    await holdKey(page, 'KeyD', 180);
    const movedSnap = await getDebugState(page);
    expect(
      distanceXZ(startSnap.player.position, movedSnap.player.position),
    ).toBeGreaterThan(0.2);
    await orbitCameraDrag(page, 180, -30, 8);
    await waitForRafFrames(page, 3);

    // 2. 4-hit LMB/J combo
    await moveIntoMeleeRange(page, 3.0);
    const preCombo = await getDebugState(page);
    for (let hit = 0; hit < 4; hit += 1) {
      await triggerBasicAttack(page, hit % 2 === 0 ? 'LMB' : 'KeyJ');
      await page.waitForTimeout(260);
    }
    const postCombo = await getDebugState(page);
    expect(postCombo.boss.hp).toBeLessThan(preCombo.boss.hp);

    // 3. Skills 1/2/3 independent cooldowns & damage
    await debugReadyAllSkills(page);
    await moveIntoMeleeRange(page, 3.4);

    // Skill 1 deals damage and enters cooldown (immediate second press deals no skill hit) while Skill 2 stays ready
    const beforeS1 = await getDebugState(page);
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      ({ prevHp, minDmg, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill1 > 0 &&
            s.player.skillCooldowns.skill1 <= cdMax - 0.42 &&
            prevHp - s.boss.hp >= minDmg,
        );
      },
      {
        prevHp: beforeS1.boss.hp,
        minDmg: COMBAT_TUNING.skill1TotalDamage,
        cdMax: COMBAT_TUNING.skill1CooldownSeconds,
      },
      { timeout: 3_000 },
    );
    const afterS1 = await getDebugState(page);
    expect(afterS1.boss.hp).toBeLessThan(beforeS1.boss.hp);

    await page.keyboard.press('Digit1');
    await page.waitForTimeout(200);
    const afterS1CooldownPress = await getDebugState(page);
    expect(afterS1CooldownPress.boss.hp).toBe(afterS1.boss.hp);

    // Skill 2 still executes independently while Skill 1 is on cooldown
    await moveIntoMeleeRange(page, 3.4);
    const beforeS2 = await getDebugState(page);
    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      ({ prevHp, minDmg, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill2 > 0 &&
            s.player.skillCooldowns.skill2 <= cdMax - 0.45 &&
            prevHp - s.boss.hp >= minDmg,
        );
      },
      {
        prevHp: beforeS2.boss.hp,
        minDmg: COMBAT_TUNING.skill2Damage,
        cdMax: COMBAT_TUNING.skill2CooldownSeconds,
      },
      { timeout: 3_000 },
    );
    const afterS2 = await getDebugState(page);
    expect(afterS2.boss.hp).toBeLessThan(beforeS2.boss.hp);

    await page.keyboard.press('Digit2');
    await page.waitForTimeout(200);
    const afterS2CooldownPress = await getDebugState(page);
    expect(afterS2CooldownPress.boss.hp).toBe(afterS2.boss.hp);

    // Skill 3 executes independently while Skills 1 & 2 are on cooldown
    await ensureQiForSkill3(page);
    await moveIntoMeleeRange(page, 4.0);
    const beforeS3 = await getDebugState(page);
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
    const afterS3 = await getDebugState(page);
    expect(afterS3.boss.hp).toBeLessThan(beforeS3.boss.hp);

    // 4. Space / Shift dodge & Perfect Dodge Bullet-Time
    await page.keyboard.press('ShiftLeft');
    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().player.isDodging),
      undefined,
      { timeout: 2_000 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === false,
      undefined,
      { timeout: 3_000 },
    );
    const { before: preDodge, after: postDodge } = await performPerfectDodge(
      page,
      'abyssal_sweep',
    );
    expect(postDodge.bulletTimeActive).toBe(true);
    expect(postDodge.stats.perfectDodges).toBeGreaterThan(
      preDodge.stats.perfectDodges,
    );

    // Wait for bullet time to settle, then test Skill 2 Posture Break (1.6x stagger)
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && !s.player.isDodging && !s.bulletTimeActive);
      },
      undefined,
      { timeout: 5_000 },
    );
    await debugReadyAllSkills(page);
    await moveIntoMeleeRange(page, 3.2);
    await debugSetBossPosture(page, 10);
    await page.keyboard.press('Digit2');

    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().boss.staggered),
      undefined,
      { timeout: 4_000 },
    );
    const brokenSnap = await getDebugState(page);
    expect(brokenSnap.boss.staggered).toBe(true);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.toUpperCase()).toContain('POSTURE BROKEN');

    // Wait deterministically for Skill 2's 0.42s (+85ms hitstop) recovery to finish before basic attack follow-up
    await page.waitForFunction(
      (maxCd) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.boss.staggered &&
            s.player.skillCooldowns.skill2 <= maxCd - 0.45 &&
            s.player.activeClip !== 'Sword_Heavy_Combo',
        );
      },
      COMBAT_TUNING.skill2CooldownSeconds,
      { timeout: 3_000 },
    );

    // Verify 1.6x stagger damage & Azure Jade Shield / sustain healing
    const beforeStaggerHit = await getDebugState(page);
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForFunction(
      ({ prevHp, minDmg }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && prevHp - s.boss.hp >= minDmg);
      },
      {
        prevHp: beforeStaggerHit.boss.hp,
        minDmg: COMBAT_TUNING.comboSteps[0].damage * 1.5,
      },
      { timeout: 3_000 },
    );
    const afterStaggerHit = await getDebugState(page);
    const staggerDelta = beforeStaggerHit.boss.hp - afterStaggerHit.boss.hp;
    expect(staggerDelta).toBeGreaterThanOrEqual(
      COMBAT_TUNING.comboSteps[0].damage * 1.5,
    );

    // Absorb enough hits to break Shield to 0 and drop HP below maxHp, then heal via Skill 3
    const preHit = await getDebugState(page);
    for (let i = 0; i < 4; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
      const cur = await getDebugState(page);
      if (cur.player.shield === 0 && cur.player.hp < cur.player.maxHp) {
        break;
      }
    }
    const postHit = await getDebugState(page);
    expect(postHit.stats.damageTaken).toBeGreaterThan(preHit.stats.damageTaken);
    expect(postHit.player.shield).toBe(0);
    expect(postHit.player.hp).toBeLessThan(postHit.player.maxHp);

    await debugReadyAllSkills(page);
    await moveIntoMeleeRange(page, 4.0);
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
    const postHeal = await getDebugState(page);
    expect(postHeal.player.hp).toBeGreaterThan(postHit.player.hp);
    expect(postHeal.player.shield).toBe(COMBAT_TUNING.playerMaxShield);
    guards.assertClean(postHeal);
  });

  test('T4-04: Audio & 100% English DOM Audit', async ({ page }) => {
    test.setTimeout(120_000);
    const { guards, snapshot: titleSnap } = await launchGame(page, {
      testMode: true,
    });

    // TITLE
    expect(titleSnap.phase).toBe('TITLE');
    await assertNoCjkInDom(page);

    // Click BEGIN TRIAL -> unlocks audio & enters CINEMATIC_INTRO
    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return s !== undefined && s.phase !== 'TITLE' && s.audio.unlocked === true;
      },
      undefined,
      { timeout: 10_000 },
    );
    const introSnap = await getDebugState(page);
    expect(introSnap.audio.unlocked).toBe(true);
    await assertNoCjkInDom(page);
    if (introSnap.phase === 'CINEMATIC_INTRO') {
      await debugSkipCinematic(page);
    }

    // PHASE_1 + SFX on attack/dodge + mute toggle
    const p1Snap = await waitForPhase(page, 'PHASE_1', 15_000);
    expect(p1Snap.audio.unlocked).toBe(true);
    await assertNoCjkInDom(page);

    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);

    // PAUSED
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().paused),
      undefined,
      { timeout: 8_000 },
    );
    const pausedSnap = await getDebugState(page);
    expect(pausedSnap.paused).toBe(true);
    await assertNoCjkInDom(page);
    expect(pausedSnap.audio.muted).toBe(false);
    await page
      .getByRole('button', { name: UI_COPY.PAUSE_MUTE, exact: true })
      .click();
    await waitForRafFrames(page, 2);
    const mutedSnap = await getDebugState(page);
    expect(mutedSnap.audio.muted).toBe(true);
    await page
      .getByRole('button', { name: UI_COPY.PAUSE_UNMUTE, exact: true })
      .click();
    await waitForRafFrames(page, 2);
    expect((await getDebugState(page)).audio.muted).toBe(false);

    // Resume to PHASE_1
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 8_000 },
    );

    // CINEMATIC_TRANSITION -> PHASE_2 (set strictly above 55% so real attack crosses threshold)
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold + 200);
    await debugSetPlayerDamageMultiplier(page, 4);
    try {
      await moveIntoMeleeRange(page, 3.2);
      await triggerBasicAttack(page, 'KeyJ');
      await waitForRafFrames(page, 4);
      if ((await getDebugState(page)).phase === 'PHASE_1') {
        await triggerBasicAttack(page, 'KeyJ');
      }
      await page.waitForFunction(
        () => {
          const p = window.__GAME_DEBUG__?.getState().phase;
          return p === 'CINEMATIC_TRANSITION' || p === 'PHASE_2';
        },
        undefined,
        { timeout: 10_000 },
      );
      const transSnap = await getDebugState(page);
      await assertNoCjkInDom(page);
      if (transSnap.phase === 'CINEMATIC_TRANSITION') {
        await debugSkipCinematic(page);
      }
    } finally {
      await debugSetPlayerDamageMultiplier(page, 1);
    }
    const p2Snap = await waitForPhase(page, 'PHASE_2', 15_000);
    await assertNoCjkInDom(page);
    expect(p2Snap.audio.activeBgmState).not.toBe('');

    // CINEMATIC_FINISHER -> VICTORY
    await debugSetBossHp(page, 20);
    await debugSetPlayerDamageMultiplier(page, 5);
    try {
      await moveIntoMeleeRange(page, 3.2);
      await triggerBasicAttack(page, 'KeyJ');
      await page.waitForFunction(
        () => {
          const p = window.__GAME_DEBUG__?.getState().phase;
          return p === 'CINEMATIC_FINISHER' || p === 'VICTORY';
        },
        undefined,
        { timeout: 10_000 },
      );
      const finSnap = await getDebugState(page);
      await assertNoCjkInDom(page);
      if (finSnap.phase === 'CINEMATIC_FINISHER') {
        await debugSkipCinematic(page);
      }
    } finally {
      await debugSetPlayerDamageMultiplier(page, 1);
    }
    const vicSnap = await waitForPhase(page, 'VICTORY', 15_000);
    await assertNoCjkInDom(page);
    expect(vicSnap.audio.errorCount).toBe(0);
    guards.assertClean(vicSnap);
  });

  test('T4-05: OpenMotion Isolation & Offline Local Asset Audit', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    assertOpenMotionBaselineClean();

    const guards = attachRuntimeGuards(page);
    await page.goto('/?testMode=1', { waitUntil: 'domcontentloaded' });
    const titleSnap = await waitForGameReady(page, 30_000);

    expect(titleSnap.player.modelType).toBe('glb');
    expect(titleSnap.boss.modelType).toBe('glb');
    expect(guards.externalRequests).toEqual([]);
    expect(guards.badStatusResponses).toEqual([]);
    expect(guards.failedRequests).toEqual([]);

    await enterCombat(page, { skipIntro: true });
    await advancePhase1ToPhase2(page);
    const vicSnap = await finishPhase2ToVictory(page);

    expect(guards.externalRequests).toEqual([]);
    expect(guards.badStatusResponses).toEqual([]);
    expect(guards.failedRequests).toEqual([]);
    expect(guards.assetRequestUrls.length).toBeGreaterThan(0);

    // Ensure every loaded /assets/* path returned 2xx
    for (const [assetPath, statuses] of guards.assetResponseMap.entries()) {
      for (const status of statuses) {
        expect(status, `Asset ${assetPath} returned ${status}`).toBeLessThan(
          400,
        );
      }
    }
    expect(ALL_EXPECTED_ASSETS.length).toBeGreaterThan(20);

    guards.assertClean(vicSnap);
    assertOpenMotionBaselineClean();
  });

  test('T4-06: Casual Low-Difficulty Pacing & Lotus Ward Comeback Run', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Absorb repeated Boss attacks and verify gentle damage & shield absorption
    const { before: b1, after: a1 } = await takeBossHit(
      page,
      'shattered_earth_slam',
    );
    const firstHitDelta = a1.stats.damageTaken - b1.stats.damageTaken;
    expect(firstHitDelta).toBeGreaterThanOrEqual(40);
    expect(firstHitDelta).toBeLessThanOrEqual(160);
    expect(a1.player.shield).toBeLessThan(b1.player.shield);

    // Wait briefly to verify Azure Jade Shield starts recharging when unhit
    await page.waitForTimeout(2_500);
    const rechargedSnap = await getDebugState(page);
    expect(rechargedSnap.player.shield).toBeGreaterThanOrEqual(a1.player.shield);

    // Keep absorbing attacks until Immortal Lotus Ward activates (prevents defeat at 0 HP)
    let current = rechargedSnap;
    let lotusReviveDetected = false;
    let attempts = 0;
    while (!lotusReviveDetected && attempts < 22) {
      attempts += 1;
      const prevHp = current.player.hp;
      await takeBossHit(page, 'shattered_earth_slam');
      current = await getDebugState(page);
      const wardTextVisible = await page
        .getByText(UI_COPY.CALLOUT_LOTUS_WARD)
        .first()
        .isVisible()
        .catch(() => false);
      if (
        (prevHp <= 220 && current.player.hp > prevHp) ||
        current.audio.lastSfx === 'lotus_ward' ||
        wardTextVisible
      ) {
        lotusReviveDetected = true;
      }
      expect(current.player.hp).toBeGreaterThan(0);
      expect(current.phase).toBe('PHASE_1');
    }
    expect(lotusReviveDetected).toBe(true);
    expect(current.player.hp).toBeGreaterThan(0);
    expect(current.phase).toBe('PHASE_1');

    // Recover via combo-4, Perfect Dodge, and Skill-3 healing
    const hpBeforeRecover = current.player.hp;
    await performPerfectDodge(page, 'abyssal_sweep');
    await page.waitForTimeout(850);
    await debugReadyAllSkills(page);
    await ensureQiForSkill3(page);
    await moveIntoMeleeRange(page, 3.2);
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
    for (let i = 0; i < 4; i += 1) {
      await triggerBasicAttack(page, 'KeyJ');
      await page.waitForTimeout(240);
    }

    const hpAfterRecover = await getDebugState(page);
    expect(hpAfterRecover.player.hp).toBeGreaterThan(hpBeforeRecover);

    // Complete Phase 1 -> Phase 2 -> Victory and assert SSS rank
    await advancePhase1ToPhase2(page);
    const victorySnap = await finishPhase2ToVictory(page);
    expect(victorySnap.phase).toBe('VICTORY');
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain('SSS');
    guards.assertClean(victorySnap);
  });

  test('T4-07: Pointer-Lock-Denied / Trackpad & J-Key Playability Scenario', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestPointerLock', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Pointer lock denied', 'NotAllowedError')),
      });
    });

    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Play strictly via WASD, KeyJ, Space, 1/2/3, and mouse-drag orbit (no pointer lock)
    await holdKey(page, 'KeyW', 200);
    await orbitCameraDrag(page, 140, -20, 6);
    await moveIntoMeleeRange(page, 3.2);

    const beforeAttack = await getDebugState(page);
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.boss.hp < prevHp);
      },
      beforeAttack.boss.hp,
      { timeout: 3_000 },
    );
    const afterFirstBasic = await getDebugState(page);
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForFunction(
      (prevHp) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.boss.hp < prevHp);
      },
      afterFirstBasic.boss.hp,
      { timeout: 3_000 },
    );
    const afterBasic = await getDebugState(page);
    expect(afterBasic.boss.hp).toBeLessThan(beforeAttack.boss.hp);

    await moveIntoMeleeRange(page, 4.0);
    const beforeS1 = await getDebugState(page);
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      ({ prevHp, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.boss.hp < prevHp &&
            s.player.skillCooldowns.skill1 > 0 &&
            s.player.skillCooldowns.skill1 <= cdMax - 0.42,
        );
      },
      { prevHp: beforeS1.boss.hp, cdMax: COMBAT_TUNING.skill1CooldownSeconds },
      { timeout: 3_000 },
    );
    const afterS1 = await getDebugState(page);
    expect(afterS1.boss.hp).toBeLessThan(beforeS1.boss.hp);

    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().player.isDodging),
      undefined,
      { timeout: 2_000 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === false,
      undefined,
      { timeout: 3_000 },
    );
    await moveIntoMeleeRange(page, 3.4);
    const beforeS2 = await getDebugState(page);
    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      ({ prevHp, cdMax }) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.boss.hp < prevHp &&
            s.player.skillCooldowns.skill2 > 0 &&
            s.player.skillCooldowns.skill2 <= cdMax - 0.45,
        );
      },
      { prevHp: beforeS2.boss.hp, cdMax: COMBAT_TUNING.skill2CooldownSeconds },
      { timeout: 3_000 },
    );
    const afterS2 = await getDebugState(page);
    expect(afterS2.boss.hp).toBeLessThan(beforeS2.boss.hp);

    await ensureQiForSkill3(page);
    await moveIntoMeleeRange(page, 4.0);
    const beforeS3 = await getDebugState(page);
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

    const afterCombat = await getDebugState(page);
    expect(afterCombat.boss.hp).toBeLessThan(beforeS3.boss.hp);

    await advancePhase1ToPhase2(page);
    const vicSnap = await finishPhase2ToVictory(page);
    expect(vicSnap.phase).toBe('VICTORY');
    guards.assertClean(vicSnap);
  });

  test('T4-08: Pause, Window Resize & Rapid Replay Endurance Scenario', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { guards } = await launchGame(page, { testMode: true });

    for (let run = 1; run <= 2; run += 1) {
      await enterCombat(page, { skipIntro: true });

      // Mid-combat Pause -> Mute/Unmute -> Resize 1280x720 <-> 1920x1080 -> Resume
      await moveIntoMeleeRange(page, 3.4);
      await triggerBasicAttack(page, 'KeyJ');
      await page.waitForTimeout(200);

      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => Boolean(window.__GAME_DEBUG__?.getState().paused),
        undefined,
        { timeout: 8_000 },
      );
      const paused = await getDebugState(page);
      expect(paused.audio.muted).toBe(false);
      await page
        .getByRole('button', { name: UI_COPY.PAUSE_MUTE, exact: true })
        .click();
      await waitForRafFrames(page, 2);
      expect((await getDebugState(page)).audio.muted).toBe(true);
      await page
        .getByRole('button', { name: UI_COPY.PAUSE_UNMUTE, exact: true })
        .click();
      await waitForRafFrames(page, 2);
      expect((await getDebugState(page)).audio.muted).toBe(false);

      await page.setViewportSize({ width: 1920, height: 1080 });
      await waitForRafFrames(page, 4);
      const largeCanvas = await assertCanvasRendered(page);
      expect(largeCanvas.width).toBeGreaterThanOrEqual(1900);

      await page.setViewportSize({ width: 1280, height: 720 });
      await waitForRafFrames(page, 4);
      const standardCanvas = await assertCanvasRendered(page);
      expect(standardCanvas.width).toBeLessThanOrEqual(1290);

      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => window.__GAME_DEBUG__?.getState().paused === false,
        undefined,
        { timeout: 8_000 },
      );

      await advancePhase1ToPhase2(page);
      const vicSnap = await finishPhase2ToVictory(page);
      expect(vicSnap.phase).toBe('VICTORY');

      // Click PLAY AGAIN and verify clean state reset
      const replayBtn = page.getByRole('button', { name: /play again/i });
      await expect(replayBtn).toBeVisible({ timeout: 10_000 });
      await replayBtn.click();

      await page.waitForFunction(
        () => {
          const s = window.__GAME_DEBUG__?.getState();
          return (
            s !== undefined &&
            (s.phase === 'TITLE' ||
              s.phase === 'CINEMATIC_INTRO' ||
              s.phase === 'PHASE_1') &&
            s.boss.hp === s.boss.maxHp &&
            s.player.hp === s.player.maxHp &&
            s.stats.damageTaken === 0
          );
        },
        undefined,
        { timeout: 15_000 },
      );

      // If replay lands on CINEMATIC_INTRO or PHASE_1 instead of TITLE, skip/return cleanly for run 2
      const postReplay = await getDebugState(page);
      expect(postReplay.boss.hp).toBe(postReplay.boss.maxHp);
      expect(postReplay.stats.damageTaken).toBe(0);
      if (run === 1 && postReplay.phase !== 'TITLE') {
        // Reload to ensure enterCombat works cleanly if replay jumps directly to intro/combat
        await page.goto('/?testMode=1', { waitUntil: 'domcontentloaded' });
        await waitForGameReady(page, 30_000);
      }
      guards.assertClean(postReplay);
    }
  });
});
