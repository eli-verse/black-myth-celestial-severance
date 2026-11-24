import { expect, test } from '@playwright/test';
import {
  ALL_EXPECTED_ASSETS,
  assertCanvasRendered,
  assertNoCjkInDom,
  assertOpenMotionBaselineClean,
  clickCanvasCenter,
  COMBAT_TUNING,
  debugReadyAllSkills,
  debugSetBossHp,
  debugSetBossPosture,
  debugSetPlayerDamageMultiplier,
  debugSkipCinematic,
  debugTriggerBossTestAttack,
  distanceXZ,
  enterCombat,
  getDebugState,
  getOpenMotionGitStatusLines,
  holdKey,
  launchGame,
  moveIntoMeleeRange,
  OPENMOTION_STEP0_STATUS_LINES,
  orbitCameraDrag,
  performPerfectDodge,
  radiusXZ,
  rectsOverlap,
  takeBossHit,
  UI_COPY,
  waitForGameReady,
  waitForPhase,
  waitForRafFrames,
} from './helpers/gameHarness.ts';

test.describe('Tier 2 — F1 Boundaries: Isolation & Assets', () => {
  test('T2-F1-01 Reloading page with browser cache disabled triggers zero 404s', async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const { guards } = await launchGame(page, { testMode: true });
    guards.resetRecordedNetwork();

    await page.reload({ waitUntil: 'domcontentloaded' });
    const snapshot = await waitForGameReady(page);

    for (const assetPath of ALL_EXPECTED_ASSETS) {
      const statuses = guards.assetResponseMap.get(assetPath);
      expect(statuses, `Expected 200 on uncached reload for ${assetPath}`).toContain(
        200,
      );
      expect(statuses!.every((s) => s === 200)).toBe(true);
    }
    guards.assertClean(snapshot);
  });

  test('T2-F1-02 Rapid consecutive reloads (3x) produce zero failed asset fetches', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    for (let i = 0; i < 3; i += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const snap = await waitForGameReady(page);
      expect(snap.player.modelType).toBe('glb');
      expect(snap.boss.modelType).toBe('glb');
    }
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F1-03 Query params (?forceWebGL=1&testMode=1&trial=check) never corrupt relative asset URLs', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, {
      forceWebGL: true,
      testMode: true,
      extraParams: { trial: 'check' },
    });
    expect(snapshot.rendererBackend).toBe('webgl2');
    for (const reqUrl of guards.assetRequestUrls) {
      const parsed = new URL(reqUrl);
      expect(parsed.pathname.startsWith('/assets/')).toBe(true);
      expect(parsed.search).toBe('');
    }
    for (const assetPath of ALL_EXPECTED_ASSETS) {
      expect(guards.assetResponseMap.get(assetPath)).toContain(200);
    }
    guards.assertClean(snapshot);
  });

  test('T2-F1-04 Hash and sub-path navigation still resolve local /assets/... cleanly', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, {
      testMode: true,
      hash: 'act1-check',
    });
    for (const assetPath of ALL_EXPECTED_ASSETS) {
      expect(guards.assetResponseMap.get(assetPath)).toContain(200);
    }
    guards.assertClean(snapshot);

    guards.resetRecordedNetwork();
    await page.goto('/arena/subpath?testMode=1', { waitUntil: 'domcontentloaded' });
    const subSnap = await waitForGameReady(page);
    for (const reqUrl of guards.assetRequestUrls) {
      expect(new URL(reqUrl).pathname.startsWith('/assets/')).toBe(true);
    }
    guards.assertClean(subSnap);
  });

  test('T2-F1-05 OpenMotion repo has zero newly modified or untracked files during E2E run', async ({
    page,
  }) => {
    const before = getOpenMotionGitStatusLines();
    expect(before).toEqual([...OPENMOTION_STEP0_STATUS_LINES]);

    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await page.keyboard.press('KeyJ');
    await waitForRafFrames(page, 4);
    guards.assertClean(await getDebugState(page));

    const after = getOpenMotionGitStatusLines();
    expect(after).toEqual(before);
    assertOpenMotionBaselineClean();
  });
});

test.describe('Tier 2 — F2 Boundaries: Renderer & WebGL2', () => {
  test('T2-F2-01 ?forceWebGL=1 renders full combat, skills, and Phase 2 transition without WebGPU', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, {
      forceWebGL: true,
      testMode: true,
    });
    const combat = await enterCombat(page, { skipIntro: true });
    expect(combat.rendererBackend).toBe('webgl2');

    await moveIntoMeleeRange(page, 3.4);
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(400);
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    await assertCanvasRendered(page);
    guards.assertClean(p2);
  });

  test('T2-F2-02 Extreme window resize (800x600 -> 2560x1440 -> 1280x720) preserves valid canvas', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    for (const size of [
      { width: 800, height: 600 },
      { width: 2560, height: 1440 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(size);
      await waitForRafFrames(page, 4);
      const box = await assertCanvasRendered(page);
      expect(box.width).toBeGreaterThanOrEqual(size.width - 20);
      expect(box.height).toBeGreaterThanOrEqual(size.height - 20);
    }
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F2-03 Rapid resize bursts during active combat produce 0 GPU device lost errors', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    const sizes = [
      { width: 1024, height: 640 },
      { width: 1600, height: 900 },
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ];
    for (const s of sizes) {
      await page.setViewportSize(s);
      await page.keyboard.press('KeyJ');
      await waitForRafFrames(page, 2);
    }
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F2-04 Tab visibility hide/show clamps frame dt without physics teleportation', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });

    const bgTab = await page.context().newPage();
    await bgTab.bringToFront();
    await page.waitForTimeout(900);
    await page.bringToFront();
    await bgTab.close();
    await waitForRafFrames(page, 4);

    const after = await getDebugState(page);
    expect(distanceXZ(before.player.position, after.player.position)).toBeLessThan(
      2.0,
    );
    expect(Number.isFinite(after.player.position[0])).toBe(true);
    expect(Number.isFinite(after.player.position[2])).toBe(true);
    guards.assertClean(after);
  });

  test('T2-F2-05 Frame loop stays responsive across Phase 1 -> Phase 2 -> Replay transitions', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const p1 = await enterCombat(page, { skipIntro: true });
    await page.waitForTimeout(300);
    const p1Later = await getDebugState(page);
    expect(p1Later.elapsedCombatSeconds).toBeGreaterThan(p1.elapsedCombatSeconds);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY', 5_000);

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
    const replayP1 = await waitForPhase(page, 'PHASE_1', 5_000);
    await waitForRafFrames(page, 4);
    guards.assertClean(replayP1);
  });
});

test.describe('Tier 2 — F3 Boundaries: Rigged .glb & Clips', () => {
  test('T2-F3-01 Rapidly alternating W -> J -> Space -> 1 never leaves activeClip empty/undefined', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await holdKey(page, 'KeyW', 150);
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);
    await page.keyboard.press('KeyJ');
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);
    await page.keyboard.press('Space');
    expect((await getDebugState(page)).player.activeClip.length).toBeGreaterThan(0);
    await page.keyboard.press('Digit1');
    const after = await getDebugState(page);
    expect(after.player.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(after);
  });

  test('T2-F3-02 Boss activeClip recovers cleanly after Stagger ends', async ({
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
    const staggerClip = (await getDebugState(page)).boss.activeClip;
    expect(staggerClip.length).toBeGreaterThan(0);

    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === false,
      undefined,
      { timeout: 8_000 },
    );
    const recovered = await getDebugState(page);
    expect(recovered.boss.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(recovered);
  });

  test('T2-F3-03 Player and Boss modelType remains glb after Replay', async ({
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

    await page.getByRole('button', { name: UI_COPY.VICTORY_REPLAY_CTA }).click();
    await page.waitForFunction(
      () => {
        const p = window.__GAME_DEBUG__?.getState().phase;
        return p === 'CINEMATIC_INTRO' || p === 'PHASE_1';
      },
      undefined,
      { timeout: 5_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.player.modelType).toBe('glb');
    expect(snap.boss.modelType).toBe('glb');
    expect(snap.player.activeClip.length).toBeGreaterThan(0);
    expect(snap.boss.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(snap);
  });

  test('T2-F3-04 Finisher death clip plays cleanly without snapping back to idle', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, 0);
    const finisherStart = await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    const deathClip = finisherStart.boss.activeClip;
    expect(deathClip.length).toBeGreaterThan(0);

    await page.waitForTimeout(1_200);
    const midFinisher = await getDebugState(page);
    if (midFinisher.phase === 'CINEMATIC_FINISHER') {
      expect(midFinisher.boss.activeClip).toBe(deathClip);
    }
    guards.assertClean(midFinisher);
  });

  test('T2-F3-05 No missing bone or detachment errors logged during Skill 3 camera cut', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
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
    const after = await getDebugState(page);
    expect(after.player.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(after);
  });
});

test.describe('Tier 2 — F4 Boundaries: Arena Clamp & Separation', () => {
  test('T2-F4-01 Holding W continuously toward edge clamps player strictly at R <= 25.05m', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await holdKey(page, 'KeyW', 3_500);
    const snap = await getDebugState(page);
    expect(radiusXZ(snap.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.05,
    );
    guards.assertClean(snap);
  });

  test('T2-F4-02 Holding A/D along perimeter slides smoothly along R <= 25.05m without escaping', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await holdKey(page, 'KeyS', 3_000);
    const atRim = await getDebugState(page);
    await holdKey(page, 'KeyD', 1_200);
    const slid = await getDebugState(page);
    expect(radiusXZ(slid.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.05,
    );
    expect(distanceXZ(atRim.player.position, slid.player.position)).toBeGreaterThan(
      1.0,
    );
    guards.assertClean(slid);
  });

  test('T2-F4-03 Using Skill 1 Phantom Dash near arena edge never teleports outside R = 25.05m', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyS', 2_800);
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(500);
    const snap = await getDebugState(page);
    expect(radiusXZ(snap.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.05,
    );
    guards.assertClean(snap);
  });

  test('T2-F4-04 Running directly into Boss maintains soft separation (>= 1.2m)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 2.5);
    await holdKey(page, 'KeyW', 800);
    const snap = await getDebugState(page);
    expect(distanceXZ(snap.player.position, snap.boss.position)).toBeGreaterThanOrEqual(
      1.2,
    );
    guards.assertClean(snap);
  });

  test('T2-F4-05 Replay resets player and Boss back to clean arena start positions inside R <= 25m', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyA', 1_200);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);
    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY', 5_000);

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
    const replay = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(radiusXZ(replay.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius,
    );
    expect(radiusXZ(replay.boss.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius,
    );
    expect(distanceXZ(replay.player.position, start.player.position)).toBeLessThan(
      3.0,
    );
    guards.assertClean(replay);
  });
});

test.describe('Tier 2 — F5 Boundaries: TSL VFX & Atmosphere', () => {
  test('T2-F5-01 Spawning 12 rapid slashes + skills does not exhaust particle/ribbon pools or throw', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);

    for (let i = 0; i < 3; i += 1) {
      await debugReadyAllSkills(page);
      await page.keyboard.press('Digit1');
      await page.waitForTimeout(150);
      await page.keyboard.press('Digit2');
      await page.waitForTimeout(150);
      await page.keyboard.press('KeyJ');
      await page.keyboard.press('KeyJ');
      await page.keyboard.press('KeyJ');
      await page.keyboard.press('KeyJ');
    }
    await waitForRafFrames(page, 4);
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F5-02 Phase transition at 55% triggers Act II shift once (idempotent)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold - 2_000);
    await page.waitForTimeout(400);
    const snap = await getDebugState(page);
    expect(snap.phase).toBe('PHASE_2');
    guards.assertClean(snap);
  });

  test('T2-F5-03 Telegraph indicators clear immediately if Boss is staggered mid-windup', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugTriggerBossTestAttack(page, 'shattered_earth_slam');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.attackTelegraphActive === true,
      undefined,
      { timeout: 2_500 },
    );

    await debugSetBossPosture(page, 0);
    await page.waitForFunction(
      () => {
        const b = window.__GAME_DEBUG__?.getState().boss;
        return Boolean(b && b.staggered && !b.attackTelegraphActive);
      },
      undefined,
      { timeout: 2_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.boss.attackTelegraphActive).toBe(false);
    guards.assertClean(snap);
  });

  test('T2-F5-04 Telegraph indicators clear immediately on Boss HP reaching 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugTriggerBossTestAttack(page, 'cataclysmic_leap_slam');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.attackTelegraphActive === true,
      undefined,
      { timeout: 2_500 },
    );

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    const snap = await getDebugState(page);
    expect(snap.boss.attackTelegraphActive).toBe(false);
    guards.assertClean(snap);
  });

  test('T2-F5-05 Replay resets arena atmosphere cleanly back to Act I', async ({
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
    const act1 = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(act1.audio.activeBgmState).toBe('phase1');
    guards.assertClean(act1);
  });
});

test.describe('Tier 2 — F6 Boundaries: State Machine Guards', () => {
  test('T2-F6-01 Massive single hit crossing 55% clamps Boss HP at 22,000 and enters CINEMATIC_TRANSITION', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossHp(page, 22_300);
    await debugSetPlayerDamageMultiplier(page, 10);

    await page.keyboard.press('Digit2');
    const transition = await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    expect(transition.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    await debugSkipCinematic(page);
    const phase2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(phase2.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    guards.assertClean(phase2);
  });

  test('T2-F6-02 Killing Boss in PHASE_2 enters CINEMATIC_FINISHER once and ignores further hits', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossHp(page, 200);
    await page.keyboard.press('Digit2');
    const finisher = await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    expect(finisher.boss.hp).toBe(0);
    expect(finisher.boss.invulnerable).toBe(true);

    const dmgAtFinisher = finisher.stats.totalDamageDealt;
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(200);
    const after = await getDebugState(page);
    expect(after.boss.hp).toBe(0);
    expect(after.stats.totalDamageDealt).toBe(dmgAtFinisher);
    guards.assertClean(after);
  });

  test('T2-F6-03 Attack/skill keys during TITLE, CINEMATIC_INTRO, or CINEMATIC_TRANSITION deal no damage', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.keyboard.press('KeyJ');
    await page.keyboard.press('Digit1');
    const titleSnap = await getDebugState(page);
    expect(titleSnap.phase).toBe('TITLE');
    expect(titleSnap.stats.totalDamageDealt).toBe(0);

    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();
    await waitForPhase(page, 'CINEMATIC_INTRO', 5_000);
    await page.keyboard.press('Digit2');
    await page.keyboard.press('KeyJ');
    const introSnap = await getDebugState(page);
    expect(introSnap.stats.totalDamageDealt).toBe(0);
    expect(introSnap.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);

    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_1', 5_000);
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    const beforeTransAttacks = (await getDebugState(page)).boss.hp;
    await page.keyboard.press('Digit3');
    await page.keyboard.press('KeyJ');
    const transSnap = await getDebugState(page);
    expect(transSnap.boss.hp).toBe(beforeTransAttacks);
    expect(transSnap.skill3Active).toBe(false);
    guards.assertClean(transSnap);
  });

  test('T2-F6-04 Boss cannot die directly from PHASE_1 skipping PHASE_2', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugSetBossHp(page, 0);
    const transition = await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    expect(transition.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(p2.boss.hp).toBe(COMBAT_TUNING.bossPhase2HpThreshold);
    guards.assertClean(p2);
  });

  test('T2-F6-05 Clicking PLAY AGAIN resets elapsedCombatSeconds, stats, and phase', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.4);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(350);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);
    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY', 5_000);

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
    const fresh = await waitForPhase(page, 'PHASE_1', 5_000);
    expect(fresh.elapsedCombatSeconds).toBeLessThan(2.0);
    expect(fresh.stats.totalDamageDealt).toBe(0);
    expect(fresh.stats.perfectDodges).toBe(0);
    expect(fresh.stats.postureBreaks).toBe(0);
    expect(fresh.stats.maxCombo).toBe(0);
    guards.assertClean(fresh);
  });
});

test.describe('Tier 2 — F7 Boundaries: Input & Pointer Lock Fallback', () => {
  test('T2-F7-01 When pointer lock is denied, WASD, Space, J, and 1/2/3 still work 100%', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      HTMLElement.prototype.requestPointerLock = () =>
        Promise.reject(new DOMException('Pointer lock denied', 'NotAllowedError'));
    });

    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    await clickCanvasCenter(page);
    // Un-dragged LMB click starts combo1 (0.32s movement lock); wait for it to finish cleanly
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) === 1,
      undefined,
      { timeout: 1_500 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.comboStep === 0,
      undefined,
      { timeout: 2_000 },
    );

    await holdKey(page, 'KeyW', 300);
    const moved = await getDebugState(page);
    expect(distanceXZ(start.player.position, moved.player.position)).toBeGreaterThan(
      0.5,
    );

    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      (prevHp) => (window.__GAME_DEBUG__?.getState().boss.hp ?? prevHp) < prevHp,
      start.boss.hp,
      { timeout: 3_000 },
    );
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F7-02 Mouse drag without pointer lock still orbits camera smoothly', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      HTMLElement.prototype.requestPointerLock = () =>
        Promise.reject(new DOMException('Denied', 'NotAllowedError'));
    });
    const { guards } = await launchGame(page, { testMode: true });
    const p0 = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyW', 200);
    const p1 = await getDebugState(page);
    await orbitCameraDrag(page, 220, 10, 8);
    await holdKey(page, 'KeyW', 200);
    const p2 = await getDebugState(page);

    const v1x = p1.player.position[0] - p0.player.position[0];
    const v1z = p1.player.position[2] - p0.player.position[2];
    const v2x = p2.player.position[0] - p1.player.position[0];
    const v2z = p2.player.position[2] - p1.player.position[2];
    const cosTheta =
      (v1x * v2x + v1z * v2z) / (Math.hypot(v1x, v1z) * Math.hypot(v2x, v2z));
    expect(cosTheta).toBeLessThan(0.95);
    guards.assertClean(p2);
  });

  test('T2-F7-03 Pressing conflicting keys W+S or A+D simultaneously cancels velocity cleanly', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });

    try {
      await page.keyboard.down('KeyW');
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(350);
    } finally {
      await page.keyboard.up('KeyW');
      await page.keyboard.up('KeyS');
    }

    const after = await getDebugState(page);
    expect(Number.isNaN(after.player.position[0])).toBe(false);
    expect(Number.isNaN(after.player.position[2])).toBe(false);
    expect(distanceXZ(before.player.position, after.player.position)).toBeLessThan(
      0.5,
    );
    guards.assertClean(after);
  });

  test('T2-F7-04 Opening Pause releases cursor control cleanly', async ({
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

    const resumeBtn = page.getByRole('button', { name: UI_COPY.PAUSE_RESUME });
    await expect(resumeBtn).toBeVisible();
    await resumeBtn.click();
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 2_500 },
    );
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F7-05 Blur and focus events during WASD input produce zero console errors or stuck keys', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    try {
      await page.keyboard.down('KeyW');
      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
      });
    } finally {
      await page.keyboard.up('KeyW');
    }

    const after = await getDebugState(page);
    expect(Number.isFinite(after.player.position[0])).toBe(true);
    guards.assertClean(after);
  });
});

test.describe('Tier 2 — F8 Boundaries: Combo Buffer & Reset', () => {
  test('T2-F8-01 Waiting > 0.7s after Hit 1 resets combo sequence back to Hit 1', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) === 1,
      undefined,
      { timeout: 2_000 },
    );

    await page.waitForTimeout(900);
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= 1,
      undefined,
      { timeout: 2_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.player.comboStep).toBe(1);
    guards.assertClean(snap);
  });

  test('T2-F8-02 Mashing J 10 times in 0.5s keeps comboStep bounded in 0..4', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('KeyJ');
      await page.waitForTimeout(45);
      const step = (await getDebugState(page)).player.comboStep;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(4);
    }
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F8-03 Attacking out of range triggers swing clip without dealing phantom damage', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Back away far outside melee range
    await holdKey(page, 'KeyS', 1_500);
    const far = await getDebugState(page);
    expect(distanceXZ(far.player.position, far.boss.position)).toBeGreaterThan(8.0);

    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(350);
    const after = await getDebugState(page);
    expect(after.boss.hp).toBe(far.boss.hp);
    expect(after.stats.totalDamageDealt).toBe(far.stats.totalDamageDealt);
    guards.assertClean(after);
  });

  test('T2-F8-04 Dodge during Hit 2 recovery cancels combo cleanly and triggers dash immediately', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(220);
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.comboStep ?? 0) >= 2,
      undefined,
      { timeout: 2_000 },
    );

    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === true,
      undefined,
      { timeout: 1_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.player.isDodging).toBe(true);
    guards.assertClean(snap);
  });

  test('T2-F8-05 Attacking during VICTORY does not mutate totalDamageDealt', async ({
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
    const vic = await waitForPhase(page, 'VICTORY', 5_000);

    await page.keyboard.press('KeyJ');
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(300);
    const after = await getDebugState(page);
    expect(after.stats.totalDamageDealt).toBe(vic.stats.totalDamageDealt);
    guards.assertClean(after);
  });
});

test.describe('Tier 2 — F9 Boundaries: Dodge Cooldown & Bullet-Time Edge', () => {
  test('T2-F9-01 Mashing Space enforces brief post-dash cooldown (dodge > 0)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        (window.__GAME_DEBUG__?.getState().player.skillCooldowns.dodge ?? 0) > 0 ||
        window.__GAME_DEBUG__?.getState().player.isDodging === true,
      undefined,
      { timeout: 1_500 },
    );
    await page.waitForTimeout(550);
    await page.keyboard.press('Space');
    const snap = await getDebugState(page);
    expect(snap.player.skillCooldowns.dodge).toBeGreaterThan(0);
    guards.assertClean(snap);
  });

  test('T2-F9-02 Dodging outside Boss attack timing does NOT award Perfect Dodge', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    await holdKey(page, 'KeyS', 1_200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const after = await getDebugState(page);
    expect(after.bulletTimeActive).toBe(false);
    expect(after.stats.perfectDodges).toBe(start.stats.perfectDodges);
    guards.assertClean(after);
  });

  test('T2-F9-03 Bullet-Time (~0.25x) expires cleanly back to timeScale === 1.0 after ~2.0s', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const { after: inBt } = await performPerfectDodge(page, 'abyssal_sweep');
    expect(inBt.bulletTimeActive).toBe(true);
    expect(inBt.timeScale).toBeLessThanOrEqual(0.3);

    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && !s.bulletTimeActive && Math.abs(s.timeScale - 1.0) < 0.05);
      },
      undefined,
      { timeout: 4_500 },
    );
    const recovered = await getDebugState(page);
    expect(recovered.bulletTimeActive).toBe(false);
    expect(recovered.timeScale).toBeCloseTo(1.0, 2);
    guards.assertClean(recovered);
  });

  test('T2-F9-04 Dodging mid-combo cancels swing cleanly and preserves invulnerable === true', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(80);
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

  test('T2-F9-05 Multiple consecutive Perfect Dodges refresh Bullet-Time without stacking timeScale below 0.25', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await performPerfectDodge(page, 'abyssal_sweep');
    await debugReadyAllSkills(page);
    const { after: second } = await performPerfectDodge(page, 'abyssal_sweep');
    expect(second.bulletTimeActive).toBe(true);
    expect(second.timeScale).toBeGreaterThanOrEqual(
      COMBAT_TUNING.bulletTimeWorldScale - 0.02,
    );
    expect(second.stats.perfectDodges).toBeGreaterThanOrEqual(2);
    guards.assertClean(second);
  });
});

test.describe('Tier 2 — F10 Boundaries: Skill Cooldowns, Qi & Mash Guard', () => {
  test('T2-F10-01 Pressing 1 while skill1 > 0 ignores cast and never produces negative CD', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.skillCooldowns.skill1 ?? 0) > 0,
      undefined,
      { timeout: 2_000 },
    );
    const mid = await getDebugState(page);
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(200);
    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill1).toBeGreaterThan(0);
    expect(after.player.skillCooldowns.skill1).toBeLessThanOrEqual(
      mid.player.skillCooldowns.skill1,
    );
    guards.assertClean(after);
  });

  test('T2-F10-02 Pressing 2 while skill2 > 0 ignores cast and never produces negative CD', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.skillCooldowns.skill2 ?? 0) > 0,
      undefined,
      { timeout: 2_000 },
    );
    const mid = await getDebugState(page);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(200);
    const after = await getDebugState(page);
    expect(after.player.skillCooldowns.skill2).toBeGreaterThan(0);
    expect(after.player.skillCooldowns.skill2).toBeLessThanOrEqual(
      mid.player.skillCooldowns.skill2,
    );
    guards.assertClean(after);
  });

  test('T2-F10-03 Pressing 3 with qi < 50 ignores cast without draining Qi or triggering time-stop', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Cast Skill 3 twice to drop Qi below 50 (100 -> 50 -> 0) without refilling Qi via debugReadyAllSkills
    const beforeFirst = await getDebugState(page);
    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      (prevQi) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            (s.skill3Active ||
              s.player.skillCooldowns.skill3 > 0 ||
              s.player.qi < prevQi),
        );
      },
      beforeFirst.player.qi,
      { timeout: 3_000 },
    );
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && !s.skill3Active && s.player.skillCooldowns.skill3 === 0,
        );
      },
      undefined,
      { timeout: 28_000 },
    );

    const beforeSecond = await getDebugState(page);
    expect(beforeSecond.player.qi).toBeGreaterThanOrEqual(
      COMBAT_TUNING.skill3QiCost,
    );
    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      (prevQi) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            (s.skill3Active ||
              s.player.skillCooldowns.skill3 > 0 ||
              s.player.qi < prevQi),
        );
      },
      beforeSecond.player.qi,
      { timeout: 3_000 },
    );
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && !s.skill3Active && s.player.skillCooldowns.skill3 === 0,
        );
      },
      undefined,
      { timeout: 28_000 },
    );

    const lowQi = await getDebugState(page);
    expect(lowQi.player.qi).toBeLessThan(COMBAT_TUNING.skill3QiCost);
    await page.keyboard.press('Digit3');
    await page.waitForTimeout(250);
    const afterDenied = await getDebugState(page);
    expect(afterDenied.skill3Active).toBe(false);
    expect(afterDenied.player.qi).toBe(lowQi.player.qi);
    guards.assertClean(afterDenied);
  });

  test('T2-F10-04 Mashing 1+2+3+Space+LMB simultaneously maintains valid state with zero NaN/negative CDs', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);

    await page.keyboard.press('Digit1');
    await page.keyboard.press('Digit2');
    await page.keyboard.press('Digit3');
    await page.keyboard.press('Space');
    await clickCanvasCenter(page);
    await page.waitForTimeout(300);

    const snap = await getDebugState(page);
    expect(snap.player.skillCooldowns.skill1).toBeGreaterThanOrEqual(0);
    expect(snap.player.skillCooldowns.skill2).toBeGreaterThanOrEqual(0);
    expect(snap.player.skillCooldowns.skill3).toBeGreaterThanOrEqual(0);
    expect(snap.player.skillCooldowns.dodge).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(snap.player.hp)).toBe(false);
    expect(Number.isNaN(snap.boss.hp)).toBe(false);
    guards.assertClean(snap);
  });

  test('T2-F10-05 Skill 3 Time-Stop (timeScale === 0) restores timeScale === 1.0 cleanly on completion', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

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
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && !s.skill3Active && Math.abs(s.timeScale - 1.0) < 0.05);
      },
      undefined,
      { timeout: 6_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.skill3Active).toBe(false);
    expect(snap.timeScale).toBeCloseTo(1.0, 2);
    guards.assertClean(snap);
  });
});

test.describe('Tier 2 — F11 Boundaries: Posture Boundaries', () => {
  test('T2-F11-01 Boss Posture never drops below 0 on massive overkill Posture hit', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossPosture(page, 50);

    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.boss.posture).toBe(0);
    expect(snap.boss.posture).toBeGreaterThanOrEqual(0);
    guards.assertClean(snap);
  });

  test('T2-F11-02 Hitting Boss while staggered === true keeps posture === 0', async ({
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

    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(250);
    const snap = await getDebugState(page);
    expect(snap.boss.staggered).toBe(true);
    expect(snap.boss.posture).toBe(0);
    guards.assertClean(snap);
  });

  test('T2-F11-03 Hitting Boss during CINEMATIC_TRANSITION invulnerability does not drain Posture', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    const trans = await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    const postureBefore = trans.boss.posture;

    await page.keyboard.press('Digit2');
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(250);
    const transAfter = await getDebugState(page);
    expect(transAfter.boss.posture).toBe(postureBefore);
    guards.assertClean(transAfter);
  });

  test('T2-F11-04 Boss recovers from stagger after ~5s and restores Posture to 1,000', async ({
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
        return Boolean(b && !b.staggered && b.posture === maxPosture);
      },
      COMBAT_TUNING.bossMaxPosture,
      { timeout: 8_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.boss.postureRatio).toBe(1.0);
    guards.assertClean(snap);
  });

  test('T2-F11-05 Second full Posture drain in PHASE_2 triggers a second POSTURE BROKEN (postureBreaks === 2)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossPosture(page, 0);
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().stats.postureBreaks === 1,
      undefined,
      { timeout: 2_500 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === false,
      undefined,
      { timeout: 8_000 },
    );

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await moveIntoMeleeRange(page, 3.6);
    await debugSetBossPosture(page, 200);
    await page.keyboard.press('Digit2');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().stats.postureBreaks === 2,
      undefined,
      { timeout: 3_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.boss.staggered).toBe(true);
    expect(snap.stats.postureBreaks).toBe(2);
    guards.assertClean(snap);
  });
});

test.describe('Tier 2 — F12 Boundaries: Sustain & Immortal Lotus Ward', () => {
  test('T2-F12-01 Taking gentle Boss hits drains shield before hp', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const { before, after } = await takeBossHit(page, 'abyssal_sweep');
    expect(after.player.shield).toBeLessThan(before.player.shield);
    expect(after.player.hp).toBe(before.player.hp);
    guards.assertClean(after);
  });

  test('T2-F12-02 Consecutive Boss hits respect post-hit grace frames (~0.6s)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const { before, after: hit1 } = await takeBossHit(
      page,
      'cross_slash_wave',
    );
    const poolAfterHit1 = hit1.player.hp + hit1.player.shield;
    const takenAfterHit1 = hit1.stats.damageTaken;
    expect(takenAfterHit1 - before.stats.damageTaken).toBeLessThanOrEqual(150);
    expect(poolAfterHit1).toBeGreaterThan(1_000);

    // Stay in melee range for ~500ms across the remaining active hitbox frames (activeSeconds: 0.5 < 0.6s grace)
    await page.waitForTimeout(500);
    const duringGrace = await getDebugState(page);
    expect(duringGrace.player.hp + duringGrace.player.shield).toBe(
      poolAfterHit1,
    );
    expect(duringGrace.stats.damageTaken).toBe(takenAfterHit1);

    // Wait >= 900ms for attack recovery (0.8s) and post-hit grace expiry (0.6s) before hit2
    await page.waitForTimeout(950);
    const { after: hit2 } = await takeBossHit(page, 'shattered_earth_slam');
    expect(hit2.stats.damageTaken).toBeGreaterThan(takenAfterHit1);
    expect(hit2.player.hp + hit2.player.shield).toBeLessThan(poolAfterHit1);
    guards.assertClean(hit2);
  });

  test('T2-F12-03 Letting Boss hit Player down toward 0 HP triggers Immortal Lotus Ward safety net', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Absorb repeated heavy Boss slams until Lotus Ward activates
    let wardTriggered = false;
    for (let i = 0; i < 16; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
      const snap = await getDebugState(page);
      expect(snap.player.hp).toBeGreaterThan(0);
      if (snap.audio.lastSfx === 'lotus_ward') {
        wardTriggered = true;
        break;
      }
      const wardTextVisible = await page
        .getByText(UI_COPY.CALLOUT_LOTUS_WARD)
        .first()
        .isVisible()
        .catch(() => false);
      if (wardTextVisible) {
        wardTriggered = true;
        break;
      }
    }

    const finalSnap = await getDebugState(page);
    expect(finalSnap.player.hp).toBeGreaterThan(0);
    expect(wardTriggered).toBe(true);
    guards.assertClean(finalSnap);
  });

  test('T2-F12-04 Passive Lotus Qi Regen heals HP when hp < 500', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Take hits until HP drops strictly below 500
    for (let i = 0; i < 10; i += 1) {
      const cur = await getDebugState(page);
      if (cur.player.hp < COMBAT_TUNING.lowHpThreshold) break;
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
    }

    const lowSnap = await getDebugState(page);
    expect(lowSnap.player.hp).toBeLessThan(COMBAT_TUNING.lowHpThreshold);

    // Disengage so passive Lotus Regen (+15/s) ticks cleanly
    await holdKey(page, 'KeyS', 1_200);
    await page.waitForFunction(
      (prevHp) => (window.__GAME_DEBUG__?.getState().player.hp ?? 0) > prevHp,
      lowSnap.player.hp,
      { timeout: 4_000 },
    );
    const healed = await getDebugState(page);
    expect(healed.player.hp).toBeGreaterThan(lowSnap.player.hp);
    guards.assertClean(healed);
  });

  test('T2-F12-05 hp and shield never exceed maxHp (1000) / maxShield (250) on overheal', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Absorb 3 heavy hits so Shield drops to 0 and HP drops below maxHp (e.g., ~890 < 1000)
    for (let i = 0; i < 3; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
    }
    const bruised = await getDebugState(page);
    expect(bruised.player.shield).toBe(0);
    expect(bruised.player.hp).toBeLessThan(COMBAT_TUNING.playerMaxHp);

    // Skill 3 heals +120 HP and restores Shield to 250; verify genuine increase AND cap clamp
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
    expect(healed.player.hp).toBeGreaterThan(bruised.player.hp);
    expect(healed.player.hp).toBeLessThanOrEqual(COMBAT_TUNING.playerMaxHp);
    expect(healed.player.shield).toBe(COMBAT_TUNING.playerMaxShield);

    // Cast Skill 3 again at/near full HP & Shield to confirm overheal never exceeds caps
    await debugReadyAllSkills(page);
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
    const overhealed = await getDebugState(page);
    expect(overhealed.player.hp).toBeLessThanOrEqual(COMBAT_TUNING.playerMaxHp);
    expect(overhealed.player.shield).toBe(COMBAT_TUNING.playerMaxShield);
    guards.assertClean(overhealed);
  });
});

test.describe('Tier 2 — F13 Boundaries: English UI, Pause & Resize', () => {
  test('T2-F13-01 Narrow desktop 1280x720 has zero HUD overlap between Boss bar, Player bar, and Skill bar', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    const snap = await enterCombat(page, { skipIntro: true });

    const bossLabel = page.getByText(UI_COPY.BOSS_NAME, { exact: true }).first();
    const playerLabel = page
      .getByText(UI_COPY.PLAYER_QI_LABEL, { exact: true })
      .first();
    const skillLabel = page
      .getByText(UI_COPY.SKILL_3_NAME, { exact: true })
      .first();

    await expect(bossLabel).toBeVisible();
    await expect(playerLabel).toBeVisible();
    await expect(skillLabel).toBeVisible();

    const bossBox = await bossLabel.boundingBox();
    const playerBox = await playerLabel.boundingBox();
    const skillBox = await skillLabel.boundingBox();

    expect(bossBox).not.toBeNull();
    expect(playerBox).not.toBeNull();
    expect(skillBox).not.toBeNull();

    expect(rectsOverlap(bossBox!, playerBox!)).toBe(false);
    expect(rectsOverlap(bossBox!, skillBox!)).toBe(false);
    expect(rectsOverlap(playerBox!, skillBox!)).toBe(false);
    await assertNoCjkInDom(page);
    guards.assertClean(snap);
  });

  test('T2-F13-02 Wide desktop 2560x1440 renders HUD cleanly without clipping', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.setViewportSize({ width: 2560, height: 1440 });
    const snap = await enterCombat(page, { skipIntro: true });

    for (const label of [
      UI_COPY.BOSS_NAME,
      UI_COPY.BOSS_POSTURE_LABEL,
      UI_COPY.BOSS_HP_LABEL,
      UI_COPY.PLAYER_SHIELD_LABEL,
      UI_COPY.SKILL_1_NAME,
    ]) {
      const box = await page
        .getByText(label, { exact: true })
        .first()
        .boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(2560);
      expect(box!.y + box!.height).toBeLessThanOrEqual(1440);
    }
    guards.assertClean(snap);
  });

  test('T2-F13-03 Pressing Esc in PHASE_1 pauses simulation and freezes elapsedCombatSeconds', async ({
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
    const t1 = (await getDebugState(page)).elapsedCombatSeconds;
    await page.waitForTimeout(500);
    const t2 = (await getDebugState(page)).elapsedCombatSeconds;
    expect(t2).toBeCloseTo(t1, 3);
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F13-04 Clicking RESUME or pressing Esc again resumes simulation seamlessly', async ({
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
    await page.getByRole('button', { name: UI_COPY.PAUSE_RESUME }).click();
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 2_500 },
    );

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 2_500 },
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 2_500 },
    );
    guards.assertClean(await getDebugState(page));
  });

  test('T2-F13-05 RESTART TRIAL from Pause menu cleanly resets HP, Posture, CDs, and Phase', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.6);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(300);

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
    expect(fresh.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    expect(fresh.player.skillCooldowns.skill2).toBe(0);
    guards.assertClean(fresh);
  });
});

test.describe('Tier 2 — F14 Boundaries: Audio Policies & Edge States', () => {
  test('T2-F14-01 Zero user input keeps audio.errorCount === 0 despite autoplay policy', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    await page.waitForTimeout(500);
    const later = await getDebugState(page);
    expect(later.audio.errorCount).toBe(0);
    guards.assertClean(snapshot);
  });

  test('T2-F14-02 First keyboard gesture unlocks audio cleanly', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().audio.unlocked === true,
      undefined,
      { timeout: 3_000 },
    );
    const snap = await getDebugState(page);
    expect(snap.audio.unlocked).toBe(true);
    expect(snap.audio.errorCount).toBe(0);
    guards.assertClean(snap);
  });

  test('T2-F14-03 Pausing via Esc suspends/ducks BGM cleanly and resuming restores it without errors', async ({
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
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 2_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.audio.errorCount).toBe(0);
    guards.assertClean(snap);
  });

  test('T2-F14-04 Muting audio keeps audio.muted === true across Phase 1 -> Phase 2 -> Victory', async ({
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
    expect(p2.audio.muted).toBe(true);

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    const vic = await waitForPhase(page, 'VICTORY', 5_000);
    expect(vic.audio.muted).toBe(true);
    guards.assertClean(vic);
  });

  test('T2-F14-05 Rapidly firing 10 SFX events in 1s yields audio.errorCount === 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? 'KeyJ' : 'Space');
      await page.waitForTimeout(80);
    }
    const snap = await getDebugState(page);
    expect(snap.audio.errorCount).toBe(0);
    guards.assertClean(snap);
  });
});

test.describe('Tier 2 — F15 Boundaries: Debug Contract Safety', () => {
  test('T2-F15-01 window.__GAME_DEBUG__.getState() returns JSON-serializable snapshot without NaN', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    const serialized = JSON.stringify(snapshot);
    expect(serialized.length).toBeGreaterThan(100);
    expect(serialized).not.toContain('NaN');
    expect(serialized).not.toContain('null,"modelType"');
    guards.assertClean(snapshot);
  });

  test('T2-F15-02 Calling setBossHp(-500) in PHASE_2 clamps cleanly at 0', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugSetBossHp(page, -500);
    const snap = await getDebugState(page);
    expect(snap.boss.hp).toBe(0);
    guards.assertClean(snap);
  });

  test('T2-F15-03 Calling setBossHp(999999) clamps cleanly at maxHp (40,000)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, 999_999);
    const snap = await getDebugState(page);
    expect(snap.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    guards.assertClean(snap);
  });

  test('T2-F15-04 Calling setBossPosture(-100) clamps cleanly at 0 and triggers stagger', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossPosture(page, -100);
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.staggered === true,
      undefined,
      { timeout: 2_500 },
    );
    const snap = await getDebugState(page);
    expect(snap.boss.posture).toBe(0);
    expect(snap.boss.staggered).toBe(true);
    guards.assertClean(snap);
  });

  test('T2-F15-05 Calling skipCinematic() when already in PHASE_1 is a safe no-op', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const before = await enterCombat(page, { skipIntro: true });
    await debugSkipCinematic(page);
    const after = await getDebugState(page);
    expect(after.phase).toBe('PHASE_1');
    expect(after.boss.hp).toBe(before.boss.hp);
    guards.assertClean(after);
  });
});
