#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2) of
Rhineland-Palatinate – the open geodata of the state survey LVermGeo
(geobasis-rlp.de), licence dl-de/by-2-0 – and reduce them to what the map
build reads.  It does for this state what tools/fetch-geodata.py does for
Hesse; the difference is the shape of what is served: the LVermGeo keeps
every tile on its own as a file of a fixed name, so a map of any rectangle
can be fetched without downloading whole districts.

    python3 -I tools/fetch-rlp.py --east 400..401 --north 5579..5580
    python3 -I tools/fetch-rlp.py --east 398..403 --north 5576..5581 --only dgm
    python3 -I tools/fetch-rlp.py --east 398..403 --north 5576..5581 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 400_5579 is the square Koblenz lies in.
Which tiles exist, the index of the download server says; tiles the state has
none of (Hessian, Saarland or Belgian land inside the rectangle) are printed
at the end – the map is built where terrain is (tools/osm-extract.ts), so
those squares simply stay out of the map.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: both states then write the same bytes.
           Source: https://geobasis-rlp.de/data/dgm1/current/tif/
           dgm1_32_<E 3><N 4>_1_rp_<year>.tif – the year is part of the name
           (every tile is renewed in its own year), so the directory index is
           read first.
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts.
           Source: https://geobasis-rlp.de/data/geb3dlo/current/gml/
           LoD2_32_<E 3><N 4>_2_RP.gml – one tile of 2 km x 2 km, the anchor
           is even east and north.

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
import urllib.error
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
# the download server of the open geodata (no key, no registration):
# one file per tile, and an index of the directory that names every one of them
DGM_INDEX = 'https://geobasis-rlp.de/data/dgm1/current/tif/'
DGM_FILE = DGM_INDEX + 'dgm1_32_%03d_%04d_1_rp_%d.tif'
LOD2_FILE = 'https://geobasis-rlp.de/data/geb3dlo/current/gml/LoD2_32_%03d_%04d_2_RP.gml'
CACHE = os.path.join(ROOT, 'data/work/rlp')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'400..403' → (400, 403); '400' → (400, 400)"""
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


def ask(url, attempts=5, binary=False):
    """One GET with retries; None if the server has no such file (404)."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == attempts - 1:
                raise
            say(f'[rlp] {e} for {os.path.basename(url)}; trying again')
            time.sleep(5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[rlp] {e}; trying again')
            time.sleep(5 * (attempt + 1))
    return None


def head(url, attempts=4):
    """Length of the file in bytes; None if there is no such file, 0 if it stayed unknown."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT}, method='HEAD')
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=120) as r:
                return int(r.headers.get('Content-Length') or 0)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == attempts - 1:
                say(f'[rlp] {e} ({url.rsplit("/", 1)[-1]}); it is tried anyway')
                return 0
            time.sleep(5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            if attempt == attempts - 1:
                say(f'[rlp] {e} ({url.rsplit("/", 1)[-1]}); it is tried anyway')
                return 0
            say(f'[rlp] {e} ({url.rsplit("/", 1)[-1]}); trying again')
            time.sleep(5 * (attempt + 1))
    return 0


def dgm_index():
    """Every tile of terrain the server has: '400_5579' → its year (from the directory index)."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, 'dgm1-tiles.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)
    import re

    say('[rlp] reading the index of the terrain tiles (one file per kilometre square)')
    page = ask(DGM_INDEX)
    if not page:
        raise RuntimeError(f'no index of the terrain tiles at {DGM_INDEX}')
    found = {}
    for east, north, year in re.findall(rb'dgm1_32_(\d{3})_(\d{4})_1_rp_(\d{4})\.tif', page):
        found[f'{int(east)}_{int(north)}'] = int(year)
    if not found:
        raise RuntimeError(f'no tiles named in the index at {DGM_INDEX}')
    with open(cache + '.tmp', 'w') as f:
        json.dump(found, f)
    os.replace(cache + '.tmp', cache)
    say(f'[rlp] {len(found)} tiles of terrain are there')
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
        say(f'[rlp] curl ended with {code} for {os.path.basename(dest)}; trying again')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


def take_dgm(year, east, north, tmp):
    """One GeoTIFF → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(DGM_FILE % (east, north, year), tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    blob = GD.reduce_tile(data)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def take_lod2(east, north, name, tmp):
    """Eine CityGML-Kachel von 2 km → ein Zwischenverzeichnis für sich, von tools/lod2-extract.ts gelesen.

    Der Name trägt die Kachel, weil tools/lod2-extract.ts sein Ausgabeverzeichnis vor dem
    Schreiben leert (rmSync in Zeile 176): riefe man es je Kachel mit demselben Namen, bliebe
    nur die letzte Kachel übrig.  Der Punkt davor verhindert, dass der Kartenbau das
    Zwischenverzeichnis mitliest; merge_lod2() fügt die Kacheln danach zusammen.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
    url = LOD2_FILE % (east, north)
    length = head(url)
    if length is None:
        return -1
    say(f'[rlp] buildings {east}_{north}: {length / 1e6:.0f} MB')
    curl_to(url, tmp)
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
    """Die Quadrate von 2 km aller Kacheln in data/work/lod2/<name> zusammenführen.

    Jede Kachel hat in ihr eigenes Zwischenverzeichnis geschrieben; benachbarte Kacheln teilen
    sich Quadrate, und ein Quadrat ist eine Datei voller Zeilen – mehr als das Aneinanderhängen
    der Dateien braucht es nicht (eine gzip-Datei darf mehrere Member hintereinander haben).
    """
    final = os.path.join(GD.LOD2_OUT, name)
    staging = sorted(d for d in os.listdir(GD.LOD2_OUT) if d.startswith(f'.{name}-'))
    if not staging:
        return
    os.makedirs(final, exist_ok=True)
    for part in staging:
        src = os.path.join(GD.LOD2_OUT, part)
        for square in os.listdir(src):
            with open(os.path.join(src, square), 'rb') as a, open(os.path.join(final, square), 'ab') as b:
                shutil.copyfileobj(a, b)
        shutil.rmtree(src)
    units = 0
    for square in sorted(os.listdir(final)):
        units += sum(1 for _ in gzip.open(os.path.join(final, square), 'rb'))
    say(f'[rlp] Gebäude aus {len(staging)} Kacheln zusammengeführt: {len(os.listdir(final))} Quadrate '
        f'von 2 km, {units} Einheiten in data/work/lod2/{name}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Ostkilometer, UTM32 (400 oder 398..403)')
    ap.add_argument('--north', type=span, required=True, help='Nordkilometer, UTM32 (5579 oder 5576..5581)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur das Gelände oder nur die Gebäude')
    ap.add_argument('--lod2-name', default='Rheinland-Pfalz', help='Verzeichnis unter data/work/lod2')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Kacheln gleichzeitig geholt werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kacheln (zum Probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit ihnen geschieht')
    ap.add_argument('--gaps', help='die Kilometerquadrate ohne Daten des Landes in diese Datei schreiben')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[rlp] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} Kilometerquadrate')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[rlp] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerquadrate sind schon in einer anderen Karte, z. B. {overlap[:5]}')
        say(f'[rlp] {len(overlap)} Kilometerquadrate hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben weg')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    want_dgm = args.only in (None, 'dgm')
    want_lod2 = args.only in (None, 'lod2')
    work = []
    gaps = []

    if want_dgm:
        tiles = dgm_index()
        for e in range(e0, e1 + 1):
            for n in range(n0, n1 + 1):
                if f'{e}_{n}' in skip:
                    continue
                if f'{e}_{n}' in tiles:
                    work.append(('dgm', e, n, tiles[f'{e}_{n}']))
                else:
                    gaps.append(f'{e}_{n}')
        say(f'[rlp] Gelände: {sum(1 for w in work if w[0] == "dgm")} Kacheln zu holen')

    if want_lod2:
        # one tile of 2 km for every four kilometre squares; the anchor is even
        count = 0
        for e in range(e0 - e0 % 2, e1 + 1, 2):
            for n in range(n0 - n0 % 2, n1 + 1, 2):
                # a tile of 2 km reaches into four squares: if another map already has one
                # of them, its buildings belong to that map and the tile stays out
                if skip and any(f'{ee}_{nn}' in skip for ee in (e, e + 1) for nn in (n, n + 1)):
                    continue
                work.append(('lod2', e, n, 0))
                count += 1
        say(f'[rlp] Gebäude: {count} Kacheln von 2 km zu holen')

    if args.limit:
        work = work[: args.limit]
        say(f'[rlp] nur die ersten {len(work)} davon (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    missing = {'lod2': []}

    def one(item):
        product, e, n, extra = item
        tmp = os.path.join(GD.TMP, f'rlp-{product}-{e}_{n}')
        if product == 'dgm':
            made = take_dgm(extra, e, n, tmp + '.tif')
        else:
            made = take_lod2(e, n, args.lod2_name, tmp + '.gml')
        return product, e, n, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, e, n, made = item
            if made > 0:
                counts[product] += 1
            elif made < 0:
                missing['lod2'].append(f'{e}_{n}')
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[rlp] {done}/{len(work)}: {counts["dgm"]} Gelände, {counts["lod2"]} Gebäude '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    say(f'[rlp] fertig: {counts["dgm"]} Geländekacheln ({again["dgm"]} waren schon da), '
        f'{counts["lod2"]} Gebäudekacheln ({again["lod2"]} waren schon da) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if missing['lod2']:
        say(f'[rlp] keine Gebäudemodelle für {len(missing["lod2"])} Kacheln von 2 km: '
            + ', '.join(missing['lod2'][:8]))
    if gaps:
        say(f'[rlp] kein Gelände von Rheinland-Pfalz für {len(gaps)} Kilometerquadrate '
            '(dort bleibt die Karte leer)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
