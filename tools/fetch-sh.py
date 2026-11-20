#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt die offenen Geobasisdaten des Landesamtes für Vermessung und Geoinformation
Schleswig-Holstein (LVermGeo SH) – Geländemodell DGM1 und 3D-Gebäudemodell LoD2,
Lizenz CC BY 4.0, Quellenvermerk „© GeoBasis-DE/LVermGeo SH/CC BY 4.0" – und bringt
sie in die Form, die der Kartenbau liest.  Es tut für dieses Land, was
tools/fetch-geodata.py für Hessen tut.

    python3 -I tools/fetch-sh.py --east 573..574 --north 6019..6020
    python3 -I tools/fetch-sh.py --east 570..578 --north 6015..6027 --only dgm
    python3 -I tools/fetch-sh.py --east 570..578 --north 6015..6027 --published index.json

--east/--north sind Kilometerquadrate in UTM32 (EPSG:25832), dasselbe Gitter, nach dem
die Kacheln des Landes benannt sind: 573_6020 ist das Quadrat mit der Kieler Innenstadt
(Rathaus: E 573853, N 6020021).  Welche Quadrate das Land hat, sagt sein Kachelindex;
Quadrate ohne Daten (meist Wasserflächen ohne Gebäude) werden am Ende aufgeführt – die
Karte entsteht nur, wo Gelände liegt (tools/osm-extract.ts), jene Quadrate bleiben
also einfach leer.

Gelände:   data/work/dgm2/<E km>_<N km>.dgm – vermindert von tools/fetch-geodata.py,
           das hierfür eingelesen wird: beide Länder schreiben dann dieselben Bytes
Gebäude:   data/work/lod2/<name>/<x>_<z>.ndjson.gz – geschrieben von tools/lod2-extract.ts

Der Weg: das Downloadportal (geodaten.schleswig-holstein.de/gaialight-sh) hält je
Produkt eine GeoJSON-Datei „Massendownload" mit allen Kacheln des Landes und einem
direkten Verweis pro Kachel – 18 685 Kacheln Gelände, 13 805 Kacheln Gebäude (Stand
November 2026).  Darin steht zu jedem Kilometerquadrat der Link auf seine Datei: eine
XYZ-Punktreihe (1 m Gitter, ~28 MB) bzw. eine CityGML-Datei (~5…30 MB).  Ein Schlüssel
oder eine Anmeldung ist nicht nötig.

--published <map-assets/index.json> hält diese Karte davon ab, ein Quadrat zu holen, das
eine andere Karte schon hat: zwei Karten dürfen keine Kachel von 500 m gemeinsam haben,
denn im Index der Teile gehört ein Kachelschlüssel zu einer Karte.  Jedes Quadrat, das
der genannte Index schon kennt, bleibt aus (mit --on-overlap fail stattdessen ein Abbruch).

Braucht Python 3 (numpy und Pillow kommen über tools/fetch-geodata.py herein), curl und
node.  Was schon da ist, wird übersprungen, der Befehl kann nach einem Abbruch also
wiederholt werden.
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
    """tools/fetch-geodata.py als Modul: sein reduce_tile schreibt das Gelände eines Landes – es schreibt unseres mit."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# das Portal der offenen Geobasisdaten (kein Schlüssel, keine Anmeldung):
#   dladownload/dl-dgm1.html -> DGM1_SH__Massendownload.geojson, dl-lod2.html -> LOD2_SH_Massendownload.geojson
PORTAL = 'https://geodaten.schleswig-holstein.de/gaialight-sh/_apps/dladownload'
INDEX = {
    'dgm': PORTAL + '/single.php?file=DGM1_SH__Massendownload.geojson&id=4',
    'lod2': PORTAL + '/single.php?file=LOD2_SH_Massendownload.geojson&id=4',
}
LINK_FIELD = {'dgm': 'link_data', 'lod2': 'data_link'}
# dgm1_32_573_6020_1_sh_2023.xyz bzw. LoD2_32_573_6020_1_SH.xml
KACHEL = {
    'dgm': re.compile(r'dgm1_32_(\d+)_(\d+)_1_sh', re.IGNORECASE),
    'lod2': re.compile(r'lod2_32_(\d+)_(\d+)_1_sh', re.IGNORECASE),
}
CACHE = os.path.join(ROOT, 'data/work/sh')

# der Rahmen der Karte (src/geo/utm.ts) und ihr Gitter aus Kacheln von 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'573..578' → (573, 578); '573' → (573, 573)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'kein Bereich von Kilometern: {text}')
    return tuple(values)


def tile_keys(east, north):
    """Die vier Kacheln von 500 m, die ein Kilometerquadrat abdeckt, so benannt wie map-assets es tut ('434_363')."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def kacheln(product):
    """Der Index des Landes: {(E km, N km): Verweis auf die Datei} – einmal geholt, dann zwischengespeichert."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'{product}.geojson')
    if not os.path.exists(cache):
        say(f'[sh] Kachelindex {product} holen ({INDEX[product].split("file=")[1].split("&")[0]})')
        request = urllib.request.Request(INDEX[product], headers={'User-Agent': AGENT})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=600) as r:
                    blob = r.read()
                break
            except Exception as e:  # noqa: BLE001 - Netzärger aller Art: warten und noch einmal
                if attempt == 4:
                    raise
                say(f'[sh] {e}; noch einmal')
                time.sleep(5 * (attempt + 1))
        with open(cache + '.tmp', 'wb') as f:
            f.write(blob)
        os.replace(cache + '.tmp', cache)
    with open(cache) as f:
        dokument = json.load(f)
    found = {}
    for feature in dokument['features']:
        eigenschaften = feature['properties']
        link = eigenschaften.get(LINK_FIELD[product]) or eigenschaften.get('link_data')
        if not link:
            continue
        m = KACHEL[product].search(link)
        if m:
            found[(int(m.group(1)), int(m.group(2)))] = link
    say(f'[sh] Index {product}: {len(found)} Kacheln von einem Kilometer')
    return found


def curl_to(url, dest, attempts=6):
    """Mit curl herunterladen (setzt eine halbe Datei fort)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(attempts):
        code = subprocess.call(
            [
                'curl', '-fsSL', '--compressed', '-A', AGENT, '-C', '-',
                '--retry', '3', '--connect-timeout', '30', '-o', dest, url,
            ]
        )
        if code == 0:
            return
        # 33: der Server will nicht fortsetzen – von vorn
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[sh] curl endete mit {code} für {os.path.basename(dest)}; noch einmal')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'nicht heruntergeladen: {url}')


def xyz_to_tiff(data, east, north):
    """Die Punktreihen eines Kilometerquadrats → ein GeoTIFF von 1000 × 1000 Höhen in Metern.

    Jede Zeile beginnt an der Nordwestecke, der Ostwert wächst in der Zeile, der Nordwert
    fällt von Zeile zu Zeile – tools/mapgen/dgm.ts sagt dasselbe andersherum (Zeile 0 einer
    Kachel ist ihr Nordrand).  So wie tools/fetch-bw.py es für Baden-Württemberg tut.
    """
    import numpy as np
    from PIL import Image

    try:
        flat = np.fromstring(data, sep=' ')  # drei Zahlen je Punkt: Ost, Nord, Höhe
    except AttributeError:  # numpy ohne fromstring: selbst zerlegen
        try:
            flat = np.array(data.split(), dtype=np.float64)
        except TypeError:
            flat = np.array(data.decode('ascii', 'replace').split(), dtype=np.float64)
    points = flat.reshape(-1, 3)
    grid = np.zeros((1000, 1000), np.float32)
    rows = np.rint((north + 1) * 1000 - 0.5 - points[:, 1]).astype(np.intp)
    cols = np.rint(points[:, 0] - (east * 1000 + 0.5)).astype(np.intp)
    inside = (rows >= 0) & (rows < 1000) & (cols >= 0) & (cols < 1000)
    grid[rows[inside], cols[inside]] = points[inside, 2]
    holes = 1000 * 1000 - int(inside.sum())
    if holes:
        say(f'[sh] Gelände {east}_{north}: {holes} von 1000000 Zellen von 1 m ohne Höhe')
    out = io.BytesIO()
    Image.fromarray(grid, mode='F').save(out, format='TIFF')
    return out.getvalue()


def take_dgm(url, east, north, tmp):
    """Eine XYZ-Datei → data/work/dgm2/<E>_<N>.dgm, vermindert wie in Hessen."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    curl_to(url, tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    blob = GD.reduce_tile(xyz_to_tiff(data, east, north))
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def take_lod2(url, east, north, name, tmp):
    """Eine CityGML-Datei → ein Staging-Verzeichnis für sich, gelesen von tools/lod2-extract.ts.

    Der Name trägt die Kachel, denn tools/lod2-extract.ts leert das Verzeichnis, in das es
    schreibt (rmSync in Zeile 176): je Kachel mit demselben Namen gerufen bliebe nur die
    letzte.  Der Punkt davor hält den Kartenbau davon ab, das Staging-Verzeichnis
    mitzulesen; merge_lod2() setzt die Kacheln danach zusammen.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
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
        raise RuntimeError(f'tools/lod2-extract.ts scheiterte an {name} {east}_{north}')
    os.remove(tmp)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {east}_{north}\n')
    return 1


def merge_lod2(name):
    """Die Quadrate von 2 km aller Kacheln in data/work/lod2/<name> zusammenfügen.

    Jede Kachel schrieb in ein Staging-Verzeichnis für sich; benachbarte Kacheln teilen
    Quadrate, und ein Quadrat ist eine Datei voller Zeilen – mehr ist nicht zu tun, als die
    Dateien aneinanderzuhängen (eine gzip-Datei darf mehrere Glieder hintereinander halten).
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
    say(f'[sh] Gebäude aus {len(staging)} Kacheln zusammengefügt: {len(os.listdir(final))} Quadrate von 2 km, '
        f'{units} Einheiten in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometerquadrate nach Osten, UTM32 (573 oder 573..578)')
    ap.add_argument('--north', type=span, required=True, help='Kilometerquadrate nach Norden, UTM32 (6019 oder 6015..6027)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='nur das Gelände oder nur die Gebäude')
    ap.add_argument('--lod2-name', default='Schleswig-Holstein', help='Verzeichnis unter data/work/lod2, in das die Gebäude kommen')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Kacheln zugleich geholt werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kacheln (um den Weg erst zu probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit jenen Quadraten geschieht')
    ap.add_argument('--gaps', help='die Quadrate ohne Daten des Landes in diese Datei schreiben')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[sh] Ost {e0}..{e1} km, Nord {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} Kacheln von 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[sh] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerquadrate hat eine andere Karte schon, z. B. {overlap[:5]}')
        say(f'[sh] {len(overlap)} Kilometerquadrate hat eine andere Karte schon: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    gaps = []
    for product in (['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']):
        index = kacheln(product)
        wanted = [
            (e, n)
            for e in range(e0, e1 + 1)
            for n in range(n0, n1 + 1)
            if f'{e}_{n}' not in skip
        ]
        for e, n in wanted:
            if (e, n) in index:
                work.append((product, e, n, index[(e, n)]))
            elif product == 'dgm':
                gaps.append(f'{e}_{n}')
        say(f'[sh] {product}: {sum(1 for w in work if w[0] == product)} Kacheln zu holen'
            + (f', {len(gaps)} Quadrate ohne Gelände' if product == 'dgm' and gaps else ''))

    if args.limit:
        work = work[: args.limit]
        say(f'[sh] nur die ersten {len(work)} davon (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}

    def one(item):
        product, e, n, url = item
        tmp = os.path.join(GD.TMP, f'sh-{product}-{e}_{n}')
        if product == 'dgm':
            made = take_dgm(url, e, n, tmp + '.xyz')
        else:
            made = take_lod2(url, e, n, args.lod2_name, tmp + '.xml')
        return product, e, n, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, e, n, made = item
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done % 10 == 0 or done == len(work):
                say(f'[sh] {done}/{len(work)}: {counts["dgm"]} Gelände, {counts["lod2"]} Gebäude '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    say(f'[sh] fertig: {counts["dgm"]} Kacheln Gelände ({again["dgm"]} waren schon da), '
        f'{counts["lod2"]} Kacheln Gebäude ({again["lod2"]} waren schon da) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[sh] kein Gelände von Schleswig-Holstein für {len(gaps)} Kilometerquadrate '
            f'(dort bleibt die Karte aus)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
