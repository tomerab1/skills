#!/usr/bin/env python3
"""
render_pdf.py — turn a Markdown trip brief into a PDF with correct Hebrew RTL.

Pure stdlib for the Markdown->HTML step; uses headless Google Chrome for the
HTML->PDF step (perfect Unicode bidi / Hebrew shaping, no Python deps). Falls
back to weasyprint if present, else writes the .html and tells you.

Usage
-----
  render_pdf.py --in brief.md --out trip.pdf --lang he --title "טרק בבוצ'גי"
  render_pdf.py --in brief.md --out trip.pdf --lang en --title "Bucegi trek"
  render_pdf.py --in brief.md --out trip.pdf --lang bi --title "Bucegi / בוצ'גי"

--lang he  -> base direction RTL, Hebrew-first fonts
--lang en  -> base direction LTR
--lang bi  -> base direction LTR, English-led with inline Hebrew (bidi handles it)

The Markdown supported is a practical subset: # ## ### headings, - / * and
1. lists, > blockquotes, --- rules, **bold**, *italic*, `code`, [text](url),
and blank-line-separated paragraphs. Links render as footnote-style anchors so
the printed PDF still shows where each point came from.
"""
from __future__ import annotations
import sys, os, re, html, argparse, subprocess, tempfile, shutil

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

# ---------------------------------------------------------------- inline md
def inline(s: str, fn: dict | None = None) -> str:
    """Inline markup. `fn` maps footnote id -> {url,label} for [^id] citations."""
    fn = fn or {}
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    # footnote citation [^id] -> superscript link to the section URL
    def _cite(m):
        fid = m.group(1)
        url = fn.get(fid, {}).get("url", "")
        href = f' href="{html.escape(url, quote=True)}"' if url else ""
        return f'<sup class="cite"><a{href}>{html.escape(fid)}</a></sup>'
    s = re.sub(r"\[\^([\w.-]+)\]", _cite, s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"(?<![\w])_([^_]+)_(?![\w])", r"<em>\1</em>", s)
    # inline links: [text](url)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
               lambda m: f'<a href="{html.escape(m.group(2),quote=True)}">{m.group(1)}</a>',
               s)
    return s

FN_DEF = re.compile(r"^\[\^([\w.-]+)\]:\s*(.*)$")
URL_RE = re.compile(r"(https?://\S+)")

def _is_table_sep(s: str) -> bool:
    return bool(re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$", s))

def _row_cells(s: str) -> list[str]:
    s = s.strip()
    if s.startswith("|"): s = s[1:]
    if s.endswith("|"):   s = s[:-1]
    return [c.strip() for c in s.split("|")]

# ---------------------------------------------------------------- block md
def md_to_html(md: str) -> str:
    lines = md.replace("\r\n", "\n").split("\n")

    # pass 1: pull out footnote definitions  [^id]: label... <url>
    footnotes: dict = {}
    order: list = []
    body_lines: list = []
    for ln in lines:
        m = FN_DEF.match(ln)
        if m:
            fid, rest = m.group(1), m.group(2).strip()
            um = URL_RE.search(rest)
            url = um.group(1) if um else ""
            label = (rest[:um.start()] + rest[um.end():] if um else rest).strip(" —-·\t")
            footnotes[fid] = {"url": url, "label": label or fid}
            order.append(fid)
        else:
            body_lines.append(ln)

    out, i, n = [], 0, len(body_lines)
    while i < n:
        ln = body_lines[i]
        if not ln.strip():
            i += 1; continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            lvl = len(m.group(1))
            out.append(f"<h{lvl}>{inline(m.group(2).strip(), footnotes)}</h{lvl}>")
            i += 1; continue
        # pipe table: header row, then a separator row of dashes
        if "|" in ln and i + 1 < n and _is_table_sep(body_lines[i + 1]):
            header = _row_cells(ln)
            i += 2
            rows = []
            while i < n and "|" in body_lines[i] and body_lines[i].strip():
                rows.append(_row_cells(body_lines[i])); i += 1
            th = "".join(f"<th>{inline(c, footnotes)}</th>" for c in header)
            trs = "".join(
                "<tr>" + "".join(f"<td>{inline(c, footnotes)}</td>" for c in r) + "</tr>"
                for r in rows)
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>")
            continue
        if re.match(r"^\s*([-*_])\s*\1\s*\1[\s\1]*$", ln):
            out.append("<hr>"); i += 1; continue
        if re.match(r"^\s*>", ln):
            buf = []
            while i < n and re.match(r"^\s*>", body_lines[i]):
                buf.append(inline(re.sub(r"^\s*>\s?", "", body_lines[i]), footnotes)); i += 1
            out.append("<blockquote>" + "<br>".join(buf) + "</blockquote>"); continue
        if re.match(r"^\s*[-*+]\s+", ln):
            buf = []
            while i < n and re.match(r"^\s*[-*+]\s+", body_lines[i]):
                buf.append("<li>" + inline(re.sub(r"^\s*[-*+]\s+", "", body_lines[i]), footnotes) + "</li>")
                i += 1
            out.append("<ul>" + "".join(buf) + "</ul>"); continue
        if re.match(r"^\s*\d+[.)]\s+", ln):
            buf = []
            while i < n and re.match(r"^\s*\d+[.)]\s+", body_lines[i]):
                buf.append("<li>" + inline(re.sub(r"^\s*\d+[.)]\s+", "", body_lines[i]), footnotes) + "</li>")
                i += 1
            out.append("<ol>" + "".join(buf) + "</ol>"); continue
        buf = []
        while i < n and body_lines[i].strip() and not re.match(
                r"^(#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*([-*_])\s*\2\s*\2)", body_lines[i]) \
                and not ("|" in body_lines[i] and i + 1 < n and _is_table_sep(body_lines[i + 1])):
            buf.append(inline(body_lines[i].strip(), footnotes)); i += 1
        out.append("<p>" + "<br>".join(buf) + "</p>")

    # pass 2: render the References list from footnote defs (in first-seen order)
    if order:
        items = []
        for fid in order:
            f = footnotes[fid]
            label = inline(f["label"], {})
            if f["url"]:
                label += f' <a class="ref" href="{html.escape(f["url"], quote=True)}">↗</a>'
            items.append(f'<li id="fn-{html.escape(fid)}"><span class="fnid">{html.escape(fid)}.</span> {label}</li>')
        out.append('<h2 class="refs-h">References</h2><ol class="refs">' + "".join(items) + "</ol>")
    return "\n".join(out)

# ---------------------------------------------------------------- template
TEMPLATE = """<!DOCTYPE html>
<html lang="{lang}" dir="{dir}">
<head><meta charset="utf-8"><title>{title}</title>
<style>
  @page {{ size: A4; margin: 18mm 16mm; }}
  html {{ direction: {dir}; }}
  body {{
    font-family: "Arial Hebrew", "Heebo", "Rubik", "Arial Unicode MS",
                 -apple-system, Arial, sans-serif;
    font-size: 12pt; line-height: 1.6; color: #1a1a1a; max-width: 720px;
    margin: 0 auto;
  }}
  h1 {{ font-size: 22pt; border-bottom: 3px solid #2e7d32; padding-bottom: 6px;
        color: #1b5e20; }}
  h2 {{ font-size: 16pt; color: #2e7d32; margin-top: 22px;
        border-{startside}: 4px solid #a5d6a7; padding-{startside}: 8px; }}
  h3 {{ font-size: 13pt; color: #33691e; }}
  a  {{ color: #1565c0; text-decoration: none; word-break: break-word; }}
  p a:not(.ref)::after, li a:not(.ref)::after {{
    content: " \\2197"; font-size: 0.8em; color: #90a4ae; }}
  ul, ol {{ padding-{startside}: 22px; }}
  li {{ margin: 3px 0; }}
  blockquote {{ margin: 10px 0; padding: 8px 14px; background: #f1f8e9;
    border-{startside}: 4px solid #aed581; color: #33691e; }}
  code {{ background: #eceff1; padding: 1px 5px; border-radius: 3px;
    font-family: "SF Mono", Menlo, monospace; font-size: 0.9em;
    direction: ltr; unicode-bidi: embed; }}
  hr {{ border: none; border-top: 1px solid #cfd8dc; margin: 20px 0; }}
  /* tables */
  table {{ border-collapse: collapse; width: 100%; margin: 14px 0;
    font-size: 11pt; }}
  th, td {{ border: 1px solid #cfd8dc; padding: 6px 10px;
    text-align: {startside}; vertical-align: top; }}
  thead th {{ background: #e8f5e9; color: #1b5e20; font-weight: 700; }}
  tbody tr:nth-child(even) {{ background: #f7faf7; }}
  /* citations */
  sup.cite {{ font-size: 0.7em; line-height: 0; }}
  sup.cite a {{ color: #2e7d32; font-weight: 700; padding: 0 1px; }}
  sup.cite a::after {{ content: none; }}
  .refs-h {{ font-size: 13pt; }}
  ol.refs {{ font-size: 10pt; color: #455a64; }}
  ol.refs li {{ margin: 4px 0; }}
  ol.refs {{ list-style: none; padding-{startside}: 0; }}
  .fnid {{ color: #2e7d32; font-weight: 700; margin-{endside}: 6px; }}
  a.ref {{ color: #90a4ae; }}
  .footer {{ margin-top: 28px; padding-top: 10px; border-top: 1px solid #cfd8dc;
    font-size: 9pt; color: #78909c; }}
</style></head>
<body>
{body}
<div class="footer">{footer}</div>
</body></html>
"""

def build_html(md: str, title: str, lang: str) -> str:
    direction = "rtl" if lang == "he" else "ltr"
    startside = "right" if direction == "rtl" else "left"
    endside = "left" if direction == "rtl" else "right"
    footer = ("הופק על ידי כלי המחקר hike-research · המקור: sipurderech.co.il"
              if lang == "he" else
              "Generated by the hike-research skill · Source: sipurderech.co.il")
    return TEMPLATE.format(
        lang=lang if lang in ("he", "en") else "en",
        dir=direction, startside=startside, endside=endside,
        title=html.escape(title), body=md_to_html(md), footer=footer)

# ---------------------------------------------------------------- PDF
def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if c and os.path.exists(c):
            return c
    return None

def html_to_pdf(html_str: str, out_pdf: str) -> str:
    out_pdf = os.path.abspath(out_pdf)
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False,
                                     encoding="utf-8") as f:
        f.write(html_str); html_path = f.name
    chrome = find_chrome()
    try:
        if chrome:
            subprocess.run([chrome, "--headless=new", "--disable-gpu",
                            "--no-sandbox", "--no-pdf-header-footer",
                            "--virtual-time-budget=4000",
                            f"--print-to-pdf={out_pdf}", "file://" + html_path],
                           check=True, capture_output=True, timeout=90)
            if os.path.exists(out_pdf):
                return f"PDF written via Chrome: {out_pdf}"
        try:
            import weasyprint
            weasyprint.HTML(string=html_str).write_pdf(out_pdf)
            return f"PDF written via weasyprint: {out_pdf}"
        except ImportError:
            pass
        side = os.path.splitext(out_pdf)[0] + ".html"
        with open(side, "w", encoding="utf-8") as f:
            f.write(html_str)
        return ("No Chrome/weasyprint PDF engine found. Wrote HTML instead: "
                + side + "  (open it and Print > Save as PDF)")
    finally:
        try: os.unlink(html_path)
        except OSError: pass

def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="Markdown brief, or - for stdin")
    ap.add_argument("--out", required=True, help="output .pdf path")
    ap.add_argument("--title", default="Trip brief")
    ap.add_argument("--lang", choices=["he", "en", "bi"], default="en")
    args = ap.parse_args(argv)
    md = sys.stdin.read() if args.inp == "-" else open(args.inp, encoding="utf-8").read()
    print(html_to_pdf(build_html(md, args.title, args.lang), args.out))

if __name__ == "__main__":
    main(sys.argv[1:])
