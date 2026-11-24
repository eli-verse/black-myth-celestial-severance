import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ALL_EXPECTED_ASSETS,
  assertCanvasRendered,
  assertOpenMotionBaselineClean,
  COMBAT_TUNING,
  debugSetBossHp,
  debugSkipCinematic,
  debugTriggerBossTestAttack,
  enterCombat,
  EXPECTED_AUDIO_ASSETS,
  EXPECTED_GLB_ASSETS,
  EXPECTED_HDRI_ASSETS,
  GAME_REPO_PATH,
  getDebugState,
  holdKey,
  launchGame,
  listGameFilesRecursively,
  moveIntoMeleeRange,
  radiusXZ,
  UI_COPY,
  waitForPhase,
  waitForRafFrames,
} from './helpers/gameHarness.ts';

test.describe('Tier 1 — F1: Standalone Isolation & Offline Asset Bundle', () => {
  test('T1-F1-01 All HTTP requests target localhost/127.0.0.1 only (zero external CDN requests)', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    await waitForRafFrames(page, 3);
    guards.assertClean(snapshot);
    expect(guards.externalRequests).toEqual([]);
    expect(guards.allRequests.length).toBeGreaterThanOrEqual(34);
  });

  test('T1-F1-02 Zero HTTP >=400 or 404 responses on full page load and intro', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const phase1Snapshot = await enterCombat(page, { skipIntro: false });
    expect(phase1Snapshot.phase).toBe('PHASE_1');
    guards.assertClean(phase1Snapshot);
  });

  test('T1-F1-03 All 10 local .glb player/boss/weapon/env assets load with status 200', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    for (const assetPath of EXPECTED_GLB_ASSETS) {
      const statuses = guards.assetResponseMap.get(assetPath);
      expect(statuses, `Expected status records for ${assetPath}`).toBeDefined();
      expect(statuses).toContain(200);
      expect(statuses!.every((s) => s < 400)).toBe(true);
    }
    guards.assertClean(snapshot);
  });

  test('T1-F1-04 All 2 local .hdr and 21 audio assets load with status 200 and 0 audio errors', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    for (const assetPath of [...EXPECTED_HDRI_ASSETS, ...EXPECTED_AUDIO_ASSETS]) {
      const statuses = guards.assetResponseMap.get(assetPath);
      expect(statuses, `Expected status records for ${assetPath}`).toBeDefined();
      expect(statuses).toContain(200);
      expect(statuses!.every((s) => s < 400)).toBe(true);
    }
    expect(snapshot.audio.errorCount).toBe(0);
    guards.assertClean(snapshot);
  });

  test('T1-F1-05 OpenMotion repo untouched and Game THIRD_PARTY_LICENSES boundary passes', async () => {
    assertOpenMotionBaselineClean();

    const pkgPath = path.join(GAME_REPO_PATH, 'package.json');
    const licensePath = path.join(GAME_REPO_PATH, 'THIRD_PARTY_LICENSES.md');
    expect(fs.existsSync(pkgPath)).toBe(true);
    expect(fs.existsSync(licensePath)).toBe(true);

    const licenseText = fs.readFileSync(licensePath, 'utf8');
    expect(licenseText).toContain('CC0-1.0');

    for (const assetPath of ALL_EXPECTED_ASSETS) {
      const diskPath = path.join(GAME_REPO_PATH, 'public', assetPath);
      expect(fs.existsSync(diskPath), `Missing local asset ${diskPath}`).toBe(true);
    }

    const srcFiles = listGameFilesRecursively(path.join(GAME_REPO_PATH, 'src'));
    for (const file of [...srcFiles, path.join(GAME_REPO_PATH, 'index.html')]) {
      const content = fs.readFileSync(file, 'utf8');
      expect(/OpenMotion/i.test(content), `Found OpenMotion ref in ${file}`).toBe(
        false,
      );
    }
  });
});

test.describe('Tier 1 — F2: Three.js WebGPU Renderer, RenderPipeline Bloom & WebGL2 Fallback', () => {
  test('T1-F2-01 Primary launch initializes WebGPU (or WebGL2 if adapter absent) without error', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    const hasGpuAdapter = await page.evaluate(async () => {
      const nav = navigator as Navigator & {
        gpu?: { requestAdapter?: () => Promise<unknown | null> };
      };
      if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') return false;
      try {
        const adapter = await nav.gpu.requestAdapter();
        return adapter !== null;
      } catch {
        return false;
      }
    });
    if (hasGpuAdapter) {
      expect(snapshot.rendererBackend).toBe('webgpu');
    } else {
      expect(['webgpu', 'webgl2']).toContain(snapshot.rendererBackend);
    }
    guards.assertClean(snapshot);
  });

  test('T1-F2-02 Canvas renders non-zero pixel buffer with visible non-blank frame', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    const dims = await assertCanvasRendered(page);
    expect(dims.width).toBeGreaterThan(200);
    expect(dims.height).toBeGreaterThan(200);
    guards.assertClean(snapshot);
  });

  test('T1-F2-03 ?forceWebGL=1 cleanly initializes rendererBackend === webgl2', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, {
      forceWebGL: true,
      testMode: true,
    });
    expect(snapshot.rendererBackend).toBe('webgl2');
    await assertCanvasRendered(page);
    guards.assertClean(snapshot);
  });

  test('T1-F2-04 Viewport resize (1280x720 -> 1920x1080) updates canvas dimensions cleanly', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const initial = await assertCanvasRendered(page);
    expect(initial.width).toBeGreaterThanOrEqual(1200);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForRafFrames(page, 5);

    const resized = await assertCanvasRendered(page);
    expect(resized.width).toBeGreaterThanOrEqual(1900);
    expect(resized.height).toBeGreaterThanOrEqual(1060);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F2-05 Zero shader compilation or pipeline warnings/errors across frame loop', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await page.keyboard.press('KeyJ');
    await waitForRafFrames(page, 12);
    guards.assertClean(await getDebugState(page));
  });
});

test.describe('Tier 1 — F3: Local Rigged .glb Characters & Skeletal Clips', () => {
  test('T1-F3-01 Player modelType === glb with active skeletal clip on load', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    expect(snapshot.player.modelType).toBe('glb');
    expect(snapshot.player.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(snapshot);
  });

  test('T1-F3-02 Boss modelType === glb with active skeletal clip on load', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    expect(snapshot.boss.modelType).toBe('glb');
    expect(snapshot.boss.activeClip.length).toBeGreaterThan(0);
    guards.assertClean(snapshot);
  });

  test('T1-F3-03 Player activeClip switches from idle to locomotion clip during W hold', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const idleSnap = await getDebugState(page);
    const idleClip = idleSnap.player.activeClip;

    let runClip = idleClip;
    try {
      await page.keyboard.down('KeyW');
      await page.waitForFunction(
        (prevClip) => {
          const clip = window.__GAME_DEBUG__?.getState().player.activeClip ?? '';
          return clip.length > 0 && clip !== prevClip;
        },
        idleClip,
        { timeout: 3_000 },
      );
      runClip = (await getDebugState(page)).player.activeClip;
    } finally {
      await page.keyboard.up('KeyW');
    }

    expect(runClip.length).toBeGreaterThan(0);
    expect(runClip).not.toBe(idleClip);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F3-04 Player activeClip switches to attack clip during combo input', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const before = await getDebugState(page);

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      (prevClip) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.comboStep >= 1 &&
            s.player.activeClip.length > 0 &&
            s.player.activeClip !== prevClip,
        );
      },
      before.player.activeClip,
      { timeout: 2_500 },
    );

    const after = await getDebugState(page);
    expect(after.player.activeClip).not.toBe(before.player.activeClip);
    guards.assertClean(after);
  });

  test('T1-F3-05 Boss activeClip transitions to active attack clip in combat', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const idleClip = (await getDebugState(page)).boss.activeClip;

    await debugTriggerBossTestAttack(page, 'abyssal_sweep');
    await page.waitForFunction(
      (prevClip) => {
        const b = window.__GAME_DEBUG__?.getState().boss;
        return Boolean(
          b &&
            (b.attackTelegraphActive || b.currentAttack !== null) &&
            b.activeClip.length > 0 &&
            b.activeClip !== prevClip,
        );
      },
      idleClip,
      { timeout: 3_000 },
    );

    const after = await getDebugState(page);
    expect(after.boss.activeClip.length).toBeGreaterThan(0);
    expect(after.boss.activeClip).not.toBe(idleClip);
    guards.assertClean(after);
  });
});

test.describe('Tier 1 — F4: Black-Gold Temple Circular Arena & Mirror Floor', () => {
  test('T1-F4-01 Title panorama renders canvas without clipping or full-viewport HUD block', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    const canvasBox = await assertCanvasRendered(page);
    const startBtn = page.getByRole('button', { name: UI_COPY.TITLE_START_CTA });
    await expect(startBtn).toBeVisible();
    const btnBox = await startBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    expect(btnBox!.width).toBeLessThan(canvasBox.width * 0.6);
    guards.assertClean(snapshot);
  });

  test('T1-F4-02 Player spawns inside valid arena radius (R <= 25.0m)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const snap = await enterCombat(page, { skipIntro: true });
    expect(radiusXZ(snap.player.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius,
    );
    guards.assertClean(snap);
  });

  test('T1-F4-03 Boss spawns near arena center within R <= 25.0m', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const snap = await enterCombat(page, { skipIntro: true });
    expect(radiusXZ(snap.boss.position)).toBeLessThanOrEqual(
      COMBAT_TUNING.arenaRadius,
    );
    guards.assertClean(snap);
  });

  test('T1-F4-04 360-degree movement around arena remains unobstructed', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    const visited: Array<readonly [number, number]> = [
      [start.player.position[0], start.player.position[2]],
    ];

    for (const key of ['KeyD', 'KeyW', 'KeyA', 'KeyS']) {
      await holdKey(page, key, 400);
      const s = await getDebugState(page);
      expect(radiusXZ(s.player.position)).toBeLessThanOrEqual(
        COMBAT_TUNING.arenaRadius + 0.05,
      );
      visited.push([s.player.position[0], s.player.position[2]]);
    }

    const totalTravel =
      Math.hypot(visited[1]![0] - visited[0]![0], visited[1]![1] - visited[0]![1]) +
      Math.hypot(visited[2]![0] - visited[1]![0], visited[2]![1] - visited[1]![1]) +
      Math.hypot(visited[3]![0] - visited[2]![0], visited[3]![1] - visited[2]![1]) +
      Math.hypot(visited[4]![0] - visited[3]![0], visited[4]![1] - visited[3]![1]);
    expect(totalTravel).toBeGreaterThan(4.0);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F4-05 Arena viewport renders cleanly at 1280x720 and 1440x900', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await waitForRafFrames(page, 3);
    const box720 = await assertCanvasRendered(page);
    expect(box720.width).toBeGreaterThanOrEqual(1270);

    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForRafFrames(page, 3);
    const box900 = await assertCanvasRendered(page);
    expect(box900.width).toBeGreaterThanOrEqual(1430);
    expect(box900.height).toBeGreaterThanOrEqual(890);
    guards.assertClean(await getDebugState(page));
  });
});

test.describe('Tier 1 — F5: Custom TSL NodeMaterial VFX & Act I/II Atmosphere', () => {
  test('T1-F5-01 Combo attacks render smoothly with zero TSL/node compile errors', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 3.2);

    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('KeyJ');
      await page.waitForTimeout(260);
    }
    await waitForRafFrames(page, 4);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F5-02 Boss telegraph attack activates attackTelegraphActive === true cleanly', async ({
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

    const snap = await getDebugState(page);
    expect(snap.boss.attackTelegraphActive).toBe(true);
    await waitForRafFrames(page, 4);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F5-03 Phase Transition at 55% HP updates atmosphere cleanly without shader errors', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);

    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await waitForRafFrames(page, 4);
    await debugSkipCinematic(page);
    const phase2 = await waitForPhase(page, 'PHASE_2', 5_000);
    expect(phase2.phase).toBe('PHASE_2');
    guards.assertClean(phase2);
  });

  test('T1-F5-04 Skill 3 Time-Stop domain triggers visual domain state cleanly', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await moveIntoMeleeRange(page, 4.0);

    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      () => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.skill3Active && s.timeScale === 0);
      },
      undefined,
      { timeout: 3_000 },
    );

    const snap = await getDebugState(page);
    expect(snap.skill3Active).toBe(true);
    expect(snap.timeScale).toBe(0);
    await waitForRafFrames(page, 4);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F5-05 Victory finisher particles and dissolve complete without console errors', async ({
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
    await waitForRafFrames(page, 4);
    const victory = await waitForPhase(page, 'VICTORY', 10_000);
    expect(victory.boss.hp).toBe(0);
    guards.assertClean(victory);
  });
});
