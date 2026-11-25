#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Saxony –
the open geodata of the state survey (GeoSN, Landesamt für Geobasisinformation
Sachsen), licence "Datenlizenz Deutschland – Namensnennung – Version 2.0", so
nothing here needs a key, only a source note in the map – and reduce them to
what the map build reads.  It does for this state what tools/fetch-geodata.py
does for Hesse.

    python3 -I tools/fetch-sachsen.py --east 828..834 --north 5662..5668
    python3 -I tools/fetch-sachsen.py --east 824..838 --north 5658..5672 --only dgm
    python3 -I tools/fetch-sachsen.py --east 824..838 --north 5658..5672 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the grid the map tiles
are cut from – NOT the UTM33 grid Saxony names its own tiles by: 831_5665 is the
square the Dresden Altstadt lies in (UTM33: 410_5655).  Squares outside the
state get no terrain – they are printed at the end and the map stays out of them
(tools/osm-extract.ts builds where terrain is).

Where the data comes from: the "Produktdownload" of geoviewer.sachsen.de (the
download page https://www.geodaten.sachsen.de/downloadbereich-digitale-hoehenmodelle-4851.html
and …-digitale-3d-stadtmodelle-4875.html link to it).  Behind it an ArcGIS
MapServer, rest_geosn_downloadlinks, has one polygon per tile of 2 × 2 km (UTM33,
EPSG:25833) with its download link on the state's Nextcloud
(geocloud.landesvermessung.sachsen.de, public shares, no login); which tiles exist
is asked from it for the rectangle, never guessed.

Terrain:   dgm1_33<E>_<N>_2_sn_tiff.zip – one GeoTIFF of 2000 × 2000 cells of
           1 m in UTM33.  The map wants UTM32 squares of 1 km, and the two grids
           are turned against each other by ~3.6° here, so every cell centre of a
           UTM32 square goes through the Krüger series of src/geo/utm.ts (the
           functions of tools/fetch-mv.py) into UTM33 and its height is read
           there bilinearly from the tiles around it:
           data/work/dgm2/<E>_<N>.dgm (reduced by tools/fetch-geodata.py)

Buildings: lod2_33<E>_<N>_2_sn_citygml.zip – one CityGML 1.0 file per tile of
           2 km in UTM33; every coordinate triple of every gml:posList is moved
           to UTM32 (as tools/fetch-mv.py does) before tools/lod2-extract.ts
           reads it: data/work/lod2/<name>/<x>_<z>.ndjson.gz

What the licence says – the GeoSN's "Allgemeine Nutzungsbedingungen"
(https://www.landesvermessung.sachsen.de/allgemeine-nutzungsbedingungen-8954.html):
"Bei der Bereitstellung erteilt die Vermessungsbehörde gemäß § 1 Nr. 3 der
Sächsischen Geodatennutzungsverordnung … eine Erlaubnis zur Nutzung, die eine
uneingeschränkte Weiterverwendung der Informationen durch jedermann ermöglicht.
Die Erlaubnis entspricht dem Lizenzmuster der Datenlizenz Deutschland –
Namensnennung – Version 2.0 unter Angabe des Quellenvermerks 'Landesamt für
Geobasisinformation Sachsen (GeoSN)' oder kurz 'GeoSN'. Der Download und die
Nutzung der online bereitgestellten Daten sind … kostenfrei."  Example given
there: "Quelle: GeoSN, dl-de/by-2-0".  So the map names the source (see
.github/workflows/build-map-sachsen.yml).

--published <map-assets/index.json> keeps this map from covering a tile another
map already has (see tools/fetch-mv.py): with --on-overlap skip (the default)
those kilometre squares are left out, with fail the script stops.

Needs Python 3 with numpy and Pillow, and node.  What is already there is
skipped, so the command can be repeated after an interruption.
"""
import argparse
import concurrent.futures
import importlib.util
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, 'tools', file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# tools/fetch-mv.py: the Krüger series between UTM32 and UTM33, the reprojection of
# CityGML and the joining of the building tiles; it brings tools/fetch-geodata.py along
MV = module('fetch_mv', 'fetch-mv.py')
GD = MV.GD
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

AGENT = GD.AGENT
SERVICE = ('https://geodienste.sachsen.de/ags-relay/ArcGISServer/guest/arcgis/rest/services/'
           'geosn/rest_geosn_downloadlinks/MapServer')
LAYER_LOD2 = 3
LAYER_DGM1 = 6
# the links the Produktdownload app itself builds (its app.json); the MapServer's own
# CityGML links point to a share that answered 503 in November 2026, so they come second
CLOUD = 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/'
DGM_LINK = CLOUD + 'JCcXyifaNdLDnxZ/dgm1_33%d_%d_2_sn_tiff.zip'
LOD2_LINK = CLOUD + 'AyJqXpJAZJXomCb/lod2_33%d_%d_2_sn_citygml.zip'
CACHE = os.path.join(ROOT, 'data/work/sachsen')

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def zone32_to_zone33(east, north):
    lat, lon = MV.to_lat_lon(east, north, MV.ZONE_32)
    return MV.to_utm(lat, lon, MV.ZONE_33)


def urlopen(url, attempts=5):
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
            say(f'[sachsen] {e}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def fetch_first(urls):
    """The bytes of the first of these links that answers."""
    last = None
    for url in urls:
        if not url:
            continue
        try:
            return urlopen(url, attempts=3)
        except Exception as e:  # noqa: BLE001
            last = e
            say(f'[sachsen] {url}: {e}')
    raise RuntimeError(f'no link answered: {last}')


def rect33(e0, e1, n0, n1, margin=50.0):
    """The UTM33 frame of a UTM32 rectangle of kilometre squares (its corners and edge middles)."""
    es, ns = [], []
    for e in np.linspace(e0 * 1000, (e1 + 1) * 1000, 9):
        for n in np.linspace(n0 * 1000, (n1 + 1) * 1000, 9):
            es.append(e)
            ns.append(n)
    x, y = zone32_to_zone33(np.array(es), np.array(ns))
    return x.min() - margin, y.min() - margin, x.max() + margin, y.max() + margin


def tiles(layer, frame):
    """The tiles of 2 km the MapServer layer has in the frame: {(east km, north km): attributes}."""
    cache = os.path.join(CACHE, f'layer{layer}-{"_".join(str(round(v)) for v in frame)}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            found = json.load(f)
    else:
        query = urllib.parse.urlencode({
            'where': '1=1',
            'geometry': ','.join(f'{v:.0f}' for v in frame),
            'geometryType': 'esriGeometryEnvelope',
            'inSR': 25833,
            'spatialRel': 'esriSpatialRelIntersects',
            'outFields': '*',
            'returnGeometry': 'false',
            'f': 'json',
        })
        answer = json.loads(urlopen(f'{SERVICE}/{layer}/query?{query}'))
        if 'error' in answer:
            raise RuntimeError(f'MapServer layer {layer}: {answer["error"]}')
        if answer.get('exceededTransferLimit'):
            raise RuntimeError(f'MapServer layer {layer}: too many tiles in one answer – a smaller rectangle')
        found = [f['attributes'] for f in answer['features']]
        with open(cache + '.tmp', 'w') as f:
            json.dump(found, f)
        os.replace(cache + '.tmp', cache)
    out = {}
    for attrs in found:
        key = str(attrs['Kachel'])
        out[(int(key[:-4]), int(key[-4:]))] = attrs
    return out


# --- terrain ---------------------------------------------------------------------------

def tile_path(tile):
    return os.path.join(CACHE, 'dgm1', f'{tile[0]}_{tile[1]}.npy')


def take_dgm1_tile(tile, attrs):
    """One GeoTIFF of 2 km → data/work/sachsen/dgm1/<E>_<N>.npy (float32, NaN: no height)."""
    out = tile_path(tile)
    if os.path.exists(out):
        return 0
    blob = fetch_first([DGM_LINK % tile, attrs.get('Download')])
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        members = [m for m in z.namelist() if m.lower().endswith('.tif')]
        if not members:
            raise RuntimeError(f'{tile}: no GeoTIFF in {z.namelist()}')
        image = Image.open(io.BytesIO(z.read(members[0])))
        tie = image.tag_v2.get(33922)
        a = np.asarray(image, dtype=np.float32)
    if a.shape != (2000, 2000):
        raise RuntimeError(f'{tile}: expected 2000 x 2000 cells, got {a.shape}')
    # the tile's upper left corner must be where its name says (ModelTiepoint, PixelIsArea)
    if tie and (round(tie[3]) != tile[0] * 1000 or round(tie[4]) != (tile[1] + 2) * 1000):
        raise RuntimeError(f'{tile}: tie point {tie[3:5]} does not fit the name')
    a = np.where(a > -1000, a, np.nan).astype(np.float32)
    np.save(out + '.tmp.npy', a)
    os.replace(out + '.tmp.npy', out)
    return len(blob)


def take_dgm(east, north):
    """One UTM32 kilometre square: its 1000 × 1000 cell centres read bilinearly from the UTM33 tiles."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    j = np.arange(1000) + 0.5
    e32 = east * 1000 + j[None, :] + np.zeros((1000, 1))
    n32 = (north + 1) * 1000 - j[:, None] + np.zeros((1, 1000))   # row 0: the northern edge
    x, y = zone32_to_zone33(e32.ravel(), n32.ravel())
    # the mosaic of the tiles around the square, upper left corner (x0, y1)
    tx0 = int(np.floor((x.min() - 2) / 2000)) * 2
    tx1 = int(np.floor((x.max() + 2) / 2000)) * 2
    ty0 = int(np.floor((y.min() - 2) / 2000)) * 2
    ty1 = int(np.floor((y.max() + 2) / 2000)) * 2
    cols = (tx1 - tx0) // 2 + 1
    rows = (ty1 - ty0) // 2 + 1
    mosaic = np.full((rows * 2000, cols * 2000), np.nan, np.float32)
    any_tile = False
    for ci, te in enumerate(range(tx0, tx1 + 1, 2)):
        for ri, tn in enumerate(range(ty1, ty0 - 1, -2)):
            path = tile_path((te, tn))
            if os.path.exists(path):
                mosaic[ri * 2000:(ri + 1) * 2000, ci * 2000:(ci + 1) * 2000] = np.load(path, mmap_mode='r')
                any_tile = True
    if not any_tile:
        raise RuntimeError('no tile of the state here')
    x0 = tx0 * 1000
    y1 = (ty1 + 2) * 1000
    c = x - x0 - 0.5
    r = y1 - y - 0.5
    c0 = np.clip(np.floor(c).astype(np.int64), 0, mosaic.shape[1] - 2)
    r0 = np.clip(np.floor(r).astype(np.int64), 0, mosaic.shape[0] - 2)
    fc = (c - c0).astype(np.float32)
    fr = (r - r0).astype(np.float32)
    h00 = mosaic[r0, c0]
    h01 = mosaic[r0, c0 + 1]
    h10 = mosaic[r0 + 1, c0]
    h11 = mosaic[r0 + 1, c0 + 1]
    h = (h00 * (1 - fc) + h01 * fc) * (1 - fr) + (h10 * (1 - fc) + h11 * fc) * fr
    # at the edge of the state a corner may have no height: take the nearest cell there
    near = mosaic[np.clip(np.rint(r).astype(np.int64), 0, mosaic.shape[0] - 1),
                  np.clip(np.rint(c).astype(np.int64), 0, mosaic.shape[1] - 1)]
    h = np.where(np.isnan(h), near, h)
    if np.isnan(h).all():
        raise RuntimeError('no heights of the state in this square')
    h = np.where(np.isnan(h), -9999, h).astype(np.float32).reshape(1000, 1000)
    buf = io.BytesIO()
    Image.fromarray(h).save(buf, format='TIFF')
    blob = GD.reduce_tile(buf.getvalue())
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


# --- buildings -------------------------------------------------------------------------

def take_lod2(tile, attrs, name):
    """One CityGML file of a tile of 2 km, UTM33 → UTM32, read by tools/lod2-extract.ts (as in fetch-mv.py)."""
    key = f'{tile[0]}_{tile[1]}'
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{key}')
    if os.path.exists(done):
        return 0
    blob = fetch_first([LOD2_LINK % tile, attrs.get('Download_CityGML')])
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        members = [m for m in z.namelist() if m.lower().endswith('.gml')]
        if not members:
            raise RuntimeError(f'{key}: no CityGML in {len(blob)} bytes ({z.namelist()[:3]})')
        data = z.read(members[0])
    data, triples = MV.move_poslists(data)
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


def run(work, one, label):
    """Run the items with --jobs threads; returns (made, there, failed items)."""
    made = there = 0
    failed = []
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=ARGS.jobs) as pool:
        futures = {pool.submit(one, item): item for item in work}
        for count, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            item = futures[future]
            try:
                if future.result():
                    made += 1
                else:
                    there += 1
            except Exception as e:  # noqa: BLE001 - one failing tile does not spoil the others
                failed.append(item)
                say(f'[sachsen] {label} {item}: {e}')
            if count % 25 == 0 or count == len(work):
                say(f'[sachsen] {label}: {count}/{len(work)} – {(time.time() - started) / 60:.0f} min so far')
    say(f'[sachsen] {label}: {made} made, {there} were there, {len(failed)} failed')
    return made, there, failed


ARGS = None


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=MV.span, required=True, help='east kilometres, UTM32 (831 or 824..838)')
    ap.add_argument('--north', type=MV.span, required=True, help='north kilometres, UTM32 (5665 or 5658..5672)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Sachsen', help='directory under data/work/lod2')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no terrain for into this file')
    ARGS = args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), os.path.join(CACHE, 'dgm1')):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[sachsen] east {e0}..{e1} km, north {n0}..{n1} km (UTM32) – {(e1 - e0 + 1) * (n1 - n0 + 1)} squares of 1 km')
    frame = rect33(e0, e1, n0, n1)
    say(f'[sachsen] in UTM33: {frame[0]:.0f}..{frame[2]:.0f} / {frame[1]:.0f}..{frame[3]:.0f}')

    known = set()
    if args.published:
        with open(args.published) as f:
            for file in json.load(f)['files']:
                known.update(file['tiles'])
        say(f'[sachsen] {args.published}: {len(known)} tiles of other maps')
    overlap = sorted(f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)
                     if MV.tile_keys(e, n) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[sachsen] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + f', e. g. {overlap[:5]}')
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    if args.only != 'lod2':
        dgm1 = tiles(LAYER_DGM1, frame)
        say(f'[sachsen] dgm1: {len(dgm1)} tiles of 2 km of the state touch the rectangle')
        run(sorted(dgm1), lambda t: take_dgm1_tile(t, dgm1[t]), 'dgm1 tiles')
        squares = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1) if f'{e}_{n}' not in skip]
        _, _, gaps = run(squares, lambda s: take_dgm(*s), 'terrain squares')
        if gaps:
            names = sorted(f'{e}_{n}' for e, n in gaps)
            say(f'[sachsen] no terrain of Saxony for {len(names)} kilometre squares (the map stays out of them)')
            if args.gaps:
                with open(args.gaps, 'w') as f:
                    f.write('\n'.join(names) + '\n')
    if args.only != 'dgm':
        lod2 = tiles(LAYER_LOD2, frame)
        say(f'[sachsen] lod2: {len(lod2)} tiles of 2 km of the state touch the rectangle')
        run(sorted(lod2), lambda t: take_lod2(t, lod2[t], args.lod2_name), 'lod2 tiles')
        # merge_lod2 of tools/fetch-mv.py joins the staging directories .<name>-<tile>
        MV.merge_lod2(args.lod2_name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
