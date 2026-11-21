#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain models of the two provinces of Trentino-Südtirol – the
autonomous province of Trento serves its laser-scan terrain of 2014 sheet by sheet of
500 m (CC BY 4.0), that of Bolzano serves its terrain of 0.5 m and 2.5 m through a
GeoServer WCS (CC0) – and reduce them to what the map build reads.  It does for these
two provinces what tools/fetch-geodata.py does for Hesse.

    python3 -I tools/fetch-tn.py --east 657..671 --north 5098..5112
    python3 -I tools/fetch-tn.py --east 674..688 --north 5145..5159 --lod2-name Bozen
    python3 -I tools/fetch-tn.py --east 657..671 --north 5098..5112 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the terrain tiles
are named after: 664_5105 is the tile the town of Trento lies in, 681_5152 that of Bozen.
Which province a tile belongs to – and so where its terrain comes from – is decided by
its north: south of the Salurner Klause (5120 km) it is Trento, north of it Bolzano; only
those two provinces publish open terrain, and each covers its own.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py, which is
           read here for it: both provinces then write the same bytes.  Not every 500 m
           sheet exists (Campolongo and parts of the Dolomites were not flown); a kilometre
           square one sheet is missing for is left out and named at the end – the map is
           built where terrain is (tools/osm-extract.ts), so those squares simply stay out
           of the map.
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts.

Neither province publishes open building models of LoD2 without a key (November 2026);
what is found later can be handed in with --lod2-source <list>: one line per kilometre
square, "<E>_<N> <url of a CityGML file or archive>", read by tools/lod2-extract.ts.

Because the terrain of these valleys reaches from 190 m to over 3000 m, one tile cannot
hold it with the 2 cm of tools/fetch-geodata.py: the step here is 5 cm, which is what the
header of every tile says (3276 m is then the highest it can hold).

--published <map-assets/index.json> keeps this map from covering a tile another map already
has: two maps must not hold the same tile of 500 m, because in the index of the parts a
tile key belongs to one map.  Every kilometre square the named index already knows is left
out (with --on-overlap fail instead the script stops and names them).

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py), curl and node.
What is already there is skipped, so the command can be repeated after an interruption.
"""
import argparse
import concurrent.futures
import gzip
import importlib.util
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py as a module: its reduce_tile writes Hesse's terrain – it writes ours too."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()
# the mountains here are higher than what 2 cm per step can hold – 5 cm reach 3276 m
GD.DGM_STEP = 0.05

AGENT = GD.AGENT

# Trento: one ESRI ASCII grid of 1000 x 1000 cells of 0.5 m per sheet of 500 m, named after
# the west and south edge of the sheet in hectometres (664051045 covers 664000-664500 E,
# 5104500-5105000 N); licence CC BY 4.0
ASC = 'https://siatservices.provincia.tn.it/stemdata/2014_lidar_dtm_asc/5h%04d%05d_DTM.asc'
# Bolzano: WCS 2.0.1 of the province's GeoServer, terrain of 0.5 m (2000 x 2000 cells per
# kilometre) and of 2.5 m (400 x 400); licence CC0
WCS = 'https://geoservices9.civis.bz.it/geoserver/wcs'
COVERAGE = {
    '05m': 'p_bz-Elevation__DigitalTerrainModel-0.5m',
    '25m': 'p_bz-Elevation__DigitalTerrainModel-2.5m',
}
# north of this line Bolzano serves the tile, south of it Trento
BORDER_N = 5120
CACHE = os.path.join(ROOT, 'data/work/trentino')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'657..671' → (657, 671); '664' → (664, 664)"""
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


def curl_code(url, dest, extra=()):
    """Download with curl (resumes a partial file); its exit code comes back."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    return subprocess.call(
        ['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30',
         '-o', dest, *extra, url]
    )


def curl_to(url, dest, attempts=5):
    """Download with curl, and try again after network trouble.  22 = the server said 404."""
    for attempt in range(attempts):
        code = curl_code(url, dest)
        if code == 0:
            return True
        # 33: the server would not resume – start again
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[tn] curl meldet {code} für {os.path.basename(dest)}; noch einmal')
        time.sleep(10 * (attempt + 1))
    return False


def missing(url, attempts=4):
    """Does the server hold anything at this address?  (404: this 500 m was never flown.)"""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Range': 'bytes=0-99'})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as r:
                r.read(100)
            return False
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404, 410):
                return True
            if attempt == attempts - 1:
                raise
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise RuntimeError(f'{url}: {e}')
            say(f'[tn] {e}; noch einmal')
        time.sleep(5 * (attempt + 1))
    return False


def source_of(north):
    """Which province serves this kilometre square."""
    return 'bolzano' if north >= BORDER_N else 'trento'


def read_asc(path):
    """One ESRI ASCII grid: 1000 rows of 1000 cells of 0.5 m, the first row the northern one."""
    import numpy as np
    head = {}
    with open(path) as f:
        for _ in range(6):
            line = f.readline().split()
            if len(line) == 2:
                head[line[0]] = float(line[1])
        a = np.array(' '.join(f).split(), dtype=np.float32)
    rows = int(head.get('nrows', 0))
    cols = int(head.get('ncols', 0))
    if rows * cols != a.size:
        raise RuntimeError(f'{path}: header says {rows} x {cols}, found {a.size} cells')
    return a.reshape(rows, cols)


def trento_sheets(east, north, tmp):
    """The four sheets of 500 m of one kilometre square – None if one of them is missing."""
    sheets = []
    for dx in (0, 1):
        for dz in (0, 1):
            west = (east * 1000 + dx * 500) // 100
            south = (north * 1000 + dz * 500) // 100
            url = ASC % (west, south)
            dest = os.path.join(tmp, f'5h{west:04d}{south:05d}.asc')
            if not curl_to(url, dest) and missing(url):
                return None
            if not os.path.exists(dest) or os.path.getsize(dest) < 1000:
                say(f'[tn] {url} kam leer an')
                return None
            sheets.append(((dx, dz), dest))
    return sheets


def trento_grid(sheets):
    """Four sheets of 500 m → 2000 x 2000 cells of 0.5 m, rows from north to south."""
    import numpy as np
    cells = {key: read_asc(path) for key, path in sheets}
    north = np.concatenate([cells[(0, 1)], cells[(1, 1)]], axis=1)
    south = np.concatenate([cells[(0, 0)], cells[(1, 0)]], axis=1)
    return np.concatenate([north, south], axis=0)


def wcs_url(quality, east, north):
    """One kilometre square of Bolzano's terrain as a GeoTIFF of floating point numbers."""
    query = urllib.parse.urlencode([
        ('service', 'WCS'),
        ('version', '2.0.1'),
        ('request', 'GetCoverage'),
        ('coverageId', COVERAGE[quality]),
        ('format', 'image/tiff'),
        ('subset', f'E({east * 1000},{(east + 1) * 1000})'),
        ('subset', f'N({north * 1000},{(north + 1) * 1000})'),
    ])
    return f'{WCS}?{query}'


def bolzano_grid(east, north, qualities, tmp):
    """One kilometre square of Bolzano: the terrain of 0.5 m if there is one, else that of 2.5 m."""
    import numpy as np
    from PIL import Image
    for quality in qualities:
        url = wcs_url(quality, east, north)
        dest = os.path.join(tmp, f'bz-{east}_{north}-{quality}.tif')
        if not curl_to(url, dest) or not os.path.exists(dest):
            continue
        with open(dest, 'rb') as f:
            start = f.read(4)
        # a coverage that does not reach here comes back as an XML of exceptions
        if start[:2] not in (b'II', b'MM'):
            say(f'[tn] {quality} deckt {east}_{north} nicht ({start[:20]!r})')
            os.remove(dest)
            continue
        a = np.asarray(Image.open(dest), dtype=np.float32)
        if a.size == 0 or not np.isfinite(a).all():
            say(f'[tn] {quality} deckt {east}_{north} nicht')
            os.remove(dest)
            continue
        os.remove(dest)
        return a
    return None


def to_km(a):
    """Any grid of one kilometre square → the 1000 x 1000 cells tools/fetch-geodata.py expects.

    A whole number of source cells per cell of the map (2000 of 0.5 m per kilometre) is
    averaged; what does not fit (400 cells of 2.5 m) is read between its neighbours.
    Cells without a height (-9999) count as no data, as they do in tools/fetch-geodata.py.
    """
    import numpy as np
    a = np.asarray(a, dtype=np.float32)
    rows, cols = a.shape
    valid = a > -1000
    if rows % 1000 == 0 and cols % 1000 == 0 and rows >= 1000 and cols >= 1000:
        ky = rows // 1000
        kx = cols // 1000
        b = a.reshape(1000, ky, 1000, kx)
        ok = valid.reshape(1000, ky, 1000, kx)
        total = np.where(ok, b, 0).astype(np.float64).sum(axis=(1, 3))
        count = ok.sum(axis=(1, 3))
        return np.where(count > 0, total / np.maximum(count, 1), -9999).astype(np.float32)
    src = np.where(valid, a, np.nan).astype(np.float32)
    iy = np.linspace(0, rows - 1, 1000)
    ix = np.linspace(0, cols - 1, 1000)
    y0 = np.floor(iy).astype(int)
    x0 = np.floor(ix).astype(int)
    y1 = np.minimum(y0 + 1, rows - 1)
    x1 = np.minimum(x0 + 1, cols - 1)
    wy = (iy - y0)[:, None]
    wx = (ix - x0)[None, :]
    top = src[y0][:, x0] * (1 - wx) + src[y0][:, x1] * wx
    bottom = src[y1][:, x0] * (1 - wx) + src[y1][:, x1] * wx
    grid = top * (1 - wy) + bottom * wy
    return np.where(np.isfinite(grid), grid, -9999).astype(np.float32)


def to_tiff(a):
    """The 1000 x 1000 cells as the bytes of a GeoTIFF – what reduce_tile reads."""
    import numpy as np
    from PIL import Image
    buffer = io.BytesIO()
    Image.fromarray(np.asarray(a, dtype=np.float32), mode='F').save(buffer, format='TIFF')
    return buffer.getvalue()


def take_dgm(east, north, qualities, tmp):
    """One kilometre square → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it.

    None: no province serves this square (then the map stays out of it).
    """
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    try:
        if source_of(north) == 'bolzano':
            grid = bolzano_grid(east, north, qualities, tmp)
        else:
            sheets = trento_sheets(east, north, tmp)
            grid = None if sheets is None else trento_grid(sheets)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if grid is None:
        return None
    blob = GD.reduce_tile(to_tiff(to_km(grid)))
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def take_lod2(product_url, east, north, name, tmp):
    """One CityGML file → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
    if not curl_to(product_url, tmp):
        raise RuntimeError(f'could not download {product_url}')
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', f'.{name}-{east}_{north}', '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    with open(tmp, 'rb') as gml:
        while True:
            chunk = gml.read(1 << 20)
            if not chunk:
                break
            node.stdin.write(chunk)
    node.stdin.close()
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts failed for {name} {east}_{north}')
    os.remove(tmp)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {east}_{north}\n')
    return 1


def merge_lod2(name):
    """Put the squares of 2 km of every kilometre tile together into data/work/lod2/<name>.

    Every tile wrote into a staging directory of its own; neighbouring tiles share squares, and
    one square is one file of lines – so joining the files is all there is to it (a gzip file
    may hold several members one after the other).
    """
    final = os.path.join(GD.LOD2_OUT, name)
    staging = sorted(d for d in os.listdir(GD.LOD2_OUT) if d.startswith(f'.{name}-'))
    if not staging:
        return None
    units = 0
    for part in staging:
        src = os.path.join(GD.LOD2_OUT, part)
        for square in os.listdir(src):
            os.makedirs(final, exist_ok=True)
            with open(os.path.join(src, square), 'rb') as a, open(os.path.join(final, square), 'ab') as b:
                shutil.copyfileobj(a, b)
        shutil.rmtree(src)
    for square in sorted(os.listdir(final)):
        units += sum(1 for _ in gzip.open(os.path.join(final, square), 'rb'))
    say(f'[tn] Gebäude aus {len(staging)} Kacheln zusammengefügt: {len(os.listdir(final))} Quadrate von 2 km, '
        f'{units} Gebäude in data/work/lod2/{name}')
    return units


def lod2_source(path, e0, e1, n0, n1):
    """Lines '<E>_<N> <url>' → the building tiles of this rectangle."""
    jobs = []
    with open(path) as f:
        for line in f:
            words = line.split()
            if len(words) != 2 or words[0].startswith('#'):
                continue
            tile, url = words
            east, north = (int(v) for v in tile.split('_'))
            if e0 <= east <= e1 and n0 <= north <= n1:
                jobs.append(('lod2', east, north, url))
    return jobs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Ostkilometer, UTM32 (664 oder 657..671)')
    ap.add_argument('--north', type=span, required=True, help='Nordkilometer, UTM32 (5105 oder 5098..5112)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur das Gelände oder nur die Gebäude')
    ap.add_argument('--source', choices=['auto', 'trento', 'bolzano'], default='auto',
                    help='which province serves the tiles (auto: by their north, from 5120 km Bolzano)')
    ap.add_argument('--dem', choices=['auto', '05m', '25m'], default='auto',
                    help='Bolzano: the terrain of 0.5 m, or only that of 2.5 m')
    ap.add_argument('--lod2-name', default='Trentino', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--lod2-source', help='file of lines "<E>_<N> <url of a CityGML file>"')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are downloaded at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares no province serves into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT,
                os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    qualities = ['05m', '25m'] if args.dem == 'auto' else [args.dem]
    sources = sorted({source_of(n) for n in range(n0, n1 + 1)} if args.source == 'auto' else {args.source})
    say(f'[tn] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} Kacheln von 1 km, '
        f'Gelände von {", ".join(sources)} ({GD.DGM_STEP * 100:g} cm je Stufe)')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[tn] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[tn] {len(overlap)} Kacheln hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben weg')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    if args.only != 'lod2':
        work += [('dgm', e, n, None) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)
                 if f'{e}_{n}' not in skip]
    if args.only != 'dgm' and args.lod2_source:
        if not os.path.exists(args.lod2_source):
            ap.error(f'no such list of buildings: {args.lod2_source}')
        work += lod2_source(args.lod2_source, e0, e1, n0, n1)
    say(f'[tn] {sum(1 for w in work if w[0] == "dgm")} Kacheln Gelände, '
        f'{sum(1 for w in work if w[0] == "lod2")} Kacheln Gebäude zu holen')

    if args.limit:
        work = work[: args.limit]
        say(f'[tn] nur die ersten {len(work)} davon (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    gaps = []

    def one(item):
        product, east, north, url = item
        if product == 'dgm':
            made = take_dgm(east, north, qualities, os.path.join(GD.TMP, f'tn-{east}_{north}'))
        else:
            made = take_lod2(url, east, north, args.lod2_name, os.path.join(GD.TMP, f'tn-lod2-{east}_{north}'))
        return product, east, north, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, east, north, made = item
            if made is None:
                gaps.append(f'{east}_{north}')
            elif made:
                counts[product] += 1
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[tn] {done}/{len(work)}: {counts["dgm"]} Gelände, {counts["lod2"]} Gebäude '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    say(f'[tn] fertig: {counts["dgm"]} Kacheln Gelände ({again["dgm"]} waren da), '
        f'{counts["lod2"]} Kacheln Gebäude ({again["lod2"]} waren da) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[tn] für {len(gaps)} Kacheln von 1 km dient keine Provinz ein Geländemodell '
            f'(dort bleibt die Karte weg)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
