---
name: walk-route
description: Plan a real, followable walking route from a place + preferences. Uses Overpass (OpenStreetMap) to discover what's around — parks, water, viewpoints, paths, cafés — and BRouter foot routing to stitch an actual A→B or round-trip walk, written out as a GPX you can load on a phone or GPS watch. Use when the user wants to plan a walk/stroll/loop, not research a destination.
argument-hint: a start place + distance or A→B, e.g. "4km park loop from Rothschild Blvd" or "walk from the old port to the lighthouse"
---

# Walk route planner

Turn a place + what the user wants out of the walk into a **followable GPX
route**, built from OpenStreetMap. Overpass answers *what's around* (green space,
water, viewpoints, paths, cafés); BRouter answers *how to actually walk it* on
real footways. The deliverable is a `.gpx` file (track + the chosen POIs as
waypoints) plus a short in-chat summary.

One helper lives next to this file — `walk.py`, pure stdlib, subcommand style:

| subcommand | what it does |
|---|---|
| `geocode "<place>"` | place name (Hebrew or English) → lat/lon candidates + bbox |
| `features --around LAT,LON --radius M --kinds ...` | OSM features near a point (POIs, green space, paths) as JSON |
| `route --pts "LAT,LON;..." --out F.gpx` | route an explicit point sequence → GPX track |
| `loop --around LAT,LON --km N --out F.gpx` | fit a ~N km round-trip through spread-out POIs → GPX |
| `turbo --around LAT,LON --radius M --kinds ...` | overpass-turbo.eu link to eyeball the data on a map |
| `convert FILE.gpx --out FILE.kml` | GPX ⇄ KML (KML imports into Google My Maps / Earth) |

`route`/`loop` write **GPX by default, or KML if `--out` ends in `.kml`**. GPX
suits dedicated apps (Organic Maps, OsmAnd, Komoot, Gaia, Garmin); KML is for
**Google My Maps** (which then shows inside the Google Maps app) and Google Earth.
Neither Apple Maps nor the plain Google Maps app imports route files directly.

Run from this skill's directory: `python3 "$SKILL_DIR/walk.py" ...`.
State (response cache + per-host throttle) lives under `~/.claude/walk-route/`.

## Be a polite guest (read this first)

This talks to free, community-run services (Nominatim, Overpass, BRouter). It's
for **personal route planning** — equivalent to a person using the websites, not
bulk harvesting. The helper already **caches every response and rate-limits each
host**; don't bypass that. Keep queries targeted (one area, a handful of kinds),
don't loop the tools hundreds of times to brute-force a route, and if the user
asks to mass-download an area, push back and offer the targeted flow. Set
`WALK_ROUTE_UA="you@example.com"` to add honest contact info to the User-Agent.

## Workflow

### 1. Get the ask

Pin down, asking at most one short question if genuinely ambiguous:

- **Shape:** a **loop** (round-trip from one point, by distance) or **A→B**
  (start → destination, optionally via places). Most "go for a walk" asks are loops.
- **Distance / effort:** target km for a loop, or just the endpoints for A→B.
- **Theme / preferences →** which `--kinds` to discover. Map the user's words to
  the menu (`python3 walk.py features --kinds list`):
  `park`, `forest`, `water`, `fountain`, `viewpoint`, `historic`, `cafe`,
  `bench`, `playground`, `toilet`, `art`. "Green / nature" → `park,forest,water`;
  "scenic" → `viewpoint,water,park`; "with kids" → `park,playground,toilet,fountain`;
  "café crawl" → `cafe,historic,art`.
- **Profile / engine:** default `foot` routes on **walkable surfaces only** —
  sidewalks, footways, pedestrian streets, crossings — via Valhalla's pedestrian
  costing. Use `trail`/`hike` for a genuine off-road hike (routes via BRouter,
  which deliberately uses paths/tracks). `short` = most direct. Override with
  `--engine valhalla|brouter|auto` if needed.

### 2. Geocode the start / endpoints

```
python3 walk.py geocode "<place>" --limit 5
```
Hebrew and English both work. Pick the right candidate (show the user the
`display_name`s if there's any doubt) and keep its `lat,lon`. For A→B, geocode
both ends. Coordinates the user gives directly can be used as-is.

### 3. Discover what's around (Overpass)

```
python3 walk.py features --around LAT,LON --radius <m> --kinds <theme>
```
Use a radius that fits the walk (~loop distance × 160 for a loop, or covering the
A→B corridor). Read the returned features — each has `name`, `label`, `dist_m`,
and `tags`. This is the menu of things worth routing past; surface a few good
named ones to the user. Unnamed features (`name: null`) are still valid waypoints
(e.g. a `garden` or `water` polygon) — just describe them by `label`.

### 4. Build the route → GPX

**Loop** (let the helper build + fit):
```
python3 walk.py loop --around LAT,LON --km 4 --kinds park,water,viewpoint \
    --profile foot --out "<name>.gpx" --name "<name>"
```
It builds a **ring of network-snapped compass points** around the start (snapped
to real walkable edges, preferring footways/residential over arterials and
stairs), routes a round-trip through them, **removes every out-and-back fold**
(so no spikes/tails), and adjusts the ring radius toward the target distance. It
does **not** route through POI centroids — that used to cause spikes and lines
clipping buildings. The `waypoints` it returns are the named POIs of `--kinds`
the ring **passes near** (markers), not vias. JSON reports actual `km`, `minutes`,
ring radius, and those pass-by POIs. **Distance is a soft target** — a rounder,
fully-walkable ring beats hitting the exact km. To vary the route, change
`--seed` (rotates the ring through different streets), `--km`, or `--kinds`.

**A→B** (you choose the waypoints):
```
python3 walk.py route --pts "LAT_A,LON_A;LAT_B,LON_B" \
    --via "LAT,LON;LAT,LON" \
    --wpt "LAT,LON,Rose Garden" --wpt "LAT,LON,Viewpoint" \
    --profile foot --out "<name>.gpx" --name "<name>"
```
Pick 1–4 features from step 3 that lie roughly between the endpoints and pass them
as `--via` (routed through, in order) — order them along the direction of travel
so the path doesn't backtrack. Add `--wpt` markers (named) for the POIs you want
visible in the GPX. Check the reported `km`; adjust vias if it's longer than the
user wanted.

Write the GPX to the **user's working directory** (or a path they give), not the
scratchpad — it's the deliverable. Name it after the route, e.g.
`yarkon-4km-loop.gpx`.

### 5. Report

Give the user, in chat:
- the **GPX path**, and what it's for (load on a phone / watch / Komoot / Gaia),
- a one-line **summary**: distance, est. walking time, ascent if notable,
- a short **"you'll pass…"** list naming the POIs/green space the route goes by
  (from the waypoints + features),
- offer the **`turbo` link** if they'd like to see the underlying OSM data on a
  map in the browser (cheap — same query you already ran).

Don't claim turn-by-turn precision the data can't back: the track follows OSM
footways, but say where coverage might be thin (e.g. informal paths, new builds).

## Notes & limits

- **GPX is the artifact.** The track is the routed line; the POIs are GPX `<wpt>`
  markers. Most apps render both.
- **Loops are built spike-free, on real walkable ways.** `loop` does NOT route
  through POI centroids (which sit off-network and caused spikes / lines clipping
  buildings). It snaps a compass ring to actual walkable edges — preferring
  footways & residential streets over arterials and stairs — and strips every
  out-and-back fold, so the result is a clean ring. The reported `waypoints` are
  the named POIs the ring **passes near**, not detour targets. If a loop still
  looks off, re-roll `--seed` (rotates the ring onto different streets).
- **`route` (hand-picked vias) trims only short hairs.** There, a via on an area
  centroid can leave a small in-and-back "hair"; `route` strips hairs shorter
  than ~70 m but **keeps** a longer deliberate out-and-back (a turnaround to a far
  POI changes where you walk). Pass `--keep-spurs` to disable. To avoid hairs,
  pass vias that sit on a path/road, and spread them around the compass so the
  path forms a ring instead of doubling back.
- **Distances are estimates.** Loop fitting targets ±`tolerance` (default 20%);
  the reported `km` is the truth. BRouter's `minutes` is a rough foot estimate.
- **Coverage = OpenStreetMap.** Great in cities and popular areas, patchy in
  others. A missing path means OSM lacks it, not that it doesn't exist.
- **Two routing engines.** Default `auto` sends walking profiles to **Valhalla
  pedestrian** (sticks to sidewalks / footways / pedestrian ways and crossings,
  shuns tracks and non-walkable surfaces — the right choice for city & suburban
  walks) and trail/hike profiles to **BRouter** (`hiking-mountain`, which uses
  paths/tracks for real off-road hikes). The output `profile` field shows which
  ran (`valhalla:pedestrian` / `brouter:hiking-mountain`). If Valhalla is down,
  `auto` falls back to BRouter (noted on stderr) — a coarser, less foot-specific
  line, so prefer re-running once Valhalla is back. **Valhalla `/route` returns
  no elevation**, so `ascent_m` is `0` with it (don't report a climb figure for
  Valhalla routes); BRouter does report ascent.
- **Caches persist** (geocode 30d, Overpass/BRouter 14d). Re-planning the same
  area is fast and makes no new requests. Delete `~/.claude/walk-route/` to reset.
- **Pairs with `hike-research`:** that skill distills a destination from trip
  reports; this one plans the on-the-ground route. Use them together for hikes.
