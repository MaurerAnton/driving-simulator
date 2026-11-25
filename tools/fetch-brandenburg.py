#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Brandenburg –
open geodata of the state survey LGB (Landesvermessung und Geobasisinformation
Brandenburg) that need no key, only a source note in the map – and reduce them to
what the map build reads.  It does for this state what tools/fetch-geodata.py does
for Hesse, and it is tools/fetch-berlin.py with the buildings of Brandenburg added:
the terrain, the UTM33 → UTM32 conversion and the joining of the squares come from
there.

    python3 -I tools/fetch-brandenburg.py --east 773..779 --north 5810..5816
    python3 -I tools/fetch-brandenburg.py --east 773..779 --north 5810..5816 --only dgm
    python3 -I tools/fetch-brandenburg.py --east 773..779 --north 5810..5816 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the grid the map tiles
are cut from: 776_5813 is the square the Alter Markt of Potsdam lies in.  Squares
outside the coverage (Poland, the other states) get no terrain – they are printed at
the end and the map stays out of them (tools/osm-extract.ts builds where terrain is).

Terrain:   the WCS coverage bb_dgm of the LGB ("Brandenburg mit Berlin", 1 m) at
           https://isk.geobasis-bb.de/ows/dgm_wcs, one GetCoverage of 1000 × 1000
           cells per kilometre square, asked for in UTM32 – the service reprojects,
           so the native UTM33 of the state never reaches the map:
           data/work/dgm2/<E>_<N>.dgm  (tools/fetch-berlin.py take_dgm)
Buildings: the LGB's LoD2 models, one CityGML file per square of 1 km in UTM33
           (EPSG:25833), from OpenGeodata.Brandenburg:
           https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod2_gml/lod2_33<E>-<N>.zip
           Which squares exist is read from that directory's index (19 300 files),
           never guessed.  Every coordinate triple of every gml:posList goes through
           the Krüger series of src/geo/utm.ts (UTM33 → UTM32) before
           tools/lod2-extract.ts reads it:
           data/work/lod2/<name>/<x>_<z>.ndjson.gz
           The LGB's files hold Brandenburg's buildings only; where the rectangle
           reaches into Berlin, Berlin's own squares (ATOM feed of Geoportal Berlin,
           as tools/fetch-berlin.py takes them) are added, so a square on the border
           gets the buildings of both sides.

What the licences say, taken from the services themselves:

  * the index page of OpenGeodata.Brandenburg (https://data.geobasis-bb.de/geobasis/daten/
    and …/3d_gebaeude/lod2_gml/): "Diese Daten stehen unter der Datenlizenz
    Deutschland Namensnennung 2.0 (https://www.govdata.de/dl-de/by-2-0),
    Bereitsteller: GeoBasis-DE / LGB."
  * the metadata of the LoD2 dataset (geoportal.brandenburg.de, fileid
    0414a37a-a749-4ee6-9f59-a41226919c58): "Datenlizenz Deutschland - Namensnennung -
    Version 2.0", "Quelle: © GeoBasis-DE/LGB, dl-de/by-2-0".
  * the GetCapabilities of the WCS: "Die Daten können gemäß der „Datenlizenz
    Deutschland - Namensnennung - Version 2.0“ … genutzt werden. Namensnennung:
    “GeoBasis-DE/LGB“" (with "© Geoportal Berlin, dl-de/by-2-0" added when data of
    Berlin are used), fees "kostenfrei, unter Beachtung der Lizenzbedingungen".
  * Berlin's LoD2 (only where the rectangle reaches into Berlin): dl-de/zero-2-0,
    see tools/fetch-berlin.py.

--published <map-assets/index.json> keeps this map from covering a tile another
map already has (as in tools/fetch-berlin.py).

Needs Python 3 with numpy and pillow, and node.  What is already there is skipped,
so the command can be repeated after an interruption.
"""
import argparse
import concurrent.futures
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def berlin():
    """tools/fetch-berlin.py as a module: the same WCS, the same UTM33 → UTM32, the same joining."""
    path = os.path.join(ROOT, 'tools', 'fetch-berlin.py')
    spec = importlib.util.spec_from_file_location('fetch_berlin', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BE = berlin()
GD = BE.GD

LOD2_DIR = 'https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod2_gml/'
LOD2_FILE = LOD2_DIR + 'lod2_33%d-%d.zip'
LOD2_MEMBER = re.compile(r'lod2_33(\d{3})-(\d{4})\.zip')
CACHE = os.path.join(ROOT, 'data/work/brandenburg')

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def available_tiles():
    """Every square of 1 km of buildings the LGB has: lower left corner in UTM33 kilometres."""
    cache = os.path.join(CACHE, 'tiles.json')
    os.makedirs(CACHE, exist_ok=True)
    if os.path.exists(cache):
        with open(cache) as f:
            return [tuple(t) for t in json.load(f)]
    page = BE.urlopen(LOD2_DIR).decode('utf8', 'replace')
    tiles = sorted({(int(found[1]), int(found[2])) for found in LOD2_MEMBER.finditer(page)})
    if not tiles:
        raise RuntimeError(f'no squares of buildings in the index ({len(page)} bytes)')
    with open(cache + '.tmp', 'w') as f:
        json.dump(tiles, f)
    os.replace(cache + '.tmp', cache)
    say(f'[bb] the LGB has {len(tiles)} squares of 1 km of buildings (index of lod2_gml)')
    return tiles


def take_lod2(url, key, name):
    """One CityGML file of a square of 1 km, UTM33 → UTM32, read by tools/lod2-extract.ts.

    key names the source and the square ('bb-368_5806', 'be-370_5810'): a square on the
    border is a file of the LGB and one of Berlin, and both must stay.  Each goes into a
    staging directory of its own (tools/lod2-extract.ts empties the directory it writes),
    BE.merge_lod2() joins them afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{key}')
    if os.path.exists(done):
        return 0
    blob = BE.urlopen(url)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        members = [m for m in z.namelist() if m.lower().endswith(('.gml', '.xml'))]
        if not members:
            raise RuntimeError(f'{key}: no CityGML in {len(blob)} bytes ({z.namelist()[:3]})')
        data = b''.join(z.read(m) for m in members[:1])
    data, triples = BE.move_poslists(data)
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', f'.{name}-{key}', '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    try:
        node.stdin.write(data)
        node.stdin.close()
    except BrokenPipeError:
        pass
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts failed for {key}')
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {key} {triples} triples moved from UTM33 to UTM32\n')
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=BE.span, required=True, help='east kilometres, UTM32 (776 or 773..779)')
    ap.add_argument('--north', type=BE.span, required=True, help='north kilometres, UTM32 (5813 or 5810..5816)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Brandenburg', help='directory under data/work/lod2')
    ap.add_argument('--no-berlin', action='store_true', help="leave out Berlin's own buildings")
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares that have no terrain into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE, BE.CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[bb] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[bb] {args.published}: {len(known)} tiles of other maps')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if BE.tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[bb] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    if args.only != 'lod2':
        work += [('dgm', None, e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)
                 if f'{e}_{n}' not in skip]
    if args.only != 'dgm':
        tiles = BE.wanted_tiles(available_tiles(), e0, e1, n0, n1)
        say(f'[bb] lod2: {len(tiles)} squares of 1 km of the LGB touch the rectangle')
        work += [('lod2', (LOD2_FILE % t, f'bb-{t[0]}_{t[1]}'), None, None) for t in tiles]
        if not args.no_berlin:
            tiles = BE.wanted_tiles(BE.available_tiles(), e0, e1, n0, n1)
            say(f'[bb] lod2: {len(tiles)} squares of 1 km of Berlin touch the rectangle')
            work += [('lod2', (BE.DOWNLOAD % t, f'be-{t[0]}_{t[1]}'), None, None) for t in tiles]

    if args.limit:
        work = work[: args.limit]
        say(f'[bb] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    gaps = []

    def one(item):
        if item[0] == 'dgm':
            return item[0], BE.take_dgm(item[2], item[3])
        return item[0], take_lod2(item[1][0], item[1][1], args.lod2_name)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(one, item) for item in work]
        for done_count, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            try:
                product, made = future.result()
            except Exception as e:  # noqa: BLE001 - one failing square does not spoil the others
                item = work[futures.index(future)]
                if item[0] == 'dgm':
                    gaps.append(f'{item[2]}_{item[3]}')
                    say(f'[bb] no terrain for {item[2]}_{item[3]}: {e}')
                else:
                    say(f'[bb] no buildings for {item[1][1]}: {e}')
                continue
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done_count % 25 == 0 or done_count == len(work):
                say(f'[bb] {done_count}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[bb] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there), '
        f'{counts["lod2"]} tiles of buildings ({again["lod2"]} were there) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        BE.merge_lod2(args.lod2_name)
    if gaps:
        say(f'[bb] no terrain for {len(gaps)} kilometre squares '
            '(the map stays out of them)'
            + (f': {", ".join(sorted(gaps)[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(sorted(gaps)) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
