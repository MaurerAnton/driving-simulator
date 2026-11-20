#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das offene Geobasis NRW – das Geländemodell DGM1 (Rasterweite 1 m, GeoTIFF)
und die Gebäudemodelle LoD2 (CityGML) – für ein Rechteck von Kilometerkacheln
und reduziert beides auf das, was der Kartenbau liest.  Es tut für
Nordrhein-Westfalen, was tools/fetch-geodata.py für Hessen und
tools/fetch-lgln.py für Niedersachsen tut; der Unterschied ist die Quelle:
Geobasis NRW hält jeden Kilometer des Landes in einer eigenen Datei, die ein
Verzeichnis (XML) mit Namen und Größe nennt – ein Rechteck lässt sich also
holen, ohne ein ganzes Bundesland zu laden.

    python3 -I tools/fetch-nrw.py --east 356..357 --north 5645..5646
    python3 -I tools/fetch-nrw.py --east 355..360 --north 5642..5647 --only lod2
    python3 -I tools/fetch-nrw.py --east 355..360 --north 5642..5647 --published map-assets/index.json

--east/--north sind UTM32-Kilometerquadrate (EPSG:25832), dasselbe Raster, nach
dem die Kacheln heißen: 356_5645 ist die Kachel, in der der Kölner Dom steht.
Welche Kacheln es gibt, sagt das Verzeichnis des Landes; Quadrate ohne Gelände
(meist Land eines anderen Bundeslandes im Rechteck) werden am Ende genannt –
die Karte entsteht dort, wo Gelände ist (tools/osm-extract.ts), sie bleiben
also einfach leer.

Gelände:   data/work/dgm2/<E km>_<N km>.dgm – verkleinert von tools/fetch-geodata.py,
           das hier dafür gelesen wird: beide Länder schreiben dann dieselben Bytes
Gebäude:   data/work/lod2/<Gemeinde>/<x>_<z>.ndjson.gz – geschrieben von
           tools/lod2-extract.ts.  Jedes Gebäude trägt in NRW seinen
           Gemeindeschlüssel (<gen:stringAttribute name="Gemeindeschluessel">);
           der Name dazu kommt aus dem WFS des Landes (dvg:nw_dvg1_gem), damit
           der Ordner so heißt wie die Gemeinde in OpenStreetMap – nur dann
           findet tools/build-graph.ts die Modelle und setzt lod2: true.
           Mit --lod2-name <Name> gehen stattdessen alle Gebäude in einen
           einzigen Ordner dieses Namens.

--published <map-assets/index.json> verhindert, dass diese Karte eine Kachel
von 500 m deckt, die schon eine andere Karte hat: im Verzeichnis der Teile
gehört ein Kachelschlüssel zu einer Karte.  Jedes Kilometerquadrat, das der
genannte Index schon kennt, bleibt weg (mit --on-overlap fail bricht das
Skript ab und nennt sie).

Gebraucht werden Python 3 (numpy und Pillow kommen über tools/fetch-geodata.py
herein), curl und node.  Was schon da ist, wird übersprungen, der Befehl kann
also nach einer Unterbrechung wiederholt werden.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py als Modul: sein reduce_tile schreibt das Gelände eines Landes – es schreibt unseres mit."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# Geobasis NRW – Datenlizenz Deutschland - Zero - Version 2.0, kein Schlüssel nötig.
#   "Geobasis NRW stellt diese Daten unter der Datenlizenz Deutschland - Zero - Version 2.0
#    bereit; jede Nutzung ist ohne Einschränkungen oder Bedingungen zulässig."
OPEN = 'https://www.opengeodata.nrw.de/produkte/geobasis/'
DIR = {'dgm': 'hm/dgm1_tiff/dgm1_tiff/', 'lod2': '3dg/lod2_gml/lod2_gml/'}
# dgm1_32_356_5645_1_nw_2022.tif (das Jahr wechselt von Kachel zu Kachel, daher steht es hier nicht fest)
# LoD2_32_356_5645_1_NW.gml
FILE = {
    'dgm': re.compile(r'^dgm1_32_(\d+)_(\d+)_1_nw_\d{4}\.tif$'),
    'lod2': re.compile(r'^LoD2_32_(\d+)_(\d+)_1_NW\.gml$'),
}
# eine Kachel ohne Gebäude ist nur der Kopf der Datei (1553 B bei der Suche 2026-11)
EMPTY_GML = 4096
# die Gemeindenamen zu den Gemeindeschlüsseln (Verwaltungsgebiete, Stand von heute)
WFS = 'https://www.wfs.nrw.de/geobasis/wfs_nw_dvg'
CACHE = os.path.join(ROOT, 'data/work/nrw')

# der Rahmen der Karte (src/geo/utm.ts) und ihr Raster von Kacheln zu 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000
MEMBER = re.compile(rb'<core:cityObjectMember>.*?</core:cityObjectMember>', re.S)
AGS = re.compile(rb'name="Gemeindeschluessel">\s*<gen:value>(\d+)')

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'356..359' → (356, 359); '356' → (356, 356)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'kein Bereich von Kilometern: {text}')
    return tuple(values)


def tile_keys(east, north):
    """Die vier Kacheln von 500 m, die ein Kilometerquadrat deckt, so benannt wie map-assets ('434_363')."""
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
                return r.read()
        except Exception as e:  # noqa: BLE001 - jedes Netzleiden: warten und noch einmal
            if attempt == attempts - 1:
                raise
            say(f'[nrw] {e}; noch einmal')
            time.sleep(5 * (attempt + 1))
    return b''


def index_of(product):
    """Das Verzeichnis des Landes: Kilometerkachel → (Dateiname, Größe), in data/work/nrw zwischengespeichert."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'{product}-index.xml')
    if not os.path.exists(cache):
        say(f'[nrw] Verzeichnis der {product}-Kacheln von opengeodata.nrw.de holen')
        curl_to(f'{OPEN}{DIR[product]}index.xml', cache + '.tmp')
        os.replace(cache + '.tmp', cache)
    with open(cache, 'rb') as f:
        text = f.read()
    found = {}
    for name, size in re.findall(rb'<file name="([^"]+)" size="(\d+)"', text):
        m = FILE[product].match(name.decode())
        if m:
            key = (int(m.group(1)), int(m.group(2)))
            found[key] = (name.decode(), int(size))
    return found


def municipalities(e0, e1, n0, n1):
    """Gemeindeschlüssel → Name für das Rechteck, aus dem WFS des Landes (EPSG:25832)."""
    query = urllib.parse.urlencode({
        'SERVICE': 'WFS',
        'VERSION': '1.1.0',
        'REQUEST': 'GetFeature',
        'TYPENAME': 'dvg:nw_dvg1_gem',
        'SRSNAME': 'EPSG:25832',
        'BBOX': f'{e0 * 1000},{n0 * 1000},{(e1 + 1) * 1000},{(n1 + 1) * 1000},EPSG:25832',
    })
    text = ask(f'{WFS}?{query}').decode('utf-8', 'replace')
    found = {}
    for block in re.finditer(r'<gml:featureMember>.*?</gml:featureMember>', text, re.S):
        body = block.group(0)
        ags = re.search(r'<dvg:KN>(\d+)</dvg:KN>', body)
        name = re.search(r'<dvg:GN>(.*?)</dvg:GN>', body, re.S)
        if ags and name:
            found[ags.group(1)] = name.group(1).strip()
    return found


def curl_to(url, dest, attempts=6):
    """Mit curl herunterladen (eine halbe Datei wird fortgesetzt)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(attempts):
        code = subprocess.call(
            ['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30', '-o', dest, url]
        )
        if code == 0:
            return
        # 33: der Server setzt nicht fort – von vorn
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[nrw] curl endete mit {code} für {os.path.basename(dest)}; noch einmal')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'nicht heruntergeladen: {url}')


def take_dgm(name_and_size, east, north, tmp):
    """Ein GeoTIFF → data/work/dgm2/<E>_<N>.dgm, verkleinert wie tools/fetch-geodata.py es tut."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(f'{OPEN}{DIR["dgm"]}{name_and_size[0]}', tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    blob = GD.reduce_tile(data)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def split_lod2(name_and_size, east, north, parts):
    """Ein CityGML → Stücke je Gemeinde nach data/raw/tmp/nrw-lod2/<Schlüssel>.gml (weiter unten nach node)."""
    done = os.path.join(GD.LOD2_OUT, '.done', f'nrw-{east}_{north}')
    if os.path.exists(done):
        return None
    tmp = os.path.join(GD.TMP, f'nrw-lod2-{east}_{north}.gml')
    curl_to(f'{OPEN}{DIR["lod2"]}{name_and_size[0]}', tmp)
    if os.path.getsize(tmp) < EMPTY_GML:
        # Kacheln ohne ein Gebäude (Wald, Acker, Rhein): der Kopf allein
        os.remove(tmp)
        os.makedirs(os.path.dirname(done), exist_ok=True)
        with open(done, 'w') as f:
            f.write(f'{east}_{north}: keine Gebäude\n')
        return 0
    with open(tmp, 'rb') as f:
        text = f.read()
    head = text.find(b'<core:cityObjectMember>')
    if head < 0:
        os.remove(tmp)
        with open(done, 'w') as f:
            f.write(f'{east}_{north}: keine Gebäude\n')
        return 0
    head_file = os.path.join(parts, 'head.xml')
    if not os.path.exists(head_file):
        with open(head_file + '.tmp', 'wb') as f:
            f.write(text[:head])
        os.replace(head_file + '.tmp', head_file)
    handles = {}
    count = 0
    for m in MEMBER.finditer(text):
        ags = AGS.search(m.group(0))
        key = (ags.group(1).decode() if ags else 'ohne').replace('/', '_')
        handle = handles.get(key)
        if handle is None:
            handle = handles[key] = open(os.path.join(parts, f'{key}.gml'), 'ab')
        handle.write(m.group(0))
        count += 1
    for handle in handles.values():
        handle.close()
    os.remove(tmp)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{east}_{north}: {count} Gebäude\n')
    return count


def feed_lod2(name, part_files, tiles):
    """Alle Stücke einer Gemeinde in einem Lauf an tools/lod2-extract.ts geben:
    der Löscht seinen Ausgabeordner bei jedem Aufruf, ein zweiter Lauf nähme dem ersten alles weg."""
    marker = os.path.join(GD.LOD2_OUT, '.done', f'nrw-lod2-{name.replace("/", "_")}')
    if os.path.exists(marker):
        with open(marker) as f:
            if f.read().strip() == ' '.join(tiles):
                return 0
    say(f'[nrw] {name}: {len(part_files)} Stück(e) aus {len(tiles)} Kacheln an tools/lod2-extract.ts')
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', name, '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    written = 0
    sources = [os.path.join(os.path.dirname(part_files[0]), 'head.xml')] + list(part_files)
    for path in sources:
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                node.stdin.write(chunk)
                written += len(chunk)
    node.stdin.write(b'</core:CityModel>\n')
    node.stdin.close()
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts scheiterte an {name}')
    with open(marker, 'w') as f:
        f.write(' '.join(tiles))
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometer nach Osten, UTM32 (356 oder 356..359)')
    ap.add_argument('--north', type=span, required=True, help='Kilometer nach Norden, UTM32 (5645 oder 5643..5646)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur das Gelände oder nur die Gebäude')
    ap.add_argument('--lod2-name', default='', help='alle Gebäude in diesen einen Ordner statt je Gemeinde')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Kacheln gleichzeitig geholt werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kacheln (um den Weg erst zu probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit diesen Kacheln geschieht')
    ap.add_argument('--gaps', help='in diese Datei die Kilometerquadrate schreiben, für die das Land nichts hat')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    parts = os.path.join(GD.TMP, 'nrw-lod2')
    os.makedirs(parts, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    tiles = [f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    say(f'[nrw] {e0}..{e1} km Ost, {n0}..{n1} km Nord – {len(tiles)} Kacheln zu 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[nrw] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(t for t in tiles if tile_keys(*(int(v) for v in t.split('_'))) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerquadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[nrw] {len(overlap)} Kilometerquadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    products = ['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']
    started = time.time()
    gaps = []
    lod2_tiles = []

    for product in products:
        index = index_of(product)
        work = []
        for tile in tiles:
            e, n = (int(v) for v in tile.split('_'))
            if tile in skip:
                continue
            if (e, n) in index:
                work.append((e, n, index[(e, n)]))
            else:
                gaps.append(f'{product} {tile}')
        if args.limit:
            work = work[: args.limit]
        say(f'[nrw] {product}: {len(work)} Kacheln ({sum(w[2][1] for w in work) / 1048576:.0f} MB nach dem Verzeichnis)')

        def one(item):
            e, n, name_and_size = item
            if product == 'dgm':
                return take_dgm(name_and_size, e, n, os.path.join(GD.TMP, f'nrw-dgm-{e}_{n}.tif'))
            return split_lod2(name_and_size, e, n, parts)

        done = 0
        wrote = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for result in pool.map(one, work):
                done += 1
                wrote += result or 0
                if done % 10 == 0 or done == len(work):
                    say(f'[nrw] {product} {done}/{len(work)} – {(time.time() - started) / 60:.0f} min bis hier')
        if product == 'dgm':
            say(f'[nrw] Gelände: {len(work)} Kacheln, {wrote / 1048576:.1f} MB verkleinert in {(time.time() - started) / 60:.0f} min')
        else:
            lod2_tiles = [f'{e}_{n}' for e, n, _ in work]
            say(f'[nrw] Gebäude: {len(work)} Kacheln zerlegt ({wrote} Gebäude) in {(time.time() - started) / 60:.0f} min')

    if 'lod2' in products:
        keys = sorted(f[: -len('.gml')] for f in os.listdir(parts) if f.endswith('.gml'))
        done_tiles = sorted(
            f[4:] for f in os.listdir(os.path.join(GD.LOD2_OUT, '.done'))
            if f.startswith('nrw-') and not f.startswith('nrw-lod2-')
        )
        names = {} if args.lod2_name else municipalities(e0, e1, n0, n1)
        say(f'[nrw] der WFS nennt {len(names)} Gemeinden im Rechteck')
        groups = {}
        for key in keys:
            # ein Rechteck kann mehrere Male geholt worden sein; jedes Stück zählt einmal
            group = args.lod2_name or names.get(key, '')
            if not group:
                group = f'NRW-{key}'
                say(f'[nrw] kein Gemeindename für Schlüssel {key}: die Gebäude gehen nach {group}')
            groups.setdefault(group, []).append(os.path.join(parts, f'{key}.gml'))
        for group, files in sorted(groups.items()):
            feed_lod2(group, sorted(files), done_tiles)

    if gaps:
        say(f'[nrw] das Land hat für {len(gaps)} Quadrate nichts'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    say(f'[nrw] fertig in {(time.time() - started) / 60:.0f} min')
    return 0


if __name__ == '__main__':
    sys.exit(main())
