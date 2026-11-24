import type { AssetLoader } from '../engine/AssetLoader.ts';
import type {
  AudioInterface,
  BgmState,
  GameDebugSnapshot,
  GamePhase,
  SfxId,
} from '../types/game.ts';

export interface AudioBufferProvider {
  getBundle(): { audioBuffers: Map<string, ArrayBuffer> };
}

const MAX_ACTIVE_SFX_VOICES = 16;
const SFX_THROTTLE_MS = 20;
const BGM_CROSSFADE_SECONDS = 1.0;
const BULLET_TIME_CUTOFF_HZ = 650;
const NORMAL_CUTOFF_HZ = 20000;
const PAUSE_DUCK_GAIN = 0.25;
const DEFAULT_MASTER_VOLUME = 0.92;

const ALL_AUDIO_MANIFEST_KEYS = [
  'bgm_phase1',
  'bgm_phase2',
  'bgm_victory',
  'sfx_sword_slash_1',
  'sfx_sword_slash_2',
  'sfx_sword_slash_3',
  'sfx_sword_slash_4',
  'sfx_sword_heavy',
  'sfx_knife_slice_1',
  'sfx_knife_slice_2',
  'sfx_impact_heavy_1',
  'sfx_impact_heavy_2',
  'sfx_impact_metal_1',
  'sfx_impact_metal_2',
  'sfx_dodge_cloth_1',
  'sfx_dodge_cloth_2',
  'sfx_chime_bell',
  'sfx_gong_heavy',
  'sfx_posture_break',
  'sfx_boss_roar',
  'sfx_boss_roar_2',
] as const;

interface BgmPhaseConfig {
  readonly state: BgmState;
  readonly preferredBufferKey?: string;
  readonly bufferKey: 'bgm_phase1' | 'bgm_phase2' | 'bgm_victory';
  readonly gain: number;
  readonly loop: boolean;
}

const PHASE_BGM_MAP: Record<GamePhase, BgmPhaseConfig> = {
  TITLE: {
    state: 'title',
    preferredBufferKey: 'bgm_wuxia_overture',
    bufferKey: 'bgm_phase1',
    gain: 0.64,
    loop: true,
  },
  CINEMATIC_INTRO: {
    state: 'intro',
    preferredBufferKey: 'bgm_wuxia_overture',
    bufferKey: 'bgm_phase1',
    gain: 0.72,
    loop: true,
  },
  PHASE_1: {
    state: 'phase1',
    preferredBufferKey: 'bgm_phase1_chant_rock',
    bufferKey: 'bgm_phase1',
    gain: 0.68,
    loop: true,
  },
  CINEMATIC_TRANSITION: {
    state: 'transition',
    preferredBufferKey: 'bgm_phase2_deity_choir',
    bufferKey: 'bgm_phase2',
    gain: 0.76,
    loop: true,
  },
  PHASE_2: {
    state: 'phase2',
    preferredBufferKey: 'bgm_phase2_deity_choir',
    bufferKey: 'bgm_phase2',
    gain: 0.72,
    loop: true,
  },
  CINEMATIC_FINISHER: {
    state: 'finisher',
    preferredBufferKey: 'bgm_finisher_kengeki',
    bufferKey: 'bgm_phase2',
    gain: 0.76,
    loop: true,
  },
  VICTORY: {
    state: 'victory',
    preferredBufferKey: 'bgm_victory_wuxia2',
    bufferKey: 'bgm_victory',
    gain: 0.72,
    loop: true,
  },
};

interface SfxVoicePreset {
  readonly preferredBufferKey?: string;
  readonly bufferKey: string;
  readonly gain: number;
  readonly playbackRate: number;
  readonly rateJitter?: number;
}

const SFX_PRESET_MAP: Record<SfxId, SfxVoicePreset> = {
  sword_slash_1: {
    bufferKey: 'sfx_sword_slash_1',
    gain: 0.98,
    playbackRate: 1.0,
    rateJitter: 0.04,
  },
  sword_slash_2: {
    bufferKey: 'sfx_sword_slash_2',
    gain: 1.0,
    playbackRate: 1.04,
    rateJitter: 0.04,
  },
  sword_slash_3: {
    bufferKey: 'sfx_sword_slash_3',
    gain: 1.05,
    playbackRate: 1.02,
    rateJitter: 0.04,
  },
  sword_slash_4: {
    bufferKey: 'sfx_sword_slash_4',
    gain: 1.18,
    playbackRate: 0.95,
    rateJitter: 0.03,
  },
  impact_light: {
    preferredBufferKey: 'sfx_meat_hit_light',
    bufferKey: 'sfx_impact_metal_1',
    gain: 1.15,
    playbackRate: 1.0,
    rateJitter: 0.05,
  },
  impact_heavy: {
    preferredBufferKey: 'sfx_meat_hit_heavy',
    bufferKey: 'sfx_impact_heavy_1',
    gain: 1.28,
    playbackRate: 0.96,
    rateJitter: 0.04,
  },
  impact_counter_crit: {
    preferredBufferKey: 'sfx_meat_hit_slam',
    bufferKey: 'sfx_impact_metal_2',
    gain: 1.38,
    playbackRate: 1.02,
    rateJitter: 0.03,
  },
  dodge_whoosh: {
    bufferKey: 'sfx_dodge_cloth_1',
    gain: 0.85,
    playbackRate: 1.05,
    rateJitter: 0.04,
  },
  perfect_dodge_chime: {
    bufferKey: 'sfx_chime_bell',
    gain: 0.95,
    playbackRate: 1.12,
  },
  skill1_phantom_dash: {
    bufferKey: 'sfx_sword_slash_3',
    gain: 1.05,
    playbackRate: 1.08,
    rateJitter: 0.04,
  },
  skill2_cleave_charge: {
    bufferKey: 'sfx_sword_heavy',
    gain: 1.15,
    playbackRate: 0.94,
  },
  skill2_cleave_slam: {
    preferredBufferKey: 'sfx_meat_hit_slam',
    bufferKey: 'sfx_impact_heavy_2',
    gain: 1.45,
    playbackRate: 0.92,
  },
  skill3_timestop_snap: {
    bufferKey: 'sfx_gong_heavy',
    gain: 1.1,
    playbackRate: 1.15,
  },
  skill3_reality_slash: {
    preferredBufferKey: 'sfx_meat_hit_light',
    bufferKey: 'sfx_knife_slice_2',
    gain: 1.05,
    playbackRate: 1.08,
    rateJitter: 0.05,
  },
  skill3_detonation: {
    preferredBufferKey: 'sfx_meat_hit_slam',
    bufferKey: 'sfx_gong_heavy',
    gain: 1.48,
    playbackRate: 0.86,
  },
  posture_break: {
    preferredBufferKey: 'sfx_meat_hit_slam',
    bufferKey: 'sfx_posture_break',
    gain: 1.42,
    playbackRate: 0.94,
  },
  boss_roar: {
    bufferKey: 'sfx_boss_roar',
    gain: 0.9,
    playbackRate: 0.95,
  },
  boss_slam: {
    bufferKey: 'sfx_impact_heavy_2',
    gain: 0.9,
    playbackRate: 0.84,
  },
  boss_lightning: {
    bufferKey: 'sfx_gong_heavy',
    gain: 0.85,
    playbackRate: 1.28,
  },
  boss_sweep: {
    bufferKey: 'sfx_boss_roar_2',
    gain: 0.82,
    playbackRate: 1.08,
  },
  lotus_ward: {
    bufferKey: 'sfx_chime_bell',
    gain: 0.92,
    playbackRate: 0.92,
  },
  shield_recharge: {
    bufferKey: 'sfx_dodge_cloth_2',
    gain: 0.55,
    playbackRate: 1.25,
  },
  heal_chime: {
    bufferKey: 'sfx_chime_bell',
    gain: 0.65,
    playbackRate: 1.32,
  },
  ui_click: {
    bufferKey: 'sfx_chime_bell',
    gain: 0.45,
    playbackRate: 1.5,
  },
};

interface BgmSlot {
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
  bufferKey: string | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

interface ActiveSfxVoice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
}

function getAudioContextConstructor(): (new () => AudioContext) | null {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class AudioManager implements AudioInterface {
  private readonly bufferProvider?: AssetLoader | AudioBufferProvider;
  private readonly decodedBuffers = new Map<string, AudioBuffer>();
  private readonly lastSfxPlayTimeMs = new Map<SfxId, number>();
  private readonly activeSfxVoices: ActiveSfxVoice[] = [];

  private ctx: AudioContext | null = null;
  private unlockPromise: Promise<void> | null = null;
  private decodingComplete = false;
  private unlocked = false;
  private muted = false;
  private paused = false;
  private bulletTimeActive = false;
  private masterVolume = DEFAULT_MASTER_VOLUME;
  private currentPhase: GamePhase = 'TITLE';
  private activeBgmState: BgmState = 'title';
  private lastSfx: string | null = null;
  private errorCount = 0;
  private disposed = false;

  // Web Audio graph nodes
  private bgmSlots: [BgmSlot, BgmSlot] | null = null;
  private activeBgmSlotIndex: 0 | 1 = 0;
  private bgmDuckGain: GainNode | null = null;
  private bulletTimeFilter: BiquadFilterNode | null = null;
  private sfxGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  constructor(assetLoader?: AssetLoader | AudioBufferProvider) {
    this.bufferProvider = assetLoader;
  }

  async unlock(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.unlockPromise) {
      return this.unlockPromise;
    }

    if (this.ctx) {
      const existingCtx = this.ctx;
      let finishedSync = false;
      const promise = (async () => {
        try {
          if (
            existingCtx.state === 'suspended' &&
            typeof existingCtx.resume === 'function'
          ) {
            await existingCtx.resume();
          }

          if (this.disposed || this.ctx !== existingCtx) {
            return;
          }

          if (!this.bgmSlots || !this.sfxGain || !this.masterGain) {
            this.buildAudioGraph(existingCtx);
          }

          this.unlocked = existingCtx.state === 'running';
          if (!this.unlocked) {
            return;
          }

          if (!this.decodingComplete) {
            await this.decodeAllAudioBuffers(existingCtx);
            if (this.disposed || this.ctx !== existingCtx) {
              return;
            }
            this.decodingComplete = true;
          }

          this.syncBgmPlayback();
        } catch {
          this.errorCount += 1;
        } finally {
          finishedSync = true;
          this.unlockPromise = null;
        }
      })();
      if (!finishedSync) {
        this.unlockPromise = promise;
      }

      return promise;
    }

    const AudioCtxCtor = getAudioContextConstructor();
    if (!AudioCtxCtor) {
      return;
    }

    let finishedSync = false;
    const promise = (async () => {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioCtxCtor();

        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          await ctx.resume();
        }

        if (this.disposed) {
          if (typeof ctx.close === 'function') {
            void ctx.close().catch(() => {});
          }
          return;
        }

        this.ctx = ctx;

        if (!this.bgmSlots || !this.sfxGain || !this.masterGain) {
          this.buildAudioGraph(ctx);
        }
        this.unlocked = ctx.state === 'running';
        if (!this.unlocked) {
          return;
        }

        if (!this.decodingComplete) {
          await this.decodeAllAudioBuffers(ctx);
          if (this.disposed || this.ctx !== ctx) {
            return;
          }
          this.decodingComplete = true;
        }

        this.syncBgmPlayback();
      } catch {
        if (ctx && !this.bgmSlots) {
          if (this.ctx === ctx) {
            this.ctx = null;
          }
          if (typeof ctx.close === 'function') {
            void ctx.close().catch(() => {});
          }
        }
        this.errorCount += 1;
      } finally {
        finishedSync = true;
        this.unlockPromise = null;
      }
    })();
    if (!finishedSync) {
      this.unlockPromise = promise;
    }

    return promise;
  }

  setBgmState(phase: GamePhase): void {
    if (this.disposed) {
      return;
    }
    const config = PHASE_BGM_MAP[phase];
    this.currentPhase = phase;
    this.activeBgmState = config.state;

    if (!this.unlocked || !this.decodingComplete || !this.ctx) {
      return;
    }

    this.syncBgmPlayback();
  }

  setBulletTimeFilter(active: boolean): void {
    if (this.disposed) {
      return;
    }
    this.bulletTimeActive = Boolean(active);
    if (!this.bulletTimeFilter || !this.ctx) {
      return;
    }
    const targetHz = this.bulletTimeActive ? BULLET_TIME_CUTOFF_HZ : NORMAL_CUTOFF_HZ;
    this.setAudioParamSmooth(this.bulletTimeFilter.frequency, targetHz, 0.08);
  }

  playSfx(id: SfxId): void {
    if (this.disposed) {
      return;
    }
    this.lastSfx = id;

    if (!this.unlocked || !this.ctx || !this.sfxGain) {
      return;
    }

    const nowMs =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const prevMs = this.lastSfxPlayTimeMs.get(id);
    if (prevMs !== undefined && nowMs >= prevMs && nowMs - prevMs < SFX_THROTTLE_MS) {
      return;
    }
    this.lastSfxPlayTimeMs.set(id, nowMs);

    const preset = SFX_PRESET_MAP[id];
    const resolvedKey =
      preset.preferredBufferKey && this.decodedBuffers.has(preset.preferredBufferKey)
        ? preset.preferredBufferKey
        : preset.bufferKey;
    let buffer = this.decodedBuffers.get(resolvedKey);
    if (!buffer) {
      buffer = this.createProceduralFallbackBuffer(this.ctx, preset.bufferKey) ?? undefined;
      if (buffer) {
        this.decodedBuffers.set(preset.bufferKey, buffer);
      }
    }
    if (!buffer) {
      return;
    }

    try {
      while (this.activeSfxVoices.length >= MAX_ACTIVE_SFX_VOICES) {
        const oldest = this.activeSfxVoices.shift();
        if (oldest) {
          this.stopAndDisconnectVoice(oldest);
        }
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const jitter = preset.rateJitter
        ? (Math.random() * 2 - 1) * preset.rateJitter
        : 0;
      if (source.playbackRate) {
        source.playbackRate.value = Math.max(0.4, preset.playbackRate + jitter);
      }

      const voiceGain = this.ctx.createGain();
      voiceGain.gain.value = preset.gain;

      source.connect(voiceGain);
      voiceGain.connect(this.sfxGain);

      const voice: ActiveSfxVoice = { source, gainNode: voiceGain };
      this.activeSfxVoices.push(voice);

      source.onended = () => {
        const idx = this.activeSfxVoices.indexOf(voice);
        if (idx !== -1) {
          this.activeSfxVoices.splice(idx, 1);
        }
        this.disconnectVoiceNodes(voice);
      };

      source.start(0);
      this.playRuyiStaffAcousticLayer(id);
    } catch {
      this.errorCount += 1;
    }
  }

  /**
   * Co-triggers Sun Wukong's fierce "呔！(DAI!)" / "嘿！" battle cries on staff swings & skills,
   * plus deep sub-bass chest thump on meaty monster impacts.
   */
  private playRuyiStaffAcousticLayer(id: SfxId): void {
    const ctx = this.ctx;
    const out = this.sfxGain;
    if (!ctx || !out || this.disposed || typeof ctx.createGain !== 'function') {
      return;
    }

    try {
      // 1. Sun Wukong Battle Cries ("呔！", "嘿！", "呔！破！")
      let voiceKey: string | null = null;
      let voiceGainVal = 1.0;
      let voiceRate = 1.0;
      if (id === 'sword_slash_1') {
        voiceKey = 'sfx_wukong_dai_1';
        voiceGainVal = 1.05;
        voiceRate = 1.0 + (Math.random() - 0.5) * 0.05;
      } else if (id === 'sword_slash_4') {
        voiceKey = 'sfx_wukong_dai_1';
        voiceGainVal = 1.25;
        voiceRate = 0.96;
      } else if (id === 'sword_slash_2' || id === 'sword_slash_3') {
        voiceKey = 'sfx_wukong_hei_1';
        voiceGainVal = 0.88;
        voiceRate = id === 'sword_slash_3' ? 1.06 : 0.98;
      } else if (
        id === 'skill1_phantom_dash' ||
        id === 'skill2_cleave_charge' ||
        id === 'skill3_timestop_snap'
      ) {
        voiceKey = 'sfx_wukong_dai_2';
        voiceGainVal = 1.32;
        voiceRate = id === 'skill2_cleave_charge' ? 0.98 : 1.02;
      }

      if (voiceKey && this.decodedBuffers.has(voiceKey)) {
        const vBuf = this.decodedBuffers.get(voiceKey)!;
        const vSrc = ctx.createBufferSource();
        const vGain = ctx.createGain();
        vSrc.buffer = vBuf;
        if (vSrc.playbackRate) {
          vSrc.playbackRate.value = voiceRate;
        }
        vGain.gain.value = voiceGainVal;
        vSrc.connect(vGain);
        vGain.connect(out);
        vSrc.onended = () => {
          try {
            vSrc.disconnect();
            vGain.disconnect();
          } catch {
            // Ignore cleanup errors
          }
        };
        vSrc.start(0);
      }

      // 2. Deep 42Hz sub-bass chest thump on meaty monster impacts
      if (
        typeof ctx.createOscillator === 'function' &&
        (id === 'impact_light' ||
          id === 'impact_heavy' ||
          id === 'impact_counter_crit' ||
          id === 'skill2_cleave_slam' ||
          id === 'skill3_detonation' ||
          id === 'posture_break')
      ) {
        const now = ctx.currentTime;
        const isColossal =
          id === 'skill2_cleave_slam' ||
          id === 'skill3_detonation' ||
          id === 'posture_break';
        const isHeavy =
          isColossal || id === 'impact_heavy' || id === 'impact_counter_crit';

        const subOsc = ctx.createOscillator();
        const subGain = ctx.createGain();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(isColossal ? 195 : isHeavy ? 165 : 140, now);
        subOsc.frequency.exponentialRampToValueAtTime(isColossal ? 36 : 44, now + 0.14);
        subGain.gain.setValueAtTime(isColossal ? 0.95 : isHeavy ? 0.78 : 0.58, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + (isColossal ? 0.36 : 0.22));
        subOsc.connect(subGain);
        subGain.connect(out);
        subOsc.start(now);
        subOsc.stop(now + (isColossal ? 0.38 : 0.24));
      }
    } catch {
      // Optional acoustic enhancement layer; never interrupt core sample playback
    }
  }

  setMuted(muted: boolean): void {
    if (this.disposed) {
      return;
    }
    this.muted = Boolean(muted);
    this.applyMasterGain(true);
  }

  setMasterVolume(vol: number): void {
    if (this.disposed || !Number.isFinite(vol)) {
      return;
    }
    this.masterVolume = Math.max(0, Math.min(1, vol));
    this.applyMasterGain(true);
  }

  setPaused(paused: boolean): void {
    if (this.disposed) {
      return;
    }
    this.paused = Boolean(paused);
    if (!this.bgmDuckGain || !this.ctx) {
      return;
    }
    const targetDuck = this.paused ? PAUSE_DUCK_GAIN : 1.0;
    this.setAudioParamSmooth(this.bgmDuckGain.gain, targetDuck, 0.08);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  getState(): GameDebugSnapshot['audio'] {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      activeBgmState: this.activeBgmState,
      lastSfx: this.lastSfx,
      errorCount: this.errorCount,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unlocked = false;
    this.decodingComplete = false;

    if (this.bgmSlots) {
      for (const slot of this.bgmSlots) {
        this.clearBgmSlot(slot);
        try {
          slot.gainNode.disconnect();
        } catch {
          // Ignore disconnect errors on teardown
        }
      }
      this.bgmSlots = null;
    }

    while (this.activeSfxVoices.length > 0) {
      const voice = this.activeSfxVoices.pop();
      if (voice) {
        this.stopAndDisconnectVoice(voice);
      }
    }

    const nodes: Array<{ disconnect?: () => void } | null> = [
      this.bgmDuckGain,
      this.bulletTimeFilter,
      this.sfxGain,
      this.masterGain,
      this.compressor,
    ];
    for (const node of nodes) {
      try {
        node?.disconnect?.();
      } catch {
        // Ignore disconnect errors on teardown
      }
    }

    this.bgmDuckGain = null;
    this.bulletTimeFilter = null;
    this.sfxGain = null;
    this.masterGain = null;
    this.compressor = null;

    if (this.ctx) {
      const ctxToClose = this.ctx;
      this.ctx = null;
      if (typeof ctxToClose.close === 'function') {
        void ctxToClose.close().catch(() => {});
      }
    }

    this.decodedBuffers.clear();
    this.lastSfxPlayTimeMs.clear();
  }

  private buildAudioGraph(ctx: AudioContext): void {
    const slotAGain = ctx.createGain();
    const slotBGain = ctx.createGain();
    slotAGain.gain.value = 0;
    slotBGain.gain.value = 0;

    const bgmDuckGain = ctx.createGain();
    bgmDuckGain.gain.value = this.paused ? PAUSE_DUCK_GAIN : 1.0;

    const bulletTimeFilter = ctx.createBiquadFilter();
    bulletTimeFilter.type = 'lowpass';
    bulletTimeFilter.frequency.value = this.bulletTimeActive
      ? BULLET_TIME_CUTOFF_HZ
      : NORMAL_CUTOFF_HZ;
    if (bulletTimeFilter.Q) {
      bulletTimeFilter.Q.value = 0.707;
    }

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = 1.26;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.muted ? 0 : this.masterVolume;

    const compressor = ctx.createDynamicsCompressor();
    if (compressor.threshold) compressor.threshold.value = -14;
    if (compressor.knee) compressor.knee.value = 18;
    if (compressor.ratio) compressor.ratio.value = 4;
    if (compressor.attack) compressor.attack.value = 0.003;
    if (compressor.release) compressor.release.value = 0.25;

    // BGM branch: dual crossfade gains -> bgmDuckGain -> bulletTimeFilter -> masterGain
    slotAGain.connect(bgmDuckGain);
    slotBGain.connect(bgmDuckGain);
    bgmDuckGain.connect(bulletTimeFilter);
    bulletTimeFilter.connect(masterGain);

    // SFX branch: sfxGain -> masterGain
    sfxGain.connect(masterGain);

    // Master out: masterGain -> compressor -> destination
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    this.bgmSlots = [
      { gainNode: slotAGain, source: null, bufferKey: null, stopTimer: null },
      { gainNode: slotBGain, source: null, bufferKey: null, stopTimer: null },
    ];
    this.activeBgmSlotIndex = 0;
    this.bgmDuckGain = bgmDuckGain;
    this.bulletTimeFilter = bulletTimeFilter;
    this.sfxGain = sfxGain;
    this.masterGain = masterGain;
    this.compressor = compressor;
  }

  private async decodeAllAudioBuffers(ctx: AudioContext): Promise<void> {
    const rawBuffers = this.bufferProvider?.getBundle().audioBuffers;
    const keys = new Set<string>(ALL_AUDIO_MANIFEST_KEYS);
    if (rawBuffers) {
      for (const key of rawBuffers.keys()) {
        keys.add(key);
      }
    }

    await Promise.all(
      Array.from(keys, async (key) => {
        if (this.disposed || this.ctx !== ctx) {
          return;
        }
        const raw = rawBuffers?.get(key);
        if (raw && raw.byteLength > 0 && typeof ctx.decodeAudioData === 'function') {
          try {
            const decoded = await ctx.decodeAudioData(raw.slice(0));
            if (this.disposed || this.ctx !== ctx) {
              return;
            }
            if (decoded && decoded.length > 0) {
              this.decodedBuffers.set(key, decoded);
              return;
            }
          } catch {
            // Per-file codec fallback (e.g. headless Chromium lacking AAC for .m4a).
            // Never increment errorCount or perform external fetches.
          }
        }

        if (this.disposed || this.ctx !== ctx) {
          return;
        }
        const fallback = this.createProceduralFallbackBuffer(ctx, key);
        if (fallback) {
          this.decodedBuffers.set(key, fallback);
        }
      }),
    );
  }

  private syncBgmPlayback(): void {
    if (this.disposed || !this.ctx || !this.bgmSlots) {
      return;
    }

    const config = PHASE_BGM_MAP[this.currentPhase];
    const resolvedKey =
      config.preferredBufferKey && this.decodedBuffers.has(config.preferredBufferKey)
        ? config.preferredBufferKey
        : config.bufferKey;
    let buffer = this.decodedBuffers.get(resolvedKey);
    if (!buffer) {
      buffer = this.createProceduralFallbackBuffer(this.ctx, config.bufferKey) ?? undefined;
      if (buffer) {
        this.decodedBuffers.set(config.bufferKey, buffer);
      }
    }
    if (!buffer) {
      return;
    }

    const currentSlot = this.bgmSlots[this.activeBgmSlotIndex];
    const nextSlotIndex: 0 | 1 = this.activeBgmSlotIndex === 0 ? 1 : 0;
    const nextSlot = this.bgmSlots[nextSlotIndex];

    // If the active slot is already playing the target buffer, smoothly adjust gain only.
    if (currentSlot.source && currentSlot.bufferKey === resolvedKey) {
      this.setAudioParamSmooth(
        currentSlot.gainNode.gain,
        config.gain,
        BGM_CROSSFADE_SECONDS * 0.25,
      );
      return;
    }

    try {
      // Fade out current slot if it has an active source
      if (currentSlot.source) {
        this.setAudioParamSmooth(
          currentSlot.gainNode.gain,
          0,
          BGM_CROSSFADE_SECONDS * 0.28,
        );
        if (currentSlot.stopTimer !== null) {
          clearTimeout(currentSlot.stopTimer);
        }
        const slotToClear = currentSlot;
        slotToClear.stopTimer = setTimeout(() => {
          if (!this.disposed) {
            this.clearBgmSlot(slotToClear);
          }
        }, Math.ceil(BGM_CROSSFADE_SECONDS * 1100));
      }

      // Prepare and fade in the new slot
      this.clearBgmSlot(nextSlot);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = config.loop;
      source.connect(nextSlot.gainNode);

      const now = this.ctx.currentTime ?? 0;
      if (typeof nextSlot.gainNode.gain.setValueAtTime === 'function') {
        nextSlot.gainNode.gain.setValueAtTime(0, now);
      } else {
        nextSlot.gainNode.gain.value = 0;
      }

      source.start(0);
      nextSlot.source = source;
      nextSlot.bufferKey = resolvedKey;
      this.activeBgmSlotIndex = nextSlotIndex;

      this.setAudioParamSmooth(
        nextSlot.gainNode.gain,
        config.gain,
        BGM_CROSSFADE_SECONDS * 0.28,
      );
    } catch {
      this.errorCount += 1;
    }
  }

  private clearBgmSlot(slot: BgmSlot): void {
    if (slot.stopTimer !== null) {
      clearTimeout(slot.stopTimer);
      slot.stopTimer = null;
    }
    if (slot.source) {
      try {
        slot.source.stop();
      } catch {
        // Ignore if already stopped
      }
      try {
        slot.source.disconnect();
      } catch {
        // Ignore disconnect error
      }
      slot.source = null;
    }
    slot.bufferKey = null;
  }

  private applyMasterGain(immediate = false): void {
    if (!this.masterGain || !this.ctx || this.disposed) {
      return;
    }
    const target = this.muted ? 0 : this.masterVolume;
    if (immediate) {
      const now = this.ctx.currentTime ?? 0;
      if (typeof this.masterGain.gain.cancelScheduledValues === 'function') {
        try {
          this.masterGain.gain.cancelScheduledValues(now);
        } catch {
          // Ignore
        }
      }
      this.masterGain.gain.value = target;
    } else {
      this.setAudioParamSmooth(this.masterGain.gain, target, 0.02);
    }
  }

  private setAudioParamSmooth(
    param: AudioParam | undefined,
    targetValue: number,
    timeConstant: number,
  ): void {
    if (!param || !this.ctx) {
      return;
    }
    const now = this.ctx.currentTime ?? 0;
    try {
      if (typeof param.cancelScheduledValues === 'function') {
        param.cancelScheduledValues(now);
      }
      if (typeof param.setTargetAtTime === 'function') {
        param.setTargetAtTime(targetValue, now, timeConstant);
        return;
      }
    } catch {
      // Fallback to direct assignment below
    }
    param.value = targetValue;
  }

  private stopAndDisconnectVoice(voice: ActiveSfxVoice): void {
    try {
      voice.source.onended = null;
      voice.source.stop();
    } catch {
      // Ignore if already ended
    }
    this.disconnectVoiceNodes(voice);
  }

  private disconnectVoiceNodes(voice: ActiveSfxVoice): void {
    try {
      voice.source.disconnect();
    } catch {
      // Ignore
    }
    try {
      voice.gainNode.disconnect();
    } catch {
      // Ignore
    }
  }

  private createProceduralFallbackBuffer(
    ctx: AudioContext,
    key: string,
  ): AudioBuffer | null {
    if (typeof ctx.createBuffer !== 'function') {
      return null;
    }

    const sampleRate =
      typeof ctx.sampleRate === 'number' && ctx.sampleRate > 0
        ? ctx.sampleRate
        : 44100;

    let durationSeconds = 0.35;
    if (key.startsWith('bgm_')) {
      durationSeconds = 4.0;
    } else if (key.includes('roar')) {
      durationSeconds = 1.1;
    } else if (key.includes('gong') || key.includes('posture_break')) {
      durationSeconds = 1.0;
    } else if (key.includes('chime')) {
      durationSeconds = 0.6;
    } else if (key.includes('slash') || key.includes('slice') || key.includes('dodge')) {
      durationSeconds = 0.24;
    }

    const frameCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    if (!buffer || typeof buffer.getChannelData !== 'function') {
      return buffer;
    }

    const data = buffer.getChannelData(0);

    if (key.startsWith('bgm_')) {
      // Seamless loopable dark-myth drone chord (integer cycles over 4.0s)
      const rootHz =
        key === 'bgm_phase2' ? 110 : key === 'bgm_victory' ? 130.81 : 98;
      const fifthHz = rootHz * 1.5;
      const octaveHz = rootHz * 2;
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const swell = 0.78 + 0.22 * Math.sin((2 * Math.PI * t) / durationSeconds);
        const s =
          0.45 * Math.sin(2 * Math.PI * rootHz * t) +
          0.25 * Math.sin(2 * Math.PI * fifthHz * t) +
          0.15 * Math.sin(2 * Math.PI * octaveHz * t);
        data[i] = s * 0.22 * swell;
      }
      return buffer;
    }

    if (key.includes('roar')) {
      // Deep resonant beast roar (descending sawtooth + sub rumble + breath noise)
      let noiseState = 0x13579bdf;
      let lp = 0;
      for (let i = 0; i < frameCount; i += 1) {
        const u = i / frameCount;
        const t = i / sampleRate;
        const env = Math.min(1, u / 0.08) * Math.pow(1 - u, 1.35);
        const freq = 72 - 32 * u + 6 * Math.sin(2 * Math.PI * 9 * t);
        const saw = 2 * ((t * freq) % 1) - 1;
        const sub = Math.sin(2 * Math.PI * (freq * 0.5) * t);
        noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
        const white = (noiseState / 0xffffffff) * 2 - 1;
        lp = lp * 0.88 + white * 0.12;
        data[i] = (saw * 0.35 + sub * 0.4 + lp * 0.45) * env * 0.55;
      }
      return buffer;
    }

    if (key.includes('chime')) {
      // Crystalline pentatonic bell chime
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const u = i / frameCount;
        const env = Math.min(1, u / 0.015) * Math.exp(-5.5 * u);
        const fundamental = Math.sin(2 * Math.PI * 880 * t);
        const overtone1 = 0.45 * Math.sin(2 * Math.PI * 1760 * t);
        const overtone2 = 0.25 * Math.sin(2 * Math.PI * 2637 * t);
        data[i] = (fundamental + overtone1 + overtone2) * env * 0.35;
      }
      return buffer;
    }

    if (key.includes('gong') || key.includes('posture_break')) {
      // Heavy bronze gong / posture shatter
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const u = i / frameCount;
        const env = Math.min(1, u / 0.01) * Math.exp(-3.4 * u);
        const body =
          Math.sin(2 * Math.PI * 110 * t) +
          0.6 * Math.sin(2 * Math.PI * 167 * t) +
          0.4 * Math.sin(2 * Math.PI * 283 * t) +
          0.25 * Math.sin(2 * Math.PI * 421 * t);
        data[i] = body * env * 0.3;
      }
      return buffer;
    }

    if (key.includes('impact')) {
      // Punchy low impact + metallic transient
      let seed = 0x2468ace1;
      for (let i = 0; i < frameCount; i += 1) {
        const t = i / sampleRate;
        const u = i / frameCount;
        const env = Math.exp(-9.0 * u);
        const pitch = 140 * Math.exp(-6.0 * u) + 38;
        const thud = Math.sin(2 * Math.PI * pitch * t);
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = ((seed / 0xffffffff) * 2 - 1) * Math.exp(-16 * u);
        data[i] = (thud * 0.65 + noise * 0.35) * env * 0.55;
      }
      return buffer;
    }

    // Sword slash / slice / cloth whoosh fallback
    let seed = 0x9e3779b9;
    let prev = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const u = i / frameCount;
      const env = Math.sin(Math.PI * u) * Math.exp(-3.0 * u);
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 0xffffffff) * 2 - 1;
      const hp = white - prev * 0.7;
      prev = white;
      data[i] = hp * env * 0.42;
    }
    return buffer;
  }
}
