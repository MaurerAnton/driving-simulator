#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Hessian
municipalities from the state's download centre (gds.hessen.de, open
geodata) and reduce them, municipality by municipality, to what the map
build reads.  The archives themselves are deleted again: all of northern
Hesse is 22 GB of terrain alone, the reduced form about 1 GB.

    python3 -I tools/fetch-geodata.py --list
    python3 -I tools/fetch-geodata.py --district "Landkreis Kassel" --district "Kreisfreie Stadt Kassel"
    python3 -I tools/fetch-geodata.py --district "Landkreis Kassel" --municipality Nieste --only dgm

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – the 1 km tiles on a 2 m grid
           (mean of 2 × 2 cells), heights in steps of 2 cm, predicted from
           the neighbours and deflated (read by tools/mapgen/dgm.ts)
Buildings: data/work/lod2/<municipality>/… (written by tools/lod2-extract.ts)

Needs Python 3 with numpy and Pillow, curl and node.  What is already there
is skipped, so the command can be repeated after an interruption.
"""
import argparse
import io
import json
import os
import re
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://gds.hessen.de'
API = BASE + '/INTERSHOP/rest/WFS/HLBG-Geodaten-Site/-/downloadcenter'
AGENT = 'map-fetch/0.1'
PRODUCTS = {
    'dgm': '3D-Daten/Digitales Geländemodell (DGM1)',
    'lod2': '3D-Daten/3D-Gebäudemodelle/3D-Gebäudemodelle LoD2',
}
DGM_OUT = os.path.join(ROOT, 'data/work/dgm2')
LOD2_OUT = os.path.join(ROOT, 'data/work/lod2')
TMP = os.path.join(ROOT, 'data/raw/tmp')

# the reduced terrain tile: cells per side, metres per height step
DGM_N = 500
DGM_STEP = 0.02


def api(path, page=1):
    query = urllib.parse.urlencode({'path': path, 'page': page})
    req = urllib.request.Request(API + '?' + query, headers={'User-Agent': AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == 4:
                raise
            print(f'[fetch] {e}; trying again', flush=True)
            time.sleep(5 * (attempt + 1))


def districts(product):
    root = api(PRODUCTS[product])
    deepest = max((n.get('level', 0) for n in root['navigation']), default=0)
    return [n['name'] for n in root['navigation'] if n.get('level') == deepest]


def downloads(product, district):
    items = []
    page = 1
    while True:
        result = api(PRODUCTS[product] + '/' + district, page)['searchresult']
        items += result['downloads']
        if len(items) >= result['paging']['total'] or not result['downloads']:
            return items
        page += 1
        time.sleep(0.3)


def megabytes(text):
    value, unit = text.replace('.', '').replace(',', '.').split()
    return float(value) * {'KB': 0.001, 'MB': 1, 'GB': 1000}[unit]


def plain(name):
    """'Bad Karlshafen - DGM1', 'Bad_Emstal-LoD2' → 'Bad_Karlshafen', 'Bad_Emstal'"""
    name = re.sub(r'\s*-\s*(DGM1|LoD2)$', '', name)
    return re.sub(r'[^0-9A-Za-zÄÖÜäöüß.-]+', '_', name).strip('_')


def fetch(uri, dest):
    """Download with curl (resumes a partial file)."""
    url = BASE + urllib.parse.quote(uri)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    for attempt in range(6):
        code = subprocess.call(['curl', '-fsSL', '-A', AGENT, '-C', '-', '--retry', '3', '--connect-timeout', '30', '-o', dest, url])
        if code == 0:
            return
        # 33: the server would not resume – start again
        if code == 33 and os.path.exists(dest):
            os.remove(dest)
        print(f'[fetch] curl ended with {code}; trying again', flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f'could not download {url}')


def reduce_tile(data):
    """A 1000 × 1000 GeoTIFF (heights in metres) → the bytes of a reduced tile."""
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(data)), dtype=np.float32)
    if a.shape != (1000, 1000):
        raise ValueError(f'expected 1000 x 1000 cells, got {a.shape}')
    k = 1000 // DGM_N
    valid = a > -1000
    total = np.where(valid, a, 0).astype(np.float64).reshape(DGM_N, k, DGM_N, k).sum(axis=(1, 3))
    count = valid.reshape(DGM_N, k, DGM_N, k).sum(axis=(1, 3))
    mean = np.where(count > 0, total / np.maximum(count, 1), 0)
    # 0 stands for "no height here"
    q = np.clip(np.rint(mean / DGM_STEP), 0, 65535).astype(np.int64)
    padded = np.zeros((DGM_N + 1, DGM_N + 1), np.int64)
    padded[1:, 1:] = q
    # what the left, upper and upper-left neighbours do not foretell
    rest = padded[1:, 1:] - padded[1:, :-1] - padded[:-1, 1:] + padded[:-1, :-1]
    wrapped = (rest & 0xFFFF).astype(np.uint16).astype(np.int16)
    zigzag = ((wrapped.astype(np.int32) << 1) ^ (wrapped.astype(np.int32) >> 15)).astype(np.uint16)
    planes = (zigzag & 0xFF).astype(np.uint8).tobytes() + (zigzag >> 8).astype(np.uint8).tobytes()
    return b'DGM2' + struct.pack('<HH', DGM_N, round(DGM_STEP * 1000)) + zlib.compress(planes, 9)


def take_dgm(archive):
    made = 0
    there = 0
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            # (the archives name their tiles DGM1_32_527_5718_1_he.tif – older ones in small letters)
            m = re.search(r'dgm1_32_(\d+)_(\d+)_1_he\.tif$', info.filename, re.IGNORECASE)
            if not m:
                continue
            out = os.path.join(DGM_OUT, f'{int(m[1])}_{int(m[2])}.dgm')
            if os.path.exists(out):
                there += 1
                continue
            data = reduce_tile(z.read(info))
            with open(out + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(out + '.tmp', out)
            made += 1
    return made, there


def take_lod2(archive, name):
    with zipfile.ZipFile(archive) as z:
        members = [i for i in z.infolist() if i.filename.lower().endswith('.gml')]
        if len(members) != 1:
            raise RuntimeError(f'{archive}: expected one .gml, found {len(members)}')
        node = subprocess.Popen(['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', name, '-'], stdin=subprocess.PIPE, cwd=ROOT)
        with z.open(members[0]) as gml:
            while True:
                chunk = gml.read(1 << 20)
                if not chunk:
                    break
                node.stdin.write(chunk)
        node.stdin.close()
        if node.wait() != 0:
            raise RuntimeError(f'tools/lod2-extract.ts failed for {name}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--list', action='store_true', help='show the districts and what they hold')
    ap.add_argument('--district', action='append', default=[], help='a district as the download centre names it (repeatable)')
    ap.add_argument('--municipality', action='append', default=[], help='only municipalities whose name contains this (repeatable)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    args = ap.parse_args()

    if args.list:
        for product in PRODUCTS:
            for d in districts(product):
                items = downloads(product, d)
                print(f'{product:5} {d:40} {len(items):3} files {sum(megabytes(i["fileSize"]) for i in items):7.0f} MB', flush=True)
        return
    if not args.district:
        ap.error('name at least one --district (see --list)')

    for sub in (DGM_OUT, os.path.join(DGM_OUT, '.done'), LOD2_OUT, os.path.join(LOD2_OUT, '.done'), TMP):
        os.makedirs(sub, exist_ok=True)
    t0 = time.time()
    fold = lambda s: s.lower().replace('ß', 'ss')  # noqa: E731 - (the two products spell some districts differently: Meißner / Meissner)
    known = {product: districts(product) for product in PRODUCTS if not args.only or args.only == product}
    for district in args.district:
        for product in ['lod2', 'dgm']:
            if product not in known:
                continue
            match = [d for d in known[product] if fold(d) == fold(district)]
            if not match:
                print(f'[fetch] no district "{district}" for {product}; there are: {", ".join(known[product])}', flush=True)
                continue
            for item in downloads(product, match[0]):
                name = plain(item['name'])
                if args.municipality and not any(m.lower() in name.lower() for m in args.municipality):
                    continue
                done = os.path.join(DGM_OUT if product == 'dgm' else LOD2_OUT, '.done', name)
                if os.path.exists(done):
                    continue
                archive = os.path.join(TMP, f'{name}-{product}.zip')
                started = time.time()
                fetch(item['downloadLink']['uri'], archive)
                loaded = time.time() - started
                if product == 'dgm':
                    made, there = take_dgm(archive)
                    if made + there == 0:
                        raise RuntimeError(f'{archive}: no terrain tiles found in it (are they named differently?)')
                    note = f'{made} tiles reduced, {there} already there'
                else:
                    take_lod2(archive, name)
                    note = 'buildings extracted'
                size = os.path.getsize(archive) / 1048576
                os.remove(archive)
                with open(done, 'w') as f:
                    f.write(item.get('creationDate', '') + '\n')
                print(
                    f'[fetch] {product} {match[0]} / {name}: {size:.0f} MB in {loaded:.0f} s, {note} '
                    f'({time.time() - started - loaded:.0f} s) – {(time.time() - t0) / 60:.0f} min so far',
                    flush=True,
                )
                time.sleep(1)

if __name__ == '__main__':
    sys.exit(main())
