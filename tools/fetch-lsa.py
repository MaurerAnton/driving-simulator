#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and building models (LoD2) of Saxony-
Anhalt – the open geodata of the state survey LVermGeo, licence
"Datenlizenz Deutschland – Namensnennung – Version 2.0" (dl-de/by-2-0), so
nothing here needs a key, only a source note in the map – and reduce them to
what the map build reads.  It does for this state what tools/fetch-geodata.py
does for Hesse.

    python3 -I tools/fetch-lsa.py --east 673..687 --north 5771..5785
    python3 -I tools/fetch-lsa.py --east 673..687 --north 5771..5785 --only dgm
    python3 -I tools/fetch-lsa.py --east 673..687 --north 5771..5785 --published map-assets/index.json

--east/--north are UTM32 kilometre squares (EPSG:25832), the grid the terrain
tiles are cut from: 680_5778 is the square the city of Magdeburg lies in.
Squares outside the state (to the east and west mostly) get no terrain – they
are printed at the end and the map stays out of them (tools/osm-extract.ts
builds where terrain is).

Terrain:   one 1 km square per WCS GetCoverage (ows_WCS_ST_DGM1, native
           EPSG:25832, so no reprojection) – data/work/dgm2/<E>_<N>.dgm
Buildings: the state's four LoD2 archives of the whole state (LoD2-1.zip …
           LoD2-4.zip, several GB) are never downloaded: their central
           directories and the CityGML files of the squares of 2 km in them
           are read through HTTP Range requests, and every one of those goes
           through tools/lod2-extract.ts – data/work/lod2/<name>/<x>_<z>.ndjson.gz

What the licence says, taken from the portal itself: on the page of the open
data (https://www.geodatenportal.sachsen-anhalt.de/de/gdp-open-data.html)
"Für die nachfolgend kostenfrei bereitgestellten Daten … gelten die
Nutzungsbedingungen des LVermGeo, wonach diese unter der Open-Data-Lizenz
'Datenlizenz Deutschland – Namensnennung – Version 2.0' genutzt werden
dürfen", and in the GetCapabilities of the WCS under ows:Fees:
"Datenlizenz Deutschland - Namensnennung, Version 2.0,
https://geodatenportal.sachsen-anhalt.de/gfds/datei/anzeigen/id/3567,501/nutzungsbedingungen_b.pdf".
So the map names the source (see .github/workflows/build-map-lsa.yml).

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
import urllib.parse
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
# the terrain as a coverage of 1 m: one GetCoverage per kilometre square, in UTM32
WCS = 'https://www.geodatenportal.sachsen-anhalt.de/ows_WCS_ST_DGM1'
# the buildings: four archives of the whole state, each holding one CityGML per square of 2 km
LOD2_NAME = ('https://www.geodatenportal.sachsen-anhalt.de/gfds_webshare/download/LVermGeo/'
             'Geodatenportal/Online-Bereitstellung-LVermGeo/3D/LoD2-%s.zip')
LOD2_PARTS = ('1', '2', '3', '4')
LOD2_MEMBER = re.compile(r'LoD2_32_(\d+)_(\d+)_2_ST\.gml$')
CACHE = os.path.join(ROOT, 'data/work/lsa')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()
_local = threading.local()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'673..687' → (673, 687); '680' → (680, 680)"""
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


def urlopen(url, attempts=5):
    """The bytes of one answer, tried again when the network or the service fails."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    last = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            last = e
            say(f'[lsa] {e}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


class Http:
    """A read-only file over HTTP that answers Range requests – for reading one member out of a zip of a gigabyte."""

    def __init__(self, url):
        self.url = url
        self.pos = 0
        self.buf = b''
        self.buf_start = 0
        request = urllib.request.Request(url, headers={'User-Agent': AGENT})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=120) as r:
                    self.size = int(r.headers['Content-Length'])
                    ranges = r.headers.get('Accept-Ranges')
                break
            except Exception:  # noqa: BLE001
                if attempt == 4:
                    raise
                time.sleep(5 * (attempt + 1))
        if ranges != 'bytes':
            raise RuntimeError(f'{url}: the server does not answer Range requests')

    def seekable(self):
        return True

    def seek(self, off, whence=0):
        if whence == 1:
            off = self.pos + off
        elif whence == 2:
            off = self.size + off
        self.pos = max(0, int(off))

    def tell(self):
        return self.pos

    def _fill(self, want):
        start = self.pos
        end = min(self.size, start + max(want, 1 << 17)) - 1
        request = urllib.request.Request(self.url, headers={'User-Agent': AGENT, 'Range': f'bytes={start}-{end}'})
        last = None
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=300) as r:
                    if r.status != 206:
                        raise RuntimeError(f'expected 206 Partial Content, got {r.status}')
                    data = r.read()
                self.buf_start = start
                self.buf = data
                return
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(5 * (attempt + 1))
        raise RuntimeError(f'{self.url}: bytes {start}-{end}: {last}')

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        out = b''
        while len(out) < n and self.pos < self.size:
            if not (self.buf_start <= self.pos < self.buf_start + len(self.buf)):
                self._fill(n - len(out))
            off = self.pos - self.buf_start
            out += self.buf[off:off + (n - len(out))]
            self.pos = min(self.size, self.pos + (n - len(out)))
        return out

    def get(self, start, length):
        """Exactly length bytes from start."""
        self.seek(start)
        return self.read(length)


def central_directory(url):
    """Every file of a zip, from its central directory alone – the archive itself stays where it is."""
    handle = Http(url)
    tail = handle.get(max(0, handle.size - (1 << 16)), min(handle.size, 1 << 16))
    at = tail.rfind(b'PK\x05\x06')
    if at < 0:
        raise RuntimeError(f'{url}: no end of central directory')
    count, = struct.unpack('<H', tail[at + 8:at + 10])
    cd_size, cd_at = struct.unpack('<II', tail[at + 12:at + 20])
    if count == 0xFFFF or cd_at == 0xFFFFFFFF:
        loc = tail.rfind(b'PK\x06\x07')
        if loc < 0:
            raise RuntimeError(f'{url}: no zip64 end of central directory')
        cd_at, = struct.unpack('<Q', tail[loc + 8:loc + 16])
        head = handle.get(cd_at, 56)
        if head[:4] != b'PK\x06\x06':
            raise RuntimeError(f'{url}: no zip64 central directory')
        count, = struct.unpack('<Q', head[32:40])
        cd_size, = struct.unpack('<Q', head[40:48])
    cd = handle.get(cd_at, cd_size)
    files = []
    pos = 0
    for _ in range(count):
        if cd[pos:pos + 4] != b'PK\x01\x02':
            break
        head = cd[pos:pos + 46]
        method, = struct.unpack('<H', head[10:12])
        crc, csize, size = struct.unpack('<III', head[16:28])
        name_len, extra_len, comment_len = struct.unpack('<HHH', head[28:34])
        offset, = struct.unpack('<I', head[42:46])
        name = cd[pos + 46:pos + 46 + name_len].decode('utf-8', 'replace')
        extra = cd[pos + 46 + name_len:pos + 46 + name_len + extra_len]
        if csize == 0xFFFFFFFF or offset == 0xFFFFFFFF:
            p = 0
            while p + 4 <= len(extra):
                tag, room = struct.unpack('<HH', extra[p:p + 4])
                body = extra[p + 4:p + 4 + room]
                if tag == 1:
                    want = 0
                    if size == 0xFFFFFFFF:
                        size, = struct.unpack('<Q', body[want:want + 8])
                        want += 8
                    if csize == 0xFFFFFFFF:
                        csize, = struct.unpack('<Q', body[want:want + 8])
                        want += 8
                    if offset == 0xFFFFFFFF:
                        offset, = struct.unpack('<Q', body[want:want + 8])
                    break
                p += 4 + room
        files.append({'name': name, 'size': size, 'csize': csize, 'crc': crc, 'method': method, 'offset': offset})
        pos += 46 + name_len + extra_len + comment_len
    return files


def read_member(handle, member):
    """The bytes of one file of a zip, read through the handle of its archive."""
    head = handle.get(member['offset'], 30)
    if head[:4] != b'PK\x03\x04':
        raise RuntimeError(f"{member['name']}: no local file header")
    name_len, extra_len = struct.unpack('<HH', head[26:30])
    raw = handle.get(member['offset'] + 30 + name_len + extra_len, member['csize'])
    if member['method'] == 0:
        return raw
    if member['method'] != 8:
        raise RuntimeError(f"{member['name']}: compression {member['method']} is not read here")
    return zlib.decompress(raw, -15)


def part_index(part):
    """The files of one LoD2 archive (asked once, then kept in data/work/lsa)."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, f'lod2-{part}.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)
    files = central_directory(LOD2_NAME % part)
    with open(cache + '.tmp', 'w') as f:
        json.dump(files, f)
    os.replace(cache + '.tmp', cache)
    return files


def handle_of(url):
    """One handle of this url per worker (a handle has one position; it cannot be shared)."""
    handles = getattr(_local, 'handles', None)
    if handles is None:
        handles = {}
        _local.handles = handles
    if url not in handles:
        handles[url] = Http(url)
    return handles[url]


def take_dgm(east, north):
    """One kilometre square of terrain → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0
    query = urllib.parse.urlencode({
        'SERVICE': 'WCS',
        'VERSION': '2.0.1',
        'REQUEST': 'GetCoverage',
        'COVERAGEID': 'Coverage1',
        'FORMAT': 'image/tiff',
        'SUBSET': [f'x({east * 1000},{(east + 1) * 1000})', f'y({north * 1000},{(north + 1) * 1000})'],
    }, doseq=True)
    data = urlopen(f'{WCS}?{query}')
    # the answer is multipart/related: the coverage description first, the GeoTIFF second
    at = min((at for at in (data.find(m) for m in (b'II*\x00', b'MM\x00*')) if at >= 0), default=-1)
    if at < 0:
        raise RuntimeError(f'{east}_{north}: no GeoTIFF in {len(data)} bytes ({data[:200]!r})')
    blob = GD.reduce_tile(data[at:])
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob)


def take_lod2(part, member, key, name):
    """One CityGML file of a square of 2 km → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{key}')
    if os.path.exists(done):
        return 0
    data = read_member(handle_of(LOD2_NAME % part), member)
    node = subprocess.Popen(
        ['node', os.path.join(ROOT, 'tools/lod2-extract.ts'), '--name', f'.{name}-{key}', '-'],
        stdin=subprocess.PIPE,
        cwd=ROOT,
    )
    try:
        node.stdin.write(data)
        node.stdin.close()
    except BrokenPipeError:
        pass
    if node.wait() != 0:
        raise RuntimeError(f'tools/lod2-extract.ts failed for {member["name"]}')
    os.makedirs(os.path.dirname(done), exist_ok=True)
    with open(done, 'w') as f:
        f.write(f'{name} {key} {member["name"]}\n')
    return 1


def merge_lod2(name):
    """Put the squares of 2 km of every tile together into data/work/lod2/<name>.

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
    say(f'[lsa] buildings joined from {len(staging)} tiles: {len(os.listdir(final))} squares of 2 km, '
        f'{units} units in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (680 or 673..687)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5778 or 5771..5785)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--lod2-name', default='Sachsen-Anhalt', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are fetched at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no terrain for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    say(f'[lsa] east {e0}..{e1} km, north {n0}..{n1} km – {(e1 - e0 + 1) * (n1 - n0 + 1)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[lsa] {args.published}: {len(known)} tiles of other maps')

    overlap = sorted(
        f'{e}_{n}'
        for e in range(e0, e1 + 1)
        for n in range(n0, n1 + 1)
        if tile_keys(e, n) & known
    )
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[lsa] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    work = []
    if args.only != 'lod2':
        work += [('dgm', None, e, n, None)
                 for e in range(e0, e1 + 1)
                 for n in range(n0, n1 + 1)
                 if f'{e}_{n}' not in skip]

    lod2_jobs = []
    if args.only != 'dgm':
        # a CityGML file holds a square of 2 km, named after its lower left corner
        low_e = (e0 // 2) * 2
        low_n = (n0 // 2) * 2
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(LOD2_PARTS)) as pool:
            indexes = {part: pool.submit(part_index, part) for part in LOD2_PARTS}
            for part in LOD2_PARTS:
                for member in indexes[part].result():
                    found = LOD2_MEMBER.search(member['name'])
                    if not found:
                        continue
                    tile_e, tile_n = int(found[1]), int(found[2])
                    if tile_e + 2 <= e0 or tile_e > e1 or tile_n + 2 <= n0 or tile_n > n1:
                        continue
                    key = f'{tile_e}_{tile_n}'
                    done = os.path.join(GD.LOD2_OUT, '.done', f'{args.lod2_name}-{key}')
                    if os.path.exists(done):
                        continue
                    lod2_jobs.append(('lod2', part, tile_e, tile_n, member))
        say(f'[lsa] lod2: {len(lod2_jobs)} squares of 2 km in the archives of the state')
        work += [('lod2', part, e, n, member) for part, e, n, member in
                 ((j[1], j[2], j[3], j[4]) for j in lod2_jobs)]

    if args.limit:
        work = work[: args.limit]
        say(f'[lsa] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    gaps = []

    def one(item):
        product, part, e, n, member = item
        if product == 'dgm':
            return product, take_dgm(e, n)
        return product, take_lod2(part, member, f'{e}_{n}', args.lod2_name)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(one, item) for item in work]
        for done_count, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            try:
                product, made = future.result()
            except Exception as e:  # noqa: BLE001 - one failing square does not spoil the others
                item = work[futures.index(future)]
                if product_of(item) == 'dgm':
                    gaps.append(f'{item[2]}_{item[3]}')
                    say(f'[lsa] no terrain for {item[2]}_{item[3]}: {e}')
                else:
                    say(f'[lsa] no buildings for {item[2]}_{item[3]}: {e}')
                continue
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done_count % 25 == 0 or done_count == len(work):
                say(f'[lsa] {done_count}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[lsa] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there), '
        f'{counts["lod2"]} tiles of buildings ({again["lod2"]} were there) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    if gaps:
        say(f'[lsa] no terrain of Saxony-Anhalt for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(sorted(gaps)[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(sorted(gaps)) + '\n')
    return 0


def product_of(item):
    return item[0]


if __name__ == '__main__':
    sys.exit(main())
