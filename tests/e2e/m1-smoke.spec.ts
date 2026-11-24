import { expect, test, type Page } from '@playwright/test';
import type { GameDebugSnapshot } from '../../src/types/game.ts';

const CJK_REGEX = /[\u4e00-\u9fff]/;

async function runSmokeCheck(
  page: Page,
  url: string,
  expectedBackend: 'webgpu' | 'webgl2',
): Promise<void> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badStatusResponses: string[] = [];
  const externalRequests: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      badStatusResponses.push(`${res.status()} ${res.url()}`);
    }
  });
  page.on('request', (req) => {
    const reqUrl = req.url();
    if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
      return;
    }
    const parsed = new URL(reqUrl);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      externalRequests.push(reqUrl);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(
    () => {
      const api = (window as { __GAME_DEBUG__?: { getState(): GameDebugSnapshot } })
        .__GAME_DEBUG__;
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
    { timeout: 30_000 },
  );

  // Let multiple frames render through WebGPURenderer / RenderPipeline
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }),
  );

  const snapshot = await page.evaluate(() => {
    return (
      window as { __GAME_DEBUG__?: { getState(): GameDebugSnapshot } }
    ).__GAME_DEBUG__!.getState();
  });

  expect(snapshot.rendererBackend).toBe(expectedBackend);
  expect(snapshot.player.modelType).toBe('glb');
  expect(snapshot.boss.modelType).toBe('glb');
  expect(snapshot.player.activeClip.length).toBeGreaterThan(0);
  expect(snapshot.boss.activeClip.length).toBeGreaterThan(0);
  expect(snapshot.errors).toEqual([]);

  const canvasBox = await page.locator('canvas').boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(canvasBox!.width).toBeGreaterThan(200);
  expect(canvasBox!.height).toBeGreaterThan(200);

  const bodyText = await page.locator('body').innerText();
  expect(CJK_REGEX.test(bodyText)).toBe(false);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(badStatusResponses).toEqual([]);
  expect(externalRequests).toEqual([]);
}

test.describe('M1 Dual-Backend Smoke Suite', () => {
  test('renders rigged GLBs with Metal 3 WebGPU backend and zero errors', async ({
    page,
  }) => {
    await runSmokeCheck(page, '/?testMode=1', 'webgpu');
  });

  test('renders rigged GLBs with ?forceWebGL=1 fallback and zero errors', async ({
    page,
  }) => {
    await runSmokeCheck(page, '/?forceWebGL=1&testMode=1', 'webgl2');
  });
});
