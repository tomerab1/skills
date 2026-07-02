#!/usr/bin/env node
// render.mjs — turn the knowledge graph into a polished, self-contained HTML dashboard.
//
//   node render.mjs --from-db [--days 21] [--open]     Deterministic, ZERO LLM. Groups recent
//                                                       KG items + trending repos. Always works.
//   node render.mjs --curated <file.json> [--open]      Rich mode: render an in-session-curated
//                                                       payload (sections with "why you'd care").
//
// Writes ~/ai-radar/reports/ai-radar-<ts>.html and refreshes reports/latest.html. Prints the path.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { openDb, RUNTIME, loadConfig, recentItems, countsBySource, trendingRepos } from './db.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fmtDate = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };

const SRC = {
  github:     { label: 'GitHub', color: '#7aa2ff' },
  provider:   { label: 'Blog',   color: '#5fd0a0' },
  hackernews: { label: 'HN',     color: '#ff6600' },
  arxiv:      { label: 'arXiv',  color: '#b31b1b' },
  x:          { label: 'X',      color: '#c0c4d4' },
  web:        { label: 'Web',    color: '#d98a4a' },
};

// Fallback relevance keywords (config.relevance.keywords overrides). Weighted so Claude Code /
// MCP / agents rank high and bare "llm" barely registers — that's what tames the firehose.
const DEFAULT_KW = {
  'claude code': 5, 'claude': 3, 'anthropic': 3, 'mcp': 4, 'model context protocol': 4,
  'subagent': 4, 'agentic': 3, 'agent': 3, 'skill': 3, 'plugin': 2, 'devtools': 2,
  'developer experience': 2, 'orchestrat': 2, 'rag': 1, 'llm': 1, 'openai': 1, 'gemini': 1,
};

// ---- tiny, safe markdown -> HTML (no deps). Card bodies (release notes, changelogs) are
// raw markdown; this makes them readable. We escape ALL source first, then add our own tags,
// so user content can never inject markup. Inner links are real <a> (cards aren't <a> anymore).
// Turn a single bare http(s) URL (already HTML-escaped) into a SHORT anchor:
//   github .../pull|issues/NNN -> #NNN ; otherwise hostname (+ short tail).
function shortLink(u) {
  const gh = u.match(/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/);
  let label;
  if (gh) label = '#' + gh[1];
  else {
    const segs = u.replace(/^https?:\/\//, '').split('/').filter(Boolean);
    const h = (segs.shift() || '').replace(/^www\./, '');
    const tail = segs.length ? segs[segs.length - 1] : '';
    label = tail && (h.length + tail.length) <= 30 ? `${h}/…/${tail}` : h;
  }
  return `<a href="${u}" target="_blank" rel="noopener" class="exturl">${label}</a>`;
}
// Linkify BARE urls as a later pass — skip anything already inside an <a>…</a> or <code>…</code>,
// so existing markdown links [text](url) are never double-linkified.
function linkifyBare(htm) {
  return htm.replace(/(<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>)|(https?:\/\/[^\s<]+)/g,
    (m, keep, url) => {
      if (keep) return keep;
      let trail = '';
      const t = url.match(/[.,;:!?]+$/);
      if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
      return shortLink(url) + trail;
    });
}
function mdInline(s) {
  let h = s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  h = linkifyBare(h); // after the [text](url) pass so real links are left intact
  return h
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|\s)@([a-zA-Z0-9_-]{2,})/g, '$1<span class="mention">@$2</span>');
}
const ALERTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
function mdToHtml(src) {
  if (!src) return '';
  const lines = esc(String(src).replace(/\r/g, '').slice(0, 800)).split('\n');
  let out = '', inList = false, inQuote = false, inCode = false, codeBuf = '';
  const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
  const closeQuote = () => { if (inQuote) { out += '</blockquote>'; inQuote = false; } };
  const flushCode = () => { out += `<pre class="code">${codeBuf.replace(/\n$/, '')}</pre>`; codeBuf = ''; inCode = false; };
  for (const raw of lines) {
    const fence = raw.trim().match(/^(?:`{3,}|~{3,})/);
    // inside a fenced code block: accumulate verbatim until the closing fence
    if (inCode) { if (fence) flushCode(); else codeBuf += raw + '\n'; continue; }
    if (fence) { closeList(); closeQuote(); inCode = true; codeBuf = ''; continue; }
    const line = raw.trim();
    if (!line) { closeList(); closeQuote(); continue; }
    // horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) { closeList(); closeQuote(); out += '<hr>'; continue; }
    let m;
    // blockquote / GitHub alert (note: esc() turned leading '>' into '&gt;')
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      const content = m[1];
      const al = content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (!inQuote) { out += `<blockquote${al ? ` class="al-${al[1].toLowerCase()}"` : ''}>`; inQuote = true; }
      if (al) { out += `<div class="alert">${ALERTS[al[1].toUpperCase()]}</div>`; if (al[2]) out += `<p>${mdInline(al[2])}</p>`; }
      else if (content) out += `<p>${mdInline(content)}</p>`;
      continue;
    }
    closeQuote();
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { closeList(); out += `<div class="mdh">${mdInline(m[1])}</div>`; }
    else if ((m = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/))) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${mdInline(m[1])}</li>`; }
    else { closeList(); out += `<p>${mdInline(line)}</p>`; }
  }
  if (inCode) flushCode();
  closeList(); closeQuote();
  return out;
}

function buildFromDb() {
  const cfg = loadConfig();
  const db = openDb();
  const days = Number(val('--days', cfg.lookbackDays || 21));
  const items = recentItems(db, days, 600);
  const recentCut = Date.now() - 26 * 3600 * 1000; // "new" = captured in the last ingest-ish window
  const rel = cfg.relevance || {};
  const kw = rel.keywords || DEFAULT_KW;
  const dimBelow = rel.dimBelow ?? 2;
  // Deterministic relevance: weighted keyword overlap on title+tags+summary, plus a popularity
  // nudge for HN (its points). Sorts signal to the top; low-relevance items are dimmed, not dropped.
  function scoreOf(it) {
    const text = `${it.title || ''} ${it.tags || ''} ${it.summary || ''}`.toLowerCase();
    let kwScore = 0;
    for (const k in kw) if (text.includes(k)) kwScore += kw[k];
    let pop = 0;
    if (it.source === 'hackernews') { const m = (it.summary || '').match(/[▲△]\s*(\d+)/); if (m) pop = Math.min(Number(m[1]) / 50, 4); }
    return { kwScore, total: kwScore + pop };
  }
  const norm = items.map(it => {
    const s = scoreOf(it);
    let why = it.summary || '', points = 0, comments = 0;
    if (it.source === 'hackernews') { // lift points/comments out of the body into card metadata
      const m = why.match(/[▲△]\s*(\d+)\s*points\s*·\s*(\d+)\s*comments\s*·?\s*(.*)/i);
      if (m) { points = +m[1]; comments = +m[2]; why = m[3] || ''; }
    }
    return {
      title: it.title, url: it.url, source: it.source, kind: it.kind,
      date: it.published || it.captured, author: it.author,
      whyYouCare: why, tags: it.tags ? JSON.parse(it.tags) : [],
      isNew: Date.parse(it.captured) >= recentCut, signal: '',
      _score: s.total, _lowRel: s.kwScore < dimBelow,
      _captured: it.captured, _points: points, _comments: comments,
    };
  });
  const pick = (pred) => norm.filter(pred)
    .sort((a, b) => b._score - a._score || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const sections = [
    { id: 'releases', title: 'Releases & official tools', blurb: 'New versions from watched orgs (Anthropic, MCP, OpenAI…).',
      items: pick(i => i.kind === 'release') },
    { id: 'repos', title: 'Repos on the radar', blurb: 'Skills, agents, MCP servers & frameworks surfacing in search.',
      items: pick(i => i.source === 'github' && i.kind === 'repo') },
    { id: 'reading', title: 'Reading & changelogs', blurb: 'Provider blogs and engineering writeups.',
      items: pick(i => i.source === 'provider') },
    { id: 'arxiv', title: 'Research (arXiv)', blurb: 'Recent papers on agents, LLMs & language models — most relevant first.',
      items: pick(i => i.source === 'arxiv') },
    { id: 'hn', title: 'Hacker News', blurb: 'Top AI / agent / Claude / MCP stories — by relevance, then points.',
      items: pick(i => i.source === 'hackernews') },
    { id: 'x', title: 'From X', blurb: 'Links shared by people you follow.',
      items: pick(i => i.source === 'x') },
  ].filter(s => s.items.length);

  const data = {
    title: cfg.title || 'AI Radar',
    generatedAt: new Date().toISOString(),
    windowLabel: `last ${days} days`,
    mode: 'from-db (no LLM)',
    sections,
    trending: trendingRepos(db, 14, 12),
    stats: { scanned: items.length, new: norm.filter(i => i.isNew).length,
             sources: Object.fromEntries(countsBySource(db).map(r => [r.source, r.n])) },
  };
  db.close();
  return data;
}

function buildFromCurated(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.title ||= 'AI Radar';
  data.generatedAt ||= new Date().toISOString();
  data.mode ||= 'curated';
  if (!data.trending) { const db = openDb(); data.trending = trendingRepos(db, 14, 12); db.close(); }
  return data;
}

function card(it) {
  const s = SRC[it.source] || { label: it.source || '·', color: '#9aa1b8' };
  const srcLc = (s.label || '').toLowerCase();
  const titleLc = (it.title || '').toLowerCase();
  // de-noise tags: drop ones that just echo the source/kind or repeat the title
  const drop = new Set(['hn', 'arxiv', 'post', 'repo', 'release', 'x', 'web', srcLc, String(it.source)]);
  const tags = (it.tags || [])
    .filter(t => { const tl = String(t).toLowerCase().trim(); return tl && !drop.has(tl) && !titleLc.includes(tl); })
    .slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const pts = it._points ? `<span class="pts" title="${it._points} points · ${it._comments || 0} comments on HN">▲ ${it._points}</span>` : '';
  const captured = it._captured || it.date || '';
  const search = `${it.title || ''} ${(it.tags || []).join(' ')} ${it.whyYouCare || ''} ${host(it.url)}`
    .toLowerCase().replace(/\s+/g, ' ').trim();
  return `<div class="card${it._lowRel ? ' lowrel' : ''}" data-href="${esc(it.url)}" data-source="${esc(it.source || '')}" data-captured="${esc(captured)}" data-date="${esc(it.date || '')}" data-points="${it._points || 0}" data-score="${Number(it._score || 0).toFixed(2)}" data-lowrel="${it._lowRel ? 1 : 0}" data-search="${esc(search)}"${it._lowRel ? ' title="lower relevance to your interests"' : ''}>
    <div class="top">
      <span class="badge" style="--c:${s.color}">${esc(s.label)}</span>
      ${pts}
      <span class="new">NEW</span>
      ${it.signal ? `<span class="signal">${esc(it.signal)}</span>` : ''}
      <span class="when">${esc(fmtDate(it.date))}</span>
    </div>
    <a class="name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
    ${it.whyYouCare ? `<div class="why">${mdToHtml(it.whyYouCare)}</div>` : ''}
    <div class="foot"><span class="src">${esc(host(it.url))}</span>${tags}</div>
  </div>`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function html(d) {
  const chips = Object.entries(d.stats?.sources || {}).map(([k, v]) =>
    `<span class="chip"><b style="color:${(SRC[k]||{}).color||'#9aa1b8'}">${esc(k)}</b> ${v}</span>`).join('');

  const hasTrend = (d.trending || []).length > 0;
  const secs = (d.sections || []).map(sec => ({ ...sec, _id: 'sec-' + (sec.id ? slug(sec.id) : slug(sec.title)) }));

  // toolbar: source filter buttons with live counts + total
  const allItems = secs.flatMap(s => s.items);
  const total = allItems.length;
  const srcCounts = {};
  for (const it of allItems) srcCounts[it.source] = (srcCounts[it.source] || 0) + 1;
  const srcFilters = Object.keys(srcCounts).filter(k => SRC[k]).map(k =>
    `<button class="sf" data-src="${k}" type="button">${esc(SRC[k].label)} <i>${srcCounts[k]}</i></button>`).join('');
  const toolbar = `
    <div class="toolbar" role="search">
      <input id="q" class="search" type="search" placeholder="Search ${total} items…" autocomplete="off" aria-label="Search">
      <div class="srcfilters">${srcFilters}</div>
      <select id="recency" class="ctl" aria-label="Recency">
        <option value="0">Any time</option><option value="1">24h</option><option value="7">7 days</option><option value="21">21 days</option>
      </select>
      <select id="sortsel" class="ctl" aria-label="Sort">
        <option value="rel">Sort: Relevance</option><option value="new">Sort: Newest</option><option value="pts">Sort: HN points</option>
      </select>
      <label class="tg"><input type="checkbox" id="newonly"> New only</label>
      <label class="tg"><input type="checkbox" id="hidelow"> Hide low-rel</label>
      <label class="tg"><input type="checkbox" id="compactchk" checked> Compact</label>
      <span id="shown" class="shown"></span>
    </div>`;

  // Sidebar tree — jump between sections, with live scrollspy highlighting.
  const tree = `
    <nav class="side">
      <div class="sidehead">On the radar</div>
      <ul class="tree">
        ${hasTrend ? `<li><a href="#trending" data-jump><span class="ic">📈</span>Trending<span class="n">${d.trending.length}</span></a></li>` : ''}
        ${secs.map(s => `<li><a href="#${s._id}" data-jump><span class="ic">▾</span>${esc(s.title)}<span class="n">${s.items.length}</span></a></li>`).join('')}
      </ul>
      <div class="sidefoot">Click a section header to collapse it.</div>
    </nav>`;

  const trending = hasTrend ? `
    <section id="trending" class="sec trend">
      <div class="sechead"><span class="caret">▾</span><h2>📈 Trending repos <span class="sub">by stars gained · 14d</span></h2></div>
      <div class="trendrow">
        ${d.trending.map(t => `<a class="tcard" href="${esc(t.url)}" target="_blank" rel="noopener">
          <span class="delta">+${t.delta}</span><span class="tname">${esc(t.name)}</span>
          <span class="tstars">★ ${t.latest}</span></a>`).join('')}
      </div>
    </section>` : '';

  const sections = secs.map(sec => `
    <section id="${sec._id}" class="sec">
      <div class="sechead" data-sec><span class="caret">▾</span><h2>${esc(sec.title)} <span class="count">${sec.items.length}</span></h2></div>
      ${sec.blurb ? `<p class="blurb">${esc(sec.blurb)}</p>` : ''}
      <div class="grid">${sec.items.map(card).join('')}</div>
    </section>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.title)}</title>
<style>
  :root{--bg:#0b0c11;--panel:#14161f;--panel2:#191c28;--line:#262a3a;--ink:#e9ebf2;--mut:#9aa1b8;--faint:#828aa6;--acc:#d98a4a}
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:radial-gradient(1100px 560px at 82% -12%,#1a1d2b 0%,var(--bg) 55%) fixed;color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}.wrap{max-width:1240px;margin:0 auto;padding:36px 22px 80px}
  header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:8px}
  .kicker{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);font-weight:700}
  h1{font-size:29px;letter-spacing:-.02em;margin:8px 0 12px}
  .meta{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;color:var(--mut);font-size:13px}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .chip{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;color:var(--mut)}
  .mode{margin-left:auto;color:var(--faint);font-size:12px}
  /* layout: sticky sidebar tree + main */
  .layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:30px;align-items:start;margin-top:18px}
  .side{position:sticky;top:64px;max-height:calc(100vh - 80px);overflow:auto;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--panel2));padding:14px 11px}
  .sidehead{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);font-weight:700;margin:2px 6px 10px}
  .tree{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
  .tree a{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:9px;font-size:13px;color:var(--mut);border-left:2px solid transparent}
  .tree a:hover{background:var(--panel2);color:var(--ink)}
  .tree a.active{background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--ink);border-left-color:var(--acc)}
  .tree .ic{font-size:10px;color:var(--faint);width:13px;text-align:center}
  .tree .n{margin-left:auto;font-size:11px;color:var(--faint);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 6px;font-variant-numeric:tabular-nums}
  .sidefoot{margin:12px 6px 2px;font-size:11px;color:var(--faint);line-height:1.5}
  /* sections */
  .sec{scroll-margin-top:64px}
  .sechead{display:flex;align-items:center;gap:9px;cursor:pointer;user-select:none;margin-top:30px}
  .sec:first-child .sechead,.trend .sechead{margin-top:4px}
  h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin:0}
  h2 .sub,h2 .count{text-transform:none;letter-spacing:0}
  h2 .count{color:var(--acc);font-size:12px;border:1px solid var(--line);border-radius:6px;padding:0 7px;margin-left:6px}
  h2 .sub{color:var(--faint);font-weight:400;font-size:11px}
  .caret{color:var(--faint);font-size:10px;width:12px;transition:transform .15s}
  .sec.collapsed .caret{transform:rotate(-90deg)}
  .sec.collapsed .blurb,.sec.collapsed .grid,.sec.collapsed .trendrow{display:none}
  .blurb{color:var(--mut);font-size:13px;margin:9px 0 14px;max-width:74ch}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:11px;margin-top:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px 15px;display:flex;flex-direction:column;gap:7px;cursor:pointer;transition:border-color .15s,transform .15s}
  .card:hover{border-color:var(--acc);transform:translateY(-2px)}
  .card.lowrel{opacity:.42}.card.lowrel:hover{opacity:1}
  .top{display:flex;align-items:center;gap:8px}
  .badge{font-size:10.5px;font-weight:700;color:var(--c);border:1px solid color-mix(in srgb,var(--c) 45%,var(--line));border-radius:6px;padding:1px 7px;text-transform:uppercase;letter-spacing:.06em}
  .new{display:none;font-size:9.5px;font-weight:800;letter-spacing:.08em;color:#0b0c11;background:var(--acc);border-radius:5px;padding:1px 6px}
  .card.is-new .new{display:inline-block}
  .pts{font-size:10.5px;font-weight:700;color:#ff8a3d;background:color-mix(in srgb,#ff6600 13%,transparent);border:1px solid color-mix(in srgb,#ff6600 36%,var(--line));border-radius:5px;padding:1px 6px;font-variant-numeric:tabular-nums}
  .signal{font-size:11px;color:#5fd0a0;font-weight:600}
  .when{margin-left:auto;font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
  .name{font-weight:650;font-size:14.5px;letter-spacing:-.01em;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
  .name:hover{color:var(--acc)}
  /* rendered markdown inside cards */
  .why{margin:1px 0 0;color:var(--mut);font-size:13px;max-height:150px;overflow:hidden;position:relative;overflow-wrap:anywhere}
  .why.clipped::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30px;background:linear-gradient(transparent,var(--panel));pointer-events:none}
  .why p{margin:.2em 0}.why ul{margin:.3em 0;padding-left:1.1em}.why li{margin:.14em 0}
  .why .mdh{font-weight:700;color:var(--ink);font-size:12.5px;margin:.5em 0 .15em}
  .why strong{color:var(--ink)}.why em{color:var(--mut)}.why a{color:#7aa2ff}
  .why code{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#cdd3e6}
  .why .mention{color:#7aa2ff}
  .why hr{border:0;border-top:1px solid var(--line);margin:.6em 0}
  .why pre.code{margin:.45em 0;padding:.5em .65em;background:var(--panel2);border:1px solid var(--line);border-radius:7px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#cdd3e6;white-space:pre-wrap;overflow-wrap:anywhere}
  .why blockquote{margin:.5em 0;padding:.4em .75em;border-left:3px solid var(--line);background:var(--panel2);border-radius:0 8px 8px 0;color:var(--mut)}
  .why blockquote p{margin:.2em 0}
  .why blockquote .alert{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:.15em}
  .why blockquote.al-note{border-left-color:#7aa2ff}.why blockquote.al-note .alert{color:#7aa2ff}
  .why blockquote.al-tip{border-left-color:#5fd0a0}.why blockquote.al-tip .alert{color:#5fd0a0}
  .why blockquote.al-important{border-left-color:#b78aff}.why blockquote.al-important .alert{color:#b78aff}
  .why blockquote.al-warning{border-left-color:#d9a84a}.why blockquote.al-warning .alert{color:#d9a84a}
  .why blockquote.al-caution{border-left-color:#e0736b}.why blockquote.al-caution .alert{color:#e0736b}
  .foot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:2px}
  .src{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--faint)}
  .tag{font-size:10px;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:0 6px}
  .trendrow{display:flex;flex-wrap:wrap;gap:9px;padding:10px 0 4px}
  .tcard{flex:0 0 auto;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:10px 13px;display:flex;flex-direction:column;gap:2px;min-width:150px}
  .tcard:hover{border-color:#5fd0a0}
  .delta{color:#5fd0a0;font-weight:800;font-size:15px}
  .tname{font-size:12.5px;color:var(--ink)}.tstars{font-size:11px;color:var(--faint)}
  footer{margin-top:50px;border-top:1px solid var(--line);padding-top:20px;color:var(--faint);font-size:12.5px;line-height:1.7}
  footer code{background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12px;color:var(--mut)}
  /* filter / search / sort toolbar */
  .toolbar{position:sticky;top:0;z-index:8;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 2px;padding:9px 0;background:rgba(11,12,17,.93);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  .search{flex:1 1 210px;min-width:150px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 12px;color:var(--ink);font-size:13px;outline:none}
  .search::placeholder{color:var(--faint)}.search:focus{border-color:var(--acc)}
  .srcfilters{display:flex;gap:5px;flex-wrap:wrap}
  .sf{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--mut);cursor:pointer;display:inline-flex;gap:6px;align-items:center}
  .sf i{font-style:normal;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
  .sf:hover{border-color:var(--acc)}.sf.off{opacity:.4;text-decoration:line-through}
  .ctl{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:6px 9px;color:var(--mut);font-size:12px;cursor:pointer;outline:none}
  .tg{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--mut);cursor:pointer;user-select:none;white-space:nowrap}
  .tg input{accent-color:var(--acc);cursor:pointer}
  .shown{margin-left:auto;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
  /* compact density mode */
  .compact .grid{grid-template-columns:1fr;gap:4px}
  .compact .card{flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:5px 10px;padding:8px 13px}
  .compact .why,.compact .foot{display:none}
  .compact .name{order:1;flex:1 1 55%;font-size:13.5px}
  .compact .top{order:2;flex:1 1 auto;justify-content:flex-end;gap:7px}
  .compact .top .when{margin-left:6px}
  /* keyboard accessibility */
  .card:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
  .sechead:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}
  .sf:focus-visible,.ctl:focus-visible,.search:focus-visible,.tree a:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
  /* mobile: nav becomes a sticky one-line jump bar so content is above the fold */
  @media(max-width:880px){
    .wrap{padding:24px 16px 70px}
    .layout{grid-template-columns:1fr;gap:14px}
    .side{position:sticky;top:52px;max-height:none;padding:8px 9px;z-index:7}
    .sidehead{display:none}
    .tree{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:6px;-webkit-overflow-scrolling:touch}
    .tree a{flex:0 0 auto;padding:6px 10px}.tree .ic{display:none}.tree .n{margin-left:6px}
    .sidefoot{display:none}
    .toolbar .shown{display:none}.toolbar .srcfilters{order:6}
  }
</style></head><body class="compact"><div class="wrap">
  <header>
    <div class="kicker">AI Radar · ecosystem discovery</div>
    <h1>${esc(d.title)}</h1>
    <div class="meta">
      <span>Generated ${esc(d.generatedAt.slice(0,16).replace('T',' '))}</span>
      ${d.windowLabel ? `<span>· window: ${esc(d.windowLabel)}</span>` : ''}
      <span class="mode">${esc(d.mode)}</span>
    </div>
    <div class="chips">
      <span class="chip" id="newchip">tracking new items…</span>
      <span class="chip"><b>${total}</b> items · ${secs.length} sections</span>
    </div>
  </header>
  ${toolbar}
  <div class="layout">
    ${tree}
    <main>
      ${trending}
      ${sections || '<p style="color:var(--mut);margin-top:30px">No items yet — run the ingest first.</p>'}
      <footer>
        Built from your local knowledge graph at <code>~/ai-radar/radar.db</code>.
        Hourly ingest is pure Node (GitHub + RSS) — no <code>claude -p</code>, no metered calls.
        Refresh passively with <code>node ~/.claude/skills/ai-radar/render.mjs --from-db --open</code>,
        or run <code>/ai-radar</code> for the curated, ranked version.
      </footer>
    </main>
  </div>
<script>
(function(){
  var cards=Array.prototype.slice.call(document.querySelectorAll('.card'));
  var secAll=Array.prototype.slice.call(document.querySelectorAll('.sec'));

  // whole-card click + keyboard (Enter/Space); inner links still work normally
  cards.forEach(function(c){
    c.setAttribute('tabindex','0'); c.setAttribute('role','link');
    c.addEventListener('click',function(e){ if(e.target.closest&&e.target.closest('a'))return; var u=c.dataset.href; if(u)window.open(u,'_blank','noopener'); });
    c.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); var u=c.dataset.href; if(u)window.open(u,'_blank','noopener'); } });
  });

  // collapse / expand a section (click or keyboard), with aria-expanded
  document.querySelectorAll('.sechead').forEach(function(h){
    h.setAttribute('tabindex','0'); h.setAttribute('role','button'); h.setAttribute('aria-expanded','true');
    function toggle(){ var col=h.closest('.sec').classList.toggle('collapsed'); h.setAttribute('aria-expanded',String(!col)); }
    h.addEventListener('click',toggle);
    h.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } });
  });

  // soft fade (not a scrollbar) only when a card body actually overflows
  document.querySelectorAll('.why').forEach(function(w){ if(w.scrollHeight>w.clientHeight+2) w.classList.add('clipped'); });

  // "new since last visit": drive the NEW pill off last-visit, not capture age
  var KEY='ai-radar:lastSeen', last=localStorage.getItem(KEY), lastMs=last?Date.parse(last):0, newCount=0;
  function capMs(c){ return Date.parse(c.dataset.captured||c.dataset.date||'')||0; }
  cards.forEach(function(c){
    var isNew = last && capMs(c) && capMs(c)>lastMs;
    c.dataset.isnew=isNew?'1':'0';
    if(isNew){ c.classList.add('is-new'); newCount++; }
  });
  var chip=document.getElementById('newchip');
  if(chip){
    if(!last) chip.textContent='tracking new items from your next visit';
    else if(newCount) chip.innerHTML='<b style="color:var(--acc)">'+newCount+'</b> new since '+new Date(lastMs).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    else chip.textContent='nothing new since last visit';
  }
  try{ localStorage.setItem(KEY,new Date().toISOString()); }catch(e){}

  // filter / search / sort — all client-side over the DOM
  var q=document.getElementById('q'), recency=document.getElementById('recency'), sortsel=document.getElementById('sortsel');
  var newonly=document.getElementById('newonly'), hidelow=document.getElementById('hidelow'), compactchk=document.getElementById('compactchk');
  var grids=Array.prototype.slice.call(document.querySelectorAll('.grid')), srcOff=new Set();
  function apply(){
    var term=((q&&q.value)||'').toLowerCase().trim();
    var days=recency?parseInt(recency.value,10):0, cut=days?Date.now()-days*86400000:0;
    var no=newonly&&newonly.checked, hl=hidelow&&hidelow.checked;
    if(compactchk) document.body.classList.toggle('compact',compactchk.checked);
    var vis=0;
    cards.forEach(function(c){
      var ok=true;
      if(srcOff.has(c.dataset.source)) ok=false;
      if(ok&&term&&(c.dataset.search||'').indexOf(term)<0) ok=false;
      if(ok&&cut&&capMs(c)<cut) ok=false;
      if(ok&&no&&c.dataset.isnew!=='1') ok=false;
      if(ok&&hl&&c.dataset.lowrel==='1') ok=false;
      c.style.display=ok?'':'none'; if(ok) vis++;
    });
    var key=sortsel?sortsel.value:'rel';
    grids.forEach(function(g){
      var cs=Array.prototype.slice.call(g.querySelectorAll(':scope > .card'));
      cs.sort(function(a,b){
        if(key==='new') return capMs(b)-capMs(a);
        if(key==='pts') return (+b.dataset.points)-(+a.dataset.points);
        return (+b.dataset.score)-(+a.dataset.score) || capMs(b)-capMs(a);
      });
      cs.forEach(function(c){ g.appendChild(c); });
    });
    secAll.forEach(function(sec){
      if(sec.id==='trending') return;
      var v=0; sec.querySelectorAll('.card').forEach(function(c){ if(c.style.display!=='none') v++; });
      var cnt=sec.querySelector('.count'); if(cnt) cnt.textContent=v;
      sec.style.display=v?'':'none';
      var link=document.querySelector('.tree a[href="#'+sec.id+'"]');
      if(link){ link.style.display=v?'':'none'; var n=link.querySelector('.n'); if(n) n.textContent=v; }
    });
    var sh=document.getElementById('shown'); if(sh) sh.textContent='showing '+vis+' of '+cards.length;
  }
  [q,recency,sortsel,newonly,hidelow,compactchk].forEach(function(el){ if(el) el.addEventListener('input',apply); });
  document.querySelectorAll('.sf').forEach(function(b){
    b.setAttribute('tabindex','0');
    function t(){ var s=b.dataset.src; if(srcOff.has(s)){srcOff.delete(s);b.classList.remove('off');}else{srcOff.add(s);b.classList.add('off');} apply(); }
    b.addEventListener('click',t);
    b.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); t(); } });
  });
  apply();

  // scrollspy with bottom-of-page fallback (operates over visible sections only)
  var links=new Map();
  document.querySelectorAll('.tree a').forEach(function(a){ links.set(a.getAttribute('href').slice(1),a); });
  function setActive(id){ links.forEach(function(a){ a.classList.toggle('active',a===links.get(id)); }); }
  function onScroll(){
    var v=secAll.filter(function(s){ return s.style.display!=='none'; });
    if(!v.length) return;
    var trigger=window.innerHeight*0.28, cur=v[0];
    for(var i=0;i<v.length;i++){ if(v[i].getBoundingClientRect().top<=trigger) cur=v[i]; }
    if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2) cur=v[v.length-1];
    setActive(cur.id);
  }
  window.addEventListener('scroll',onScroll,{passive:true});
  window.addEventListener('resize',onScroll,{passive:true});
  onScroll();
})();
</script>
</div></body></html>`;
}

// ---- main ---------------------------------------------------------------------------
// --json: print the structured from-db data model (no HTML). The /ai-radar in-session step
// reads this, adds "why you'd care" + ranking, and feeds it back via --curated.
if (has('--json')) { process.stdout.write(JSON.stringify(buildFromDb(), null, 2) + '\n'); process.exit(0); }

const data = has('--curated') ? buildFromCurated(val('--curated')) : buildFromDb();
const out = html(data);
const stamp = data.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(RUNTIME, 'reports', `ai-radar-${stamp}.html`);
const latest = path.join(RUNTIME, 'reports', 'latest.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
fs.writeFileSync(latest, out);
process.stdout.write(file + '\n');
if (has('--open')) execFile('open', [file], () => {});
