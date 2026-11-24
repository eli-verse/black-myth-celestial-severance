import { expect, test } from '@playwright/test';
import {
  assertNoCjkInDom,
  COMBAT_TUNING,
  debugReadyAllSkills,
  debugSetBossHp,
  debugSetBossPosture,
  debugSkipCinematic,
  debugTriggerBossTestAttack,
  enterCombat,
  getDebugState,
  launchGame,
  moveIntoMeleeRange,
  takeBossHit,
  UI_COPY,
  waitForPhase,
} from './helpers/gameHarness.ts';

test.describe('Tier 1 — F12: Forgiving Low-Difficulty Sustain & Boss AI', () => {
  test('T1-F12-01 Player starts with hp === 1000 and shield === 250', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const snap = await enterCombat(page, { skipIntro: true });
    expect(snap.player.hp).toBe(COMBAT_TUNING.playerMaxHp);
    expect(snap.player.shield).toBe(COMBAT_TUNING.playerMaxShield);
    guards.assertClean(snap);
  });

  test('T1-F12-02 Boss telegraphed attacks deal gentle damage (<= 150) absorbed by Shield first', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const { before, after } = await takeBossHit(page, 'shattered_earth_slam');

    const totalTaken = after.stats.damageTaken - before.stats.damageTaken;
    expect(totalTaken).toBeGreaterThanOrEqual(COMBAT_TUNING.bossDamageMin);
    expect(totalTaken).toBeLessThanOrEqual(150);
    expect(after.player.shield).toBeLessThan(before.player.shield);
    expect(after.player.hp).toBe(before.player.hp);
    guards.assertClean(after);
  });

  test('T1-F12-03 Azure Jade Shield auto-regenerates after brief out-of-combat window', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    const { after: damaged } = await takeBossHit(page, 'shattered_earth_slam');
    expect(damaged.player.shield).toBeLessThan(COMBAT_TUNING.playerMaxShield);

    // Move away from Boss so Boss attacks don't reset the 3.5s regen delay
    await page.keyboard.press('Space');
    await page.waitForFunction(
      (prevShield) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(s && s.player.shield > prevShield);
      },
      damaged.player.shield,
      { timeout: 8_000 },
    );

    const regen = await getDebugState(page);
    expect(regen.player.shield).toBeGreaterThan(damaged.player.shield);
    guards.assertClean(regen);
  });

  test('T1-F12-04 Skill 3 restores Player HP and full Azure Jade Shield after taking damage', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    // Absorb 3 hits to break through 250 Shield and reduce HP below 1000
    for (let i = 0; i < 3; i += 1) {
      await takeBossHit(page, 'cataclysmic_leap_slam');
      await page.waitForTimeout(700);
    }

    const bruised = await getDebugState(page);
    expect(bruised.player.shield).toBe(0);
    expect(bruised.player.hp).toBeLessThan(COMBAT_TUNING.playerMaxHp);

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

    const healed = await getDebugState(page);
    expect(healed.player.hp).toBeGreaterThan(bruised.player.hp);
    expect(healed.player.shield).toBe(COMBAT_TUNING.playerMaxShield);
    guards.assertClean(healed);
  });

  test('T1-F12-05 Boss executes distinct telegraphed attacks in Phase 1 and Phase 2', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugTriggerBossTestAttack(page, 'abyssal_sweep');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.attackTelegraphActive === true,
      undefined,
      { timeout: 2_500 },
    );
    const p1Attack = (await getDebugState(page)).boss.currentAttack;
    expect(p1Attack).toBe('abyssal_sweep');

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);

    await debugTriggerBossTestAttack(page, 'twin_abyssal_cleave');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().boss.attackTelegraphActive === true,
      undefined,
      { timeout: 2_500 },
    );
    const p2Attack = (await getDebugState(page)).boss.currentAttack;
    expect(p2Attack).toBe('twin_abyssal_cleave');
    expect(p2Attack).not.toBe(p1Attack);
    guards.assertClean(await getDebugState(page));
  });
});

test.describe('Tier 1 — F13: 100% English UI, HUD, Pause Menu & SSS Results', () => {
  test('T1-F13-01 Title screen displays main title, BEGIN TRIAL, and English controls legend', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    await expect(page.getByText(UI_COPY.TITLE_MAIN)).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }),
    ).toBeVisible();
    await expect(page.getByText(/WASD/i).first()).toBeVisible();
    await assertNoCjkInDom(page);
    guards.assertClean(snapshot);
  });

  test('T1-F13-02 Active HUD displays Boss name, HP/POSTURE/SHIELD/AWAKENING, and English skill names', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const snap = await enterCombat(page, { skipIntro: true });

    await expect(page.getByText(UI_COPY.BOSS_NAME, { exact: true }).first()).toBeVisible();
    expect(
      await page.getByText(UI_COPY.BOSS_HP_LABEL, { exact: true }).count(),
    ).toBeGreaterThanOrEqual(2);
    await expect(
      page.getByText(UI_COPY.BOSS_HP_LABEL, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(UI_COPY.BOSS_POSTURE_LABEL, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(UI_COPY.PLAYER_SHIELD_LABEL, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(UI_COPY.PLAYER_QI_LABEL, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(UI_COPY.SKILL_1_NAME, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(UI_COPY.SKILL_2_NAME, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(UI_COPY.SKILL_3_NAME, { exact: true }).first()).toBeVisible();
    await assertNoCjkInDom(page);
    guards.assertClean(snap);
  });

  test('T1-F13-03 Phase banners render ACT I and ACT II English titles', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });
    await expect(page.getByText(UI_COPY.BANNER_ACT_1)).toBeVisible({
      timeout: 5_000,
    });

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    await waitForPhase(page, 'PHASE_2', 5_000);
    await expect(page.getByText(UI_COPY.BANNER_ACT_2)).toBeVisible({
      timeout: 5_000,
    });
    await assertNoCjkInDom(page);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F13-04 Esc opens PAUSED menu with RESUME, MUTE AUDIO, and RESTART TRIAL', async ({
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

    await expect(page.getByText(UI_COPY.PAUSE_TITLE)).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_COPY.PAUSE_RESUME }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_COPY.PAUSE_MUTE }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_COPY.PAUSE_RESTART }),
    ).toBeVisible();
    await assertNoCjkInDom(page);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F13-05 Victory screen displays VICTORY header, SSS rank, stats, PLAY AGAIN with zero CJK', async ({
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
    const victory = await waitForPhase(page, 'VICTORY', 5_000);

    await expect(page.getByText(UI_COPY.VICTORY_HEADER)).toBeVisible();
    await expect(page.getByText(/\bSSS\b/).first()).toBeVisible();
    await expect(page.getByText(UI_COPY.VICTORY_STAT_TIME)).toBeVisible();
    await expect(page.getByText(UI_COPY.VICTORY_STAT_DAMAGE)).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_COPY.VICTORY_REPLAY_CTA }),
    ).toBeVisible();
    await assertNoCjkInDom(page);
    guards.assertClean(victory);
  });
});

test.describe('Tier 1 — F14: Web Audio BGM & Combat SFX Matrix', () => {
  test('T1-F14-01 Before user gesture, page initializes audio without throwing (errorCount === 0)', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    expect(snapshot.audio.errorCount).toBe(0);
    guards.assertClean(snapshot);
  });

  test('T1-F14-02 Clicking BEGIN TRIAL unlocks Web Audio (audio.unlocked === true)', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const combat = await enterCombat(page, { skipIntro: true });
    expect(combat.audio.unlocked).toBe(true);
    expect(combat.audio.errorCount).toBe(0);
    guards.assertClean(combat);
  });

  test('T1-F14-03 activeBgmState transitions cleanly across PHASE_1, PHASE_2, and VICTORY', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const p1 = await enterCombat(page, { skipIntro: true });
    const bgmPhase1 = p1.audio.activeBgmState;
    expect(bgmPhase1.length).toBeGreaterThan(0);

    await debugSetBossHp(page, COMBAT_TUNING.bossPhase2HpThreshold);
    await waitForPhase(page, 'CINEMATIC_TRANSITION', 5_000);
    await debugSkipCinematic(page);
    const p2 = await waitForPhase(page, 'PHASE_2', 5_000);
    const bgmPhase2 = p2.audio.activeBgmState;
    expect(bgmPhase2.length).toBeGreaterThan(0);
    expect(bgmPhase2).not.toBe(bgmPhase1);

    await debugSetBossHp(page, 0);
    await waitForPhase(page, 'CINEMATIC_FINISHER', 5_000);
    await debugSkipCinematic(page);
    const vic = await waitForPhase(page, 'VICTORY', 5_000);
    const bgmVictory = vic.audio.activeBgmState;
    expect(bgmVictory.length).toBeGreaterThan(0);
    expect(bgmVictory).not.toBe(bgmPhase2);
    expect(vic.audio.errorCount).toBe(0);
    guards.assertClean(vic);
  });

  test('T1-F14-04 Sword slash, Dodge, and Skill inputs update audio.lastSfx cleanly', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('KeyJ');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().audio.lastSfx !== null,
      undefined,
      { timeout: 2_500 },
    );
    const afterSlash = (await getDebugState(page)).audio.lastSfx;
    expect(afterSlash).toBeTruthy();

    await page.keyboard.press('Space');
    await page.waitForFunction(
      (prev) => {
        const sfx = window.__GAME_DEBUG__?.getState().audio.lastSfx;
        return Boolean(sfx && sfx !== prev);
      },
      afterSlash,
      { timeout: 2_500 },
    );
    const afterDodge = (await getDebugState(page)).audio.lastSfx;
    expect(afterDodge).toBeTruthy();
    expect(afterDodge).not.toBe(afterSlash);

    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().player.isDodging === false,
      undefined,
      { timeout: 2_000 },
    );
    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      (prev) => {
        const sfx = window.__GAME_DEBUG__?.getState().audio.lastSfx;
        return Boolean(sfx && sfx !== prev);
      },
      afterDodge,
      { timeout: 2_500 },
    );
    const afterSkill = (await getDebugState(page)).audio.lastSfx;
    expect(afterSkill).toBeTruthy();
    expect(afterSkill).not.toBe(afterDodge);
    guards.assertClean(await getDebugState(page));
  });

  test('T1-F14-05 Pause Mute button toggles audio.muted between true and false', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    const start = await enterCombat(page, { skipIntro: true });
    expect(start.audio.muted).toBe(false);

    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().paused === true,
      undefined,
      { timeout: 2_500 },
    );

    await page.getByRole('button', { name: UI_COPY.PAUSE_MUTE }).click();
    const mutedState = await getDebugState(page);
    expect(mutedState.audio.muted).toBe(true);

    await page.getByRole('button', { name: UI_COPY.PAUSE_UNMUTE }).click();
    const unmutedState = await getDebugState(page);
    expect(unmutedState.audio.muted).toBe(false);
    guards.assertClean(unmutedState);
  });
});

test.describe('Tier 1 — F15: Deterministic Debug & E2E Inspection Contract', () => {
  test('T1-F15-01 window.__GAME_DEBUG__.getState() returns complete typed GameDebugSnapshot', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: true });
    expect(typeof snapshot.phase).toBe('string');
    expect(typeof snapshot.paused).toBe('boolean');
    expect(['webgpu', 'webgl2']).toContain(snapshot.rendererBackend);
    expect(typeof snapshot.timeScale).toBe('number');
    expect(Array.isArray(snapshot.player.position)).toBe(true);
    expect(Array.isArray(snapshot.boss.position)).toBe(true);
    expect(typeof snapshot.stats.rank).toBe('string');
    expect(typeof snapshot.audio.unlocked).toBe('boolean');
    expect(Array.isArray(snapshot.errors)).toBe(true);
    guards.assertClean(snapshot);
  });

  test('T1-F15-02 skipCinematic() cleanly advances active cinematic to playable state', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();
    await waitForPhase(page, 'CINEMATIC_INTRO', 5_000);

    await debugSkipCinematic(page);
    const snap = await waitForPhase(page, 'PHASE_1', 3_000);
    expect(snap.phase).toBe('PHASE_1');
    guards.assertClean(snap);
  });

  test('T1-F15-03 readyAllSkills() resets CDs to 0 and fills Qi to 100', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await page.keyboard.press('Digit1');
    await page.waitForFunction(
      () => (window.__GAME_DEBUG__?.getState().player.skillCooldowns.skill1 ?? 0) > 0,
      undefined,
      { timeout: 2_500 },
    );
    await page.waitForTimeout(450);

    await page.keyboard.press('Digit3');
    await page.waitForFunction(
      (maxQi) => {
        const s = window.__GAME_DEBUG__?.getState();
        return Boolean(
          s &&
            s.player.skillCooldowns.skill3 > 0 &&
            s.player.qi < maxQi,
        );
      },
      COMBAT_TUNING.playerMaxQi,
      { timeout: 3_000 },
    );
    await page.waitForFunction(
      () => window.__GAME_DEBUG__?.getState().skill3Active === false,
      undefined,
      { timeout: 6_000 },
    );

    await debugReadyAllSkills(page);
    const snap = await getDebugState(page);
    expect(snap.player.skillCooldowns.skill1).toBe(0);
    expect(snap.player.skillCooldowns.skill2).toBe(0);
    expect(snap.player.skillCooldowns.skill3).toBe(0);
    expect(snap.player.skillCooldowns.dodge).toBe(0);
    expect(snap.player.qi).toBe(COMBAT_TUNING.playerMaxQi);
    guards.assertClean(snap);
  });

  test('T1-F15-04 setBossHp() and setBossPosture() deterministically update Boss state under ?testMode=1', async ({
    page,
  }) => {
    const { guards } = await launchGame(page, { testMode: true });
    await enterCombat(page, { skipIntro: true });

    await debugSetBossHp(page, 28_000);
    await debugSetBossPosture(page, 450);
    const snap = await getDebugState(page);
    expect(snap.boss.hp).toBe(28_000);
    expect(snap.boss.hpRatio).toBeCloseTo(28_000 / COMBAT_TUNING.bossMaxHp, 3);
    expect(snap.boss.posture).toBe(450);
    expect(snap.boss.postureRatio).toBeCloseTo(
      450 / COMBAT_TUNING.bossMaxPosture,
      3,
    );
    guards.assertClean(snap);
  });

  test('T1-F15-05 Normal load without ?testMode=1 does not auto-alter HP, skills, or phases', async ({
    page,
  }) => {
    const { guards, snapshot } = await launchGame(page, { testMode: false });
    expect(snapshot.phase).toBe('TITLE');
    expect(snapshot.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(snapshot.boss.posture).toBe(COMBAT_TUNING.bossMaxPosture);
    expect(snapshot.stats.totalDamageDealt).toBe(0);

    // Also verify debug test mutators do not hijack normal mode into skipping or altering play
    await page.getByRole('button', { name: UI_COPY.TITLE_START_CTA }).click();
    await waitForPhase(page, 'CINEMATIC_INTRO', 5_000);
    const phase1 = await waitForPhase(page, 'PHASE_1', 12_000);
    expect(phase1.boss.hp).toBe(COMBAT_TUNING.bossMaxHp);
    expect(phase1.player.hp).toBe(COMBAT_TUNING.playerMaxHp);
    expect(phase1.player.qi).toBe(COMBAT_TUNING.playerInitialQi);
    guards.assertClean(phase1);
  });
});
