#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das Geländemodell und die Gebäude des südöstlichen Frankreichs von der
Géoplateforme (IGN, Licence Ouverte / Open Licence 2.0 – kein Schlüssel, keine
Anmeldung) und bringt sie in die Form, in der der Kartenbau sie liest.

    python3 -I tools/fetch-frs.py --east 170..184 --north 5069..5083
    python3 -I tools/fetch-frs.py --east 176..176 --north 5076..5076 --only dgm
    python3 -I tools/fetch-frs.py --east 176..184 --north 5069..5083 --published map-assets/index.json

--east/--north sind Kilometerquadrate in UTM32 (EPSG:32632 – die Géoplateforme
liefert Zone 32 statt 25832, die Zahlen sind dieselben); 176_5076 ist das
Quadrat, in dem Lyon liegt.

Gelände:  RGE ALTI® (5 m) als Höhenraster über WMS – 1000 × 1000 Werte je
          Quadratkilometer, nach Norden ausgerichtet → data/work/dgm2/<E>_<N>.dgm
          Die Reduktion ist die von tools/fetch-geodata.py, nur mit anderem
          Höhenschritt: 2 cm reichen bis 1310 m, darüber 5 cm (Alpen) oder
          10 cm, damit 65535 Stufen immer genügen (tools/mapgen/dgm.ts:60 liest
          den Schritt aus der Datei).
Gebäude:  BD TOPO® V3, BDTOPO_V3:batiment über WFS – Grundriss mit Dachhöhen,
          daraus Wand-, Dach- und Bodenflächen → data/work/lod2/<Gemeinde>/<x>_<z>.ndjson.gz
          im selben Aufbau wie tools/lod2-extract.ts ihn schreibt (ein Verzeichnis
          je Gemeinde, damit tools/build-graph.ts die OSM-Umrisse dort nicht
          zusätzlich hochzieht).  Die Gemeinden kommen aus BDTOPO_V3:commune.

--published <map-assets/index.json> lässt Quadrate aus, die eine andere Karte
schon hat.  Python 3 mit numpy; was daliegt, wird übersprungen, der Lauf kann
also nach einer Unterbrechung wiederholt werden.
"""
import argparse
import concurrent.futures
import gzip
import json
import os
import re
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib

try:
    import numpy as np
except ImportError:  # noqa: BLE001 - nur beim Rechnen gebraucht; der Fehler kommt dann beim ersten Kachelschreiben
    np = None

# Wird nur gebraucht, wenn das Werkzeug zum Probieren außerhalb der Kopie liegt.
ROOT = os.environ.get('FRS_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WMS = 'https://data.geopf.fr/wms-r/wms'
WMS_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES'
WFS = 'https://data.geopf.fr/wfs/ows'
BATIMENT = 'BDTOPO_V3:batiment'
COMMUNE = 'BDTOPO_V3:commune'
TYPENAMES = 'BDTOPO_V3:batiment'
COUNT = 5000
AGENT = 'map-fetch/0.1'

WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000
LOD2_BIN = 2000
DGM_N = 500
RASTER = 1000

DGM_OUT = os.path.join(ROOT, 'data/work/dgm2')
LOD2_OUT = os.path.join(ROOT, 'data/work/lod2')
TMP = os.path.join(ROOT, 'data/raw/tmp')
CACHE = os.path.join(ROOT, 'data/work/frs')

GML = '{http://www.opengis.net/gml/3.2}'
BD = '{http://BDTOPO_V3}'

# usage_1 → der deutsche Funktionscode, den tools/mapgen/buildings.ts:116 liest
# (2000…2999 gewerblich, 3000…3999 öffentlich, 3041 Kirche, sonst nach Größe)
USAGE = {
    'Résidentiel': '51001_1000',
    'Commercial et services': '51001_2000',
    'Industriel': '51001_2500',
    'Agricole': '51001_2400',
    'Stockage': '51001_2500',
    'Religieux': '51001_3041',
    'Enseignement': '51001_3000',
    'Santé': '51001_3000',
    'Sportif': '51001_3200',
    'Administratif': '51001_3000',
    'Services publics': '51001_3000',
    'Transport': '51001_3300',
}
LIGHT = '51001_2523'  # leichte Baukörper (Schuppen): einfache Wand

FALLBACK = ['Frankreich']

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'176..184' → (176, 184); '176' → (176, 176)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'kein Kilometerbereich: {text}')
    return tuple(values)


def tile_keys(east, north):
    """Die vier 500-m-Kacheln eines Kilometerquadrats, so wie map-assets sie nennt ('434_363')."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def ask(url, attempts=6):
    """Lädt eine URL; bei Netzfehlern wird mit wachsendem Abstand wiederholt."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - irgendein Netzärger: warten und noch einmal
            if attempt == attempts - 1:
                raise
            say(f'[fr-suedost] {e}; noch einmal')
            time.sleep(5 * (attempt + 1))


def reduce_own(values, step):
    """1000 × 1000 Höhen (Meter) → die Bytes einer reduzierten Kachel (wie fetch-geodata.py)."""
    k = RASTER // DGM_N
    valid = np.isfinite(values) & (values > -1000)
    total = np.where(valid, values, 0).astype(np.float64).reshape(DGM_N, k, DGM_N, k).sum(axis=(1, 3))
    count = valid.reshape(DGM_N, k, DGM_N, k).sum(axis=(1, 3))
    mean = np.where(count > 0, total / np.maximum(count, 1), 0)
    # 0 heißt „keine Höhe hier“
    q = np.clip(np.rint(mean / step), 0, 65535).astype(np.int64)
    padded = np.zeros((DGM_N + 1, DGM_N + 1), np.int64)
    padded[1:, 1:] = q
    # was linker, oberer und linksoberer Nachbar nicht vorhersagen
    rest = padded[1:, 1:] - padded[1:, :-1] - padded[:-1, 1:] + padded[:-1, :-1]
    wrapped = (rest & 0xFFFF).astype(np.uint16).astype(np.int16)
    zigzag = ((wrapped.astype(np.int32) << 1) ^ (wrapped.astype(np.int32) >> 15)).astype(np.uint16)
    planes = (zigzag & 0xFF).astype(np.uint8).tobytes() + (zigzag >> 8).astype(np.uint8).tobytes()
    return b'DGM2' + struct.pack('<HH', DGM_N, round(step * 1000)) + zlib.compress(planes, 9)


def take_dgm(east, north):
    """Ein Kilometerquadrat Gelände → data/work/dgm2/<E>_<N>.dgm."""
    out = os.path.join(DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0, 0.0, 0.0
    query = urllib.parse.urlencode({
        'SERVICE': 'WMS',
        'VERSION': '1.3.0',
        'REQUEST': 'GetMap',
        'LAYERS': WMS_LAYER,
        'STYLES': '',
        'CRS': 'EPSG:32632',
        'BBOX': f'{east * 1000},{north * 1000},{(east + 1) * 1000},{(north + 1) * 1000}',
        'WIDTH': RASTER,
        'HEIGHT': RASTER,
        'FORMAT': 'image/x-bil;bits=32',
    })
    raw = ask(f'{WMS}?{query}')
    expected = RASTER * RASTER * 4
    if len(raw) != expected:
        raise RuntimeError(f'{east}_{north}: {len(raw)} Bytes statt {expected} ({raw[:120]!r})')
    values = np.frombuffer(raw, dtype='<f4').reshape(RASTER, RASTER)
    # Zeile 0 liegt im Norden: die oberste Zeile beginnt an der Nordkante
    highest = float(np.nanmax(values[np.isfinite(values) & (values > -1000)])) if np.isfinite(values).any() else 0.0
    step = 0.02 if highest <= 1310 else 0.05 if highest <= 3270 else 0.1
    blob = reduce_own(values, step)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob), highest, step


def wfs_features(typename, bbox):
    """Alle Features eines Layers im Rechteck (Seitenweise; BBOX in EPSG:32632)."""
    start = 0
    matched = None
    while True:
        query = urllib.parse.urlencode({
            'SERVICE': 'WFS',
            'VERSION': '2.0.0',
            'REQUEST': 'GetFeature',
            'TYPENAMES': typename,
            'SRSNAME': 'EPSG:32632',
            # (ohne die Namensangabe in der Box antwortet der Dienst mit 0 Treffern)
            'BBOX': f'{bbox},EPSG:32632',
            'COUNT': COUNT,
            'STARTINDEX': start,
        })
        raw = ask(f'{WFS}?{query}')
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            raise RuntimeError(f'{typename}: {e} – {raw[:200]!r}') from None
        if matched is None:
            try:
                matched = int(root.get('numberMatched', '0') or 0)
            except ValueError:  # 'unknown': then it counts itself
                matched = 0
        returned = int(root.get('numberReturned', '0') or 0)
        yield root
        if returned < COUNT or matched and start + returned >= matched:
            return
        if returned == 0:
            return
        start += returned


def text_of(feature, tag, default=''):
    node = feature.find(BD + tag)
    return node.text.strip() if node is not None and node.text else default


def rings_of(feature, dim):
    """Die Außenringe der Geometrie: [(ost, nord, höhe), …], Schlusspunkt entfernt."""
    out = []
    surface = feature.find(BD + 'geometrie/' + GML + 'MultiSurface')
    if surface is None:
        return out
    for member in surface.findall(GML + 'surfaceMember/' + GML + 'Polygon'):
        exterior = member.find(GML + 'exterior/' + GML + 'LinearRing/' + GML + 'posList')
        if exterior is None or not exterior.text:
            continue
        nums = exterior.text.split()
        if len(nums) < dim * 4 or len(nums) % dim:
            continue
        pts = [tuple(float(nums[i + d]) for d in range(dim)) for i in range(0, len(nums), dim)]
        if dim == 2:
            pts = [(p[0], p[1], 0.0) for p in pts]
        if len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6:
            pts = pts[:-1]
        if len(pts) >= 3:
            out.append(pts)
    return out


def inside(rings, x, z):
    """Liegt der Punkt (Weltkoordinaten) im ersten Ring oder in einem seiner Löcher?"""
    for ring in rings:
        hit = False
        n = len(ring)
        for i in range(n):
            x1, z1 = ring[i]
            x2, z2 = ring[(i + 1) % n]
            if (z1 > z) != (z2 > z):
                if x1 + (z - z1) / (z2 - z1) * (x2 - x1) > x:
                    hit = not hit
        if hit:
            return True
    return False


def load_communes(e0, e1, n0, n1):
    """Die Gemeinden des Rechtecks: name, Ringe in Weltkoordinaten, Rahmengrenzen."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'communes-{e0}_{e1}-{n0}_{n1}.json')
    bbox = f'{e0 * 1000},{n0 * 1000},{(e1 + 1) * 1000},{(n1 + 1) * 1000}'
    places = []
    if os.path.exists(cache):
        with open(cache) as f:
            for entry in json.load(f):
                places.append({'name': entry['name'], 'polys': [[tuple(p) for p in poly] for poly in entry['polys']]})
        return finish_communes(places)
    for root in wfs_features(COMMUNE, bbox):
        for feature in root.iter(BD + 'commune'):
            name = text_of(feature, 'nom_officiel')
            polys = [[(round(p[0] - WORLD_ORIGIN_E, 2), round(WORLD_ORIGIN_N - p[1], 2)) for p in ring] for ring in rings_of(feature, 2)]
            polys = [p for p in polys if len(p) >= 3]
            if not name or not polys:
                continue
            places.append({'name': plain(name), 'polys': polys})
    say(f'[fr-suedost] {len(places)} Gemeinden im Rechteck')
    with open(cache + '.tmp', 'w') as f:
        json.dump([{'name': p['name'], 'polys': p['polys']} for p in places], f)
    os.replace(cache + '.tmp', cache)
    return finish_communes(places)


def finish_communes(places):
    for place in places:
        xs = [x for poly in place['polys'] for x, _ in poly]
        zs = [z for poly in place['polys'] for _, z in poly]
        place['box'] = (min(xs), min(zs), max(xs), max(zs))
        place['centre'] = ((min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2)
    return places


def plain(name):
    """Gemeindename → Verzeichnisname (wie ihn OSM auch schreibt)."""
    return re.sub(r'[^0-9A-Za-zÀ-ÿ\' -]+', '_', name).strip(" _-'") or 'Frankreich'


def commune_of(places, x, z):
    """Die Gemeinde, in der ein Punkt liegt; sonst die nächste (Rechtecksrand)."""
    best = None
    best_d = None
    for index, place in enumerate(places):
        x0, z0, x1, z1 = place['box']
        if x0 - 50 <= x <= x1 + 50 and z0 - 50 <= z <= z1 + 50 and inside(place['polys'], x, z):
            return index
        cx, cz = place['centre']
        d = (cx - x) ** 2 + (cz - z) ** 2
        if best_d is None or d < best_d:
            best_d = d
            best = index
    return best


def normal_outward(poly, centre):
    """Stimmt die Umlaufrichtung der Fläche (nach außen zeigende Normale)?"""
    def triplets():
        for i in range(1, len(poly), 3):
            yield (poly[i], poly[i + 1], poly[i + 2])

    p = list(triplets())
    ax, ay, az = (p[1][i] - p[0][i] for i in range(3))
    bx, by, bz = (p[2][i] - p[0][i] for i in range(3))
    nx, ny, nz = ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx
    mx = sum(q[0] for q in p) / len(p) - centre[0]
    mz = sum(q[2] for q in p) / len(p) - centre[1]
    return nx * mx + nz * mz


def unit_of(feature, places, seen=()):
    """Ein BD-TOPO-Gebäude → den Satz {gemeinde, zeile} wie ihn der Kartenbau liest."""
    rings = rings_of(feature, 3)
    if not rings:
        return None
    fid = text_of(feature, 'cleabs') or text_of(feature, 'identifiants_rnb')
    if fid:
        # (ein Gebäude, das über die Kachelgrenze ragt, kommt zweimal: nur einmal schreiben)
        if fid in seen:
            return None
        seen.add(fid)
    usage = text_of(feature, 'usage_1')
    fn = LIGHT if text_of(feature, 'construction_legere') == 'true' else USAGE.get(usage, '51001_1000')
    height = float(text_of(feature, 'hauteur', '0') or 0)
    try:
        base = float(text_of(feature, 'altitude_minimale_sol'))
    except ValueError:
        base = None
    highest = max(p[2] for ring in rings for p in ring)
    if base is None:
        base = (highest - height) if height else min(p[2] for ring in rings for p in ring)
    world = []
    for ring in rings:
        world.append([(round(p[0] - WORLD_ORIGIN_E, 2), round(p[2], 2), round(WORLD_ORIGIN_N - p[1], 2)) for p in ring])
    flat = 0.1
    roof = '1000' if max(p[1] for ring in world for p in ring) - min(p[1] for ring in world for p in ring) <= flat else ''
    polys = []
    min_x = min(p[0] for ring in world for p in ring)
    max_x = max(p[0] for ring in world for p in ring)
    min_z = min(p[2] for ring in world for p in ring)
    max_z = max(p[2] for ring in world for p in ring)
    centre = ((min_x + max_x) / 2, (min_z + max_z) / 2)
    for ring in world:
        # Boden (Fläche 2: Fußabdruck und Grundfläche des Modells)
        ground = [2]
        for x, _, z in ring:
            ground += [x, round(base, 2), z]
        polys.append(ground)
        polys.append([1] + [v for x, y, z in ring for v in (x, y, z)])
        # Wände: eine Fläche je Kante, vom Boden bis zur Dachkante
        n = len(ring)
        for i in range(n):
            x1, y1, z1 = ring[i]
            x2, y2, z2 = ring[(i + 1) % n]
            wall = [0, x1, y1, z1, x2, y2, z2, x2, round(base, 2), z2, x1, round(base, 2), z1]
            if normal_outward(wall, centre) < 0:
                wall = [0, x1, round(base, 2), z1, x2, round(base, 2), z2, x2, y2, z2, x1, y1, z1]
            polys.append(wall)
    key = f'{(centre[0] + GRID_OFFSET) // LOD2_BIN:.0f}_{(centre[1] + GRID_OFFSET) // LOD2_BIN:.0f}'
    unit = {'id': fid, 'fn': fn, 'roof': roof, 'polys': polys}
    index = commune_of(places, centre[0], centre[1]) if places else None
    return {
        'key': key,
        'dir': places[index]['name'] if index is not None else FALLBACK[0],
        'line': json.dumps(unit, separators=(',', ':')),
    }


def take_lod2(east, north, places, seen, lock):
    """Ein Kilometerquadrat Gebäude → data/work/lod2/<Gemeinde>/<Feld>.ndjson.gz."""
    done = os.path.join(LOD2_OUT, '.done', f'fr-{east}_{north}')
    if os.path.exists(done):
        return 0, 0, 0
    bbox = f'{east * 1000},{north * 1000},{(east + 1) * 1000},{(north + 1) * 1000}'
    groups = {}
    buildings = 0
    twice = 0
    for root in wfs_features(BATIMENT, bbox):
        features = root.iter(BD + 'batiment')
        for feature in features:
            buildings += 1
            with lock:
                unit = unit_of(feature, places, seen)
                if unit is None:
                    twice += 1
                    continue
            groups.setdefault((unit['dir'], unit['key']), []).append(unit['line'])
    # (die Quadrate von 2 km teilen sich Nachbarkacheln: angehängte gzip-Teile
    #  liest der Kartenbau als eine Datei)
    written = 0
    with lock:
        for (directory, key), lines in groups.items():
            out_dir = os.path.join(LOD2_OUT, directory)
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, f'{key}.ndjson.gz'), 'ab') as f:
                f.write(gzip.compress(('\n'.join(lines) + '\n').encode('utf-8'), 6, mtime=0))
            written += len(lines)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{east} {north}\n')
    say(f'[fr-suedost] Gebäude {east}_{north}: {buildings} im Dienst, {written} geschrieben, {twice} doppelt')
    return buildings, written, twice


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Ostkilometer UTM32 (176 oder 170..184)')
    ap.add_argument('--north', type=span, required=True, help='Nordkilometer UTM32 (5076 oder 5069..5083)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur Gelände oder nur Gebäude')
    ap.add_argument('--lod2-name', default='Frankreich', help='Verzeichnis für Gebäude außerhalb jeder Gemeinde')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Quadrate gleichzeitig')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Quadrate (zum Probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit ihnen geschieht')
    ap.add_argument('--gaps', help='Datei für die Quadrate, zu denen es keine Daten gab')
    args = ap.parse_args()

    e0, e1 = args.east
    n0, n1 = args.north
    tiles = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    for sub in (DGM_OUT, os.path.join(DGM_OUT, '.done'), LOD2_OUT, os.path.join(LOD2_OUT, '.done'), TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    say(f'[fr-suedost] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {len(tiles)} Quadratkilometer')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[fr-suedost] {args.published}: {len(known)} Kacheln anderer Karten')
    overlap = sorted(f'{e}_{n}' for e, n in tiles if tile_keys(e, n) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Quadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[fr-suedost] {len(overlap)} Quadrate hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))
    if args.on_overlap == 'skip' and overlap:
        skip = set(overlap)
        tiles = [t for t in tiles if f'{t[0]}_{t[1]}' not in skip]

    if args.limit:
        tiles = tiles[: args.limit]
        say(f'[fr-suedost] nur die ersten {len(tiles)} Quadrate (--limit)')

    FALLBACK[0] = args.lod2_name
    started = time.time()
    gaps = []
    counts = {'dgm': 0, 'lod2': 0}
    units = 0

    def elapsed():
        return f'{(time.time() - started) / 60:.0f} min'

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        if args.only != 'lod2':
            jobs = {pool.submit(take_dgm, e, n): (e, n) for e, n in tiles}
            for number, job in enumerate(concurrent.futures.as_completed(jobs), start=1):
                e, n = jobs[job]
                try:
                    size, highest, step = job.result()
                except Exception as exc:  # noqa: BLE001 - ein Quadrat darf den Lauf nicht abbrechen
                    gaps.append(f'{e}_{n}')
                    say(f'[fr-suedost] Gelände {e}_{n}: {exc}')
                    continue
                counts['dgm'] += 1 if size else 0
                if number % 25 == 0 or number == len(jobs):
                    say(f'[fr-suedost] Gelände {number}/{len(jobs)}: {size and highest:.1f} m, Schritt {step} m '
                        f'– {elapsed()}')
        if args.only != 'dgm':
            places = load_communes(e0, e1, n0, n1)
            lock = threading.Lock()
            seen = set()
            jobs = {pool.submit(take_lod2, e, n, places, seen, lock): (e, n) for e, n in tiles}
            for number, job in enumerate(concurrent.futures.as_completed(jobs), start=1):
                e, n = jobs[job]
                try:
                    _, written, _ = job.result()
                except Exception as exc:  # noqa: BLE001
                    gaps.append(f'{e}_{n}')
                    say(f'[fr-suedost] Gebäude {e}_{n}: {exc}')
                    continue
                counts['lod2'] += 1
                units += written
                if number % 25 == 0 or number == len(jobs):
                    say(f'[fr-suedost] Gebäude {number}/{len(jobs)}: {units} Modelle – {elapsed()}')

    say(f'[fr-suedost] fertig: {counts["dgm"]} Quadrate Gelände, {counts["lod2"]} Quadrate Gebäude '
        f'mit {units} Modellen in {elapsed()}')
    if os.path.isdir(LOD2_OUT):
        directories = sorted(d for d in os.listdir(LOD2_OUT) if not d.startswith('.'))
        say(f'[fr-suedost] {len(directories)} Gemeindeverzeichnisse unter data/work/lod2')
    if gaps:
        say(f'[fr-suedost] keine Daten für {len(gaps)} Quadrate: {", ".join(gaps[:8])}')
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
