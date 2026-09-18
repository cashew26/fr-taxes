/**
 * Copy Tesseract.js, its WebAssembly core and language data from node_modules into
 * vendor/tesseract/ so the app works fully offline / self-hosted (no CDN).
 * The app uses vendor/ automatically when present, otherwise falls back to jsDelivr.
 *
 *   npm install && npm run vendor
 *
 * Language packs: any @tesseract.js-data/<lang> package that is installed is copied
 * (eng, fra, ita, spa, deu, por ... are listed in package.json devDependencies).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'vendor', 'tesseract');
const req = (p) => { if (!fs.existsSync(p)) throw new Error(`${p} not found. Run: npm install`); return p; };

fs.mkdirSync(path.join(out, 'core'), { recursive: true });
fs.mkdirSync(path.join(out, 'lang'), { recursive: true });

for (const f of ['tesseract.min.js', 'worker.min.js']) {
  fs.copyFileSync(req(path.join(nm, 'tesseract.js', 'dist', f)), path.join(out, f));
}
const coreDir = req(path.join(nm, 'tesseract.js-core'));
for (const f of fs.readdirSync(coreDir)) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) fs.copyFileSync(path.join(coreDir, f), path.join(out, 'core', f));
}
const dataDir = path.join(nm, '@tesseract.js-data');
let langs = [];
if (fs.existsSync(dataDir)) {
  for (const lang of fs.readdirSync(dataDir)) {
    const src = path.join(dataDir, lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, 'lang', `${lang}.traineddata.gz`)); langs.push(lang); }
  }
}
console.log(`Vendored Tesseract.js into ${path.relative(root, out)}/ with languages: ${langs.join(', ') || '(none)'}`);
