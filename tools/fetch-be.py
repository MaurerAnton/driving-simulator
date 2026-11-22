# SPDX-License-Identifier: AGPL-3.0-only
#!/usr/bin/env python3
"""
Fetch the open height models of Belgium – the 1 m grid "DHMV II DTM" of
agentschap Digitaal Vlaanderen, served by its WCS at geo.api.vlaanderen.be
("Het gebruik van de service is kosteloos."; the licence the CSW metadata of
the coverage names is the "Modellicentie voor gratis hergebruik", which
data.vlaanderen.be describes as

    Elk commercieel of niet-commercieel hergebruik voor onbepaalde duur is
    toegelaten, zonder dat daar kosten aan verbonden zijn.  Als enige
    gebruiksvoorwaarde geldt een bronvermeldingsplicht.

so it is attribution-only), and, where Flanders has no 1 m data, the Copernicus
DEM GLO-30 of the European Union (its licence text, quoted from INFO/eula_F.pdf
in the bucket itself, allows free use with the attribution

    Produced using Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and
    Space GmbH 2014-2018 provided under COPERNICUS by the European Union and
    ESA; all rights reserved) – and reduce them to what the map build reads.
Buildings stay out: no CityGML of LoD2 is open in Belgium, so a Belgian map is
a terrain-only map, exactly as the build tolerates it.

    python3 -I tools/fetch-be.py --east 243 --north 5649
    python3 -I tools/fetch-be.py --east 236..250 --north 5642..5656
    python3 -I tools/fetch-be.py --east 250..264 --north 5608..5622 --source copernicus
    python3 -I tools/fetch-be.py --east 236..250 --north 5642..5656 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832): 243_5649 is the square
the Grote Markt of Hasselt stands in.  Which squares this script asks Flanders
for and which it takes from Copernicus, --source says:

    auto       – DHMV II (1 m) if the whole rectangle lies in the coverage of
                 geo.api.vlaanderen.be (Flanders and Brussels), else Copernicus
    dhmv       – DHMV II DTM 1 m, one GetCoverage request per square
    copernicus – Copernicus DEM GLO-30, one degree tile out of the public bucket
                 copernicus-dem-30m (used for Wallonia: the only 1 m product the
                 Walloon geoportal offers is a 9.5 GB zip per province)

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: every country then writes the same bytes
           Source (dhmv):       https://geo.api.vlaanderen.be/dhmv/wcs,
                                coverage DHMVII_DTM_1m, heights in metres above
                                the Belgian datum (TAW), grid in BD72 /
                                Belgian Lambert 72 (EPSG:31370)
           Source (copernicus): https://copernicus-dem-30m.s3.amazonaws.com/
                                Copernicus_DSM_COG_10_N<lat>_00_E<lon>_00_DEM/ …,
                                grid in WGS 84 (EPSG:4326), 1 arc second

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

Needs Python 3 and two packages the map build installs anyway (numpy and
Pillow).  What is already there is skipped, so the command can be repeated
after an interruption.
"""
import argparse
import importlib.util
import io
import json
import math
import os
import threading
import time
import urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py as a module: its reduce_tile writes one state's terrain – it writes ours too."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# --- the two sources ---------------------------------------------------------
WCS = 'https://geo.api.vlaanderen.be/dhmv/wcs'
COVERAGE = 'DHMVII_DTM_1m'
# what DescribeCoverage answers for DHMVII_DTM_1m: the coverage envelope in
# BD72 / Belgian Lambert 72 (EPSG:31370); the centres of its cells lie at
# 17000.5 + i, 249999.5 - j (grid origin and GridEnvelope of the description)
DHMV_LOW = (17000.0, 148000.0)
DHMV_HIGH = (264000.0, 250000.0)
COP = 'https://copernicus-dem-30m.s3.amazonaws.com'
CACHE = os.path.join(ROOT, 'data/work/belgien')
# what the two rasters call "no height": DHMV writes -9999 into it, the build
# itself treats everything below -1000 m as no height
NODATA = -1000.0
EMPTY = -32768.0

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


# --- projections -------------------------------------------------------------
# No server reprojects a raster for us and the map build installs no projection
# library, so the two chains this script needs are written here: Snyder's
# formulae on numpy arrays.  They were checked against PROJ:
#   UTM32 -> BD72 / Belgian Lambert 72 (EPSG:31370, transformation EPSG:15928
#     "BD72 to ETRS89 (2)" read backwards) agree to 8 mm over a 9 x 9 grid,
#   UTM32 -> WGS 84 latitude/longitude agree to 1 mm (the inverse of the UTM
#     formulae themselves).
GRS80 = (6378137.0, 298.257222101)
INTL24 = (6378388.0, 297.0)
DEG = math.pi / 180


def _ell(a, rf):
    f = 1.0 / rf
    return a, math.sqrt(2 * f - f * f), f


def _meridional_arc(phi, a, e):
    e2 = e * e
    return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
                - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * phi)
                + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * phi)
                - (35 * e2**3 / 3072) * np.sin(6 * phi))


def _arc_to_lat(M, a, e):
    e1 = (1 - math.sqrt(1 - e * e)) / (1 + math.sqrt(1 - e * e))
    mu = M / (a * (1 - e * e / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    return (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
            + (151 * e1**3 / 96) * np.sin(6 * mu)
            + (1097 * e1**4 / 512) * np.sin(8 * mu))


def _utm32_inverse(E, N):
    """UTM32 (EPSG:25832) -> latitude and longitude on GRS80."""
    a, e, _ = _ell(*GRS80)
    e2 = e * e
    ep2 = e2 / (1 - e2)
    x = E - 500000.0
    M = _meridional_arc(0.0, a, e) + N / 0.9996
    phi1 = _arc_to_lat(M, a, e)
    s, c, t = np.sin(phi1), np.cos(phi1), np.tan(phi1)
    C1 = ep2 * c * c
    T1 = t * t
    N1 = a / np.sqrt(1 - e2 * s * s)
    R1 = a * (1 - e2) / (1 - e2 * s * s)**1.5
    d = x / (N1 * 0.9996)
    lat = phi1 - (N1 * t / R1) * (d**2 / 2
                                  - (5 + 3 * T1 + 10 * C1 - 4 * C1**2 - 9 * ep2) * d**4 / 24
                                  + (61 + 90 * T1 + 298 * C1 + 45 * T1**2 - 252 * ep2 - 3 * C1**2) * d**6 / 720)
    lon = 9 * DEG + (d - (1 + 2 * T1 + C1) * d**3 / 6
                     + (5 - 2 * C1 + 28 * T1 - 3 * C1**2 + 8 * ep2 + 24 * T1**2) * d**5 / 120) / c
    return lat, lon


def _geo_to_xyz(lat, lon, a, e):
    e2 = e * e
    s, c = np.sin(lat), np.cos(lat)
    nu = a / np.sqrt(1 - e2 * s * s)
    return np.stack([nu * c * np.cos(lon), nu * c * np.sin(lon), nu * (1 - e2) * s])


def _xyz_to_geo(P, a, e):
    e2 = e * e
    X, Y, Z = P
    p = np.hypot(X, Y)
    lat = np.arctan2(Z, p)
    for _ in range(6):                                   # Bowring's iteration
        s = np.sin(lat)
        nu = a / np.sqrt(1 - e2 * s * s)
        lat = np.arctan2(Z + nu * e2 * s, p)
    return lat, np.arctan2(Y, X)


def _lcc_forward(lat, lon, a, e, lat0, lon0, sp1, sp2, FE, FN):
    """Snyder 15-3..15-6 with the Belgian false origin at the pole (rho0 = 0)."""
    def mf(phi):
        s = np.sin(phi)
        return np.cos(phi) / np.sqrt(1 - e * e * s * s)

    def tf(phi):
        s = np.sin(phi)
        return np.tan(np.pi / 4 + phi / 2) * ((1 - e * s) / (1 + e * s))**(e / 2)

    m1, m2, t1, t2, t0 = mf(sp1), mf(sp2), tf(sp1), tf(sp2), tf(lat0)
    n = np.log(m1 / m2) / np.log(t2 / t1)
    F = m1 * t1**n / n
    rho = a * F * tf(lat)**(-n)
    rho0 = 0.0 if abs(abs(lat0) - np.pi / 2) < 1e-12 else a * F * t0**(-n)
    theta = n * (lon - lon0)
    return FE + rho * np.sin(theta), FN + rho0 - rho * np.cos(theta)


def utm32_to_belgian72(E, N):
    """UTM32 metres -> metres of BD72 / Belgian Lambert 72 (EPSG:31370)."""
    a, e, _ = _ell(*GRS80)
    lat, lon = _utm32_inverse(np.asarray(E, dtype=np.float64), np.asarray(N, dtype=np.float64))
    P = _geo_to_xyz(lat, lon, a, e)
    # EPSG:15928 "BD72 to ETRS89 (2)" read backwards – coordinate frame rotation
    tx, ty, tz = 106.8686, -52.2978, 103.7239
    rx, ry, rz = 0.3366, -0.457, 1.8422
    ds = 1.2747
    r = np.array([rx, ry, rz]) * math.pi / (180 * 3600)
    R = np.array([[1, r[2], -r[1]], [-r[2], 1, r[0]], [r[1], -r[0], 1]])
    Q = (1 + ds * 1e-6) * (R @ P.reshape(3, -1)) + np.array([tx, ty, tz])[:, None]
    ab, eb, _ = _ell(*INTL24)
    latb, lonb = _xyz_to_geo(Q.reshape(P.shape), ab, eb)
    return _lcc_forward(latb, lonb, ab, eb, 90 * DEG, 4.36748666666667 * DEG,
                        51.1666672333333 * DEG, 49.8333339 * DEG, 150000.013, 5400088.438)


# --- the height rasters ------------------------------------------------------
def http_get(url, tries=4):
    """The bytes of an address, with patience: a WCS that is busy answers late."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=600) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == tries - 1:
                raise
            say(f'[be] {e}; trying again in {20 * (attempt + 1)} s')
            time.sleep(20 * (attempt + 1))
    raise RuntimeError(url)


def coverage_part(data):
    """The GeoTIFF out of the multipart/related answer of a GetCoverage request."""
    chunks = data.split(b'--wcs')
    for part in chunks:
        if b'Content-Type: image/tiff' in part:
            sep = b'\r\n\r\n' if b'\r\n\r\n' in part else b'\n\n'
            return part.split(sep, 1)[1].rstrip(b'\r\n')
    raise RuntimeError(f'no GeoTIFF in the answer ({len(data)} bytes)')


def read_tiff(data):
    """A GeoTIFF in memory -> heights, the tie point and the size of a cell."""
    image = Image.open(io.BytesIO(data))
    tie = image.tag_v2.get(33922)
    scale = image.tag_v2.get(33550)
    a = np.asarray(image, dtype=np.float32)
    if tie is None or scale is None:
        raise RuntimeError('the GeoTIFF carries no tie point or pixel scale')
    return a, float(tie[3]), float(tie[4]), float(scale[0]), float(scale[1])


def dhmv_window(lo_x, hi_x, lo_y, hi_y):
    """One window out of the Flemish 1 m grid; SUBSET asks in metres of BD72."""
    url = (f'{WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={COVERAGE}'
           f'&FORMAT=image/tiff&SUBSET=x({lo_x},{hi_x})&SUBSET=y({lo_y},{hi_y})')
    data = http_get(url)
    a, tie_x, tie_y, sx, sy = read_tiff(coverage_part(data))
    # the tie point is the upper left corner of the window, so the centre of the
    # cell (row, column) lies at tie_x + (column + 0.5) * sx, tie_y - (row + 0.5) * sy
    return a, tie_x + 0.5 * sx, tie_y - 0.5 * sy, sx, sy


def cop_name(lat, lon):
    """The degree tile of Copernicus a point falls into (its south west corner names it)."""
    return (f'Copernicus_DSM_COG_10_N{math.floor(lat):02d}_00_E{math.floor(lon):03d}_00_DEM')


def cop_tile(name):
    """The 1 degree tile of Copernicus, whole: 2400 x 3600 cells, once a rectangle."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name + '.tif')
    if not os.path.exists(path) or os.path.getsize(path) < 1 << 20:
        url = f'{COP}/{name}/{name}.tif'
        say(f'[be] {name}: fetching the degree tile')
        blob = http_get(url)
        with open(path + '.part', 'wb') as f:
            f.write(blob)
        os.replace(path + '.part', path)
    a, lon0, lat0, sx, sy = read_tiff(open(path, 'rb').read())
    # GeoKey 1025 = 2: RasterPixelIsPoint – the tie point is the centre of the
    # first cell, so the centre of (row, column) is at lon0 + column * sx, lat0 - row * sy
    return a, lon0, lat0, sx, sy


# --- one kilometre square ----------------------------------------------------
def square_grid(east, north):
    """The centres of the 1000 x 1000 cells of one kilometre square, in UTM32."""
    col = np.arange(1000, dtype=np.float64) + 0.5
    row = np.arange(1000, dtype=np.float64) + 0.5
    E = (east * 1000.0 + col)[None, :]
    N = (north * 1000.0 + 1000.0 - row)[:, None]
    return E, N


def bilinear(window, x0, y0, sx, sy, X, Y):
    """Heights read between the cells: X, Y of the source grid, bilinear."""
    wide = window.shape[1]
    col = (X - x0) / sx
    row = (y0 - Y) / sy
    ci = np.floor(col).astype(np.int64)
    ri = np.floor(row).astype(np.int64)
    ci = np.clip(ci, 0, wide - 2)
    ri = np.clip(ri, 0, window.shape[0] - 2)
    fx = (col - ci).astype(np.float32)
    fy = (row - ri).astype(np.float32)
    flat = window.ravel()
    base = ri * wide + ci
    v00 = flat[base]
    v01 = flat[base + 1]
    v10 = flat[base + wide]
    v11 = flat[base + wide + 1]
    h = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy
    # a neighbour without a height makes no height: EMPTY stays outside > -1000
    empty = (v00 <= NODATA) | (v01 <= NODATA) | (v10 <= NODATA) | (v11 <= NODATA)
    h[empty] = EMPTY
    return h, empty


def heights_from_dhmv(east, north):
    X, Y = utm32_to_belgian72(*square_grid(east, north))
    lo_x = math.floor(X.min()) - 2
    hi_x = math.ceil(X.max()) + 2
    lo_y = math.floor(Y.min()) - 2
    hi_y = math.ceil(Y.max()) + 2
    window, x0, y0, sx, sy = dhmv_window(lo_x, hi_x, lo_y, hi_y)
    return bilinear(window, x0, y0, sx, sy, X, Y)


def heights_from_copernicus(east, north):
    E, N = square_grid(east, north)
    # the raster is gridded in degrees of WGS 84 (EPSG:4326)
    lat, lon = [v / DEG for v in _utm32_inverse(E, N)]
    h = np.full(lat.shape, EMPTY, dtype=np.float32)
    empty = np.ones(lat.shape, dtype=bool)
    done = set()
    # one square lies in one degree tile, at a degree boundary in two
    for i in range(0, 1000, 999):
        for j in range(0, 1000, 999):
            name = cop_name(lat[i, j], lon[i, j])
            if name in done:
                continue
            done.add(name)
            window, lon0, lat0, sx, sy = cop_tile(name)
            one, gone = bilinear(window, lon0, lat0, sx, sy, lon, lat)
            # only where this tile really holds the point does it count
            col = (lon - lon0) / sx
            row = (lat0 - lat) / sy
            inside = (col >= 0) & (col < window.shape[1]) & (row >= 0) & (row < window.shape[0])
            h[inside] = one[inside]
            empty[inside] = gone[inside]
    return h, empty


def write_tile(heights, east, north):
    """A 1000 x 1000 TIFF -> data/work/dgm2/<E>_<N>.dgm, as tools/fetch-geodata.py writes it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    buffer = io.BytesIO()
    Image.fromarray(heights, mode='F').save(buffer, format='TIFF')
    blob = GD.reduce_tile(buffer.getvalue())
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def span(text):
    """'236..250' → (236, 250); '243' → (243, 243)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'not a range of kilometres: {text}')
    return tuple(values)


def tile_keys(east, north):
    """The four tiles of 500 m a kilometre square covers, named as map-assets does ('434_363')."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def choose_source(source, east, north):
    """auto: the 1 m grid of Flanders where it covers the whole rectangle."""
    if source != 'auto':
        return source
    E = np.array([east[0] * 1000.0, east[1] * 1000.0 + 1000.0])
    N = np.array([north[0] * 1000.0, north[1] * 1000.0 + 1000.0])
    X, Y = utm32_to_belgian72(E[None, :], N[:, None])
    inside = (X.min() >= DHMV_LOW[0] and X.max() <= DHMV_HIGH[0]
              and Y.min() >= DHMV_LOW[1] and Y.max() <= DHMV_HIGH[1])
    return 'dhmv' if inside else 'copernicus'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (243 or 236..250)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5649 or 5642..5656)')
    ap.add_argument('--source', choices=['auto', 'dhmv', 'copernicus'], default='auto',
                    help='which height model is read (auto: DHMV where it covers the rectangle)')
    ap.add_argument('--limit', type=int, default=0, help='only this many squares (to try the way first)')
    ap.add_argument('--dry', action='store_true', help='only say what would be fetched')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares without any height into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    wanted = [(e, n) for n in range(n1, n0 - 1, -1) for e in range(e0, e1 + 1)]
    source = choose_source(args.source, args.east, args.north)
    say(f'[be] east {e0}..{e1} km, north {n0}..{n1} km – {len(wanted)} squares of 1 km, '
        f'heights from {"DHMV II DTM 1 m (Flanders)" if source == "dhmv" else "Copernicus DEM GLO-30"}')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[be] {args.published}: {len(known)} tiles of other maps')

    overlap = [f'{e}_{n}' for e, n in wanted if tile_keys(e, n) & known]
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[be] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = [(e, n) for e, n in wanted if f'{e}_{n}' not in skip]
    done = [k for k in work if os.path.exists(os.path.join(GD.DGM_OUT, f'{k[0]}_{k[1]}.dgm'))]
    if done:
        say(f'[be] {len(done)} squares are already reduced and are skipped')
    todo = [k for k in work if k not in done]
    if args.limit:
        todo = todo[: args.limit]
        say(f'[be] only the first {len(todo)} of them (--limit)')
    if args.dry:
        say(f'[be] {len(todo)} squares to fetch of {len(wanted)}')
        return 0
    if not todo:
        say('[be] nothing to fetch')
        return 0

    take = heights_from_dhmv if source == 'dhmv' else heights_from_copernicus
    gaps = []
    made = 0
    started = time.time()
    for east, north in todo:
        try:
            h, empty = take(east, north)
        except OSError as e:
            # Now and then the WCS answers with a GeoTIFF that ends early.  Rather
            # than leaving the rectangle unfinished, take the other open source
            # for this one square: 30 m where 1 m was wanted, but no hole.
            if source != 'dhmv':
                raise
            say(f'[be] {east}_{north}: DHMV answered truncated ({e}) - '
                f'this square from Copernicus')
            h, empty = heights_from_copernicus(east, north)
        if empty.all():
            say(f'[be] {east}_{north}: the source has no height there')
            gaps.append(f'{east}_{north}')
            continue
        size = write_tile(h, east, north)
        made += 1
        say(f'[be] {east}_{north}: {size / 1024:.0f} KB, '
            f'{h[~empty].min():.0f}..{h[~empty].max():.0f} m'
            + (f', {100 * empty.mean():.1f} % without height' if empty.any() else '')
            + f' ({made} of {len(todo)}, {(time.time() - started) / made:.1f} s each)')

    say(f'[be] {made} squares in {time.time() - started:.0f} s; {len(gaps)} without height')
    if gaps and args.gaps:
        with open(args.gaps, 'w') as f:
            f.write('\n'.join(gaps) + '\n')
        say(f'[be] the squares without height stand in {args.gaps}')
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main())
