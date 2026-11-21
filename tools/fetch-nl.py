#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the open geodata of the Netherlands – the terrain model AHN (Actueel
Hoogtebestand Nederland, 0.5 m, served by PDOK as WCS) and the building
models of 3DBAG (LoD2, CityJSON) – and reduce them to what the map build
reads.  Nothing here needs a key or an account:

  terrain    PDOK WCS, coverage dtm_05m, licence CC0 1.0 (the capabilities
             of the service say: <ows:Fees>NONE</ows:Fees> and
             <ows:AccessConstraints>otherRestrictions; Geen beperkingen;
             http://creativecommons.org/publicdomain/zero/1.0/deed.nl</ows:AccessConstraints>)
  buildings  3DBAG v20250903, licence CC BY 4.0 (the collection says so:
             https://creativecommons.org/licenses/by/4.0/)

    python3 -I tools/fetch-nl.py --east 214..228 --north 5803..5817
    python3 -I tools/fetch-nl.py --east 214..228 --north 5803..5817 --only dgm
    python3 -I tools/fetch-nl.py --east 214..228 --north 5803..5817 --published map-assets/index.json

--east/--north are kilometre squares of UTM32 (EPSG:25832), the grid the
whole map is built on: 221_5810 is the square the centre of Amsterdam lies
in.  AHN answers a WCS request for such a square in UTM32 itself
(SUBSETTINGCRS and OUTPUTCRS), so no reprojection of the terrain is needed;
3DBAG is in RD (EPSG:7415) and is turned into UTM32 here (a polynomial fit,
17 mm rms).

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – 1 km on a grid of 2 m, reduced
           by tools/fetch-geodata.py, which is read here for it
Buildings: data/work/lod2/<municipality>/<x>_<z>.ndjson.gz – written by
           tools/lod2-extract.ts, one directory per municipality (the tiles
           of 3DBAG are named after no municipality, so the municipality the
           middle of a tile lies in gives it its name)

Two honest notes about the heights – both are said again in reports/nl.md:

* the reduced terrain holds no height below 0 (0 means "no height" to the
  map), and much of the Randstad lies below NAP; every height therefore gets
  OFFSET = 10 m added, terrain and buildings alike, so that the scene keeps
  its own shape (nothing is flattened) and no hole appears where a polder is;
* AHN leaves cells without a height (nodata 3.4e38 – under buildings, on
  water, in the shadow of the laser), a third of the cells in the centre of
  Amsterdam; those cells get the mean of their neighbourhood (radii 2, 8, 32
  and 128 m) before the tile is reduced.  A square that is almost entirely
  gap (open water) is left out, so the map stays out of it.

--published <map-assets/index.json> keeps this map from covering a tile
another map already has (with --on-overlap fail instead the script stops and
names them).

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py),
curl and node.  What is already there is skipped, so the command can be
repeated after an interruption.
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py as a module: its reduce_tile writes the terrain of Hesse – it writes ours too."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# the open services (no key, no account):
AHN = 'https://service.pdok.nl/rws/actueel-hoogtebestand-nederland/wcs/v1_0'
BAG = 'https://data.3dbag.nl/api/BAG3D/wfs'
GEMEENTE = 'https://service.pdok.nl/kadaster/bestuurlijkegebieden/wfs/v1_0'
CRS = 'http://www.opengis.net/def/crs/EPSG/0/25832'
CACHE = os.path.join(ROOT, 'data/work/nl')

# every height (terrain and buildings) is lifted by this much, because the
# reduced terrain cannot hold the heights below NAP of the Dutch lowlands
OFFSET = 10.0
# a kilometre square with less than this share of cells with a height is left out
VALID_MIN = 0.05

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

# RD (EPSG:7415) -> UTM32 (EPSG:25832) and back: a polynomial of degree 3 in
# kilometres around the middle of the country, fitted against 170 867 points
# of the RDNAPTRANS grid (17 mm rms, 0.20 m at the worst point)
RD_CENTRE = (155000.0, 463000.0)
UTM_CENTRE = (248814.76226644922, 5783315.914661597)
RD2UTM = [[4.063688506828062, 1.1373119485082952], [0.049822107219505925, 0.9991983971057811],
          [3.0110809216847385e-06, -3.046296975734321e-07], [-3.464635581935464e-10, -2.073134278284815e-09],
          [0.999198518597102, -0.0498220469397924], [-5.820197936360134e-07, -6.038643500608461e-06],
          [-5.977491672237396e-09, 9.526682349056808e-10], [-3.0237631228566857e-06, 3.027753235162682e-07],
          [7.6205519596696e-10, 6.1765776857016155e-09], [1.92849838264734e-09, -2.615200871704299e-10]]

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'214..228' → (214, 228); '214' → (214, 214)"""
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
            with urllib.request.urlopen(request, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[nl] {e}; trying again')
            time.sleep(5 * (attempt + 1))


def curl_to(url, dest, attempts=6):
    """Download with curl (resumes a partial file)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(attempts):
        code = subprocess.call(
            ['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30', '-o', dest, url]
        )
        if code == 0 and os.path.getsize(dest) > 1024:
            return
        # 33: the server would not resume – start again
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[nl] curl ended with {code} for {os.path.basename(dest)}; trying again')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


def rd_to_utm(x, y):
    """Rijksdriehoek coordinates → UTM32 (numpy arrays of any shape)."""
    import numpy as np

    u = (np.asarray(x, dtype=np.float64) - RD_CENTRE[0]) / 1000
    v = (np.asarray(y, dtype=np.float64) - RD_CENTRE[1]) / 1000
    terms = np.stack(
        [np.ones_like(u), v, v * v, v**3, u, u * v, u * v * v, u * u, u * u * v, u**3], axis=-1
    )
    shape = np.broadcast(u, v).shape
    flat = terms.reshape(-1, 10) @ np.asarray(RD2UTM, dtype=np.float64)
    # the fit works in kilometres (that is what keeps it accurate with coefficients near 1)
    east = 1000 * flat[:, 0].reshape(shape) + UTM_CENTRE[0]
    north = 1000 * flat[:, 1].reshape(shape) + UTM_CENTRE[1]
    return east, north


def coverage_url(east, north):
    """The WCS request for the terrain of one kilometre square of UTM32 (AHN answers in UTM32 itself)."""
    x0, x1 = east * 1000, (east + 1) * 1000
    y0, y1 = north * 1000, (north + 1) * 1000
    parts = [
        'SERVICE=WCS', 'VERSION=2.0.1', 'REQUEST=GetCoverage', 'COVERAGEID=dtm_05m', 'FORMAT=image/tiff',
        f'SUBSET=x({x0},{x1})', f'SUBSET=y({y0},{y1})',
        f'SUBSETTINGCRS={CRS}', f'OUTPUTCRS={CRS}', 'SCALESIZE=x(1000),y(1000)',
    ]
    return AHN + '?' + '&'.join(parts)


def box_sum(a, r):
    """For every cell, the sum of the cells in the square of (2 r + 1)² around it (edges held)."""
    import numpy as np

    p = np.pad(a, r, mode='edge')
    cum = np.zeros((p.shape[0] + 1, p.shape[1] + 1), dtype=np.float64)
    cum[1:, 1:] = np.cumsum(np.cumsum(p, axis=0), axis=1)
    n = 2 * r + 1
    return cum[n:, n:] - cum[:-n, n:] - cum[n:, :-n] + cum[:-n, :-n]


def take_dgm(east, north, tmp):
    """One kilometre square of AHN → data/work/dgm2/<E>_<N>.dgm; None when the square has no terrain."""
    import numpy as np
    from PIL import Image

    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(coverage_url(east, north), tmp)
    with Image.open(tmp) as im:
        a = np.asarray(im, dtype=np.float32)
    if a.shape != (1000, 1000):
        raise ValueError(f'{east}_{north}: expected 1000 x 1000 cells, got {a.shape}')
    os.remove(tmp)
    # 3.4028235e+38 is the nodata value of AHN; the heights themselves stay within ±100 m
    valid = (a > -1000) & (a < 10000)
    if valid.mean() < VALID_MIN:
        say(f'[nl] terrain {east}_{north}: only {valid.mean() * 100:.1f} % of the cells have a height – left out')
        return None
    a = np.where(valid, a, 0.0)
    for r in (2, 8, 32, 128):
        if valid.all():
            break
        count = box_sum(valid.astype(np.float64), r)
        mean = box_sum(a, r) / np.maximum(count, 1)
        a = np.where(valid, a, mean)
        valid = valid | (count > 0)
    a = np.where(valid, a, 0.0) + OFFSET
    buf = io.BytesIO()
    Image.fromarray(a, mode='F').save(buf, format='TIFF')
    blob = GD.reduce_tile(buf.getvalue())
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def flat(coords):
    """Every position of a GeoJSON coordinate nest, and the corners of its box."""
    xs = []
    ys = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for part in c:
                walk(part)

    walk(coords)
    return min(xs), max(xs), min(ys), max(ys)


def rings(coords):
    """The rings of a GeoJSON polygon or multipolygon: [(outer, [hole, …]), …]"""
    if not coords:
        return []
    if isinstance(coords[0][0], (int, float)):
        return [(coords, [])]
    if isinstance(coords[0][0][0], (int, float)):
        return [(coords[0], coords[1:])]
    out = []
    for polygon in coords:
        out += rings(polygon)
    return out


def inside(x, y, ring):
    hit = False
    for i in range(len(ring) - 1):
        ax, ay = ring[i][0], ring[i][1]
        bx, by = ring[i + 1][0], ring[i + 1][1]
        if (ay > y) != (by > y) and x < ax + (y - ay) / (by - ay) * (bx - ax):
            hit = not hit
    return hit


def municipalities(e0, e1, n0, n1):
    """The municipalities of the rectangle: [(name, [(outer, holes), …])] as PDOK draws them."""
    cache = os.path.join(CACHE, f'gemeente-{e0}-{e1}-{n0}-{n1}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            answer = json.load(f)
    else:
        query = urllib.parse.urlencode({
            'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature',
            'typeName': 'bestuurlijkegebieden:Gemeentegebied', 'outputFormat': 'application/json',
            'srsName': 'EPSG:25832', 'count': 1000,
            'BBOX': f'{e0 * 1000},{n0 * 1000},{(e1 + 1) * 1000},{(n1 + 1) * 1000},EPSG:25832',
        })
        answer = ask(f'{GEMEENTE}?{query}')
        with open(cache + '.tmp', 'w') as f:
            json.dump(answer, f)
        os.replace(cache + '.tmp', cache)
    out = []
    for feature in answer.get('features') or []:
        name = (feature.get('properties') or {}).get('naam')
        if name and feature.get('geometry'):
            out.append((name, rings(feature['geometry']['coordinates'])))
    say(f'[nl] {len(out)} municipalities in the rectangle')
    return out


def plain(name):
    """'s-Hertogenbosch → s-Hertogenbosch (a directory name, and a name tools/lod2-extract.ts takes)."""
    return re.sub(r'[/\\]+', ' ', name).strip() or 'Nederland'


def bag_tiles(e0, e1, n0, n1):
    """The 3DBAG tiles that reach into the rectangle, finest first: (tile id, download link, middle x, middle y)."""
    cache = os.path.join(CACHE, f'tiles-{e0}-{e1}-{n0}-{n1}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            answer = json.load(f)
    else:
        answer = {'features': []}
        start = 0
        while True:
            query = urllib.parse.urlencode({
                'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'typeName': 'BAG3D:tiles',
                'outputFormat': 'application/json', 'srsName': 'EPSG:25832', 'count': 1000,
                # the tiles table has no primary key: without an order of its own the service
                # refuses to page ("Cannot do natural order without a primary key")
                'sortBy': 'tile_id', 'startIndex': start,
                'BBOX': f'{e0 * 1000},{n0 * 1000},{(e1 + 1) * 1000},{(n1 + 1) * 1000},EPSG:25832',
            })
            page = ask(f'{BAG}?{query}')
            features = page.get('features') or []
            answer['features'] += features
            if len(features) < 1000:
                break
            start += 1000
        with open(cache + '.tmp', 'w') as f:
            json.dump(answer, f)
        os.replace(cache + '.tmp', cache)
    tiles = []
    for feature in answer['features']:
        props = feature.get('properties') or {}
        link = props.get('cj_download')
        if not link or not feature.get('geometry'):
            continue
        x0, x1, y0, y1 = flat(feature['geometry']['coordinates'])
        tiles.append((props.get('tile_id', ''), link, (x0 + x1) / 2, (y0 + y1) / 2))
    # 3DBAG tiles of several zooms cover each other (the zoom follows how built-up an area is);
    # the finer ones hold the better models, so they are read first (a building read once stays read)
    tiles.sort(key=lambda t: (-int(t[0].split('/')[0]) if t[0].split('/')[0].isdigit() else 0, t[0]))
    say(f'[nl] {len(tiles)} tiles of 3DBAG in the rectangle')
    return tiles


def city_gml(path, seen, lock):
    """One 3DBAG tile (CityJSON, gzip) → CityGML for tools/lod2-extract.ts, in UTM32 and lifted by OFFSET.

    Buildings another tile already brought are left out: the tiles of different zooms cover each
    other, and the same building twice is two buildings in the map.
    """
    import numpy as np

    kinds = {'GroundSurface': 'bldg:GroundSurface', 'WallSurface': 'bldg:WallSurface',
             'RoofSurface': 'bldg:RoofSurface'}
    with gzip.open(path) as fh:
        city = json.load(fh)
    scale = np.asarray(city['transform']['scale'], dtype=np.float64)
    translate = np.asarray(city['transform']['translate'], dtype=np.float64)
    vertices = np.asarray(city['vertices'], dtype=np.float64) * scale + translate
    east, north = rd_to_utm(vertices[:, 0], vertices[:, 1])
    height = vertices[:, 2] + OFFSET
    objects = city['CityObjects']
    out = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<CityModel xmlns:bldg="http://www.opengis.net/citygml/building/2.0" '
        'xmlns:gml="http://www.opengis.net/gml">',
    ]
    kept = 0
    again = 0
    for oid, obj in objects.items():
        if obj.get('type') != 'Building':
            continue
        # 1000 is the flat roof of the map build, 1010 a slanted one (tools/mapgen/buildings.ts)
        roof = '1000' if (obj.get('attributes') or {}).get('b3_dak_type') == 'horizontal' else '1010'
        for child in obj.get('children') or [oid]:
            part = objects.get(child, obj)
            solid = None
            for lod in ('2.2', '1.3', '1.2'):
                for geometry in part.get('geometry') or []:
                    if str(geometry.get('lod')) == lod and geometry.get('type') == 'Solid':
                        solid = geometry
                        break
                if solid:
                    break
            if not solid:
                continue
            with lock:
                if child in seen:
                    again += 1
                    continue
                seen.add(child)
            semantics = [s.get('type', '') for s in (solid.get('semantics') or {}).get('surfaces') or []]
            written = False
            for index, surface in enumerate(solid['boundaries'][0]):
                kind = kinds.get(semantics[index] if index < len(semantics) else '', 'bldg:WallSurface')
                ring = surface[0]
                if len(ring) < 4:
                    continue
                points = ' '.join(f'{east[v]:.2f} {north[v]:.2f} {height[v]:.2f}' for v in ring)
                if not written:
                    out.append(f'<bldg:Building gml:id="{child}">')
                    out.append(f'<bldg:roofType>{roof}</bldg:roofType>')
                    written = True
                out.append(f'<{kind}><gml:exterior><gml:posList>{points}</gml:posList></gml:exterior></{kind}>')
            if written:
                out.append('</bldg:Building>')
                kept += 1
    out.append('</CityModel>')
    return '\n'.join(out) + '\n', kept, again


def take_lod2(tile, link, name, tmp, seen, lock):
    """One tile of 3DBAG → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles of one municipality together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{tile}')
    if os.path.exists(done):
        return 0, 0
    curl_to(link, tmp)
    gml, kept, again = city_gml(tmp, seen, lock)
    if os.path.exists(tmp):
        os.remove(tmp)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {tile}: {kept} models, {again} another tile had already\n')
    if not kept:
        return kept, again
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', f'.{name}-{tile}', '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    node.stdin.write(gml.encode())
    node.stdin.close()
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts failed for {name} {tile}')
    return kept, again


def merge_lod2(name):
    """Put the squares of 2 km of every tile of one municipality together into data/work/lod2/<name>."""
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
    say(f'[nl] {name}: {len(staging)} tiles joined – {len(os.listdir(final))} squares of 2 km, {units} units')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (221 or 214..228)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5810 or 5803..5817)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the terrain has no data for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[nl] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} squares of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[nl] {args.published}: {len(known)} tiles of other maps')

    squares = [f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    overlap = sorted(s for s in squares if tile_keys(*(int(v) for v in s.split('_'))) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[nl] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    if args.on_overlap == 'skip':
        squares = [s for s in squares if s not in set(overlap)]

    started = time.time()
    gaps = []
    if args.only != 'lod2':
        done = 0
        again = 0
        work = [(int(s.split('_')[0]), int(s.split('_')[1])) for s in squares]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for i, made in enumerate(pool.map(
                lambda t: take_dgm(t[0], t[1], os.path.join(GD.TMP, f'nl-dgm-{t[0]}_{t[1]}.tif')), work
            ), start=1):
                if made:
                    done += 1
                elif made is None:
                    gaps.append(f'{work[i - 1][0]}_{work[i - 1][1]}')
                else:
                    again += 1
                if i % 25 == 0 or i == len(work):
                    say(f'[nl] terrain {i}/{len(work)}: {done} squares of terrain ({again} were there) '
                        f'– {(time.time() - started) / 60:.0f} min so far')
        say(f'[nl] terrain done: {done} tiles ({again} were there, {len(gaps)} without terrain) '
            f'in {(time.time() - started) / 60:.0f} min')

    names = set()
    if args.only != 'dgm':
        tiles = bag_tiles(e0, e1, n0, n1)
        if args.limit:
            tiles = tiles[: args.limit]
            say(f'[nl] only the first {len(tiles)} of them (--limit)')
        places = municipalities(e0, e1, n0, n1)
        work = []
        for tile_id, link, x, y in tiles:
            # the tiles of 3DBAG are named after no municipality: the one the middle of a tile lies
            # in gives the buildings their directory (a tile over a border goes to one of them)
            name = 'Nederland'
            for place, polygons in places:
                if any(inside(x, y, outer) and not any(inside(x, y, hole) for hole in holes)
                       for outer, holes in polygons):
                    name = plain(place)
                    break
            work.append((tile_id.replace('/', '-'), link, name))
        seen = set()
        lock = threading.Lock()
        total = 0
        doubled = 0
        started = time.time()

        def one(item):
            tile_id, link, name = item
            kept, again = take_lod2(tile_id, link, name,
                                    os.path.join(GD.TMP, f'nl-{tile_id}.city.json.gz'), seen, lock)
            return name, kept, again

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for i, (name, kept, again) in enumerate(pool.map(one, work), start=1):
                total += kept
                doubled += again
                names.add(name)
                if i % 25 == 0 or i == len(work):
                    say(f'[nl] buildings {i}/{len(work)}: {total} models ({doubled} another tile had already) '
                        f'– {(time.time() - started) / 60:.0f} min so far')
        say(f'[nl] buildings done: {total} models in {len(work)} tiles ({doubled} already read) '
            f'in {(time.time() - started) / 60:.0f} min')
        for name in sorted(names):
            merge_lod2(name)

    if gaps:
        say(f'[nl] no terrain for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
