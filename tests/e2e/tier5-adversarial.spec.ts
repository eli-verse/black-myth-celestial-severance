import { expect, test } from '@playwright/test';
import {
  COMBAT_TUNING,
  UI_COPY,
  assertCanvasRendered,
  assertNoCjkInDom,
  debugReadyAllSkills,
  debugSetBossHp,
  debugSkipCinematic,
  enterCombat,
  getDebugState,
  holdKey,
  launchGame,
  moveIntoMeleeRange,
  orbitCameraDrag,
  performPerfectDodge,
  radiusXZ,
  triggerBasicAttack,
  waitForPhase,
  waitForRafFrames,
} from './helpers/gameHarness';

test.describe('Tier 5 — White-Box Adversarial E2E Suite', () => {
  test('T5-E2E-01: Rapid simultaneous key chord + Escape pause/resume during active Bullet-Time & Skill 3 time-stop', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page);
    await debugReadyAllSkills(page);

    // Ensure >= 50 Qi and trigger Perfect Dodge Bullet-Time
    await performPerfectDodge(page, 'abyssal_sweep');

    // Rapid simultaneous chord: Digit3 + Digit2 + Digit1 + KeyJ during Bullet-Time
    await Promise.all([
      page.keyboard.press('Digit3'),
      page.keyboard.press('Digit2'),
      page.keyboard.press('Digit1'),
      page.keyboard.press('KeyJ'),
    ]);

    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().skill3Active),
      undefined,
      { timeout: 5_000 },
    );

    // Pause -> verify frozen -> Resume via Escape twice during active Skill 3 time-stop
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => Boolean(window.__GAME_DEBUG__?.getState().paused),
      undefined,
      { timeout: 5_000 },
    );
    await expect(
      page.getByRole('heading', { name: UI_COPY.PAUSE_TITLE }),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 5_000 },
    );

    // Wait for Skill 3 & Bullet-Time to finish and timeScale to restore cleanly to 1.0
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s && !s.skill3Active && !s.bulletTimeActive && s.timeScale === 1.0,
        );
      },
      undefined,
      { timeout: 10_000 },
    );

    const finalSnap = await getDebugState(page);
    expect(finalSnap.paused).toBe(false);
    expect(finalSnap.timeScale).toBe(1.0);
    expect(finalSnap.audio.errorCount).toBe(0);
    guards.assertClean(finalSnap);
  });

  for (const forceWebGL of [false, true] as const) {
    const backendLabel = forceWebGL ? 'WebGL2 (?forceWebGL=1)' : 'WebGPU';

    test(`T5-E2E-02 (${backendLabel}): Narrow/1px resize + visibilitychange + rapid phase skip & replay loop`, async ({
      page,
    }) => {
      const { guards } = await launchGame(page, {
        testMode: true,
        forceWebGL,
      });
      await enterCombat(page);

      // Resize across narrow 320x240, 1x1 minimum, and back to 1280x720
      await page.setViewportSize({ width: 320, height: 240 });
      await waitForRafFrames(page, 3);
      await page.setViewportSize({ width: 1, height: 1 });
      await waitForRafFrames(page, 3);
      await page.setViewportSize({ width: 1280, height: 720 });
      await waitForRafFrames(page, 3);

      // Simulate visibilitychange hidden -> visible
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: false,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitForRafFrames(page, 3);

      // Rapid phase skip: PHASE_1 -> CINEMATIC_TRANSITION -> PHASE_2 -> CINEMATIC_FINISHER -> VICTORY -> PLAY AGAIN
      await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
      await waitForPhase(page, 'CINEMATIC_TRANSITION');
      await debugSkipCinematic(page);
      await waitForPhase(page, 'PHASE_2');

      await debugSetBossHp(page, 0);
      await waitForPhase(page, 'CINEMATIC_FINISHER');
      await debugSkipCinematic(page);
      await waitForPhase(page, 'VICTORY');

      await page.getByRole('button', { name: UI_COPY.VICTORY_REPLAY_CTA }).click();
      await page.waitForFunction(
        () => {
          const p = window.__GAME_DEBUG__?.getState().phase;
          return p === 'CINEMATIC_INTRO' || p === 'PHASE_1';
        },
        undefined,
        { timeout: 10_000 },
      );

      const snap = await getDebugState(page);
      expect(snap.player.position.every((n) => Number.isFinite(n))).toBe(true);
      expect(snap.boss.position.every((n) => Number.isFinite(n))).toBe(true);
      expect(snap.audio.errorCount).toBe(0);
      await assertCanvasRendered(page);
      guards.assertClean(snap);
    });
  }

  test('T5-01: Pause/Escape Matrix Across All 7 Phases', async ({ page }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const pauseHeading = page.getByRole('heading', {
      name: UI_COPY.PAUSE_TITLE,
    });

    // 1. TITLE: Escape must NOT open Pause menu
    await page.keyboard.press('Escape');
    await waitForRafFrames(page, 3);
    expect((await getDebugState(page)).paused).toBe(false);
    await expect(pauseHeading).toBeHidden();

    // 2. CINEMATIC_INTRO: Escape opens Pause menu, Resume closes it
    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();
    await waitForPhase(page, 'CINEMATIC_INTRO');

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 5_000 },
    );
    await expect(pauseHeading).toBeVisible();
    await page.getByRole('button', { name: UI_COPY.PAUSE_RESUME }).click();
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 5_000 },
    );
    await expect(pauseHeading).toBeHidden();

    // 3. PHASE_1 -> CINEMATIC_TRANSITION: Escape toggles Pause cleanly
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_1');
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION');

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 5_000 },
    );
    await expect(pauseHeading).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 5_000 },
    );

    // 4. PHASE_2 -> CINEMATIC_FINISHER: Escape toggles Pause cleanly
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2');
    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER');

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 5_000 },
    );
    await expect(pauseHeading).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 5_000 },
    );

    // 5. VICTORY: Escape must NOT open Pause menu
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY');
    await page.keyboard.press('Escape');
    await waitForRafFrames(page, 3);
    expect((await getDebugState(page)).paused).toBe(false);
    await expect(pauseHeading).toBeHidden();

    guards.assertClean(await getDebugState(page));
  });

  test('T5-02: window.blur and document visibilitychange clear stuck keys and active mouse drag without phantom click-attack', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page);

    // Hold KeyW + ShiftRight without keyup, verify velocity > 0
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftRight');
    await page.waitForFunction(
      () => {
        const v = window.__GAME_DEBUG__?.getState().player.velocity;
        return Boolean(v && Math.hypot(v[0], v[2]) > 1);
      },
      undefined,
      { timeout: 5_000 },
    );

    // Dispatch window.blur without releasing keys -> velocity must drop to 0
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForFunction(
      () => {
        const v = window.__GAME_DEBUG__?.getState().player.velocity;
        return Boolean(v && Math.hypot(v[0], v[2]) < 1e-4);
      },
      undefined,
      { timeout: 5_000 },
    );
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftRight');

    // Now test visibilitychange while holding KeyD and left-mouse-dragging
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.keyboard.down('KeyD');
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(cx + 2, cy, { steps: 2 }); // below drag threshold

    await page.waitForFunction(
      () => {
        const v = window.__GAME_DEBUG__?.getState().player.velocity;
        return Boolean(v && Math.hypot(v[0], v[2]) > 1);
      },
      undefined,
      { timeout: 5_000 },
    );

    const comboBefore = (await getDebugState(page)).player.comboStep;

    // Hide document via visibilitychange -> heldKeys & isDragging clear immediately
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(
      () => {
        const v = window.__GAME_DEBUG__?.getState().player.velocity;
        return Boolean(v && Math.hypot(v[0], v[2]) < 1e-4);
      },
      undefined,
      { timeout: 5_000 },
    );

    // Restore visibility and release mouse/key -> NO phantom click-attack on mouseup!
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.mouse.up({ button: 'left' });
    await page.keyboard.up('KeyD');
    await waitForRafFrames(page, 4);

    const after = await getDebugState(page);
    expect(after.player.comboStep).toBe(comboBefore);
    expect(Math.hypot(after.player.velocity[0], after.player.velocity[2])).toBeLessThan(1e-3);
    guards.assertClean(after);
  });

  test('T5-03: ArrowUp/ArrowDown/ArrowLeft/ArrowRight + ShiftRight locomotion parity and arenaRadius clamping', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page);

    for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'] as const) {
      const before = (await getDebugState(page)).player.position;
      await page.keyboard.down('ShiftRight');
      await holdKey(page, key, 220);
      await page.keyboard.up('ShiftRight');
      const after = (await getDebugState(page)).player.position;
      const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
      expect(moved, `Expected movement for ${key} + ShiftRight`).toBeGreaterThan(0.4);
      expect(radiusXZ(after)).toBeLessThanOrEqual(COMBAT_TUNING.arenaRadius + 0.01);
    }

    // Drive toward outer arena wall via ArrowDown to confirm clamping at <= arenaRadius
    await holdKey(page, 'ArrowDown', 1_200);
    const edgeSnap = await getDebugState(page);
    expect(radiusXZ(edgeSnap.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius + 0.01,
    );
    guards.assertClean(edgeSnap);
  });

  test('T5-04: pointerlockerror & pointerlockchange recovery preserves drag-orbit, attacks, and Escape/VICTORY release', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page);
    await moveIntoMeleeRange(page, 3.6);

    // Dispatch pointerlockerror and pointerlockchange transitions
    await page.evaluate(() => {
      document.dispatchEvent(new Event('pointerlockerror'));
      document.dispatchEvent(new Event('pointerlockchange'));
    });
    await waitForRafFrames(page, 3);

    // Drag-orbit and LMB/KeyJ attack continue working cleanly
    await orbitCameraDrag(page, 80, -20, 6);
    const beforeHp = (await getDebugState(page)).boss.hp;
    await triggerBasicAttack(page, 'KeyJ');
    await page.waitForFunction(
      (hp) => (window.__GAME_DEBUG__?.getState().boss.hp ?? hp) < hp,
      beforeHp,
      { timeout: 5_000 },
    );

    // Escape pauses cleanly and VICTORY completes cleanly
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 5_000 },
    );
    await page.getByRole('button', { name: UI_COPY.PAUSE_RESUME }).click();
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === false,
      undefined,
      { timeout: 5_000 },
    );

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION');
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2');
    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER');
    await debugSkipCinematic(page);
    await waitForPhase(page, 'VICTORY');

    guards.assertClean(await getDebugState(page));
  });

  test('T5-05: Rapid 3x Replay / Restart endurance without page reload keeps clean HUD, zero leaks, and reset vitals', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { guards } = await launchGame(page, { testMode: true });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      if (cycle === 1) {
        await enterCombat(page);
      } else {
        await page.getByRole('button', { name: UI_COPY.VICTORY_REPLAY_CTA }).click();
        await page.waitForFunction(
          () => {
            const p = window.__GAME_DEBUG__?.getState().phase;
            return p === 'CINEMATIC_INTRO' || p === 'PHASE_1';
          },
          undefined,
          { timeout: 10_000 },
        );
        if ((await getDebugState(page)).phase === 'CINEMATIC_INTRO') {
          await debugSkipCinematic(page);
        }
        await waitForPhase(page, 'PHASE_1');
      }

      // Verify clean initial vitals & single HUD/Menu mount
      const startSnap = await getDebugState(page);
      expect(startSnap.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
      expect(startSnap.player.hp).toBe(COMBAT_TUNING.playerMaxHp);
      expect(startSnap.elapsedCombatSeconds).toBeLessThan(1.0);
      expect(await page.locator('.bm-hud-root').count()).toBe(1);
      expect(await page.locator('.bm-menu-root').count()).toBe(1);

      // Pause -> RESTART TRIAL inside cycle
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => window.__GAME_DEBUG__?.getState().paused === true,
        undefined,
        { timeout: 5_000 },
      );
      await page.getByRole('button', { name: UI_COPY.PAUSE_RESTART }).click();
      await page.waitForFunction(
        () => {
          const s = window.__GAME_DEBUG__?.getState();
          return Boolean(
            s && !s.paused && (s.phase === 'CINEMATIC_INTRO' || s.phase === 'PHASE_1'),
          );
        },
        undefined,
        { timeout: 10_000 },
      );
      if ((await getDebugState(page)).phase === 'CINEMATIC_INTRO') {
        await debugSkipCinematic(page);
      }
      await waitForPhase(page, 'PHASE_1');

      // Progress through Phase 2 -> Victory
      await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
      await waitForPhase(page, 'CINEMATIC_TRANSITION');
      await debugSkipCinematic(page);
      await waitForPhase(page, 'PHASE_2');

      await debugSetBossHp(page, 0);
      await waitForPhase(page, 'CINEMATIC_FINISHER');
      await debugSkipCinematic(page);
      await waitForPhase(page, 'VICTORY');

      await expect(
        page.getByRole('heading', { name: UI_COPY.VICTORY_HEADER }),
      ).toBeVisible();
      await assertNoCjkInDom(page);
    }

    const finalSnap = await getDebugState(page);
    expect(finalSnap.audio.errorCount).toBe(0);
    guards.assertClean(finalSnap);
  });
});
