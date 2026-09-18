/**
 * Accuracy evaluation on the X-Wines test set (100 wines, one label photo each).
 *
 * Usage: node test/eval.mjs [--labels DIR] [--csv FILE] [--lang eng|eng+fra] [--refresh]
 * OCR output is cached in test/.cache/ocr-<lang>.json so matcher tuning is instant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import { WineIndex } from '../matcher.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const cache = 'scripts/.cache/rogerioxavier__X-Wines/Dataset/last';
const labelsDir = args.labels || path.join(cache, 'XWines_Test_100_labels');
const csvFile = args.csv || path.join(cache, 'XWines_Test_100_wines.csv');
const lang = args.lang || 'eng';
const verbose = !!args.verbose;
// Preprocessing variant, mirrors app.js: none | gray | both (gray + inverted pass)
const pre = args.pre || 'both';
const psm = args.psm || '3';
const target = Number(args.size || 1800);

async function variants(file) {
  if (pre === 'none') return [fs.readFileSync(file)];
  const im = await Jimp.read(file);
  if (target > 0) {
    const scale = target / Math.max(im.width, im.height);
    im.resize({ w: Math.round(im.width * scale), h: Math.round(im.height * scale) });
  }
  if (pre !== 'raw' && pre !== 'rawboth') im.greyscale().normalize();
  const out = [await im.getBuffer('image/png')];
  if (pre === 'both' || pre === 'rawboth') out.push(await im.clone().invert().getBuffer('image/png'));
  return out;
}

// --- expected answers -----------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [h, ...body] = rows;
  return body.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
const expected = parseCsv(fs.readFileSync(csvFile, 'utf8'));

// --- OCR (cached) ---------------------------------------------------------------------
const cacheFile = `test/.cache/ocr2-${lang}-${pre}-psm${psm}-${target}.json`;
const minConf = Number(args.minconf ?? 0);
const matchOpts = Object.fromEntries((args.opt ? String(args.opt).split(',') : []).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
let ocr = fs.existsSync(cacheFile) && !args.refresh ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const missing = expected.filter((w) => ocr[w.WineID] == null);
if (missing.length) {
  const langs = lang.split('+');
  const langPath = path.resolve(`node_modules/@tesseract.js-data/${langs[0]}/4.0.0_best_int`);
  const worker = await createWorker(langs, 1, { langPath: langs.length === 1 ? langPath : undefined, gzip: true, cachePath: path.resolve('test/.cache') });
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  for (const w of missing) {
    const file = path.join(labelsDir, `${w.WineID}.jpeg`);
    if (!fs.existsSync(file)) continue;
    const passes = [];
    for (const buf of await variants(file)) {
      const { data } = await worker.recognize(buf, {}, { text: true, blocks: true });
      const words = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) words.push({ text: wd.text, confidence: Math.round(wd.confidence) });
      passes.push({ text: data.text, words });
    }
    ocr[w.WineID] = passes;
    process.stderr.write(`ocr ${w.WineID}\r`);
  }
  await worker.terminate();
  fs.mkdirSync('test/.cache', { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(ocr, null, 1));
}

// --- matching -------------------------------------------------------------------------
const db = JSON.parse(fs.readFileSync('data/wines.json', 'utf8'));
const t0 = Date.now();
const index = new WineIndex(db, { idfPower: Number(args.idfpower ?? 1) });
const buildMs = Date.now() - t0;
const nameOf = (w) => `${w.WineryName} ${w.WineName}`.toLowerCase();

let n = 0; let top1 = 0; let top5 = 0; let top10 = 0; let none = 0; let ms = 0;
const pcts = { hit: [], miss: [] };
for (const w of expected) {
  if (ocr[w.WineID] == null) continue;
  n++;
  const t1 = Date.now();
  const words = ocr[w.WineID].flatMap((p) => p.words);
  const { results } = index.match({ words, minConfidence: minConf }, { topN: 10, minPercent: 0, ...matchOpts });
  ms += Date.now() - t1;
  const target = nameOf(w);
  const rank = results.findIndex((r) => r.wine.source === 'xwines' && r.wine.name.toLowerCase() === target);
  if (rank === 0) top1++;
  if (rank >= 0 && rank < 5) top5++;
  if (rank >= 0) top10++; else none++;
  if (rank === 0) pcts.hit.push(results[0].percent); else if (results[0]) pcts.miss.push(results[0].percent);
  if (verbose || rank !== 0) {
    console.log(`\n[${rank < 0 ? 'MISS' : `rank ${rank + 1}`}] ${w.WineID} expected: ${w.WineryName} | ${w.WineName}`);
    console.log('  ocr:', JSON.stringify(ocr[w.WineID].map((p) => p.words.map((x) => `${x.text}/${x.confidence}`).join(' ')).join(' | ').slice(0, 220)));
    results.slice(0, 3).forEach((r, i) => console.log(`  ${i + 1}. ${r.percent}%  ${r.wine.name}  [${r.matchedTokens.join(',')}] ${r.vintageStatus}`));
  }
}
const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-');
console.log(`\nlang=${lang} pre=${pre} psm=${psm} size=${target} minconf=${minConf} opts=${JSON.stringify(matchOpts)}  wines=${db.wines.length}  index build ${buildMs} ms, match avg ${(ms / n).toFixed(1)} ms`);
console.log(`n=${n}  top1=${top1} (${(100 * top1 / n).toFixed(0)}%)  top5=${top5}  top10=${top10}  not in top10=${none}`);
console.log(`avg % shown: correct top-1 ${avg(pcts.hit)}, wrong top-1 ${avg(pcts.miss)}`);
