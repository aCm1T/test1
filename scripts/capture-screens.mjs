import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = '/opt/cursor/artifacts/screenshots';
fs.mkdirSync(OUT, { recursive: true });

async function canvasShot(page, name) {
  const data = await page.evaluate(async () => {
    // Composite: grab WebGL canvas + overlay DOM via html2canvas-less approach
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    // Force one frame settle
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return canvas.toDataURL('image/png');
  });
  if (!data) throw new Error('no canvas for ' + name);
  const b64 = data.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
  console.log('ok', name, fs.statSync(path.join(OUT, name)).size);
}

async function fullShot(page, name) {
  // Faster path: JPEG screenshot without waiting forever
  try {
    await page.screenshot({
      path: path.join(OUT, name),
      type: 'jpeg',
      quality: 80,
      timeout: 8000,
      animations: 'disabled',
      caret: 'hide',
    });
    console.log('full', name);
  } catch (e) {
    console.warn('full shot failed, canvas only', name, e.message);
    await canvasShot(page, name);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => { console.error('PAGEERROR', e.message); errors.push(e.message); });

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await fullShot(page, '01-main-menu.jpg');

  await page.evaluate(async () => { if (window.__BLACKOPS__) await window.__BLACKOPS__.start(); });
  await page.waitForTimeout(2000);
  await canvasShot(page, '02-spawn.png');

  await page.evaluate(() => { window.__BLACKOPS__.moveTo(0,0,20); window.__BLACKOPS__.look(0,-0.1); });
  await page.waitForTimeout(800);
  await canvasShot(page, '03-street.png');

  await page.evaluate(() => { window.__BLACKOPS__.moveTo(-8,0,5); window.__BLACKOPS__.look(1.0,-0.05); });
  await page.waitForTimeout(800);
  await canvasShot(page, '04-alley.png');

  await page.evaluate(() => { window.__BLACKOPS__.moveTo(6,0,-2); window.__BLACKOPS__.look(-0.7,0.08); });
  await page.waitForTimeout(800);
  await canvasShot(page, '05-combat-lane.png');

  await page.evaluate(() => { window.__BLACKOPS__.moveTo(0,0,10); window.__BLACKOPS__.look(0.2,-0.12); });
  await page.waitForTimeout(800);
  await canvasShot(page, '06-weapon-view.png');

  await page.evaluate(() => { window.__BLACKOPS__.moveTo(-4,0,-12); window.__BLACKOPS__.look(3.0,0.0); });
  await page.waitForTimeout(800);
  await canvasShot(page, '07-wide.png');

  // HUD overlay composite via full page once
  await fullShot(page, '08-with-hud.jpg');

  console.log('errors', errors);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
