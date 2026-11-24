import {
  COMBAT_TUNING,
  type DebugTestHooks,
  type GameDebugAPI,
  type GameDebugSnapshot,
  type GamePerfSnapshot,
} from '../types/game.ts';

declare global {
  interface Window {
    __GAME_DEBUG__?: GameDebugAPI;
  }
}

const MAX_CAPTURED_ERRORS = 100;

export function safeToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message ?? 'Error';
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '[unserializable object]';
    }
  }
}

export function createDefaultDebugSnapshot(
  overrides: Partial<GameDebugSnapshot> = {},
): GameDebugSnapshot {
  const base: GameDebugSnapshot = {
    phase: 'TITLE',
    paused: false,
    rendererBackend: 'webgpu',
    elapsedCombatSeconds: 0,
    timeScale: 1.0,
    bulletTimeActive: false,
    skill3Active: false,
    player: {
      hp: COMBAT_TUNING.playerMaxHp,
      maxHp: COMBAT_TUNING.playerMaxHp,
      shield: COMBAT_TUNING.playerMaxShield,
      maxShield: COMBAT_TUNING.playerMaxShield,
      qi: COMBAT_TUNING.playerInitialQi,
      maxQi: COMBAT_TUNING.playerMaxQi,
      position: [0, 0, 4],
      velocity: [0, 0, 0],
      comboStep: 0,
      comboCount: 0,
      isDodging: false,
      invulnerable: false,
      skillCooldowns: {
        skill1: 0,
        skill2: 0,
        skill3: 0,
        dodge: 0,
      },
      modelType: 'glb',
      activeClip: '',
    },
    boss: {
      hp: COMBAT_TUNING.bossMaxHp,
      maxHp: COMBAT_TUNING.bossMaxHp,
      hpRatio: 1.0,
      posture: COMBAT_TUNING.bossMaxPosture,
      maxPosture: COMBAT_TUNING.bossMaxPosture,
      postureRatio: 1.0,
      staggered: false,
      staggerRemaining: 0,
      invulnerable: false,
      currentAttack: null,
      attackTelegraphActive: false,
      position: [0, 0, -5],
      modelType: 'glb',
      activeClip: '',
    },
    stats: {
      totalDamageDealt: 0,
      damageTaken: 0,
      perfectDodges: 0,
      postureBreaks: 0,
      maxCombo: 0,
      rank: 'SSS',
    },
    audio: {
      unlocked: false,
      muted: false,
      activeBgmState: 'title',
      lastSfx: null,
      errorCount: 0,
    },
    errors: [],
  };

  return {
    ...base,
    ...overrides,
    player: {
      ...base.player,
      ...overrides.player,
      skillCooldowns: {
        ...base.player.skillCooldowns,
        ...overrides.player?.skillCooldowns,
      },
    },
    boss: {
      ...base.boss,
      ...overrides.boss,
    },
    stats: {
      ...base.stats,
      ...overrides.stats,
    },
    audio: {
      ...base.audio,
      ...overrides.audio,
    },
    errors: overrides.errors ? [...overrides.errors] : [],
  };
}

export class DebugBridge {
  private snapshotProvider: () => GameDebugSnapshot;
  private perfProvider?: () => GamePerfSnapshot;
  private hooks: DebugTestHooks = {};
  private errors: string[] = [];
  private installed = false;

  private readonly onWindowError = (ev: ErrorEvent): void => {
    const err = ev.error as { stack?: string; message?: string } | undefined;
    const raw =
      err instanceof Error
        ? (err.stack ?? err.message)
        : (err?.stack ?? err?.message ?? ev.message);
    const message = safeToString(raw) || 'Unknown window error';
    this.pushError(message);
  };

  private readonly onUnhandledRejection = (ev: PromiseRejectionEvent): void => {
    const message = safeToString(ev.reason) || 'Unknown rejection';
    this.pushError(`UnhandledRejection: ${message}`);
  };

  constructor(initialProvider?: () => GameDebugSnapshot) {
    this.snapshotProvider =
      initialProvider ?? (() => createDefaultDebugSnapshot());
  }

  setSnapshotProvider(provider: () => GameDebugSnapshot): void {
    this.snapshotProvider = provider;
  }

  setPerfProvider(provider: () => GamePerfSnapshot): void {
    this.perfProvider = provider;
  }

  setHooks(hooks: DebugTestHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  pushError(message: string): void {
    const normalized = safeToString(message) || 'Unknown error';
    if (this.errors.length >= MAX_CAPTURED_ERRORS) {
      return;
    }
    this.errors.push(normalized);
  }

  getErrors(): readonly string[] {
    return this.errors;
  }

  clearErrors(): void {
    this.errors = [];
  }

  isTestMode(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return new URLSearchParams(window.location.search).get('testMode') === '1';
  }

  install(): GameDebugAPI {
    const api: GameDebugAPI = {
      getState: (): GameDebugSnapshot => {
        const snapshot = this.snapshotProvider();
        const combinedErrors: string[] = [];
        const seen = new Set<string>();
        for (const err of [...snapshot.errors, ...this.errors]) {
          if (!seen.has(err)) {
            seen.add(err);
            combinedErrors.push(err);
          }
        }
        const perf = this.perfProvider ? this.perfProvider() : snapshot.perf;
        return {
          ...snapshot,
          ...(perf ? { perf } : {}),
          errors: combinedErrors.slice(0, MAX_CAPTURED_ERRORS),
        };
      },
      setBossHp: (hp: number): void => {
        this.hooks.setBossHp?.(hp);
      },
      setBossPosture: (posture: number): void => {
        this.hooks.setBossPosture?.(posture);
      },
      readyAllSkills: (): void => {
        this.hooks.readyAllSkills?.();
      },
      triggerBossTestAttack: (attackId?: string): void => {
        this.hooks.triggerBossTestAttack?.(attackId);
      },
      skipCinematic: (): void => {
        this.hooks.skipCinematic?.();
      },
      setPlayerDamageMultiplier: (mult: number): void => {
        this.hooks.setPlayerDamageMultiplier?.(mult);
      },
    };

    if (typeof window !== 'undefined') {
      window.__GAME_DEBUG__ = api;
      if (!this.installed) {
        window.addEventListener('error', this.onWindowError);
        window.addEventListener('unhandledrejection', this.onUnhandledRejection);
        this.installed = true;
      }
    }

    return api;
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      if (this.installed) {
        window.removeEventListener('error', this.onWindowError);
        window.removeEventListener(
          'unhandledrejection',
          this.onUnhandledRejection,
        );
        this.installed = false;
      }
      if (window.__GAME_DEBUG__) {
        delete window.__GAME_DEBUG__;
      }
    }
  }
}
