#!/usr/bin/env python3
"""Build data/wines.json from open wine datasets.

Sources (both are public GitHub repositories, cloned on demand into scripts/.cache):
  * alfredodeza/wine-ratings  - wine-ratings.csv, ~32.8k wines scraped from wine.com
                                (name, region, variety, rating, notes)
  * rogerioxavier/X-Wines     - XWines_Test_100_wines.csv, the 100-wine test subset of the
                                X-Wines dataset (CC0), with winery / region / country / grapes.
                                The 1K and 100K subsets are hosted on Google Drive; drop the
                                CSV next to the test file (or pass --xwines) to include them.

Usage:
  python3 scripts/build_db.py                 # clone sources if needed, write data/wines.json
  python3 scripts/build_db.py --wine-ratings path/to/wine-ratings.csv --xwines path/to/XWines_*.csv

Output format (compact, see README):
  {"version": 1, "built": "...", "fields": [...], "sources": [...], "wines": [[...], ...]}
"""
import argparse
import ast
import csv
import datetime as dt
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(ROOT, "data", "wines.json")

FIELDS = ["name", "winery", "region", "country", "variety", "vintage", "vintages", "rating", "source"]

YEAR_RE = re.compile(r"\b(19[0-9]{2}|20[0-9]{2})\b")
SIZE_RE = re.compile(r"\s*\((?:[^()]*(?:ml|liter|litre|magnum|half|bottle|pack|case|gift|box)[^()]*)\)", re.I)

US_STATES = {
    "California", "Washington", "Oregon", "New York", "Virginia", "Texas", "Idaho", "Michigan",
    "Colorado", "Arizona", "New Mexico", "Pennsylvania", "Ohio", "North Carolina", "Missouri",
}


def clone(repo: str) -> str:
    """Shallow-clone a public GitHub repo into the cache dir (once) and return its path."""
    dest = os.path.join(CACHE, repo.replace("/", "__"))
    if not os.path.isdir(os.path.join(dest, ".git")):
        os.makedirs(CACHE, exist_ok=True)
        print(f"Cloning https://github.com/{repo} ...", file=sys.stderr)
        subprocess.run(
            ["git", "clone", "--depth", "1", f"https://github.com/{repo}", dest],
            check=True, env={**os.environ, "GIT_LFS_SKIP_SMUDGE": "1"},
        )
    return dest


def num(s):
    try:
        v = float(s)
        return int(v) if v.is_integer() else round(v, 1)
    except (TypeError, ValueError):
        return None


def load_wine_ratings(path: str):
    wines = []
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            name = SIZE_RE.sub("", (row.get("name") or "").strip())
            if not name:
                continue
            m = YEAR_RE.search(name)
            vintage = int(m.group(1)) if m else None
            region = (row.get("region") or "").strip()
            parts = [p.strip() for p in region.split(",") if p.strip()]
            country = None
            if parts:
                country = "USA" if parts[-1] in US_STATES else parts[-1]
                if country == "USA":
                    region = ", ".join(parts)  # keep the state; country is implicit
                else:
                    region = ", ".join(parts[:-1]) or parts[-1]
            variety = (row.get("variety") or "").strip() or None
            if variety in ("Collectible", "Boutique", "Screw Cap"):
                variety = None
            wines.append({
                "name": name, "winery": None, "region": region or None, "country": country,
                "variety": variety, "vintage": vintage, "vintages": None,
                "rating": num(row.get("rating")), "source": "wine.com",
            })
    return wines


def load_xwines(path: str):
    wines = []
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            winery = (row.get("WineryName") or "").strip()
            wname = (row.get("WineName") or "").strip()
            if not wname:
                continue
            try:
                vintages = [int(v) for v in ast.literal_eval(row.get("Vintages") or "[]") if str(v).isdigit()]
            except (ValueError, SyntaxError):
                vintages = []
            try:
                grapes = ast.literal_eval(row.get("Grapes") or "[]")
            except (ValueError, SyntaxError):
                grapes = []
            variety = ", ".join(grapes) if grapes else (row.get("Type") or None)
            name = f"{winery} {wname}".strip() if winery and not wname.lower().startswith(winery.lower()) else wname
            wines.append({
                "name": name, "winery": winery or None,
                "region": (row.get("RegionName") or "").strip() or None,
                "country": (row.get("Country") or "").strip() or None,
                "variety": variety, "vintage": None, "vintages": vintages or None,
                "rating": None, "source": "xwines",
            })
    return wines


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wine-ratings", help="path to wine-ratings.csv (default: clone alfredodeza/wine-ratings)")
    ap.add_argument("--xwines", action="append", help="path to an XWines_*_wines.csv (repeatable; default: clone rogerioxavier/X-Wines test set)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    sources = []
    wines = []

    wr = args.wine_ratings or os.path.join(clone("alfredodeza/wine-ratings"), "wine-ratings.csv")
    w = load_wine_ratings(wr)
    wines += w
    sources.append({"id": "wine.com", "name": "alfredodeza/wine-ratings (wine.com ratings)",
                    "url": "https://github.com/alfredodeza/wine-ratings", "count": len(w)})

    xw_paths = args.xwines or [os.path.join(clone("rogerioxavier/X-Wines"), "Dataset", "last", "XWines_Test_100_wines.csv")]
    n = 0
    for p in xw_paths:
        w = load_xwines(p)
        wines += w
        n += len(w)
    sources.append({"id": "xwines", "name": "X-Wines dataset (de Azambuja et al. 2023, CC0)",
                    "url": "https://github.com/rogerioxavier/X-Wines", "count": n})

    # Deduplicate exact (name, vintage) pairs, keeping the first.
    seen = set()
    unique = []
    for x in wines:
        key = (x["name"].lower(), x["vintage"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(x)

    unique.sort(key=lambda x: (x["name"].lower(), x["vintage"] or 0))
    payload = {
        "version": 1,
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": FIELDS,
        "sources": sources,
        "wines": [[x[k] for k in FIELDS] for x in unique],
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(unique)} wines to {args.out} ({os.path.getsize(args.out)/1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
