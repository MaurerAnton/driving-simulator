#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das offene Geländemodell von Nordwest-Italien – das Copernicus DEM
(GLO-30, Raster von ~30 m) aus dem offenen AWS-Vorrat copernicus-dem-30m –
und reduziert es auf das, was der Kartenbau liest.  Italienische Behörden
halten zwar eigene Modelle bereit (Piemonte: CC BY 4.0, Valle d'Aosta:
CC BY), aber nur über Portale mit Anmeldung oder über eine App – ohne
Schlüssel und ohne Registrierung bleibt das Copernicus DEM, dessen
Lizenz („Licence for Copernicus DEM instance COP-DEM-GLO-30-F Global 30m
Full, Free & Open … on a full, open and free-of-charge basis") nur den
Quellenvermerk verlangt:

    „Produced using Copernicus DEM © DLR e.V. 2010-2014 and © Airbus
     Defence and Space GmbH 2014-2018 provided under COPERNICUS by the
     European Union and ESA; all rights reserved."

    python3 -I tools/fetch-it.py --east 396..398 --north 4991..4993
    python3 -I tools/fetch-it.py --east 390..404 --north 4985..4999 --jobs 6
    python3 -I tools/fetch-it.py --east 390..404 --north 4985..4999 --published map-assets/index.json

--east/--north sind Kilometerkacheln in UTM32 (EPSG:25832), dasselbe Raster,
nach dem die Geländekacheln benannt sind: 397_4992 ist die Kachel mit der
Turiner Innenstadt.  Aus dem Rechteck wird seine geographische Fläche, und
die Kacheln von 1° × 1° des Copernicus DEM, die sie braucht (eine Kachel:
3600 × 3600 Zellen, ~43 MB), werden geholt und im Speicher gehalten.

Gelände: data/work/dgm2/<E km>_<N km>.dgm – eine Kachel von 1 km auf einem
         Raster von 2 m, Höhen in Schritten von 5 cm (in den Alpen 10 oder
         20 cm), querverpresst, gelesen von tools/mapgen/dgm.ts
Gebäude: keine.  Offene LoD2-Gebäudemodelle gibt es in Italien nicht
         (Lombardien: Portal mit Anmeldung, Ligurien: 403 auf /download/,
         Piemonte: Katalog ohne unmittelbare Adressen, Aostatal: nur über
         eine App) – die Karte bekommt ihre Häuser aus OpenStreetMap.

Warum dieses Skript die Kacheln selbst schreibt und nicht reduce_tile aus
tools/fetch-geodata.py nimmt: jene Funktion rundet auf 2 cm und fasst damit
nur Höhen bis 1310 m – im Aostatal sind es über 3000 m.  Das Format ist
dasselbe („DGM2", 500 Zellen je Seite, Schritt in der Kachel), nur der
Schritt ist hier größer; außerdem bleibt eine Zelle mit der Höhe 0 dem
„keine Höhe" des Lesers vorbehalten, weshalb echte 0 m (Meer bei Genua)
als 1 gespeichert werden.

Nötig sind Python 3 mit numpy und Pillow sowie curl.  Was schon da ist,
bleibt liegen – der Befehl kann nach einer Unterbrechung noch einmal
laufen.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import math
import os
import struct
import subprocess
import sys
import threading
import time
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py als Modul: seine Wege (data/work/…) sind auch hier die richtigen."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# the Copernicus DEM on the open bucket of AWS – licence COP-DEM-GLO-30-F, free and open, no key:
#   https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N45_00_E007_00_DEM/
#       Copernicus_DSM_COG_10_N45_00_E007_00_DEM.tif   (~43 MB, EPSG:4326, 3600 × 3600)
DEM_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com'
DEM_ZIP = (DEM_BASE + '/Copernicus_DSM_COG_10_N%02d_00_E%03d_00_DEM'
           '/Copernicus_DSM_COG_10_N%02d_00_E%03d_00_DEM.tif')
# a DEM tile: 1 degree in cells of 1/3600 degree, its pixel centres on lon/lat = whole degrees
DEM_N = 3600
DEM_DEG = 1.0 / DEM_N
# meters per height step of the reduced tile: 5 cm holds 3276 m, 10 cm holds 6553 m
STEPS = (0.05, 0.1, 0.2)

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'513..514' → (513, 514); '513' → (513, 513)"""
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


def curl_to(url, dest, attempts=6):
    """Download with curl (resumes a partial file)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(attempts):
        code = subprocess.call(
            ['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30', '-o', dest, url]
        )
        if code == 0:
            return
        # 33: the server would not resume – start again
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[it] curl ended with {code} for {os.path.basename(dest)}; trying again')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


_A = 6378137.0
_F = 1 / 298.257223563
_K0 = 0.9996
_E2 = _F * (2 - _F)
_LON0 = math.radians(9.0)


def inv_utm32(e, n):
    """UTM32 metres (arrays) → (lon, lat) in degrees; the inverse of src/geo/utm.ts."""
    import numpy as np

    x = np.asarray(e, dtype=np.float64) - 500000.0
    y = np.asarray(n, dtype=np.float64)
    mu = (y / _K0) / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    e1sq = e1 * e1
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu)
            + (21 * e1sq / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * np.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * np.sin(8 * mu))
    sin1 = np.sin(phi1)
    cos1 = np.cos(phi1)
    c1 = e1sq * cos1 ** 2
    t1 = np.tan(phi1) ** 2
    n1 = _A / np.sqrt(1 - _E2 * sin1 ** 2)
    r1 = _A * (1 - _E2) / (1 - _E2 * sin1 ** 2) ** 1.5
    d = x / (n1 * _K0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * e1sq) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * e1sq - 3 * c1 * c1) * d ** 6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                   + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * e1sq + 24 * t1 * t1) * d ** 5 / 120) / cos1
    return np.degrees(lon), np.degrees(lat)


_dem = {}
_dem_lock = threading.Lock()


def dem_tile(lat, lon):
    """The heights of one DEM tile of 1° × 1° (its south-west corner at whole degrees), held in memory."""
    with _dem_lock:
        if (lat, lon) in _dem:
            return _dem[(lat, lon)]
    path = os.path.join(GD.TMP, f'cop-N{lat:02d}E{lon:03d}.tif')
    if not os.path.exists(path) or os.path.getsize(path) < 1 << 20:
        say(f'[it] Copernicus-Kachel N{lat:02d} E{lon:03d} holen')
        curl_to(DEM_ZIP % (lat, lon, lat, lon), path)
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(path), dtype=np.float32)
    if a.shape != (DEM_N, DEM_N):
        raise ValueError(f'expected {DEM_N} x {DEM_N} cells, got {a.shape}')
    with _dem_lock:
        _dem[(lat, lon)] = a
    return a


def heights(east, north):
    """500 × 500 heights in metres for the kilometre tile: row 0 its northern edge (tools/mapgen/dgm.ts)."""
    import numpy as np

    # the centres of the cells of 2 m: eastwards along a row, southwards from row to row
    centre = np.arange(GD.DGM_N) * 2.0 + 1.0
    e = east * 1000 + centre[None, :]
    n = (north + 1) * 1000 - centre[:, None]
    lon, lat = inv_utm32(e, n)
    grid = np.full((GD.DGM_N, GD.DGM_N), np.nan, np.float32)
    for la in range(int(np.floor(lat.min())), int(np.floor(lat.max())) + 1):
        for lo in range(int(np.floor(lon.min())), int(np.floor(lon.max())) + 1):
            a = dem_tile(la, lo)
            # pixel is point (GeoKey 1025 = 2): the pixel at (0, 0) has its centre on the whole degree
            fi = (la + 1 - lat) * DEM_N
            fj = (lon - lo) * DEM_N
            there = (fi >= 0) & (fi <= DEM_N - 1) & (fj >= 0) & (fj <= DEM_N - 1)
            if not there.any():
                continue
            i0 = np.clip(np.floor(fi).astype(np.intp), 0, DEM_N - 1)
            j0 = np.clip(np.floor(fj).astype(np.intp), 0, DEM_N - 1)
            i1 = np.minimum(i0 + 1, DEM_N - 1)
            j1 = np.minimum(j0 + 1, DEM_N - 1)
            ti = (fi - i0)[there]
            tj = (fj - j0)[there]
            top = a[i0[there], j0[there]] * (1 - ti) + a[i1[there], j0[there]] * ti
            low = a[i0[there], j1[there]] * (1 - ti) + a[i1[there], j1[there]] * ti
            grid[there] = top * (1 - tj) + low * tj
    # a height below -1000 m says the same as in tools/fetch-geodata.py: none here
    grid[np.isnan(grid) | (grid <= -1000)] = np.nan
    return grid


def write_tile(grid):
    """500 × 500 heights in metres → the bytes of a reduced tile."""
    import numpy as np

    valid = np.isfinite(grid)
    if not valid.any():
        return None
    flat = np.where(valid, grid, 0.0)
    top = float(flat[valid].max())
    step = next(s for s in STEPS if top <= 65535 * s)
    # 0 stands for "no height here": the sea off Genoa is at 0 m, so the lowest cell is 1
    q = np.where(valid, np.clip(np.rint(flat / step), 1, 65535), 0).astype(np.int64)
    padded = np.zeros((GD.DGM_N + 1, GD.DGM_N + 1), np.int64)
    padded[1:, 1:] = q
    # what the left, upper and upper-left neighbours do not foretell
    rest = padded[1:, 1:] - padded[1:, :-1] - padded[:-1, 1:] + padded[:-1, :-1]
    wrapped = (rest & 0xFFFF).astype(np.uint16).astype(np.int16)
    zigzag = ((wrapped.astype(np.int32) << 1) ^ (wrapped.astype(np.int32) >> 15)).astype(np.uint16)
    planes = (zigzag & 0xFF).astype(np.uint8).tobytes() + (zigzag >> 8).astype(np.uint8).tobytes()
    return b'DGM2' + struct.pack('<HH', GD.DGM_N, round(step * 1000)) + zlib.compress(planes, 9)


def take_dgm(east, north):
    blob = write_tile(heights(east, north))
    if blob is None:
        return 0
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def dem_tiles_of(e0, e1, n0, n1):
    """Which tiles of the Copernicus DEM the rectangle needs (whole degrees south-west)."""
    import numpy as np

    corners = [(e0 * 1000, n0 * 1000), ((e1 + 1) * 1000, n0 * 1000),
               (e0 * 1000, (n1 + 1) * 1000), ((e1 + 1) * 1000, (n1 + 1) * 1000)]
    lon, lat = inv_utm32([c[0] for c in corners], [c[1] for c in corners])
    return sorted({(int(math.floor(la)), int(math.floor(lo))) for la, lo in zip(lat, lon)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (397 or 390..404)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (4992 or 4985..4999)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Italien-Nordwest', help='where the buildings would go (there are none)')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are worked on at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many kilometre tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares without terrain into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.TMP):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[it] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} Kacheln von 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[it] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerraster hat eine andere Karte schon, z. B. {overlap[:5]}')
        say(f'[it] {len(overlap)} Kilometerraster hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben weg')
            + (f', z. B. {overlap[:5]}'))
    skip = {tuple(int(v) for v in key.split('_')) for key in overlap} if args.on_overlap == 'skip' else set()

    if args.only != 'dgm':
        say('[it] Gebäudemodelle: Italien hat keine offenen LoD2-Daten – '
            'die Häuser dieser Karte kommen aus OpenStreetMap')
        if args.only == 'lod2':
            return 0

    needed = dem_tiles_of(e0, e1, n0, n1)
    say(f'[it] {len(needed)} Kacheln des Copernicus DEM: '
        + ', '.join(f'N{la:02d}E{lo:03d}' for la, lo in needed))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        list(pool.map(lambda key: dem_tile(*key), needed))

    work = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)
            if (e, n) not in skip and not os.path.exists(os.path.join(GD.DGM_OUT, f'{e}_{n}.dgm'))]
    again = (e1 - e0 + 1) * (n1 - n0 + 1) - len(skip) - len(work)
    if args.limit:
        work = work[: args.limit]
        say(f'[it] nur die ersten {len(work)} davon (--limit)')
    say(f'[it] {len(work)} Kacheln Gelände zu schreiben'
        + (f', {again} sind schon da' if again else ''))

    started = time.time()
    sizes = 0
    gaps = []

    def one(item):
        east, north = item
        size = take_dgm(east, north)
        return east, north, size

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for done, (east, north, size) in enumerate(pool.map(one, work), start=1):
            if size:
                sizes += size
            else:
                gaps.append(f'{east}_{north}')
            if done % 25 == 0 or done == len(work):
                say(f'[it] {done}/{len(work)} Kacheln – {sizes // 1024 // 1024} MB, '
                    f'{(time.time() - started) / 60:.0f} min bisher')
    say(f'[it] fertig: {len(work) - len(gaps)} Kacheln Gelände, {sizes // 1024 // 1024} MB '
        f'in {(time.time() - started) / 60:.0f} min')
    if gaps:
        say(f'[it] kein Gelände für {len(gaps)} Kilometerraster (die Karte bleibt dort draußen)'
            + (f': {", ".join(sorted(gaps)[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(sorted(gaps)) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
