/**
 * Wine Scanner - browser app.
 *  1. Load data/wines.json and build the matching index (matcher.js).
 *  2. Load Tesseract.js (local vendor/ copy if present, otherwise the jsDelivr CDN).
 *  3. On photo: fix orientation, resize, grayscale + contrast, OCR (and an inverted pass),
 *     then rank wines and show a match percentage.
 */
import { WineIndex } from './matcher.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'), filePick: $('file-pick'), btnCamera: $('btn-camera'), btnPick: $('btn-pick'),
  dropzone: $('dropzone'), preview: $('preview'), progress: $('progress'), fill: $('progress-fill'),
  status: $('status'), error: $('error'), resultsCard: $('results-card'), results: $('results'),
  resultsMeta: $('results-meta'), noResults: $('no-results'), ocrText: $('ocr-text'),
  btnSearch: $('btn-search'), textDetails: $('text-details'), dbInfo: $('db-info'),
  optInvert: $('opt-invert'), optTopN: $('opt-topn'),
};

const TESSERACT_VERSION = '7';
const MAX_SIDE = 1800;
const PAGE_SEG_MODE = '11';   // sparse text: labels are scattered words, not paragraphs
const MIN_WORD_CONFIDENCE = 40;

let index = null;       // WineIndex
let worker = null;      // Tesseract worker
let workerLangs = '';   // languages the current worker was created with
let tessPaths = null;   // {workerPath, corePath, langPath} or {} for CDN defaults
let busy = false;

// --- UI helpers -----------------------------------------------------------------------
function setStatus(text, fraction) {
  els.progress.hidden = false;
  els.status.textContent = text;
  els.fill.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
function hideStatus() { els.progress.hidden = true; }
function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function setBusy(b) {
  busy = b;
  for (const el of [els.btnCamera, els.btnPick, els.btnSearch]) el.disabled = b;
}
function selectedLangs() {
  const l = [...document.querySelectorAll('input[name=lang]:checked')].map((c) => c.value);
  return l.length ? l : ['eng'];
}

// --- database -------------------------------------------------------------------------
async function loadDatabase() {
  setStatus('Loading wine database…', 0.05);
  const res = await fetch('data/wines.json');
  if (!res.ok) throw new Error(`Cannot load data/wines.json (${res.status}). Run: npm run build-db`);
  const db = await res.json();
  index = new WineIndex(db);
  const srcs = db.sources.map((s) => `<a href="${s.url}" rel="noopener">${s.name}</a> (${s.count.toLocaleString()})`).join(', ');
  els.dbInfo.innerHTML = `Database: ${index.wines.length.toLocaleString()} wines, built ${db.built.slice(0, 10)}. Sources: ${srcs}.`;
  hideStatus();
}

// --- Tesseract loading ------------------------------------------------------------------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => { s.remove(); reject(new Error(`failed to load ${src}`)); };
    document.head.appendChild(s);
  });
}

async function ensureTesseract() {
  if (window.Tesseract) return;
  setStatus('Loading OCR engine…', 0.1);
  try {
    await loadScript('vendor/tesseract/tesseract.min.js');
    tessPaths = { workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract/core/', langPath: 'vendor/tesseract/lang', gzip: true };
  } catch {
    await loadScript(`https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`);
    tessPaths = {}; // CDN defaults for worker, core and language data
  }
}

async function getWorker(langs) {
  await ensureTesseract();
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  setStatus(`Preparing OCR (${key})…`, 0.15);
  worker = await window.Tesseract.createWorker(langs, 1, {
    ...tessPaths,
    logger: (m) => {
      if (m.status === 'recognizing text') setStatus('Reading label…', 0.3 + 0.6 * m.progress);
      else if (m.status && m.progress != null) setStatus(`${m.status}…`, 0.15 + 0.15 * m.progress);
    },
  });
  await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE });
  workerLangs = key;
  return worker;
}

// --- image preprocessing ------------------------------------------------------------------
async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Unreadable image')); img.src = url; });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Returns [normal, inverted] canvases. The photo is only downscaled (long side <= MAX_SIDE) to
 * keep OCR fast; on the X-Wines label photos, grayscale / contrast stretching and upscaling
 * made recognition worse, so the pixels are otherwise left untouched.
 */
async function preprocess(file, withInverted) {
  const bmp = await decodeImage(file);
  const w = bmp.width || bmp.naturalWidth; const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)); const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cw, ch);
  if (bmp.close) bmp.close();
  const out = [canvas];
  if (withInverted) {
    const inv = document.createElement('canvas');
    inv.width = cw; inv.height = ch;
    const ictx = inv.getContext('2d');
    ictx.drawImage(canvas, 0, 0);
    ictx.globalCompositeOperation = 'difference';
    ictx.fillStyle = '#fff';
    ictx.fillRect(0, 0, cw, ch);
    out.push(inv);
  }
  return out;
}

// --- pipeline -------------------------------------------------------------------------------
async function scan(file) {
  if (busy) return;
  if (!file || !file.type.startsWith('image/')) { showError('Please choose an image file.'); return; }
  showError('');
  setBusy(true);
  els.preview.src = URL.createObjectURL(file);
  els.preview.hidden = false;
  try {
    if (!index) await loadDatabase();
    const w = await getWorker(selectedLangs());
    setStatus('Preparing image…', 0.25);
    const canvases = await preprocess(file, els.optInvert.checked);
    const words = [];
    for (let i = 0; i < canvases.length; i++) {
      setStatus(canvases.length > 1 ? `Reading label (pass ${i + 1}/${canvases.length})…` : 'Reading label…', 0.3);
      const { data } = await w.recognize(canvases[i], {}, { text: true, blocks: true });
      for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) {
        words.push({ text: wd.text, confidence: wd.confidence });
      }
    }
    const kept = words.filter((x) => x.confidence >= MIN_WORD_CONFIDENCE);
    // Show the confident words to the user (editable); low-confidence noise is dropped.
    const text = kept.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim();
    els.ocrText.value = text;
    if (!text) {
      els.textDetails.open = true;
      showError('No text could be read on this photo. Try closer, sharper, with more light, or type the label text below.');
    }
    renderMatches({ words: kept, minConfidence: MIN_WORD_CONFIDENCE });
  } catch (e) {
    console.error(e);
    showError(`Something went wrong: ${e.message}`);
  } finally {
    hideStatus();
    setBusy(false);
  }
}

function pctClass(p) { return p >= 60 ? 'good' : p >= 40 ? 'mid' : 'low'; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderMatches(input) {
  const topN = Math.max(1, Math.min(50, Number(els.optTopN.value) || 10));
  const t0 = performance.now();
  const { query, results: raw } = index.match(input, { topN: topN * 4 });
  const ms = performance.now() - t0;
  // Collapse the vintages of one wine into a single row (best-scoring vintage first).
  const groups = new Map();
  for (const r of raw) {
    const key = `${r.wine.source}|${r.wine.name.replace(/\b(19|20)\d{2}\b/g, '').toLowerCase().trim()}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { ...r, others: [] });
    else if (r.wine.vintage) g.others.push(r.wine);
  }
  const results = [...groups.values()].slice(0, topN);
  els.resultsCard.hidden = false;
  els.results.innerHTML = '';
  els.noResults.hidden = results.length > 0;
  els.resultsMeta.textContent = `${query.tokens.length} words read${query.years.length ? `, year ${query.years.join('/')}` : ''} · ${ms.toFixed(0)} ms`;
  for (const r of results) {
    const w = r.wine;
    const meta = [w.region, w.country && w.country !== w.region ? w.country : null, w.variety].filter(Boolean).join(' · ');
    const vintage = w.vintage ? `${w.vintage}` : (w.vintages ? `vintages ${Math.min(...w.vintages)}–${Math.max(...w.vintages)}` : '');
    const vtag = r.vintageStatus === 'match' ? '<span class="tag ok">vintage ✓</span>'
      : r.vintageStatus === 'mismatch' ? '<span class="tag warn">other vintage</span>' : '';
    const rating = w.rating ? `<span class="tag">${w.rating} pts</span>` : '';
    const others = r.others.length
      ? `<p class="meta small">Other vintages: ${r.others.map((o) => `${o.vintage}${o.rating ? ` (${o.rating})` : ''}`).join(', ')}</p>` : '';
    const li = document.createElement('li');
    li.className = 'result';
    li.innerHTML = `
      <div class="pct ${pctClass(r.percent)}">${r.percent}%<small>match</small></div>
      <div>
        <p class="name">${esc(w.name)}${vtag}${rating}</p>
        <p class="meta">${esc(meta)}${vintage ? ` · ${esc(vintage)}` : ''}</p>${others}
        <div class="bar"><div class="fill" style="width:${r.percent}%"></div></div>
      </div>`;
    li.title = `Matched words: ${r.matchedTokens.join(', ')}`;
    els.results.appendChild(li);
  }
  els.resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- events -------------------------------------------------------------------------------
els.btnCamera.addEventListener('click', () => els.file.click());
els.btnPick.addEventListener('click', () => els.filePick.click());
for (const input of [els.file, els.filePick]) {
  input.addEventListener('change', () => { if (input.files[0]) scan(input.files[0]); input.value = ''; });
}
els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('over'); });
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('over'));
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); els.dropzone.classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) scan(f);
});
els.dropzone.addEventListener('click', () => { if (!busy) els.filePick.click(); });
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) scan(item.getAsFile());
});
els.btnSearch.addEventListener('click', async () => {
  if (busy) return;
  showError('');
  try {
    if (!index) { setBusy(true); await loadDatabase(); }
    renderMatches(els.ocrText.value);
  } catch (e) { showError(e.message); } finally { setBusy(false); }
});

loadDatabase().catch((e) => { hideStatus(); showError(e.message); });
