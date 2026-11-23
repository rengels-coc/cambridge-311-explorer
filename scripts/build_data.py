#!/usr/bin/env python3
"""
Build compact, spatially-joined data files for the Cambridge 311 Explorer.
Zero external dependencies (Python 3.9+ stdlib only) so it runs smoothly in GitHub Actions.

Outputs:
  data/tickets.bin  - Zero-copy columnar binary dataset sorted by created timestamp
  data/meta.json    - Categories, themes, statuses, region metadata, build stats
  data/regions.json - Simplified official Cambridge GIS GeoJSON boundaries
"""

import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

EPOCH = datetime(2009, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
EPOCH_SEC = int(EPOCH.timestamp())

SOCRATA_URL = "https://data.cambridgema.gov/resource/2z9k-mv9g.json"
POP_URL = "https://data.cambridgema.gov/resource/rqau-pwa4.json"
GIS_BASE = "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main"

GIS_LAYERS = {
    "neighborhoods": f"{GIS_BASE}/Boundary/CDD_Neighborhoods/BOUNDARY_CDDNeighborhoods.geojson",
    "tracts": f"{GIS_BASE}/Demographics/Census_2020/2020_Tracts/DEMOGRAPHICS_Tracts2020.geojson",
    "wards_precincts": f"{GIS_BASE}/Elections/Wards_and_Precincts/ELECTIONS_WardsPrecincts.geojson",
    "zipcodes": f"{GIS_BASE}/Boundary/Zip_Codes/BOUNDARY_Zipcodes.geojson",
}

# Official City of Cambridge categorical palette (from Cambridge Reimagined dataviz guide)
THEMES = [
    {"id": "streets", "name": "Streets & Sidewalks", "color": "#196CC6"},
    {"id": "waste", "name": "Waste & Recycling", "color": "#FF6000"},
    {"id": "trees", "name": "Trees & Parks", "color": "#29BA38"},
    {"id": "traffic", "name": "Traffic & Signals", "color": "#730FE8"},
    {"id": "bikes", "name": "Bikes & Mobility", "color": "#EC1A88"},
    {"id": "buildings", "name": "Buildings & Neighborhood", "color": "#FFB800"},
    {"id": "snow", "name": "Snow & Ice", "color": "#1D2F8D"},
    {"id": "animals", "name": "Animals, Pests & Health", "color": "#D20404"},
    {"id": "other", "name": "Other & General", "color": "#999999"},
]

STATUS_MAP = {
    "Archived": 0,
    "Closed": 1,
    "Acknowledged": 2,
    "Open": 3,
}
STATUS_NAMES = ["Archived", "Closed", "Acknowledged", "Open"]


import re

def classify_theme(cat: str) -> int:
    """Map any of the 124 issue_category strings to one of the 9 intuitive themes."""
    c = (cat or "").lower()
    if re.search(r"\b(snow|snowy|icy|unshoveled|shovel|shovelling)\b", c):
        return 6  # Snow & Ice
    if re.search(r"\b(bike|bicycle)\b", c):
        return 4  # Bikes & Mobility
    if re.search(r"\b(trash|recycl\w*|compost|food waste|yard waste|bigbelly|dumpster|dumping|white good|holiday tree)\b", c):
        return 1  # Waste & Recycling
    if re.search(r"\b(rodent|rat|roadkill|dead animal|animal|needle|baiting)\b", c):
        return 7  # Animals, Pests & Health
    if re.search(r"\b(traffic|signal|sign|pavement marking|parking|transportation|space saver|taxi)\b", c):
        return 3  # Traffic & Signals
    if re.search(r"\b(tree|trees|park|parks|botanical|fresh pond|danehy|rubber surface|hard surface)\b", c):
        return 2  # Trees & Parks
    if re.search(r"\b(pothole|sidewalk|sidewalks|street|streetlight|streetlights|manhole|drain|catch basin|curb|paving|pave|sinkhole|asphalt|trip hazard|trip hazards|water cut|water cuts|water box|remedial engineering|ada complaint|flexi pave|skim coat|5 year plan)\b", c):
        return 0  # Streets & Sidewalks
    if re.search(r"\b(graffiti|construction|leaf blower|private property|building|housing|electrical|utility|library|public art|furniture|lawn sign)\b", c):
        return 5  # Buildings & Neighborhood
    return 8  # Other & General


def fetch_json(url: str, timeout: int = 60):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Cambridge-311-Explorer-Builder/1.0",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------- Geometry helpers ----------

COS_LAT = math.cos(math.radians(42.3736))
MI_PER_DEG_LAT = 69.054
MI_PER_DEG_LNG = 69.172 * COS_LAT


def ring_area_sqmi(ring):
    if len(ring) < 3:
        return 0.0
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * MI_PER_DEG_LNG, ring[i][1] * MI_PER_DEG_LAT
        x2, y2 = ring[i + 1][0] * MI_PER_DEG_LNG, ring[i + 1][1] * MI_PER_DEG_LAT
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def geom_area_sqmi(geom):
    gtype = geom["type"]
    coords = geom["coordinates"]
    total = 0.0
    if gtype == "Polygon":
        total += ring_area_sqmi(coords[0])
        for hole in coords[1:]:
            total -= ring_area_sqmi(hole)
    elif gtype == "MultiPolygon":
        for poly in coords:
            total += ring_area_sqmi(poly[0])
            for hole in poly[1:]:
                total -= ring_area_sqmi(hole)
    return max(total, 0.0001)


def dp_simplify(pts, eps):
    """Iterative Douglas-Peucker simplification for a coordinate ring."""
    if len(pts) <= 4:
        return pts
    # Keep closed ring endpoints
    keep = [False] * len(pts)
    keep[0] = True
    keep[-1] = True
    stack = [(0, len(pts) - 1)]
    eps_sq = eps * eps
    while stack:
        a, b = stack.pop()
        if b - a <= 1:
            continue
        ax, ay = pts[a][0], pts[a][1]
        bx, by = pts[b][0], pts[b][1]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        max_d2 = -1.0
        idx = -1
        for i in range(a + 1, b):
            px, py = pts[i][0], pts[i][1]
            if denom == 0.0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / denom
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                cx, cy = ax + t * dx, ay + t * dy
                d2 = (px - cx) ** 2 + (py - cy) ** 2
            if d2 > max_d2:
                max_d2 = d2
                idx = i
        if max_d2 > eps_sq and idx != -1:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    out = [[round(p[0], 5), round(p[1], 5)] for p, k in zip(pts, keep) if k]
    if len(out) < 4:
        out = [[round(p[0], 5), round(p[1], 5)] for p in pts]
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def simplify_geom(geom, eps=0.00007):
    gtype = geom["type"]
    coords = geom["coordinates"]
    if gtype == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [dp_simplify(r, eps) for r in coords],
        }
    elif gtype == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [[dp_simplify(r, eps) for r in poly] for poly in coords],
        }
    return geom


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def build_polygon_index(features):
    """Precompute bounding boxes and rings for fast point-in-polygon lookups."""
    indexed = []
    for idx, feat in enumerate(features):
        geom = feat["geometry"]
        gtype = geom["type"]
        polys = [geom["coordinates"]] if gtype == "Polygon" else geom["coordinates"]
        minx = miny = 1e9
        maxx = maxy = -1e9
        clean_polys = []
        for poly in polys:
            outer = poly[0]
            pminx = min(p[0] for p in outer)
            pmaxx = max(p[0] for p in outer)
            pminy = min(p[1] for p in outer)
            pmaxy = max(p[1] for p in outer)
            minx, maxx = min(minx, pminx), max(maxx, pmaxx)
            miny, maxy = min(miny, pminy), max(maxy, pmaxy)
            clean_polys.append((pminx, pminy, pmaxx, pmaxy, outer, poly[1:]))
        indexed.append((idx, minx, miny, maxx, maxy, clean_polys))
    return indexed


def locate_point(x, y, poly_index):
    for idx, minx, miny, maxx, maxy, polys in poly_index:
        if x < minx or x > maxx or y < miny or y > maxy:
            continue
        for pminx, pminy, pmaxx, pmaxy, outer, holes in polys:
            if x < pminx or x > pmaxx or y < pminy or y > pmaxy:
                continue
            if point_in_ring(x, y, outer):
                in_hole = any(point_in_ring(x, y, h) for h in holes)
                if not in_hole:
                    return idx
    return 255


def load_regions():
    print("Loading Cambridge GIS boundaries and 2020 neighborhood populations...")
    pop_rows = fetch_json(POP_URL)
    nh_pop = {}
    for row in pop_rows:
        name = (row.get("neighborhood_1") or "").strip()
        pop_val = row.get("_2020_popualtion") or row.get("_2020_population")
        if name and pop_val:
            try:
                nh_pop[name.lower()] = int(float(pop_val))
            except ValueError:
                pass

    raw_layers = {}
    regions_out = {}
    regions_meta = {}

    # 1. Neighborhoods
    gj = fetch_json(GIS_LAYERS["neighborhoods"])
    feats = sorted(gj["features"], key=lambda f: f["properties"].get("NAME", ""))
    raw_layers["neighborhoods"] = feats
    nh_meta = []
    nh_feats = []
    for i, f in enumerate(feats):
        p = f["properties"]
        name = p.get("NAME", f"Neighborhood {i+1}").strip()
        area = round(geom_area_sqmi(f["geometry"]), 4)
        pop = nh_pop.get(name.lower())
        nh_meta.append({"id": i, "code": str(p.get("N_HOOD", i + 1)), "name": name, "area_sqmi": area, "pop": pop})
        nh_feats.append({
            "type": "Feature",
            "id": i,
            "properties": {"id": i, "name": name, "area_sqmi": area, "pop": pop},
            "geometry": simplify_geom(f["geometry"]),
        })
    regions_out["neighborhoods"] = {"type": "FeatureCollection", "features": nh_feats}
    regions_meta["neighborhoods"] = nh_meta

    # 2. 2020 Census Tracts
    gj = fetch_json(GIS_LAYERS["tracts"])
    feats = sorted(gj["features"], key=lambda f: f["properties"].get("NAME20", ""))
    raw_layers["tracts"] = feats
    tr_meta = []
    tr_feats = []
    for i, f in enumerate(feats):
        p = f["properties"]
        tname = f"Tract {p.get('NAME20', i+1)}"
        aland = p.get("ALAND20")
        area = round(float(aland) / 2589988.11, 4) if aland and float(aland) > 0 else round(geom_area_sqmi(f["geometry"]), 4)
        tr_meta.append({"id": i, "code": str(p.get("GEOID20", "")), "name": tname, "area_sqmi": area, "pop": None})
        tr_feats.append({
            "type": "Feature",
            "id": i,
            "properties": {"id": i, "name": tname, "code": str(p.get("GEOID20", "")), "area_sqmi": area, "pop": None},
            "geometry": simplify_geom(f["geometry"]),
        })
    regions_out["tracts"] = {"type": "FeatureCollection", "features": tr_feats}
    regions_meta["tracts"] = tr_meta

    # 3. Wards & Precincts
    gj = fetch_json(GIS_LAYERS["wards_precincts"])
    feats = sorted(gj["features"], key=lambda f: (int(f["properties"].get("Ward", 0)), int(f["properties"].get("Precinct", 0))))
    raw_layers["wards_precincts"] = feats
    wp_meta = []
    wp_feats = []
    for i, f in enumerate(feats):
        p = f["properties"]
        code = str(p.get("WardPrecinct", f"{p.get('Ward')}-{p.get('Precinct')}"))
        name = f"Ward {p.get('Ward')}, Precinct {p.get('Precinct')}"
        area = round(geom_area_sqmi(f["geometry"]), 4)
        pop = int(float(p["TOTALPOP"])) if p.get("TOTALPOP") else None
        wp_meta.append({"id": i, "code": code, "name": name, "area_sqmi": area, "pop": pop})
        wp_feats.append({
            "type": "Feature",
            "id": i,
            "properties": {"id": i, "name": name, "code": code, "area_sqmi": area, "pop": pop},
            "geometry": simplify_geom(f["geometry"]),
        })
    regions_out["wards_precincts"] = {"type": "FeatureCollection", "features": wp_feats}
    regions_meta["wards_precincts"] = wp_meta

    # 4. ZIP Codes
    gj = fetch_json(GIS_LAYERS["zipcodes"])
    feats = sorted(gj["features"], key=lambda f: str(f["properties"].get("ZIP_CODE", "")))
    raw_layers["zipcodes"] = feats
    zp_meta = []
    zp_feats = []
    for i, f in enumerate(feats):
        p = f["properties"]
        z = str(p.get("ZIP_CODE", f"ZIP {i+1}")).strip()
        area = round(geom_area_sqmi(f["geometry"]), 4)
        zp_meta.append({"id": i, "code": z, "name": f"ZIP {z}", "area_sqmi": area, "pop": None})
        zp_feats.append({
            "type": "Feature",
            "id": i,
            "properties": {"id": i, "name": f"ZIP {z}", "code": z, "area_sqmi": area, "pop": None},
            "geometry": simplify_geom(f["geometry"]),
        })
    regions_out["zipcodes"] = {"type": "FeatureCollection", "features": zp_feats}
    regions_meta["zipcodes"] = zp_meta

    poly_indices = {k: build_polygon_index(v) for k, v in raw_layers.items()}
    return regions_out, regions_meta, poly_indices


def parse_iso_dt(s: str):
    if not s:
        return None
    # Socrata floating timestamp: "2026-11-23T07:44:55.000"
    try:
        return datetime.fromisoformat(s.replace("Z", "")).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def fetch_all_tickets():
    print("Downloading all Cambridge 311 tickets from data.cambridgema.gov...")
    all_rows = []
    limit = 50000
    offset = 0
    select = "ticket_id,issue_category,ticket_status,ticket_created_date_time,ticket_closed_date_time,lat,lng,image"
    while True:
        params = urllib.parse.urlencode({
            "$select": select,
            "$order": ":id",
            "$limit": limit,
            "$offset": offset,
        })
        batch = fetch_json(f"{SOCRATA_URL}?{params}", timeout=120)
        if not batch:
            break
        all_rows.extend(batch)
        print(f"  Fetched {len(all_rows):,} rows...")
        if len(batch) < limit:
            break
        offset += limit
    return all_rows


def main():
    t0 = time.time()
    regions_out, regions_meta, poly_indices = load_regions()
    rows = fetch_all_tickets()

    print(f"Processing and spatially joining {len(rows):,} tickets...")
    cat_counts = {}
    parsed = []
    max_created_iso = ""
    min_created_iso = "9999-12-31T00:00:00.000"

    nh_idx_map = poly_indices["neighborhoods"]
    tr_idx_map = poly_indices["tracts"]
    wp_idx_map = poly_indices["wards_precincts"]
    zp_idx_map = poly_indices["zipcodes"]

    matched_nh = 0
    matched_tr = 0
    matched_wp = 0
    matched_zp = 0

    for r in rows:
        created_str = r.get("ticket_created_date_time")
        dt_c = parse_iso_dt(created_str)
        if not dt_c:
            continue
        c_min = int((dt_c - EPOCH).total_seconds() // 60)
        if c_min < 0:
            continue

        if created_str > max_created_iso:
            max_created_iso = created_str
        if created_str < min_created_iso:
            min_created_iso = created_str

        try:
            tid = int(r["ticket_id"])
            lat = float(r["lat"])
            lng = float(r["lng"])
        except (KeyError, TypeError, ValueError):
            continue

        cat = (r.get("issue_category") or "Other").strip() or "Other"
        cat_counts[cat] = cat_counts.get(cat, 0) + 1

        st = STATUS_MAP.get(r.get("ticket_status", "Archived"), 0)
        has_img = 1 if r.get("image") else 0
        flags = (st & 0x03) | (has_img << 2)

        dur_h = 65535
        closed_str = r.get("ticket_closed_date_time")
        if closed_str:
            dt_cl = parse_iso_dt(closed_str)
            if dt_cl and dt_cl >= dt_c:
                hrs = int((dt_cl - dt_c).total_seconds() // 3600)
                dur_h = min(hrs, 65534)

        nh = locate_point(lng, lat, nh_idx_map)
        tr = locate_point(lng, lat, tr_idx_map)
        wp = locate_point(lng, lat, wp_idx_map)
        zp = locate_point(lng, lat, zp_idx_map)
        if nh != 255:
            matched_nh += 1
        if tr != 255:
            matched_tr += 1
        if wp != 255:
            matched_wp += 1
        if zp != 255:
            matched_zp += 1

        parsed.append((
            c_min,
            tid,
            int(round(lat * 100000)),
            int(round(lng * 100000)),
            dur_h,
            cat,
            flags,
            nh,
            tr,
            wp,
            zp,
        ))

    # Sort ascending by created_min (tie-break by ticket_id) for O(log N) binary search
    parsed.sort(key=lambda x: (x[0], x[1]))
    n = len(parsed)

    # Order categories by descending frequency
    sorted_cats = sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    cat_to_idx = {name: i for i, (name, _) in enumerate(sorted_cats)}
    categories_meta = [
        {"id": i, "name": name, "count": cnt, "theme": classify_theme(name)}
        for i, (name, cnt) in enumerate(sorted_cats)
    ]

    # Write columnar binary file (4-byte aligned sections)
    # Header: 16 bytes -> magic(4s), version(I), count(I), epoch_sec(I)
    bin_path = DATA_DIR / "tickets.bin"
    with open(bin_path, "wb") as f:
        f.write(struct.pack("<4sIII", b"C311", 1, n, EPOCH_SEC))
        f.write(struct.pack(f"<{n}I", *(p[1] for p in parsed)))  # ticketId
        f.write(struct.pack(f"<{n}I", *(p[0] for p in parsed)))  # createdMin
        f.write(struct.pack(f"<{n}i", *(p[2] for p in parsed)))  # latE5
        f.write(struct.pack(f"<{n}i", *(p[3] for p in parsed)))  # lngE5
        f.write(struct.pack(f"<{n}H", *(p[4] for p in parsed)))  # durHours
        # Pad 2 bytes if n is odd to keep 4-byte alignment
        if n % 2 == 1:
            f.write(b"\x00\x00")
        f.write(bytes(cat_to_idx[p[5]] for p in parsed))          # catIdx
        f.write(bytes(p[6] for p in parsed))                      # flags
        f.write(bytes(p[7] for p in parsed))                      # nhIdx
        f.write(bytes(p[8] for p in parsed))                      # trIdx
        f.write(bytes(p[9] for p in parsed))                      # wpIdx
        f.write(bytes(p[10] for p in parsed))                     # zpIdx

    # Write regions.json
    regions_path = DATA_DIR / "regions.json"
    with open(regions_path, "w", encoding="utf-8") as f:
        json.dump(regions_out, f, separators=(",", ":"))

    # Write meta.json
    meta = {
        "dataset_id": "2z9k-mv9g",
        "source_url": "https://data.cambridgema.gov/Public-Works/Commonwealth-Connect-Service-Requests/2z9k-mv9g/about_data",
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": n,
        "epoch_sec": EPOCH_SEC,
        "min_created": min_created_iso,
        "max_created": max_created_iso,
        "statuses": STATUS_NAMES,
        "themes": THEMES,
        "categories": categories_meta,
        "regions": regions_meta,
    }
    meta_path = DATA_DIR / "meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s!")
    print(f"  Records:        {n:,} ({min_created_iso[:10]} to {max_created_iso[:10]})")
    print(f"  Spatial match:  Neighborhoods {matched_nh/n*100:.1f}%, Tracts {matched_tr/n*100:.1f}%, Wards/Pct {matched_wp/n*100:.1f}%, ZIPs {matched_zp/n*100:.1f}%")
    print(f"  tickets.bin:    {bin_path.stat().st_size / (1024*1024):.2f} MB")
    print(f"  regions.json:   {regions_path.stat().st_size / 1024:.1f} KB")
    print(f"  meta.json:      {meta_path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
