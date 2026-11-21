#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Berlin –
both open geodata that need no key, only a source note in the map – and reduce
them to what the map build reads.  It does for the capital what
tools/fetch-geodata.py does for Hesse.

    python3 -I tools/fetch-berlin.py --east 791..805 --north 5821..5835
    python3 -I tools/fetch-berlin.py --east 791..805 --north 5821..5835 --only dgm
    python3 -I tools/fetch-berlin.py --east 791..805 --north 5821..5835 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the grid the map tiles
are cut from: 799_5828 is the square Berlin Mitte lies in.  Squares outside the
coverage get no terrain – they are printed at the end and the map stays out of
them (tools/osm-extract.ts builds where terrain is).

Terrain:   Brandenburg's survey (LGB, Landesvermessung und Geobasisinformation
           Brandenburg) serves the DGM1 of "Brandenburg mit Berlin" as a WCS
           coverage bb_dgm at https://isk.geobasis-bb.de/ows/dgm_wcs; one
           GetCoverage of 1000 × 1000 cells per kilometre square, asked for in
           UTM32, the grid of the map – so no reprojection:
           data/work/dgm2/<E>_<N>.dgm
Buildings: Berlin itself publishes its LoD2 models – one CityGML file per square
           of 1 km, and that in UTM33 (EPSG:25833), not in the UTM32 of the map:
           every coordinate triple of every gml:posList goes through the Krüger
           series of src/geo/utm.ts before tools/lod2-extract.ts reads it:
           data/work/lod2/<name>/<x>_<z>.ndjson.gz
           Which squares exist is read from the ATOM feed of Geoportal Berlin
           (https://gdi.berlin.de/data/a_lod2/atom/0.atom), never guessed.

What the licences say, taken from the services themselves:

  * the GetCapabilities of the Brandenburg WCS
    (https://isk.geobasis-bb.de/ows/dgm_wcs?SERVICE=WCS&REQUEST=GetCapabilities):
    "Die Daten können gemäß der „Datenlizenz Deutschland - Namensnennung -
    Version 2.0“ (https://www.govdata.de/dl-de/by-2-0) genutzt werden.
    Namensnennung: “GeoBasis-DE/LGB“, Beispiel: „© GeoBasis-DE/LGB,
    dl-de/by-2-0, (Daten geändert)“, (Klammer = optional) Hinweis: werden auch
    Daten des Bundeslandes Berlin genutzt, ist der Copyright-Vermerk um den
    Hinweis “© Geoportal Berlin, dl-de/by-2-0“ zu ergänzen." and
    "<ows:Fees>kostenfrei, unter Beachtung der Lizenzbedingungen</ows:Fees>".

  * the <rights> of the ATOM feed of Berlin's LoD2 dataset (0.atom):
    "Für die Nutzung der Daten ist die Datenlizenz Deutschland - Zero -
    Version 2.0 anzuwenden. Die Lizenz ist über
    https://www.govdata.de/dl-de/zero-2-0 abrufbar."
    (the feed is served by Senatsverwaltung für Stadtentwicklung, Bauen und
    Wohnen Berlin)

Both are open licences of the "Datenlizenz Deutschland" family – dl-de/by-2-0
and dl-de/zero-2-0 – so nothing here needs a key or a registration, and the map
names the sources (see .github/workflows/build-map-berlin.yml).

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the script
stops and names them).

Needs Python 3 (numpy comes in through tools/fetch-geodata.py) and node.  What is
already there is skipped, so the command can be repeated after an interruption.
"""
import argparse
import concurrent.futures
import gzip
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
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
import numpy as np  # noqa: E402 - after fetch-geodata.py, which needs it too

AGENT = GD.AGENT
# the terrain as a coverage of 1 m: one GetCoverage per kilometre square, asked for in UTM32.
# Version 1.0.0: the service answers 2.0.1 requests with a coverage subsetting it does not have.
WCS = 'https://isk.geobasis-bb.de/ows/dgm_wcs'
COVERAGE = 'bb_dgm'
# the buildings: the ATOM feed of Geoportal Berlin names every square of 1 km of the city
ATOM = 'https://gdi.berlin.de/data/a_lod2/atom/0.atom'
DOWNLOAD = 'https://gdi.berlin.de/data/a_lod2/atom/LoD2_%d_%d.zip'
ATOM_MEMBER = re.compile(r'LoD2_(\d+)_(\d+)\.zip')
CACHE = os.path.join(ROOT, 'data/work/berlin')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

# UTM32 and UTM33: Krüger's series, the same one src/geo/utm.ts uses (GRS80 ellipsoid)
ZONE_32 = 9.0
ZONE_33 = 15.0
K0 = 0.9996
FALSE_E = 500000.0
A_GRS80 = 6378137.0
_F = 1 / 298.257222101
_N1 = _F / (2 - _F)
_N2 = _N1 * _N1
_N3 = _N2 * _N1
_N4 = _N2 * _N2
_A_RECT = (A_GRS80 / (1 + _N1)) * (1 + _N2 / 4 + _N4 / 64)
_ALPHA = np.array([_N1 / 2 - 2 * _N2 / 3 + 5 * _N3 / 16, 13 * _N2 / 48 - 3 * _N3 / 5, 61 * _N3 / 240])
_BETA = np.array([_N1 / 2 - 2 * _N2 / 3 + 37 * _N3 / 96, _N2 / 48 + _N3 / 15, 17 * _N3 / 480])
_DELTA = np.array([2 * _N1 - 2 * _N2 / 3 - 2 * _N3, 7 * _N2 / 3 - 8 * _N3 / 5, 56 * _N3 / 15])
_E_CONF = 2 * np.sqrt(_N1) / (1 + _N1)

POSLIST = re.compile(rb'(<gml:posList[^>]*>)(.*?)(</gml:posList>)', re.S)

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'791..805' → (791, 805); '799' → (799, 799)"""
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


def to_lat_lon(east, north, zone):
    xi = np.asarray(north, float) / (K0 * _A_RECT)
    eta = (np.asarray(east, float) - FALSE_E) / (K0 * _A_RECT)
    xi_p = xi.copy()
    eta_p = eta.copy()
    for j in range(3):
        k = 2 * (j + 1)
        xi_p = xi_p - _BETA[j] * np.sin(k * xi) * np.cosh(k * eta)
        eta_p = eta_p - _BETA[j] * np.cos(k * xi) * np.sinh(k * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    phi = chi.copy()
    for j in range(3):
        phi = phi + _DELTA[j] * np.sin(2 * (j + 1) * chi)
    lam = np.radians(zone) + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return np.degrees(phi), np.degrees(lam)


def to_utm(lat, lon, zone):
    phi = np.radians(lat)
    dlam = np.radians(lon) - np.radians(zone)
    sin_phi = np.sin(phi)
    t = np.sinh(np.arctanh(sin_phi) - _E_CONF * np.arctanh(_E_CONF * sin_phi))
    xi_p = np.arctan2(t, np.cos(dlam))
    eta_p = np.arctanh(np.sin(dlam) / np.sqrt(1 + t * t))
    xi = xi_p.copy()
    eta = eta_p.copy()
    for j in range(3):
        k = 2 * (j + 1)
        xi = xi + _ALPHA[j] * np.sin(k * xi_p) * np.cosh(k * eta_p)
        eta = eta + _ALPHA[j] * np.cos(k * xi_p) * np.sinh(k * eta_p)
    return FALSE_E + K0 * _A_RECT * eta, K0 * _A_RECT * xi


def zone33_to_zone32(east, north):
    """UTM33 → the UTM32 of the map: over the geographic coordinates, as src/geo/utm.ts does it."""
    lat, lon = to_lat_lon(east, north, ZONE_33)
    return to_utm(lat, lon, ZONE_32)


def move_poslists(data):
    """The CityGML of Berlin with every coordinate triple moved from UTM33 to UTM32."""
    out = bytearray()
    at = 0
    triples = 0
    for found in POSLIST.finditer(data):
        out += data[at:found.start()]
        nums = np.array(found[2].split(), dtype=float)
        taken = nums[: len(nums) - len(nums) % 3].reshape(-1, 3)
        if not len(taken):
            out += found[0]
            at = found.end()
            continue
        taken[:, 0], taken[:, 1] = zone33_to_zone32(taken[:, 0], taken[:, 1])
        out += found[1] + ' '.join(f'{v:.3f}' for v in taken.reshape(-1)).encode() + found[3]
        triples += len(taken)
        at = found.end()
    out += data[at:]
    return bytes(out), triples


def urlopen(url, attempts=5):
    """The bytes of one answer, tried again when the network or the service fails."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    last = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            last = e
            if 400 <= getattr(e, 'code', 0) < 500:
                raise
            say(f'[be] {e}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def take_dgm(east, north):
    """One kilometre square of terrain → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    query = urllib.parse.urlencode({
        'SERVICE': 'WCS',
        'VERSION': '1.0.0',
        'REQUEST': 'GetCoverage',
        'COVERAGE': COVERAGE,
        'CRS': 'EPSG:25832',
        'BBOX': f'{east * 1000},{north * 1000},{(east + 1) * 1000},{(north + 1) * 1000}',
        'WIDTH': 1000,
        'HEIGHT': 1000,
        'FORMAT': 'GTiff',
    })
    data = urlopen(f'{WCS}?{query}')
    at = min((at for at in (data.find(m) for m in (b'II*\x00', b'MM\x00*')) if at >= 0), default=-1)
    if at < 0:
        raise RuntimeError(f'{east}_{north}: no GeoTIFF in {len(data)} bytes ({data[:200]!r})')
    blob = GD.reduce_tile(data[at:])
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def available_tiles():
    """Every square of 1 km of buildings Geoportal Berlin has: lower left corner in UTM33 kilometres."""
    cache = os.path.join(CACHE, 'tiles.json')
    os.makedirs(CACHE, exist_ok=True)
    if os.path.exists(cache):
        with open(cache) as f:
            return [tuple(t) for t in json.load(f)]
    feed = urlopen(ATOM).decode('utf8', 'replace')
    tiles = sorted({(int(found[1]), int(found[2])) for found in ATOM_MEMBER.finditer(feed)})
    if not tiles:
        raise RuntimeError(f'no squares of buildings in the feed ({len(feed)} bytes)')
    with open(cache + '.tmp', 'w') as f:
        json.dump(tiles, f)
    os.replace(cache + '.tmp', cache)
    say(f'[be] Geoportal Berlin has {len(tiles)} squares of 1 km of buildings (ATOM feed)')
    return tiles


def wanted_tiles(tiles, e0, e1, n0, n1):
    """Those of them whose square touches the rectangle asked for – compared in UTM32.

    A square of UTM33 is a rectangle there and a slightly turned quadrilateral here, so the
    corner that is farthest east (or north) may be inside the square, not at its end; the
    four corners give the frame, which is enough to tell who is in and who is out.
    """
    east = np.array([tile[0] for tile in tiles], float) * 1000.0
    north = np.array([tile[1] for tile in tiles], float) * 1000.0
    low_e = np.full(len(tiles), np.inf)
    high_e = np.full(len(tiles), -np.inf)
    low_n = np.full(len(tiles), np.inf)
    high_n = np.full(len(tiles), -np.inf)
    for de in (0.0, 1000.0):
        for dn in (0.0, 1000.0):
            c_e, c_n = zone33_to_zone32(east + de, north + dn)
            low_e = np.minimum(low_e, c_e)
            high_e = np.maximum(high_e, c_e)
            low_n = np.minimum(low_n, c_n)
            high_n = np.maximum(high_n, c_n)
    inside = (high_e >= e0 * 1000) & (low_e <= (e1 + 1) * 1000) & \
             (high_n >= n0 * 1000) & (low_n <= (n1 + 1) * 1000)
    return [tiles[i] for i in np.nonzero(inside)[0]]


def take_lod2(tile, name):
    """One CityGML file of a square of 1 km, UTM33 → UTM32, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    key = f'{tile[0]}_{tile[1]}'
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{key}')
    if os.path.exists(done):
        return 0
    blob = urlopen(DOWNLOAD % tile)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        members = [m for m in z.namelist() if m.lower().endswith(('.gml', '.xml'))]
        if not members:
            raise RuntimeError(f'{key}: no CityGML in {len(blob)} bytes ({z.namelist()[:3]})')
        data = z.read(members[0])
    data, triples = move_poslists(data)
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


def merge_lod2(name):
    """Put the squares of every tile together into data/work/lod2/<name>.

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
    say(f'[be] buildings joined from {len(staging)} tiles: {len(os.listdir(final))} squares of 2 km, '
        f'{units} units in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (799 or 791..805)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5828 or 5821..5835)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Berlin', help='directory under data/work/lod2')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares that have no terrain into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[be] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[be] {args.published}: {len(known)} tiles of other maps')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[be] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    if args.only != 'lod2':
        work += [('dgm', None, e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)
                 if f'{e}_{n}' not in skip]
    if args.only != 'dgm':
        tiles = wanted_tiles(available_tiles(), e0, e1, n0, n1)
        say(f'[be] lod2: {len(tiles)} squares of 1 km of Berlin touch the rectangle')
        work += [('lod2', tile, None, None) for tile in tiles]

    if args.limit:
        work = work[: args.limit]
        say(f'[be] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    gaps = []

    def one(item):
        if item[0] == 'dgm':
            return item[0], take_dgm(item[2], item[3])
        return item[0], take_lod2(item[1], args.lod2_name)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(one, item) for item in work]
        for done_count, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            try:
                product, made = future.result()
            except Exception as e:  # noqa: BLE001 - one failing square does not spoil the others
                item = work[futures.index(future)]
                if item[0] == 'dgm':
                    gaps.append(f'{item[2]}_{item[3]}')
                    say(f'[be] no terrain for {item[2]}_{item[3]}: {e}')
                else:
                    say(f'[be] no buildings for {item[1][0]}_{item[1][1]}: {e}')
                continue
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done_count % 25 == 0 or done_count == len(work):
                say(f'[be] {done_count}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[be] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there), '
        f'{counts["lod2"]} tiles of buildings ({again["lod2"]} were there) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[be] no terrain for {len(gaps)} kilometre squares '
            '(the map stays out of them)'
            + (f': {", ".join(sorted(gaps)[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(sorted(gaps)) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
