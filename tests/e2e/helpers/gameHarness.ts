import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  COMBAT_TUNING,
  UI_COPY,
  type BossAttackId,
  type GameDebugSnapshot,
  type GamePhase,
  type RankGrade,
  type RendererBackend,
  type Vec3Tuple,
} from '../../../src/types/game.ts';

export { COMBAT_TUNING, UI_COPY };
export type {
  BossAttackId,
  GameDebugSnapshot,
  GamePhase,
  RankGrade,
  RendererBackend,
  Vec3Tuple,
};

export const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export const GAME_REPO_PATH = '/Users/sunqingyu/Documents/ChatGPT/Game';
export const OPENMOTION_REPO_PATH = '/Users/sunqingyu/Documents/ChatGPT/OpenMotion';

export const EXPECTED_GLB_ASSETS: readonly string[] = [
  '/assets/models/player/player_swordsman.glb',
  '/assets/models/player/weapon_katana.glb',
  '/assets/models/boss/boss_titan.glb',
  '/assets/models/boss/boss_weapon.glb',
  '/assets/models/env/arch_banner.glb',
  '/assets/models/env/bell_structure.glb',
  '/assets/models/env/column.glb',
  '/assets/models/env/column_broken.glb',
  '/assets/models/env/dragon_statue.glb',
  '/assets/models/env/main_altar.glb',
];

export const EXPECTED_HDRI_ASSETS: readonly string[] = [
  '/assets/hdri/arena_night.hdr',
  '/assets/hdri/arena_dusk.hdr',
];

export const EXPECTED_AUDIO_ASSETS: readonly string[] = [
  '/assets/audio/bgm/bgm_phase1.ogg',
  '/assets/audio/bgm/bgm_phase2.mp3',
  '/assets/audio/bgm/bgm_victory.ogg',
  '/assets/audio/sfx/boss_roar.m4a',
  '/assets/audio/sfx/boss_roar_2.ogg',
  '/assets/audio/sfx/chime_bell.ogg',
  '/assets/audio/sfx/dodge_cloth_1.ogg',
  '/assets/audio/sfx/dodge_cloth_2.ogg',
  '/assets/audio/sfx/gong_heavy.ogg',
  '/assets/audio/sfx/impact_heavy_1.ogg',
  '/assets/audio/sfx/impact_heavy_2.ogg',
  '/assets/audio/sfx/impact_metal_1.ogg',
  '/assets/audio/sfx/impact_metal_2.ogg',
  '/assets/audio/sfx/knife_slice_1.ogg',
  '/assets/audio/sfx/knife_slice_2.ogg',
  '/assets/audio/sfx/posture_break.ogg',
  '/assets/audio/sfx/sword_heavy.wav',
  '/assets/audio/sfx/sword_slash_1.wav',
  '/assets/audio/sfx/sword_slash_2.wav',
  '/assets/audio/sfx/sword_slash_3.wav',
  '/assets/audio/sfx/sword_slash_4.wav',
];

export const ALL_EXPECTED_ASSETS: readonly string[] = [
  ...EXPECTED_GLB_ASSETS,
  ...EXPECTED_HDRI_ASSETS,
  ...EXPECTED_AUDIO_ASSETS,
];

export const OPENMOTION_STEP0_STATUS_LINES: readonly string[] = [
  ' M docs/product/architecture.md',
  ' M docs/usage.md',
  ' M scripts/npm-runtime.mjs',
  ' M server.ts',
  ' M studio/src/components/editor/useDomEditOverlayRects.ts',
  ' M studio/src/i18n/mvp-ui.json',
  ' M studio/src/i18n/mvp-zh-CN.json',
  ' M studio/src/motion/AssetBrowser.tsx',
  ' M studio/src/motion/CommunityLink.tsx',
  ' M studio/src/motion/McpConnectionPage.tsx',
  ' M studio/src/motion/useWorkspace.test.tsx',
  ' M studio/src/motion/useWorkspace.ts',
  ' M tests/projects.test.ts',
  ' M tests/sessions.test.ts',
  ' M workspace.ts',
  '?? .motion-data-opendesign-devs/',
  '?? .work/',
  '?? claude-watermelon-recreation-comparison.mp4',
  '?? claude-watermelon-recreation.zip',
  '?? claude-watermelon-recreation/',
  '?? docs/images/internal-trial/',
  '?? docs/internal-trial.md',
  '?? docs/production/',
  '?? motion-projects/',
  '?? opendesign-devs-recreation-comparison.mp4',
  '?? opendesign-devs-recreation.zip',
  '?? opendesign-devs-recreation/',
  '?? studio/src/components/editor/useDomEditOverlayRects.test.tsx',
  '?? studio/src/motion/community-feishu.svg',
  '?? tests/source-native-runtime.test.ts',
];

export interface RuntimeGuards {
  readonly consoleErrors: string[];
  readonly shaderErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
  readonly badStatusResponses: string[];
  readonly externalRequests: string[];
  readonly allRequests: string[];
  readonly assetResponseMap: Map<string, number[]>;
  readonly assetRequestUrls: string[];
  resetRecordedNetwork(): void;
  assertClean(snapshot?: GameDebugSnapshot): void;
}

const SHADER_OR_GPU_ERROR_PATTERN =
  /shader|wgsl|glsl|tsl|device\s*lost|pipeline\s*error|validation\s*error|compile\s*error/i;

export function attachRuntimeGuards(page: Page): RuntimeGuards {
  const consoleErrors: string[] = [];
  const shaderErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badStatusResponses: string[] = [];
  const externalRequests: string[] = [];
  const allRequests: string[] = [];
  const assetResponseMap = new Map<string, number[]>();
  const assetRequestUrls: string[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
    if (
      (msg.type() === 'error' || msg.type() === 'warning') &&
      SHADER_OR_GPU_ERROR_PATTERN.test(text)
    ) {
      shaderErrors.push(`[${msg.type()}] ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`);
  });

  page.on('response', (res) => {
    const status = res.status();
    const resUrl = res.url();
    if (status >= 400) {
      badStatusResponses.push(`${status} ${resUrl}`);
    }
    if (resUrl.startsWith('http://') || resUrl.startsWith('https://')) {
      const parsed = new URL(resUrl);
      if (parsed.pathname.startsWith('/assets/')) {
        const list = assetResponseMap.get(parsed.pathname) ?? [];
        list.push(status);
        assetResponseMap.set(parsed.pathname, list);
      }
    }
  });

  page.on('request', (req) => {
    const reqUrl = req.url();
    allRequests.push(reqUrl);
    if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
      return;
    }
    const parsed = new URL(reqUrl);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      externalRequests.push(reqUrl);
    }
    if (parsed.pathname.startsWith('/assets/')) {
      assetRequestUrls.push(reqUrl);
    }
  });

  return {
    consoleErrors,
    shaderErrors,
    pageErrors,
    failedRequests,
    badStatusResponses,
    externalRequests,
    allRequests,
    assetResponseMap,
    assetRequestUrls,
    resetRecordedNetwork(): void {
      failedRequests.length = 0;
      badStatusResponses.length = 0;
      externalRequests.length = 0;
      allRequests.length = 0;
      assetResponseMap.clear();
      assetRequestUrls.length = 0;
    },
    assertClean(snapshot?: GameDebugSnapshot): void {
      expect(consoleErrors, 'consoleErrors').toEqual([]);
      expect(shaderErrors, 'shaderErrors').toEqual([]);
      expect(pageErrors, 'pageErrors').toEqual([]);
      expect(failedRequests, 'failedRequests').toEqual([]);
      expect(badStatusResponses, 'badStatusResponses').toEqual([]);
      expect(externalRequests, 'externalRequests').toEqual([]);
      if (snapshot) {
        expect(snapshot.errors, 'snapshot.errors').toEqual([]);
      }
    },
  };
}

export function buildGameUrl(options?: {
  testMode?: boolean;
  forceWebGL?: boolean;
  path?: string;
  extraParams?: Record<string, string>;
  hash?: string;
}): string {
  const basePath = options?.path ?? '/';
  const params = new URLSearchParams();
  if (options?.forceWebGL) {
    params.set('forceWebGL', '1');
  }
  if (options?.testMode) {
    params.set('testMode', '1');
  }
  if (options?.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) {
      params.set(k, v);
    }
  }
  const query = params.toString();
  const hashPart = options?.hash
    ? options.hash.startsWith('#')
      ? options.hash
      : `#${options.hash}`
    : '';
  return `${basePath}${query ? `?${query}` : ''}${hashPart}`;
}

export async function waitForRafFrames(page: Page, count = 3): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let remaining = frameCount;
        const tick = (): void => {
          remaining -= 1;
          if (remaining <= 0) {
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
}

export async function getDebugState(page: Page): Promise<GameDebugSnapshot> {
  return page.evaluate(() => {
    const api = window.__GAME_DEBUG__;
    if (!api) {
      throw new Error('window.__GAME_DEBUG__ is not installed');
    }
    return api.getState();
  });
}

export async function waitForGameReady(
  page: Page,
  timeoutMs = 30_000,
): Promise<GameDebugSnapshot> {
  await page.waitForFunction(
    () => {
      const api = window.__GAME_DEBUG__;
      if (!api) return false;
      const s = api.getState();
      return (
        s.player.modelType === 'glb' &&
        s.boss.modelType === 'glb' &&
        s.player.activeClip.length > 0 &&
        s.boss.activeClip.length > 0
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  await waitForRafFrames(page, 3);
  return getDebugState(page);
}

export async function launchGame(
  page: Page,
  options?: {
    testMode?: boolean;
    forceWebGL?: boolean;
    path?: string;
    extraParams?: Record<string, string>;
    hash?: string;
    timeoutMs?: number;
  },
): Promise<{ guards: RuntimeGuards; snapshot: GameDebugSnapshot; url: string }> {
  const guards = attachRuntimeGuards(page);
  const url = buildGameUrl(options);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const snapshot = await waitForGameReady(page, options?.timeoutMs ?? 30_000);
  return { guards, snapshot, url };
}

export async function waitForPhase(
  page: Page,
  targetPhase: GamePhase,
  timeoutMs = 15_000,
): Promise<GameDebugSnapshot> {
  await page.waitForFunction(
    (phase) => window.__GAME_DEBUG__?.getState().phase === phase,
    targetPhase,
    { timeout: timeoutMs },
  );
  return getDebugState(page);
}

export async function debugSkipCinematic(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__GAME_DEBUG__?.skipCinematic();
  });
}

export async function debugSetBossHp(page: Page, hp: number): Promise<void> {
  await page.evaluate((value) => {
    window.__GAME_DEBUG__?.setBossHp(value);
  }, hp);
}

export async function debugSetBossPosture(
  page: Page,
  posture: number,
): Promise<void> {
  await page.evaluate((value) => {
    window.__GAME_DEBUG__?.setBossPosture(value);
  }, posture);
}

export async function debugReadyAllSkills(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__GAME_DEBUG__?.readyAllSkills();
  });
}

export async function debugTriggerBossTestAttack(
  page: Page,
  attackId?: BossAttackId,
): Promise<void> {
  await page.evaluate((id) => {
    window.__GAME_DEBUG__?.triggerBossTestAttack(id);
  }, attackId);
}

export async function debugSetPlayerDamageMultiplier(
  page: Page,
  mult: number,
): Promise<void> {
  await page.evaluate((value) => {
    window.__GAME_DEBUG__?.setPlayerDamageMultiplier(value);
  }, mult);
}

export async function enterCombat(
  page: Page,
  options?: { skipIntro?: boolean; timeoutMs?: number },
): Promise<GameDebugSnapshot> {
  const skipIntro = options?.skipIntro ?? true;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const startButton = page.getByRole('button', {
    name: UI_COPY.TITLE_START_CTA,
  });
  await expect(startButton).toBeVisible({ timeout: 10_000 });
  await startButton.click();

  await page.waitForFunction(
    () => {
      const phase = window.__GAME_DEBUG__?.getState().phase;
      return phase !== undefined && phase !== 'TITLE';
    },
    undefined,
    { timeout: 10_000 },
  );

  if (skipIntro) {
    const snap = await getDebugState(page);
    if (snap.phase === 'CINEMATIC_INTRO') {
      await debugSkipCinematic(page);
    }
  }

  return waitForPhase(page, 'PHASE_1', timeoutMs);
}

export async function holdKey(
  page: Page,
  code: string,
  durationMs: number,
): Promise<void> {
  try {
    await page.keyboard.down(code);
    await page.waitForTimeout(durationMs);
  } finally {
    await page.keyboard.up(code);
  }
}

export async function clickCanvasCenter(page: Page): Promise<void> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas boundingBox is null');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function orbitCameraDrag(
  page: Page,
  dx: number,
  dy: number,
  steps = 8,
): Promise<void> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('Canvas boundingBox is null');
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: 'left' });
  try {
    await page.mouse.move(startX + dx, startY + dy, { steps });
  } finally {
    await page.mouse.up({ button: 'left' });
  }
}

export function distanceXZ(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export function radiusXZ(p: Vec3Tuple): number {
  return Math.hypot(p[0], p[2]);
}

export async function moveIntoMeleeRange(
  page: Page,
  maxDistance = 3.4,
  timeoutMs = 5_000,
): Promise<GameDebugSnapshot> {
  const deadline = Date.now() + timeoutMs;
  await page.waitForFunction(
    () => {
      const s = window.__GAME_DEBUG__?.getState();
      return Boolean(s && !s.player.isDodging && !s.skill3Active);
    },
    undefined,
    { timeout: Math.min(timeoutMs, 2_500) },
  );

  let state = await getDebugState(page);
  if (distanceXZ(state.player.position, state.boss.position) <= maxDistance) {
    return state;
  }

  // Probe camera-relative forward vector using KeyW
  const beforeProbe = state.player.position;
  await holdKey(page, 'KeyW', 140);
  state = await getDebugState(page);
  let fx = state.player.position[0] - beforeProbe[0];
  let fz = state.player.position[2] - beforeProbe[2];
  let fLen = Math.hypot(fx, fz);

  while (
    Date.now() < deadline &&
    distanceXZ(state.player.position, state.boss.position) > maxDistance
  ) {
    if (fLen <= 0.05) {
      const retryBefore = state.player.position;
      await holdKey(page, 'KeyW', 140);
      state = await getDebugState(page);
      fx = state.player.position[0] - retryBefore[0];
      fz = state.player.position[2] - retryBefore[2];
      fLen = Math.hypot(fx, fz);
      continue;
    }

    const toBossX = state.boss.position[0] - state.player.position[0];
    const toBossZ = state.boss.position[2] - state.player.position[2];
    const ux = fx / fLen;
    const uz = fz / fLen;
    const candidates: Array<{ key: string; dot: number }> = [
      { key: 'KeyW', dot: ux * toBossX + uz * toBossZ },
      { key: 'KeyS', dot: -ux * toBossX - uz * toBossZ },
      { key: 'KeyD', dot: -uz * toBossX + ux * toBossZ },
      { key: 'KeyA', dot: uz * toBossX - ux * toBossZ },
    ];
    candidates.sort((a, b) => b.dot - a.dot);
    const bestKey = candidates[0]!.key;

    const remainingDist = distanceXZ(state.player.position, state.boss.position);
    const stepMs = remainingDist > 6 ? 260 : 140;
    await holdKey(page, bestKey, stepMs);
    state = await getDebugState(page);
  }

  return state;
}

export async function triggerBasicAttack(
  page: Page,
  method: 'KeyJ' | 'LMB' = 'KeyJ',
): Promise<void> {
  if (method === 'KeyJ') {
    await page.keyboard.press('KeyJ');
  } else {
    await clickCanvasCenter(page);
  }
}

export async function performPerfectDodge(
  page: Page,
  attackId: BossAttackId = 'abyssal_sweep',
): Promise<{ before: GameDebugSnapshot; after: GameDebugSnapshot }> {
  await moveIntoMeleeRange(page, 4.2);
  const before = await getDebugState(page);
  const tuning = COMBAT_TUNING.bossAttacks.find((a) => a.id === attackId);
  const windupMs = (tuning?.windupSeconds ?? 1.1) * 1000;

  await debugTriggerBossTestAttack(page, attackId);
  await page.waitForFunction(
    () => {
      const b = window.__GAME_DEBUG__?.getState().boss;
      return Boolean(b && (b.attackTelegraphActive || b.currentAttack !== null));
    },
    undefined,
    { timeout: 3_000 },
  );

  // Dodge squarely inside the 0.35s perfect-dodge window before active hitbox (world-time scaled)
  const targetWorldSec = Math.max(0.15, (windupMs - 220) / 1000);
  await page.evaluate(
    ({ targetSec, maxDt }) =>
      new Promise<void>((resolve) => {
        let worldElapsed = 0;
        let prev = performance.now();
        const step = (now: number): void => {
          const dt = Math.max(0, Math.min((now - prev) / 1000, maxDt));
          prev = now;
          const s = window.__GAME_DEBUG__?.getState();
          if (
            !s ||
            s.phase === 'TITLE' ||
            s.phase === 'VICTORY' ||
            !s.boss.attackTelegraphActive
          ) {
            resolve();
            return;
          }
          if (!s.paused) {
            worldElapsed += dt * s.timeScale;
          }
          if (worldElapsed >= targetSec) {
            resolve();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { targetSec: targetWorldSec, maxDt: COMBAT_TUNING.maxDeltaSeconds },
  );
  await page.keyboard.press('Space');

  await page.waitForFunction(
    (prevDodges) => {
      const s = window.__GAME_DEBUG__?.getState();
      return Boolean(s && s.bulletTimeActive && s.stats.perfectDodges > prevDodges);
    },
    before.stats.perfectDodges,
    { timeout: 2_500 },
  );

  const after = await getDebugState(page);
  return { before, after };
}

export async function takeBossHit(
  page: Page,
  attackId: BossAttackId = 'shattered_earth_slam',
): Promise<{ before: GameDebugSnapshot; after: GameDebugSnapshot }> {
  await moveIntoMeleeRange(page, 3.5);
  const before = await getDebugState(page);
  await debugTriggerBossTestAttack(page, attackId);

  await page.waitForFunction(
    (prevTaken) => {
      const s = window.__GAME_DEBUG__?.getState();
      return Boolean(s && s.stats.damageTaken > prevTaken);
    },
    before.stats.damageTaken,
    { timeout: 4_000 },
  );

  const after = await getDebugState(page);
  return { before, after };
}

export async function assertNoCjkInDom(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  expect(
    CJK_REGEX.test(bodyText),
    `Unexpected CJK characters in DOM text: ${bodyText.slice(0, 300)}`,
  ).toBe(false);
}

export async function assertCanvasRendered(
  page: Page,
): Promise<{ width: number; height: number }> {
  const canvas = page.locator('#game-root canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(200);
  expect(box!.height).toBeGreaterThan(200);
  const pngBuffer = await canvas.screenshot();
  expect(pngBuffer.byteLength).toBeGreaterThan(2_000);
  return { width: box!.width, height: box!.height };
}

export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const horizontalOverlap = a.x < b.x + b.width && a.x + a.width > b.x;
  const verticalOverlap = a.y < b.y + b.height && a.y + a.height > b.y;
  return horizontalOverlap && verticalOverlap;
}

export function getOpenMotionGitStatusLines(): string[] {
  const raw = execFileSync(
    'git',
    ['-C', OPENMOTION_REPO_PATH, 'status', '--short'],
    { encoding: 'utf8' },
  );
  return raw.split('\n').filter((line) => line.length > 0);
}

export function assertOpenMotionBaselineClean(): void {
  const lines = getOpenMotionGitStatusLines();
  expect(lines).toEqual([...OPENMOTION_STEP0_STATUS_LINES]);
}

export function listGameFilesRecursively(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listGameFilesRecursively(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}
