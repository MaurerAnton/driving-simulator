# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2-DE) of
Hamburg – the open geodata of the state survey LGV, licence dl-de/by-2-0 – and
reduce them to what the map build reads.  It does for this state what
tools/fetch-geodata.py does for Hesse.

    python3 -I tools/fetch-hamburg.py --east 564..565 --north 5933..5934
    python3 -I tools/fetch-hamburg.py --east 561..570 --north 5929..5938 --only lod2
    python3 -I tools/fetch-hamburg.py --east 561..570 --north 5929..5938 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 565_5933 is the square the town hall (Rathaus)
lies in, 564_5933 the Speicherstadt.  Squares the state has no data for (parts
of the harbour, the Wadden Sea outside the tiles) are printed at the end – the
map is built where terrain is (tools/osm-extract.ts), so those squares simply
stay out of the map.

How Hamburg serves its data: not one file per tile, but two big ZIP archives,
one per product, each holding one file per kilometre square:

    DGM1   https://archiv.transparenz.hamburg.de/hmbtgarchive/HMDK/dgm1_hh_2022-04-30_243830_snap_2.zip
           880 tiles, dgm1_32_<E km>_<N km>_1_hh_2022.tif (1000 × 1000 GeoTIFF)
    LoD2   https://daten-hamburg.de/opendata/3d_stadtmodell_lod2/LoD2-DE_HH_2026-04-28.zip
           783 tiles, LoD2_32_<E km>_<N km>_1_HH.gml (CityGML 1.0, as in Hesse)

Both are read here member by member over HTTP range requests (Accept-Ranges:
bytes), so a rectangle costs only its own square metres and not 2 GB.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: both states then write the same bytes
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts

--published <map-assets/index.json> keeps this map from covering a tile another
map already has: two maps must not hold the same tile of 500 m, because in the
index of the parts a tile key belongs to one map.  Every kilometre square the
named index already knows is left out (with --on-overlap fail instead the
script stops and names them).

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py) and
node.  What is already there is skipped, so the command can be repeated after
an interruption.
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import importlib.util
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

# The two archives of the open geodata (Transparenzportal Hamburg, licence
# dl-de/by-2-0, no key, no registration).  The central directory of each says
# which kilometre squares it holds and where in the file each one begins.
ZIP = {
    'dgm': 'https://archiv.transparenz.hamburg.de/hmbtgarchive/HMDK/dgm1_hh_2022-04-30_243830_snap_2.zip',
    'lod2': 'https://daten-hamburg.de/opendata/3d_stadtmodell_lod2/LoD2-DE_HH_2026-04-28.zip',
}
# 2022 terrain: dgm1_hh_2022-04-30/dgm1_hh_2022/s32_565/dgm1_32_565_5933_1_hh_2022.tif
# 2026 buildings: LoD2_32_565_5933_1_HH.gml
TILE_IN = {
    'dgm': re.compile(r'dgm1_32_(\d+)_(\d+)_1_hh_?\d*\.tif$', re.IGNORECASE),
    'lod2': re.compile(r'LoD2_32_(\d+)_(\d+)_1_HH\.gml$', re.IGNORECASE),
}
CACHE = os.path.join(ROOT, 'data/work/hamburg')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'564..565' → (564, 565); '565' → (565, 565)"""
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
    """Part of a file (HTTP range request), with waiting and trying again."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Range': f'bytes={start}-{end}'})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[hamburg] {e}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'could not read {url}')


def central_directory(url):
    """Every member of the ZIP: name, method, sizes and where its data begins.

    Read from the end of the file (the end-of-central-directory record points to
    the directory itself), so a whole archive of 1.3 GB costs some 100 kB here.
    """
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, 'zip-' + hashlib.sha256(url.encode()).hexdigest()[:16] + '.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)
    # a HEAD for the length; the range request below tells us it accepts ranges
    head = urllib.request.Request(url, headers={'User-Agent': AGENT})
    head.get_method = lambda: 'HEAD'
    with urllib.request.urlopen(head, timeout=120) as r:
        size = int(r.headers['Content-Length'])
        if r.headers.get('Accept-Ranges') != 'bytes':
            raise RuntimeError(f'{url} does not answer range requests')
    tail = ask(url, max(0, size - (1 << 20)), size - 1)
    i = tail.rfind(b'PK\x05\x06')
    if i < 0:
        raise RuntimeError(f'{url}: no end-of-central-directory record')
    # sig 4, disk 2, cd disk 2, entries here 2, entries total 2, size 4, offset 4
    count, cd_size, cd_offset = struct.unpack('<HII', tail[i + 10:i + 20])
    say(f'[hamburg] {"%.0f" % (size / 1e6)} MB archive, {count} members')
    blob = ask(url, cd_offset, cd_offset + cd_size - 1)
    members = []
    p = 0
    for _ in range(count):
        if blob[p:p + 4] != b'PK\x01\x02':
            raise RuntimeError(f'{url}: directory damaged at {p}')
        method = struct.unpack('<H', blob[p + 10:p + 12])[0]
        compressed, plain = struct.unpack('<II', blob[p + 20:p + 28])
        name_len, extra_len, comment_len = struct.unpack('<HHH', blob[p + 28:p + 34])
        local = struct.unpack('<I', blob[p + 42:p + 46])[0]
        name = blob[p + 46:p + 46 + name_len].decode('utf-8', 'replace')
        members.append({
            'name': name,
            'method': method,
            'compressed': compressed,
            'plain': plain,
            'local': local,
        })
        p += 46 + name_len + extra_len + comment_len
    with open(cache + '.tmp', 'w') as f:
        json.dump(members, f)
    os.replace(cache + '.tmp', cache)
    return members


def tiles_of(product, members):
    """kilometre square → the member holding it."""
    pattern = TILE_IN[product]
    found = {}
    for m in members:
        match = pattern.search(m['name'])
        if match:
            found[(int(match.group(1)), int(match.group(2)))] = m
    return found


def take_member(url, member, dest):
    """One member of the archive, written to dest (– its own range of bytes)."""
    header = ask(url, member['local'], member['local'] + 29)
    name_len, extra_len = struct.unpack('<HH', header[26:30])
    start = member['local'] + 30 + name_len + extra_len
    raw = ask(url, start, start + member['compressed'] - 1)
    if len(raw) != member['compressed']:
        raise RuntimeError(f'{member["name"]}: {len(raw)} of {member["compressed"]} bytes')
    data = raw if member['method'] == 0 else zlib.decompress(raw, -15)
    if len(data) != member['plain']:
        raise RuntimeError(f'{member["name"]}: {len(data)} of {member["plain"]} bytes unpacked')
    with open(dest + '.tmp', 'wb') as f:
        f.write(data)
    os.replace(dest + '.tmp', dest)
    return len(data)


def take_dgm(url, member, east, north, tmp):
    """One GeoTIFF → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    take_member(url, member, tmp)
    with open(tmp, 'rb') as f:
        blob = GD.reduce_tile(f.read())
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    os.remove(tmp)
    return len(blob)


def take_lod2(url, member, east, north, name, tmp):
    """One CityGML file → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0
    take_member(url, member, tmp)
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
        raise RuntimeError(f'tools/lod2-extract.ts failed for {name} {east}_{north}')
    os.remove(tmp)
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {east}_{north}\n')
    return 1


def merge_lod2(name):
    """Put the squares of 2 km of every kilometre tile together into data/work/lod2/<name>.

    Every tile wrote into a staging directory of its own; neighbouring tiles share squares, and
    one square is one file of lines – so joining the files is all there is to it (a gzip file
    may hold several members one after the other).
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
    say(f'[hamburg] buildings joined from {len(staging)} tiles: {len(os.listdir(final))} squares of 2 km, '
        f'{units} units in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (565 or 564..565)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5933 or 5933..5934)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Hamburg', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares Hamburg has no data for into this file')
    ap.add_argument('--dgm-zip', help='another address for the terrain archive (default: the 2022 DGM1)')
    ap.add_argument('--lod2-zip', help='another address for the building archive (default: LoD2-DE 2026)')
    args = ap.parse_args()

    zip_of = dict(ZIP)
    if args.dgm_zip:
        zip_of['dgm'] = args.dgm_zip
    if args.lod2_zip:
        zip_of['lod2'] = args.lod2_zip

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'),
                GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[hamburg] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[hamburg] {args.published}: {len(known)} tiles of other maps')

    squares = [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    overlap = sorted(f'{e}_{n}' for e, n in squares if tile_keys(e, n) & known)
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[hamburg] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    products = ['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']
    work = []
    gaps = []
    for product in products:
        held = tiles_of(product, central_directory(zip_of[product]))
        for e, n in squares:
            if f'{e}_{n}' in skip:
                continue
            if (e, n) in held:
                work.append((product, e, n, held[(e, n)]))
            elif product == 'dgm':
                gaps.append(f'{e}_{n}')
        say(f'[hamburg] {product}: {sum(1 for w in work if w[0] == product)} tiles in the archive')

    if args.limit:
        work = work[: args.limit]
        say(f'[hamburg] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    bytes_seen = {'dgm': 0, 'lod2': 0}

    def one(item):
        product, e, n, member = item
        tmp = os.path.join(GD.TMP, f'hamburg-{product}-{e}_{n}')
        if product == 'dgm':
            made = take_dgm(zip_of[product], member, e, n, tmp + '.tif')
        else:
            made = take_lod2(zip_of[product], member, e, n, args.lod2_name, tmp + '.gml')
        return product, e, n, made

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, e, n, made = item
            if made:
                counts[product] += 1
                bytes_seen[product] += made
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[hamburg] {done}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[hamburg] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there), '
        f'{counts["lod2"]} tiles of buildings ({again["lod2"]} were there) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[hamburg] no terrain of Hamburg for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
