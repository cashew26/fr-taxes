# Wine Scanner

Take a photo of a wine label and get the closest matching wines from a bundled wine database,
each with a match percentage. Everything runs in the browser: the photo is read with
[Tesseract.js](https://github.com/naptha/tesseract.js) (OCR compiled to WebAssembly) and the
words are matched against the database locally. No server, no API key, the photo never leaves
the device.

This folder is independent from the rest of the repository.

## Run it

The page needs to be served over HTTP (browser workers and `fetch` do not work from `file://`):

```sh
cd "wine scanner"
python3 -m http.server 8080        # or: npm start, npx serve, any static server
```

Open <http://localhost:8080>, then **Take a photo** (opens the camera on a phone), **Choose an
image**, or drop / paste a picture. The first scan downloads the OCR engine and language data
(about 10 MB) from the jsDelivr CDN; they are cached by the browser afterwards.

Deploying is copying the folder to any static host (GitHub Pages works as is).

### Fully offline / self-hosted OCR

```sh
npm install
npm run vendor      # copies Tesseract.js, its wasm core and language packs into vendor/
```

When `vendor/tesseract/` exists the page uses it instead of the CDN. `vendor/` is git-ignored.

## How matching works

1. **Preprocessing** (`app.js`): EXIF orientation is applied and the image is downscaled to
   1800 px on its long side. Settings offers a second pass on an inverted copy for light text
   on dark labels; it is off by default because it doubles the time without improving the
   benchmark below. Grayscale conversion, contrast stretching and upscaling were also tried
   and made recognition worse on the test labels.
2. **OCR**: Tesseract in "sparse text" page segmentation mode (labels are scattered words, not
   paragraphs). All words are kept: filtering on Tesseract's confidence also lost too many real
   words set in decorative fonts.
3. **Matching** (`matcher.js`): each wine is a small document (producer + name, region,
   variety). Words are lowercased, accents stripped and weighted by inverse document frequency,
   so a rare producer name counts far more than "cabernet". Label words may differ from the
   database by one or two characters (OCR errors), glued words are split and split words are
   glued when that yields a known word. The score combines:
   - how much of the wine's name (by weight) is covered by the label,
   - how much of the label's known words the wine explains (separates cuvées of one producer),
   - region / country words (10%),
   - a specificity factor, so that a label matching only generic words cannot reach 100%,
   - the vintage: a year on the label that differs from the wine's vintage lowers the score,
   so the right vintage of a wine ranks first.

   The result is displayed as a percentage. Above roughly 60% the top result is usually right;
   below 40% treat it as a hint and check the "Recognized text" box, which can be edited and
   searched again (it also works as a plain text search without a photo). Vintages of the same
   wine are grouped into one row.

## Database

`data/wines.json` is built by `scripts/build_db.py` from two public datasets on GitHub:

| Source | Wines | Fields used |
|---|---|---|
| [alfredodeza/wine-ratings](https://github.com/alfredodeza/wine-ratings) (scraped from wine.com) | 32,780 | name (with vintage), region, variety, rating |
| [rogerioxavier/X-Wines](https://github.com/rogerioxavier/X-Wines) test subset (CC0) | 100 | winery, name, region, country, grapes, vintages |

```sh
python3 scripts/build_db.py                    # clones both sources into scripts/.cache and rebuilds
python3 scripts/build_db.py --xwines XWines_Slim_1K_wines.csv --xwines XWines_Full_100K_wines.csv
```

The X-Wines 1K and 100K subsets are distributed via Google Drive (link in their README); pass
the CSV files with `--xwines` to include them. Any other dataset can be added with a small
loader in `build_db.py` returning the same fields.

The file format is compact: `{"fields": [...], "wines": [[...], ...], "sources": [...]}`.
Fields are `name, winery, region, country, variety, vintage, vintages, rating, source`.

## Evaluation

The X-Wines test subset ships a label photo for each of its 100 wines, which makes a small
benchmark. `test/eval.mjs` runs the same OCR settings as the app in Node (using `jimp` for the
preprocessing), caches the OCR output and reports how often the expected wine is ranked first
among the 30,894 wines:

```sh
npm install
npm run eval                 # OCR the 100 labels once (cached), then score
node test/eval.mjs --verbose                    # print the misses
node test/eval.mjs --pre both --psm 3 --size 1800 --upscale --opt queryWeight=0.5   # experiments
```

`test/e2e.mjs` drives the real page in headless Chromium (Playwright) with a few label photos
and saves screenshots in `test/screenshots/`.

Current numbers (English language pack, 30,894 wines, 100 label photos of 480×640 px):

| Setting | Expected wine ranked 1st | In top 5 | In top 10 |
|---|---|---|---|
| App defaults (sparse text mode, original colours) | 52% | 61% | 63% |
| Same plus an inverted pass (`--pre rawboth`) | 52% | 61% | 63% |
| Automatic page segmentation instead of sparse text | 38% | 46% | 47% |
| Grayscale + contrast stretch + upscale to 1800 px | 51% | 54% | 56% |

When the right wine is ranked first it is shown with 64% on average; a wrong first result
averages 45%. The wines that are never found are those whose OCR output is unusable (foil or
engraved lettering, script fonts, very low contrast): the matcher cannot recover what was not read.

## Limits

- Coverage: 30,894 wines, mostly what wine.com sold in 2020–2021 (US, France, Italy, Spain,
  Argentina…). A wine that is not in the database cannot be found; the nearest names are shown
  with a low percentage.
- OCR is the weak link: decorative fonts, engraved or foil text and reflections lose words.
  A sharp, well lit, straight photo of just the label helps a lot.
- Matching is textual. Two wines from the same producer with similar names can swap places when
  the distinguishing word is not read.

## Files

```
index.html        page
style.css         styles (light / dark)
app.js            camera input, preprocessing, OCR, rendering
matcher.js        tokenisation, index and scoring (no DOM; shared with the tests)
data/wines.json   wine database (built)
scripts/build_db.py, scripts/vendor.mjs
test/eval.mjs, test/e2e.mjs
```
