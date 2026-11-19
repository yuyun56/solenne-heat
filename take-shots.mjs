// Verify the game loads without errors and take the entry's screenshots.
// Serves game/ with the repo's own serve.ts, drives headless Chrome (puppeteer from the
// token-radar tools install — this repo vendors nothing), first plays the real game for a
// few seconds collecting console/page errors, then visits each ?shot= scene in shots.json,
// waits for window.__shotReady and saves the frame as a JPEG under screenshots/.
//   node take-shots.mjs            full run: verify + screenshots
//   node take-shots.mjs --verify   verification only, no screenshots written
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/home/hatch/workspace/token-radar/tools/');
const puppeteer = require('puppeteer');

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8931;
const base = `http://127.0.0.1:${PORT}`;
const verifyOnly = process.argv.includes('--verify');

const server = spawn('node', ['serve.ts', '--port', String(PORT)], { cwd: here, stdio: 'pipe' });
await new Promise((resolve) => setTimeout(resolve, 900));

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const failures = [];

async function watchPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => failures.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') failures.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => failures.push(`requestfailed: ${req.url()}`));
  return page;
}

try {
  // 1) The real game: title screen, start a run, drive a little, pause.
  const page = await watchPage();
  await page.goto(base + '/?seed=7', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 1500));
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyP');
  await new Promise((r) => setTimeout(r, 400));
  await page.keyboard.press('KeyP');
  await new Promise((r) => setTimeout(r, 800));
  const blank = await page.evaluate(() => {
    const c = document.getElementById('game');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let varied = 0;
    for (let i = 0; i < data.length; i += 401 * 4) if (data[i] > 20 || data[i + 1] > 20) varied += 1;
    return varied < 10;
  });
  console.log('live game loaded; canvas blank?', blank);
  if (blank) failures.push('canvas looks blank during live play');
  await page.close();

  // 2) The staged scenes (also the screenshots themselves).
  const shots = JSON.parse(readFileSync(join(here, 'shots.json'), 'utf8'));
  for (const shot of shots) {
    const page = await watchPage();
    await page.goto(base + '/' + shot.query, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('window.__shotReady === true', { timeout: 20000 });
    if (!verifyOnly) {
      const path = join(here, 'screenshots', shot.name);
      await page.screenshot({ path, type: 'jpeg', quality: 86 });
      const size = statSync(path).size;
      console.log('shot', shot.name, size, 'bytes');
      if (size > 262144) failures.push(`${shot.name} is ${size} bytes, over the 256 KiB cap`);
    } else {
      console.log('scene ok', shot.name);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

if (failures.length > 0) {
  console.error('FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('ALL BROWSER CHECKS PASSED');
