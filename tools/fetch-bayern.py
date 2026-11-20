#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt die offenen Geodaten der Bayerischen Vermessungsverwaltung – das Geländemodell
DGM1 (Rasterweite 1 m, GeoTIFF) und die Gebäudemodelle LoD2 (CityGML) – für ein
Rechteck von Kilometerkacheln und reduziert beides auf das, was der Kartenbau
liest.  Es tut für Bayern, was tools/fetch-nrw.py für Nordrhein-Westfalen und
tools/fetch-geodata.py für Hessen tun.

    python3 -I tools/fetch-bayern.py --east 690..694 --north 5334..5338
    python3 -I tools/fetch-bayern.py --east 690..694 --north 5334..5338 --only dgm
    python3 -I tools/fetch-bayern.py --east 690..694 --north 5334..5338 --published map-assets/index.json

Quelle ist der offene Bereich der BayernWolke, ohne Anmeldung und ohne Schlüssel
(Lizenz der Produkte: Creative Commons Namensnennung 4.0, siehe
https://geodaten.bayern.de/opengeodata/):

    https://download1.bayernwolke.de/a/dgm/dgm1/<E>_<N>.tif     1 km-Kachel
    https://download1.bayernwolke.de/a/lod2/citygml/<E>_<N>.gml  2 km-Kachel

Jede Kachel liegt unter ihrem eigenen Namen; es gibt kein Verzeichnis mit
Namen und Größe, sondern nur den Versuch: eine Kachel, die das Land nicht hat,
antwortet mit 404 und wird am Ende als Lücke genannt.

--east/--north sind UTM32-Kilometerquadrate (EPSG:25832), dasselbe Raster, nach
dem die Kacheln heißen: 691_5334 ist die Kachel mit dem Marienplatz.  Bayern
östlich von 12° Ost liegt in UTM-Zone 33 und heißt dort anders – dieses Skript
bleibt westlich davon.  Welche Quadrate ohne Gelände sind (meist Land eines
anderen Bundeslandes im Rechteck), wird genannt; die Karte entsteht dort, wo
Gelände ist (tools/osm-extract.ts), sie bleiben also einfach leer.

Gelände:   data/work/dgm2/<E km>_<N km>.dgm – verkleinert von tools/fetch-geodata.py,
           das hier dafür gelesen wird: beide Länder schreiben dann dieselben Bytes
Gebäude:   data/work/lod2/<Gemeinde>/<x>_<z>.ndjson.gz – geschrieben von
           tools/lod2-extract.ts.  Jedes Gebäude trägt in Bayern seinen
           Gemeindeschlüssel (<gen:stringAttribute name="Gemeindeschluessel">);
           der Name dazu kommt aus dem Verzeichnis des Landes (gemeinde.kml
           desselben Produkts), damit der Ordner so heißt wie die Gemeinde in
           OpenStreetMap – nur dann findet tools/build-graph.ts die Modelle und
           setzt lod2: true.  Mit --lod2-name <Name> gehen stattdessen alle
           Gebäude in einen einzigen Ordner dieses Namens.

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
import urllib.error
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
# die offenen Geodaten der Bayerischen Vermessungsverwaltung, BayernWolke
OPEN = 'https://download1.bayernwolke.de/a/'
DGM = OPEN + 'dgm/dgm1/{e}_{n}.tif'
LOD2 = OPEN + 'lod2/citygml/{e}_{n}.gml'
# Verzeichnis der Gemeinden desselben Produkts: Gemeindeschlüssel → Name
KML = 'https://geodaten.bayern.de/odd/a/lod2/citygml/meta/kml/gemeinde.kml'
CACHE = os.path.join(ROOT, 'data/work/bayern')

# der Rahmen der Karte (src/geo/utm.ts) und ihr Raster von Kacheln zu 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000
# Bayern ist CityGML 1.0: die Mitglieder heißen (ohne Namensraum davor) <cityObjectMember>
MEMBER = re.compile(rb'<cityObjectMember>.*?</cityObjectMember>', re.S)
AGS = re.compile(rb'name="Gemeindeschluessel">\s*<gen:value>\s*(\d+)', re.S)
META4 = re.compile(r'/metalink/(\d+)\.meta4')

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'690..694' → (690, 694); '690' → (690, 690)"""
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


def head(url, attempts=4):
    """Was der Server über die Datei sagt: ihre Größe in Bytes oder None, wenn es sie nicht gibt."""
    request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as r:
                length = r.headers.get('Content-Length') or ''
                return int(length) if length.isdigit() else 0
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == attempts - 1:
                raise
            say(f'[bayern] {e.code} bei {os.path.basename(url)}; noch einmal')
            time.sleep(5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001 - jedes Netzleiden: warten und noch einmal
            if attempt == attempts - 1:
                raise
            say(f'[bayern] {e}; noch einmal')
            time.sleep(5 * (attempt + 1))
    return None


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
        say(f'[bayern] curl endete mit {code} für {os.path.basename(dest)}; noch einmal')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'nicht heruntergeladen: {url}')


def municipalities():
    """Gemeindeschlüssel → Name, aus gemeinde.kml des Landes (dasselbe Produkt wie die Gebäude)."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, 'gemeinde.kml')
    if not os.path.exists(cache):
        say('[bayern] Verzeichnis der Gemeinden von geodaten.bayern.de holen')
        curl_to(KML, cache + '.tmp')
        os.replace(cache + '.tmp', cache)
    with open(cache, 'rb') as f:
        text = f.read().decode('utf-8', 'replace')
    found = {}
    for block in re.finditer(r'(?s)<Placemark>.*?</Placemark>', text):
        body = block.group(0)
        name = re.search(r'<name>(.*?)</name>', body, re.S)
        ags = META4.search(body)
        if name and ags:
            found[ags.group(1)] = name.group(1).strip()
    return found


def take_dgm(east, north, tmp):
    """Ein GeoTIFF → data/work/dgm2/<E>_<N>.dgm, verkleinert wie tools/fetch-geodata.py es tut."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(DGM.format(e=east, n=north), tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    blob = GD.reduce_tile(data)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def split_lod2(east, north, parts):
    """Ein CityGML → Stücke je Gemeinde nach data/raw/tmp/bayern-lod2/<Schlüssel>.gml (weiter unten nach node)."""
    done = os.path.join(GD.LOD2_OUT, '.done', f'bayern-{east}_{north}')
    if os.path.exists(done):
        return None
    tmp = os.path.join(GD.TMP, f'bayern-lod2-{east}_{north}.gml')
    curl_to(LOD2.format(e=east, n=north), tmp)
    with open(tmp, 'rb') as f:
        text = f.read()
    start = text.find(b'<cityObjectMember>')
    if start < 0:
        os.remove(tmp)
        os.makedirs(os.path.dirname(done), exist_ok=True)
        with open(done, 'w') as f:
            f.write(f'{east}_{north}: keine Gebäude\n')
        return 0
    head_file = os.path.join(parts, 'head.xml')
    if not os.path.exists(head_file):
        with open(head_file + '.tmp', 'wb') as f:
            f.write(text[:start])
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
    marker = os.path.join(GD.LOD2_OUT, '.done', f'bayern-lod2-{name.replace("/", "_")}')
    wanted = ' '.join(tiles)
    if os.path.exists(marker):
        with open(marker) as f:
            if f.read().strip() == wanted:
                return 0
    say(f'[bayern] {name}: {len(part_files)} Stück(e) aus {len(tiles)} Kacheln an tools/lod2-extract.ts')
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
    node.stdin.write(b'</CityModel>\n')
    node.stdin.close()
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts scheiterte an {name}')
    with open(marker, 'w') as f:
        f.write(wanted)
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometer nach Osten, UTM32 (690 oder 690..694)')
    ap.add_argument('--north', type=span, required=True, help='Kilometer nach Norden, UTM32 (5334 oder 5334..5338)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur das Gelände oder nur die Gebäude')
    ap.add_argument('--lod2-name', default='', help='alle Gebäude in diesen einen Ordner statt je Gemeinde')
    ap.add_argument('--jobs', type=int, default=3, help='wie viele Kacheln gleichzeitig geholt werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kacheln (um den Weg erst zu probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit diesen Kacheln geschieht')
    ap.add_argument('--gaps', help='in diese Datei die Kilometerquadrate schreiben, für die das Land nichts hat')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    parts = os.path.join(GD.TMP, 'bayern-lod2')
    os.makedirs(parts, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[bayern] {e0}..{e1} km Ost, {n0}..{n1} km Nord – {(e1 - e0 + 1) * (n1 - n0 + 1)} Quadratkilometer')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[bayern] {args.published}: {len(known)} Kacheln anderer Karten')

    tiles = [f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    overlap = sorted(t for t in tiles if tile_keys(*(int(v) for v in t.split('_'))) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerquadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[bayern] {len(overlap)} Kilometerquadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    started = time.time()
    gaps = []
    lod2_tiles = []

    if args.only != 'lod2':
        work = []
        for tile in tiles:
            if tile in skip:
                continue
            e, n = (int(v) for v in tile.split('_'))
            size = head(DGM.format(e=e, n=n))
            if size is None:
                gaps.append(f'dgm {tile}')
            else:
                work.append((e, n, size))
        if args.limit:
            work = work[: args.limit]
        say(f'[bayern] Gelände: {len(work)} Kacheln, {sum(w[2] for w in work) / 1048576:.0f} MB')

        def one_dgm(item):
            e, n, _ = item
            return take_dgm(e, n, os.path.join(GD.TMP, f'bayern-dgm-{e}_{n}.tif'))

        done = 0
        wrote = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for result in pool.map(one_dgm, work):
                done += 1
                wrote += result
                if done % 10 == 0 or done == len(work):
                    say(f'[bayern] Gelände {done}/{len(work)} – {(time.time() - started) / 60:.0f} min bis hier')
        say(f'[bayern] Gelände: {wrote / 1048576:.1f} MB verkleinert in {(time.time() - started) / 60:.0f} min')

    if args.only != 'dgm':
        # die Gebäudemodelle liegen in Kacheln von 2 km: nur gerade Kilometer haben eine Datei
        work = []
        for e in range(e0 - e0 % 2, e1 + 1, 2):
            for n in range(n0 - n0 % 2, n1 + 1, 2):
                tile = f'{e}_{n}'
                if tile in skip:
                    continue
                size = head(LOD2.format(e=e, n=n))
                if size is None:
                    gaps.append(f'lod2 {tile}')
                else:
                    work.append((e, n, size))
        say(f'[bayern] Gebäude: {len(work)} Kacheln zu 2 km, {sum(w[2] for w in work) / 1048576:.0f} MB')

        def one_lod2(item):
            e, n, _ = item
            return split_lod2(e, n, parts)

        done = 0
        wrote = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.jobs, 2)) as pool:
            for result in pool.map(one_lod2, work):
                done += 1
                wrote += result or 0
                say(f'[bayern] Gebäude {done}/{len(work)} – {wrote} Gebäude, {(time.time() - started) / 60:.0f} min bis hier')
        lod2_tiles = [f'{e}_{n}' for e, n, _ in work]
        say(f'[bayern] Gebäude: {len(work)} Kacheln zerlegt in {(time.time() - started) / 60:.0f} min')

        keys = sorted(f[: -len('.gml')] for f in os.listdir(parts) if f.endswith('.gml'))
        names = {} if args.lod2_name else municipalities()
        say(f'[bayern] das Verzeichnis des Landes nennt {len(names)} Gemeinden')
        groups = {}
        for key in keys:
            # ein Rechteck kann mehrere Male geholt worden sein; jedes Stück zählt einmal
            group = args.lod2_name or names.get(key, '')
            if not group:
                group = f'BY-{key}'
                say(f'[bayern] kein Gemeindename für Schlüssel {key}: die Gebäude gehen nach {group}')
            groups.setdefault(group, []).append(os.path.join(parts, f'{key}.gml'))
        for group, files in sorted(groups.items()):
            feed_lod2(group, sorted(files), lod2_tiles)

    if gaps:
        say(f'[bayern] das Land hat für {len(gaps)} Quadrate nichts'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    say(f'[bayern] fertig in {(time.time() - started) / 60:.0f} min')
    return 0


if __name__ == '__main__':
    sys.exit(main())
