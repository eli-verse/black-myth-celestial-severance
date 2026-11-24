import './ui/styles.css';
import { AudioManager } from './audio/AudioManager.ts';
import type { PlayerInputFrame } from './combat/CombatSystem.ts';
import { GameStateMachine } from './combat/GameStateMachine.ts';
import { DebugBridge, createDefaultDebugSnapshot } from './debug/DebugBridge.ts';
import { AssetLoader } from './engine/AssetLoader.ts';
import { RendererSystem } from './engine/RendererSystem.ts';
import { TimeScaleSystem } from './engine/TimeScaleSystem.ts';
import { BossEntity } from './entities/BossEntity.ts';
import { PlayerEntity } from './entities/PlayerEntity.ts';
import { ArenaScene } from './scene/ArenaScene.ts';
import { AtmosphereController } from './scene/AtmosphereController.ts';
import { COMBAT_TUNING, type HudSnapshot } from './types/game.ts';
import { HudOverlay } from './ui/HudOverlay.ts';
import { MenuScreens } from './ui/MenuScreens.ts';
import { VfxManager } from './vfx/VfxManager.ts';

const MOVEMENT_OR_SPRINT_KEYS = new Set<string>([
  'KeyW',
  'ArrowUp',
  'KeyS',
  'ArrowDown',
  'KeyA',
  'ArrowLeft',
  'KeyD',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

const DRAG_THRESHOLD_PX = 5;

function blurActiveElement(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

function tryRequestPointerLock(canvas: HTMLCanvasElement): void {
  if (typeof canvas.requestPointerLock !== 'function') {
    return;
  }
  try {
    const maybePromise = canvas.requestPointerLock() as unknown;
    if (
      maybePromise &&
      typeof (maybePromise as Promise<void>).catch === 'function'
    ) {
      (maybePromise as Promise<void>).catch(() => {
        // Pointer lock may be denied in headless or non-gesture contexts; drag-orbit remains active.
      });
    }
  } catch {
    // Synchronous pointer lock rejection fallback.
  }
}

async function bootstrap(): Promise<void> {
  const debugBridge = new DebugBridge();
  debugBridge.install();

  const statusEl = document.getElementById('m1-status-overlay');
  const container = document.getElementById('game-root');
  if (!container) {
    debugBridge.pushError('Missing #game-root container element');
    return;
  }

  const rendererSystem = new RendererSystem();
  const timeScaleSystem = new TimeScaleSystem();
  const assetLoader = new AssetLoader({
    onError: (msg) => {
      debugBridge.pushError(msg);
    },
  });
  const audioManager = new AudioManager(assetLoader);

  debugBridge.setSnapshotProvider(() =>
    createDefaultDebugSnapshot({
      phase: 'TITLE',
      rendererBackend: rendererSystem.backend,
      timeScale: timeScaleSystem.worldTimeScale,
      bulletTimeActive: timeScaleSystem.bulletTimeActive,
      skill3Active: timeScaleSystem.skill3Active,
      player: {
        ...createDefaultDebugSnapshot().player,
        modelType: 'glb',
      },
      boss: {
        ...createDefaultDebugSnapshot().boss,
        modelType: 'glb',
      },
    }),
  );

  try {
    await rendererSystem.init(container);

    const bundle = await assetLoader.loadAll((progress) => {
      if (statusEl && progress.currentKey) {
        statusEl.textContent = `Loading Temple Assets (${progress.loaded}/${progress.total})...`;
      }
    });

    const scene = rendererSystem.scene;
    const canvas = rendererSystem.renderer.domElement;

    const atmosphere = new AtmosphereController({
      scene,
      rendererSystem,
      nightHdri: bundle.hdris.get('hdri_night'),
      duskHdri: bundle.hdris.get('hdri_dusk'),
    });

    const arena = new ArenaScene({
      scene,
      assetLoader,
      atmosphere,
    });
    arena.configureReflectorLayers(rendererSystem.camera);

    const vfx = new VfxManager(scene, assetLoader);

    const player = new PlayerEntity({
      assetLoader,
      arenaRadius: COMBAT_TUNING.arenaRadius,
      onError: (msg) => {
        debugBridge.pushError(msg);
      },
    });

    const boss = new BossEntity({
      assetLoader,
      arenaRadius: COMBAT_TUNING.arenaRadius,
      onError: (msg) => {
        debugBridge.pushError(msg);
      },
    });

    scene.add(player.rootGroup);
    scene.add(boss.rootGroup);

    await rendererSystem.prewarmScene(
      () => {
        player.setPrewarmVisible(true);
        vfx.setPrewarmVisible(true);
      },
      () => {
        player.setPrewarmVisible(false);
        vfx.setPrewarmVisible(false);
      },
    );

    const gameStateMachine = new GameStateMachine({
      player,
      boss,
      timeScaleSystem,
      arena,
      vfx,
      audio: audioManager,
      debugBridge,
      rendererBackend: rendererSystem.backend,
      testMode: debugBridge.isTestMode(),
      cinematicIntroDurationSeconds: debugBridge.isTestMode()
        ? COMBAT_TUNING.introDurationSeconds
        : 8.0,
    });

    const heldKeys = new Set<string>();
    const pendingActions = {
      attackPressed: false,
      dodgePressed: false,
      skill1Pressed: false,
      skill2Pressed: false,
      skill3Pressed: false,
    };

    let isDragging = false;
    let dragMoved = false;
    let dragTravel = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastDragX = 0;
    let lastDragY = 0;
    let lastTimeMs = performance.now();

    const resetInputState = (): void => {
      heldKeys.clear();
      pendingActions.attackPressed = false;
      pendingActions.dodgePressed = false;
      pendingActions.skill1Pressed = false;
      pendingActions.skill2Pressed = false;
      pendingActions.skill3Pressed = false;
      isDragging = false;
      dragMoved = false;
      dragTravel = 0;
    };

    const isPlayableUnpaused = (): boolean =>
      !gameStateMachine.paused &&
      (gameStateMachine.phase === 'PHASE_1' ||
        gameStateMachine.phase === 'PHASE_2');

    const consumeInputFrame = (): PlayerInputFrame => {
      const playable = isPlayableUnpaused();
      const forward =
        playable && (heldKeys.has('KeyW') || heldKeys.has('ArrowUp')) ? 1 : 0;
      const backward =
        playable && (heldKeys.has('KeyS') || heldKeys.has('ArrowDown')) ? 1 : 0;
      const left =
        playable && (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft')) ? 1 : 0;
      const right =
        playable && (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) ? 1 : 0;
      const isSprinting =
        playable &&
        (heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight'));

      const frame: PlayerInputFrame = {
        moveX: right - left,
        moveZ: forward - backward,
        attackPressed: playable && pendingActions.attackPressed,
        dodgePressed: playable && pendingActions.dodgePressed,
        skill1Pressed: playable && pendingActions.skill1Pressed,
        skill2Pressed: playable && pendingActions.skill2Pressed,
        skill3Pressed: playable && pendingActions.skill3Pressed,
        isSprinting,
      };

      pendingActions.attackPressed = false;
      pendingActions.dodgePressed = false;
      pendingActions.skill1Pressed = false;
      pendingActions.skill2Pressed = false;
      pendingActions.skill3Pressed = false;

      return frame;
    };

    // Mount UI overlays above <canvas> inside #game-root
    const hudOverlay = new HudOverlay(container, {
      immersiveCleanMode: !debugBridge.isTestMode(),
    });
    let menuScreens!: MenuScreens;

    const renderUi = (snapshot: HudSnapshot): void => {
      const shouldReleasePointerLock =
        snapshot.paused ||
        snapshot.phase === 'TITLE' ||
        snapshot.phase === 'CINEMATIC_FINISHER' ||
        snapshot.phase === 'VICTORY';
      if (shouldReleasePointerLock && document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
      if (!isPlayableUnpaused()) {
        resetInputState();
      }
      hudOverlay.render(snapshot);
      menuScreens.render(snapshot);
    };

    const refreshUiImmediate = (): void => {
      renderUi(
        gameStateMachine.getHudSnapshot(
          rendererSystem.backend,
          document.pointerLockElement === canvas,
          debugBridge.isTestMode(),
        ),
      );
    };

    const unlockAudioOnGesture = (): void => {
      if (!audioManager.getState().unlocked) {
        void audioManager.unlock();
      }
    };

    menuScreens = new MenuScreens(container, {
      onBeginTrial: () => {
        void audioManager.unlock();
        blurActiveElement();
        resetInputState();
        gameStateMachine.startTrial();
      },
      onResume: () => {
        void audioManager.unlock();
        blurActiveElement();
        resetInputState();
        gameStateMachine.setPaused(false);
      },
      onRestartTrial: () => {
        void audioManager.unlock();
        blurActiveElement();
        resetInputState();
        gameStateMachine.restartTrial();
      },
      onPlayAgain: () => {
        void audioManager.unlock();
        blurActiveElement();
        resetInputState();
        gameStateMachine.restartTrial();
      },
      onToggleMute: () => {
        void audioManager.unlock();
        audioManager.setMuted(!audioManager.getState().muted);
        refreshUiImmediate();
      },
      onMasterVolumeChange: (volume: number) => {
        void audioManager.unlock();
        audioManager.setMasterVolume(volume);
        refreshUiImmediate();
      },
    });

    gameStateMachine.subscribeHud(renderUi);

    if (statusEl) {
      statusEl.hidden = true;
      statusEl.className = 'is-hidden';
      statusEl.style.display = 'none';
      statusEl.textContent = '';
    }

    // Unlock Web Audio on first keyboard or pointer interaction anywhere
    window.addEventListener('keydown', unlockAudioOnGesture, { capture: true });
    window.addEventListener('pointerdown', unlockAudioOnGesture, {
      capture: true,
    });

    // Keyboard Controls
    window.addEventListener('keydown', (ev: KeyboardEvent) => {
      // Allow ESC / Space / Enter to skip active cinematics immediately in live play
      if (
        !debugBridge.isTestMode() &&
        !ev.repeat &&
        (ev.code === 'Escape' || ev.code === 'Space' || ev.code === 'Enter') &&
        (gameStateMachine.phase === 'CINEMATIC_INTRO' ||
          gameStateMachine.phase === 'CINEMATIC_TRANSITION' ||
          gameStateMachine.phase === 'CINEMATIC_FINISHER')
      ) {
        ev.preventDefault();
        gameStateMachine.skipCinematic();
        return;
      }

      if (ev.code === 'Escape' && !ev.repeat) {
        const phase = gameStateMachine.phase;
        if (phase !== 'TITLE' && phase !== 'VICTORY') {
          const nextPaused = !gameStateMachine.paused;
          if (nextPaused) {
            resetInputState();
            if (document.pointerLockElement) {
              document.exitPointerLock?.();
            }
          } else {
            blurActiveElement();
          }
          gameStateMachine.setPaused(nextPaused);
        }
        return;
      }

      if (!isPlayableUnpaused()) {
        return;
      }

      if (
        ev.code === 'Space' ||
        ev.code === 'ArrowUp' ||
        ev.code === 'ArrowDown' ||
        ev.code === 'ArrowLeft' ||
        ev.code === 'ArrowRight'
      ) {
        ev.preventDefault();
      }

      if (MOVEMENT_OR_SPRINT_KEYS.has(ev.code)) {
        heldKeys.add(ev.code);
      }

      if (!ev.repeat) {
        switch (ev.code) {
          case 'KeyJ':
            pendingActions.attackPressed = true;
            break;
          case 'Space':
          case 'ShiftLeft':
          case 'ShiftRight':
            pendingActions.dodgePressed = true;
            break;
          case 'Digit1':
            pendingActions.skill1Pressed = true;
            break;
          case 'Digit2':
            pendingActions.skill2Pressed = true;
            break;
          case 'Digit3':
            pendingActions.skill3Pressed = true;
            break;
          default:
            break;
        }
      }
    });

    window.addEventListener('keyup', (ev: KeyboardEvent) => {
      heldKeys.delete(ev.code);
    });

    // Pointer Lock & Mouse Camera Orbit / Attack Fallback (single mouse family)
    document.addEventListener('pointerlockchange', () => {
      gameStateMachine.setPointerLocked(document.pointerLockElement === canvas);
    });
    document.addEventListener('pointerlockerror', () => {
      gameStateMachine.setPointerLocked(false);
    });

    canvas.addEventListener('mousedown', (ev: MouseEvent) => {
      if (
        !debugBridge.isTestMode() &&
        ev.button === 0 &&
        gameStateMachine.phase === 'CINEMATIC_INTRO'
      ) {
        gameStateMachine.skipCinematic();
        return;
      }
      if (ev.button !== 0 || !isPlayableUnpaused()) {
        return;
      }
      if (document.pointerLockElement !== canvas) {
        tryRequestPointerLock(canvas);
      }

      if (document.pointerLockElement === canvas) {
        pendingActions.attackPressed = true;
      } else {
        isDragging = true;
        dragMoved = false;
        dragTravel = 0;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        lastDragX = ev.clientX;
        lastDragY = ev.clientY;
      }
    });

    window.addEventListener('mousemove', (ev: MouseEvent) => {
      if (!isPlayableUnpaused()) {
        return;
      }
      if (document.pointerLockElement === canvas) {
        if (isDragging) {
          dragTravel += Math.hypot(ev.movementX, ev.movementY);
          if (dragTravel > DRAG_THRESHOLD_PX) {
            dragMoved = true;
          }
        }
        player.applyCameraOrbitDelta(ev.movementX, ev.movementY);
      } else if (isDragging) {
        const dx = ev.clientX - lastDragX;
        const dy = ev.clientY - lastDragY;
        lastDragX = ev.clientX;
        lastDragY = ev.clientY;
        dragTravel += Math.hypot(dx, dy);
        if (
          dragTravel > DRAG_THRESHOLD_PX ||
          Math.hypot(ev.clientX - dragStartX, ev.clientY - dragStartY) > DRAG_THRESHOLD_PX
        ) {
          dragMoved = true;
        }
        player.applyCameraOrbitDelta(dx, dy);
      }
    });

    window.addEventListener('mouseup', (ev: MouseEvent) => {
      if (ev.button !== 0 || !isDragging) {
        return;
      }
      if (!dragMoved && isPlayableUnpaused()) {
        pendingActions.attackPressed = true;
      }
      isDragging = false;
      dragMoved = false;
      dragTravel = 0;
    });

    // Blur / Visibility Guard
    window.addEventListener('blur', () => {
      resetInputState();
      lastTimeMs = performance.now();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        resetInputState();
      }
      lastTimeMs = performance.now();
    });

    // Main Real-Time Loop & Lightweight Perf Telemetry
    let lastCpuTickMs = 0;
    let rollingFps = 60;
    let perfFrameCount = 0;
    let perfWindowStartMs = performance.now();

    debugBridge.setPerfProvider(() => {
      const renderStats = rendererSystem.getPerfStats();
      return {
        drawCalls: renderStats.drawCalls,
        triangles: renderStats.triangles,
        frameCalls: renderStats.frameCalls,
        cpuTickMs: Number(lastCpuTickMs.toFixed(2)),
        fps: Number(rollingFps.toFixed(1)),
      };
    });

    lastTimeMs = performance.now();
    const tick = (nowMs: number): void => {
      const rawDt = Math.max(
        0,
        Math.min((nowMs - lastTimeMs) / 1000, COMBAT_TUNING.maxDeltaSeconds),
      );
      lastTimeMs = nowMs;

      const tickStartMs = performance.now();
      gameStateMachine.update(
        rawDt,
        rendererSystem.camera,
        consumeInputFrame(),
      );
      rendererSystem.render();
      lastCpuTickMs = performance.now() - tickStartMs;

      perfFrameCount += 1;
      const windowElapsedMs = nowMs - perfWindowStartMs;
      if (windowElapsedMs >= 250) {
        rollingFps = (perfFrameCount * 1000) / windowElapsedMs;
        perfFrameCount = 0;
        perfWindowStartMs = nowMs;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    debugBridge.pushError(message);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = '';
      statusEl.style.display = '';
      statusEl.textContent = 'Engine Initialization Failed';
    }
  }
}

void bootstrap();
