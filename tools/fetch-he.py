#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Fetch the official terrain model (DGM1) and the building models (LoD2) of the
Hessian municipalities that lie in one rectangle of UTM32 kilometre squares –
the open geodata of the Hessian administration for land management and
geoinformation (HVBG, https://gds.hessen.de) – and reduce them to what the map
build reads.  tools/fetch-geodata.py already knows the download centre; what is
added here is the rectangle: not the state is fetched, but only those
municipalities of it whose kilometre squares the rectangle wants.

    python3 -I tools/fetch-he.py --east 526..540 --north 5678..5692 \
        --district "Kreisfreie Stadt Kassel" --district "Landkreis Kassel"
    python3 -I tools/fetch-he.py --east 526..540 --north 5678..5692 --only dgm \
        --district "Kreisfreie Stadt Kassel" --published map-assets/index.json

Terrain:   data/work/dgm2/<E km>_<N km>.dgm – the 1 km tiles on a 2 m grid
           (mean of 2 x 2 cells, heights in steps of 2 cm, deflated), written by
           reduce_tile() of tools/fetch-geodata.py, which is read here for it
Buildings: data/work/lod2/<name>/<x>_<z>.ndjson.gz – written by tools/lod2-extract.ts

How the municipalities are chosen: every archive is a ZIP whose members are
named DGM1_32_<E>_<N>_1_he.tif, and a ZIP keeps its directory of members at the
end of the file.  The download server answers range requests (measured: HTTP
206 for "Range: bytes=-262144"), so the members of an archive are read with two
small ranged GETs – 262 kB plus the directory, about 280 kB for the largest
municipality of Kassel – instead of downloading the archive (which is 300 MB
and more).  An archive without a wanted kilometre square stays where it is;
only archives that hold one are fetched.  An archive that did not say what it
holds (a server without ranges, a ZIP built otherwise) is fetched as a whole
and afterwards trimmed back to the rectangle – never the other way round.

Which squares another map already has, the index of the published maps says:
map-assets/index.json names every tile of 500 m one map holds, and two maps
must not hold the same tile.  Those kilometre squares are left out (with
--on-overlap fail the script stops instead).  Squares of the rectangle the
state has no terrain for are written into --gaps.

Needs Python 3 (numpy and Pillow come in through tools/fetch-geodata.py), curl
and node.  What is already there is skipped, so the command can be repeated
after an interruption.
"""
import argparse
import importlib.util
import json
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# what map-assets/index.json counts in (src/world/grid.ts, tools/fetch-rlp.py)
WORLD_ORIGIN_E = 528000
WORLD_ORIGIN_N = 5678000
GRID_OFFSET = 200_000
AGENT = 'map-fetch/0.1'
SELECTED = os.path.join(ROOT, 'data/work/he-selected.json')  # which municipalities the rectangle wants


def geodata():
    """tools/fetch-geodata.py as a module: its reduce_tile writes the terrain of one tile."""
    path = os.path.join(ROOT, 'tools', 'fetch-geodata.py')
    spec = importlib.util.spec_from_file_location('fetch_geodata', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GD = geodata()


def say(text):
    print(f'[he] {text}', flush=True)


# The download centre refuses connections when it has just answered many requests
# (measured: urllib.error.URLError, Errno 111, in the middle of a list of pages).
# tools/fetch-geodata.py asks without a second try, so its api() is wrapped here:
# the same question again after a growing pause, six times, then the error stands.
_api_once = GD.api


def _api(path, page=1):
    for attempt in range(6):
        try:
            return _api_once(path, page)
        except Exception as error:                                  # Connection refused, timeout, …
            last = error
            if attempt == 5:
                raise
            say(f'{path} (Seite {page}) abgewiesen ({error}) – Versuch {attempt + 2} in '
                f'{10 * (attempt + 1)} s')
            time.sleep(10 * (attempt + 1))
    raise last


GD.api = _api


def fold(name):
    """The two products spell some districts differently (Meißner / Meissner)."""
    return name.lower().replace('ß', 'ss')


def tile_keys(east, north):
    """The four tiles of 500 m a kilometre square covers, named as map-assets does ('434_363')."""
    x0 = east * 1000 - WORLD_ORIGIN_E
    z0 = WORLD_ORIGIN_N - (north + 1) * 1000
    return {
        f'{(x0 + dx * 500 + GRID_OFFSET) // 500}_{(z0 + dz * 500 + GRID_OFFSET) // 500}'
        for dx in (0, 1)
        for dz in (0, 1)
    }


def ask(url, range_header):
    """One ranged GET; None if the server does not serve it (it also refuses single ones of many)."""
    request = urllib.request.Request(url, headers={'User-Agent': AGENT, 'Range': range_header})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=180) as r:
                if r.status != 206:
                    return None
                return r.read()
        except Exception as e:  # noqa: BLE001 - every trouble here only means "unknown, fetch it"
            say(f'{type(e).__name__} {e}: no ranged read of {os.path.basename(url)}')
            time.sleep(5 * (attempt + 1))
    return None


def archive_tiles(url):
    """Which kilometre squares of terrain an archive holds – read from its directory; None if it does not say."""
    tail = ask(url, 'bytes=-262144')
    if not tail:
        return None
    at = tail.rfind(b'PK\x05\x06')  # end of central directory
    if at < 0:
        return None
    entries = struct.unpack('<H', tail[at + 10:at + 12])[0]
    cd_size, cd_offset = struct.unpack('<II', tail[at + 12:at + 20])
    directory = ask(url, f'bytes={cd_offset}-{cd_offset + cd_size - 1}') if cd_size else b''
    if directory is None or len(directory) < cd_size:
        return None
    tiles = set()
    at = 0
    found = 0
    while found < entries and directory[at:at + 4] == b'PK\x01\x02':
        name_len, extra_len, comment_len = struct.unpack('<HHH', directory[at + 28:at + 34])
        name = directory[at + 46:at + 46 + name_len].decode('utf-8', 'replace')
        m = re.search(r'dgm1_32_(\d+)_(\d+)_1_he\.tif$', name, re.IGNORECASE)
        if m:
            tiles.add((int(m[1]), int(m[2])))
        at += 46 + name_len + extra_len + comment_len
        found += 1
    return tiles or None


def take_dgm(archive, wanted):
    """Like take_dgm of tools/fetch-geodata.py, but it keeps only the squares of the rectangle."""
    made = 0
    there = 0
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            m = re.search(r'dgm1_32_(\d+)_(\d+)_1_he\.tif$', info.filename, re.IGNORECASE)
            if not m:
                continue
            square = (int(m[1]), int(m[2]))
            if square not in wanted:
                continue
            out = os.path.join(GD.DGM_OUT, f'{square[0]}_{square[1]}.dgm')
            if os.path.exists(out):
                there += 1
                continue
            data = GD.reduce_tile(z.read(info))
            with open(out + '.tmp', 'wb') as f:
                f.write(data)
            os.replace(out + '.tmp', out)
            made += 1
    return made, there


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--east', required=True, help='rectangle: kilometre squares from..to to the east (UTM32)')
    ap.add_argument('--north', required=True, help='rectangle: kilometre squares from..to to the north')
    ap.add_argument('--district', action='append', default=[], help='a district as the download centre names it (repeatable; tools/fetch-geodata.py --list lists them)')
    ap.add_argument('--lod2-name', default='Hessen', help='directory under data/work/lod2 the building models go into')
    ap.add_argument('--published', help='map-assets/index.json: the tiles another map already has')
    ap.add_argument('--on-overlap', choices=['skip', 'fetch', 'fail'], default='skip', help='what happens to those squares')
    ap.add_argument('--only', choices=['dgm', 'lod2'], help='only the terrain or only the buildings')
    ap.add_argument('--gaps', help='write the kilometre squares without terrain into this file')
    args = ap.parse_args()

    if not args.district:
        ap.error('name at least one --district (they are listed by tools/fetch-geodata.py --list)')
    pairs = []
    for name in ('east', 'north'):
        text = getattr(args, name)
        m = re.fullmatch(r'(-?\d+)\s*\.\.\s*(-?\d+)', text.strip())
        if not m:
            ap.error(f'--{name} wants "<from>..<to>", read "{text}"')
        pairs.append((int(m[1]), int(m[2])))
    (e0, e1), (n0, n1) = pairs
    wanted = {(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)}
    say(f'rectangle east {e0}..{e1} km, north {n0}..{n1} km – {len(wanted)} squares of 1 km')

    if args.published:
        if not os.path.exists(args.published):
            ap.error(f'no such index: {args.published}')
        with open(args.published) as f:
            index = json.load(f)
        known = set()
        for file in index['files']:
            known.update(file['tiles'])
        say(f'{args.published}: {len(known)} tiles of other maps')
        taken = sorted(s for s in wanted if tile_keys(*s) & known)
        if taken:
            if args.on_overlap == 'fail':
                ap.error(f'{len(taken)} squares are already in another map, e. g. {taken[:5]}')
            say(f'{len(taken)} squares another map already has ({taken[:5]}'
                + (' …' if len(taken) > 5 else '') + ') – they are left out')
            if args.on_overlap == 'skip':
                wanted -= set(taken)
    if not wanted:
        say('no square left – nothing to fetch')
        return 0

    for sub in (GD.DGM_OUT, os.path.join(GD.DGM_OUT, '.done'), GD.LOD2_OUT, os.path.join(GD.LOD2_OUT, '.done'), GD.TMP):
        os.makedirs(sub, exist_ok=True)

    selected = {'dgm': {}, 'lod2': {}}
    if os.path.exists(SELECTED):
        with open(SELECTED) as f:
            loaded = json.load(f)
        for product in selected:
            selected[product] = loaded.get(product, {})
    save = lambda: json.dump(selected, open(SELECTED, 'w'))  # noqa: E731

    districts = {d: GD.districts(d) for d in (['dgm'] if args.only == 'dgm' else
                                              ['lod2'] if args.only == 'lod2' else ['dgm', 'lod2'])}
    match_district = lambda product, name: next((d for d in districts[product] if fold(d) == fold(name)), None)  # noqa: E731

    # 1: the terrain – which municipality holds a square of the rectangle
    if 'dgm' in districts:
        for name in args.district:
            district = match_district('dgm', name)
            if not district:
                say(f'no district "{name}" for the terrain; there are: {", ".join(districts["dgm"])}')
                continue
            for item in GD.downloads('dgm', district):
                municipality = GD.plain(item['name'])
                done = os.path.join(GD.DGM_OUT, '.done', municipality)
                if municipality in selected['dgm'].get(district, []) or os.path.exists(done):
                    selected['dgm'].setdefault(district, [])
                    if municipality not in selected['dgm'][district]:
                        selected['dgm'][district].append(municipality)
                    continue
                tiles = archive_tiles(GD.BASE + urllib.parse.quote(item['downloadLink']['uri']))
                if tiles is not None and not tiles & wanted:
                    say(f'{district} / {municipality}: none of its {len(tiles)} squares is wanted – left')
                    continue
                if tiles is None:
                    say(f'{district} / {municipality}: what it holds stayed unknown – fetched and trimmed')
                selected['dgm'].setdefault(district, []).append(municipality)
                save()
                started = time.time()
                archive = os.path.join(GD.TMP, f'{municipality}-dgm.zip')
                GD.fetch(item['downloadLink']['uri'], archive)
                loaded = time.time() - started
                made, there = take_dgm(archive, wanted)
                size = os.path.getsize(archive) / 1048576
                os.remove(archive)
                with open(done, 'w') as f:
                    f.write(item.get('creationDate', '') + '\n')
                say(f'dgm {district} / {municipality}: {size:.0f} MB in {loaded:.0f} s, '
                    f'{made} tiles reduced, {there} already there')
                time.sleep(1)
        save()

    # 2: the buildings of the same municipalities
    if 'lod2' in districts:
        terrain = {m for names in selected['dgm'].values() for m in names}
        for name in args.district:
            district = match_district('lod2', name)
            if not district:
                say(f'no district "{name}" for the buildings; there are: {", ".join(districts["lod2"])}')
                continue
            for item in GD.downloads('lod2', district):
                municipality = GD.plain(item['name'])
                done = os.path.join(GD.LOD2_OUT, '.done', municipality)
                if municipality in selected['lod2'].get(district, []) or os.path.exists(done):
                    selected['lod2'].setdefault(district, [])
                    if municipality not in selected['lod2'][district]:
                        selected['lod2'][district].append(municipality)
                    continue
                if terrain and municipality not in terrain:
                    say(f'{district} / {municipality}: no terrain of the rectangle from it – left')
                    continue
                selected['lod2'].setdefault(district, []).append(municipality)
                save()
                started = time.time()
                archive = os.path.join(GD.TMP, f'{municipality}-lod2.zip')
                GD.fetch(item['downloadLink']['uri'], archive)
                say(f'lod2 {district} / {municipality}: {os.path.getsize(archive) / 1048576:.0f} MB '
                    f'in {time.time() - started:.0f} s, extracting the buildings')
                GD.take_lod2(archive, args.lod2_name)
                os.remove(archive)
                with open(done, 'w') as f:
                    f.write(item.get('creationDate', '') + '\n')
                time.sleep(1)
        save()

    # 3: what the rectangle is missing
    have = set()
    for name in os.listdir(GD.DGM_OUT):
        m = re.fullmatch(r'(-?\d+)_(-?\d+)\.dgm', name)
        if m:
            have.add((int(m[1]), int(m[2])))
    gaps = sorted(wanted - have)
    for square in sorted(have - wanted):
        say(f'tile outside the rectangle, it belongs to no map of this run: {square[0]}_{square[1]}')
    say(f'{len(wanted & have)} of {len(wanted)} squares of the rectangle have terrain, {len(gaps)} do not')
    if gaps:
        say('no terrain for ' + ', '.join(f'{e}_{n}' for e, n in gaps[:10]) + (' …' if len(gaps) > 10 else ''))
        if args.gaps:
            with open(args.gaps, 'w') as f:
                f.write('\n'.join(f'{e}_{n}' for e, n in gaps) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
