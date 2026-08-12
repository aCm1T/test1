import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import {
  CAPTURE_DEBUG_VIEWS,
  CAPTURE_RESOLUTIONS,
  CAPTURE_SCENARIO_DEFS,
} from './lib/nightglass-capture-integrity.mjs';
import {
  assertReleaseGate,
  isReleaseCaptureRequested,
  withReleaseCaptureFlag,
} from './lib/nightglass-release-capture.mjs';

const OUT = path.resolve(process.env.SCREENSHOT_DIR ?? 'artifacts/screenshots');
const BASE_URL = process.env.GAME_URL ?? 'http://127.0.0.1:4173/';
const RELEASE_CAPTURE = isReleaseCaptureRequested(BASE_URL, process.env.CAPTURE_RELEASE);
const CAPTURE_FRAME_BUFFER = !RELEASE_CAPTURE && process.env.CAPTURE_FRAME_BUFFER === '1';
const CANVAS_ONLY = process.env.CAPTURE_CANVAS_ONLY === '1';
const SKIP_MENU = process.env.CAPTURE_SKIP_MENU === '1';
const SKIP_TIMING = process.env.CAPTURE_SKIP_TIMING === '1';
const releaseCaptureUrl = withReleaseCaptureFlag(BASE_URL, RELEASE_CAPTURE);
const captureUrl = new URL(releaseCaptureUrl);
if (CAPTURE_FRAME_BUFFER) captureUrl.searchParams.set('qaCaptureBuffer', '1');
const CAPTURE_URL = captureUrl.toString();
const QUICK = process.env.CAPTURE_QUICK === '1';
const MATRIX = process.env.CAPTURE_MATRIX === '1';
const DEBUG_ONLY = process.env.CAPTURE_DEBUG_ONLY === '1';
const SCENARIO_FILTER = process.env.CAPTURE_SCENARIOS
  ?.split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const SKIP_DEBUG_VIEWS = process.env.CAPTURE_SKIP_DEBUG === '1';
const REQUESTED_VIEWPORT = {
  width: Number(process.env.CAPTURE_WIDTH ?? 1920),
  height: Number(process.env.CAPTURE_HEIGHT ?? 1080),
};
const RESOLUTIONS = MATRIX
  ? Object.entries(CAPTURE_RESOLUTIONS).map(([label, size]) => ({ label, ...size }))
  : [{ label: `${REQUESTED_VIEWPORT.width}x${REQUESTED_VIEWPORT.height}`, ...REQUESTED_VIEWPORT }];

const SCENARIOS = CAPTURE_SCENARIO_DEFS;

const scenariosByName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
const SELECTED_SCENARIOS = SCENARIO_FILTER
  ? SCENARIO_FILTER.map((name) => {
    const scenario = scenariosByName.get(name);
    if (!scenario) throw new Error(`unknown capture scenario: ${name}`);
    return scenario;
  })
  : [...SCENARIOS];

const DEBUG_VIEWS = CAPTURE_DEBUG_VIEWS;

function ensureParent(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function canvasShot(page, filename) {
  ensureParent(filename);
  const data = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return canvas.toDataURL('image/png');
  });
  if (!data) throw new Error(`no canvas for ${filename}`);
  fs.writeFileSync(filename, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

async function fullShot(page, filename) {
  ensureParent(filename);
  await page.screenshot({
    path: filename,
    type: 'png',
    timeout: 30_000,
    animations: 'disabled',
    caret: 'hide',
  });
}

async function capturePair(page, directory, name) {
  await page.evaluate(() => window.__BLACKOPS__.presentation({ hud: false, viewModel: false }));
  await settle(page);
  await canvasShot(page, path.join(directory, `${name}.world.png`));
  await page.evaluate(() => window.__BLACKOPS__.presentation({ hud: true, viewModel: true }));
  await settle(page);
  // In constrained software-WebGL environments, page-level compositing can
  // take minutes per frame. A retained canvas offers a deterministic gameplay
  // visual (world + viewmodel) without pretending to capture DOM HUD pixels.
  if (CANVAS_ONLY) {
    await canvasShot(page, path.join(directory, `${name}.gameplay.png`));
  } else {
    await fullShot(page, path.join(directory, `${name}.hud.png`));
  }
}

async function prepareScenario(page, scenario) {
  await page.evaluate(({ position, look, state, enemyDistance }) => {
    window.__BLACKOPS__.debugView('beauty');
    window.__BLACKOPS__.moveTo(...position);
    window.__BLACKOPS__.look(...look);
    window.__BLACKOPS__.state(state);
    if (enemyDistance) window.__BLACKOPS__.enemyDistance(enemyDistance);
  }, scenario);
  await settle(page);
}

async function measureFrames(page, sampleCount = 180) {
  return page.evaluate((count) => new Promise((resolve) => {
    const samples = [];
    let previous = performance.now();
    const sample = (now) => {
      samples.push(now - previous);
      previous = now;
      if (samples.length >= count) {
        const sorted = [...samples].sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
        resolve({
          sampleCount: samples.length,
          averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          onePercentLowFps: 1000 / percentile(0.99),
        });
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), sampleCount);
}

async function captureResolution(page, resolution) {
  const directory = path.join(OUT, resolution.label);
  console.log(`capture ${resolution.label}`);
  await page.setViewportSize({ width: resolution.width, height: resolution.height });
  // A heavy WebGL bootstrap can delay DOMContentLoaded while shaders and
  // imported development props initialize. The explicit __BLACKOPS__ wait
  // below is the deterministic readiness gate, so only wait for the initial
  // response here instead of coupling capture to the page lifecycle event.
  await page.goto(CAPTURE_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => Boolean(window.__BLACKOPS__), undefined, { timeout: 90_000 });
  if (RELEASE_CAPTURE) {
    const runtime = await page.evaluate(() => window.__BLACKOPS__?.stats());
    assertReleaseGate(runtime, `${resolution.label} preflight`);
  }
  await page.evaluate(() => window.__BLACKOPS__.freeze(true));
  await settle(page);
  if (!DEBUG_ONLY && !SKIP_MENU) {
    await canvasShot(page, path.join(directory, 'menu.world.png'));
    if (CANVAS_ONLY) {
      await canvasShot(page, path.join(directory, 'menu.gameplay.png'));
    } else {
      await fullShot(page, path.join(directory, 'menu.hud.png'));
    }
  }

  await page.evaluate(async () => {
    await window.__BLACKOPS__.start();
    window.__BLACKOPS__.freeze(true);
  });
  await settle(page);

  if (DEBUG_ONLY) {
    await prepareScenario(page, SCENARIOS.find((scenario) => scenario.name === 'warehouse'));
    await page.evaluate(() => window.__BLACKOPS__.presentation({ hud: false, viewModel: false }));
    for (const view of DEBUG_VIEWS) {
      await page.evaluate((debugView) => window.__BLACKOPS__.debugView(debugView), view);
      await settle(page);
      await canvasShot(page, path.join(directory, `debug.${view}.png`));
    }
    await page.evaluate(() => window.__BLACKOPS__.debugView('beauty'));
  } else if (QUICK && !SCENARIO_FILTER) {
    await capturePair(page, directory, 'spawn');
  } else {
    for (const scenario of SELECTED_SCENARIOS) {
      await prepareScenario(page, scenario);
      await capturePair(page, directory, scenario.name);
    }
    if (!SKIP_DEBUG_VIEWS && !SCENARIO_FILTER) {
      await prepareScenario(page, scenariosByName.get('warehouse'));
      await page.evaluate(() => window.__BLACKOPS__.presentation({ hud: false, viewModel: false }));
      for (const view of DEBUG_VIEWS) {
        await page.evaluate((debugView) => window.__BLACKOPS__.debugView(debugView), view);
        await settle(page);
        await canvasShot(page, path.join(directory, `debug.${view}.png`));
      }
      await page.evaluate(() => window.__BLACKOPS__.debugView('beauty'));
    }
  }

  const runtime = await page.evaluate(() => window.__BLACKOPS__.stats());
  if (RELEASE_CAPTURE) assertReleaseGate(runtime, `${resolution.label} final`);
  const report = {
    resolution,
    runtime,
    frameTiming: SKIP_TIMING ? null : await measureFrames(page, QUICK || DEBUG_ONLY ? 5 : 180),
    note: SKIP_TIMING
      ? 'Frame timing was intentionally skipped for this targeted visual-only capture.'
      : 'Headless capture timing is diagnostic only; it is not the RTX 3060 release benchmark.',
  };
  ensureParent(path.join(directory, 'renderer-stats.json'));
  fs.writeFileSync(path.join(directory, 'renderer-stats.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`complete ${resolution.label}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({
    viewport: { width: RESOLUTIONS[0].width, height: RESOLUTIONS[0].height },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });

  try {
    for (const resolution of RESOLUTIONS) await captureResolution(page, resolution);
  } finally {
    await browser.close();
  }

  if (errors.length > 0) {
    throw new Error(`capture encountered errors:\n${errors.join('\n')}`);
  }
  console.log(`captured ${RESOLUTIONS.length} resolution set(s) in ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
