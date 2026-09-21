import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { distHash, sourceHash } from './lib/standalone-evidence.mjs';

const gameUrl = process.env.GAME_URL ?? 'http://127.0.0.1:4173/';
const profile = process.env.SMOKE_PROFILE ?? 'root';
const captureImages = process.env.SMOKE_CAPTURE === '1';
const output = path.resolve(process.env.SMOKE_DIR ?? 'artifacts/standalone-smoke');
const evidencePath = path.join(output, 'evidence.json');
const sizes = [
  { label: '1280x720', width: 1280, height: 720 },
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '3440x1440', width: 3440, height: 1440 },
];

fs.mkdirSync(output, { recursive: true });
console.log(`[smoke:${profile}] launching Chromium for ${gameUrl}`);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const results = [];

try {
  for (const size of sizes) {
    console.log(`[smoke:${profile}] ${size.label}: loading production build`);
    const deviceScaleFactor = size.width >= 3000 ? 0.5 : 1;
    const page = await browser.newPage({ viewport: size, deviceScaleFactor });
    page.setDefaultTimeout(60_000);
    const errors = [];
    const failedResources = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => failedResources.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));

    const response = await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!response?.ok()) throw new Error(`${size.label}: document returned ${response?.status() ?? 'no response'}`);
    console.log(`[smoke:${profile}] ${size.label}: DOM ready, waiting for engine`);
    await page.waitForSelector('#main-menu:not(.main-menu-hidden)', { state: 'visible' });
    await page.waitForSelector('[data-action="play"]:not(:disabled)', { state: 'visible', timeout: 90_000 });
    console.log(`[smoke:${profile}] ${size.label}: engine ready`);
    if (await page.locator('select').count()) throw new Error(`${size.label}: native select is present`);
    if (await page.evaluate(() => Boolean(window.__BLACKOPS__))) throw new Error(`${size.label}: QA mutation API leaked into production`);

    if (size.label === '1280x720') {
      console.log(`[smoke:${profile}] ${size.label}: keyboard listbox`);
      await page.locator('[data-action="settings"]').click({ force: true, timeout: 10_000 });
      console.log(`[smoke:${profile}] ${size.label}: settings opened`);
      const combo = page.getByRole('combobox', { name: 'Graphics tier' });
      await combo.focus();
      console.log(`[smoke:${profile}] ${size.label}: graphics control focused`);
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) !== 'LOW') {
        throw new Error('graphics listbox ArrowDown navigation failed');
      }
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      console.log(`[smoke:${profile}] ${size.label}: graphics keyboard selection applied`);
      if ((await combo.getAttribute('aria-expanded')) !== 'false') throw new Error('graphics listbox did not close');
      if (!(await combo.textContent())?.includes('AUTO')) throw new Error('graphics listbox Enter selection failed');
      await combo.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      if (await page.locator('[data-graphics-listbox]').isVisible()) throw new Error('Escape did not close graphics listbox');
      await page.locator('[data-panel="settings"] [data-action="back"]').click({ force: true, timeout: 10_000 });
    }

    if (captureImages) await captureHud(page, path.join(output, `${profile}-${size.label}-menu.png`));
    console.log(`[smoke:${profile}] ${size.label}: starting normal gameplay`);
    await page.click('[data-action="play"]');
    await page.waitForSelector('#hud-root:not(.hud-hidden)', { state: 'visible', timeout: 90_000 });
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(250);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(180);
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('Digit2');
    await page.keyboard.press('KeyR');
    await page.keyboard.press('KeyG');
    if (captureImages) {
      await captureCanvas(page, path.join(output, `${profile}-${size.label}-game-canvas.png`));
      await captureHud(page, path.join(output, `${profile}-${size.label}-game-hud.png`));
    }

    console.log(`[smoke:${profile}] ${size.label}: pause and resume`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#main-menu:not(.main-menu-hidden)', { state: 'visible', timeout: 10_000 });
    const resume = await page.locator('[data-play-label]').textContent();
    if (resume?.trim() !== 'RESUME') throw new Error(`${size.label}: Escape did not enter resumable pause menu`);
    await page.click('[data-action="play"]');
    await page.waitForSelector('#hud-root:not(.hud-hidden)', { state: 'visible' });
    await page.waitForTimeout(400);

    if (errors.length || failedResources.length) {
      throw new Error(`${size.label}: runtime errors=${JSON.stringify(errors)} resources=${JSON.stringify(failedResources)}`);
    }
    results.push({ size: size.label, deviceScaleFactor, menu: true, settingsKeyboard: size.label === '1280x720', gameplay: true, pauseResume: true, captures: captureImages });
    await page.close();
    console.log(`[smoke:${profile}] ${size.label}: passed`);
  }
} finally {
  await browser.close();
}

const existing = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : { profiles: {} };
existing.sourceHash = sourceHash();
existing.profiles ??= {};
existing.profiles[profile] = {
  passed: true,
  testedAt: new Date().toISOString(),
  url: gameUrl,
  distHash: distHash(),
  viewports: results,
};
fs.writeFileSync(evidencePath, `${JSON.stringify(existing, null, 2)}\n`);
console.log(`[smoke:${profile}] evidence written to ${path.relative(process.cwd(), evidencePath)}`);

async function captureCanvas(page, filename) {
  const data = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.querySelector('canvas')?.toDataURL('image/png') ?? null;
  });
  if (!data) throw new Error('game canvas was unavailable for capture');
  fs.writeFileSync(filename, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

async function captureHud(page, filename) {
  await page.locator('canvas').evaluate((canvas) => { canvas.style.visibility = 'hidden'; });
  try {
    await page.screenshot({ path: filename, animations: 'disabled', timeout: 30_000 });
  } finally {
    await page.locator('canvas').evaluate((canvas) => { canvas.style.visibility = ''; });
  }
}
