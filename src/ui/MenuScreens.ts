// src/ui/MenuScreens.ts

import { UI_COPY, type HudSnapshot } from '../types/game.ts';

export interface MenuScreenCallbacks {
  onBeginTrial: () => void;
  onResume: () => void;
  onRestartTrial: () => void;
  onPlayAgain: () => void;
  onToggleMute: () => void;
  onMasterVolumeChange: (volume: number) => void;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function formatWholeNumber(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return safe.toLocaleString('en-US');
}

function formatClearTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.round(safe * 10);
  const mins = Math.floor(totalTenths / 600);
  const wholeSecs = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(mins).padStart(2, '0')}:${String(wholeSecs).padStart(2, '0')}.${tenths}`;
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function createButton(className: string, text: string): HTMLButtonElement {
  const btn = createEl('button', className, text);
  btn.type = 'button';
  btn.setAttribute('type', 'button');
  return btn;
}

function setScreenVisible(
  el: HTMLElement,
  visible: boolean,
  baseClass: string,
): void {
  el.hidden = !visible;
  el.className = visible ? baseClass : `${baseClass} is-hidden`;
}

function safeBlur(el: HTMLElement): void {
  if (typeof el.blur === 'function') {
    el.blur();
  }
}

export class MenuScreens {
  private readonly container: HTMLElement;
  private readonly callbacks: MenuScreenCallbacks;
  private readonly root: HTMLElement;

  // Title Screen
  private readonly titleScreen: HTMLElement;
  private readonly beginBtn: HTMLButtonElement;
  private readonly titleAudioBtn: HTMLButtonElement;

  // Pause Screen
  private readonly pauseScreen: HTMLElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly pauseMuteBtn: HTMLButtonElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly volumeValueEl: HTMLElement;
  private readonly restartBtn: HTMLButtonElement;

  // Victory Screen
  private readonly victoryScreen: HTMLElement;
  private readonly rankGradeEl: HTMLElement;
  private readonly statTimeEl: HTMLElement;
  private readonly statDamageEl: HTMLElement;
  private readonly statDodgesEl: HTMLElement;
  private readonly statPosturesEl: HTMLElement;
  private readonly statComboEl: HTMLElement;
  private readonly statTakenEl: HTMLElement;
  private readonly playAgainBtn: HTMLButtonElement;

  // Event cleanup
  private readonly cleanups: Array<() => void> = [];

  // Dirty-check state
  private disposed = false;
  private isDraggingVolume = false;
  private lastTitleVisible: boolean | null = null;
  private lastPauseVisible: boolean | null = null;
  private lastVictoryVisible: boolean | null = null;
  private lastTitleAudioText = '';
  private lastPauseMuteText = '';
  private lastVolumeNumber: number | null = null;
  private lastVolumeText = '';
  private lastRank = '';
  private lastTimeText = '';
  private lastDamageText = '';
  private lastDodgesText = '';
  private lastPosturesText = '';
  private lastComboText = '';
  private lastTakenText = '';

  constructor(container: HTMLElement, callbacks: MenuScreenCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.root = createEl('div', 'bm-menu-root');

    // -----------------------------------------------------------------------
    // Title Screen
    // -----------------------------------------------------------------------
    this.titleScreen = createEl(
      'section',
      'bm-menu-screen bm-title-screen is-hidden',
    );
    this.titleScreen.hidden = true;
    this.titleScreen.setAttribute('aria-label', UI_COPY.TITLE_MAIN);

    const titleCard = createEl('div', 'bm-title-card');
    titleCard.appendChild(createEl('h1', 'bm-title-main', UI_COPY.TITLE_MAIN));
    titleCard.appendChild(
      createEl('p', 'bm-title-subtitle', UI_COPY.TITLE_SUBTITLE),
    );

    const titleActions = createEl('div', 'bm-title-actions');
    this.beginBtn = createButton(
      'bm-btn bm-btn-primary',
      UI_COPY.TITLE_START_CTA,
    );
    this.titleAudioBtn = createButton('bm-btn bm-btn-subtle', 'SOUND: ON');
    titleActions.appendChild(this.beginBtn);
    titleActions.appendChild(this.titleAudioBtn);
    titleCard.appendChild(titleActions);

    titleCard.appendChild(
      createEl('p', 'bm-title-controls', UI_COPY.TITLE_CONTROLS),
    );
    this.titleScreen.appendChild(titleCard);
    this.root.appendChild(this.titleScreen);

    // -----------------------------------------------------------------------
    // Pause Screen
    // -----------------------------------------------------------------------
    this.pauseScreen = createEl(
      'section',
      'bm-menu-screen bm-pause-screen is-hidden',
    );
    this.pauseScreen.hidden = true;
    this.pauseScreen.setAttribute('role', 'dialog');
    this.pauseScreen.setAttribute('aria-modal', 'true');
    this.pauseScreen.setAttribute('aria-label', UI_COPY.PAUSE_TITLE);

    const pauseCard = createEl('div', 'bm-modal-card');
    pauseCard.appendChild(createEl('h2', 'bm-modal-title', UI_COPY.PAUSE_TITLE));

    const pauseStack = createEl('div', 'bm-menu-stack');
    this.resumeBtn = createButton('bm-btn bm-btn-primary', UI_COPY.PAUSE_RESUME);
    this.pauseMuteBtn = createButton(
      'bm-btn bm-btn-secondary',
      UI_COPY.PAUSE_MUTE,
    );

    const volumeRow = createEl('div', 'bm-volume-row');
    const volumeHeader = createEl('div', 'bm-volume-header');
    const volumeLabel = createEl('label', 'bm-volume-label', UI_COPY.PAUSE_VOLUME);
    volumeLabel.setAttribute('for', 'bm-master-volume');
    this.volumeValueEl = createEl('span', 'bm-volume-value', '85%');
    volumeHeader.appendChild(volumeLabel);
    volumeHeader.appendChild(this.volumeValueEl);

    this.volumeInput = document.createElement('input');
    this.volumeInput.id = 'bm-master-volume';
    this.volumeInput.className = 'bm-volume-slider';
    this.volumeInput.type = 'range';
    this.volumeInput.min = '0';
    this.volumeInput.max = '1';
    this.volumeInput.step = '0.01';
    this.volumeInput.value = '0.85';
    this.volumeInput.setAttribute('type', 'range');
    this.volumeInput.setAttribute('min', '0');
    this.volumeInput.setAttribute('max', '1');
    this.volumeInput.setAttribute('step', '0.01');
    this.volumeInput.setAttribute('aria-label', UI_COPY.PAUSE_VOLUME);

    volumeRow.appendChild(volumeHeader);
    volumeRow.appendChild(this.volumeInput);

    this.restartBtn = createButton(
      'bm-btn bm-btn-secondary',
      UI_COPY.PAUSE_RESTART,
    );

    pauseStack.appendChild(this.resumeBtn);
    pauseStack.appendChild(this.pauseMuteBtn);
    pauseStack.appendChild(volumeRow);
    pauseStack.appendChild(this.restartBtn);
    pauseCard.appendChild(pauseStack);
    this.pauseScreen.appendChild(pauseCard);
    this.root.appendChild(this.pauseScreen);

    // -----------------------------------------------------------------------
    // Victory Screen
    // -----------------------------------------------------------------------
    this.victoryScreen = createEl(
      'section',
      'bm-menu-screen bm-victory-screen is-hidden',
    );
    this.victoryScreen.hidden = true;
    this.victoryScreen.setAttribute('role', 'dialog');
    this.victoryScreen.setAttribute('aria-modal', 'true');
    this.victoryScreen.setAttribute('aria-label', UI_COPY.VICTORY_HEADER);

    const victoryCard = createEl('div', 'bm-modal-card bm-victory-card');
    victoryCard.appendChild(
      createEl('h2', 'bm-modal-title', UI_COPY.VICTORY_HEADER),
    );

    const rankBox = createEl('div', 'bm-rank-box');
    rankBox.appendChild(
      createEl('span', 'bm-rank-label', UI_COPY.VICTORY_RANK_LABEL),
    );
    this.rankGradeEl = createEl('span', 'bm-rank-grade', 'SSS');
    rankBox.appendChild(this.rankGradeEl);
    victoryCard.appendChild(rankBox);

    const statsGrid = createEl('div', 'bm-stats-grid');
    this.statTimeEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_TIME, '00:00.0');
    this.statDamageEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_DAMAGE, '0');
    this.statDodgesEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_DODGES, '0');
    this.statPosturesEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_POSTURES, '0');
    this.statComboEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_COMBO, '0');
    this.statTakenEl = this.appendStatRow(statsGrid, UI_COPY.VICTORY_STAT_TAKEN, '0');
    victoryCard.appendChild(statsGrid);

    this.playAgainBtn = createButton(
      'bm-btn bm-btn-primary',
      UI_COPY.VICTORY_REPLAY_CTA,
    );
    victoryCard.appendChild(this.playAgainBtn);
    this.victoryScreen.appendChild(victoryCard);
    this.root.appendChild(this.victoryScreen);

    this.bindEvents();
    this.container.appendChild(this.root);
  }

  render(snapshot: HudSnapshot): void {
    if (this.disposed) {
      return;
    }

    const showTitle = snapshot.phase === 'TITLE';
    const showVictory = snapshot.phase === 'VICTORY';
    const showPause = snapshot.paused && !showTitle && !showVictory;

    if (this.lastTitleVisible !== showTitle) {
      setScreenVisible(
        this.titleScreen,
        showTitle,
        'bm-menu-screen bm-title-screen',
      );
      this.lastTitleVisible = showTitle;
    }

    if (this.lastPauseVisible !== showPause) {
      setScreenVisible(
        this.pauseScreen,
        showPause,
        'bm-menu-screen bm-pause-screen',
      );
      if (!showPause) {
        this.isDraggingVolume = false;
      }
      this.lastPauseVisible = showPause;
    }

    if (this.lastVictoryVisible !== showVictory) {
      setScreenVisible(
        this.victoryScreen,
        showVictory,
        'bm-menu-screen bm-victory-screen',
      );
      this.lastVictoryVisible = showVictory;
    }

    if (showTitle) {
      const titleAudioText = snapshot.audio.muted ? 'SOUND: OFF' : 'SOUND: ON';
      if (titleAudioText !== this.lastTitleAudioText) {
        this.titleAudioBtn.textContent = titleAudioText;
        this.lastTitleAudioText = titleAudioText;
      }
    }

    if (showPause) {
      const muteText = snapshot.audio.muted
        ? UI_COPY.PAUSE_UNMUTE
        : UI_COPY.PAUSE_MUTE;
      if (muteText !== this.lastPauseMuteText) {
        this.pauseMuteBtn.textContent = muteText;
        this.lastPauseMuteText = muteText;
      }

      const vol = clamp01(snapshot.audio.masterVolume);
      const volText = `${Math.round(vol * 100)}%`;
      if (volText !== this.lastVolumeText) {
        this.volumeValueEl.textContent = volText;
        this.lastVolumeText = volText;
      }
      if (
        !this.isDraggingVolume &&
        (this.lastVolumeNumber === null ||
          Math.abs(vol - this.lastVolumeNumber) > 0.005)
      ) {
        this.volumeInput.value = vol.toFixed(2);
        this.lastVolumeNumber = vol;
      }
    }

    if (showVictory) {
      const { stats } = snapshot;
      if (stats.rank !== this.lastRank) {
        this.rankGradeEl.textContent = stats.rank;
        this.lastRank = stats.rank;
      }

      const timeText = formatClearTime(stats.clearTimeSeconds);
      if (timeText !== this.lastTimeText) {
        this.statTimeEl.textContent = timeText;
        this.lastTimeText = timeText;
      }

      const damageText = formatWholeNumber(stats.totalDamageDealt);
      if (damageText !== this.lastDamageText) {
        this.statDamageEl.textContent = damageText;
        this.lastDamageText = damageText;
      }

      const dodgesText = formatWholeNumber(stats.perfectDodges);
      if (dodgesText !== this.lastDodgesText) {
        this.statDodgesEl.textContent = dodgesText;
        this.lastDodgesText = dodgesText;
      }

      const posturesText = formatWholeNumber(stats.postureBreaks);
      if (posturesText !== this.lastPosturesText) {
        this.statPosturesEl.textContent = posturesText;
        this.lastPosturesText = posturesText;
      }

      const comboText = formatWholeNumber(stats.maxCombo);
      if (comboText !== this.lastComboText) {
        this.statComboEl.textContent = comboText;
        this.lastComboText = comboText;
      }

      const takenText = formatWholeNumber(stats.damageTaken);
      if (takenText !== this.lastTakenText) {
        this.statTakenEl.textContent = takenText;
        this.lastTakenText = takenText;
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }

  private appendStatRow(
    grid: HTMLElement,
    label: string,
    initialValue: string,
  ): HTMLElement {
    grid.appendChild(createEl('span', 'bm-stat-label', label));
    const valEl = createEl('span', 'bm-stat-value', initialValue);
    grid.appendChild(valEl);
    return valEl;
  }

  private addListener(
    target: EventTarget,
    event: string,
    handler: EventListener,
  ): void {
    target.addEventListener(event, handler);
    this.cleanups.push(() => {
      target.removeEventListener(event, handler);
    });
  }

  private bindEvents(): void {
    this.addListener(this.beginBtn, 'click', () => {
      safeBlur(this.beginBtn);
      this.callbacks.onBeginTrial();
    });

    this.addListener(this.titleAudioBtn, 'click', () => {
      safeBlur(this.titleAudioBtn);
      this.callbacks.onToggleMute();
    });

    this.addListener(this.resumeBtn, 'click', () => {
      safeBlur(this.resumeBtn);
      this.callbacks.onResume();
    });

    this.addListener(this.pauseMuteBtn, 'click', () => {
      safeBlur(this.pauseMuteBtn);
      this.callbacks.onToggleMute();
    });

    this.addListener(this.restartBtn, 'click', () => {
      safeBlur(this.restartBtn);
      this.callbacks.onRestartTrial();
    });

    this.addListener(this.playAgainBtn, 'click', () => {
      safeBlur(this.playAgainBtn);
      this.callbacks.onPlayAgain();
    });

    const stopDraggingVolume = (): void => {
      this.isDraggingVolume = false;
    };

    this.addListener(this.volumeInput, 'pointerdown', () => {
      this.isDraggingVolume = true;
    });
    this.addListener(this.volumeInput, 'mousedown', () => {
      this.isDraggingVolume = true;
    });
    this.addListener(this.volumeInput, 'pointerup', stopDraggingVolume);
    this.addListener(this.volumeInput, 'mouseup', stopDraggingVolume);
    this.addListener(this.volumeInput, 'pointercancel', stopDraggingVolume);
    this.addListener(this.volumeInput, 'blur', stopDraggingVolume);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.addListener(window, 'pointerup', stopDraggingVolume);
      this.addListener(window, 'mouseup', stopDraggingVolume);
      this.addListener(window, 'pointercancel', stopDraggingVolume);
    }

    const handleVolumeUpdate = (): void => {
      if (this.volumeInput.value.trim() === '') {
        return;
      }
      const parsed = Number(this.volumeInput.value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const clamped = clamp01(parsed);
      this.lastVolumeNumber = clamped;
      const volText = `${Math.round(clamped * 100)}%`;
      if (volText !== this.lastVolumeText) {
        this.volumeValueEl.textContent = volText;
        this.lastVolumeText = volText;
      }
      this.callbacks.onMasterVolumeChange(clamped);
    };

    this.addListener(this.volumeInput, 'input', handleVolumeUpdate);
    this.addListener(this.volumeInput, 'change', () => {
      this.isDraggingVolume = false;
      handleVolumeUpdate();
    });
  }
}
