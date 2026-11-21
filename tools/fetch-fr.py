#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das amtliche Geländemodell des Nordostens Frankreichs – RGE ALTI in 5 m
(Géoplateforme / IGN, Licence Ouverte / Open Licence 2.0, ohne Schlüssel und
ohne Anmeldung) – und bringt es in die Form, die der Kartenbau liest.

    python3 -I tools/fetch-fr.py --east 369..383 --north 5283..5297
    python3 -I tools/fetch-fr.py --east 369..383 --north 5283..5297 --published map-assets/index.json
    python3 -I tools/fetch-fr.py --east 369..383 --north 5283..5297 --dept 68 --limit 4

--east/--north sind Kilometerquadrate UTM32 (EPSG:25832), dasselbe Gitter, nach
dem die Geländekacheln benannt sind: 376_5290 ist das Quadrat, in dem das
Rathaus von Mulhouse steht.

Was das Skript tut:

  1. Aus dem Rechteck werden die Kartenblätter von 5 km bestimmt, die es
     braucht – in Lambert-93 (EPSG:2154), dem Gitter, in dem das IGN liefert.
  2. Welche Départements die Gegend hält, sagt die offene Verwaltungs-API
     geo.api.gouv.fr (Stichproben im Rechteck → INSEE-Code der Gemeinde); von
     jedem Département wird das 5-m-Archiv der Géoplateforme geholt
     (https://data.geopf.fr/telechargement/…) und daraus werden nur die
     gebrauchten Blätter entpackt.
  3. Die Blätter werden zu einem Raster von 5 m über das ganze Rechteck
     zusammengelegt; jedes Kilometerquadrat wird darauf zweifach linear
     abgetastet (1 m), als 1000 × 1000-GeoTIFF durch tools/fetch-geodata.py
     (reduce_tile) verkleinert und nach data/work/dgm2/<E>_<N>.dgm geschrieben
     – genau dieselben Bytes wie für Hessen und das Saarland.

Kein französisches Gebäudemodell: das IGN gibt seine 3D-Gebäude nur gegen einen
Schlüssel heraus (wxs.ign.fr).  Die Gebäude dieser Karte kommen deshalb aus
OpenStreetMap; amtlich ist das Gelände.  Quadrate, für die Frankreich kein
Gelände hat (die deutsche und die Schweizer Seite der Grenze), bleiben aus der
Karte heraus und werden gemeldet (--gaps).

Nötig: Python 3 mit numpy, Pillow und py7zr sowie curl.  Was schon da ist, wird
übergangen; der Befehl kann nach einer Unterbrechung wiederholt werden.
"""
import argparse
import concurrent.futures
import importlib.util
import io
import json
import math
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
    """tools/fetch-geodata.py als Modul: sein reduce_tile verkleinert Hessens Gelände – und unseres."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
# Gelände: die Géoplateforme des IGN – offene Daten, kein Schlüssel, keine Anmeldung.
# Die Lizenz nennt der Katalog selbst (IGNF_RGEALTIr_2-0_ASC_5M_LAMB93_IGN69_D0xx.xml im
# Archiv und die Metadaten des Katalogs): "Licence Ouverte / Open License".
TELECHARGEMENT = 'https://data.geopf.fr/telechargement'
PRODUCT = 'RGEALTI'
# Verwaltungsgrenzen: welche Départements das Rechteck berührt (offene Daten, kein Schlüssel)
COMMUNES = 'https://geo.api.gouv.fr/communes'
CACHE = os.path.join(ROOT, 'data/raw/rgealti')

# der Rahmen der Karte (src/geo/utm.ts) und ihr Gitter aus Kacheln von 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'369..383' → (369, 383); '369' → (369, 369)"""
    parts = [p for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    values = [int(p) for p in parts]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'kein Bereich von Kilometern: {text}')
    return tuple(values)


def tile_keys(east, north):
    """Die vier Kacheln von 500 m, die ein Kilometerquadrat deckt ('434_363' wie map-assets)."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


# --------------------------------------------------------------------------------------
# UTM32 (EPSG:25832) und Lambert-93 (EPSG:2154) auf dem GRS80-Ellipsoid
# (Snyder und Krüger; gegen die bekannten Kacheln von Bremen und Straßburg gemessen)
# --------------------------------------------------------------------------------------

A = 6378137.0
F = 1 / 298.257222101
E2 = 1 - (1 - F) ** 2
E = math.sqrt(E2)
UTM_K0 = 0.9996
UTM_E0 = 500000.0
UTM_LON0 = math.radians(9.0)
L93_LON0 = math.radians(3.0)
L93_E0 = 700000.0
L93_N0 = 6600000.0


def _l93_constants():
    phi1, phi2, phi0 = math.radians(44.0), math.radians(49.0), math.radians(46.5)

    def t_of(phi):
        s = math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)

    def m_of(phi):
        return math.cos(phi) / math.sqrt(1 - E2 * math.sin(phi) ** 2)

    t1, t2, t0 = t_of(phi1), t_of(phi2), t_of(phi0)
    n = (math.log(m_of(phi1)) - math.log(m_of(phi2))) / (math.log(t1) - math.log(t2))
    f = m_of(phi1) / (n * t1 ** n)
    return n, f, A * f * t0 ** n


L93_N, L93_F, L93_R0 = _l93_constants()


def utm32_inverse(east, north):
    """UTM32-Meter → (Länge, Breite) in Grad (Krüger, vier Glieder)"""
    n = F / (2 - F)
    n2, n3, n4 = n * n, n ** 3, n ** 4
    a_ = A / (1 + n) * (1 + n2 / 4 + n4 / 64)
    xi = north / (UTM_K0 * a_)
    eta = (east - UTM_E0) / (UTM_K0 * a_)
    b1 = n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180
    b2 = 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440
    b3 = 61 * n3 / 240 - 103 * n4 / 140
    b4 = 49561 * n4 / 161280
    xi_ = xi - (b1 * math.sin(2 * xi) * math.cosh(2 * eta) + b2 * math.sin(4 * xi) * math.cosh(4 * eta)
                + b3 * math.sin(6 * xi) * math.cosh(6 * eta) + b4 * math.sin(8 * xi) * math.cosh(8 * eta))
    eta_ = eta - (b1 * math.cos(2 * xi) * math.sinh(2 * eta) + b2 * math.cos(4 * xi) * math.sinh(4 * eta)
                  + b3 * math.cos(6 * xi) * math.sinh(6 * eta) + b4 * math.cos(8 * xi) * math.sinh(8 * eta))
    chi = math.asin(math.sin(xi_) / math.cosh(eta_))
    lat = (chi + (2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45) * math.sin(2 * chi)
           + (7 * n2 / 3 - 8 * n3 / 3 - 227 * n4 / 45) * math.sin(4 * chi)
           + (56 * n3 / 15 - 136 * n4 / 35) * math.sin(6 * chi)
           + (4279 * n4 / 630) * math.sin(8 * chi))
    lon = UTM_LON0 + math.atan(math.sinh(eta_) / math.cos(xi_))
    return math.degrees(lon), math.degrees(lat)


def utm32_to_l93_arrays(x, y):
    """UTM32-Meter → Lambert-93-Meter, auf ganzen Feldern (dieselben Formeln wie utm32_inverse)"""
    import numpy as np

    n = F / (2 - F)
    n2, n3, n4 = n * n, n ** 3, n ** 4
    a_ = A / (1 + n) * (1 + n2 / 4 + n4 / 64)
    xi = y / (UTM_K0 * a_)
    eta = (x - UTM_E0) / (UTM_K0 * a_)
    b1 = n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180
    b2 = 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440
    b3 = 61 * n3 / 240 - 103 * n4 / 140
    b4 = 49561 * n4 / 161280
    xi_ = xi - (b1 * np.sin(2 * xi) * np.cosh(2 * eta) + b2 * np.sin(4 * xi) * np.cosh(4 * eta)
                + b3 * np.sin(6 * xi) * np.cosh(6 * eta) + b4 * np.sin(8 * xi) * np.cosh(8 * eta))
    eta_ = eta - (b1 * np.cos(2 * xi) * np.sinh(2 * eta) + b2 * np.cos(4 * xi) * np.sinh(4 * eta)
                  + b3 * np.cos(6 * xi) * np.sinh(6 * eta) + b4 * np.cos(8 * xi) * np.sinh(8 * eta))
    chi = np.arcsin(np.sin(xi_) / np.cosh(eta_))
    lat = (chi + (2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45) * np.sin(2 * chi)
           + (7 * n2 / 3 - 8 * n3 / 3 - 227 * n4 / 45) * np.sin(4 * chi)
           + (56 * n3 / 15 - 136 * n4 / 35) * np.sin(6 * chi)
           + (4279 * n4 / 630) * np.sin(8 * chi))
    lon = UTM_LON0 + np.arctan(np.sinh(eta_) / np.cos(xi_))
    s = np.sin(lat)
    t = np.tan(np.pi / 4 - lat / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)
    r = A * L93_F * t ** L93_N
    gamma = L93_N * (lon - L93_LON0)
    return L93_E0 + r * np.sin(gamma), L93_N0 + L93_R0 - r * np.cos(gamma)


def l93_box(e0, e1, n0, n1, steps=128):
    """Der Lambert-93-Umriß des Rechtecks aus Kilometerquadraten (sein Rand wird abgetastet)."""
    import numpy as np

    east = np.linspace(e0 * 1000.0, (e1 + 1) * 1000.0, steps)
    north = np.linspace(n0 * 1000.0, (n1 + 1) * 1000.0, steps)
    corners = [
        (np.full(steps, e0 * 1000.0), north),
        (np.full(steps, (e1 + 1) * 1000.0), north),
        (east, np.full(steps, n0 * 1000.0)),
        (east, np.full(steps, (n1 + 1) * 1000.0)),
    ]
    xs, ys = [], []
    for x, y in corners:
        lx, ly = utm32_to_l93_arrays(x, y)
        xs.append(lx)
        ys.append(ly)
    return float(np.min(xs)), float(np.max(xs)), float(np.min(ys)), float(np.max(ys))


def sheets_of_box(box):
    """Welche Blätter von 5 km der Umriß braucht (im Namen steht links x, oben y in km)."""
    xmin, xmax, ymin, ymax = box
    x0 = int(math.floor(xmin / 5000.0)) * 5
    x1 = int(math.floor(xmax / 5000.0)) * 5
    y0 = int(math.floor(ymin / 5000.0)) * 5 + 5
    y1 = int(math.floor(ymax / 5000.0)) * 5 + 5
    return [(x, y) for x in range(x0, x1 + 1, 5) for y in range(y0, y1 + 1, 5)]


def departments(e0, e1, n0, n1):
    """Welche Départements das Rechteck berührt (neun Stichproben → INSEE-Code der Gemeinde)."""
    found = []
    at_e = [e0 * 1000 + 400, (e0 + e1 + 1) * 500, (e1 + 1) * 1000 - 400]
    at_n = [n0 * 1000 + 400, (n0 + n1 + 1) * 500, (n1 + 1) * 1000 - 400]
    for east in at_e:
        for north in at_n:
            lon, lat = utm32_inverse(east, north)
            got = get(f'{COMMUNES}?lat={lat:.6f}&lon={lon:.6f}&fields=code,nom')
            codes = re.findall(r'"code"\s*:\s*"(\d{2})\d{3}"', got or '')
            if codes:
                say(f'[fr] {lon:.4f} E {lat:.4f} N: Département {" ".join(sorted(set(codes)))}')
            for code in codes:
                if code not in found:
                    found.append(code)
    return [dept_code(c) for c in found]


# --------------------------------------------------------------------------------------
# holen und entpacken
# --------------------------------------------------------------------------------------


def dept_code(text):
    """'68', 'D68' oder '068' → '068', wie das Bezugsverzeichnis die Zone nennt."""
    return '%03d' % int(re.sub(r'\D', '', text))


def get(url, attempts=5):
    """Ein GET mit dem Kopf des Kartenladers – ohne Namen weist das IGN die Anfrage ab (403)."""
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': AGENT})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001 - Netz: warten und noch einmal
            if attempt == attempts - 1:
                say(f'[fr] {e} bei {url.rsplit("/", 1)[-1]} – aufgegeben')
                return None
            say(f'[fr] {e} bei {url.rsplit("/", 1)[-1]}; noch einmal in {5 * (attempt + 1)} s')
            time.sleep(5 * (attempt + 1))
    return None


def archive_of(dept):
    """Das 5-m-Archiv eines Départements: (Name, Adresse, Bytes) aus dem Bezugsverzeichnis."""
    zone = 'D' + dept_code(dept)
    feed = get(f'{TELECHARGEMENT}/resource/{PRODUCT}?zone={zone}&limit=50')
    for link in re.findall(r'<id>([^<]+)</id>', feed or ''):
        if '5M_ASC_LAMB93-IGN69' not in link:
            continue
        sub = get(link)
        urls = re.findall(r'<link href="([^"]+\.7z)"', sub or '')
        lengths = re.findall(r'gpf_dl:length="(\d+)"', sub or '')
        if not urls:
            continue
        return os.path.basename(urllib.parse.unquote(link)), urls[0], int(lengths[0]) if lengths else 0
    say(f'[fr] {zone}: kein Archiv RGE ALTI 5 m ASC im Bezugsverzeichnis')
    return None


def fetch(dept, info):
    """Das Archiv des Départements nach data/raw/rgealti holen (liegt es schon: nichts tun)."""
    name, url, length = info
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, name + '.7z')
    if os.path.exists(out) and (not length or os.path.getsize(out) == length):
        say(f'[fr] D{dept}: {name}.7z liegt schon da ({os.path.getsize(out) / 1048576:.0f} MB)')
        return out
    say(f'[fr] D{dept}: {name} holen – {(length or 0) / 1048576:.0f} MB')
    started = time.time()
    subprocess.run(['curl', '-fsSL', '--retry', '5', '--retry-delay', '20', '-o', out + '.part', url], check=True)
    os.replace(out + '.part', out)
    say(f'[fr] D{dept}: {os.path.getsize(out) / 1048576:.0f} MB in {(time.time() - started) / 60:.1f} min')
    return out


def unpack(dept, archive, wanted):
    """Nur die gebrauchten Blätter aus dem Archiv nehmen: (kx, ky) → Pfad."""
    import py7zr

    out = os.path.join(CACHE, 'D' + dept_code(dept))
    os.makedirs(out, exist_ok=True)

    def name_of(tile):
        return f'RGEALTI_FXX_{tile[0]:04d}_{tile[1]:04d}_MNT_LAMB93_IGN69.asc'

    have = {}
    for tile in wanted:
        path = os.path.join(out, name_of(tile))
        if os.path.exists(path):
            have[tile] = path
    missing = [name_of(t) for t in wanted if t not in have]
    if not missing:
        return have
    say(f'[fr] D{dept}: {len(missing)} Blätter entpacken')
    started = time.time()
    with py7zr.SevenZipFile(archive) as z:
        targets = [n for n in z.getnames() if os.path.basename(n) in missing]
        if targets:
            z.extract(path=out, targets=targets)
    # das Blatt liegt im Archiv in einem Verzeichnis: von unten nach oben flach hinstellen
    for base, dirs, files in os.walk(out, topdown=False):
        for f in files:
            src = os.path.join(base, f)
            flat = os.path.join(out, f)
            if src != flat:
                if os.path.exists(flat):
                    os.remove(src)
                else:
                    shutil.move(src, flat)
        if base != out and not os.listdir(base):
            try:
                os.rmdir(base)
            except OSError:
                pass
    for tile in wanted:
        path = os.path.join(out, name_of(tile))
        if os.path.exists(path):
            have[tile] = path
    say(f'[fr] D{dept}: {len(have)} Blätter da in {(time.time() - started) / 60:.1f} min')
    return have


def read_asc(path):
    """Ein Blatt von 5 km: 1000 × 1000 Höhen in Metern, Zeile 0 ist der Nordrand."""
    import numpy as np

    with open(path, 'rb') as f:
        head = f.read(400)
    head_of = {}
    for key in ('ncols', 'nrows', 'xllcorner', 'yllcorner', 'cellsize'):
        m = re.search(rf'{key}\s+(-?[\d.]+)'.encode(), head)
        if not m:
            raise ValueError(f'{path}: kein {key} in der Kopfzeile')
        head_of[key] = float(m.group(1))
    nodata = re.search(rb'NODATA_value\s+(-?[\d.]+)', head)
    nod = float(nodata.group(1)) if nodata else -99999.0
    at = head.index(b'NODATA_value')
    at = head.index(b'\n', at) + 1
    with open(path, 'rb') as f:
        f.seek(at)
        raw = f.read()
    rows, cols = int(head_of['nrows']), int(head_of['ncols'])
    a = np.array(raw.split(), dtype=np.float32).reshape(rows, cols)
    a = np.where(a <= nod + 1, np.nan, a)  # Zeile 0 liegt im Norden, so wie das IGN die Blätter schreibt
    return a, head_of


def lay_out(sheets, have):
    """Die Blätter zu einem Raster von 5 m zusammenlegen: (Feld, linker x, oberes y in km)."""
    import numpy as np

    x0 = min(s[0] for s in sheets)
    y1 = max(s[1] for s in sheets)
    cols = (max(s[0] for s in sheets) - x0) * 200 + 1000
    rows = (y1 - min(s[1] for s in sheets)) * 200 + 1000
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    for tile in sheets:
        path = have.get(tile)
        if not path:
            continue
        a, head = read_asc(path)
        if a.shape != (1000, 1000):
            raise ValueError(f'{path}: {a.shape} statt 1000 × 1000')
        if abs(head['xllcorner'] - (tile[0] * 1000 - 2.5)) > 1 or abs(head['yllcorner'] - ((tile[1] - 5) * 1000 + 2.5)) > 1:
            raise ValueError(f'{path}: die Kopfzeile paßt nicht zum Namen ({head})')
        # Zellenmitten: x = x0·1000 + 5·Spalte, y = y1·1000 - 5·Zeile
        r0 = (y1 - tile[1]) * 200
        c0 = (tile[0] - x0) * 200
        grid[r0:r0 + 1000, c0:c0 + 1000] = a
    return grid, x0, y1


def sample(grid, x0, y1, east, north):
    """Ein Kilometerquadrat zweifach linear abtasten: 1000 × 1000 Höhen und wieviel davon Gelände ist."""
    import numpy as np

    at = np.arange(1000) + 0.5
    rows, cols = grid.shape
    x = (east * 1000 + at)[None, :].repeat(1000, 0).ravel()
    y = (north * 1000 + 1000 - at)[:, None].repeat(1000, 1).ravel()  # Zeile 0 ist der Nordrand
    lx, ly = utm32_to_l93_arrays(x, y)
    fx = (lx - x0 * 1000.0) / 5.0
    fy = (y1 * 1000.0 - ly) / 5.0
    c0 = np.floor(fx).astype(np.int64)
    r0 = np.floor(fy).astype(np.int64)
    tx = (fx - c0).astype(np.float32)
    ty = (fy - r0).astype(np.float32)
    del lx, ly, fx, fy

    def cell(rr, cc):
        inside = (rr >= 0) & (rr < rows) & (cc >= 0) & (cc < cols)
        return np.where(inside, grid[np.clip(rr, 0, rows - 1), np.clip(cc, 0, cols - 1)], np.nan)

    corners = [(cell(r0, c0), (1 - tx) * (1 - ty)), (cell(r0, c0 + 1), tx * (1 - ty)),
               (cell(r0 + 1, c0), (1 - tx) * ty), (cell(r0 + 1, c0 + 1), tx * ty)]
    total = np.zeros(1000 * 1000, np.float32)
    value = np.zeros(1000 * 1000, np.float32)
    for v, w in corners:
        good = ~np.isnan(v)
        total += np.where(good, w, 0)
        value += np.where(good, w * np.nan_to_num(v, nan=0.0), 0)
    out = np.where(total > 0, value / np.maximum(total, 1e-6), -99999.0)
    return out.reshape(1000, 1000), float(np.mean(total > 0))


def write_tile(grid, x0, y1, east, north, out_dir):
    """Ein Kilometerquadrat → data/work/dgm2/<E>_<N>.dgm (dasselbe wie tools/fetch-geodata.py)."""
    import numpy as np  # noqa: F401 - reduce_tile braucht es
    from PIL import Image

    out = os.path.join(out_dir, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0, 1.0
    a, share = sample(grid, x0, y1, east, north)
    if share < 0.5:
        return -1, share
    buffer = io.BytesIO()
    Image.fromarray(a, mode='F').save(buffer, format='TIFF')
    blob = GD.reduce_tile(buffer.getvalue())
    os.makedirs(out_dir, exist_ok=True)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob), share


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometerquadrate nach Osten, UTM32 (376 oder 369..383)')
    ap.add_argument('--north', type=span, required=True, help='Kilometerquadrate nach Norden, UTM32 (5290 oder 5283..5297)')
    ap.add_argument('--dept', action='append', default=[], help='nur dieses Département (25, 54, 57, 67, 68; wiederholbar)')
    ap.add_argument('--jobs', type=int, default=4, help='wieviele Quadrate zugleich gelesen werden')
    ap.add_argument('--limit', type=int, default=0, help='nur soviele Quadrate (um den Weg erst zu probieren)')
    ap.add_argument('--dry', action='store_true', help='nur sagen, was geholt würde')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit ihnen geschieht')
    ap.add_argument('--gaps', help='Datei, in die die Quadrate ohne französisches Gelände kommen')
    args = ap.parse_args()

    out_dir = GD.DGM_OUT
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    wanted = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    say(f'[fr] Osten {e0}..{e1} km, Norden {n0}..{n1} km – {len(wanted)} Quadrate von 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            for file in json.load(f)['files']:
                known.update(file['tiles'])
        say(f'[fr] {args.published}: {len(known)} Kacheln anderer Karten')
    overlap = [t for t in wanted if tile_keys(*t) & known]
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Quadrate hat schon eine andere Karte, z. B. ' + ', '.join(f'{e}_{n}' for e, n in overlap[:5]))
        say(f'[fr] {len(overlap)} Quadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus'))

    box = l93_box(e0, e1, n0, n1)
    sheets = sheets_of_box(box)
    say(f'[fr] Umriß in Lambert-93 {box[0]:.0f}..{box[1]:.0f} E / {box[2]:.0f}..{box[3]:.0f} N – '
        f'{len(sheets)} Blätter von 5 km gebraucht')
    depts = [dept_code(d) for d in args.dept] or departments(e0, e1, n0, n1)
    if not depts:
        ap.error('kein Département gefunden – mit --dept 68 (o. ä.) von Hand nennen')
    say(f'[fr] Départements: {" ".join(depts)}')

    have = {}
    for dept in depts:
        left = [s for s in sheets if s not in have]
        if not left:
            break
        info = archive_of(dept)
        if not info:
            continue
        if args.dry:
            say(f'[fr] D{dept}: {info[0]} – {(info[2] or 0) / 1048576:.0f} MB, {len(left)} Blätter gebraucht')
            continue
        have.update(unpack(dept, fetch(dept, info), left))
    if args.dry:
        return 0
    missing = [s for s in sheets if s not in have]
    if missing:
        say(f'[fr] {len(missing)} Blätter liegen in keinem der Départements ({", ".join(depts)}): '
            + ', '.join(f'{x}_{y}' for x, y in missing[:6]))

    started = time.time()
    grid, x0, y1 = lay_out(sheets, have)
    import numpy
    filled = int(numpy.isfinite(grid).sum())
    say(f'[fr] Raster von 5 m über das Rechteck: {grid.shape[1]} × {grid.shape[0]} Zellen, {filled} davon mit Höhe')
    if not have:
        say('[fr] kein einziges Blatt – ohne französisches Gelände keine Karte')
        return 1

    work = [t for t in wanted if args.on_overlap == 'fetch' or t not in overlap]
    if args.limit:
        work = work[: args.limit]
        say(f'[fr] nur die ersten {len(work)} Quadrate (--limit)')
    made, again, gaps = 0, 0, []

    def one(item):
        east, north = item
        return (east, north) + write_tile(grid, x0, y1, east, north, out_dir)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            east, north, size, share = item
            if size == 0:
                again += 1
            elif size < 0:
                gaps.append(f'{east}_{north}')
            else:
                made += 1
            if done % 20 == 0 or done == len(work):
                say(f'[fr] {done}/{len(work)}: {made} Quadrate Gelände, {len(gaps)} ohne Daten '
                    f'– {(time.time() - started) / 60:.0f} min bisher')

    say(f'[fr] fertig: {made} Quadrate Gelände geschrieben ({again} waren schon da, '
        f'{len(gaps)} ohne französisches Gelände) in {(time.time() - started) / 60:.0f} min: {out_dir}')
    if gaps:
        say('[fr] kein Gelände (deutsche oder Schweizer Seite der Grenze, die Karte bleibt dort aus): '
            + ', '.join(gaps[:8]) + (' …' if len(gaps) > 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
