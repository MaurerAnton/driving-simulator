#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model of Switzerland (swissALTI3D, 2 m) – open
geodata of the Federal Office of Topography swisstopo, "Terms of use for free
geodata and geoservices (OGD) from swisstopo", attribution only – and reduce
it to what the map build reads.  It does for Switzerland what
tools/fetch-geodata.py does for Hesse; two things are different here:

  * The tiles are named after a grid of their own, LV95 (EPSG:2056), which is
    turned against UTM32 (EPSG:25832) by about one degree.  Every UTM32 square
    of 1 km is therefore put together from up to four LV95 tiles – what lies
    at a cell centre is taken from the LV95 cell of 2 m it falls into.  The
    transformation is done here in numpy (LV95 -> WGS84 -> UTM32 after the
    rigorous formulas of swisstopo's refsys.pdf), because the runner has no
    PROJ.
  * Switzerland reaches higher than Germany: much of its surface lies above
    1310 m, and 65535 times 2 cm would end there.  These tiles keep their step
    of 5 cm (3276 m is reached then, enough for every place a road goes), in
    the same reduced form otherwise (header DGM2, 500 cells a side).

    python3 -I tools/fetch-ch.py --east 382..383 --north 5201..5202
    python3 -I tools/fetch-ch.py --east 375..389 --north 5194..5208 --jobs 8
    python3 -I tools/fetch-ch.py --east 375..389 --north 5194..5208 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
reduced tiles are named after: 382_5201 is the square the town hall of Bern
stands in.  Which LV95 tiles exist, the STAC catalogue of data.geo.admin.ch
says and, where it does not, the tile itself is asked for (swissALTI3D is
released year by year and canton by canton: newest stand first).  Squares for
which Switzerland has no terrain (German or French land inside the rectangle)
are named at the end – the map is built where terrain is
(tools/osm-extract.ts), so those squares stay out of the map.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – a grid of 2 m, heights in steps
           of 5 cm, predicted from the neighbours and deflated
           Source: https://data.geo.admin.ch/ch.swisstopo.swissalti3d/
                   swissalti3d_<year>_<E km>-<N km>/swissalti3d_<year>_<E km>-<N km>_2_2056_5728.tif

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

Building models: swissBUILDINGS3D 3.0 Beta gives Switzerland in CityGML too,
but only where the federal building identifier is in, and those files are not
part of the free download (its catalogue holds only DWG and ESRI FileGDB per
tile, neither of which can be read without a licence of its own).  Buildings
of these maps therefore come from OpenStreetMap, as in every other map.

Needs Python 3 with numpy and Pillow.  What is already there is skipped, so
the command can be repeated after an interruption.
"""
import argparse
import concurrent.futures
import io
import json
import math
import os
import re
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import zlib

try:
    import numpy as np
    from PIL import Image
except ImportError as e:  # noqa: BLE001 - numpy and Pillow are what the runner installs
    sys.exit(f'[ch] {e} – pip install numpy pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT = 'map-fetch/0.1'
STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items'
TERRAIN = ('https://data.geo.admin.ch/ch.swisstopo.swissalti3d/'
           'swissalti3d_{year}_{tile}/swissalti3d_{year}_{tile}_2_2056_5728.tif')
# the newest stand is asked for first; 2019 is the oldest the catalogue names
YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019]
DGM_OUT = os.path.join(ROOT, 'data/work/dgm2')
CACHE = os.path.join(ROOT, 'data/work/ch')

# the reduced terrain tile: cells per side, metres per height step
DGM_N = 500
DGM_STEP = 0.05

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


# --- LV95 (EPSG:2056) <-> UTM32 (EPSG:25832) --------------------------------
# The Swiss projection is an oblique conformal cylinder; the formulas are the
# ones of swisstopo (refsys.pdf) as PROJ keeps them in its somerc, and CH1903+
# (Bessel) and CHTRS95 (GRS80) are moved into each other by the official
# translation (-674.374, -15.056, -405.346).  Everything below works on whole
# arrays: one UTM32 square is 500 x 500 cell centres at once.

BES_A = 6377397.155
BES_ES = 0.006674372230614
PHI0 = math.radians(46 + (57 + 8.66 / 60) / 60)
LAM0 = math.radians(7 + (26 + 22.50 / 60) / 60)
E_BES = math.sqrt(BES_ES)

WGS_A = 6378137.0
WGS_F = 1 / 298.257222101
WGS_ES = WGS_F * (2 - WGS_F)

_C = math.sqrt(1 + BES_ES * math.cos(PHI0) ** 4 / (1 - BES_ES))
_SINP0 = math.sin(PHI0) / _C
_COSP0 = math.cos(math.asin(_SINP0))
_K = (math.log(math.tan(math.pi / 4 + math.asin(_SINP0) / 2))
      - _C * (math.log(math.tan(math.pi / 4 + PHI0 / 2))
              - (E_BES / 2) * math.log((1 + E_BES * math.sin(PHI0)) / (1 - E_BES * math.sin(PHI0)))))
_KR = math.sqrt(1 - BES_ES) / (1 - BES_ES * math.sin(PHI0) ** 2) * BES_A
LV95_E0 = 2600000.0
LV95_N0 = 1200000.0
_DX, _DY, _DZ = -674.374, -15.056, -405.346

_UTM_K0 = 0.9996
_E1 = (1 - math.sqrt(1 - WGS_ES)) / (1 + math.sqrt(1 - WGS_ES))
_LON0 = math.radians(9)
# UTM32 north as a series in the latitude (the inverse of the meridian arc)
_M0 = WGS_A * (1 - WGS_ES / 4 - 3 * WGS_ES ** 2 / 64 - 5 * WGS_ES ** 3 / 256)
_M2 = 3 * _E1 / 2 - 27 * _E1 ** 3 / 32
_M4 = 21 * _E1 ** 2 / 16 - 55 * _E1 ** 4 / 32
_M6 = 151 * _E1 ** 3 / 96
_M8 = 1097 * _E1 ** 4 / 512


def _utm32_wgs84(east, north):
    """UTM32 metres -> WGS84 latitude, longitude (arrays, radians)."""
    m = north / _UTM_K0
    mu = m / _M0
    phi1 = (mu + _M2 * np.sin(2 * mu) + _M4 * np.sin(4 * mu) + _M6 * np.sin(6 * mu) + _M8 * np.sin(8 * mu))
    ep2 = WGS_ES / (1 - WGS_ES)
    s1 = np.sin(phi1)
    c1 = ep2 * np.cos(phi1) ** 2
    t1 = np.tan(phi1) ** 2
    n1 = WGS_A / np.sqrt(1 - WGS_ES * s1 * s1)
    r1 = WGS_A * (1 - WGS_ES) / (1 - WGS_ES * s1 * s1) ** 1.5
    d = (east - 500000) / (n1 * _UTM_K0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (
        d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                   + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / np.cos(phi1)
    return lat, lon


def _wgs84_lv95(lat, lon):
    """WGS84 latitude, longitude (arrays, radians) -> LV95 metres."""
    nu = WGS_A / np.sqrt(1 - WGS_ES * np.sin(lat) ** 2)
    x = nu * np.cos(lat) * np.cos(lon) + _DX
    y = nu * np.cos(lat) * np.sin(lon) + _DY
    z = (nu * (1 - WGS_ES)) * np.sin(lat) + _DZ
    # back to the Bessel ellipsoid: latitude and longitude of the Swiss datum
    p = np.hypot(x, y)
    lam = np.arctan2(y, x)
    phi = np.arctan2(z, p * (1 - BES_ES))
    for _ in range(8):
        nu = BES_A / np.sqrt(1 - BES_ES * np.sin(phi) ** 2)
        h = p / np.cos(phi) - nu
        phi = np.arctan2(z, p * (1 - BES_ES * nu / (nu + h)))
    # the Swiss oblique conformal cylinder itself
    sp = E_BES * np.sin(phi)
    phip = 2 * np.arctan(np.exp(_C * (np.log(np.tan(np.pi / 4 + phi / 2))
                                      - (E_BES / 2) * np.log((1 + sp) / (1 - sp))) + _K)) - np.pi / 2
    lamp = _C * (lam - LAM0)
    cp = np.cos(phip)
    phipp = np.arcsin(_COSP0 * np.sin(phip) - _SINP0 * cp * np.cos(lamp))
    lampp = np.arcsin(cp * np.sin(lamp) / np.cos(phipp))
    return LV95_E0 + _KR * lampp, LV95_N0 + _KR * np.log(np.tan(np.pi / 4 + phipp / 2))


def utm32_lv95(east, north):
    """UTM32 metres (arrays) -> LV95 metres (arrays)."""
    lat, lon = _utm32_wgs84(east, north)
    return _wgs84_lv95(lat, lon)


# --- what the open data hold ------------------------------------------------


def read(url, attempts=5, method='GET'):
    """A GET or HEAD on data.geo.admin.ch – services there answer with JSON or bytes."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': AGENT}, method=method),
                                        timeout=180) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, b''
            if attempt == attempts - 1:
                raise
            say(f'[ch] {e.code} bei {os.path.basename(urllib.parse.unquote(url))}; noch einmal')
            time.sleep(5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[ch] {e} bei {os.path.basename(urllib.parse.unquote(url))}; noch einmal')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def wgs84_box(e0, e1, n0, n1):
    """The WGS84 frame of a rectangle of UTM32 squares (for the STAC search)."""
    east = np.array([e0 * 1000.0, (e1 + 1) * 1000.0, e0 * 1000.0, (e1 + 1) * 1000.0])
    north = np.array([n0 * 1000.0, (n1 + 1) * 1000.0, (n1 + 1) * 1000.0, n0 * 1000.0])
    lat, lon = _utm32_wgs84(east, north)
    return math.degrees(lon.min()), math.degrees(lat.min()), math.degrees(lon.max()), math.degrees(lat.max())


def stac_items(bbox, pages=12):
    """Which LV95 tiles of swissALTI3D the catalogue holds in the frame: tile -> newest year.

    STAC wants WGS84.  A tile comes out several times (one stand per year), the
    newest one wins; the search answers page by page.
    """
    found = {}
    url = STAC + '?' + urllib.parse.urlencode({'bbox': '%.6f,%.6f,%.6f,%.6f' % bbox, 'limit': 100})
    for _ in range(pages):
        status, body = read(url)
        if status != 200:
            say(f'[ch] Katalog: {status} – die Kacheln werden einzeln gefragt')
            return found
        page = json.loads(body)
        for feature in page.get('features', []):
            m = re.match(r'^swissalti3d_(\d{4})_(\d+)-(\d+)$', feature['id'])
            if not m:
                continue
            year = int(m[1])
            tile = f'{m[2]}-{m[3]}'
            if tile not in found or found[tile] < year:
                found[tile] = year
        nxt = next((l['href'] for l in page.get('links', []) if l.get('rel') == 'next'), None)
        if not nxt:
            break
        url = nxt
    return found


def available(tile, catalog):
    """Which stand of one LV95 tile can be fetched: its year, or None.

    The catalogue said which tiles there are and which year each stands at; a
    tile it does not name (foreign land inside the rectangle, or a stand newer
    than the index) is asked for year by year.
    """
    order = [catalog[tile]] if tile in catalog else []
    order += [y for y in YEARS if y not in order]
    for year in order:
        if read(TERRAIN.format(year=year, tile=tile), attempts=3, method='HEAD')[0] == 200:
            return year
    return None


def fetch_tile(tile, year):
    """One LV95 tile of 2 m into data/work/ch – the squares read it from there."""
    path = os.path.join(CACHE, f'{tile}.tif')
    if os.path.exists(path):
        return 0
    status, body = read(TERRAIN.format(year=year, tile=tile))
    if status != 200:
        raise RuntimeError(f'{tile}: Stand {year} genannt, gelesen wurde {status}')
    with open(path + '.tmp', 'wb') as f:
        f.write(body)
    os.replace(path + '.tmp', path)
    return len(body)


def tile_array(tile):
    """The heights of one cached LV95 tile: 500 x 500 cells of 2 m, metres."""
    with open(os.path.join(CACHE, f'{tile}.tif'), 'rb') as f:
        a = np.asarray(Image.open(io.BytesIO(f.read())), dtype=np.float32)
    if a.shape != (DGM_N, DGM_N):
        raise ValueError(f'{tile}: erwartet {DGM_N} x {DGM_N} Zellen, bekommen {a.shape}')
    return a


def lv95_tiles_of(east, north):
    """Which LV95 tiles of 1 km one UTM32 square of 1 km falls into.

    The two grids are turned against each other by about a degree and their
    metres differ a little, so the four corners of the square are transformed
    and everything between the smallest and the largest kilometre asked for.
    """
    corners = utm32_lv95(np.array([east * 1000.0, (east + 1) * 1000.0, east * 1000.0, (east + 1) * 1000.0]),
                         np.array([north * 1000.0, (north + 1) * 1000.0, (north + 1) * 1000.0, north * 1000.0]))
    e, n = corners
    tiles = []
    # the transformation is affine enough over a kilometre: the four corners
    # hold everything between them
    for te in range(int(np.floor(e.min() / 1000.0)), int(np.floor(e.max() / 1000.0)) + 1):
        for tn in range(int(np.floor(n.min() / 1000.0)), int(np.floor(n.max() / 1000.0)) + 1):
            tiles.append(f'{te}-{tn}')
    return tiles


def reduce_tile(heights, valid):
    """500 x 500 heights in metres -> the bytes of a reduced tile (step 5 cm).

    As tools/fetch-geodata.py writes them, only without the averaging of two by
    two cells: the LV95 grid is 2 m itself, which is the grid of the tile.
    0 stands for "no height here".
    """
    mean = np.where(valid, heights, 0.0)
    q = np.clip(np.rint(mean / DGM_STEP), 0, 65535).astype(np.int64)
    padded = np.zeros((DGM_N + 1, DGM_N + 1), np.int64)
    padded[1:, 1:] = q
    # what the left, upper and upper-left neighbours do not foretell
    rest = padded[1:, 1:] - padded[1:, :-1] - padded[:-1, 1:] + padded[:-1, :-1]
    wrapped = (rest & 0xFFFF).astype(np.uint16).astype(np.int16)
    zigzag = ((wrapped.astype(np.int32) << 1) ^ (wrapped.astype(np.int32) >> 15)).astype(np.uint16)
    planes = (zigzag & 0xFF).astype(np.uint8).tobytes() + (zigzag >> 8).astype(np.uint8).tobytes()
    return b'DGM2' + struct.pack('<HH', DGM_N, round(DGM_STEP * 1000)) + zlib.compress(planes, 9)


def take_dgm(east, north, arrays):
    """One UTM32 square of 1 km -> data/work/dgm2/<E>_<N>.dgm.

    arrays maps every LV95 tile the square falls into to its heights (None for
    tiles the country has none of).
    """
    out = os.path.join(DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return None
    # the centres of the cells: 500 a side, 2 m apart, the first row in the north
    at = np.arange(DGM_N)
    easting = east * 1000.0 + 2 * at + 1
    northing = (north + 1) * 1000.0 - 2 * at - 1
    gx, gy = np.meshgrid(easting, northing)
    e, n = utm32_lv95(gx.ravel(), gy.ravel())
    heights = np.zeros(DGM_N * DGM_N, dtype=np.float64)
    valid = np.zeros(DGM_N * DGM_N, dtype=bool)
    for tile, a in arrays.items():
        if a is None:
            continue
        te, tn = tile.split('-')
        te = int(te) * 1000.0
        tn = int(tn) * 1000.0
        inside = (e >= te) & (e < te + 1000.0) & (n >= tn) & (n < tn + 1000.0)
        if not inside.any():
            continue
        col = np.clip(((e[inside] - te) / 2.0).astype(np.int64), 0, DGM_N - 1)
        row = np.clip(((tn + 1000.0 - n[inside]) / 2.0).astype(np.int64), 0, DGM_N - 1)
        value = a[row, col]
        good = np.isfinite(value) & (value > -1000.0)
        heights[inside] = np.where(good, value, 0.0)
        valid[inside] = good
    if not valid.any():
        return 0
    blob = reduce_tile(heights.reshape(DGM_N, DGM_N), valid.reshape(DGM_N, DGM_N))
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return (float(heights[valid].max()), int(valid.sum()), valid.size)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', required=True, help='Kilometerquadrate nach Osten, UTM32 (382 oder 375..389)')
    ap.add_argument('--north', required=True, help='Kilometerquadrate nach Norden, UTM32 (5201 oder 5194..5208)')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Kacheln zugleich gelesen werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kacheln (um den Weg zu probieren)')
    ap.add_argument('--dry', action='store_true', help='nur sagen, was geholt würde')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit ihnen geschieht')
    ap.add_argument('--gaps', help='in diese Datei die Quadrate schreiben, für die die Schweiz kein Gelände hat')
    args = ap.parse_args()

    def span(text, where):
        values = [int(v) for v in re.split(r'\.\.|\s+', text.strip()) if v]
        if len(values) == 1:
            values *= 2
        if len(values) != 2 or values[0] > values[1]:
            ap.error(f'{where}: {text} ist kein Bereich von Kilometern')
        return tuple(values)

    e0, e1 = span(args.east, '--east')
    n0, n1 = span(args.north, '--north')
    wanted = [f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    say(f'[ch] Osten {e0}..{e1} km, Norden {n0}..{n1} km – {len(wanted)} Quadrate von 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[ch] {args.published}: {len(known)} Kacheln anderer Karten')

    # the frame of the map is UTM32, its tiles of 500 m are named after the world grid
    WORLD_ORIGIN_E = 528000
    WORLD_ORIGIN_N = 5678000
    GRID_OFFSET = 200_000

    def tile_keys(key):
        east, north = [int(v) for v in key.split('_')]
        x0 = east * 1000 - WORLD_ORIGIN_E
        z0 = WORLD_ORIGIN_N - (north + 1) * 1000
        return {f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
                for dx in (0, 1) for dz in (0, 1)}

    overlap = [k for k in wanted if tile_keys(k) & known]
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Quadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[ch] {len(overlap)} Quadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + f', z. B. {overlap[:5]}')
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    for sub in (DGM_OUT, CACHE):
        os.makedirs(sub, exist_ok=True)

    box = wgs84_box(e0, e1, n0, n1)
    say(f'[ch] Rahmen in WGS84: {box[0]:.4f}/{box[1]:.4f} bis {box[2]:.4f}/{box[3]:.4f}')
    catalog = stac_items(box)
    say(f'[ch] Katalog: {len(catalog)} LV95-Kacheln swissALTI3D im Rahmen'
        + (f', neueste Stände {", ".join(str(y) for y in sorted(set(catalog.values())))}' if catalog else ''))

    work = [k for k in wanted if k not in skip]
    if args.limit:
        work = work[: args.limit]
        say(f'[ch] nur die ersten {len(work)} davon (--limit)')

    if args.dry:
        needed = {t for key in work for t in lv95_tiles_of(*[int(v) for v in key.split('_')])}
        say(f'[ch] es würden {len(needed)} LV95-Kacheln gebraucht, davon im Katalog: '
            f'{len([t for t in needed if t in catalog])}')
        return 0

    started = time.time()
    # 1. which LV95 tiles the rectangle needs, with the stand each is at
    needs = {key: lv95_tiles_of(*[int(v) for v in key.split('_')]) for key in work}
    wanted_tiles = sorted({t for tiles in needs.values() for t in tiles})
    say(f'[ch] {len(wanted_tiles)} LV95-Kacheln werden gebraucht ({len(work)} Quadrate)')

    def probe(tile):
        return tile, available(tile, catalog)

    years = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, (tile, year) in enumerate(pool.map(probe, wanted_tiles), start=1):
            if year is not None:
                years[tile] = year
            if done % 50 == 0 or done == len(wanted_tiles):
                say(f'[ch] {done}/{len(wanted_tiles)} LV95-Kacheln erfragt, {len(years)} davon vorhanden '
                    f'– {(time.time() - started) / 60:.0f} min bisher')
    gaps_lv95 = [t for t in wanted_tiles if t not in years]
    say(f'[ch] swissALTI3D für {len(years)} LV95-Kacheln, kein Gelände für {len(gaps_lv95)}'
        + (f' (z. B. {", ".join(gaps_lv95[:6])})' if gaps_lv95 else ''))

    # 2. the tiles themselves, every one read once
    got = 0
    read_bytes = 0

    def pull(item):
        return fetch_tile(*item)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, size in enumerate(pool.map(pull, sorted(years.items())), start=1):
            got += size > 0
            read_bytes += size
            if done % 50 == 0 or done == len(years):
                say(f'[ch] {done}/{len(years)} LV95-Kacheln geholt ({read_bytes / 1048576:.0f} MB) '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    # 3. every UTM32 square out of up to four LV95 tiles
    highest = 0.0
    highest_key = None
    made = 0
    there = 0
    gaps = []

    def one(key):
        east, north = [int(v) for v in key.split('_')]
        arrays = {t: (tile_array(t) if t in years else None) for t in needs[key]}
        return take_dgm(east, north, arrays)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for key, top in zip(work, pool.map(one, work)):
            if top is None:
                there += 1
                continue
            if top == 0:
                gaps.append(key)
                continue
            made += 1
            if top[0] > highest:
                highest = top[0]
                highest_key = key
            if top[1] < top[2]:
                say(f'[ch] Quadrat {key}: {top[2] - top[1]} von {top[2]} Zellen ohne Gelände')

    say(f'[ch] fertig: {made} Quadrate Gelände ({there} waren schon da, {read_bytes / 1048576:.0f} MB gelesen), '
        f'{(time.time() - started) / 60:.0f} min')
    if highest_key:
        say(f'[ch] höchster Punkt des Rechtecks: {highest:.1f} m (LN02) im Quadrat {highest_key}')
    if gaps:
        say(f'[ch] kein Gelände der Schweiz für {len(gaps)} Quadrate (die Karte bleibt dort draußen)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
