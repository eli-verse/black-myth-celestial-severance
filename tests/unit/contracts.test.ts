import { describe, expect, it } from 'vitest';
import { createDefaultDebugSnapshot } from '../../src/debug/DebugBridge.ts';
import { COMBAT_TUNING, UI_COPY } from '../../src/types/game.ts';

const CJK_REGEX = /[\u4e00-\u9fff]/;

describe('Shared Contracts & Tuning Invariants', () => {
  it('enforces COMBAT_TUNING balance and pacing invariants', () => {
    expect(COMBAT_TUNING.bossMaxHp).toBe(40_000);
    expect(COMBAT_TUNING.bossPhase2HpThreshold).toBe(22_000);
    expect(COMBAT_TUNING.bossPhase2ThresholdRatio).toBe(0.55);
    expect(COMBAT_TUNING.bossMaxPosture).toBe(1_000);
    expect(COMBAT_TUNING.playerMaxHp).toBe(1_000);
    expect(COMBAT_TUNING.playerMaxShield).toBe(250);
    expect(COMBAT_TUNING.comboSteps).toHaveLength(4);

    expect(COMBAT_TUNING.skill1CooldownSeconds).toBe(6.0);
    expect(COMBAT_TUNING.skill2CooldownSeconds).toBe(10.0);
    expect(COMBAT_TUNING.skill3CooldownSeconds).toBe(20.0);

    for (const attack of COMBAT_TUNING.bossAttacks) {
      expect(attack.damage).toBeGreaterThanOrEqual(60);
      expect(attack.damage).toBeLessThanOrEqual(120);
      expect(attack.windupSeconds).toBeGreaterThanOrEqual(0.9);
      expect(attack.windupSeconds).toBeLessThanOrEqual(1.4);
    }
  });

  it('keeps UI_COPY 100% English with zero CJK characters', () => {
    for (const [key, value] of Object.entries(UI_COPY)) {
      expect(value.length, `UI_COPY.${key} must be non-empty`).toBeGreaterThan(0);
      expect(
        CJK_REGEX.test(value),
        `UI_COPY.${key} contains CJK characters: "${value}"`,
      ).toBe(false);
    }
  });

  it('builds a JSON-serializable GameDebugSnapshot with defaults', () => {
    const snapshot = createDefaultDebugSnapshot({
      rendererBackend: 'webgpu',
    });
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped.phase).toBe('TITLE');
    expect(roundTripped.rendererBackend).toBe('webgpu');
    expect(roundTripped.boss.maxHp).toBe(40_000);
    expect(roundTripped.boss.maxPosture).toBe(1_000);
    expect(roundTripped.player.maxHp).toBe(1_000);
    expect(roundTripped.player.maxShield).toBe(250);
    expect(roundTripped.player.modelType).toBe('glb');
    expect(roundTripped.boss.modelType).toBe('glb');
    expect(roundTripped.errors).toEqual([]);
  });
});
