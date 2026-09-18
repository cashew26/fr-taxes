/**
 * Wine label matcher: pure functions and an in-memory index, no DOM.
 * Works as an ES module in the browser and in Node (used by test/eval.mjs).
 *
 * Idea: OCR text from a label is a noisy bag of words. Each wine in the DB is a small
 * document (name + region + variety). We score wines by how much of their name (weighted
 * by inverse document frequency, so rare words such as the producer count more than
 * "cabernet") is covered by the label's words, allowing small spelling differences,
 * then adjust for region and vintage. The result is a 0..1 score shown as a percentage.
 */

// Words that appear on almost every label and never help identify a wine.
export const LABEL_STOPWORDS = new Set((
  'alc alcohol vol volume abv ml cl litre liter contains contient sulfites sulphites sulfite sulphite ' +
  'product produce produit prodotto producto of de du des della dello di da la le les el il lo the and et e y ' +
  'bottled embotellado imbottigliato mis en bouteille par au a al by for pour in ' +
  'appellation controlee protegee origine denominacion denominazione origem controlada ' +
  'imported importer imports importe distributed net contents cont serve chilled government warning ' +
  'oz fl org www http https com net'
).split(/\s+/));

const YEAR_RE = /^(19[2-9]\d|20[0-4]\d)$/;

/** Lowercase, strip accents, keep letters/digits only (as spaces between tokens). */
export function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[Œœ]/g, 'oe')
    .replace(/[Ææ]/g, 'ae')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split normalized text into tokens; drops 1-char tokens. */
export function tokenize(str) {
  return normalize(str).split(' ').filter((t) => t.length >= 2);
}

/** Fix OCR digit/letter confusions inside mostly numeric tokens ("2O15" -> "2015"). */
function fixDigits(tok) {
  const digits = (tok.match(/\d/g) || []).length;
  if (digits >= 2 && digits >= tok.length - 1) {
    return tok.replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5').replace(/b/g, '8');
  }
  return tok;
}

/** Levenshtein distance with an upper bound (returns max+1 when exceeded). */
export function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}

/** Allowed edit distance for a token of a given length. */
function maxEdits(len, opt) {
  if (len < opt.fuzzyMinLen1) return 0;
  if (len < opt.fuzzyMinLen2) return 1;
  return 2;
}

const EDIT_QUALITY = [1, 0.85, 0.65];

export const DEFAULT_OPTIONS = {
  topN: 10,
  /** IDF mass (sum of matched name-token weights) needed for full confidence. */
  specificity: 12,
  regionWeight: 0.15,
  /** Weight of "how much label evidence this wine explains, relative to the best candidate". */
  queryWeight: 0.4,
  /** Minimum token length to allow 1 (resp. 2) OCR character errors. */
  fuzzyMinLen1: 5,
  fuzzyMinLen2: 8,
  vintageMismatchPenalty: 0.8,
  vintageListMissPenalty: 0.92,
  minPercent: 15,
};

export class WineIndex {
  /**
   * @param {object} db  parsed data/wines.json ({fields, wines: [[...]]})
   */
  constructor(db, { idfPower = 1 } = {}) {
    const f = db.fields;
    const col = (name) => f.indexOf(name);
    const iName = col('name'); const iWinery = col('winery'); const iRegion = col('region');
    const iCountry = col('country'); const iVariety = col('variety'); const iVintage = col('vintage');
    const iVintages = col('vintages'); const iRating = col('rating'); const iSource = col('source');

    this.wines = db.wines.map((row, id) => ({
      id,
      name: row[iName], winery: row[iWinery], region: row[iRegion], country: row[iCountry],
      variety: row[iVariety], vintage: row[iVintage], vintages: row[iVintages],
      rating: row[iRating], source: row[iSource],
    }));
    this.sources = db.sources || [];

    // Per-wine token sets. Name tokens exclude the vintage year (handled separately).
    this.nameTokens = new Array(this.wines.length);
    this.regionTokens = new Array(this.wines.length);
    const df = new Map();
    for (const w of this.wines) {
      const nt = new Set(tokenize(`${w.winery || ''} ${w.name}`).filter((t) => !YEAR_RE.test(t)));
      const rt = new Set(tokenize(`${w.region || ''} ${w.country || ''}`));
      for (const t of rt) nt.delete(t) || null; // a region word in the name is scored as region only
      this.nameTokens[w.id] = nt;
      this.regionTokens[w.id] = rt;
      for (const t of new Set([...nt, ...rt])) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = this.wines.length;
    this.idf = new Map();
    for (const [t, d] of df) this.idf.set(t, Math.log((N + 1) / (d + 0.5)) ** idfPower);

    // Inverted indexes and per-wine total weights.
    this.namePostings = new Map();
    this.regionPostings = new Map();
    this.nameWeight = new Float64Array(N);
    this.regionWeight = new Float64Array(N);
    for (const w of this.wines) {
      for (const t of this.nameTokens[w.id]) {
        this.nameWeight[w.id] += this.idf.get(t);
        let p = this.namePostings.get(t); if (!p) this.namePostings.set(t, (p = []));
        p.push(w.id);
      }
      for (const t of this.regionTokens[w.id]) {
        this.regionWeight[w.id] += this.idf.get(t);
        let p = this.regionPostings.get(t); if (!p) this.regionPostings.set(t, (p = []));
        p.push(w.id);
      }
    }

    // Vocabulary bucketed by length for bounded fuzzy lookup.
    this.byLength = new Map();
    for (const t of this.idf.keys()) {
      let b = this.byLength.get(t.length); if (!b) this.byLength.set(t.length, (b = []));
      b.push(t);
    }
  }

  /**
   * Turn OCR output into scoring tokens and candidate vintages.
   * @param {string|{words: {text: string, confidence?: number}[], minConfidence?: number}} input
   */
  parseQuery(input) {
    const years = new Set();
    const tokens = new Set();
    let raw;
    if (typeof input === 'string') raw = tokenize(input);
    else {
      const min = input.minConfidence ?? 0;
      raw = [];
      for (const w of input.words || []) {
        if (w.confidence != null && w.confidence < min) continue;
        raw.push(...tokenize(w.text));
      }
    }
    const kept = [];
    for (let t of raw) {
      t = fixDigits(t);
      if (YEAR_RE.test(t)) { years.add(Number(t)); continue; }
      if (LABEL_STOPWORDS.has(t)) continue;
      if (/^\d+$/.test(t) && t.length !== 4) continue; // 750, 13, 12.5 ...: noise
      kept.push(t);
    }
    // OCR often splits or glues words: "MERCO URI" -> "mercouri", "COLUMBIACREST" -> "columbia crest".
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i];
      tokens.add(t);
      if (i + 1 < kept.length) {
        const joined = t + kept[i + 1];
        if (joined.length >= 5 && this.idf.has(joined) && !(this.idf.has(t) && this.idf.has(kept[i + 1]))) tokens.add(joined);
      }
      if (t.length >= 8 && !this.idf.has(t)) {
        for (let k = 3; k <= t.length - 3; k++) {
          const a = t.slice(0, k); const b = t.slice(k);
          if (this.idf.has(a) && this.idf.has(b)) { tokens.add(a); tokens.add(b); break; }
        }
      }
    }
    return { tokens: [...tokens], years: [...years] };
  }

  /** Map each query token to DB vocabulary tokens with a match quality. */
  expandToken(tok, opt = DEFAULT_OPTIONS) {
    const out = new Map();
    if (this.idf.has(tok)) out.set(tok, 1);
    const max = maxEdits(tok.length, opt);
    if (max === 0) return out;
    for (let len = tok.length - max; len <= tok.length + max; len++) {
      const bucket = this.byLength.get(len);
      if (!bucket) continue;
      for (const v of bucket) {
        if (v === tok) continue;
        const d = editDistance(tok, v, max);
        if (d <= max) {
          const q = EDIT_QUALITY[d] * (v.length >= 6 ? 1 : 0.9);
          if ((out.get(v) || 0) < q) out.set(v, q);
        }
      }
    }
    return out;
  }

  /**
   * @param {string|object} input OCR text, a typed query, or {words, minConfidence} (see parseQuery)
   * @returns {{query: object, results: Array}} ranked matches
   */
  match(input, options = {}) {
    const opt = { ...DEFAULT_OPTIONS, ...options };
    const query = this.parseQuery(input);
    // wineId -> Map(dbToken -> best quality)
    const nameHits = new Map();
    const regionHits = new Map();
    const matchedVocab = new Map(); // dbToken -> {q, from}
    for (const tok of query.tokens) {
      for (const [v, q] of this.expandToken(tok, opt)) {
        const prev = matchedVocab.get(v);
        if (!prev || prev.q < q) matchedVocab.set(v, { q, from: tok });
      }
    }
    for (const [v, { q }] of matchedVocab) {
      const np = this.namePostings.get(v);
      if (np) for (const id of np) {
        let m = nameHits.get(id); if (!m) nameHits.set(id, (m = new Map()));
        m.set(v, q);
      }
      const rp = this.regionPostings.get(v);
      if (rp) for (const id of rp) {
        let m = regionHits.get(id); if (!m) regionHits.set(id, (m = new Map()));
        m.set(v, q);
      }
    }

    // Evidence explained by each candidate; the best candidate defines 100%.
    const evidence = new Map();
    let maxEvidence = 0;
    for (const [id, hits] of nameHits) {
      let matched = 0;
      for (const [v, q] of hits) matched += this.idf.get(v) * q;
      evidence.set(id, matched);
      if (matched > maxEvidence) maxEvidence = matched;
    }

    const results = [];
    for (const [id, hits] of nameHits) {
      const matched = evidence.get(id);
      const matchedTokens = [...hits.keys()];
      const nameCov = matched / this.nameWeight[id];
      const queryCov = maxEvidence > 0 ? matched / maxEvidence : 0;
      let regionCov = 0;
      const rh = regionHits.get(id);
      if (rh && this.regionWeight[id] > 0) {
        let r = 0; for (const [v, q] of rh) r += this.idf.get(v) * q;
        regionCov = r / this.regionWeight[id];
      }
      const specificity = Math.min(1, matched / opt.specificity);
      const nameScore = nameCov * (1 - opt.queryWeight) + queryCov * opt.queryWeight;
      let score = (nameScore * (1 - opt.regionWeight) + regionCov * opt.regionWeight) * specificity;

      const w = this.wines[id];
      let vintageStatus = 'unknown';
      if (query.years.length) {
        if (w.vintage != null) {
          if (query.years.includes(w.vintage)) vintageStatus = 'match';
          else { vintageStatus = 'mismatch'; score *= opt.vintageMismatchPenalty; }
        } else if (w.vintages && w.vintages.length) {
          if (query.years.some((y) => w.vintages.includes(y))) vintageStatus = 'match';
          else { vintageStatus = 'not-listed'; score *= opt.vintageListMissPenalty; }
        }
      }
      const percent = Math.round(score * 100);
      if (percent < opt.minPercent) continue;
      results.push({
        wine: w, score, percent, nameCov, queryCov, regionCov, specificity, vintageStatus,
        matchedTokens,
      });
    }
    results.sort((a, b) => b.score - a.score
      || (a.vintageStatus === 'match') - (b.vintageStatus === 'match')
      || (b.wine.rating || 0) - (a.wine.rating || 0));
    return { query, results: results.slice(0, opt.topN) };
  }
}
