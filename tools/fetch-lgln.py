#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Lower
Saxony – the open geodata of the state survey LGLN, licence CC BY 4.0 – and
reduce them to what the map build reads.  It does for this state what
tools/fetch-geodata.py does for Hesse; the difference is the shape of what is
served: LGLN keeps every kilometre tile of the state on its own, so a map of
any rectangle can be fetched without downloading whole districts.

    python3 -I tools/fetch-lgln.py --east 545..556 --north 5697..5712
    python3 -I tools/fetch-lgln.py --east 535..594 --north 5690..5741 --only dgm
    python3 -I tools/fetch-lgln.py --east 545..556 --north 5697..5712 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 545_5698 is the tile the town of Hann. Münden
lies in.  Which tiles exist, the index of the open geodata says; tiles the
state has none of (Hessian land inside the rectangle, mostly) are printed at
the end – the map is built where terrain is (tools/osm-extract.ts), so those
squares simply stay out of the map.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: both states then write the same bytes
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts

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
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

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
# the tile index of the open geodata (ArcGIS FeatureServer, no key needed):
#   one feature per kilometre tile, tile_id = <prefix><E km><N km> – 325455696 is
#   the terrain of 545_5696, 25455696 its buildings
FEATURES = 'https://services-eu1.arcgis.com/4v3xxN52w88W065F/arcgis/rest/services/%s/FeatureServer/0/query'
PREFIX = {'dgm': 320_000_000, 'lod2': 20_000_000}
SERVICE = {'dgm': 'lgln_opengeodata_dgm1', 'lod2': 'lgln_opengeodata_lod2'}
LINK = {'dgm': 'dgm1', 'lod2': 'xml'}
CACHE = os.path.join(ROOT, 'data/work/lgln')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'545..556' → (545, 556); '545' → (545, 545)"""
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


def ask(url, attempts=5):
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[lgln] {e}; trying again')
            time.sleep(5 * (attempt + 1))


def column(product, east, n0, n1):
    """Every kilometre tile of one column the index holds: north → its download link."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'{product}-{east}-{n0}-{n1}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return {int(n): link for n, link in json.load(f).items()}
    low = PREFIX[product] + east * 10_000 + n0
    high = PREFIX[product] + east * 10_000 + n1
    found = {}
    offset = 0
    while True:
        query = urllib.parse.urlencode({
            'f': 'json',
            'where': f'tile_id >= {low} and tile_id <= {high}',
            'outFields': f'tile_id,{LINK[product]}',
            'returnGeometry': 'false',
            'orderByFields': 'tile_id',
            'resultRecordCount': 2000,
            'resultOffset': offset,
        })
        answer = ask(f'{FEATURES % SERVICE[product]}?{query}')
        features = answer.get('features') or []
        for feature in features:
            a = feature['attributes']
            found[a['tile_id'] - PREFIX[product] - east * 10_000] = a[LINK[product]]
        if not features or not answer.get('exceededTransferLimit'):
            break
        offset += len(features)
    # (an empty answer is not kept: it would keep every following run from asking again)
    if found:
        with open(cache + '.tmp', 'w') as f:
            json.dump(found, f)
        os.replace(cache + '.tmp', cache)
    return found


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
        say(f'[lgln] curl ended with {code} for {os.path.basename(dest)}; trying again')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


def take_dgm(product_url, east, north, tmp):
    """One GeoTIFF → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(product_url, tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    blob = GD.reduce_tile(data)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def take_lod2(product_url, east, north, name, tmp):
    """One CityGML file → a staging directory of its own, read by tools/lod2-extract.ts (CityGML 1.0 AdV, as in Hesse).

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
    curl_to(product_url, tmp)
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
    say(f'[lgln] buildings joined from {len(staging)} tiles: {len(os.listdir(final))} squares of 2 km, '
        f'{units} units in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (545 or 545..556)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5698 or 5697..5712)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Niedersachsen', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are downloaded at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no data for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[lgln] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[lgln] {args.published}: {len(known)} tiles of other maps')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[lgln] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    report = {}
    for product in (['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']):
        jobs = []
        for e in range(e0, e1 + 1):
            jobs.append((e, concurrent.futures.Future()))
        # one question per kilometre column is quicker than one per tile
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            columns = {e: pool.submit(column, product, e, n0, n1) for e, _ in jobs}
            for e, _ in jobs:
                column_links = columns[e].result()
                for n in range(n0, n1 + 1):
                    if f'{e}_{n}' in skip:
                        continue
                    if n in column_links:
                        work.append((product, e, n, column_links[n]))
                    elif product == 'dgm':
                        report.setdefault('gap', []).append(f'{e}_{n}')
        say(f'[lgln] {product}: {sum(1 for w in work if w[0] == product)} tiles to fetch')

    if args.limit:
        work = work[: args.limit]
        say(f'[lgln] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}

    def one(item):
        product, e, n, url = item
        tmp = os.path.join(GD.TMP, f'lgln-{product}-{e}_{n}')
        if product == 'dgm':
            made = take_dgm(url, e, n, tmp + '.tif')
        else:
            made = take_lod2(url, e, n, args.lod2_name, tmp + '.gml')
        return product, e, n, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, e, n, made = item
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[lgln] {done}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[lgln] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there), '
        f'{counts["lod2"]} tiles of buildings ({again["lod2"]} were there) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if 'gap' in report:
        gaps = report['gap']
        say(f'[lgln] no terrain of Lower Saxony for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
