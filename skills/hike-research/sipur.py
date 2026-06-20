#!/usr/bin/env python3
"""
sipur.py — polite fetcher + local cache + knowledge graph for sipurderech.co.il

Pure stdlib. Used by the `hike-research` skill.

Subcommands
-----------
  discover <query> [--limit N]
        Match the sitemap's slugs against a place query (Hebrew or English/latin)
        and print candidate URLs. Sitemap is cached locally for a day.

  fetch <url-or-slug> [<url-or-slug> ...]
        Fetch each page (browser UA, rate-limited, disk-cached), extract the
        readable text + internal links, and fold nodes/edges into the graph.
        Re-fetching a cached, fresh page is free. Prints a short JSON summary.

  show <url-or-slug>
        Print the cached extracted text (and metadata) for one page, for the
        agent to read.

  graph [--format json|summary]
        Print the knowledge graph (nodes + edges). `summary` is human-readable.

  related <url-or-slug> [--depth 1]
        Print pages connected to this one in the graph (neighbours / clusters),
        useful for finding several sipurei-derech about the same trip.

All state lives under  ~/.claude/hike-research/  (override with HIKE_RESEARCH_DIR).

Politeness: identifies honestly, sleeps RATE_LIMIT_SEC between live requests,
and caches everything so each page is fetched at most once per TTL. This is for
personal trip planning — keep it targeted, don't crawl the whole sitemap.
"""
from __future__ import annotations

import sys, os, re, json, time, html, argparse, urllib.parse, urllib.request
from html.parser import HTMLParser

SITE = "https://www.sipurderech.co.il"
HOST = "www.sipurderech.co.il"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 "
      "(personal hiking-trip research; respects robots Allow:/ )")
RATE_LIMIT_SEC = 1.2          # min seconds between live fetches
PAGE_TTL_SEC = 14 * 24 * 3600 # cached pages valid for 14 days
SITEMAP_TTL_SEC = 24 * 3600

# Non-content slugs we never treat as hikes
META_SLUGS = {"about", "contact", "search", "map", ""}

def root() -> str:
    d = os.environ.get("HIKE_RESEARCH_DIR",
                       os.path.expanduser("~/.claude/hike-research"))
    os.makedirs(os.path.join(d, "cache"), exist_ok=True)
    return d

def cache_dir() -> str:
    return os.path.join(root(), "cache")

# ---------------------------------------------------------------- url helpers
def slug_of(url_or_slug: str) -> str:
    """Return the path-slug (decoded) for a URL or bare slug."""
    s = url_or_slug.strip()
    if s.startswith("http"):
        s = urllib.parse.urlparse(s).path
    s = urllib.parse.unquote(s).strip("/")
    return s

def url_of(url_or_slug: str) -> str:
    s = url_or_slug.strip()
    if s.startswith("http"):
        return s
    slug = s.strip("/")
    if slug == "":
        return SITE
    return SITE + "/" + urllib.parse.quote(slug, safe="/-_")

def cache_path(slug: str) -> str:
    safe = re.sub(r"[^\w\-]", "_", slug) or "_home"
    return os.path.join(cache_dir(), safe + ".json")

# ---------------------------------------------------------------- HTML parsing
SKIP_TAGS = {"script", "style", "svg", "noscript", "template", "head"}

class Reader(HTMLParser):
    """Extract visible text + same-host links (with anchor text)."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._skip = 0
        self._chunks: list[str] = []
        self._main_depth = 0
        self._in_main = False
        self._a_href: str | None = None
        self._a_buf: list[str] = []
        self.links: list[dict] = []
        self.title = ""
        self.description = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP_TAGS:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag == "meta" and a.get("name") == "description":
            self.description = (a.get("content") or "").strip()
        if tag == "main":
            self._main_depth += 1
            self._in_main = True
        if tag == "a" and a.get("href"):
            self._a_href = a["href"]
            self._a_buf = []
        if tag in ("br", "p", "div", "li", "h1", "h2", "h3", "tr"):
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False
        if tag == "main" and self._main_depth:
            self._main_depth -= 1
        if tag == "a" and self._a_href is not None:
            text = re.sub(r"\s+", " ", "".join(self._a_buf)).strip()
            self._record_link(self._a_href, text)
            self._a_href = None
            self._a_buf = []

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._skip:
            return
        self._chunks.append(data)
        if self._a_href is not None:
            self._a_buf.append(data)

    def _record_link(self, href, text):
        try:
            full = urllib.parse.urljoin(SITE + "/", href)
        except Exception:
            return
        p = urllib.parse.urlparse(full)
        if p.netloc and p.netloc != HOST:
            return  # external (e.g. googleusercontent images)
        if p.scheme not in ("http", "https", ""):
            return
        slug = urllib.parse.unquote(p.path).strip("/")
        if not slug or slug.startswith("_next") or slug.startswith("api/"):
            return
        if re.search(r"\.(js|css|png|jpe?g|svg|webp|ico|xml|txt|gif)$", slug, re.I):
            return
        self.links.append({"slug": slug, "text": text})

    def text(self) -> str:
        raw = "".join(self._chunks)
        raw = html.unescape(raw)
        lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in raw.splitlines()]
        out, blank = [], False
        for ln in lines:
            if ln:
                out.append(ln); blank = False
            elif not blank:
                out.append(""); blank = True
        return "\n".join(out).strip()

# ---------------------------------------------------------------- fetching
_last_fetch = [0.0]

def _http_get(url: str) -> tuple[int, str]:
    wait = RATE_LIMIT_SEC - (time.time() - _last_fetch[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "he,en;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            _last_fetch[0] = time.time()
            return r.status, body
    except urllib.error.HTTPError as e:
        _last_fetch[0] = time.time()
        return e.code, ""
    except Exception as e:
        return 0, f"__ERROR__ {e}"

# ---------------------------------------------------------------- sitemap
def load_sitemap() -> list[str]:
    path = os.path.join(root(), "sitemap.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < SITEMAP_TTL_SEC:
        return json.load(open(path))
    status, body = _http_get(SITE + "/sitemap.xml")
    slugs = []
    if status == 200:
        for loc in re.findall(r"<loc>(.*?)</loc>", body):
            slugs.append(slug_of(html.unescape(loc)))
    json.dump(slugs, open(path, "w"), ensure_ascii=False)
    return slugs

def discover(query: str, limit: int = 25) -> list[str]:
    q = query.strip().lower()
    slugs = load_sitemap()
    scored = []
    for s in slugs:
        if s in META_SLUGS:
            continue
        sl = s.lower()
        if q == sl:
            scored.append((100, s))
        elif q in sl or sl in q:
            scored.append((60 - abs(len(sl) - len(q)), s))
        else:
            # token overlap (handles "north italy" vs "צפון-איטליה" only weakly;
            # latin slugs and Hebrew queries match best when the place name is shared)
            qt = set(re.split(r"[\s\-_]+", q))
            st = set(re.split(r"[\s\-_]+", sl))
            inter = qt & st
            if inter:
                scored.append((20 + 5 * len(inter), s))
    scored.sort(key=lambda x: (-x[0], len(x[1])))
    return [s for _, s in scored[:limit]]

# ---------------------------------------------------------------- graph
def load_graph() -> dict:
    path = os.path.join(root(), "graph.json")
    if os.path.exists(path):
        return json.load(open(path))
    return {"nodes": {}, "edges": []}

def save_graph(g: dict):
    json.dump(g, open(os.path.join(root(), "graph.json"), "w"),
              ensure_ascii=False, indent=2)

def _edge_key(e): return (e["src"], e["dst"], e["rel"])

def graph_upsert(g: dict, slug: str, **attrs):
    node = g["nodes"].setdefault(slug, {"slug": slug, "url": url_of(slug)})
    for k, v in attrs.items():
        if v:
            node[k] = v

def graph_link(g: dict, src: str, dst: str, rel: str, label: str = ""):
    existing = {_edge_key(e) for e in g["edges"]}
    if (src, dst, rel) not in existing:
        e = {"src": src, "dst": dst, "rel": rel}
        if label:
            e["label"] = label
        g["edges"].append(e)

# ---------------------------------------------------------------- classify
def classify(text: str, child_links: int) -> str:
    """Rough page type from rendered text. Agent can refine."""
    hub_signals = ("מסלולים מומלצים", "סיפורי דרך ב", "פעילויות ב", "יעדים ב")
    has_hub = sum(1 for s in hub_signals if s in text)
    if has_hub >= 2 and child_links >= 3:
        return "hub"        # region / destination index
    if len(text) > 1500 and has_hub == 0:
        return "story"      # a personal trip narrative
    return "page"

def fetch_one(slug: str, force: bool = False) -> dict:
    slug = slug_of(slug)
    cp = cache_path(slug)
    if not force and os.path.exists(cp) and \
       time.time() - os.path.getmtime(cp) < PAGE_TTL_SEC:
        return json.load(open(cp))

    status, body = _http_get(url_of(slug))
    if body.startswith("__ERROR__") or status != 200:
        rec = {"slug": slug, "url": url_of(slug), "status": status,
               "ok": False, "error": body[:200]}
        json.dump(rec, open(cp, "w"), ensure_ascii=False)
        return rec

    r = Reader()
    r.feed(body)
    text = r.text()
    # internal links pointing at *other* slugs (potential children / siblings)
    children = []
    seen = set()
    for ln in r.links:
        cs = ln["slug"]
        if cs == slug or cs in META_SLUGS or cs in seen:
            continue
        seen.add(cs)
        children.append(ln)
    ptype = classify(text, len(children))
    rec = {
        "slug": slug, "url": url_of(slug), "status": 200, "ok": True,
        "title": re.sub(r"\s+", " ", html.unescape(r.title)).strip(),
        "description": r.description,
        "type": ptype,
        "text": text,
        "links": children,
        "fetched_at": int(time.time()),
    }
    json.dump(rec, open(cp, "w"), ensure_ascii=False)

    # fold into graph
    g = load_graph()
    graph_upsert(g, slug, title=rec["title"], type=ptype,
                 description=rec["description"])
    for ln in children:
        graph_upsert(g, ln["slug"], title=ln["text"])
        graph_link(g, slug, ln["slug"], "links_to", ln["text"])
    save_graph(g)
    return rec

# ---------------------------------------------------------------- related
def related(slug: str, depth: int = 1) -> dict:
    slug = slug_of(slug)
    g = load_graph()
    out, frontier, seen = [], {slug}, {slug}
    for _ in range(depth):
        nxt = set()
        for e in g["edges"]:
            if e["src"] in frontier and e["dst"] not in seen:
                out.append(e); nxt.add(e["dst"]); seen.add(e["dst"])
            elif e["dst"] in frontier and e["src"] not in seen:
                out.append(e); nxt.add(e["src"]); seen.add(e["src"])
        frontier = nxt
    nodes = {s: g["nodes"].get(s, {"slug": s, "url": url_of(s)})
             for s in seen}
    return {"root": slug, "neighbours": nodes, "edges": out}

# ---------------------------------------------------------------- CLI
def main(argv):
    ap = argparse.ArgumentParser(prog="sipur.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("discover"); p.add_argument("query"); p.add_argument("--limit", type=int, default=25)
    p = sub.add_parser("fetch"); p.add_argument("targets", nargs="+"); p.add_argument("--force", action="store_true")
    p = sub.add_parser("show"); p.add_argument("target")
    p = sub.add_parser("graph"); p.add_argument("--format", choices=["json", "summary"], default="summary")
    p = sub.add_parser("related"); p.add_argument("target"); p.add_argument("--depth", type=int, default=1)

    args = ap.parse_args(argv)

    if args.cmd == "discover":
        for s in discover(args.query, args.limit):
            print(f"{url_of(s)}\t{s}")
    elif args.cmd == "fetch":
        for t in args.targets:
            rec = fetch_one(t, force=args.force)
            summary = {k: rec.get(k) for k in
                       ("slug", "url", "status", "ok", "title", "type")}
            summary["text_chars"] = len(rec.get("text", ""))
            summary["links"] = len(rec.get("links", []))
            print(json.dumps(summary, ensure_ascii=False))
    elif args.cmd == "show":
        rec = fetch_one(args.target)
        if not rec.get("ok"):
            print(json.dumps(rec, ensure_ascii=False)); return
        print(f"# {rec['title']}\nURL: {rec['url']}\nTYPE: {rec['type']}\n")
        if rec.get("description"):
            print(rec["description"] + "\n")
        print(rec["text"])
        if rec["links"]:
            print("\n--- LINKS ---")
            for ln in rec["links"]:
                print(f"- {ln['text'] or '(no text)'} -> {url_of(ln['slug'])}")
    elif args.cmd == "graph":
        g = load_graph()
        if args.format == "json":
            print(json.dumps(g, ensure_ascii=False, indent=2))
        else:
            print(f"nodes: {len(g['nodes'])}  edges: {len(g['edges'])}")
            for s, n in g["nodes"].items():
                print(f"  [{n.get('type','?'):5}] {s}  {n.get('title','')}".rstrip())
    elif args.cmd == "related":
        print(json.dumps(related(args.target, args.depth),
                         ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main(sys.argv[1:])
