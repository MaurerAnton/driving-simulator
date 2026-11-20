#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2) of
Baden-Württemberg – the open geodata of the state survey LGL, licence
"Datenlizenz Deutschland Namensnennung 2.0" – and reduce them to what the
map build reads.  It does for this state what tools/fetch-geodata.py does
for Hesse; the difference is the shape of what is served: LGL keeps its data
in archives of 2 × 2 kilometres on the open-geodata portal
opengeodata.lgl-bw.de (no key, no registration), so a map of any rectangle
can be fetched without downloading whole districts.

    python3 -I tools/fetch-bw.py --east 513..514 --north 5402..5403
    python3 -I tools/fetch-bw.py --east 505..520 --north 5396..5409 --only dgm
    python3 -I tools/fetch-bw.py --east 505..520 --north 5396..5409 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 513_5402 is the tile the centre of Stuttgart
lies in.  Which archives exist, the script asks the portal (a HEAD request);
the state has no data for squares outside its border – they are printed at
the end, and since the map is built where terrain is (tools/osm-extract.ts),
those squares simply stay out of the map.  Inside the state a 2 km archive
holds four kilometre tiles, so its name is the kilometre tile with an odd
easting and an even northing:

    easting 513 and 514 -> archive 513,  north 5402 and 5403 -> archive 5402

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – one kilometre tile out of the
           .xyz point rows of the archive, reduced by tools/fetch-geodata.py,
           which is read here for it: both states then write the same bytes
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts.

tools/lod2-extract.ts empties the directory it writes before it writes
--name <dir>; here every kilometre tile therefore goes into the staging
directory data/work/lod2/.<name>-<E>_<N> first – the map build leaves out
directories whose name begins with a dot (tools/mapgen/buildings.ts) – and
all of them are put together into data/work/lod2/<name> in the end, because
buildings of neighbouring tiles belong into the same square of 2 km.

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py), curl
and node.  What is already there is skipped, so the command can be repeated
after an interruption.
"""
import argparse
import concurrent.futures
import gzip
import shutil
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

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
# the open geodata of LGL Baden-Württemberg – licence dl-de/by-2-0, no key needed:
#   https://opengeodata.lgl-bw.de/data/dgm/dgm1_32_<E>_<N>_2_bw.zip   (terrain, 1 m grid, ~14 MB)
#   https://opengeodata.lgl-bw.de/data/lod2/LoD2_32_<E>_<N>_2_bw.zip  (buildings, ~18 MB)
BASE = 'https://opengeodata.lgl-bw.de/data'
ZIP = {'dgm': BASE + '/dgm/dgm1_32_%d_%d_2_bw.zip', 'lod2': BASE + '/lod2/LoD2_32_%d_%d_2_bw.zip'}
# one member per kilometre tile inside such an archive
XYZ = re.compile(r'dgm1_32_(\d+)_(\d+)_1_bw(?:_\d+)?\.xyz$', re.IGNORECASE)
GML = re.compile(r'lod2_32_(\d+)_(\d+)_1_bw\.gml$', re.IGNORECASE)

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


def archive_of(east, north):
    """The 2 km archive a kilometre tile lies in: odd easting, even northing (measured over the whole state)."""
    return (east if east % 2 else east - 1), (north if north % 2 == 0 else north - 1)


def there(url, attempts=5):
    """Whether the portal holds this archive: yes / no (a square without data answers 404)."""
    request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=120) as r:
                return 200 <= r.status < 300
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            if attempt == attempts - 1:
                raise
            say(f'[bw] {e.code} for {os.path.basename(url)}; trying again')
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[bw] {e}; trying again')
        time.sleep(5 * (attempt + 1))
    return False


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
        say(f'[bw] curl ended with {code} for {os.path.basename(dest)}; trying again')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


def xyz_to_tiff(data, east, north):
    """The point rows of one kilometre tile → a 1000 × 1000 GeoTIFF of heights in metres.

    Every row begins at the north-west corner, the easting grows along it, the
    northing falls from row to row – tools/mapgen/dgm.ts says the same the other
    way round (row 0 of a tile is its northern edge).  Checked against the
    European DEM (25 m) on 20 points of tile 513_5402: this way round differs by
    6.4 m from it, every mirror of it by 10 m and more.
    """
    import numpy as np
    from PIL import Image

    try:
        flat = np.fromstring(data, sep=' ')  # three numbers a point: easting, northing, height
    except AttributeError:  # numpy without fromstring: split it ourselves
        flat = np.array(data.split(), dtype=np.float64)
    points = flat.reshape(-1, 3)
    grid = np.zeros((1000, 1000), np.float32)
    rows = np.rint((north + 1) * 1000 - 0.5 - points[:, 1]).astype(np.intp)
    cols = np.rint(points[:, 0] - (east * 1000 + 0.5)).astype(np.intp)
    inside = (rows >= 0) & (rows < 1000) & (cols >= 0) & (cols < 1000)
    grid[rows[inside], cols[inside]] = points[inside, 2]
    if inside.sum() != 1000 * 1000:
        # outside Baden-Württemberg a tile of the border is only partly filled
        say(f'[bw] Gelände {east}_{north}: nur {inside.sum()} von 1000000 Zellen von 1 m haben eine Höhe')
    out = io.BytesIO()
    Image.fromarray(grid, mode='F').save(out, format='TIFF')
    return out.getvalue()


def take_dgm(archive, tiles):
    """One archive → data/work/dgm2/<E>_<N>.dgm per kilometre tile, reduced as tools/fetch-geodata.py reduces it."""
    done = []
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            m = XYZ.search(info.filename)
            if not m:
                continue
            east, north = int(m[1]), int(m[2])
            if (east, north) not in tiles:
                continue
            out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
            if os.path.exists(out):
                continue
            blob = GD.reduce_tile(xyz_to_tiff(z.read(info), east, north))
            with open(out + '.tmp', 'wb') as f:
                f.write(blob)
            os.replace(out + '.tmp', out)
            done.append((east, north, len(blob)))
    return done


def take_lod2(archive, tiles, name):
    """One archive → data/work/lod2/.<name>-<E>_<N> per kilometre tile, read by tools/lod2-extract.ts (CityGML, as in Hesse)."""
    done = []
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            m = GML.search(info.filename)
            if not m:
                continue
            east, north = int(m[1]), int(m[2])
            if (east, north) not in tiles:
                continue
            marker = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
            if os.path.exists(marker):
                continue
            # the dot keeps the map build from reading the staging directory as well
            tile = f'.{name}-{east}_{north}'
            node = subprocess.Popen(
                ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', tile, '-'],
                stdin=subprocess.PIPE,
                cwd=ROOT,
            )
            with z.open(info) as gml:
                while True:
                    chunk = gml.read(1 << 20)
                    if not chunk:
                        break
                    node.stdin.write(chunk)
            node.stdin.close()
            if node.wait() != 0:
                raise RuntimeError(f'tools/lod2-extract.ts failed for {tile}')
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            with open(marker, 'w') as f:
                f.write(f'{tile}\n')
            done.append((east, north, 0))
    return done


def merge_lod2(name, tiles):
    """Put the squares of 2 km of every kilometre tile together into data/work/lod2/<name>.

    One tile after the other wrote into its own directory; neighbouring tiles share squares, and
    each square is one file of lines – so joining the files (a gzip file may hold several
    members, one after the other) is all there is to it.
    """
    squares = {}
    for east, north in sorted(tiles):
        tile = os.path.join(GD.LOD2_OUT, f'.{name}-{east}_{north}')
        if not os.path.isdir(tile):
            continue
        for file in os.listdir(tile):
            if file.endswith('.ndjson.gz'):
                squares.setdefault(file, []).append(os.path.join(tile, file))
    out = os.path.join(GD.LOD2_OUT, name)
    fresh = out + '.tmp'
    shutil.rmtree(fresh, ignore_errors=True)
    os.makedirs(fresh, exist_ok=True)
    units = 0
    for file, parts in sorted(squares.items()):
        with open(os.path.join(fresh, file), 'wb') as w:
            for part in parts:
                with open(part, 'rb') as r:
                    data = r.read()
                w.write(data)
                units += gzip.decompress(data).count(b'\n')
    shutil.rmtree(out, ignore_errors=True)
    os.replace(fresh, out)
    return len(squares), units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (513 or 505..520)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5402 or 5396..5409)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Baden-Wuerttemberg', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many archives are downloaded at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many archives (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no data for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[bw] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} Kacheln von 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[bw] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerraster hat eine andere Karte schon, z. B. {overlap[:5]}')
        say(f'[bw] {len(overlap)} Kilometerraster hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben weg')
            + (f', z. B. {overlap[:5]}'))
    skip = {tuple(int(v) for v in key.split('_')) for key in overlap} if args.on_overlap == 'skip' else set()

    products = ['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']
    # the archives of this rectangle: which kilometre tiles of it each one holds
    groups = {}
    for e in range(e0, e1 + 1):
        for n in range(n0, n1 + 1):
            groups.setdefault(archive_of(e, n), set()).add((e, n))

    def missing(product, tiles):
        """Those of the tiles whose terrain or buildings are not there yet."""
        if product == 'dgm':
            return {t for t in tiles if not os.path.exists(os.path.join(GD.DGM_OUT, f'{t[0]}_{t[1]}.dgm'))}
        return {t for t in tiles
                if not os.path.exists(os.path.join(GD.LOD2_OUT, '.done', f'{args.lod2_name}-{t[0]}_{t[1]}'))}

    work = []
    again = {'dgm': 0, 'lod2': 0}
    for key in sorted(groups):
        tiles = {t for t in groups[key] if t not in skip}
        if not tiles:
            continue
        for product in products:
            wanted = missing(product, tiles)
            again[product] += len(tiles) - len(wanted)  # what an earlier run already fetched
            if wanted:
                work.append((product, key, wanted))
    if args.limit:
        work = work[: args.limit]
        say(f'[bw] nur die ersten {len(work)} davon (--limit)')
    say(f'[bw] {sum(1 for w in work if w[0] == "dgm")} Archive Gelände, '
        f'{sum(1 for w in work if w[0] == "lod2")} Archive Gebäude zu holen')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    gaps = {'dgm': set(), 'lod2': set()}

    def one(item):
        product, key, tiles = item
        url = ZIP[product] % key
        if not there(url):
            return product, key, None
        tmp = os.path.join(GD.TMP, f'bw-{product}-{key[0]}_{key[1]}.zip')
        curl_to(url, tmp)
        try:
            if product == 'dgm':
                made = take_dgm(tmp, tiles)
            else:
                made = take_lod2(tmp, tiles, args.lod2_name)
        finally:
            os.remove(tmp)
        return product, key, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, key, made = item
            if made is None:
                german = 'Gelände' if product == 'dgm' else 'Gebäude'
                say(f'[bw] kein {german}archiv {key[0]}_{key[1]} '
                    f'({len(groups[key])} Kacheln von 1 km bleiben draußen)')
                gaps[product].update(f'{e}_{n}' for e, n in groups[key])
                continue
            counts[product] += len(made)
            for east, north, size in made:
                if size:
                    say(f'[bw] Gelände {east}_{north}: {size // 1024} kB')
            if done % 10 == 0 or done == len(work):
                say(f'[bw] {done}/{len(work)}: {counts["dgm"]} Gelände, {counts["lod2"]} Gebäude '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    say(f'[bw] fertig: {counts["dgm"]} Kacheln Gelände ({again["dgm"]} waren schon da), '
        f'{counts["lod2"]} Kacheln Gebäude ({again["lod2"]} waren schon da) '
        f'in {(time.time() - started) / 60:.0f} min')
    if 'lod2' in products:
        tiles = {t for key in groups for t in groups[key] if t not in skip
                 and os.path.exists(os.path.join(GD.LOD2_OUT, '.done', f'{args.lod2_name}-{t[0]}_{t[1]}'))}
        squares, units = merge_lod2(args.lod2_name, tiles)
        say(f'[bw] Gebäude zusammengelegt: {units} Einheiten in {squares} Quadraten von 2 km')
    written = []
    for product in ('dgm', 'lod2'):
        found = sorted(gaps[product])
        if found:
            german = 'Gelände' if product == 'dgm' else 'Gebäude'
            say(f'[bw] kein {german} für {len(found)} Kilometerraster (die Karte bleibt dort draußen)'
                + (f': {", ".join(found[:8])}' if len(found) <= 8 else ''))
            written += found
    if args.gaps and written:
        with open(args.gaps, 'w') as f:
            f.write('\n'.join(sorted(written)) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
