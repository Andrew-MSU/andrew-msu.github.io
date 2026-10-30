#!/usr/bin/env python3
"""Build the static data files for the Lab 10 practice site.

Inputs are public-domain / openly published datasets already downloaded:

- USGS Historical Topographic Map Collection GeoTIFF
  Nez Perce Hollow 1:24,000 quadrangle (public domain)
- USGS 3DEP bare-earth DEM from The National Map ImageServer
- Montana Bureau of Mines and Geology 1:100,000 seamless geologic map units

The script clips, simplifies, and writes the files under ../data.
It does not embed semester information.
"""

import json
import os
import subprocess
from collections import OrderedDict

from osgeo import gdal, ogr, osr
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
SRC = os.environ.get("LAB10_SRC", "/tmp/lab10data")

WEST, SOUTH, EAST, NORTH = -112.618, 45.50799, -112.552, 45.562

COLORS = {
    "Kf": "#3d6f99",
    "Kgd": "#d45d79",
    "Qaf": "#e0b43c",
    "Qafo": "#a6842e",
    "Kfbm": "#3f8f8a",
    "Tdf": "#e07a2f",
    "Tsc": "#3e8f45",
    "Kblv": "#8d5f93",
    "Tv": "#c4544a",
    "Qc": "#8d8680",
    "*q": "#8a6249",
}


def run(cmd):
    print("+", " ".join(cmd))
    subprocess.check_call(cmd)


def srs(epsg):
    ref = osr.SpatialReference()
    ref.ImportFromEPSG(epsg)
    ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return ref


WGS = srs(4326)
UTM = srs(32612)
TO_UTM = osr.CoordinateTransformation(WGS, UTM)


def box_geom():
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for x, y in (
        (WEST, SOUTH),
        (EAST, SOUTH),
        (EAST, NORTH),
        (WEST, NORTH),
        (WEST, SOUTH),
    ):
        ring.AddPoint(x, y)
    poly = ogr.Geometry(ogr.wkbPolygon)
    poly.AddGeometry(ring)
    return poly


def utm_area(geom):
    g = geom.Clone()
    g.Transform(TO_UTM)
    return g.GetArea()


def round_ring(ring, nd=5):
    out = []
    for x, y in ring:
        pt = (round(x, nd), round(y, nd))
        if not out or out[-1] != pt:
            out.append(pt)
    if len(out) >= 2 and out[0] != out[-1]:
        out.append(out[0])
    if len(out) >= 2 and out[0] == out[-1] and len(out) < 4:
        return None
    # drop consecutive duplicates already handled; remove spike duplicates
    return out


def geom_to_polygon_coords(geom):
    geom = geom.Clone()
    if geom.GetGeometryType() != ogr.wkbPolygon:
        geom = ogr.ForceToPolygon(geom)
    geom = geom.SimplifyPreserveTopology(0.00008)
    if geom is None or geom.IsEmpty():
        return None
    name = geom.GetGeometryName()
    if name != "POLYGON":
        # take the largest polygon piece
        if name == "MULTIPOLYGON":
            best = None
            best_a = -1
            for i in range(geom.GetGeometryCount()):
                part = geom.GetGeometryRef(i)
                a = utm_area(part)
                if a > best_a:
                    best, best_a = part, a
            geom = best
        else:
            return None
    coords = []
    for i in range(geom.GetGeometryCount()):
        ring = geom.GetGeometryRef(i)
        pts = [(ring.GetX(j), ring.GetY(j)) for j in range(ring.GetPointCount())]
        cleaned = round_ring(pts)
        if cleaned:
            coords.append(cleaned)
    if not coords or len(coords[0]) < 4:
        return None
    return coords


def explode(geom):
    geom = geom.MakeValid() if hasattr(geom, "MakeValid") else geom
    name = geom.GetGeometryName()
    if name == "POLYGON":
        return [geom]
    if name == "MULTIPOLYGON":
        return [geom.GetGeometryRef(i).Clone() for i in range(geom.GetGeometryCount())]
    if name == "GEOMETRYCOLLECTION":
        out = []
        for i in range(geom.GetGeometryCount()):
            out.extend(explode(geom.GetGeometryRef(i)))
        return out
    return []


def prepare_scan():
    tif = os.path.join(SRC, "nezperce.tif")
    raw = os.path.join(SRC, "scan_warp.tif")
    run(
        [
            "gdalwarp",
            "-t_srs",
            "EPSG:4326",
            "-te",
            str(WEST),
            str(SOUTH),
            str(EAST),
            str(NORTH),
            "-ts",
            "1600",
            "0",
            "-r",
            "cubic",
            "-dstalpha",
            "-overwrite",
            tif,
            raw,
        ]
    )
    im = Image.open(raw).convert("RGB")
    out = os.path.join(DATA, "scan.jpg")
    im.save(out, "JPEG", quality=74, optimize=True, progressive=True)
    # Exact bounds from the warped raster so pixel space matches geography.
    info = subprocess.check_output(["gdalinfo", "-json", raw])
    meta = json.loads(info)
    corners = meta["cornerCoordinates"]
    # gdalinfo json uses upperLeft etc. as [lon, lat] after traditional order? 
    # GDAL JSON cornerCoordinates are [x, y] in the dataset CRS. For EPSG:4326
    # with traditional GIS order, x is longitude.
    ul = corners["upperLeft"]
    lr = corners["lowerRight"]
    scan = {
        "title": "USGS historical 1:24,000 topographic map, Nez Perce Hollow quadrangle, Montana",
        "credit": "U.S. Geological Survey, Historical Topographic Map Collection. Public domain. Cropped inside the neatline and saved without a world file so it can be georeferenced by hand.",
        "sourceUrl": "https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-the-past",
        "downloadUrl": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF/MT/MT_Nez%20Perce%20Hollow_265723_1961_24000_geo.tif",
        "west": ul[0],
        "north": ul[1],
        "east": lr[0],
        "south": lr[1],
        "width": im.size[0],
        "height": im.size[1],
    }
    with open(os.path.join(DATA, "scan.json"), "w") as f:
        json.dump(scan, f, indent=2)
        f.write("\n")
    print("scan", im.size, os.path.getsize(out), scan["west"], scan["south"], scan["east"], scan["north"])
    return out


def prepare_geology():
    raw = json.load(open(os.path.join(SRC, "geol_raw.geojson")))
    box = box_geom()
    pieces = []
    for feat in raw["features"]:
        geom = ogr.CreateGeometryFromJson(json.dumps(feat["geometry"]))
        inter = geom.Intersection(box)
        if inter is None or inter.IsEmpty():
            continue
        for part in explode(inter):
            area = utm_area(part)
            if area < 220_000:
                continue
            coords = geom_to_polygon_coords(part)
            if not coords:
                continue
            holes = len(coords) - 1
            pieces.append(
                {
                    "area": area,
                    "holes": holes,
                    "coords": coords,
                    "unit": feat["properties"].get("MapUnit") or "",
                    "name": feat["properties"].get("MapUnitName") or "",
                }
            )
    # Choose a gap: the medium polygon whose interior is least covered by others
    # and is not the only simple split candidate.
    center = ((WEST + EAST) / 2, (SOUTH + NORTH) / 2)

    def centroid(coords):
        ring = coords[0]
        sx = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
        sy = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
        return sx, sy

    def dist2(coords):
        c = centroid(coords)
        return (c[0] - center[0]) ** 2 + (c[1] - center[1]) ** 2

    # A hole-free granodiorite near the middle of the sheet is an easy Split target.
    split_cands = [
        p
        for p in pieces
        if p["holes"] == 0 and p["unit"] == "Kgd" and 1_000_000 <= p["area"] <= 4_500_000
    ]
    if not split_cands:
        split_cands = [p for p in pieces if p["holes"] == 0 and 800_000 <= p["area"] <= 4_500_000]
    split = min(split_cands, key=lambda p: dist2(p["coords"]))

    # Remove a different polygon to leave an empty patch. Prefer Sixmile Creek,
    # then a debris-flow or alluvial fan, large enough to see on a phone.
    gap_pool = [
        p
        for p in pieces
        if p is not split and p["area"] >= 800_000 and p["unit"] in {"Tsc", "Tdf", "Qaf", "Qafo"}
    ]
    if not gap_pool:
        gap_pool = [p for p in pieces if p is not split and p["area"] >= 800_000]
    gap = max(gap_pool, key=lambda p: p["area"] if p["unit"] == "Tsc" else p["area"] * 0.5)

    kept = [p for p in pieces if p is not gap]
    kept.sort(key=lambda p: -p["area"])
    features = []
    split_id = None
    for i, p in enumerate(kept, start=1):
        props = {
            "id": i,
            "unit": p["unit"],
            "formation": p["name"],
            "color": COLORS.get(p["unit"], "#777777"),
            "splitThis": p is split,
        }
        if p is split:
            split_id = i
        features.append(
            {
                "type": "Feature",
                "id": i,
                "properties": props,
                "geometry": {"type": "Polygon", "coordinates": p["coords"]},
            }
        )
    fc = {"type": "FeatureCollection", "features": features}
    with open(os.path.join(DATA, "geology.geojson"), "w") as f:
        json.dump(fc, f, separators=(",", ":"))
        f.write("\n")
    task = {
        "splitId": split_id,
        "splitName": split["name"],
        "splitUnit": split["unit"],
        "gapName": gap["name"],
        "gapUnit": gap["unit"],
        "credit": "Montana Bureau of Mines and Geology, 1:100,000 seamless geologic map, map-unit polygons. Clipped to the McCartney Mountains area. Polygons smaller than about 0.22 km² were dropped, boundaries were simplified, and one polygon was left off so the editing exercise has an empty patch.",
        "service": "https://mbmgmap.mtech.edu/server/rest/services/Geology/Geology100k_Seamless/MapServer/3",
    }
    with open(os.path.join(DATA, "geology.json"), "w") as f:
        json.dump(task, f, indent=2)
        f.write("\n")
    print(
        "geology features",
        len(features),
        "split",
        split_id,
        split["name"],
        "gap",
        gap["name"],
        round(gap["area"] / 1e6, 2),
        "kb",
        os.path.getsize(os.path.join(DATA, "geology.geojson")) // 1024,
    )
    return os.path.join(DATA, "scan.jpg")


def prepare_dem():
    dem = os.path.join(SRC, "dem.tif")
    utm = os.path.join(SRC, "dem10.tif")
    hill = os.path.join(SRC, "hill_utm.tif")
    hill_ll = os.path.join(SRC, "hill_ll.tif")
    contours = os.path.join(SRC, "contours.shp")
    run(
        [
            "gdalwarp",
            "-t_srs",
            "EPSG:32612",
            "-te_srs",
            "EPSG:4326",
            "-te",
            str(WEST),
            str(SOUTH),
            str(EAST),
            str(NORTH),
            "-tr",
            "10",
            "10",
            "-r",
            "bilinear",
            "-dstnodata",
            "-9999",
            "-overwrite",
            dem,
            utm,
        ]
    )
    # Bilinear samples at the edge mix real elevations with empty cells and
    # invent a false low rim. Real ground in this clip is above ~1,700 m.
    ds = gdal.Open(utm, gdal.GA_Update)
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray()
    nodata = -9999.0
    arr[arr < 1680] = nodata
    band.WriteArray(arr)
    band.SetNoDataValue(nodata)
    band.FlushCache()
    ds.FlushCache()
    ds = None
    run(
        [
            "gdaldem",
            "hillshade",
            utm,
            hill,
            "-z",
            "1",
            "-az",
            "315",
            "-alt",
            "45",
            "-compute_edges",
        ]
    )
    run(
        [
            "gdalwarp",
            "-t_srs",
            "EPSG:4326",
            "-te_srs",
            "EPSG:4326",
            "-te",
            str(WEST),
            str(SOUTH),
            str(EAST),
            str(NORTH),
            "-ts",
            "900",
            "0",
            "-r",
            "bilinear",
            "-overwrite",
            hill,
            hill_ll,
        ]
    )
    im = Image.open(hill_ll).convert("L")
    hill_jpg = os.path.join(DATA, "hillshade.jpg")
    im.save(hill_jpg, "JPEG", quality=68, optimize=True, progressive=True)
    info = json.loads(subprocess.check_output(["gdalinfo", "-json", hill_ll]))
    ul = info["cornerCoordinates"]["upperLeft"]
    lr = info["cornerCoordinates"]["lowerRight"]
    stats = json.loads(subprocess.check_output(["gdalinfo", "-json", "-stats", utm]))
    band = stats["bands"][0]
    hill_meta = {
        "credit": "Hillshade from a USGS 3DEP bare-earth DEM (The National Map), about 10 m spacing, clipped to the McCartney Mountains. Azimuth 315°, altitude 45°, z-factor 1 on a 10 m UTM grid.",
        "sourceUrl": "https://apps.nationalmap.gov/downloader/",
        "service": "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer",
        "west": ul[0],
        "north": ul[1],
        "east": lr[0],
        "south": lr[1],
        "minElev": round(band["minimum"], 1),
        "maxElev": round(band["maximum"], 1),
        "interval": 20,
    }
    with open(os.path.join(DATA, "hillshade.json"), "w") as f:
        json.dump(hill_meta, f, indent=2)
        f.write("\n")

    if os.path.exists(contours):
        for ext in (".shp", ".shx", ".dbf", ".prj"):
            p = os.path.splitext(contours)[0] + ext
            if os.path.exists(p):
                os.remove(p)
    run(
        [
            "gdal_contour",
            "-a",
            "Contour",
            "-i",
            "20",
            utm,
            contours,
        ]
    )
    gj = os.path.join(SRC, "contours_raw.geojson")
    run(
        [
            "ogr2ogr",
            "-f",
            "GeoJSON",
            "-t_srs",
            "EPSG:4326",
            "-simplify",
            "8",
            gj,
            contours,
        ]
    )
    raw = json.load(open(gj))
    box = box_geom()
    features = []
    fid = 1
    for feat in raw["features"]:
        elev = int(round(float(feat["properties"]["Contour"])))
        # snap float noise onto the 20 m levels
        elev = int(round(elev / 20.0) * 20)
        geom = ogr.CreateGeometryFromJson(json.dumps(feat["geometry"]))
        inter = geom.Intersection(box)
        if inter is None or inter.IsEmpty():
            continue
        parts = []
        name = inter.GetGeometryName()
        if name == "LINESTRING":
            parts = [inter]
        elif name == "MULTILINESTRING":
            parts = [inter.GetGeometryRef(i) for i in range(inter.GetGeometryCount())]
        elif name == "GEOMETRYCOLLECTION":
            for i in range(inter.GetGeometryCount()):
                g = inter.GetGeometryRef(i)
                if g.GetGeometryName() == "LINESTRING":
                    parts.append(g)
                elif g.GetGeometryName() == "MULTILINESTRING":
                    parts.extend(g.GetGeometryRef(j) for j in range(g.GetGeometryCount()))
        for part in parts:
            if part.Length() <= 0:
                continue
            g = part.Clone()
            g.Transform(TO_UTM)
            length = g.Length()
            if length < 180:
                continue
            pts = []
            for i in range(part.GetPointCount()):
                pt = (round(part.GetX(i), 5), round(part.GetY(i), 5))
                if not pts or pts[-1] != pt:
                    pts.append(pt)
            if len(pts) < 2:
                continue
            features.append(
                {
                    "type": "Feature",
                    "id": fid,
                    "properties": {"id": fid, "Contour": elev, "Type": ""},
                    "geometry": {"type": "LineString", "coordinates": pts},
                }
            )
            fid += 1
    out = {"type": "FeatureCollection", "features": features}
    path = os.path.join(DATA, "contours.geojson")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    index_n = sum(1 for ft in features if ft["properties"]["Contour"] % 100 == 0)
    print(
        "contours",
        len(features),
        "index",
        index_n,
        "kb",
        os.path.getsize(path) // 1024,
        "hill",
        os.path.getsize(hill_jpg) // 1024,
        "elev",
        hill_meta["minElev"],
        hill_meta["maxElev"],
    )


def preview():
    scan = Image.open(os.path.join(DATA, "scan.jpg")).convert("RGB")
    geol = json.load(open(os.path.join(DATA, "geology.geojson")))
    meta = json.load(open(os.path.join(DATA, "scan.json")))
    w, h = scan.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")

    def xy(lon, lat):
        x = (lon - meta["west"]) / (meta["east"] - meta["west"]) * (w - 1)
        y = (meta["north"] - lat) / (meta["north"] - meta["south"]) * (h - 1)
        return x, y

    for feat in geol["features"]:
        color = feat["properties"]["color"].lstrip("#")
        rgb = tuple(int(color[i : i + 2], 16) for i in (0, 2, 4))
        rings = feat["geometry"]["coordinates"]
        exterior = [xy(x, y) for x, y in rings[0]]
        draw.polygon(exterior, fill=rgb + (110,), outline=(20, 20, 20, 220))
        for hole in rings[1:]:
            draw.polygon([xy(x, y) for x, y in hole], fill=(255, 255, 255, 0))
        if feat["properties"].get("splitThis"):
            draw.line(exterior + [exterior[0]], fill=(0, 0, 0, 255), width=4)
    scan.paste(Image.alpha_composite(scan.convert("RGBA"), overlay).convert("RGB"))
    out = os.path.join(SRC, "geology_preview.jpg")
    scan.save(out, "JPEG", quality=70)
    print("preview", out)


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    prepare_scan()
    prepare_geology()
    prepare_dem()
    preview()
