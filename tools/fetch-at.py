#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Holt das offene Geländemodell Österreichs – das ALS-DTM-Höhenraster 1 m des Bundesamtes
für Eich- und Vermessungswesen (BEV) – für ein Rechteck von Kilometerkacheln und reduziert
es auf das, was der Kartenbau liest.  Es tut für Österreich, was tools/fetch-nrw.py für
Nordrhein-Westfalen und tools/fetch-it.py für Italien tut.

    python3 -I tools/fetch-at.py --east 556 --north 5261
    python3 -I tools/fetch-at.py --east 549..563 --north 5254..5268
    python3 -I tools/fetch-at.py --east 675..689 --north 5231..5245 --published map-assets/index.json

--east/--north sind UTM32-Kilometerquadrate (EPSG:25832) – dasselbe Raster, nach dem die
Kacheln der Karte heißen: 556_5261 ist die Kachel, in der die Bregenzer Innenstadt liegt.

Das BEV hält das Land in 55 Blättern von 50 km × 50 km in EPSG:3035 (LAEA Europa), jedes
ein BigTIFF von 50001 × 50001 Pixeln (float32, Höhen in m, kein Schlüssel nötig, CC BY 4.0).
Ein Blatt ist zu groß, um ganz zu kommen; die Datei ist aber in Kacheln von 512 × 512
Pixeln geschrieben und der Server antwortet auf Bytebereiche (Accept-Ranges), also liest
dieses Skript nur die Kacheln, die das Rechteck braucht (ein Kilometerquadrat sind rund
neun davon) und entpackt sie selbst: LZW (wie libtiff es schreibt) und die
Byte-Differenzen des Predictors 3.  Die Umrechnung von UTM32 nach EPSG:3035 steht hier
(tools/fetch-geodata.py und die anderen brauchen sie nicht) und ist gegen die Rückrechnung
nach Länge und Breite geprüft.

Gelände: data/work/dgm2/<E km>_<N km>.dgm – 500 × 500 Zeilen von 2 m, geschrieben wie in
tools/fetch-geodata.py, nur mit eigener Höhenstufe: im Gebirge reicht die Stufe von 2 cm
der anderen Länder nicht (1310 m), darum wählt jede Kachel die feinste Stufe, in die ihre
Höhen passen (2 cm, 5 cm oder 10 cm – der Kopf der Datei nennt sie, tools/mapgen/dgm.ts:60).

Gebäude: Österreich hat kein offenes LoD2 – Bauwerkshöhen lägen nur im
„Digitalen Landschaftsmodell – Bauwerke" (Grundrisse mit mittlerer Höhe, 2,6 GB je Stand),
und daraus eigene Einheiten zu schreiben wäre ein zweiter Bau.  Die Dächer dieser Karten
kommen wie in Italien aus den OpenStreetMap-Umrissen.

--published <map-assets/index.json> verhindert, dass diese Karte eine Kachel von 500 m deckt, die schon eine andere Karte hat (mit --on-overlap fail bricht das Skript stattdessen
ab und nennt sie).

Gebraucht werden Python 3 mit numpy (und Pillow für tools/fetch-geodata.py, das hier
gelesen wird).  Was schon da ist, wird übersprungen, der Befehl kann also nach einer
Unterbrechung wiederholt werden.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
import re
import struct
import threading
import time
import urllib.request
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def geodata():
    """tools/fetch-geodata.py als Modul: sein Ausgabeweg für das Gelände gilt auch hier."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()

AGENT = GD.AGENT
N = GD.DGM_N
# BEV – ALS-Höhenraster 1 m, CC BY 4.0, kein Schlüssel nötig (die Lizenz steht im Metadatensatz
# des Blattes: otherConstraints → https://creativecommons.org/licenses/by/4.0/, und
# „Der öffentliche Zugang zu diesem Produkt unterliegt keinen Einschränkungen.").
# Der ATOM-Dienst nennt für jedes Blatt die Stichtage; die Adresse zum Holen folgt daraus.
ATOM = ('https://data.bev.gv.at/geonetwork/srv/atom/describe/service'
        '?uuid=208cff7a-c8aa-42fe-bf4f-2b8156e37528&language=de')
DOWNLOAD = 'https://data.bev.gv.at/download/ALS/DTM/{date}/ALS_DTM_CRS3035RES50000mN{north}E{east}.tif'
TITLE = re.compile(r'ALS (DTM) CRS3035RES50000mN(\d+)E(\d+) Höhenraster 1m Stichtag (\d{2})\.(\d{2})\.(\d{4})')
# Blätter an der Grenze: ein Rechteck kann zwei von ihnen brauchen
EDGE = 50000.0
CACHE = os.path.join(ROOT, 'data/work/at')
# die Höhenstufen der .dgm: die feinste, in die die höchste Höhe der Kachel passt
STEPS = (0.02, 0.05, 0.1)

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


# --------------------------------------------------------------------------- Geodäsie


A = 6378137.0
F = 1 / 298.257222101
E2 = F * (2 - F)
K0 = 0.9996
LAM0 = np.radians(9.0)
LAEA_LAM0 = np.radians(10.0)
PHI0 = np.radians(52.0)
FE = 4321000.0
FN = 3210000.0


def utm32_to_laea(e, n):
    """UTM32 (ETRS89) → EPSG:3035 (LAEA Europa); e und n in Metern, Arrays erlaubt."""
    x = e - 500000.0
    ep2 = E2 / (1 - E2)
    e1 = (1 - np.sqrt(1 - E2)) / (1 + np.sqrt(1 - E2))
    mu = n / K0 / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * np.sin(6 * mu))
    c1 = ep2 * np.cos(phi1) ** 2
    t1 = np.tan(phi1) ** 2
    n1 = A / np.sqrt(1 - E2 * np.sin(phi1) ** 2)
    r1 = A * (1 - E2) / (1 - E2 * np.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * K0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = LAM0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / np.cos(phi1)
    phi = lat
    lam = lon
    e_ = np.sqrt(E2)
    q = (1 - E2) * (np.sin(phi) / (1 - E2 * np.sin(phi) ** 2)
                    - (1 / (2 * e_)) * np.log((1 - e_ * np.sin(phi)) / (1 + e_ * np.sin(phi))))
    qp = 1 - ((1 - E2) / (2 * e_)) * np.log((1 - e_) / (1 + e_))
    rq = A * np.sqrt(qp / 2)
    beta = np.arcsin(q / qp)
    q0 = (1 - E2) * (np.sin(PHI0) / (1 - E2 * np.sin(PHI0) ** 2)
                     - (1 / (2 * e_)) * np.log((1 - e_ * np.sin(PHI0)) / (1 + e_ * np.sin(PHI0))))
    b0 = np.arcsin(q0 / qp)
    b = rq * np.sqrt(2 / (1 + np.sin(b0) * np.sin(beta)
                          + np.cos(b0) * np.cos(beta) * np.cos(lam - LAEA_LAM0)))
    dd = (A * np.cos(PHI0) / np.sqrt(1 - E2 * np.sin(PHI0) ** 2)) / (rq * np.cos(b0))
    return (FE + b * dd * np.cos(beta) * np.sin(lam - LAEA_LAM0),
            FN + (b / dd) * (np.cos(b0) * np.sin(beta) - np.sin(b0) * np.cos(beta) * np.cos(lam - LAEA_LAM0)))


# --------------------------------------------------------------------------- das Höhenraster


def ask(url, start=None, end=None, attempts=6):
    headers = {'User-Agent': AGENT}
    if start is not None:
        headers['Range'] = f'bytes={start}-{end}'
    request = urllib.request.Request(url, headers=headers)
    want = None if start is None else end - start + 1
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                body = r.read()
            if want is not None and (r.status != 206 or len(body) != want):
                # der Server muss Bytebereiche geben; sonst stimmt kein Versatz im Blatt
                raise OSError(f'{r.status} mit {len(body)} statt {want} Bytes')
            return body
        except Exception as e:  # noqa: BLE001 - jedes Netzleiden: warten und noch einmal
            if attempt == attempts - 1:
                raise
            say(f'[at] {e}; noch einmal')
            time.sleep(5 * (attempt + 1))
    return b''


def lzw(src, want):
    """TIFF-LZW (Kompression 5) auf einen Puffer fester Größe; liefert genau want Bytes."""
    out = bytearray()
    table = {i: bytes([i]) for i in range(256)}
    next_code = 258
    codesize = 9
    prev = None
    pos = 0
    bitbuf = 0
    bitcnt = 0
    end = len(src)
    while True:
        while bitcnt < codesize and pos < end:
            bitbuf = (bitbuf << 8) | src[pos]
            pos += 1
            bitcnt += 8
        if bitcnt < codesize:
            break
        shift = bitcnt - codesize
        code = (bitbuf >> shift) & ((1 << codesize) - 1)
        bitbuf &= (1 << shift) - 1
        bitcnt = shift
        if code == 256:  # ClearCode
            table = {i: bytes([i]) for i in range(256)}
            next_code = 258
            codesize = 9
            prev = None
            continue
        if code == 257:  # EndOfInformation
            break
        if prev is None:
            entry = table[code]
        else:
            entry = table.get(code)
            if entry is None:
                if code != next_code:
                    raise ValueError(f'LZW: Zeichen {code} fehlt in der Tabelle (bei {next_code})')
                entry = prev + prev[:1]
            table[next_code] = prev + entry[:1]
            next_code += 1
            if next_code + 1 == (1 << codesize) and codesize < 12:
                codesize += 1
        out += entry
        prev = entry
        if len(out) >= want:
            break
    if len(out) < want:
        raise ValueError(f'LZW: nur {len(out)} von {want} Bytes')
    return bytes(out[:want])


class Source:
    """Ein Blatt von 50 km: sein Kopf und die Kacheln von 512 × 512 daraus."""

    def __init__(self, north, east, url, date):
        self.north = float(north)   # die Südkante des Blattes (wie im Namen)
        self.east = float(east)     # die Westkante
        self.url = url
        self.date = date
        self.ready = False

    def covers(self, x, y):
        return self.east <= x < self.east + EDGE and self.north <= y < self.north + EDGE

    def head(self):
        if self.ready:
            return self
        start = ask(self.url, 0, 15)
        if start[:4] not in (b'II+\x00', b'II*\x00'):
            raise RuntimeError(f'{self.url}: kein TIFF (little endian)')
        ifd = struct.unpack('<Q', start[8:16])[0]
        d = ask(self.url, ifd, ifd + 8 + 20 * 64)
        count = struct.unpack('<Q', d[:8])[0]
        tags = {}
        for i in range(count):
            base = 8 + i * 20          # ein Eintrag: Merkmal (2), Typ (2), Anzahl (8), Wert (8)
            tag, typ, num = struct.unpack('<HHQ', d[base: base + 12])
            size = {3: 2, 4: 4, 13: 4, 16: 8, 18: 8}.get(typ, 1)
            if num * size <= 8:
                if typ == 3:
                    value = struct.unpack('<H', d[base + 12: base + 14])[0]
                elif typ in (4, 13):
                    value = struct.unpack('<I', d[base + 12: base + 16])[0]
                else:
                    value = struct.unpack('<Q', d[base + 12: base + 20])[0]
            else:
                value = struct.unpack('<Q', d[base + 12: base + 20])[0]
            tags[tag] = (typ, num, value)
        self.width = tags[256][2]
        self.height = tags[257][2]
        self.tile_w = tags[322][2]
        self.tile_h = tags[323][2]
        self.rows = (self.width + self.tile_w - 1) // self.tile_w
        self.columns = (self.height + self.tile_h - 1) // self.tile_h
        self.scale = struct.unpack('<ddd', ask(self.url, tags[33550][2], tags[33550][2] + 23))
        self.tie = struct.unpack('<dddddd', ask(self.url, tags[33922][2], tags[33922][2] + 47))
        self.predictor = tags.get(317, (3, 1, 1))[2]
        n = tags[324][1]
        self.offsets = np.frombuffer(ask(self.url, tags[324][2], tags[324][2] + 8 * n - 1), dtype='<u8')
        self.counts = np.frombuffer(ask(self.url, tags[325][2], tags[325][2] + 4 * n - 1), dtype='<u4')
        if self.predictor not in (1, 2, 3):
            raise RuntimeError(f'{self.url}: Predictor {self.predictor} kennt dieses Skript nicht')
        self.ready = True
        say(f'[at] Blatt N{int(self.north)}E{int(self.east)} Stichtag {self.date}: '
            f'{self.width} × {self.height} Pixel, Kacheln {self.tile_w} × {self.tile_h}, Predictor {self.predictor}')
        return self

    def pixel_of(self, x, y):
        """LAEA (x, y) → (Spalte, Zeile) mit Bruchteil; Pixel i,j hat seine Mitte bei
        (tie[3] + i + 0.5, tie[4] - j - 0.5)."""
        return (x - self.tie[3]) / self.scale[0] - 0.5, (self.tie[4] - y) / self.scale[1] - 0.5

    def tile(self, column, row):
        index = row * self.rows + column
        start = int(self.offsets[index])
        count = int(self.counts[index])
        w, h = self.tile_w, self.tile_h
        if count == 0:
            return np.full((h, w), -9999.0, np.float32)
        plain = lzw(ask(self.url, start, start + count - 1), w * h * 4)
        u = np.frombuffer(plain, dtype=np.uint8).reshape(h, 4 * w)
        if self.predictor != 1:
            # die Differenzen der Bytes laufen über die ganze Zeile: vier Blöcke (das höchste
            # Byte zuerst) und darin von Spalte zu Spalte – so schreibt libtiff den Predictor 3
            u = np.cumsum(u, axis=1, dtype=np.uint8).reshape(h, 4, w)
        else:
            u = u.reshape(h, 4, w)
        # zurück in Viererbytes: niederstes Byte zuletzt im Block
        return np.stack([u[:, 3, :], u[:, 2, :], u[:, 1, :], u[:, 0, :]], axis=-1
                        ).reshape(h, w, 4).copy().view('<f4').reshape(h, w)

    def window(self, col0, row0, columns, rows, pieces):
        """Die Pixel [col0, col0+columns) × [row0, row0+rows); pieces hält schon gelesene Kacheln."""
        self.head()
        out = np.full((rows, columns), -9999.0, np.float32)
        for row in range(row0 // self.tile_h, (row0 + rows - 1) // self.tile_h + 1):
            for column in range(col0 // self.tile_w, (col0 + columns - 1) // self.tile_w + 1):
                key = (self.north, self.east, column, row)
                piece = pieces.get(key)
                if piece is None:
                    piece = pieces[key] = self.tile(column, row)
                py = row * self.tile_h - row0
                px = column * self.tile_w - col0
                sy = slice(max(0, py), min(rows, py + self.tile_h))
                sx = slice(max(0, px), min(columns, px + self.tile_w))
                out[sy, sx] = piece[sy.start - py: sy.stop - py, sx.start - px: sx.stop - px]
        return out


def km_heights(sources, east, north, pieces):
    """Ein Kilometerquadrat: 1000 × 1000 Höhen in m, Zeile 0 am Nordrand."""
    columns = np.arange(east + 0.5, east + 1000.5, 1.0)
    rows = np.arange(north + 999.5, north - 0.5, -1.0)
    grid_e = np.repeat(columns[None, :], 1000, axis=0)
    grid_n = np.repeat(rows[:, None], 1000, axis=1)
    x, y = utm32_to_laea(grid_e, grid_n)
    source = next((s for s in sources if s.covers(float(x[500][500]), float(y[500][500]))), None)
    if source is None:
        raise RuntimeError(f'{east // 1000}_{north // 1000}: kein Blatt des BEV an dieser Stelle')
    source.head()
    px, py = source.pixel_of(x, y)
    px = np.clip(np.rint(px), 0, source.width - 1).astype(np.int64)
    py = np.clip(np.rint(py), 0, source.height - 1).astype(np.int64)
    col0, row0 = int(px.min()), int(py.min())
    window = source.window(col0, row0, int(px.max()) - col0 + 1, int(py.max()) - row0 + 1, pieces)
    return window[py - row0, px - col0]


def reduce(a):
    """1000 × 1000 Höhen in m → die Bytes einer Kachel von 500 × 500 (wie tools/fetch-geodata.py,
    nur mit der Höhenstufe, die hier passt)."""
    if a.shape != (1000, 1000):
        raise ValueError(f'erwartet 1000 × 1000 Zellen, bekommen {a.shape}')
    k = 1000 // N
    valid = np.isfinite(a) & (a > -1000)
    total = np.where(valid, a, 0).astype(np.float64).reshape(N, k, N, k).sum(axis=(1, 3))
    count = valid.reshape(N, k, N, k).sum(axis=(1, 3))
    mean = np.where(count > 0, total / np.maximum(count, 1), 0)
    top = float(mean.max()) if mean.size else 0.0
    step = next((s for s in STEPS if top / s <= 65500), STEPS[-1])
    # 0 heißt: hier steht keine Höhe
    q = np.clip(np.rint(mean / step), 0, 65535).astype(np.int64)
    padded = np.zeros((N + 1, N + 1), np.int64)
    padded[1:, 1:] = q
    # was der linke, der obere und der linke obere Nachbar nicht vorhersagen
    rest = padded[1:, 1:] - padded[1:, :-1] - padded[:-1, 1:] + padded[:-1, :-1]
    wrapped = (rest & 0xFFFF).astype(np.uint16).astype(np.int16)
    zigzag = ((wrapped.astype(np.int32) << 1) ^ (wrapped.astype(np.int32) >> 15)).astype(np.uint16)
    planes = (zigzag & 0xFF).astype(np.uint8).tobytes() + (zigzag >> 8).astype(np.uint8).tobytes()
    return b'DGM2' + struct.pack('<HH', N, round(step * 1000)) + zlib.compress(planes, 9), step


# --------------------------------------------------------------------------- Verzeichnis und Rahmen


def catalogue():
    """(Südkante, Westkante) → (Stichtag, Adresse): was der ATOM-Dienst des BEV nennt."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, 'atom-dtm.xml')
    if not os.path.exists(cache):
        say('[at] Verzeichnis der Höhenblätter vom BEV holen')
        data = ask(ATOM)
        with open(cache + '.tmp', 'wb') as f:
            f.write(data)
        os.replace(cache + '.tmp', cache)
    with open(cache, 'rb') as f:
        text = f.read().decode('utf-8', 'replace')
    found = {}
    for product, north, east, dd, mm, yyyy in TITLE.findall(text):
        key = (int(north), int(east))
        date = f'{yyyy}{mm}{dd}'
        if key not in found or date > found[key][0]:
            found[key] = (date, DOWNLOAD.format(date=date, north=north, east=east))
    if not found:
        raise RuntimeError(f'{cache}: kein ALS-DTM-Blatt im Verzeichnis gefunden')
    say(f'[at] {len(found)} Blätter im Verzeichnis')
    return found


def tile_keys(east, north):
    """Die vier Kacheln von 500 m, die ein Kilometerquadrat deckt, so benannt wie map-assets."""
    x0 = east * 1000 - 528000
    z0 = 5678000 - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + 200000) // 500}_{(z0 + dz * 500 + 200000) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def work_row(north, easts, sheets):
    """Alle Kilometerquadrate einer Reihe von Nord nach Ost; läuft in einem eigenen Prozess."""
    started = time.time()
    sources = [Source(key[0], key[1], value[1], value[0]) for key, value in sheets.items()]
    pieces = {}
    made = 0
    skipped = 0
    seen = set()
    for east in easts:
        out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
        if os.path.exists(out):
            skipped += 1
            continue
        heights = km_heights(sources, east * 1000, north * 1000, pieces)
        blob, step = reduce(heights)
        with open(out + '.tmp', 'wb') as f:
            f.write(blob)
        os.replace(out + '.tmp', out)
        made += 1
        seen.add(step)
        if made % 5 == 0:
            say(f'[at] Reihe {north} km Nord: {made} Kacheln neu ({(time.time() - started) / 60:.0f} min bis hier)')
        # der Speicher: neun Kacheln von 512 × 512 je Kilometerquadrat sind mehr als genug
        if len(pieces) > 24:
            for key in sorted(pieces)[:8]:
                del pieces[key]
    return made, skipped, sorted(seen)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='Kilometer nach Osten, UTM32 (556 oder 549..563)')
    ap.add_argument('--north', type=span, required=True, help='Kilometer nach Norden, UTM32 (5261 oder 5254..5268)')
    ap.add_argument('--jobs', type=int, default=4, help='wie viele Reihen gleichzeitig gerechnet werden')
    ap.add_argument('--limit', type=int, default=0, help='nur so viele Kilometerquadrate (um den Weg erst zu probieren)')
    ap.add_argument('--published', help='map-assets/index.json: Kacheln, die eine andere Karte schon hat')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='was mit diesen Kacheln geschieht')
    ap.add_argument('--gaps', help='in diese Datei die Kilometerquadrate schreiben, für die das BEV nichts hat')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    easts = list(range(e0, e1 + 1))
    norths = list(range(n0, n1 + 1))
    say(f'[at] {e0}..{e1} km Ost, {n0}..{n1} km Nord – {len(easts) * len(norths)} Kacheln zu 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'kein solcher Index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[at] {args.published}: {len(known)} Kacheln anderer Karten')

    chosen = []
    overlap = []
    for north in norths:
        keep = []
        for east in easts:
            tile = f'{east}_{north}'
            if tile_keys(east, north) & known:
                overlap.append(tile)
                if args.on_overlap == 'skip':
                    continue
            keep.append(east)
        if keep:
            chosen.append((north, keep))
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} Kilometerquadrate hat schon eine andere Karte, z. B. {overlap[:5]}')
        say(f'[at] {len(overlap)} Kilometerquadrate hat schon eine andere Karte: '
            + ('sie werden trotzdem geholt' if args.on_overlap == 'fetch' else 'sie bleiben aus')
            + (f', z. B. {overlap[:5]}'))

    # die Blätter, die das Rechteck braucht (mit Rand: die Ecken der Quadrate liegen nicht auf
    # dem Blattrand)
    corners = utm32_to_laea(np.array([e0 * 1000.0, (e1 + 1) * 1000.0]),
                            np.array([n0 * 1000.0, (n1 + 1) * 1000.0]))
    say(f'[at] Ecken des Rechtecks in EPSG:3035: {np.round(corners[0], 0)} / {np.round(corners[1], 0)}')
    catalogue_all = catalogue()
    wanted = set()
    for x in (float(corners[0].min()) + 2000, float(corners[0].max()) - 2000):
        for y in (float(corners[1].min()) + 2000, float(corners[1].max()) - 2000):
            key = (int(y // EDGE) * 50000, int(x // EDGE) * 50000)
            wanted.add(key)
    sheets = {}
    for key in sorted(wanted):
        if key not in catalogue_all:
            raise RuntimeError(f'kein Höhenblatt des BEV für {key} (Rechteck außerhalb Österreichs?)')
        sheets[key] = catalogue_all[key]
    for key, (date, url) in sorted(sheets.items()):
        say(f'[at] Blatt N{key[0]}E{key[1]}, Stichtag {date}')

    if args.limit:
        flat = [(n, e) for n, keep in chosen for e in keep][: args.limit]
        rows = {}
        for n, e in flat:
            rows.setdefault(n, []).append(e)
        chosen = [(n, sorted(v)) for n, v in sorted(rows.items())]

    started = time.time()
    made = 0
    skipped = 0
    steps = set()
    with concurrent.futures.ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(work_row, north, keep, sheets): north for north, keep in chosen}
        for future in concurrent.futures.as_completed(futures):
            north = futures[future]
            new, old, used = future.result()
            made += new
            skipped += old
            steps.update(used)
            say(f'[at] Reihe {north} km Nord fertig: {new} neu, {old} schon da')
    gaps = sorted(
        f'{e}_{n}' for n, keep in chosen for e in keep
        if not os.path.exists(os.path.join(GD.DGM_OUT, f'{e}_{n}.dgm'))
    )
    say(f'[at] Gelände: {made} Kacheln neu, {skipped} schon da, Höhenstufen '
        f'{sorted(steps)} m in {(time.time() - started) / 60:.0f} min')
    if gaps:
        say(f'[at] für {len(gaps)} Quadrate steht kein Gelände da'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


def span(text):
    """'549..563' → (549, 563); '556' → (556, 556)"""
    values = [int(p) for p in text.replace('..', ' ').replace('-', ' ').split() if p]
    if len(values) == 1:
        values = values * 2
    if len(values) != 2 or values[0] > values[1]:
        raise argparse.ArgumentTypeError(f'kein Bereich von Kilometern: {text}')
    return tuple(values)


if __name__ == '__main__':
    import sys
    sys.exit(main())
