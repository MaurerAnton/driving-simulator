#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""
Gelände für die Karten Thüringens: das Copernicus DEM GLO-30, gerechnet wie in
tools/fetch-it.py (dessen Befehlszeile und Ausgabe hier gelten), nur mit Kästen,
die nördlich von 50° schmaler sind.  Das Copernicus DEM hat zwischen 50° und 60°
Breite 2400 statt 3600 Spalten je Grad (1,5″ in der Länge statt 1″); fetch-it.py
erwartet überall 3600 × 3600 und bricht dort ab.

Warum nicht DGM1 und LoD2 des TLBG (© GDI-Th, CC BY 4.0): siehe den Kopf von
.github/workflows/build-map-thueringen.yml – die Downloads stehen hinter einer
CAPTCHA-Seite.  Gebäude kommen aus OpenStreetMap.

    python3 -I tools/fetch-thueringen.py --east 639..645 --north 5645..5651 --only dgm
"""
import importlib.util
import os
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('fetch_it', os.path.join(ROOT, 'tools', 'fetch-it.py'))
IT = importlib.util.module_from_spec(spec)
spec.loader.exec_module(IT)
GD = IT.GD

_dem = {}
_lock = threading.Lock()


def dem_tile(lat, lon):
    """Heights of one DEM tile of 1° (south-west corner at whole degrees): 3600 rows, 3600 or fewer columns."""
    with _lock:
        if (lat, lon) in _dem:
            return _dem[(lat, lon)]
    path = os.path.join(GD.TMP, f'cop-N{lat:02d}E{lon:03d}.tif')
    if not os.path.exists(path) or os.path.getsize(path) < 1 << 20:
        IT.say(f'[th] Copernicus-Kachel N{lat:02d} E{lon:03d} holen')
        IT.curl_to(IT.DEM_ZIP % (lat, lon, lat, lon), path)
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(path), dtype=np.float32)
    if a.shape[0] != IT.DEM_N or a.shape[1] not in (3600, 2400, 1800, 1200, 720, 360):
        raise ValueError(f'unexpected size of the DEM tile: {a.shape}')
    with _lock:
        _dem[(lat, lon)] = a
    return a


def heights(east, north):
    """500 × 500 heights in metres for the kilometre tile, row 0 its northern edge (as fetch-it.py)."""
    import numpy as np

    centre = np.arange(GD.DGM_N) * 2.0 + 1.0
    e = east * 1000 + centre[None, :]
    n = (north + 1) * 1000 - centre[:, None]
    lon, lat = IT.inv_utm32(e, n)
    grid = np.full((GD.DGM_N, GD.DGM_N), np.nan, np.float32)
    for la in range(int(np.floor(lat.min())), int(np.floor(lat.max())) + 1):
        for lo in range(int(np.floor(lon.min())), int(np.floor(lon.max())) + 1):
            a = dem_tile(la, lo)
            rows, cols = a.shape
            # pixel is point: cell (0, 0) has its centre on the north-west whole degree
            fi = (la + 1 - lat) * rows
            fj = (lon - lo) * cols
            there = (fi >= 0) & (fi <= rows - 1) & (fj >= 0) & (fj <= cols - 1)
            if not there.any():
                continue
            i0 = np.clip(np.floor(fi).astype(np.intp), 0, rows - 1)
            j0 = np.clip(np.floor(fj).astype(np.intp), 0, cols - 1)
            i1 = np.minimum(i0 + 1, rows - 1)
            j1 = np.minimum(j0 + 1, cols - 1)
            ti = (fi - i0)[there]
            tj = (fj - j0)[there]
            top = a[i0[there], j0[there]] * (1 - ti) + a[i1[there], j0[there]] * ti
            low = a[i0[there], j1[there]] * (1 - ti) + a[i1[there], j1[there]] * ti
            grid[there] = top * (1 - tj) + low * tj
    grid[np.isnan(grid) | (grid <= -1000)] = np.nan
    return grid


# fetch-it.py looks both up in its own namespace when it runs
IT.dem_tile = dem_tile
IT.heights = heights

if __name__ == '__main__':
    sys.exit(IT.main())
