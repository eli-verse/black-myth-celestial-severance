// src/ui/HudOverlay.ts

import {
  COMBAT_TUNING,
  UI_COPY,
  type HudSnapshot,
} from '../types/game.ts';

const MAX_CALLOUT_SLOTS = 4;
const MAX_SKILL_SLOTS = 4;

interface SkillCardRefs {
  root: HTMLElement;
  cdFill: HTMLElement;
  keyEl: HTMLElement;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  lastVisible: boolean | null;
  lastClass: string;
  lastKey: string;
  lastName: string;
  lastState: string;
  lastCdPct: string;
}

interface CalloutRefs {
  root: HTMLElement;
  lastVisible: boolean | null;
  lastClass: string;
  lastText: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function toPercentWidth(ratio: number): string {
  return `${(clamp01(ratio) * 100).toFixed(2)}%`;
}

function formatWholeNumber(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return safe.toLocaleString('en-US');
}

function sanitizeNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function formatTenths(value: number): string {
  return `${sanitizeNonNegative(value).toFixed(1)}s`;
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

function setVisibility(el: HTMLElement, visible: boolean, baseClass: string): void {
  el.hidden = !visible;
  el.className = visible ? baseClass : `${baseClass} is-hidden`;
}

export interface HudOverlayOptions {
  /** When true, hides all combat HUD bars, banners, and keybind prompts for an unobstructed cinematic screen. */
  immersiveCleanMode?: boolean;
}

export class HudOverlay {
  private readonly container: HTMLElement;
  private readonly root: HTMLElement;
  private readonly vignetteEl: HTMLElement;
  private readonly letterboxTopEl: HTMLElement;
  private readonly letterboxBottomEl: HTMLElement;
  private readonly immersiveCleanMode: boolean;

  // Boss Bar
  private readonly bossPanel: HTMLElement;
  private readonly bossNameEl: HTMLElement;
  private readonly bossStaggerBadge: HTMLElement;
  private readonly bossHpValueEl: HTMLElement;
  private readonly bossHpFillEl: HTMLElement;
  private readonly bossPostureValueEl: HTMLElement;
  private readonly bossPostureFillEl: HTMLElement;

  // Player Vitals
  private readonly playerPanel: HTMLElement;
  private readonly playerHpValueEl: HTMLElement;
  private readonly playerHpFillEl: HTMLElement;
  private readonly playerShieldValueEl: HTMLElement;
  private readonly playerShieldFillEl: HTMLElement;
  private readonly playerQiReadyBadge: HTMLElement;
  private readonly playerQiValueEl: HTMLElement;
  private readonly playerQiFillEl: HTMLElement;
  private readonly lotusStatusEl: HTMLElement;

  // Skill Bar
  private readonly skillBar: HTMLElement;
  private readonly skillCards: SkillCardRefs[] = [];

  // Combo Counter
  private readonly comboPanel: HTMLElement;
  private readonly comboCountEl: HTMLElement;
  private readonly comboFillEl: HTMLElement;

  // Phase Banner
  private readonly bannerEl: HTMLElement;
  private readonly bannerTitleEl: HTMLElement;
  private readonly bannerSubtitleEl: HTMLElement;

  // Floating Callouts
  private readonly calloutStack: HTMLElement;
  private readonly calloutSlots: CalloutRefs[] = [];

  // Camera/Pause Hint
  private readonly cameraHintEl: HTMLElement;

  // Cached dirty-check state
  private disposed = false;
  private lastVignetteClass = '';
  private lastLetterboxActive: boolean | null = null;

  private lastBossVisible: boolean | null = null;
  private lastBossClass = '';
  private lastBossName = '';
  private lastBossStaggerVisible: boolean | null = null;
  private lastBossStaggerText = '';
  private lastBossHpText = '';
  private lastBossHpWidth = '';
  private lastBossPostureText = '';
  private lastBossPostureWidth = '';

  private lastPlayerVisible: boolean | null = null;
  private lastPlayerHpText = '';
  private lastPlayerHpWidth = '';
  private lastPlayerShieldText = '';
  private lastPlayerShieldWidth = '';
  private lastPlayerQiReady: boolean | null = null;
  private lastPlayerQiText = '';
  private lastPlayerQiWidth = '';
  private lastPlayerQiFillClass = '';
  private lastLotusText = '';
  private lastLotusClass = '';

  private lastSkillBarVisible: boolean | null = null;

  private lastComboVisible: boolean | null = null;
  private lastComboCount = '';
  private lastComboWidth = '';

  private lastBannerVisible: boolean | null = null;
  private lastBannerClass = '';
  private lastBannerTitle = '';
  private lastBannerSubtitle = '';
  private lastBannerSubtitleVisible: boolean | null = null;

  private lastCameraHintVisible: boolean | null = null;

  constructor(container: HTMLElement, options?: HudOverlayOptions) {
    this.container = container;
    this.immersiveCleanMode = Boolean(options?.immersiveCleanMode);
    this.root = createEl('div', 'bm-hud-root');
    this.root.setAttribute('aria-live', 'off');

    // Vignette Overlay
    this.vignetteEl = createEl('div', 'bm-vignette');
    this.root.appendChild(this.vignetteEl);

    // 2.39:1 Widescreen Cinema Letterbox Bars (active during Opening Cinematic)
    this.letterboxTopEl = createEl('div', 'bm-cinema-bar is-top');
    this.letterboxBottomEl = createEl('div', 'bm-cinema-bar is-bottom');
    this.root.appendChild(this.letterboxTopEl);
    this.root.appendChild(this.letterboxBottomEl);

    // Top Boss Bar
    this.bossPanel = createEl('section', 'bm-panel bm-boss-panel is-hidden');
    this.bossPanel.hidden = true;

    const bossHeader = createEl('div', 'bm-boss-header');
    this.bossNameEl = createEl('div', 'bm-boss-name', UI_COPY.BOSS_NAME);
    this.bossStaggerBadge = createEl('span', 'bm-boss-stagger-badge is-hidden');
    this.bossStaggerBadge.hidden = true;
    bossHeader.appendChild(this.bossNameEl);
    bossHeader.appendChild(this.bossStaggerBadge);
    this.bossPanel.appendChild(bossHeader);

    const bossHpBlock = createEl('div', 'bm-meter-block');
    const bossHpMeta = createEl('div', 'bm-meter-meta');
    const bossHpLabel = createEl('span', 'bm-bar-label', UI_COPY.BOSS_HP_LABEL);
    this.bossHpValueEl = createEl('span', 'bm-bar-value', '40,000 / 40,000');
    bossHpMeta.appendChild(bossHpLabel);
    bossHpMeta.appendChild(this.bossHpValueEl);
    const bossHpTrack = createEl('div', 'bm-bar-track');
    this.bossHpFillEl = createEl('div', 'bm-bar-fill is-boss-hp');
    bossHpTrack.appendChild(this.bossHpFillEl);
    bossHpBlock.appendChild(bossHpMeta);
    bossHpBlock.appendChild(bossHpTrack);
    this.bossPanel.appendChild(bossHpBlock);

    const bossPostureBlock = createEl('div', 'bm-meter-block');
    const bossPostureMeta = createEl('div', 'bm-meter-meta');
    const bossPostureLabel = createEl(
      'span',
      'bm-bar-label',
      UI_COPY.BOSS_POSTURE_LABEL,
    );
    this.bossPostureValueEl = createEl('span', 'bm-bar-value', '1,000 / 1,000');
    bossPostureMeta.appendChild(bossPostureLabel);
    bossPostureMeta.appendChild(this.bossPostureValueEl);
    const bossPostureTrack = createEl('div', 'bm-bar-track is-compact');
    this.bossPostureFillEl = createEl('div', 'bm-bar-fill is-boss-posture');
    bossPostureTrack.appendChild(this.bossPostureFillEl);
    bossPostureBlock.appendChild(bossPostureMeta);
    bossPostureBlock.appendChild(bossPostureTrack);
    this.bossPanel.appendChild(bossPostureBlock);
    this.root.appendChild(this.bossPanel);

    // Bottom-Left Player Vitals
    this.playerPanel = createEl('section', 'bm-panel bm-player-panel is-hidden');
    this.playerPanel.hidden = true;

    const pHpBlock = createEl('div', 'bm-meter-block');
    const pHpMeta = createEl('div', 'bm-meter-meta');
    const pHpLabel = createEl('span', 'bm-bar-label', UI_COPY.PLAYER_HP_LABEL);
    this.playerHpValueEl = createEl('span', 'bm-bar-value', '1,000 / 1,000');
    pHpMeta.appendChild(pHpLabel);
    pHpMeta.appendChild(this.playerHpValueEl);
    const pHpTrack = createEl('div', 'bm-bar-track');
    this.playerHpFillEl = createEl('div', 'bm-bar-fill is-player-hp');
    pHpTrack.appendChild(this.playerHpFillEl);
    pHpBlock.appendChild(pHpMeta);
    pHpBlock.appendChild(pHpTrack);
    this.playerPanel.appendChild(pHpBlock);

    const pShieldBlock = createEl('div', 'bm-meter-block');
    const pShieldMeta = createEl('div', 'bm-meter-meta');
    const pShieldLabel = createEl(
      'span',
      'bm-bar-label',
      UI_COPY.PLAYER_SHIELD_LABEL,
    );
    this.playerShieldValueEl = createEl('span', 'bm-bar-value', '250 / 250');
    pShieldMeta.appendChild(pShieldLabel);
    pShieldMeta.appendChild(this.playerShieldValueEl);
    const pShieldTrack = createEl('div', 'bm-bar-track is-compact');
    this.playerShieldFillEl = createEl('div', 'bm-bar-fill is-player-shield');
    pShieldTrack.appendChild(this.playerShieldFillEl);
    pShieldBlock.appendChild(pShieldMeta);
    pShieldBlock.appendChild(pShieldTrack);
    this.playerPanel.appendChild(pShieldBlock);

    const pQiBlock = createEl('div', 'bm-meter-block');
    const pQiMeta = createEl('div', 'bm-meter-meta');
    const pQiLabel = createEl('span', 'bm-bar-label', UI_COPY.PLAYER_QI_LABEL);
    const pQiRight = createEl('div', 'bm-qi-right');
    this.playerQiReadyBadge = createEl('span', 'bm-qi-ready-badge is-hidden', 'READY');
    this.playerQiReadyBadge.hidden = true;
    this.playerQiValueEl = createEl('span', 'bm-bar-value', '100 / 100');
    pQiRight.appendChild(this.playerQiReadyBadge);
    pQiRight.appendChild(this.playerQiValueEl);
    pQiMeta.appendChild(pQiLabel);
    pQiMeta.appendChild(pQiRight);
    const pQiTrack = createEl('div', 'bm-bar-track is-compact');
    this.playerQiFillEl = createEl('div', 'bm-bar-fill is-player-qi');
    pQiTrack.appendChild(this.playerQiFillEl);
    pQiBlock.appendChild(pQiMeta);
    pQiBlock.appendChild(pQiTrack);
    this.playerPanel.appendChild(pQiBlock);

    const lotusRow = createEl('div', 'bm-lotus-row');
    const lotusLabel = createEl('span', 'bm-lotus-label', 'LOTUS WARD');
    this.lotusStatusEl = createEl('span', 'bm-lotus-status', 'READY');
    lotusRow.appendChild(lotusLabel);
    lotusRow.appendChild(this.lotusStatusEl);
    this.playerPanel.appendChild(lotusRow);
    this.root.appendChild(this.playerPanel);

    // Bottom-Center Skill Bar (Basic Combo + 4 HudSkillSlotSnapshot cards)
    this.skillBar = createEl('section', 'bm-skill-bar is-hidden');
    this.skillBar.hidden = true;

    const basicCard = createEl('div', 'bm-skill-card is-ready');
    basicCard.appendChild(createEl('span', 'bm-skill-key', 'LMB / J'));
    basicCard.appendChild(createEl('span', 'bm-skill-name', UI_COPY.SKILL_COMBO_NAME));
    basicCard.appendChild(createEl('span', 'bm-skill-state', 'READY'));
    this.skillBar.appendChild(basicCard);

    for (let i = 0; i < MAX_SKILL_SLOTS; i += 1) {
      const card = createEl('div', 'bm-skill-card is-hidden');
      card.hidden = true;
      const cdFill = createEl('div', 'bm-skill-cd-fill');
      const keyEl = createEl('span', 'bm-skill-key');
      const nameEl = createEl('span', 'bm-skill-name');
      const stateEl = createEl('span', 'bm-skill-state');
      card.appendChild(cdFill);
      card.appendChild(keyEl);
      card.appendChild(nameEl);
      card.appendChild(stateEl);
      this.skillBar.appendChild(card);
      this.skillCards.push({
        root: card,
        cdFill,
        keyEl,
        nameEl,
        stateEl,
        lastVisible: null,
        lastClass: '',
        lastKey: '',
        lastName: '',
        lastState: '',
        lastCdPct: '',
      });
    }
    this.root.appendChild(this.skillBar);

    // Combo Counter
    this.comboPanel = createEl('div', 'bm-panel bm-combo-panel is-hidden');
    this.comboPanel.hidden = true;
    const comboRow = createEl('div', 'bm-combo-row');
    this.comboCountEl = createEl('span', 'bm-combo-count', '0');
    const comboSuffixEl = createEl(
      'span',
      'bm-combo-suffix',
      UI_COPY.PLAYER_COMBO_SUFFIX,
    );
    comboRow.appendChild(this.comboCountEl);
    comboRow.appendChild(comboSuffixEl);
    const comboTrack = createEl('div', 'bm-combo-track');
    this.comboFillEl = createEl('div', 'bm-combo-fill');
    comboTrack.appendChild(this.comboFillEl);
    this.comboPanel.appendChild(comboRow);
    this.comboPanel.appendChild(comboTrack);
    this.root.appendChild(this.comboPanel);

    // Phase Banner
    this.bannerEl = createEl('div', 'bm-banner is-hidden');
    this.bannerEl.hidden = true;
    this.bannerTitleEl = createEl('div', 'bm-banner-title');
    this.bannerSubtitleEl = createEl('div', 'bm-banner-subtitle is-hidden');
    this.bannerSubtitleEl.hidden = true;
    this.bannerEl.appendChild(this.bannerTitleEl);
    this.bannerEl.appendChild(this.bannerSubtitleEl);
    this.root.appendChild(this.bannerEl);

    // Floating Combat Callout Stack (pooled)
    this.calloutStack = createEl('div', 'bm-callout-stack');
    for (let i = 0; i < MAX_CALLOUT_SLOTS; i += 1) {
      const item = createEl('div', 'bm-callout is-hidden');
      item.hidden = true;
      this.calloutStack.appendChild(item);
      this.calloutSlots.push({
        root: item,
        lastVisible: null,
        lastClass: '',
        lastText: '',
      });
    }
    this.root.appendChild(this.calloutStack);

    // Camera / Pause Hint
    this.cameraHintEl = createEl(
      'div',
      'bm-camera-hint is-hidden',
      UI_COPY.CAMERA_HINT,
    );
    this.cameraHintEl.hidden = true;
    this.root.appendChild(this.cameraHintEl);

    this.container.appendChild(this.root);
  }

  render(snapshot: HudSnapshot): void {
    if (this.disposed) {
      return;
    }

    this.renderVignette(snapshot);
    this.renderCinemaLetterbox(snapshot);
    if (this.immersiveCleanMode) {
      this.bossPanel.hidden = true;
      this.playerPanel.hidden = true;
      this.skillBar.hidden = true;
      this.comboPanel.hidden = true;
      this.bannerEl.hidden = true;
      this.calloutStack.hidden = true;
      this.cameraHintEl.hidden = true;
      return;
    }

    this.renderBoss(snapshot);
    this.renderPlayerVitals(snapshot);
    this.renderSkillBar(snapshot);
    this.renderCombo(snapshot);
    this.renderBanner(snapshot);
    this.renderCallouts(snapshot);
    this.renderCameraHint(snapshot);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }

  private renderVignette(snapshot: HudSnapshot): void {
    const active = snapshot.player.visible || snapshot.phase === 'CINEMATIC_FINISHER';
    let nextClass = 'bm-vignette';
    if (active) {
      if (snapshot.player.skill3Active) {
        nextClass += ' is-skill3';
      } else if (snapshot.player.bulletTimeActive) {
        nextClass += ' is-bullet-time';
      }
    }
    if (nextClass !== this.lastVignetteClass) {
      this.vignetteEl.className = nextClass;
      this.lastVignetteClass = nextClass;
    }
  }

  private renderCinemaLetterbox(snapshot: HudSnapshot): void {
    const introP = snapshot.introProgress ?? 0;
    const active =
      snapshot.phase === 'CINEMATIC_INTRO' && introP < 0.9;
    if (active !== this.lastLetterboxActive) {
      this.letterboxTopEl.className = active
        ? 'bm-cinema-bar is-top is-active'
        : 'bm-cinema-bar is-top';
      this.letterboxBottomEl.className = active
        ? 'bm-cinema-bar is-bottom is-active'
        : 'bm-cinema-bar is-bottom';
      this.lastLetterboxActive = active;
    }
  }

  private renderBoss(snapshot: HudSnapshot): void {
    const { boss } = snapshot;
    const bossClass = boss.visible
      ? boss.staggered
        ? 'bm-panel bm-boss-panel is-staggered'
        : 'bm-panel bm-boss-panel'
      : 'bm-panel bm-boss-panel is-hidden';

    if (this.lastBossVisible !== boss.visible || this.lastBossClass !== bossClass) {
      this.bossPanel.hidden = !boss.visible;
      this.bossPanel.className = bossClass;
      this.lastBossVisible = boss.visible;
      this.lastBossClass = bossClass;
    }

    if (!boss.visible) {
      if (this.lastBossStaggerVisible !== false) {
        setVisibility(this.bossStaggerBadge, false, 'bm-boss-stagger-badge');
        this.lastBossStaggerVisible = false;
      }
      if (this.lastBossStaggerText !== '') {
        this.bossStaggerBadge.textContent = '';
        this.lastBossStaggerText = '';
      }
      return;
    }

    const bossName = boss.name || UI_COPY.BOSS_NAME;
    if (bossName !== this.lastBossName) {
      this.bossNameEl.textContent = bossName;
      this.lastBossName = bossName;
    }

    const staggerVisible = boss.staggered;
    const staggerText = staggerVisible
      ? `STAGGERED · ${formatTenths(boss.staggerRemaining)}`
      : '';
    if (this.lastBossStaggerVisible !== staggerVisible) {
      setVisibility(this.bossStaggerBadge, staggerVisible, 'bm-boss-stagger-badge');
      this.lastBossStaggerVisible = staggerVisible;
    }
    if (staggerText !== this.lastBossStaggerText) {
      this.bossStaggerBadge.textContent = staggerText;
      this.lastBossStaggerText = staggerText;
    }

    const hpText = `${formatWholeNumber(boss.hp)} / ${formatWholeNumber(boss.maxHp)}`;
    if (hpText !== this.lastBossHpText) {
      this.bossHpValueEl.textContent = hpText;
      this.lastBossHpText = hpText;
    }
    const hpWidth = toPercentWidth(boss.hpRatio);
    if (hpWidth !== this.lastBossHpWidth) {
      this.bossHpFillEl.style.width = hpWidth;
      this.lastBossHpWidth = hpWidth;
    }

    const postureText = `${formatWholeNumber(boss.posture)} / ${formatWholeNumber(boss.maxPosture)}`;
    if (postureText !== this.lastBossPostureText) {
      this.bossPostureValueEl.textContent = postureText;
      this.lastBossPostureText = postureText;
    }
    const postureWidth = toPercentWidth(boss.postureRatio);
    if (postureWidth !== this.lastBossPostureWidth) {
      this.bossPostureFillEl.style.width = postureWidth;
      this.lastBossPostureWidth = postureWidth;
    }
  }

  private renderPlayerVitals(snapshot: HudSnapshot): void {
    const { player } = snapshot;
    if (this.lastPlayerVisible !== player.visible) {
      setVisibility(this.playerPanel, player.visible, 'bm-panel bm-player-panel');
      this.lastPlayerVisible = player.visible;
    }

    if (!player.visible) {
      return;
    }

    const hpText = `${formatWholeNumber(player.hp)} / ${formatWholeNumber(player.maxHp)}`;
    if (hpText !== this.lastPlayerHpText) {
      this.playerHpValueEl.textContent = hpText;
      this.lastPlayerHpText = hpText;
    }
    const hpWidth = toPercentWidth(player.hpRatio);
    if (hpWidth !== this.lastPlayerHpWidth) {
      this.playerHpFillEl.style.width = hpWidth;
      this.lastPlayerHpWidth = hpWidth;
    }

    const shieldText = `${formatWholeNumber(player.shield)} / ${formatWholeNumber(player.maxShield)}`;
    if (shieldText !== this.lastPlayerShieldText) {
      this.playerShieldValueEl.textContent = shieldText;
      this.lastPlayerShieldText = shieldText;
    }
    const shieldWidth = toPercentWidth(player.shieldRatio);
    if (shieldWidth !== this.lastPlayerShieldWidth) {
      this.playerShieldFillEl.style.width = shieldWidth;
      this.lastPlayerShieldWidth = shieldWidth;
    }

    const skill3Ready =
      snapshot.skills.find((s) => s.id === 'skill3')?.ready ?? false;
    const qiReady =
      player.qi >= COMBAT_TUNING.skill3QiCost && skill3Ready;
    if (this.lastPlayerQiReady !== qiReady) {
      setVisibility(this.playerQiReadyBadge, qiReady, 'bm-qi-ready-badge');
      this.lastPlayerQiReady = qiReady;
    }
    const qiFillClass = qiReady ? 'bm-bar-fill is-player-qi is-ready' : 'bm-bar-fill is-player-qi';
    if (qiFillClass !== this.lastPlayerQiFillClass) {
      this.playerQiFillEl.className = qiFillClass;
      this.lastPlayerQiFillClass = qiFillClass;
    }
    const qiText = `${formatWholeNumber(player.qi)} / ${formatWholeNumber(player.maxQi)}`;
    if (qiText !== this.lastPlayerQiText) {
      this.playerQiValueEl.textContent = qiText;
      this.lastPlayerQiText = qiText;
    }
    const qiWidth = toPercentWidth(player.qiRatio);
    if (qiWidth !== this.lastPlayerQiWidth) {
      this.playerQiFillEl.style.width = qiWidth;
      this.lastPlayerQiWidth = qiWidth;
    }

    const lotusText = player.lotusWardReady
      ? 'READY'
      : formatTenths(player.lotusWardCooldown);
    const lotusClass = player.lotusWardReady
      ? 'bm-lotus-status'
      : 'bm-lotus-status is-cooldown';
    if (lotusText !== this.lastLotusText) {
      this.lotusStatusEl.textContent = lotusText;
      this.lastLotusText = lotusText;
    }
    if (lotusClass !== this.lastLotusClass) {
      this.lotusStatusEl.className = lotusClass;
      this.lastLotusClass = lotusClass;
    }
  }

  private renderSkillBar(snapshot: HudSnapshot): void {
    const visible = snapshot.player.visible;
    if (this.lastSkillBarVisible !== visible) {
      setVisibility(this.skillBar, visible, 'bm-skill-bar');
      this.lastSkillBarVisible = visible;
    }

    if (!visible) {
      return;
    }

    for (let i = 0; i < this.skillCards.length; i += 1) {
      const cardRef = this.skillCards[i]!;
      const slot = snapshot.skills[i];
      const slotVisible = Boolean(slot);
      if (!slot || !slotVisible) {
        if (cardRef.lastVisible !== false) {
          setVisibility(cardRef.root, false, 'bm-skill-card');
          cardRef.lastVisible = false;
        }
        continue;
      }

      const cdIsFinite = Number.isFinite(slot.cooldownRemaining);
      const safeCd = sanitizeNonNegative(slot.cooldownRemaining);
      const onCooldown = safeCd > 0.05;
      const classes = ['bm-skill-card'];
      if (slot.active) {
        classes.push('is-active');
      } else if (onCooldown) {
        classes.push('is-cooldown');
      } else if (slot.ready) {
        classes.push('is-ready');
      }
      if (!slot.qiSufficient) {
        classes.push('is-low-qi');
      }
      const nextClass = classes.join(' ');
      if (cardRef.lastVisible !== true || cardRef.lastClass !== nextClass) {
        cardRef.root.hidden = false;
        cardRef.root.className = nextClass;
        cardRef.lastVisible = true;
        cardRef.lastClass = nextClass;
      }

      if (slot.keyLabel !== cardRef.lastKey) {
        cardRef.keyEl.textContent = slot.keyLabel;
        cardRef.lastKey = slot.keyLabel;
      }
      if (slot.name !== cardRef.lastName) {
        cardRef.nameEl.textContent = slot.name;
        cardRef.lastName = slot.name;
      }

      let stateText = 'READY';
      if (slot.active) {
        stateText = 'ACTIVE';
      } else if (onCooldown) {
        stateText = formatTenths(safeCd);
      } else if (!slot.qiSufficient) {
        stateText = `QI ${slot.qiRequired}`;
      } else if (slot.ready) {
        stateText = 'READY';
      } else if (!cdIsFinite) {
        stateText = formatTenths(slot.cooldownRemaining);
      } else if (safeCd > 0) {
        stateText = '0.1s';
      } else {
        stateText = 'LOCKED';
      }
      if (stateText !== cardRef.lastState) {
        cardRef.stateEl.textContent = stateText;
        cardRef.lastState = stateText;
      }

      const cdRatio =
        onCooldown && Number.isFinite(slot.cooldownTotal) && slot.cooldownTotal > 0
          ? clamp01(safeCd / slot.cooldownTotal)
          : 0;
      const cdPct = `${(cdRatio * 100).toFixed(1)}%`;
      if (cdPct !== cardRef.lastCdPct) {
        cardRef.cdFill.style.height = cdPct;
        cardRef.lastCdPct = cdPct;
      }
    }
  }

  private renderCombo(snapshot: HudSnapshot): void {
    const rawCount = snapshot.player.comboCount;
    const safeCount = Number.isFinite(rawCount) ? Math.max(0, Math.round(rawCount)) : 0;
    const visible = snapshot.player.visible && safeCount > 0;
    if (this.lastComboVisible !== visible) {
      setVisibility(this.comboPanel, visible, 'bm-panel bm-combo-panel');
      this.lastComboVisible = visible;
    }

    if (!visible) {
      return;
    }

    const countText = formatWholeNumber(safeCount);
    if (countText !== this.lastComboCount) {
      this.comboCountEl.textContent = countText;
      this.lastComboCount = countText;
    }

    const fillWidth = toPercentWidth(snapshot.player.comboTimerRatio);
    if (fillWidth !== this.lastComboWidth) {
      this.comboFillEl.style.width = fillWidth;
      this.lastComboWidth = fillWidth;
    }
  }

  private renderBanner(snapshot: HudSnapshot): void {
    const banner = snapshot.banner;
    const visible = Boolean(banner && banner.visible && banner.title.length > 0);
    const nextClass =
      visible && banner ? `bm-banner is-${banner.accent}` : 'bm-banner is-hidden';

    if (this.lastBannerVisible !== visible || this.lastBannerClass !== nextClass) {
      this.bannerEl.hidden = !visible;
      this.bannerEl.className = nextClass;
      this.lastBannerVisible = visible;
      this.lastBannerClass = nextClass;
    }

    if (!visible || !banner) {
      // Clear text so finisher subtitle cannot collide with VICTORY_HEADER in strict DOM queries.
      if (this.lastBannerTitle !== '') {
        this.bannerTitleEl.textContent = '';
        this.lastBannerTitle = '';
      }
      if (this.lastBannerSubtitle !== '') {
        this.bannerSubtitleEl.textContent = '';
        this.lastBannerSubtitle = '';
      }
      if (this.lastBannerSubtitleVisible !== false) {
        setVisibility(this.bannerSubtitleEl, false, 'bm-banner-subtitle');
        this.lastBannerSubtitleVisible = false;
      }
      return;
    }

    if (banner.title !== this.lastBannerTitle) {
      this.bannerTitleEl.textContent = banner.title;
      this.lastBannerTitle = banner.title;
    }

    const subtitle = banner.subtitle ?? '';
    const subtitleVisible = subtitle.length > 0;
    if (this.lastBannerSubtitleVisible !== subtitleVisible) {
      setVisibility(this.bannerSubtitleEl, subtitleVisible, 'bm-banner-subtitle');
      this.lastBannerSubtitleVisible = subtitleVisible;
    }
    if (subtitle !== this.lastBannerSubtitle) {
      this.bannerSubtitleEl.textContent = subtitle;
      this.lastBannerSubtitle = subtitle;
    }
  }

  private renderCallouts(snapshot: HudSnapshot): void {
    const suppressCallouts =
      snapshot.phase === 'TITLE' || snapshot.phase === 'VICTORY';
    const callouts = suppressCallouts ? [] : snapshot.callouts;
    for (let i = 0; i < this.calloutSlots.length; i += 1) {
      const slotRef = this.calloutSlots[i]!;
      const callout = callouts[i];
      if (!callout || callout.text.length === 0) {
        if (slotRef.lastVisible !== false) {
          setVisibility(slotRef.root, false, 'bm-callout');
          slotRef.lastVisible = false;
          slotRef.lastClass = 'bm-callout is-hidden';
        }
        if (slotRef.lastText !== '') {
          slotRef.root.textContent = '';
          slotRef.lastText = '';
        }
        continue;
      }

      const nextClass = `bm-callout is-${callout.tone}`;
      if (slotRef.lastVisible !== true || slotRef.lastClass !== nextClass) {
        slotRef.root.hidden = false;
        slotRef.root.className = nextClass;
        slotRef.lastVisible = true;
        slotRef.lastClass = nextClass;
      }
      if (callout.text !== slotRef.lastText) {
        slotRef.root.textContent = callout.text;
        slotRef.lastText = callout.text;
      }
    }
  }

  private renderCameraHint(snapshot: HudSnapshot): void {
    const visible =
      snapshot.player.visible &&
      !snapshot.paused &&
      (snapshot.phase === 'PHASE_1' || snapshot.phase === 'PHASE_2');
    if (this.lastCameraHintVisible !== visible) {
      setVisibility(this.cameraHintEl, visible, 'bm-camera-hint');
      this.lastCameraHintVisible = visible;
    }
  }
}
