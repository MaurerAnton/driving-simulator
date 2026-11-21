# SPDX-License-Identifier: AGPL-3.0-only
#!/usr/bin/env python3
"""
Fetch the official terrain model of the Grand Duchy of Luxembourg – the 1 m
grid "BD-L-MNT-1m" of the Administration du cadastre et de la topographie,
which the open-data portal data.public.lu itself publishes under "cc-zero"
(Creative Commons CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/;
no buildings exist there: no CityGML of LoD2 is open in Luxembourg) – and
reduce it to what the map build reads.  A map of Luxembourg is therefore a
terrain-only map, exactly as the build tolerates it.

    python3 -I tools/fetch-lu.py --east 293 --north 5499
    python3 -I tools/fetch-lu.py --east 286..300 --north 5492..5506
    python3 -I tools/fetch-lu.py --east 286..300 --north 5492..5506 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832): 293_5499 is the square
the city of Luxembourg lies in.  The whole country is one raster of
64 000 × 84 000 cells (1.3 GB) in its own grid LUREF / Luxembourg TM
(EPSG:2169), one row per strip; this script reads out of that file only the
rows a rectangle needs and asks libtiff – through Pillow – to unpack them: a
rectangle of 15 × 15 km costs 15 000 rows, not the whole country.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: every state then writes the same bytes
           Source: https://download.data.public.lu/resources/bd-l-mnt-1m/20180419-081916/MNT_luxembourg2017.zip
           member   MNT_luxembourg2017.tif, heights in metres above NG95
           (the vertical reference the portal names: "rattaché au marégraphe
           d'Amsterdam (Normal Null - Pegel Amsterdam)")

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

Needs Python 3 and two packages the map build installs anyway (numpy and
Pillow).  What is already there is skipped, so the command can be repeated
after an interruption.
"""
import argparse
import importlib.util
import io
import json
import math
import os
import re
import struct
import sys
import threading
import time
import urllib.request
import zipfile

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

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
# The open-data portal names the two resources of BD-L-MNT-1m; the raster is the zip.
SOURCE = 'https://download.data.public.lu/resources/bd-l-mnt-1m/20180419-081916/MNT_luxembourg2017.zip'
SOURCE_BYTES = 1209645619       # what the portal's own API says (filesize)
MEMBER = re.compile(r'\.tif$', re.IGNORECASE)
CACHE = os.path.join(ROOT, 'data/work/luxembourg')
ARCHIVE = os.path.join(CACHE, 'MNT_luxembourg2017.zip')
RASTER = os.path.join(CACHE, 'MNT_luxembourg2017.tif')
# -32767 is the value the raster's GeoTIFF tags call "no data"
NODATA = -32767
# how many rows are unpacked at once (one row is 64 000 cells = 128 KB)
BATCH = 400

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


# --- UTM32 -> LUREF / Luxembourg TM (EPSG:2169) ------------------------------
# There is no server that reprojects a raster, and the map build installs no
# projection library, so the chain is written here: Snyder's formulae on numpy
# arrays, checked against PROJ (transformer EPSG:25832 -> EPSG:2169) over a grid
# of 9 x 9 points in every rectangle – the two agree to 7 mm.
GRS80 = (6378137.0, 298.257222101)
INTL24 = (6378388.0, 297.0)
DEG = math.pi / 180


def _ell(a, rf):
    f = 1.0 / rf
    return a, math.sqrt(2 * f - f * f), f


def _meridional_arc(phi, a, e):
    e2 = e * e
    return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
                - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * phi)
                + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * phi)
                - (35 * e2**3 / 3072) * np.sin(6 * phi))


def _arc_to_lat(M, a, e):
    e1 = (1 - math.sqrt(1 - e * e)) / (1 + math.sqrt(1 - e * e))
    mu = M / (a * (1 - e * e / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    return (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
            + (151 * e1**3 / 96) * np.sin(6 * mu)
            + (1097 * e1**4 / 512) * np.sin(8 * mu))


def _geo_to_xyz(lat, lon, a, e):
    e2 = e * e
    s, c = np.sin(lat), np.cos(lat)
    nu = a / np.sqrt(1 - e2 * s * s)
    return np.stack([nu * c * np.cos(lon), nu * c * np.sin(lon), nu * (1 - e2) * s])


def _xyz_to_geo(P, a, e):
    e2 = e * e
    X, Y, Z = P
    p = np.hypot(X, Y)
    lat = np.arctan2(Z, p)
    for _ in range(6):                                   # Bowring's iteration
        s = np.sin(lat)
        nu = a / np.sqrt(1 - e2 * s * s)
        lat = np.arctan2(Z + nu * e2 * s, p)
    return lat, np.arctan2(Y, X)


def _utm32_inverse(E, N):
    """UTM32 (EPSG:25832) -> latitude and longitude on GRS80."""
    a, e, _ = _ell(*GRS80)
    e2 = e * e
    ep2 = e2 / (1 - e2)
    x = E - 500000.0
    M = _meridional_arc(0.0, a, e) + N / 0.9996
    phi1 = _arc_to_lat(M, a, e)
    s, c, t = np.sin(phi1), np.cos(phi1), np.tan(phi1)
    C1 = ep2 * c * c
    T1 = t * t
    N1 = a / np.sqrt(1 - e2 * s * s)
    R1 = a * (1 - e2) / (1 - e2 * s * s)**1.5
    d = x / (N1 * 0.9996)
    lat = phi1 - (N1 * t / R1) * (d**2 / 2
                                  - (5 + 3 * T1 + 10 * C1 - 4 * C1**2 - 9 * ep2) * d**4 / 24
                                  + (61 + 90 * T1 + 298 * C1 + 45 * T1**2 - 252 * ep2 - 3 * C1**2) * d**6 / 720)
    lon = 9 * DEG + (d - (1 + 2 * T1 + C1) * d**3 / 6
                     + (5 - 2 * C1 + 28 * T1 - 3 * C1**2 + 8 * ep2 + 24 * T1**2) * d**5 / 120) / c
    return lat, lon


def _tm_forward(lat, lon, a, e, lat0, lon0, k0, FE, FN):
    """Gauss-Krüger on the International 1924 ellipsoid, as LUREF is defined."""
    e2 = e * e
    ep2 = e2 / (1 - e2)
    s, c, t = np.sin(lat), np.cos(lat), np.tan(lat)
    N1 = a / np.sqrt(1 - e2 * s * s)
    T1 = t * t
    C1 = ep2 * c * c
    A = (lon - lon0) * c
    M = _meridional_arc(lat, a, e)
    x = FE + k0 * N1 * (A + (1 - T1 + C1) * A**3 / 6
                        + (5 - 18 * T1 + T1**2 + 72 * C1 - 58 * ep2) * A**5 / 120)
    y = FN + k0 * (M - _meridional_arc(lat0, a, e) + N1 * t * (A**2 / 2
                   + (5 - T1 + 9 * C1 + 4 * C1**2) * A**4 / 24
                   + (61 - 58 * T1 + T1**2 + 600 * C1 - 330 * ep2) * A**6 / 720))
    return x, y


def utm32_to_luref(E, N):
    """UTM32 kilometre coordinates -> metres of LUREF / Luxembourg TM (EPSG:2169)."""
    a, e, _ = _ell(*GRS80)
    lat, lon = _utm32_inverse(np.asarray(E, dtype=np.float64), np.asarray(N, dtype=np.float64))
    P = _geo_to_xyz(lat, lon, a, e)
    # EPSG:9938 "LUREF to ETRS89 (8)" read backwards – coordinate frame rotation
    tx, ty, tz = 189.228, -12.0035, 42.6303
    rx, ry, rz = -0.48171, -3.09948, 2.68639
    ds = -0.46346
    r = np.array([rx, ry, rz]) * math.pi / (180 * 3600)
    R = np.array([[1, r[2], -r[1]], [-r[2], 1, r[0]], [r[1], -r[0], 1]])
    scale = 1 + ds * 1e-6
    Q = scale * (R @ P.reshape(3, -1)) + np.array([tx, ty, tz])[:, None]
    al, el, _ = _ell(*INTL24)
    latl, lonl = _xyz_to_geo(Q.reshape(P.shape), al, el)
    return _tm_forward(latl, lonl, al, el, 49.833333333333336 * DEG, 6.166666666666667 * DEG,
                       1.0, 80000.0, 100000.0)


# --- the raster ---------------------------------------------------------------
TYPESIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
            16: 8, 17: 8, 18: 8}
# what a tag's own type means for numpy
NUMKIND = {1: 'B', 3: 'H', 4: 'I', 8: 'h', 9: 'i', 11: 'f', 12: 'd', 16: 'Q', 17: 'q', 18: 'Q'}


def span(text):
    """'286..300' → (286, 300); '293' → (293, 293)"""
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


def download(url=SOURCE, path=ARCHIVE):
    """The zip of the portal – and only once: what is there already is kept."""
    part = path + '.part'
    for attempt in range(5):
        try:
            if os.path.exists(path) and os.path.getsize(path) >= SOURCE_BYTES:
                say(f'[lu] {os.path.basename(path)}: already there ({os.path.getsize(path) / 1048576:.0f} MB)')
                return path
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if have:
                say(f'[lu] {os.path.basename(path)}: {have / 1048576:.0f} MB are already there')
            request = urllib.request.Request(url, headers={'User-Agent': AGENT})
            if have:
                request.add_header('Range', f'bytes={have}-')
            with urllib.request.urlopen(request, timeout=300) as r:
                resumed = bool(have) and r.status == 206
                if have and not resumed:
                    say('[lu] the server does not resume – the file is fetched whole again')
                    have = 0
                total = int(r.headers.get('Content-Length') or 0) + have
                started = time.time()
                with open(part, 'ab' if resumed else 'wb') as f:
                    got = have
                    while True:
                        chunk = r.read(1 << 22)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if got % (200 << 20) < (1 << 22):
                            say(f'[lu] {got / 1048576:.0f} MB of {total / 1048576:.0f} MB '
                                f'({got / (time.time() - started) / 1048576:.1f} MB/s)')
            if os.path.getsize(part) < SOURCE_BYTES:
                raise RuntimeError(f'only {os.path.getsize(part)} of {SOURCE_BYTES} bytes came')
            os.replace(part, path)
            return path
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == 4:
                raise
            say(f'[lu] {e}; trying again in {30 * (attempt + 1)} s')
            time.sleep(30 * (attempt + 1))
    raise RuntimeError(url)


def unpack(archive=ARCHIVE, out=RASTER):
    """The raster out of the zip, whole: only rows are read afterwards, but the
    zip holds one compressed member, and a row is found by its offset in it."""
    if os.path.exists(out) and os.path.getsize(out) > 100 << 20:
        say(f'[lu] {os.path.basename(out)}: already unpacked ({os.path.getsize(out) / 1048576:.0f} MB)')
        return out
    with zipfile.ZipFile(archive) as z:
        named = [i for i in z.infolist() if MEMBER.search(i.filename)]
        if not named:
            raise RuntimeError(f'{archive}: no .tif member ({[i.filename for i in z.infolist()]})')
        info = named[0]
        say(f'[lu] {info.filename}: {info.file_size / 1048576:.0f} MB to unpack')
        started = time.time()
        written = 0
        with z.open(info) as src, open(out + '.part', 'wb') as f:
            while True:
                chunk = src.read(1 << 22)
                if not chunk:
                    break
                f.write(chunk)
                written += len(chunk)
                if written % (200 << 20) < (1 << 22):
                    say(f'[lu] unpacked {written / 1048576:.0f} MB ({time.time() - started:.0f} s)')
        os.replace(out + '.part', out)
    return out


def raster_head(path=RASTER):
    """The tags of the raster: its size, the grid it lies in and where its rows stand."""
    with open(path, 'rb') as f:
        head = f.read(16)
        little = head[:2] in (b'II', b'MM')
        big = struct.unpack('<H', head[2:4])[0] == 43
        order = '<' if little else '>'
        ifd = struct.unpack(order + ('Q' if big else 'I'), head[8:16 if big else 12])[0]
        f.seek(ifd)
        count = struct.unpack(order + ('Q' if big else 'I'), f.read(8 if big else 4))[0]
        tags = {}
        for _ in range(count):
            entry = f.read(20 if big else 12)
            tag, typ, num = struct.unpack(order + 'HH' + ('Q' if big else 'I'), entry[:12 if big else 8])
            value = entry[12:20] if big else entry[8:12]
            size = TYPESIZE.get(typ, 4) * num
            if size > (8 if big else 4):
                at = struct.unpack(order + ('Q' if big else 'I'), value)[0]
                there = f.tell()
                f.seek(at)
                tags[tag] = (typ, num, f.read(size))
                f.seek(there)
            else:
                tags[tag] = (typ, num, value[:size])

    def numbers(tag):
        """The values of a tag, read as the type the tag itself names."""
        typ, num, raw = tags[tag]
        return np.frombuffer(raw, dtype=order + NUMKIND.get(typ, 'I'), count=num)

    wide, high = int(numbers(256)[0]), int(numbers(257)[0])
    bits = int(numbers(258)[0])
    compression = int(numbers(259)[0])
    strip_rows = int(numbers(278)[0])
    tie = numbers(33922)
    scale = numbers(33550)
    if compression != 5 or bits != 16 or strip_rows != 1:
        raise RuntimeError(f'{path}: expected LZW rows of 16 bits, got compression {compression}, '
                           f'{bits} bits, {strip_rows} rows per strip')
    # a row has its own LZW stream, so a row can be read alone (tags 273 and 279)
    offsets, counts = numbers(273), numbers(279)
    say(f'[lu] raster {wide} x {high} cells, 1 m, the centre of its first cell at '
        f'{tie[3]:.1f} E, {tie[4]:.1f} N (LUREF)')
    return {
        'path': path,
        'wide': wide,
        'high': high,
        # The tiepoint of this raster names raster point (0,0) – rasterio's xy
        # gives 46000 + col, 141000 - row for the centre of a cell, and so does
        # the chain above; no half cell is added (a half cell would move every
        # height half a metre against the cells it lies on).
        'x0': tie[3],               # centre of the first cell of a row
        'y0': tie[4],               # centre of the first row
        'dx': scale[0],
        'dy': scale[1],
        'strip_offsets': offsets,
        'strip_counts': counts,
    }


def strips(raster, row0, rows_wanted):
    """A small TIFF holding the rows row0.. – libtiff unpacks a row for us.

    Every strip of the great raster is a row of its own, and every row is a
    closed LZW stream: so the bytes of a few rows, put into a small TIFF that
    says the same about them (16 bits, LZW, one row per strip), are unpacked by
    the libtiff Pillow carries – in C, a hundred times faster than Python.
    """
    off = raster['strip_offsets'][row0:row0 + rows_wanted]
    cnt = raster['strip_counts'][row0:row0 + rows_wanted]
    with open(raster['path'], 'rb') as f:
        blobs = []
        for o, c in zip(off, cnt):
            f.seek(int(o))
            blobs.append(f.read(int(c)))
    tags = [(256, 3, 1, raster['wide']), (257, 3, 1, rows_wanted), (258, 3, 1, 16),
            (259, 3, 1, 5), (262, 3, 1, 1), (273, 4, rows_wanted, 0), (277, 3, 1, 1),
            (278, 3, 1, 1), (279, 4, rows_wanted, 0), (284, 3, 1, 1), (339, 3, 1, 2)]
    head = struct.pack('<HHI', 0x4949, 42, 8) + struct.pack('<H', len(tags))
    body_at = len(head) + len(tags) * 12 + 4
    off_at = body_at
    cnt_at = off_at + rows_wanted * 4
    data_at = cnt_at + rows_wanted * 4
    out = bytearray(head)
    there = data_at
    where = []
    for blob in blobs:
        where.append(there)
        there += len(blob)
    for tag, typ, num, value in tags:
        if tag == 273:
            value = off_at
        if tag == 279:
            value = cnt_at
        out += struct.pack('<HHI', tag, typ, num)
        out += struct.pack('<HH', value, 0) if typ == 3 else struct.pack('<I', value)
    out += struct.pack('<I', 0)
    out += struct.pack('<%dI' % rows_wanted, *where)
    out += struct.pack('<%dI' % rows_wanted, *[len(b) for b in blobs])
    for blob in blobs:
        out += blob
    return bytes(out)


def read_window(raster, row0, row1, col0, col1):
    """The cells of the rows row0..row1 between the columns col0..col1 (float32).

    Two rows at least: a TIFF of one row only is not read by every libtiff, so
    where one row is wanted, two are read and the second is thrown away.
    """
    rows_wanted = row1 - row0 + 1
    last = row0 + max(rows_wanted, 2) - 1
    out = np.empty((rows_wanted, col1 - col0 + 1), np.float32)
    at = row0
    while at <= last:
        n = min(BATCH, last - at + 1)
        image = Image.open(io.BytesIO(strips(raster, at, n)))
        cells = np.asarray(image)[:, col0:col1 + 1]
        take = min(n, rows_wanted - (at - row0))
        if take > 0:
            out[at - row0:at - row0 + take] = cells[:take].astype(np.float32)
        at += n
        del cells, image
    return out


def tile_grid(raster, east, north):
    """Where the 1000 x 1000 cells of one kilometre square lie in the raster."""
    easting = east * 1000 + 0.5 + np.arange(1000)          # centre of the cell, UTM32
    northing = (north + 1) * 1000 - 0.5 - np.arange(1000)  # row 0 is the northern one
    E = np.repeat(easting[None, :], 1000, axis=0).ravel()
    N = np.repeat(northing[:, None], 1000, axis=1).ravel()
    x, y = utm32_to_luref(E, N)
    col = (x - raster['x0']).reshape(1000, 1000)
    row = (raster['y0'] - y).reshape(1000, 1000)
    return col, row


def cells_of_window(col, row):
    """The window one square needs in the raster (its four corners suffice)."""
    corners = [(0, 0), (0, -1), (-1, 0), (-1, -1)]
    cols = [col[c, r] for c, r in corners]
    rows = [row[c, r] for c, r in corners]
    return (math.floor(min(cols)) - 2, math.ceil(max(cols)) + 3,
            math.floor(min(rows)) - 2, math.ceil(max(rows)) + 3)


def heights(window, col, row, col0, row0):
    """The 1000 x 1000 heights of one square, taken between the cells it lies on."""
    wide = window.shape[1]
    flat = window.ravel()
    ci = np.floor(col - col0).astype(np.int32)
    ri = np.floor(row - row0).astype(np.int32)
    fx = (col - col0 - ci).astype(np.float32)
    fy = (row - row0 - ri).astype(np.float32)
    base = ri * wide + ci
    v00 = flat[base]
    v01 = flat[base + 1]
    v10 = flat[base + wide]
    v11 = flat[base + wide + 1]
    h = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy
    # a neighbour without a height makes no height: -32768 stays outside > -1000
    empty = (v00 <= NODATA) | (v01 <= NODATA) | (v10 <= NODATA) | (v11 <= NODATA)
    h[empty] = -32768.0
    return h, empty


def write_tile(heights, east, north):
    """A 1000 x 1000 TIFF → data/work/dgm2/<E>_<N>.dgm, as tools/fetch-geodata.py writes it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    buffer = io.BytesIO()
    Image.fromarray(heights, mode='F').save(buffer, format='TIFF')
    blob = GD.reduce_tile(buffer.getvalue())
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (293 or 286..300)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5499 or 5492..5506)')
    ap.add_argument('--limit', type=int, default=0, help='only this many squares (to try the way first)')
    ap.add_argument('--dry', action='store_true', help='only say what would be fetched')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the raster has no height for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    wanted = [(e, n) for n in range(n1, n0 - 1, -1) for e in range(e0, e1 + 1)]
    say(f'[lu] east {e0}..{e1} km, north {n0}..{n1} km – {len(wanted)} squares of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[lu] {args.published}: {len(known)} tiles of other maps')

    overlap = [f'{e}_{n}' for e, n in wanted if tile_keys(e, n) & known]
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[lu] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = [(e, n) for e, n in wanted if f'{e}_{n}' not in skip]
    done = [k for k in work if os.path.exists(os.path.join(GD.DGM_OUT, f'{k[0]}_{k[1]}.dgm'))]
    if done:
        say(f'[lu] {len(done)} squares are already reduced and are skipped')
    todo = [k for k in work if k not in done]
    if args.limit:
        todo = todo[: args.limit]
        say(f'[lu] only the first {len(todo)} of them (--limit)')
    if args.dry:
        say(f'[lu] {len(todo)} squares to fetch of {len(wanted)}; '
            f'the raster is {SOURCE_BYTES / 1048576:.0f} MB to download')
        return 0
    if not todo:
        say('[lu] nothing to fetch')
        return 0

    download()
    unpack()
    raster = raster_head()

    gaps = []
    made = 0
    started = time.time()
    left = list(todo)                       # one row of the rectangle after another
    while left:
        band = [k for k in left if k[1] == left[0][1]]
        left = [k for k in left if k[1] != left[0][1]]
        grids = {k: tile_grid(raster, *k) for k in band}
        windows = {k: cells_of_window(*grids[k]) for k in band}
        col0 = min(w[0] for w in windows.values())
        col1 = max(w[1] for w in windows.values())
        row0 = max(0, min(w[2] for w in windows.values()))
        row1 = min(raster['high'] - 1, max(w[3] for w in windows.values()) - 1)
        if row1 < row0:
            # The whole row of the rectangle lies outside the raster (south of the
            # Grand Duchy or north of it): say so and go on instead of asking for a
            # window of negative height.
            for east, north in band:
                say(f'[lu] {east}_{north}: outside the raster - no height')
                gaps.append(f'{east}_{north}')
            continue
        window = read_window(raster, row0, row1, col0, col1)
        for east, north in band:
            if not (0 <= windows[(east, north)][2] and windows[(east, north)][3] <= raster['high']
                    and 0 <= windows[(east, north)][0] and windows[(east, north)][1] <= raster['wide']):
                say(f'[lu] {east}_{north}: outside the raster – no height')
                gaps.append(f'{east}_{north}')
                continue
            h, empty = heights(window, *grids[(east, north)], col0, row0)
            if empty.all():
                say(f'[lu] {east}_{north}: the raster has no height there')
                gaps.append(f'{east}_{north}')
                continue
            size = write_tile(h, east, north)
            made += 1
            say(f'[lu] {east}_{north}: {size / 1024:.0f} KB, '
                f'{h[~empty].min():.0f}..{h[~empty].max():.0f} m'
                + (f', {100 * empty.mean():.1f} % without height' if empty.any() else '')
                + f' ({made} of {len(todo)}, {(time.time() - started) / made:.1f} s each)')
        del window, grids

    say(f'[lu] {made} squares in {time.time() - started:.0f} s; {len(gaps)} without height')
    if gaps and args.gaps:
        with open(args.gaps, 'w') as f:
            f.write('\n'.join(gaps) + '\n')
        say(f'[lu] the squares without height stand in {args.gaps}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
