#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2) of the
Free Hanseatic City of Bremen – the open geodata of the Landesamt GeoInformation
Bremen, licence CC BY 4.0 – and reduce them to what the map build reads.  It
does for this state what tools/fetch-geodata.py does for Hesse; the difference
is the shape of what is served: Bremen keeps one big archive per product and
per city (Bremen and Bremerhaven), so nothing but the wanted tiles is read from
them – every member of a zip is a range request of its own.

    python3 -I tools/fetch-bremen.py --east 486..487 --north 5880..5881
    python3 -I tools/fetch-bremen.py --east 480..496 --north 5878..5892 --only dgm
    python3 -I tools/fetch-bremen.py --east 472..474 --north 5931..5933 --source bhv
    python3 -I tools/fetch-bremen.py --east 486..487 --north 5880..5881 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 487_5881 is the square the market place of
Bremen lies in.  Squares the archive holds no tile for are printed at the end –
the map is built where terrain is (tools/osm-extract.ts), so those squares
simply stay out of the map.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: every state then writes the same bytes
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts

The buildings come in squares of 2 km (LoD2_32_<E>_<N>_2_HB.gml holds the
square from E km to E+2 km and from N km to N+2 km), the terrain in squares of
1 km – so one download of buildings serves four squares of terrain, and every
square of 2 km that touches the rectangle is fetched.

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

The licence: the open-data pages of the state (geo.bremen.de) and the metadata
at metaver.de say for both products "Nutzungsbedingungen: Creative Commons
Namensnennung 4.0 International", "Quellenvermerk: Landesamt GeoInformation
Bremen" and "Es gelten keine Zugriffsbeschränkungen" – open data, no key, no
registration; what is asked for is the note of the source, which the map build
puts into map.json.

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py) and
node.  What is already there is skipped, so the command can be repeated after
an interruption.
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
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import zlib

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

# the one archive per product and per city; both are open data and answered by the
# download server of the state without a key, and both answer range requests
ZIP = {
    'dgm': {
        'hb': 'https://gdi2.geo.bremen.de/inspire/download/DGM/data/Gitternetz_DGM1_2017_HB_ASCII_XYZ.zip',
        'bhv': 'https://gdi2.geo.bremen.de/inspire/download/DGM/data/Gitternetz_DGM1_2015_BHV_ASCII_XYZ.zip',
    },
    'lod2': {
        'hb': 'https://gdi2.geo.bremen.de/inspire/download/LoD/data/LOD2_CITYGML_HB.zip',
        'bhv': 'https://gdi2.geo.bremen.de/inspire/download/LoD/data/LOD2_CITYGML_BHV.zip',
    },
}
# the tiles inside them: Bremerhaven writes its easting with an underscore too much
DGM_NAME = re.compile(r'dgm1_32(\d+)_+(\d+)_1_hb\.xyz$', re.IGNORECASE)
LOD2_NAME = re.compile(r'LoD2_32_(\d+)_(\d+)_2_HB\.gml$')
CACHE = os.path.join(ROOT, 'data/work/bremen')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

# how many bytes of the end of an archive are read to find its directory
TAIL = 8 << 20
CHUNK = 4 << 20

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'486..487' → (486, 487); '486' → (486, 486)"""
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


def ask(url, start, end, attempts=6):
    """One part of an archive (Range), with patience: the server of the state is not always quick."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Range': f'bytes={start}-{end}'})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                got = r.read()
            if len(got) != end - start + 1:
                raise OSError(f'asked {end - start + 1} B, got {len(got)} B')
            return got
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[bremen] {e}; trying again')
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('not reached')


def remote_size(url, attempts=6):
    """How long the archive is – without reading it."""
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': AGENT}, method='HEAD')
            with urllib.request.urlopen(request, timeout=120) as r:
                return int(r.headers['Content-Length'])
        except Exception as e:  # noqa: BLE001
            if attempt == attempts - 1:
                raise
            say(f'[bremen] HEAD: {e}; trying again')
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('not reached')


def directory(url, base, size, tail=TAIL):
    """Read the central directory of the zip that lies at `base` in `url` and is `size` bytes long.

    Returns {name: {size, csize, off, method}} with offsets from `base`.  Only the end of the
    archive is read – a whole archive of terrain is over a gigabyte, its directory a few
    hundred kilobytes.
    """
    if size <= 0:
        raise RuntimeError(f'no archive at {url}')
    start = max(0, size - min(tail, size))
    data = ask(url, base + start, base + size - 1)
    at = data.rfind(b'PK\x05\x06')
    if at < 0:
        raise RuntimeError(f'no directory found at the end of {url}')
    eocd = data[at:at + 22]
    cd_size = struct.unpack('<I', eocd[12:16])[0]
    if cd_size + 22 > len(data):
        # the directory did not fit into what was read: read again with room for it
        return directory(url, base, size, tail=cd_size + 65536)
    p = at - cd_size
    found = {}
    while p + 46 <= len(data) and data[p:p + 4] == b'PK\x01\x02':
        method = struct.unpack('<H', data[p + 10:p + 12])[0]
        csize = struct.unpack('<I', data[p + 20:p + 24])[0]
        size_of = struct.unpack('<I', data[p + 24:p + 28])[0]
        nlen = struct.unpack('<H', data[p + 28:p + 30])[0]
        elen = struct.unpack('<H', data[p + 30:p + 32])[0]
        clen = struct.unpack('<H', data[p + 32:p + 34])[0]
        name = data[p + 46:p + 46 + nlen].decode('latin1')
        off = struct.unpack('<I', data[p + 42:p + 46])[0]
        if not name.endswith('/'):
            found[name] = {'name': name, 'size': size_of, 'csize': csize, 'off': off, 'method': method}
        p += 46 + nlen + elen + clen
    return found


def data_start(url, base, entry):
    """Where the bytes of one member begin: after its local header (30 B + name + extra)."""
    head = ask(url, base + entry['off'], base + entry['off'] + 127)
    nlen = struct.unpack('<H', head[26:28])[0]
    elen = struct.unpack('<H', head[28:30])[0]
    return base + entry['off'] + 30 + nlen + elen


def read_member(url, base, entry):
    """One member as bytes."""
    start = data_start(url, base, entry)
    raw = ask(url, start, start + entry['csize'] - 1)
    if entry['method'] == 0:
        return raw
    d = zlib.decompressobj(-15)
    return d.decompress(raw) + d.flush()


def copy_member(url, base, entry, out, label=''):
    """One member read into `out` part by part – a square of 2 km of buildings is large."""
    start = data_start(url, base, entry)
    end = start + entry['csize'] - 1
    d = zlib.decompressobj(-15) if entry['method'] == 8 else None
    pos = start
    while pos <= end:
        stop = min(pos + CHUNK - 1, end)
        raw = ask(url, pos, stop)
        out.write(d.decompress(raw) if d else raw)
        pos = stop + 1
    if d:
        out.write(d.flush())
    if label:
        say(f'[bremen] {label} read ({entry["csize"] >> 20} MB)')


def open_zip(product, source):
    """{tile key: member} of one product, the key '<E km>_<N km>' of the square the member holds.

    The buildings lie in a zip within the zip (a stored one), so its directory has to be read
    from the inner archive; the terrain archive is flat.  The directory is kept in data/work, so
    a second run need not read it again.
    """
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'{product}-{source}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            tiles = json.load(f)
        say(f'[bremen] {product}: {len(tiles)} tiles from the directory read before')
        return tiles
    url = ZIP[product][source]
    size = remote_size(url)
    say(f'[bremen] {os.path.basename(url)}: {size >> 20} MB')
    outer = directory(url, 0, size)
    if product == 'lod2':
        inner = sorted(outer.values(), key=lambda e: -e['size'])
        if not inner or not inner[0]['name'].lower().endswith('.zip'):
            raise RuntimeError(f'no inner archive of buildings in {url}: {list(outer)[:5]}')
        member = inner[0]
        base = data_start(url, 0, member)
        entries = directory(url, base, member['size'])
        say(f'[bremen] inner archive {member["name"]}: {len(entries)} members')
    else:
        base = 0
        entries = outer
    tiles = {}
    for name, entry in entries.items():
        m = DGM_NAME.search(name) if product == 'dgm' else LOD2_NAME.search(name)
        if not m:
            continue
        key = f'{int(m[1])}_{int(m[2])}'
        tiles[key] = {'name': name, 'size': entry['size'], 'csize': entry['csize'],
                      'off': entry['off'], 'method': entry['method'], 'base': base}
    if tiles:
        with open(cache + '.tmp', 'w') as f:
            json.dump(tiles, f)
        os.replace(cache + '.tmp', cache)
    return tiles


def xyz_to_tiff(raw):
    """One kilometre tile of heights as ASCII x y z → a GeoTIFF of 1000 × 1000 cells of 1 m.

    The lines are written x ascending, y descending (the northern edge first) – which is what
    tools/mapgen/dgm.ts expects of row 0 – and the header line 'x y z' comes before them.
    """
    import numpy as np
    from PIL import Image

    text = raw.decode('latin1')
    for skip in (0, 1):
        lines = text.splitlines()
        if skip:
            lines = lines[1:]
        parts = ' '.join(lines).split()
        if len(parts) % 3:
            continue
        try:
            values = np.array(parts, dtype=np.float32)
        except ValueError:
            continue
        if values.size == 3 * 1000 * 1000:
            grid = values.reshape(1000, 1000, 3)[:, :, 2]
            buf = io.BytesIO()
            Image.fromarray(grid, mode='F').save(buf, format='TIFF')
            return buf.getvalue()
    raise RuntimeError(f'no grid of 1000 x 1000 in {len(parts) // 3} rows of heights')


def take_dgm(url, entry, east, north):
    """One tile of heights → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    blob = GD.reduce_tile(xyz_to_tiff(read_member(url, entry['base'], entry)))
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def take_lod2(url, entry, east, north, name):
    """One CityGML square of 2 km → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the square, because tools/lod2-extract.ts empties the directory it writes
    (rmSync): called once per square with the same name, only the last square would stay.  The
    dot in front keeps the map build from reading the staging directory as well; merge_lod2()
    puts the squares together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', f'.{name}-{east}_{north}', '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    try:
        copy_member(url, entry['base'], entry, node.stdin)
    except BaseException:
        node.stdin.close()
        node.wait()
        raise
    node.stdin.close()
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts failed for {name} {east}_{north}')
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {east}_{north}\n')
    return 1


def units_of(path):
    with gzip.open(path, 'rb') as f:
        return sum(1 for _ in f)


def merge_lod2(name):
    """Put the squares of 2 km of every download together into data/work/lod2/<name>.

    Every download wrote into a staging directory of its own; neighbouring downloads do not share
    squares here (every square comes from one member), so joining the files is all there is to it
    – but the count of units has to be the same afterwards as it was before, or buildings were
    lost on the way.
    """
    final = os.path.join(GD.LOD2_OUT, name)
    staging = sorted(d for d in os.listdir(GD.LOD2_OUT) if d.startswith(f'.{name}-'))
    if not staging:
        return None
    before = 0
    for part in staging:
        src = os.path.join(GD.LOD2_OUT, part)
        for square in sorted(os.listdir(src)):
            before += units_of(os.path.join(src, square))
            os.makedirs(final, exist_ok=True)
            with open(os.path.join(src, square), 'rb') as a, open(os.path.join(final, square), 'ab') as b:
                shutil.copyfileobj(a, b)
        shutil.rmtree(src)
    after = sum(units_of(os.path.join(final, s)) for s in sorted(os.listdir(final)))
    if after != before:
        raise RuntimeError(f'{before} units went in, {after} came out of data/work/lod2/{name}')
    say(f'[bremen] buildings joined from {len(staging)} downloads: {len(os.listdir(final))} squares of 2 km, '
        f'{after} units in data/work/lod2/{name}')
    return after


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (487 or 486..487)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5881 or 5880..5883)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--source', choices=['hb', 'bhv'], default='hb',
                    help='Bremen (hb) or Bremerhaven (bhv)')
    ap.add_argument('--lod2-name', default='Bremen', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are read at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no terrain for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[bremen] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} squares of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[bremen] {args.published}: {len(known)} tiles of other maps')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[bremen] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    gaps = []
    for product in (['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']):
        tiles = open_zip(product, args.source)
        url = ZIP[product][args.source]
        if product == 'dgm':
            for e in range(e0, e1 + 1):
                for n in range(n0, n1 + 1):
                    if f'{e}_{n}' in skip:
                        continue
                    if f'{e}_{n}' in tiles:
                        work.append((product, e, n, url, tiles[f'{e}_{n}']))
                    elif f'{e}_{n}' not in gaps:
                        gaps.append(f'{e}_{n}')
        else:
            # every square of 2 km that touches the rectangle: it serves four squares of 1 km
            for key, entry in tiles.items():
                east, north = (int(v) for v in key.split('_'))
                if east > e1 or east + 1 < e0 or north > n1 or north + 1 < n0:
                    continue
                if all(f'{e}_{n}' in skip for e in (east, east + 1) for n in (north, north + 1)):
                    continue
                work.append((product, east, north, url, entry))
        say(f'[bremen] {product}: {sum(1 for w in work if w[0] == product)} tiles to read')

    if args.limit:
        work = work[: args.limit]
        say(f'[bremen] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    bytes_ = {'dgm': 0}

    def one(item):
        product, e, n, url, entry = item
        if product == 'dgm':
            made = take_dgm(url, entry, e, n)
        else:
            made = take_lod2(url, entry, e, n, args.lod2_name)
        return product, e, n, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, e, n, made = item
            if made:
                counts[product] += 1
                if product == 'dgm':
                    bytes_['dgm'] += made
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[bremen] {done}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[bremen] done: {counts["dgm"]} tiles of terrain ({bytes_["dgm"] >> 20} MB, {again["dgm"]} were there), '
        f'{counts["lod2"]} squares of buildings ({again["lod2"]} were there) '
        f'in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[bremen] no terrain of Bremen for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
