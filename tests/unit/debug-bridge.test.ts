import { describe, expect, it, vi } from 'vitest';
import {
  DebugBridge,
  createDefaultDebugSnapshot,
  safeToString,
} from '../../src/debug/DebugBridge.ts';
import type { GameDebugAPI } from '../../src/types/game.ts';

interface MockWindow {
  __GAME_DEBUG__?: GameDebugAPI;
  location: { search: string };
  addEventListener: (type: string, listener: (ev: unknown) => void) => void;
  removeEventListener: (type: string, listener: (ev: unknown) => void) => void;
  dispatch: (type: string, ev: unknown) => void;
  listenerCount: (type: string) => number;
}

function createMockWindow(search = ''): MockWindow {
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  return {
    location: { search },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, ev) {
      for (const listener of listeners.get(type) ?? []) {
        listener(ev);
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function withMockWindow(
  search: string,
  fn: (mockWindow: MockWindow) => void,
): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const mockWindow = createMockWindow(search);
  Object.defineProperty(globalThis, 'window', {
    value: mockWindow,
    configurable: true,
    writable: true,
  });
  try {
    fn(mockWindow);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'window', originalDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

describe('DebugBridge', () => {
  it('installs window.__GAME_DEBUG__, registers listeners, and cleans up on dispose()', () => {
    withMockWindow('?testMode=1', (mockWindow) => {
      const bridge = new DebugBridge();
      expect(bridge.isTestMode()).toBe(true);

      const api = bridge.install();
      expect(mockWindow.__GAME_DEBUG__).toBe(api);
      expect(mockWindow.listenerCount('error')).toBe(1);
      expect(mockWindow.listenerCount('unhandledrejection')).toBe(1);

      // Re-installing does not duplicate event listeners
      bridge.install();
      expect(mockWindow.listenerCount('error')).toBe(1);
      expect(mockWindow.listenerCount('unhandledrejection')).toBe(1);

      bridge.dispose();
      expect(mockWindow.__GAME_DEBUG__).toBeUndefined();
      expect(mockWindow.listenerCount('error')).toBe(0);
      expect(mockWindow.listenerCount('unhandledrejection')).toBe(0);
    });
  });

  it('captures window error and unhandledrejection safely including Object.create(null)', () => {
    withMockWindow('', (mockWindow) => {
      const bridge = new DebugBridge();
      const api = bridge.install();

      mockWindow.dispatch('error', {
        message: 'Script failure',
        error: new Error('Boom error'),
      });
      mockWindow.dispatch('unhandledrejection', {
        reason: 'plain string rejection',
      });
      mockWindow.dispatch('unhandledrejection', {
        reason: Object.create(null),
      });

      const throwingObj = {
        toString() {
          throw new Error('toString failed');
        },
        get [Symbol.toStringTag]() {
          throw new Error('toStringTag failed');
        },
      };
      mockWindow.dispatch('unhandledrejection', {
        reason: throwingObj,
      });

      // Direct pushError with null-prototype object must never throw
      expect(() =>
        bridge.pushError(Object.create(null) as unknown as string),
      ).not.toThrow();

      expect(safeToString(Object.create(null))).toBe('[object Object]');
      expect(safeToString(throwingObj)).toBe('[unserializable object]');

      const state = api.getState();
      expect(state.errors.length).toBe(5);
      expect(state.errors[0]).toContain('Boom error');
      expect(state.errors[1]).toBe('UnhandledRejection: plain string rejection');
      expect(state.errors[2]).toBe('UnhandledRejection: [object Object]');
      expect(state.errors[3]).toBe('UnhandledRejection: [unserializable object]');
      expect(state.errors[4]).toBe('[object Object]');

      bridge.dispose();
    });
  });

  it('deduplicates errors across snapshot and bridge and caps at 100 entries', () => {
    const snapshotErrors = Array.from({ length: 60 }, (_, i) => `snap-${i}`);
    snapshotErrors.push('shared-dup');

    const bridge = new DebugBridge(() =>
      createDefaultDebugSnapshot({ errors: snapshotErrors }),
    );
    bridge.pushError('shared-dup');
    for (let i = 0; i < 150; i += 1) {
      bridge.pushError(`bridge-${i}`);
    }

    expect(bridge.getErrors()).toHaveLength(100);
    const api = bridge.install();
    const state = api.getState();
    expect(state.errors).toHaveLength(100);
    expect(state.errors.filter((e) => e === 'shared-dup')).toHaveLength(1);
  });

  it('no-ops cleanly when GameDebugAPI hooks are unhooked and forwards when hooked', () => {
    const bridge = new DebugBridge();
    const api = bridge.install();

    expect(() => {
      api.setBossHp(1000);
      api.setBossPosture(0);
      api.readyAllSkills();
      api.triggerBossTestAttack('overhead_cleave');
      api.skipCinematic();
      api.setPlayerDamageMultiplier(5);
    }).not.toThrow();

    const setBossHp = vi.fn();
    const skipCinematic = vi.fn();
    bridge.setHooks({ setBossHp, skipCinematic });

    api.setBossHp(20000);
    api.skipCinematic();
    expect(setBossHp).toHaveBeenCalledWith(20000);
    expect(skipCinematic).toHaveBeenCalledTimes(1);
  });
});
