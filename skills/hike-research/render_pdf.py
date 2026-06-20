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
def inline(s: str) -> str:
    # escape first, then re-introduce markup
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    # _italic_ : require word boundaries so URLs/identifiers with _ are untouched
    s = re.sub(r"(?<![\w])_([^_]+)_(?![\w])", r"<em>\1</em>", s)
    # links: [text](url)  -> <a href>text</a>
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
               lambda m: f'<a href="{html.escape(m.group(2),quote=True)}">{m.group(1)}</a>',
               s)
    return s

# ---------------------------------------------------------------- block md
def md_to_html(md: str) -> str:
    out, i = [], 0
    lines = md.replace("\r\n", "\n").split("\n")
    n = len(lines)
    while i < n:
        ln = lines[i]
        if not ln.strip():
            i += 1; continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            lvl = len(m.group(1))
            out.append(f"<h{lvl}>{inline(m.group(2).strip())}</h{lvl}>")
            i += 1; continue
        if re.match(r"^\s*([-*_])\s*\1\s*\1[\s\1]*$", ln):  # --- *** ___
            out.append("<hr>"); i += 1; continue
        if re.match(r"^\s*>", ln):
            buf = []
            while i < n and re.match(r"^\s*>", lines[i]):
                buf.append(inline(re.sub(r"^\s*>\s?", "", lines[i]))); i += 1
            out.append("<blockquote>" + "<br>".join(buf) + "</blockquote>"); continue
        if re.match(r"^\s*[-*+]\s+", ln):
            buf = []
            while i < n and re.match(r"^\s*[-*+]\s+", lines[i]):
                buf.append("<li>" + inline(re.sub(r"^\s*[-*+]\s+", "", lines[i])) + "</li>")
                i += 1
            out.append("<ul>" + "".join(buf) + "</ul>"); continue
        if re.match(r"^\s*\d+[.)]\s+", ln):
            buf = []
            while i < n and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                buf.append("<li>" + inline(re.sub(r"^\s*\d+[.)]\s+", "", lines[i])) + "</li>")
                i += 1
            out.append("<ol>" + "".join(buf) + "</ol>"); continue
        # paragraph: gather until blank line
        buf = []
        while i < n and lines[i].strip() and not re.match(
                r"^(#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*([-*_])\s*\2\s*\2)", lines[i]):
            buf.append(inline(lines[i].strip())); i += 1
        out.append("<p>" + "<br>".join(buf) + "</p>")
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
  a::after {{ content: " \\2197"; font-size: 0.8em; color: #90a4ae; }}
  ul, ol {{ padding-{startside}: 22px; }}
  li {{ margin: 3px 0; }}
  blockquote {{ margin: 10px 0; padding: 8px 14px; background: #f1f8e9;
    border-{startside}: 4px solid #aed581; color: #33691e; }}
  code {{ background: #eceff1; padding: 1px 5px; border-radius: 3px;
    font-family: "SF Mono", Menlo, monospace; font-size: 0.9em;
    direction: ltr; unicode-bidi: embed; }}
  hr {{ border: none; border-top: 1px solid #cfd8dc; margin: 20px 0; }}
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
    footer = ("הופק על ידי כלי המחקר hike-research · המקור: sipurderech.co.il"
              if lang == "he" else
              "Generated by the hike-research skill · Source: sipurderech.co.il")
    return TEMPLATE.format(
        lang=lang if lang in ("he", "en") else "en",
        dir=direction, startside=startside,
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
