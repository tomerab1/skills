#!/usr/bin/env python3
"""
walk.py — geocode + OpenStreetMap feature discovery + foot routing for the
`walk-route` skill. Turns a place + preferences into a real, followable walking
route (GPX), using Overpass for *what's around* and BRouter for *how to walk it*.

Pure stdlib. Talks to three public OSM-ecosystem services, politely:
  - Nominatim   (geocoding: place -> lat/lon)
  - Overpass    (OSM data: parks, water, viewpoints, paths, ... around a point)
  - BRouter     (foot routing: a list of points -> a walkable track + GPX)

Subcommands
-----------
  geocode <query> [--limit N] [--lang he,en]
        Place name (Hebrew or English) -> ranked candidates with lat/lon + bbox.

  features --around LAT,LON --radius M [--kinds park,water,...] [--limit N]
        Discover OSM features near a point (POIs + green space + paths). Prints
        JSON the agent reads to choose waypoints. `--kinds list` shows the menu.

  route --pts "LAT,LON;LAT,LON;..." [--via ...] --out FILE.gpx
        [--profile foot|scenic|quiet|short] [--name "..."] [--wpt "LAT,LON,Label"]
        Route an explicit point sequence through BRouter and write a GPX track.
        Repeat --wpt to drop named markers (your chosen POIs) into the GPX.

  loop --around LAT,LON --km DIST [--kinds park,water,...] --out FILE.gpx
        [--profile ...] [--name "..."] [--tolerance 0.2] [--seed N]
        Build a round-trip of ~DIST km from a start point: pick spread-out POIs
        of the preferred kinds, route a loop through them, and fit the distance
        by adjusting the ring. Writes GPX with the POIs as waypoints.

  turbo --around LAT,LON --radius M [--kinds ...]
        Print an overpass-turbo.eu link (and the raw Overpass QL) for the same
        discovery query, so you can eyeball the data on a map in the browser.

All state lives under  ~/.claude/walk-route/  (override with WALK_ROUTE_DIR):
responses are disk-cached and each host is rate-limited, so re-planning the same
area is fast and makes no new requests. This is for personal route planning —
keep queries targeted; don't bulk-harvest.

Politeness / fair use:
  - identifies honestly via User-Agent (set WALK_ROUTE_UA to add contact info),
  - sleeps between live requests to each host,
  - caches every response (TTLs below). Respect each service's usage policy:
    Nominatim = max ~1 req/s + cache; Overpass / BRouter = don't hammer.
"""
from __future__ import annotations

import sys, os, re, json, time, math, hashlib, argparse
import urllib.parse, urllib.request, urllib.error
from xml.dom import minidom

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

STATE_DIR = os.environ.get(
    "WALK_ROUTE_DIR",
    os.path.expanduser("~/.claude/walk-route"),
)
CACHE_DIR = os.path.join(STATE_DIR, "cache")
THROTTLE_DIR = os.path.join(STATE_DIR, "throttle")

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = "https://overpass-api.de/api/interpreter"
BROUTER = "https://brouter.de/brouter"
VALHALLA = "https://valhalla1.openstreetmap.de/route"
VALHALLA_LOCATE = "https://valhalla1.openstreetmap.de/locate"
TURBO = "https://overpass-turbo.eu/"

_contact = os.environ.get("WALK_ROUTE_UA", "").strip()
USER_AGENT = (
    "walk-route/0.1 (Claude Code skill; personal route planning"
    + (f"; {_contact}" if _contact else "")
    + ")"
)

# per-host minimum seconds between live requests, and cache TTL in seconds
HOSTS = {
    "nominatim.openstreetmap.org": dict(interval=1.1, ttl=30 * 86400),
    "overpass-api.de":             dict(interval=2.0, ttl=14 * 86400),
    "brouter.de":                  dict(interval=1.0, ttl=14 * 86400),
    "valhalla1.openstreetmap.de":  dict(interval=1.0, ttl=14 * 86400),
}

# kind -> list of Overpass element filters (without the (around:...) clause).
# Each entry produces both node and way variants where it makes sense.
KINDS = {
    "park":       ['["leisure"="park"]', '["leisure"="garden"]',
                   '["landuse"="recreation_ground"]', '["leisure"="nature_reserve"]'],
    "forest":     ['["natural"="wood"]', '["landuse"="forest"]'],
    "water":      ['["natural"="water"]', '["waterway"~"^(river|stream|canal)$"]',
                   '["natural"="beach"]'],
    "fountain":   ['["amenity"="drinking_water"]', '["amenity"="fountain"]',
                   '["natural"="spring"]'],
    "viewpoint":  ['["tourism"="viewpoint"]', '["natural"="peak"]'],
    "historic":   ['["historic"]'],
    "cafe":       ['["amenity"="cafe"]', '["amenity"="restaurant"]', '["amenity"="ice_cream"]'],
    "bench":      ['["amenity"="bench"]'],
    "playground": ['["leisure"="playground"]'],
    "toilet":     ['["amenity"="toilets"]'],
    "art":        ['["tourism"="artwork"]', '["historic"="memorial"]'],
}
# how to render a feature's "kind" label from its tags (first match wins)
_LABEL_TAGS = ["name", "tourism", "leisure", "amenity", "natural",
               "historic", "landuse", "waterway"]

# Two routing engines:
#  - Valhalla "pedestrian" costing (DEFAULT): a real foot model that sticks to
#    sidewalks / footways / pedestrian streets / crossings and avoids tracks and
#    non-walkable surfaces. This is what "walkable surfaces only" needs.
#  - BRouter: better for genuine trails/hikes (it will use paths and tracks).
# `--profile` picks the character; `--engine auto` routes walking profiles to
# Valhalla and trail/hike profiles to BRouter.
BROUTER_PROFILES = {                      # friendly name -> BRouter profile
    "trail":  "hiking-mountain",
    "hike":   "hiking-mountain",
    "mountain": "hiking-mountain",
    "short":  "shortest",
    "direct": "shortest",
}
TRAIL_PROFILES = {"trail", "hike", "mountain"}   # default to BRouter for these

# Valhalla pedestrian costing — bias hard toward proper walkways, shun tracks.
PED_COSTING = {
    "walking_speed": 5.0,
    "walkway_factor": 0.8,     # <1 makes dedicated footways cheaper -> preferred
    "sidewalk_factor": 0.9,
    "alley_factor": 2.0,       # avoid alleys
    "driveway_factor": 5.0,    # avoid driveways
    "use_tracks": 0.0,         # don't route over rough tracks
    "use_living_streets": 0.5,
    "max_hiking_difficulty": 1,
}

EARTH_R = 6371008.8  # mean Earth radius, metres


# -----------------------------------------------------------------------------
# Small utilities: geo, cache, throttled HTTP
# -----------------------------------------------------------------------------

def _ensure_dirs():
    for d in (CACHE_DIR, THROTTLE_DIR):
        os.makedirs(d, exist_ok=True)


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lon, bearing_deg, dist_m):
    """Point reached going dist_m at bearing_deg from (lat,lon)."""
    d = dist_m / EARTH_R
    th = math.radians(bearing_deg)
    p1 = math.radians(lat)
    l1 = math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def _host_of(url):
    return urllib.parse.urlsplit(url).hostname or ""


def _throttle(host):
    cfg = HOSTS.get(host)
    if not cfg:
        return
    path = os.path.join(THROTTLE_DIR, host)
    try:
        last = os.path.getmtime(path)
    except OSError:
        last = 0.0
    wait = cfg["interval"] - (time.time() - last)
    if wait > 0:
        time.sleep(wait)
    open(path, "a").close()
    os.utime(path, None)


def _cache_path(key):
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    return os.path.join(CACHE_DIR, h + ".cache")


def _cache_get(key, ttl):
    path = _cache_path(key)
    try:
        if time.time() - os.path.getmtime(path) < ttl:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
    except OSError:
        pass
    return None


def _cache_put(key, text):
    try:
        with open(_cache_path(key), "w", encoding="utf-8") as fh:
            fh.write(text)
    except OSError:
        pass


def http(url, *, data=None, headers=None, ttl=None, timeout=90, tries=3):
    """GET (or POST if data) with on-disk cache + per-host throttle + retries."""
    _ensure_dirs()
    host = _host_of(url)
    if ttl is None:
        ttl = HOSTS.get(host, {}).get("ttl", 0)
    cache_key = url + ("\n" + data if data else "")
    if ttl:
        hit = _cache_get(cache_key, ttl)
        if hit is not None:
            return hit

    body = data.encode("utf-8") if isinstance(data, str) else data
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)

    last_err = None
    for attempt in range(tries):
        _throttle(host)
        req = urllib.request.Request(url, data=body, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
            if ttl:
                _cache_put(cache_key, text)
            return text
        except urllib.error.HTTPError as e:
            last_err = e
            detail = e.read().decode("utf-8", "replace")[:300] if e.fp else ""
            # 4xx (except 429) won't fix on retry
            if e.code != 429 and 400 <= e.code < 500:
                raise RuntimeError(f"{host} HTTP {e.code}: {detail}") from None
            time.sleep(2 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{host} request failed after {tries} tries: {last_err}")


def parse_latlon(s):
    """'LAT,LON' -> (float,float). Tolerant of spaces."""
    parts = [p for p in re.split(r"[;, ]+", s.strip()) if p]
    if len(parts) < 2:
        raise ValueError(f"expected LAT,LON, got {s!r}")
    return float(parts[0]), float(parts[1])


# -----------------------------------------------------------------------------
# Geocoding (Nominatim)
# -----------------------------------------------------------------------------

def geocode(query, limit=5, lang="he,en"):
    q = urllib.parse.urlencode({
        "q": query, "format": "jsonv2", "limit": str(limit),
        "addressdetails": "1", "accept-language": lang,
    })
    raw = http(NOMINATIM + "?" + q, headers={"Accept": "application/json"})
    out = []
    for r in json.loads(raw):
        bb = r.get("boundingbox") or []
        out.append({
            "name": r.get("display_name"),
            "lat": float(r["lat"]), "lon": float(r["lon"]),
            "type": r.get("type"), "category": r.get("category"),
            "bbox": [float(x) for x in bb] if len(bb) == 4 else None,  # [s,n,w,e]
        })
    return out


# -----------------------------------------------------------------------------
# Feature discovery (Overpass)
# -----------------------------------------------------------------------------

def _overpass_ql(lat, lon, radius, kinds):
    bad = [k for k in kinds if k not in KINDS]
    if bad:
        raise ValueError(f"unknown kind(s): {', '.join(bad)}. "
                         f"known: {', '.join(sorted(KINDS))}")
    clauses = []
    around = f"(around:{int(radius)},{lat},{lon})"
    for k in kinds:
        for filt in KINDS[k]:
            clauses.append(f"  nwr{filt}{around};")
    return ("[out:json][timeout:25];\n(\n" + "\n".join(clauses)
            + "\n);\nout center tags;")


def features(lat, lon, radius, kinds, limit=60):
    ql = _overpass_ql(lat, lon, radius, kinds)
    raw = http(OVERPASS, data="data=" + urllib.parse.quote(ql),
               headers={"Content-Type": "application/x-www-form-urlencoded",
                        "Accept": "application/json"})
    data = json.loads(raw)
    seen, out = set(), []
    for el in data.get("elements", []):
        if el["type"] == "node":
            flat, flon = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            flat, flon = c.get("lat"), c.get("lon")
        if flat is None or flon is None:
            continue
        tags = el.get("tags", {}) or {}
        label = next((tags[t] for t in _LABEL_TAGS if tags.get(t)), el["type"])
        name = tags.get("name") or tags.get("name:en") or tags.get("name:he")
        key = (round(flat, 5), round(flon, 5), label)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "lat": flat, "lon": flon, "name": name, "label": label,
            "dist_m": round(haversine(lat, lon, flat, flon)),
            "osm": f"{el['type']}/{el['id']}",
            "tags": {k: tags[k] for k in tags
                     if k in ("name", "amenity", "leisure", "tourism",
                              "natural", "historic", "landuse", "waterway")},
        })
    out.sort(key=lambda f: f["dist_m"])
    return out[:limit]


def turbo_link(lat, lon, radius, kinds):
    ql = _overpass_ql(lat, lon, radius, kinds)
    url = TURBO + "?" + urllib.parse.urlencode({"Q": ql})
    url += f"#map=15/{lat}/{lon}"
    return url, ql


# -----------------------------------------------------------------------------
# Foot routing (BRouter) + GPX
# -----------------------------------------------------------------------------

def brouter_route(points, profile="trail"):
    """points: list of (lat,lon). Returns dict(coords=[(lon,lat[,ele])],
    length_m, ascent_m, time_s). BRouter wants lon,lat order. Used for trails."""
    if len(points) < 2:
        raise ValueError("need at least 2 points to route")
    bp = BROUTER_PROFILES.get(profile, profile)
    lonlats = "|".join(f"{lon},{lat}" for lat, lon in points)
    q = urllib.parse.urlencode({
        "lonlats": lonlats, "profile": bp, "alternativeidx": "0",
        "format": "geojson",
    })
    raw = http(BROUTER + "?" + q, headers={"Accept": "application/json"})
    try:
        gj = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"BRouter did not return JSON: {raw[:200]}") from None
    feats = gj.get("features") or []
    if not feats:
        raise RuntimeError(f"BRouter returned no route: {raw[:200]}")
    feat = feats[0]
    coords = feat["geometry"]["coordinates"]
    props = feat.get("properties", {})

    def _num(key, default=0.0):
        try:
            return float(props.get(key))
        except (TypeError, ValueError):
            return default
    return {
        "coords": coords,
        "length_m": _num("track-length"),
        "ascent_m": _num("filtered ascend"),
        "time_s": _num("total-time"),
        "profile": "brouter:" + bp,
    }


def decode_polyline6(s, precision=6):
    """Decode a Valhalla-encoded polyline (precision 6) -> [(lon,lat)]."""
    factor = 10 ** precision
    coords, index, lat, lng, n = [], 0, 0, 0, len(s)
    while index < n:
        for axis in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if (result & 1) else (result >> 1)
            if axis == 0:
                lat += d
            else:
                lng += d
        coords.append((lng / factor, lat / factor))   # (lon, lat) like BRouter
    return coords


def valhalla_route(points, costing_options=None):
    """points: list of (lat,lon). Routes with Valhalla 'pedestrian' costing —
    sidewalks/footways/pedestrian ways, avoiding tracks and non-walkable
    surfaces. Returns the same dict shape as brouter_route()."""
    if len(points) < 2:
        raise ValueError("need at least 2 points to route")
    body = json.dumps({
        "locations": [{"lat": la, "lon": lo} for la, lo in points],
        "costing": "pedestrian",
        "costing_options": {"pedestrian": costing_options or PED_COSTING},
        "directions_options": {"units": "kilometers"},
    })
    raw = http(VALHALLA, data=body,
               headers={"Content-Type": "application/json",
                        "Accept": "application/json"})
    trip = (json.loads(raw) or {}).get("trip", {})
    if trip.get("status") != 0:
        raise RuntimeError(f"Valhalla: {trip.get('status_message', raw[:200])}")
    coords = []
    for leg in trip.get("legs", []):
        seg = decode_polyline6(leg["shape"])
        if coords and seg and coords[-1] == seg[0]:
            seg = seg[1:]               # drop the duplicate point shared at joins
        coords.extend(seg)
    summ = trip.get("summary", {})
    return {
        "coords": coords,
        "length_m": float(summ.get("length", 0.0)) * 1000.0,
        "ascent_m": 0.0,                # Valhalla /route doesn't return elevation
        "time_s": float(summ.get("time", 0.0)),
        "profile": "valhalla:pedestrian",
    }


def route_engine(points, profile="foot", engine="auto"):
    """Dispatch to a routing engine. Default ('auto'): walking profiles ->
    Valhalla pedestrian (walkable surfaces only); trail/hike profiles -> BRouter.
    On a Valhalla failure in auto mode, fall back to BRouter so a route still
    comes back (noted on stderr)."""
    if engine == "brouter":
        return brouter_route(points, profile)
    if engine == "valhalla":
        return valhalla_route(points)
    # auto
    if profile in TRAIL_PROFILES:
        return brouter_route(points, profile)
    try:
        return valhalla_route(points)
    except RuntimeError as e:
        print(f"warning: Valhalla failed ({e}); falling back to BRouter",
              file=sys.stderr)
        return brouter_route(points, "trail")


def geo_length_m(coords):
    """Length of a [(lon,lat[,ele])] polyline, metres."""
    return sum(haversine(a[1], a[0], b[1], b[0])
               for a, b in zip(coords, coords[1:]))


def trim_spurs(coords, eps_m=12, max_arm_m=70):
    """Remove SHORT out-and-back 'lollipop' hairs from a routed track.

    When a waypoint is an area feature's centroid (a park/garden polygon), it
    often sits just off the walkable network, so the router detours in and
    retraces the same way out — leaving a small hair. At such a U-turn the track
    folds back on itself: the points either side of the tip coincide
    (pt[t-1] ~ pt[t+1]). We expand outward to find the whole folded arm and
    collapse it — but ONLY if the arm is shorter than `max_arm_m`. A genuine
    longer out-and-back (e.g. a turnaround to a far viewpoint) is a route-design
    choice, not an artifact, so it is left intact rather than silently deleted.
    Endpoints are preserved, so a closed loop stays closed.
    Returns (trimmed_coords, points_removed)."""
    pts = [tuple(c) for c in coords]
    removed, changed = 0, True
    while changed:
        changed = False
        t = 1
        while t < len(pts) - 1:
            if haversine(pts[t - 1][1], pts[t - 1][0],
                         pts[t + 1][1], pts[t + 1][0]) < eps_m:
                lo, hi = t - 1, t + 1          # mirror base pts[lo] ~ pts[hi]
                while (lo - 1 >= 0 and hi + 1 < len(pts) and
                       haversine(pts[lo - 1][1], pts[lo - 1][0],
                                 pts[hi + 1][1], pts[hi + 1][0]) < eps_m):
                    lo -= 1
                    hi += 1
                if geo_length_m(pts[lo:t + 1]) <= max_arm_m:   # short hair only
                    del pts[lo + 1:hi + 1]      # keep base pts[lo], drop the fold
                    removed += hi - lo
                    changed = True
                    t = max(1, lo)
                    continue
            t += 1
    return pts, removed


def _xesc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def write_gpx(path, name, coords, waypoints=None):
    """coords: [(lon,lat[,ele])]. waypoints: [dict(lat,lon,name,label)]."""
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<gpx version="1.1" creator="walk-route" '
             'xmlns="http://www.topografix.com/GPX/1/1">',
             f'  <metadata><name>{_xesc(name)}</name></metadata>']
    for w in (waypoints or []):
        lines.append(f'  <wpt lat="{w["lat"]:.6f}" lon="{w["lon"]:.6f}">')
        if w.get("name"):
            lines.append(f'    <name>{_xesc(w["name"])}</name>')
        if w.get("label"):
            lines.append(f'    <type>{_xesc(w["label"])}</type>')
        lines.append('  </wpt>')
    lines.append(f'  <trk><name>{_xesc(name)}</name><trkseg>')
    for c in coords:
        lon, lat = c[0], c[1]
        if len(c) > 2 and c[2] is not None:
            lines.append(f'    <trkpt lat="{lat:.6f}" lon="{lon:.6f}">'
                         f'<ele>{float(c[2]):.1f}</ele></trkpt>')
        else:
            lines.append(f'    <trkpt lat="{lat:.6f}" lon="{lon:.6f}"/>')
    lines.append('  </trkseg></trk>')
    lines.append('</gpx>')
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def write_kml(path, name, coords, waypoints=None):
    """coords: [(lon,lat[,ele])]. Writes KML — importable by Google My Maps
    (which then shows inside the Google Maps app) and Google Earth."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
           f'  <name>{_xesc(name)}</name>',
           '  <Style id="route"><LineStyle>'
           '<color>ff2222dd</color><width>4</width></LineStyle></Style>',
           f'  <Placemark><name>{_xesc(name)}</name><styleUrl>#route</styleUrl>',
           '    <LineString><tessellate>1</tessellate><coordinates>',
           '      ' + " ".join(f"{c[0]:.6f},{c[1]:.6f}" for c in coords),
           '    </coordinates></LineString></Placemark>']
    for w in (waypoints or []):
        out.append('  <Placemark>')
        if w.get("name"):
            out.append(f'    <name>{_xesc(w["name"])}</name>')
        if w.get("label"):
            out.append(f'    <description>{_xesc(w["label"])}</description>')
        out.append(f'    <Point><coordinates>{w["lon"]:.6f},{w["lat"]:.6f},0'
                   '</coordinates></Point>')
        out.append('  </Placemark>')
    out.append('</Document></kml>')
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))


def write_track(path, name, coords, waypoints=None):
    """Write GPX or KML by output extension (.kml -> KML, else GPX)."""
    if path.lower().endswith(".kml"):
        write_kml(path, name, coords, waypoints)
    else:
        write_gpx(path, name, coords, waypoints)


# -----------------------------------------------------------------------------
# Loop builder
# -----------------------------------------------------------------------------

# edge "walkability" score for snapping (lower = better for a stroll): prefer
# residential/living streets, footways/paths; shun arterials and stairs.
_EDGE_CLASS_SCORE = {
    "residential": 1, "living_street": 1, "service": 2, "service_other": 2,
    "unclassified": 2, "tertiary": 4, "tertiary_link": 4, "secondary": 7,
    "secondary_link": 7, "primary": 9, "primary_link": 9, "trunk": 13,
    "trunk_link": 13, "motorway": 99, "motorway_link": 99,
}
_EDGE_USE_SCORE = {
    "footway": -2, "path": -2, "pedestrian": -2, "sidewalk": -2, "cycleway": -1,
    "track": 2, "steps": 5, "elevator": 9,
}


def snap_to_network(points, engine="auto"):
    """Snap each (lat,lon) to the nearest *walkable* edge via Valhalla /locate,
    preferring footways/residential over arterials and stairs. This keeps loops
    on real pedestrian ways instead of diving to off-network POI centroids —
    which is what produced spikes, on-arterial stretches, and lines clipping
    buildings. Returns the input point unchanged if it can't be located, and is
    a no-op for the BRouter engine."""
    if engine == "brouter":
        return list(points)
    body = json.dumps({"locations": [{"lat": la, "lon": lo} for la, lo in points],
                       "costing": "pedestrian", "verbose": True})
    try:
        results = json.loads(http(VALHALLA_LOCATE, data=body,
                                  headers={"Content-Type": "application/json",
                                           "Accept": "application/json"}))
    except (RuntimeError, json.JSONDecodeError, KeyError):
        return list(points)
    out = []
    for (la, lo), res in zip(points, results):
        best = None  # (score, dist, lat, lon)
        for e in (res or {}).get("edges", []):
            if e.get("correlated_lat") is None:
                continue
            cl = (e.get("edge") or {}).get("classification") or {}
            score = (_EDGE_CLASS_SCORE.get(cl.get("classification"), 3)
                     + _EDGE_USE_SCORE.get(cl.get("use"), 0))
            cand = (score, e.get("distance", 1e9),
                    e["correlated_lat"], e["correlated_lon"])
            if best is None or cand[:2] < best[:2]:
                best = cand
        out.append((best[2], best[3]) if best else (la, lo))
    return out


def _nearby_named(track, feats, max_m=130, limit=10):
    """POIs whose centroid lies within max_m of the routed track — the things you
    actually pass. Named first, then closest; de-duplicated. (track is (lon,lat).)"""
    seen, near = set(), []
    for f in feats:
        d = min(haversine(f["lat"], f["lon"], t[1], t[0]) for t in track)
        if d > max_m:
            continue
        key = f.get("name") or (round(f["lat"], 4), round(f["lon"], 4))
        if key in seen:
            continue
        seen.add(key)
        near.append((0 if f.get("name") else 1, d, f))
    near.sort(key=lambda x: (x[0], x[1]))
    return [{"lat": f["lat"], "lon": f["lon"],
             "name": f.get("name") or f["label"], "label": f["label"]}
            for _, _, f in near[:limit]]


def build_loop(start, km, kinds, profile="foot", tolerance=0.2,
               name="walk loop", seed=0, engine="auto"):
    """Build a ~km round-trip as a clean ring of network-snapped compass points
    — NOT routed through off-network POI centroids (which caused spikes and
    building-clipping). POIs of `kinds` that the ring passes near become markers.
    Distance is a soft target: a rounder, fully-walkable ring beats hitting the
    exact km. Returns (route_dict, waypoints, ring_m)."""
    slat, slon = start
    target_m = km * 1000.0
    ring_m = target_m / (2 * math.pi)
    # more points for bigger loops so the ring stays round (not a triangle).
    n = min(9, max(4, round(km / 1.2) + 2))
    seed_rot = (seed * 47) % 360

    best = None  # (err, route, ring_m)
    for attempt in range(6):
        ring = [destination(slat, slon, seed_rot + i * 360.0 / n, ring_m)
                for i in range(n)]
        snapped = snap_to_network([start] + ring, engine)
        route = route_engine(snapped + [snapped[0]], profile, engine)  # close it
        # a clean loop never backtracks, so strip every out-and-back fold (not
        # just short hairs) — a snapped ring point can still land on a stub.
        route["coords"], _ = trim_spurs(route["coords"], max_arm_m=10 ** 9)
        route["length_m"] = geo_length_m(route["coords"]) or route["length_m"]
        err = abs(route["length_m"] - target_m) / target_m
        if best is None or err < best[0]:
            best = (err, route, ring_m)
        if err <= tolerance:
            break
        ring_m *= max(0.6, min(1.6, target_m / max(route["length_m"], 1.0)))

    _, route, ring_m = best
    feats = features(slat, slon, max(400, ring_m * 1.7), kinds, limit=150)
    wpts = _nearby_named(route["coords"], feats)
    return route, wpts, ring_m


# -----------------------------------------------------------------------------
# CLI commands
# -----------------------------------------------------------------------------

def _emit(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_geocode(a):
    _emit(geocode(a.query, a.limit, a.lang))


def cmd_features(a):
    if a.kinds == ["list"]:
        _emit({k: KINDS[k] for k in sorted(KINDS)})
        return
    lat, lon = parse_latlon(a.around)
    _emit(features(lat, lon, a.radius, a.kinds, a.limit))


def cmd_turbo(a):
    lat, lon = parse_latlon(a.around)
    url, ql = turbo_link(lat, lon, a.radius, a.kinds)
    _emit({"overpass_turbo_url": url, "query": ql})


def cmd_convert(a):
    """Convert a GPX (the kind this tool writes) to KML, or vice-versa, by the
    output extension. Lets a route open in Google My Maps / Google Earth."""
    doc = minidom.parse(a.infile)

    def _text(node, tag):
        els = node.getElementsByTagName(tag)
        return (els[0].firstChild.data
                if els and els[0].firstChild else None)

    name = a.name or _text(doc, "name") or "walk route"
    coords = [(float(p.getAttribute("lon")), float(p.getAttribute("lat")))
              for p in doc.getElementsByTagName("trkpt")]
    if not coords:  # maybe a KML LineString -> read its coordinates
        for c in doc.getElementsByTagName("coordinates"):
            if c.firstChild:
                for tok in c.firstChild.data.split():
                    lon, lat, *_ = tok.split(",")
                    coords.append((float(lon), float(lat)))
                break
    wpts = []
    for w in doc.getElementsByTagName("wpt"):
        wpts.append({"lat": float(w.getAttribute("lat")),
                     "lon": float(w.getAttribute("lon")),
                     "name": _text(w, "name"), "label": _text(w, "type")})
    out = a.out or (os.path.splitext(a.infile)[0]
                    + (".gpx" if a.infile.lower().endswith(".kml") else ".kml"))
    write_track(out, name, coords, wpts)
    _emit({"in": os.path.abspath(a.infile), "out": os.path.abspath(out),
           "trackpoints": len(coords), "waypoints": len(wpts),
           "format": "kml" if out.lower().endswith(".kml") else "gpx"})


def _route_points(pts_arg, via_arg):
    pts = [parse_latlon(p) for p in re.split(r"\s*;\s*", pts_arg.strip()) if p]
    if via_arg:
        # insert vias between first and last
        vias = [parse_latlon(p) for p in re.split(r"\s*;\s*", via_arg.strip()) if p]
        pts = [pts[0]] + vias + pts[1:]
    return pts


def cmd_route(a):
    pts = _route_points(a.pts, a.via)
    route = route_engine(pts, a.profile, a.engine)
    wpts = []
    for w in (a.wpt or []):
        parts = w.split(",")
        wpts.append({"lat": float(parts[0]), "lon": float(parts[1]),
                     "name": (parts[2].strip() if len(parts) > 2 else None),
                     "label": "poi"})
    coords, trimmed = ((route["coords"], 0) if a.keep_spurs
                       else trim_spurs(route["coords"]))
    length_m = geo_length_m(coords) if trimmed else route["length_m"]
    write_track(a.out, a.name, coords, wpts)
    _emit({"out": os.path.abspath(a.out), "km": round(length_m / 1000, 2),
           "ascent_m": round(route["ascent_m"]), "minutes": round(route["time_s"] / 60),
           "profile": route["profile"], "waypoints": len(wpts),
           "points": len(pts), "spur_pts_trimmed": trimmed})


def cmd_loop(a):
    start = parse_latlon(a.around)
    route, wpts, ring = build_loop(start, a.km, a.kinds, a.profile,
                                   a.tolerance, a.name, a.seed, a.engine)
    coords, trimmed = ((route["coords"], 0) if a.keep_spurs
                       else trim_spurs(route["coords"]))
    length_m = geo_length_m(coords) if trimmed else route["length_m"]
    write_track(a.out, a.name, coords, wpts)
    _emit({"out": os.path.abspath(a.out), "km": round(length_m / 1000, 2),
           "target_km": a.km, "ascent_m": round(route["ascent_m"]),
           "minutes": round(route["time_s"] / 60), "profile": route["profile"],
           "ring_m": round(ring), "spur_pts_trimmed": trimmed,
           "waypoints": [{"name": w["name"], "label": w["label"],
                          "lat": round(w["lat"], 5), "lon": round(w["lon"], 5)}
                         for w in wpts]})


def build_parser():
    p = argparse.ArgumentParser(prog="walk.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("geocode", help="place name -> lat/lon candidates")
    g.add_argument("query")
    g.add_argument("--limit", type=int, default=5)
    g.add_argument("--lang", default="he,en")
    g.set_defaults(func=cmd_geocode)

    f = sub.add_parser("features", help="discover OSM features near a point")
    f.add_argument("--around", default="0,0", help="LAT,LON (or use --kinds list)")
    f.add_argument("--radius", type=int, default=1000, help="metres")
    f.add_argument("--kinds", default="park,water,viewpoint",
                   type=lambda s: [x.strip() for x in s.split(",") if x.strip()],
                   help="comma list; 'list' to show the menu")
    f.add_argument("--limit", type=int, default=60)
    f.set_defaults(func=cmd_features)

    t = sub.add_parser("turbo", help="overpass-turbo.eu link for the discovery query")
    t.add_argument("--around", required=True, help="LAT,LON")
    t.add_argument("--radius", type=int, default=1000)
    t.add_argument("--kinds", default="park,water,viewpoint",
                   type=lambda s: [x.strip() for x in s.split(",") if x.strip()])
    t.set_defaults(func=cmd_turbo)

    r = sub.add_parser("route", help="route an explicit point sequence -> GPX/KML")
    r.add_argument("--pts", required=True, help='"LAT,LON;LAT,LON;..."')
    r.add_argument("--via", default="", help='extra waypoints "LAT,LON;..."')
    r.add_argument("--out", required=True, help="output path (.gpx or .kml)")
    r.add_argument("--profile", default="foot",
                   help="foot/walk/scenic (walkable surfaces) | trail/hike (paths) | short")
    r.add_argument("--engine", default="auto", choices=["auto", "valhalla", "brouter"],
                   help="auto: walking->Valhalla pedestrian, trails->BRouter")
    r.add_argument("--name", default="walk route")
    r.add_argument("--wpt", action="append", help='"LAT,LON,Label" (repeatable)')
    r.add_argument("--keep-spurs", action="store_true",
                   help="don't trim out-and-back hairs at off-path waypoints")
    r.set_defaults(func=cmd_route)

    lo = sub.add_parser("loop", help="build a ~N km round-trip -> GPX/KML")
    lo.add_argument("--around", required=True, help="start LAT,LON")
    lo.add_argument("--km", type=float, required=True)
    lo.add_argument("--out", required=True, help="output path (.gpx or .kml)")
    lo.add_argument("--kinds", default="park,water,viewpoint",
                    type=lambda s: [x.strip() for x in s.split(",") if x.strip()])
    lo.add_argument("--profile", default="foot",
                    help="foot/walk/scenic (walkable surfaces) | trail/hike (paths) | short")
    lo.add_argument("--engine", default="auto", choices=["auto", "valhalla", "brouter"],
                    help="auto: walking->Valhalla pedestrian, trails->BRouter")
    lo.add_argument("--name", default="walk loop")
    lo.add_argument("--tolerance", type=float, default=0.2,
                    help="acceptable distance error fraction (0.2 = 20%%)")
    lo.add_argument("--seed", type=int, default=0,
                    help="vary to get a different loop through other POIs")
    lo.add_argument("--keep-spurs", action="store_true",
                    help="don't trim out-and-back hairs at off-path waypoints")
    lo.set_defaults(func=cmd_loop)

    cv = sub.add_parser("convert", help="convert a route file GPX <-> KML")
    cv.add_argument("infile", help="input .gpx or .kml")
    cv.add_argument("--out", help="output path; default: same name, other format")
    cv.add_argument("--name", default="", help="override the route name")
    cv.set_defaults(func=cmd_convert)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
