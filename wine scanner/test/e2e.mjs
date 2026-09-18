/**
 * End-to-end smoke test: serves the folder, opens the app in headless Chromium, uploads
 * a few X-Wines test label photos and prints the ranked matches.
 *
 *   npm run vendor          # optional: use local Tesseract instead of the CDN
 *   node test/e2e.mjs [imageOrDir ...]
 *
 * Screenshots are written to test/screenshots/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/%20/g, ' '), '..');
const port = 8765;
const defaultDir = path.join(root, 'scripts/.cache/rogerioxavier__X-Wines/Dataset/last/XWines_Test_100_labels');
let images = process.argv.slice(2);
if (!images.length) images = fs.existsSync(defaultDir) ? fs.readdirSync(defaultDir).slice(0, 5).map((f) => path.join(defaultDir, f)) : [];
images = images.flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p]);
if (!images.length) { console.error('No images given.'); process.exit(1); }

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const launch = { headless: true };
if (fs.existsSync('/opt/pw-browsers/chromium')) launch.executablePath = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(launch);
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => /Database: [\d,]+ wines/.test(document.getElementById('db-info').textContent), null, { timeout: 60000 });
  fs.mkdirSync(path.join(root, 'test/screenshots'), { recursive: true });
  for (const img of images) {
    const t0 = Date.now();
    await page.setInputFiles('#file-pick', img);
    await page.waitForFunction(() => !document.getElementById('results-card').hidden && document.getElementById('progress').hidden, null, { timeout: 180000 });
    const err = await page.$eval('#error', (e) => e.hidden ? '' : e.textContent);
    const rows = await page.$$eval('#results .result', (els) => els.map((e) => `${e.querySelector('.pct').firstChild.textContent.trim()} ${e.querySelector('.name').textContent.trim()}`));
    console.log(`\n${path.basename(img)} (${((Date.now() - t0) / 1000).toFixed(1)} s)${err ? ` ERROR: ${err}` : ''}`);
    rows.slice(0, 3).forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
    await page.screenshot({ path: path.join(root, 'test/screenshots', `${path.basename(img, path.extname(img))}.png`), fullPage: true });
  }
} finally {
  await browser.close();
  server.kill();
}
