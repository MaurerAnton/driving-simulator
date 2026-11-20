#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das offene Gelände Norwegens – die Nasjonale høydemodell (NHM) DTM 1 m von
Kartverket – und schreibt es so hin, wie der Kartenbau es liest.

Im Gegensatz zu den deutschen Ländern gibt es hier keine Gebäudemodelle: FKB-Bygning
steht unter der „Norge digitalt-lisens" und ist nur für Vertragspartner (Kartkatalogen
https://kartkatalog.geonorge.no/metadata/fkb-bygning/8b4304ea-4fb0-479c-a24d-fa225e2c6e97:
„Bruksbegrensninger: Nedlasting av data begrenset til Norge digitalt avtaleparter.").
Die Karte entsteht also aus Gelände plus den aus OpenStreetMap-Fußabdrücken extrudierten
Gebäuden – ein brauchbares Ergebnis, und so gewollt.

Quelle ist der Web Coverage Service von Geonorge, ohne Anmeldung und ohne Schlüssel
(GetCapabilities antwortet „<fees>free</fees>" und
„<accessConstraints>None</accessConstraints>"):

    https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833?service=WCS&version=1.0.0
      &request=GetCoverage&coverage=nhm_dtm_topo_25833&crs=EPSG:25832
      &response_crs=EPSG:25832&bbox=<E0>,<N0>,<E1>,<N1>&width=1000&height=1000&format=GeoTIFF

Norwegen gibt seine Höhen sonst in UTM33 (EPSG:25833) heraus; der Dienst rechnet aber auf
Wunsch in die Zone 32 um, in der die Karte rechnet (EPSG:25832), und liefert genau
1000 × 1000 Werte für ein Kilometerquadrat – nachgemessen: das GeoTIFF trägt
„PCS Name = ETRS_1989_UTM_Zone_32N", Maßstab 1,0 m und als Anknüpfpunkt die Nordwestecke,
und zehn Stichproben stimmen mit dem offenen Punktdienst
https://ws.geonorge.no/hoydedata/v1/punkt (koordsys=25832) bis auf wenige Dezimeter
überein.  Aufwand je Kachel: ≈ 4,2 MB, ≈ 3 s (gemessen mit curl, November 2026).

Lizenz (Kartkatalogen): „Tilgangsrestriksjoner: Åpne data", „Lisens: Creative Commons
BY 4.0 (CC BY 4.0)", „Bruksbegrensninger: Ingen begrensninger".  Quellenzeile der Karte:
„Gelände (DTM 1 m): © Kartverket, Nasjonal høydemodell (hoydedata.no), CC BY 4.0".

Benutzung:

    python3 -I tools/fetch-no.py --east 591..605 --north 6636..6650
    python3 -I tools/fetch-no.py --east 598 --north 6643 --published map-assets/index.json
    python3 -I tools/fetch-no.py --east 591..605 --north 6636..6650 --jobs 6 --gaps data/work/gaps.txt

--east/--north sind Kilometerquadrate in UTM32 (EPSG:25832), dasselbe Gitter, nach dem die
Höhenkacheln benannt sind: 598_6643 ist das Quadrat mit dem Osloer Zentrum.  Wo der Dienst
nichts hat (offene See, Gebiet ohne Laserscan), bleibt das Quadrat weg – die Karte entsteht
nur, wo Gelände liegt (tools/osm-extract.ts).

Nur Gelände:  data/work/dgm2/<E km>_<N km>.dgm – reduziert von tools/fetch-geodata.py,
              damit alle Karten dieselben Bytes schreiben.  Dessen Stufe von 2 cm trägt
              Höhen bis 1310 m; im Gebirge (Jotunheimen) reicht das nicht, in Oslo
              (höchster Berg der Gegend ≈ 600 m) schon.

Nötig sind Python 3 mit numpy und Pillow (beide kommen im Ablauf dazu), curl und ein paar
Gigabyte Platz.  Was schon da ist, wird übersprungen; der Lauf kann also nach einer
Unterbrechung wiederholt werden.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py als Modul: sein reduce_tile schreibt das Gelände Hessens – es schreibt auch unseres."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()
AGENT = GD.AGENT

# der Kartendienst: Nasjonal høydemodell (NHM), Geländemodell von 1 m.
# Kartverket liefert sonst in UTM33; response_crs=EPSG:25832 rechnet der Dienst um.
WCS = 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833'
COVERAGE = 'nhm_dtm_topo_25833'

# das Bild der Karte (src/geo/utm.ts) und ihr Gitter aus Kacheln von 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'591..605' → (591, 605); '598' → (598, 598)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'keine Spanne von Kilometern: {text}')
    return tuple(values)


def tile_keys(east, north):
    """Die vier Kacheln von 500 m, die ein Kilometerquadrat abdeckt, so benannt wie map-assets ('434_363')."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def coverage_url(east, north):
    """Eine Anfrage: genau dieses Kilometerquadrat, 1000 × 1000 Werte im Abstand von 1 m."""
    box = f'{east * 1000},{north * 1000},{(east + 1) * 1000},{(north + 1) * 1000}'
    return (f'{WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage={COVERAGE}'
            f'&crs=EPSG:25832&response_crs=EPSG:25832&bbox={box}'
            f'&width=1000&height=1000&format=GeoTIFF')


def curl_to(url, dest, attempts=6):
    """Mit curl holen (und einen angefangenen Bruch wieder aufnehmen)."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(attempts):
        code = subprocess.call(
            ['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30', '-o', dest, url]
        )
        if code == 0 and os.path.exists(dest) and os.path.getsize(dest) > 0:
            return
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        say(f'[no] curl endete mit {code} für {os.path.basename(dest)}; noch einmal')
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'nicht geholt: {url}')


def take_dgm(east, north, tmp):
    """Ein GeoTIFF zu data/work/dgm2/<E>_<N>.dgm, reduziert wie in Hessen.

    Antwort: die Zahl der Bytes der Höhenkachel, 0 wenn sie schon lag, -1 wenn Kartverket
    für dieses Quadrat kein GeoTIFF hat (offene See oder Gebiet ohne Laserscan).
    """
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    empty = os.path.join(GD.DGM_OUT, '.done', f'{east}_{north}')
    if os.path.exists(empty):  # gemerkt: hier gibt es nichts
        return -1
    curl_to(coverage_url(east, north), tmp)
    with open(tmp, 'rb') as f:
        data = f.read()
    if data[:2] not in (b'II', b'MM'):
        # eine OGC-Meldung kommt als XML oder Text, nicht als GeoTIFF
        os.remove(tmp)
        os.makedirs(os.path.dirname(empty), exist_ok=True)
        with open(empty, 'w') as f:
            f.write('kein GeoTIFF\n')
        return -1
    blob = GD.reduce_tile(data)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometer nach Osten, UTM32 (598 oder 591..605)')
    ap.add_argument('--north', type=span, required=True, help='Kilometer nach Norden (6643 oder 6636..6650)')
    ap.add_argument('--only', choices=['dgm', 'lod2'],
                    help='offene Gebäudemodelle hat Norwegen nicht, es bleibt beim Gelände')
    ap.add_argument('--jobs', type=int, default=4, help='wieviele Kacheln zugleich geholt werden')
    ap.add_argument('--limit', type=int, default=0, help='nur soviele Kacheln (zum ersten Probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln anderer Karten')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip',
                    help='was mit jenen Quadraten geschieht')
    ap.add_argument('--gaps', help='hierhin die Kilometerquadrate ohne Daten schreiben')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.TMP):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[no] Gelände Norwegen: Ost {e0}..{e1} km, Nord {n0}..{n1} km – '
        f'{(e1 - e0 + 1) * (n1 - n0 + 1)} Quadrate von 1 km')
    if args.only == 'lod2':
        say('[no] Norwegen hat keine offenen Gebäudemodelle (FKB-Bygning: nur für Vertragspartner '
            'von Norge digitalt) – die Häuser kommen aus OpenStreetMap')
        return 0

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[no] {args.published}: {len(known)} Kacheln anderer Karten')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Quadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[no] {len(overlap)} Quadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1) if f'{e}_{n}' not in skip]
    if args.limit:
        work = work[: args.limit]
        say(f'[no] nur die ersten {len(work)} davon (--limit)')
    say(f'[no] {len(work)} Quadrate zu holen')

    started = time.time()
    made = 0
    again = 0
    gaps = []
    total = 0

    def one(item):
        e, n = item
        return e, n, take_dgm(e, n, os.path.join(GD.TMP, f'no-{e}_{n}.tif'))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for count, (e, n, size) in enumerate(pool.map(one, work), start=1):
            if size > 0:
                made += 1
                total += size
            elif size == 0:
                again += 1
            else:
                gaps.append(f'{e}_{n}')
            if count % 25 == 0 or count == len(work):
                say(f'[no] {count}/{len(work)}: {made} Höhenkacheln ({total / 1e6:.0f} MB), '
                    f'{again} waren schon da, {len(gaps)} ohne Daten '
                    f'– {(time.time() - started) / 60:.0f} min')
    say(f'[no] fertig: {made} Höhenkacheln ({total / 1e6:.0f} MB), {again} waren schon da, '
        f'{len(gaps)} Quadrate ohne Daten, {(time.time() - started) / 60:.0f} min')
    if gaps:
        say(f'[no] kein Gelände von Kartverket für {len(gaps)} Quadrate (die Karte bleibt dort weg)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
