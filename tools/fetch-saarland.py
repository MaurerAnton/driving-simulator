#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2) of the
Saarland – the open geodata of the state survey LVGL (shop.lvgl.saarland.de),
licence dl-de/by-2-0, quoted by the Saarland geoportal itself as
"Lizenz: dl-de/by-2-0 - Datenlizenz Deutschland Namensnennung 2.0 -
https://www.govdata.de/dl-de/by-2-0 - Quellenvermerk: © GeoBasis DE/LVGL-SL
(Jahr)" – and reduce them to what the map build reads.  It does for this state
what tools/fetch-geodata.py does for Hesse; the difference is the shape of what
is served: the LVGL packs every district into one zip holding one member per
kilometre tile, so this script reads the zip directory of each district first
and then single members – a rectangle of any shape costs only its own tiles
(SB alone is 881 MB of terrain).

    python3 -I tools/fetch-saarland.py --east 353..354 --north 5455..5456
    python3 -I tools/fetch-saarland.py --east 341..364 --north 5448..5464 --only dgm
    python3 -I tools/fetch-saarland.py --east 341..364 --north 5448..5464 --published map-assets/index.json
    python3 -I tools/fetch-saarland.py --east 341..364 --north 5448..5464 --district SB --district SPK

--east/--north are UTM32 kilometre squares (EPSG:25832), the same grid the
terrain tiles are named after: 354_5456 is the square the town hall of
Saarbrücken stands in.  Which tiles exist, the directories of the district
zips say; squares the state has no data for (French land inside the rectangle)
are printed at the end – the map is built where terrain is
(tools/osm-extract.ts), so those squares simply stay out of the map.

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – reduced by tools/fetch-geodata.py,
           which is read here for it: both states then write the same bytes
           Source: OD_DGM1_2025_tif_LK/DGM1_tif_<district>_EPSG-25832_Entstehung-<year>.zip
           member   DGM1_tif_<district>/dgm1_32_<E 3>_<N 4>_1_SL_<year>.tif
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts
           Source: OD_Gebäudemodelle_LoD2_gml_LK/<district>_LOD2BWK_gml.zip
           member   <district>_LOD2BWK_gml/LoD2_32_<E 3>_<N 4>_1_SL.gml
           Districts: SB, SLS, NK, WND, MZG, SPK.

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
import base64
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
# The open geodata lie on the LVGL cloud as a public share – a link without
# registration.  https://www.shop.lvgl.saarland.de/cloud/freiegeobasisdaten
# leads to it (302 to /cloud/index.php/s/<token>), and the token of the link is
# the user name of the WebDAV read access (empty password).  If the LVGL should
# ever create a new share, the link above is read first and the old token only
# used if that fails.
ENTRY = 'https://www.shop.lvgl.saarland.de/cloud/freiegeobasisdaten?dir=/OD_DGM1_2025_tif_LK'
TOKEN = 'NK8ndP55qAqGEZD'
DAV = 'https://www.shop.lvgl.saarland.de/cloud/public.php/webdav'
SHARE = 'OD_DGM1_2025_tif_LK'
PRODUCT_DIR = {'dgm': 'OD_DGM1_2025_tif_LK', 'lod2': 'OD_Gebäudemodelle_LoD2_gml_LK'}
# the district zips: SB is H030, but the share names every district by its sign
ZIP = {
    'dgm': re.compile(r'^DGM1_tif_([A-Z]{2,3})_EPSG-25832_Entstehung-(\d{4})\.zip$'),
    'lod2': re.compile(r'^([A-Z]{2,3})_LOD2BWK_gml\.zip$'),
}
# the members inside them: one kilometre tile each
MEMBER = {
    'dgm': re.compile(r'^dgm1_32_(\d{3})_(\d{4})_1_SL(?:_\d{4})?\.tif$', re.IGNORECASE),
    'lod2': re.compile(r'^LoD2_32_(\d{3})_(\d{4})_1_SL\.gml$', re.IGNORECASE),
}
CACHE = os.path.join(ROOT, 'data/work/saarland')

# the map's frame (src/geo/utm.ts) and its grid of tiles of 500 m (src/world/grid.ts)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000

_print = threading.Lock()


def say(text):
    with _print:
        print(text, flush=True)


def span(text):
    """'545..556' → (545, 556); '545' → (545, 545)"""
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


class Redirects(urllib.request.HTTPRedirectHandler):
    """Notes every URL a request is sent on to (the share token stands in the last one)."""

    def __init__(self):
        self.visited = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.visited.append(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def share_token():
    handler = Redirects()
    opener = urllib.request.build_opener(handler)
    try:
        with opener.open(urllib.request.Request(ENTRY, headers={'User-Agent': AGENT}), timeout=60) as r:
            r.read(1)
    except Exception as e:  # noqa: BLE001 - the link only leads the way; the known token follows
        say(f'[saar] {ENTRY}: {e} – the token written in the script is used')
        return TOKEN
    for url in handler.visited + [ENTRY]:
        m = re.search(r'/s/([A-Za-z0-9]{10,})', url)
        if m:
            say(f'[saar] open geodata share: {m[1]} (read from {url})')
            return m[1]
    return TOKEN


def auth(token):
    return {'User-Agent': AGENT, 'Authorization': 'Basic ' + base64.b64encode(f'{token}:'.encode()).decode()}


def read(url, token, start=None, end=None, attempts=5):
    """A GET on the share – with Range only the wanted bytes are moved."""
    headers = auth(token)
    if start is not None:
        headers['Range'] = 'bytes=-%d' % -start if start < 0 else 'bytes=%d-%s' % (start, '' if end is None else end)
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[saar] {e} for {os.path.basename(urllib.parse.unquote(url))}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def propfind(url, token, attempts=5):
    """What one directory of the share holds (WebDAV PROPFIND, Depth 1)."""
    body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
    headers = dict(auth(token), **{'Depth': '1', 'Content-Type': 'application/xml'})
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, data=body.encode(), headers=headers, method='PROPFIND')
            with urllib.request.urlopen(request, timeout=180) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:  # noqa: BLE001 - any network trouble: wait and try again
            if attempt == attempts - 1:
                raise
            say(f'[saar] {e} for {os.path.basename(urllib.parse.unquote(url))}; trying again')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def dav_path(product, name):
    """The WebDAV URL of a file of the share (its own path may hold umlauts).

    The first element after files/ is the share's own name as the geoportal link gives it; the
    share answers for it as well as for any other – what counts is the product directory after
    it.
    """
    return f'{DAV}/files/{SHARE}/{urllib.parse.quote(PRODUCT_DIR[product])}/{urllib.parse.quote(name)}'


def members(product, token):
    """Which district zips the share holds: district → (name, url) of the newest one."""
    found = {}
    xml = propfind(f'{DAV}/files/{SHARE}/{urllib.parse.quote(PRODUCT_DIR[product])}/', token)
    for href in re.findall(r'<d:href>([^<]+)</d:href>', xml):
        name = urllib.parse.unquote(href.rstrip('/').rsplit('/', 1)[-1])
        m = ZIP[product].match(name)
        if not m:
            continue
        year = int(m[2]) if product == 'dgm' and m[2] else 0
        key = m[1]
        if key not in found or found[key][0] < year:
            found[key] = (year, name)
    return {key: dav_path(product, name) for key, (year, name) in sorted(found.items())}


def central_directory(url, token):
    """The members of one district zip: name → (offset, packed size, plain size, method).

    Only the directory at the end of the archive is read (and that only once: it is kept
    in data/work/saarland), never the whole zip – SB alone holds 881 MB of terrain.
    """
    os.makedirs(CACHE, exist_ok=True)
    key = re.sub(r'[^0-9A-Za-z]+', '-', urllib.parse.unquote(url.rsplit('/', 1)[-1]))
    cache = os.path.join(CACHE, key + '.json')
    if os.path.exists(cache):
        with open(cache) as f:
            return {n: tuple(v) for n, v in json.load(f).items()}
    size = zip_size(url, token)
    tail = read(url, token, start=max(0, size - 66000), end=size - 1)
    mark = tail.rfind(b'PK\x05\x06')
    if mark < 0:
        raise RuntimeError(f'{url}: no zip directory found')
    count, = struct.unpack('<H', tail[mark + 10 : mark + 12])
    cd_size, cd_off = struct.unpack('<II', tail[mark + 12 : mark + 20])
    if cd_off == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:  # zip64 – none of the districts needs it yet
        loc = tail.rfind(b'PK\x06\x07')
        if loc < 0:
            raise RuntimeError(f'{url}: zip64 without its locator')
        off64 = struct.unpack('<Q', tail[loc + 8 : loc + 16])[0]
        head = read(url, token, start=off64, end=off64 + 55)
        cd_size, cd_off = struct.unpack('<QQ', head[40:56])
    raw = read(url, token, start=cd_off, end=cd_off + cd_size - 1)
    found = {}
    at = 0
    while at + 46 <= len(raw) and raw[at : at + 4] == b'PK\x01\x02':
        method, = struct.unpack('<H', raw[at + 10 : at + 12])
        csize, usize = struct.unpack('<II', raw[at + 20 : at + 28])
        nl, el, cl = struct.unpack('<HHH', raw[at + 28 : at + 34])
        here, = struct.unpack('<I', raw[at + 42 : at + 46])
        name = raw[at + 46 : at + 46 + nl].decode('utf-8', 'replace').rstrip('/')
        if not name.endswith('/'):
            found[name] = (here, csize, usize, method)
        at += 46 + nl + el + cl
    if not found:
        raise RuntimeError(f'{url}: the zip directory names no file ({cd_size} B, {count} entries expected)')
    with open(cache + '.tmp', 'w') as f:
        json.dump(found, f)
    os.replace(cache + '.tmp', cache)
    return found


def zip_size(url, token):
    request = urllib.request.Request(url, headers={
        'User-Agent': AGENT,
        'Authorization': 'Basic ' + base64.b64encode(f'{token}:'.encode()).decode(),
    }, method='HEAD')
    with urllib.request.urlopen(request, timeout=180) as r:
        return int(r.headers['Content-Length'])


def take(url, token, member):
    """One member out of the archive: its local header is read, then its packed bytes."""
    off, csize, usize, method = member
    head = read(url, token, start=off, end=off + 29)
    if head[:4] != b'PK\x03\x04':
        raise RuntimeError(f'{url}: no local header at {off}')
    nl, el = struct.unpack('<HH', head[26:30])
    raw = read(url, token, start=off + 30 + nl + el, end=off + 30 + nl + el + csize - 1)
    if method == 0:
        return raw
    if method != 8:
        raise RuntimeError(f'{url}: member with unknown method {method}')
    return zlib.decompress(raw, -15)


def take_dgm(url, token, member, east, north):
    """One GeoTIFF → data/work/dgm2/<E>_<N>.dgm, reduced as tools/fetch-geodata.py reduces it."""
    out = os.path.join(GD.DGM_OUT, f'{east}_{north}.dgm')
    if os.path.exists(out):
        return 0, 0
    data = take(url, token, member)
    blob = GD.reduce_tile(data)
    with open(out + '.tmp', 'wb') as f:
        f.write(blob)
    os.replace(out + '.tmp', out)
    return len(blob), member[1]


def take_lod2(url, token, member, east, north, name):
    """One CityGML file → a staging directory of its own, read by tools/lod2-extract.ts.

    The name carries the tile, because tools/lod2-extract.ts empties the directory it writes
    (rmSync in line 176): called once per tile with the same name, only the last tile would
    stay.  The dot in front keeps the map build from reading the staging directory as well;
    merge_lod2() puts the tiles together afterwards.
    """
    done = os.path.join(GD.LOD2_OUT, '.done', f'{name}-{east}_{north}')
    if os.path.exists(done):
        return 0, 0
    data = take(url, token, member)
    tmp = os.path.join(GD.TMP, f'saar-lod2-{east}_{north}.gml')
    with open(tmp, 'wb') as f:
        f.write(data)
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
    return 1, member[1]


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
    say(f'[saar] buildings joined from {len(staging)} tiles: {len(os.listdir(final))} squares of 2 km, '
        f'{units} units in data/work/lod2/{name}')
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', type=span, required=True, help='east kilometres, UTM32 (354 or 341..364)')
    ap.add_argument('--north', type=span, required=True, help='north kilometres, UTM32 (5456 or 5448..5464)')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--district', action='append', default=[], help='only this district (SB, SLS, NK, WND, MZG, SPK; repeatable)')
    ap.add_argument('--lod2-name', default='Saarland', help='directory under data/work/lod2 the buildings go to')
    ap.add_argument('--jobs', type=int, default=4, help='how many tiles are read at once')
    ap.add_argument('--limit', type=int, default=0, help='only this many tiles (to try the way first)')
    ap.add_argument('--dry', action='store_true', help='only say what would be fetched (and how many bytes it is)')
    ap.add_argument('--published', help='map-assets/index.json: tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those tiles')
    ap.add_argument('--gaps', help='write the kilometre squares the state has no data for into this file')
    args = ap.parse_args()

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP, CACHE):
        os.makedirs(sub, exist_ok=True)
    e0, e1 = args.east
    n0, n1 = args.north
    wanted = [f'{e}_{n}' for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]
    wanted_set = set(wanted)
    say(f'[saar] east {e0}..{e1} km, north {n0}..{n1} km – {len(wanted)} tiles of 1 km')

    known = set()
    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        for file in index['files']:
            known.update(file['tiles'])
        say(f'[saar] {args.published}: {len(known)} tiles of other maps')

    overlap = [k for k in wanted if tile_keys(*[int(v) for v in k.split('_')]) & known]
    if overlap:
        if args.on_overlap == 'fail':
            ap.error(f'{len(overlap)} kilometre squares are already in another map, e. g. {overlap[:5]}')
        say(f'[saar] {len(overlap)} kilometre squares another map already has: '
            + ('they are fetched anyway' if args.on_overlap == 'fetch' else 'they are left out')
            + (f', e. g. {overlap[:5]}'))
    skip = set(overlap) if args.on_overlap == 'skip' else set()

    token = share_token()
    products = ['dgm'] if args.only == 'dgm' else ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2']
    plans = {p: {} for p in products}
    for product in products:
        zips = members(product, token)
        if args.district:
            zips = {k: v for k, v in zips.items() if k.upper() in {d.upper() for d in args.district}}
            if not zips:
                ap.error(f'no such district; the share has: {", ".join(sorted(members(product, token)))}')
        say(f'[saar] {product}: {len(zips)} district archives ({", ".join(sorted(zips))})')
        seen = 0

        def index_of(item, product=product):
            district, url = item
            return district, central_directory(url, token)

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for district, listing in pool.map(index_of, sorted(zips.items())):
                hits = 0
                for member, entry in listing.items():
                    m = MEMBER[product].match(member.rsplit('/', 1)[-1])
                    if not m:
                        continue
                    key = f'{int(m[1])}_{int(m[2])}'
                    if key in wanted_set and key not in plans[product]:
                        plans[product][key] = (zips[district], entry)
                        hits += 1
                seen += len(listing)
                say(f'[saar] {product} {district}: {len(listing)} members, {hits} of them wanted')
        say(f'[saar] {product}: {len(plans[product])} tiles to fetch ({seen} members in the directories)')

    work = [(p, k) + plans[p][k] for p in products for k in wanted if p in plans and k in plans[p] and k not in skip]
    if args.dry:
        for product in products:
            items = [w for w in work if w[0] == product]
            say(f'[saar] {product}: {len(items)} tiles, {sum(w[3][1] for w in items) / 1048576:.0f} MB to read '
                f'({sum(w[3][2] for w in items) / 1048576:.0f} MB unpacked)')
        if gaps_dry := [k for k in wanted if 'dgm' in plans and k not in plans['dgm']]:
            say(f'[saar] no terrain for {len(gaps_dry)} squares: {", ".join(gaps_dry[:10])}')
        return 0
    if args.limit:
        work = work[: args.limit]
        say(f'[saar] only the first {len(work)} of them (--limit)')

    started = time.time()
    counts = {'dgm': 0, 'lod2': 0}
    again = {'dgm': 0, 'lod2': 0}
    packed = {'dgm': 0, 'lod2': 0}

    def one(item):
        product, key, url, member = item
        east, north = [int(v) for v in key.split('_')]
        if product == 'dgm':
            made, size = take_dgm(url, token, member, east, north)
        else:
            made, size = take_lod2(url, token, member, east, north, args.lod2_name)
        return product, key, made, size

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for done, item in enumerate(pool.map(one, work), start=1):
            product, key, made, size = item
            packed[product] += size
            if made:
                counts[product] += 1
            else:
                again[product] += 1
            if done % 25 == 0 or done == len(work):
                say(f'[saar] {done}/{len(work)}: {counts["dgm"]} terrain, {counts["lod2"]} buildings '
                    f'– {(time.time() - started) / 60:.0f} min so far')

    say(f'[saar] done: {counts["dgm"]} tiles of terrain ({again["dgm"]} were there, '
        f'{packed["dgm"] / 1048576:.0f} MB read), {counts["lod2"]} tiles of buildings '
        f'({again["lod2"]} were there, {packed["lod2"] / 1048576:.0f} MB read) in {(time.time() - started) / 60:.0f} min')
    if args.only != 'dgm':
        merge_lod2(args.lod2_name)
    gaps = [k for k in wanted if k not in plans['dgm']] if 'dgm' in plans else []
    if gaps:
        say(f'[saar] no terrain of the Saarland for {len(gaps)} kilometre squares (the map stays out of them)'
            + (f': {", ".join(gaps[:8])}' if len(gaps) <= 8 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
