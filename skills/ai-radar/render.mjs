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
import { openDb, RUNTIME, loadConfig, recentItems, countsBySource, trendingRepos, starSeries, risingStories, markSeenByUrls } from './db.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fmtDate = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };

const SRC = {
  github:      { label: 'GitHub',   color: '#7aa2ff' },
  provider:    { label: 'Blog',     color: '#5fd0a0' },
  hackernews:  { label: 'HN',       color: '#ff6600' },
  lobsters:    { label: 'Lobsters', color: '#ac130d' },
  reddit:      { label: 'Reddit',   color: '#ff4500' },
  huggingface: { label: 'HF',       color: '#f7c948' },
  npm:         { label: 'npm',      color: '#cb3837' },
  arxiv:       { label: 'arXiv',    color: '#b31b1b' },
  x:           { label: 'X',        color: '#c0c4d4' },
  web:         { label: 'Web',      color: '#d98a4a' },
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
    let also = [];
    try { also = JSON.parse(it.also || '[]'); } catch { /* none */ }
    return {
      title: it.title, url: it.url, source: it.source, kind: it.kind,
      date: it.published || it.captured, author: it.author,
      whyYouCare: why, tags: it.tags ? JSON.parse(it.tags) : [],
      isNew: Date.parse(it.captured) >= recentCut, signal: '',
      also, seen: !!it.seen, featured: (it.score || 0) > 0,
      _score: s.total, _lowRel: s.kwScore < dimBelow,
      _captured: it.captured, _points: points, _comments: comments,
    };
  });
  const pick = (pred) => norm.filter(pred)
    .sort((a, b) => b._score - a._score || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const COMMUNITY = new Set(['hackernews', 'lobsters', 'reddit']);
  const sections = [
    { id: 'releases', title: 'Releases & official tools', blurb: 'New versions from watched orgs & packages (Anthropic, MCP, OpenAI, npm…) — changelog notes inline.',
      items: pick(i => i.kind === 'release') },
    { id: 'repos', title: 'Repos & packages', blurb: 'Skills, agents, MCP servers & frameworks surfacing in GitHub + npm search.',
      items: pick(i => (i.source === 'github' && i.kind === 'repo') || (i.source === 'npm' && i.kind === 'package')) },
    { id: 'models', title: 'Models trending on HF', blurb: 'Hugging Face hub, by trending score.',
      items: pick(i => i.source === 'huggingface') },
    { id: 'reading', title: 'Reading & changelogs', blurb: 'Provider blogs, engineering writeups, video drops.',
      items: pick(i => i.source === 'provider') },
    { id: 'community', title: 'Community (HN · Lobsters · Reddit)', blurb: 'What practitioners are upvoting and arguing about.',
      items: pick(i => COMMUNITY.has(i.source)) },
    { id: 'arxiv', title: 'Research (arXiv)', blurb: 'Recent papers on agents, LLMs & language models — most relevant first.',
      items: pick(i => i.source === 'arxiv') },
    { id: 'x', title: 'From X', blurb: 'Links shared by people you follow.',
      items: pick(i => i.source === 'x') },
  ].filter(s => s.items.length);

  const data = {
    title: cfg.title || 'AI Radar',
    generatedAt: new Date().toISOString(),
    windowLabel: `last ${days} days`,
    mode: 'from-db (no LLM)',
    sections,
    trending: withSeries(db, trendingRepos(db, 14, 12)),
    rising: risingStories(db, 3, 8),
    stats: { scanned: items.length, new: norm.filter(i => i.isNew).length,
             sources: Object.fromEntries(countsBySource(db).map(r => [r.source, r.n])) },
  };
  db.close();
  return data;
}

// Attach a compact star-history series to each trending repo (for sparklines).
function withSeries(db, trending) {
  return trending.map(t => ({ ...t, series: starSeries(db, t.name, 14).map(r => r.value) }));
}

function buildFromCurated(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.title ||= 'AI Radar';
  data.generatedAt ||= new Date().toISOString();
  data.mode ||= 'curated';
  const db = openDb();
  if (!data.trending) data.trending = trendingRepos(db, 14, 12);
  data.trending = withSeries(db, data.trending);
  if (!data.rising) data.rising = risingStories(db, 3, 8);
  db.close();
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
  // cross-source badges: this URL was also discovered on HN / reddit / lobsters — link the thread
  const alsoB = (it.also || []).slice(0, 3).map(a => {
    const c = (SRC[a.source] || {}).color || '#9aa1b8';
    const label = esc(a.note || (SRC[a.source] || {}).label || a.source);
    return a.url
      ? `<a class="also" style="--c:${c}" href="${esc(a.url)}" target="_blank" rel="noopener" title="also on ${esc(a.source)}">${label}</a>`
      : `<span class="also" style="--c:${c}" title="also on ${esc(a.source)}">${label}</span>`;
  }).join('');
  return `<div class="card${it._lowRel ? ' lowrel' : ''}${it.featured ? ' featured' : ''}" data-href="${esc(it.url)}" data-source="${esc(it.source || '')}" data-captured="${esc(captured)}" data-date="${esc(it.date || '')}" data-points="${it._points || 0}" data-score="${Number(it._score || 0).toFixed(2)}" data-lowrel="${it._lowRel ? 1 : 0}" data-search="${esc(search)}"${it._lowRel ? ' title="lower relevance to your interests"' : ''}>
    <div class="top">
      <span class="badge" style="--c:${s.color}">${esc(s.label)}</span>
      ${pts}${alsoB}
      <span class="new">NEW</span>
      ${it.signal ? `<span class="signal">${esc(it.signal)}</span>` : ''}
      ${it.featured ? `<span class="feat" title="featured in a previous curated report">✓</span>` : ''}
      <span class="when">${esc(fmtDate(it.date))}</span>
      <button class="star" type="button" title="save (s)" aria-label="save">☆</button>
    </div>
    <a class="name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
    ${it.whyYouCare ? `<div class="why">${mdToHtml(it.whyYouCare)}</div>` : ''}
    <div class="foot"><span class="src">${esc(host(it.url))}</span>${tags}</div>
  </div>`;
}

// Tiny inline SVG sparkline for a numeric series (star history on trending cards).
function sparkline(series, w = 60, h = 16) {
  const v = (series || []).filter(n => Number.isFinite(n));
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 1.5 - (n - min) / span * (h - 3)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function html(d) {
  const hasTrend = (d.trending || []).length > 0;
  const secs = (d.sections || []).map(sec => ({ ...sec, _id: 'sec-' + (sec.id ? slug(sec.id) : slug(sec.title)) }));

  // toolbar: source filter buttons with live counts + total
  const allItems = secs.flatMap(s => s.items);
  const total = allItems.length;
  const srcCounts = {};
  for (const it of allItems) srcCounts[it.source] = (srcCounts[it.source] || 0) + 1;
  const srcFilters = Object.keys(srcCounts).filter(k => SRC[k]).map(k =>
    `<button class="sf" data-src="${k}" type="button"><span class="swatch" style="--c:${SRC[k].color}"></span>${esc(SRC[k].label)} <i>${srcCounts[k]}</i></button>`).join('');
  const toolbar = `
    <div class="toolbar" role="search">
      <div class="searchwrap"><input id="q" class="search" type="search" placeholder="Search ${total} items" autocomplete="off" aria-label="Search"><kbd>/</kbd></div>
      <div class="srcfilters">${srcFilters}</div>
      <select id="recency" class="ctl" aria-label="Recency">
        <option value="0">Any time</option><option value="1">24h</option><option value="7">7 days</option><option value="21">21 days</option>
      </select>
      <select id="sortsel" class="ctl" aria-label="Sort">
        <option value="rel">Relevance</option><option value="new">Newest</option><option value="pts">HN points</option>
      </select>
      <button class="sf" id="savedbtn" type="button" title="show saved only">★ Saved <i id="savedn">0</i></button>
      <label class="tg"><input type="checkbox" id="newonly"> New</label>
      <label class="tg"><input type="checkbox" id="hidelow"> Hide low-rel</label>
      <label class="tg"><input type="checkbox" id="hideread"> Hide read</label>
      <span id="shown" class="shown"></span>
    </div>`;

  // Left nav rail with live counts + scrollspy.
  const tree = `
    <nav class="side">
      <div class="sidehead">Sections</div>
      <ul class="tree">
        ${hasTrend ? `<li><a href="#trending" data-jump>Trending<span class="n">${d.trending.length}</span></a></li>` : ''}
        ${secs.map(s => `<li><a href="#${s._id}" data-jump>${esc(s.title)}<span class="n">${s.items.length}</span></a></li>`).join('')}
      </ul>
      <div class="sidefoot">j / k move · o open · s save · / search<br>Click a section header to collapse it.</div>
    </nav>`;

  const trending = hasTrend ? `
    <section id="trending" class="sec trend">
      <div class="sechead"><span class="caret">▾</span><h2>Trending repos <span class="sub">stars gained · 14d</span></h2></div>
      <div class="trendrow">
        ${d.trending.map(t => `<a class="tcard" href="${esc(t.url)}" target="_blank" rel="noopener">
          <span class="trow"><span class="delta">+${t.delta.toLocaleString('en-US')}</span>${sparkline(t.series)}</span>
          <span class="tname">${esc(t.name)}</span>
          <span class="tstars">★ ${t.latest.toLocaleString('en-US')}</span></a>`).join('')}
      </div>
      ${(d.rising || []).length ? `<div class="risingrow"><span class="risinglabel">Rising on HN</span>${d.rising.map(r =>
        `<a class="rchip" href="${esc(r.url)}" target="_blank" rel="noopener" title="+${r.delta} points recently"><b>+${r.delta}</b> ${esc(String(r.title).slice(0, 60))}</a>`).join('')}</div>` : ''}
    </section>` : '';

  const sections = secs.map(sec => `
    <section id="${sec._id}" class="sec">
      <div class="sechead" data-sec><span class="caret">▾</span><h2>${esc(sec.title)} <span class="count">${sec.items.length}</span></h2></div>
      ${sec.blurb ? `<p class="blurb">${esc(sec.blurb)}</p>` : ''}
      <div class="grid">${sec.items.map(card).join('')}</div>
    </section>`).join('');

  const isCurated = String(d.mode || '').includes('curated');
  const genDate = new Date(d.generatedAt);
  const dateline = genDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(d.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#1b1a16; --panel:#24231e; --panel2:#2b2a24; --raise:#31302a;
    --line:rgba(240,238,230,.085); --line2:rgba(240,238,230,.16);
    --ink:#f0eee6; --mut:#b9b5a7; --faint:#8b8779;
    --accent:#d97757; --accent2:#e59f86;
    --ui:"Familjen Grotesk",-apple-system,"Segoe UI",sans-serif;
    --prose:"Source Serif 4",Georgia,serif;
    --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  }
  *{box-sizing:border-box}html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--ui);-webkit-font-smoothing:antialiased}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(900px 420px at 78% -10%,rgba(217,119,87,.07),transparent 60%)}
  ::selection{background:var(--accent);color:#1b1a16}
  a{color:inherit;text-decoration:none}
  .wrap{position:relative;max-width:1180px;margin:0 auto;padding:22px 24px 80px}
  /* ---- top bar ---------------------------------------------------------- */
  .bar{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;padding:6px 0 16px}
  .brand{display:flex;align-items:center;gap:9px;font:600 17px/1 var(--ui);letter-spacing:-.01em}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px rgba(217,119,87,.55)}
  .bar .meta{color:var(--faint);font-size:12.5px}
  .bar .meta b{color:var(--mut);font-weight:500}
  .mode{margin-left:auto;font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);border:1px solid var(--line2);border-radius:99px;padding:3px 10px}
  body.curated .mode{color:var(--accent);border-color:rgba(217,119,87,.4)}
  #newchip{font-size:12.5px;color:var(--faint)}
  #newchip b{color:var(--accent);font-weight:600}
  /* ---- toolbar ----------------------------------------------------------- */
  .toolbar{position:sticky;top:0;z-index:8;display:flex;flex-wrap:wrap;align-items:center;gap:7px 9px;padding:10px 0;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .searchwrap{position:relative;flex:1 1 220px;min-width:170px;display:flex;align-items:center}
  .search{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:7px 30px 7px 12px;color:var(--ink);font:400 13px var(--ui);outline:none;transition:border-color .15s}
  .search::placeholder{color:var(--faint)}
  .search:focus{border-color:rgba(217,119,87,.55)}
  .searchwrap kbd{position:absolute;right:8px;font:500 10px var(--mono);color:var(--faint);border:1px solid var(--line2);border-radius:4px;padding:1px 5px;pointer-events:none}
  .srcfilters{display:flex;gap:4px;flex-wrap:wrap}
  .sf{background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:4px 10px;font:500 11.5px var(--ui);color:var(--mut);cursor:pointer;display:inline-flex;gap:6px;align-items:center;transition:border-color .15s,color .15s}
  .sf .swatch{width:7px;height:7px;border-radius:2px;background:var(--c)}
  .sf i{font-style:normal;color:var(--faint);font-size:10.5px;font-variant-numeric:tabular-nums}
  .sf:hover{border-color:var(--line2);color:var(--ink)}
  .sf.off{opacity:.4}.sf.off .swatch{background:var(--faint)}
  .sf.on{border-color:rgba(217,119,87,.55);color:var(--accent)}
  .ctl{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:5px 8px;color:var(--mut);font:500 11.5px var(--ui);cursor:pointer;outline:none}
  .tg{display:inline-flex;align-items:center;gap:5px;font:500 11.5px var(--ui);color:var(--mut);cursor:pointer;user-select:none;white-space:nowrap}
  .tg input{accent-color:var(--accent);cursor:pointer;width:13px;height:13px}
  .shown{margin-left:auto;font:400 11px var(--mono);color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
  /* ---- layout ------------------------------------------------------------- */
  .layout{display:grid;grid-template-columns:212px minmax(0,1fr);gap:30px;align-items:start;margin-top:16px}
  .side{position:sticky;top:58px;max-height:calc(100vh - 74px);overflow:auto;padding:2px 0}
  .sidehead{font:600 10.5px var(--ui);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:2px 10px 8px}
  .tree{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
  .tree a{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font:500 13px/1.3 var(--ui);color:var(--mut);border-left:2px solid transparent}
  .tree a:hover{background:var(--panel);color:var(--ink)}
  .tree a.active{background:rgba(217,119,87,.1);color:var(--ink);border-left-color:var(--accent)}
  .tree .n{margin-left:auto;font:400 10.5px var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
  .tree a.active .n{color:var(--accent)}
  .sidefoot{margin:14px 10px 2px;font:400 10.5px/1.8 var(--mono);color:var(--faint)}
  /* ---- sections ------------------------------------------------------------ */
  .sec{scroll-margin-top:58px}
  .sechead{display:flex;align-items:center;gap:9px;cursor:pointer;user-select:none;margin-top:30px;padding-left:11px;position:relative}
  .sechead::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:3px;border-radius:2px;background:var(--accent)}
  .sec:first-child .sechead,.trend .sechead{margin-top:6px}
  h2{font:600 13px/1.2 var(--ui);letter-spacing:.1em;text-transform:uppercase;color:var(--ink);margin:0}
  h2 .count{font:400 11px var(--mono);color:var(--accent);letter-spacing:0;margin-left:7px;font-variant-numeric:tabular-nums}
  h2 .sub{font:italic 400 12.5px var(--prose);color:var(--faint);text-transform:none;letter-spacing:0;margin-left:7px;font-weight:400}
  .caret{color:var(--faint);font-size:10px;width:11px;transition:transform .15s}
  .sec.collapsed .caret{transform:rotate(-90deg)}
  .sec.collapsed .blurb,.sec.collapsed .grid,.sec.collapsed .trendrow,.sec.collapsed .risingrow{display:none}
  .blurb{font:italic 400 13.5px/1.5 var(--prose);color:var(--faint);margin:8px 0 2px 11px;max-width:78ch}
  /* ---- feed rows / cards ----------------------------------------------------- */
  .grid{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 15px;display:flex;flex-direction:column;gap:7px;cursor:pointer;transition:border-color .15s,background .15s}
  .card:hover{border-color:var(--line2);background:var(--panel2)}
  .card:hover .name{color:var(--accent2)}
  .card.lowrel{opacity:.45}.card.lowrel:hover{opacity:1}
  .card.read{opacity:.45}.card.read:hover{opacity:.9}
  .card.saved{border-color:rgba(217,119,87,.45)}
  .card.kfocus{outline:2px solid var(--accent);outline-offset:2px}
  .top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:500 10.5px var(--ui)}
  .badge{display:inline-flex;align-items:center;gap:5px;color:var(--mut);font-weight:500;letter-spacing:.02em}
  .badge::before{content:"";width:7px;height:7px;border-radius:2px;background:var(--c)}
  .pts{color:var(--accent2);font:500 10.5px var(--mono);font-variant-numeric:tabular-nums}
  .also{color:var(--mut);border:1px dashed var(--line2);border-radius:6px;padding:0 6px;white-space:nowrap;font-size:10px}
  a.also:hover{border-style:solid;border-color:var(--accent);color:var(--accent)}
  .feat{color:var(--accent);font-weight:700;font-size:11px}
  .new{display:none;font:600 9px var(--ui);letter-spacing:.1em;color:#1b1a16;background:var(--accent);border-radius:5px;padding:1.5px 6px}
  .card.is-new .new{display:inline-block}
  .signal{color:#7fbf9e;font-weight:600;font-size:11px}
  .when{margin-left:auto;font:400 10.5px var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
  .star{background:none;border:0;color:var(--faint);font-size:14px;cursor:pointer;padding:0 2px;line-height:1;opacity:.6;transition:opacity .15s,color .15s}
  .card:hover .star{opacity:1}
  .star:hover{color:var(--accent)}
  .card.saved .star{color:var(--accent);opacity:1}
  .name{font:600 15px/1.35 var(--ui);letter-spacing:-.008em;color:var(--ink);overflow-wrap:anywhere;transition:color .15s}
  .why{margin:0;color:var(--mut);font:400 14px/1.55 var(--prose);max-height:150px;overflow:hidden;position:relative;overflow-wrap:anywhere}
  .why.clipped::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30px;background:linear-gradient(transparent,var(--panel));pointer-events:none}
  .card:hover .why.clipped::after{background:linear-gradient(transparent,var(--panel2))}
  .why p{margin:.2em 0}.why ul{margin:.3em 0;padding-left:1.15em}.why li{margin:.15em 0}
  .why .mdh{font:600 11px var(--ui);letter-spacing:.08em;text-transform:uppercase;color:var(--ink);margin:.6em 0 .2em}
  .why strong{color:var(--ink);font-weight:600}.why em{color:var(--mut)}
  .why a{color:var(--accent2);text-decoration:underline;text-decoration-color:rgba(217,119,87,.35);text-underline-offset:2px}
  .why a:hover{text-decoration-color:var(--accent)}
  .why code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:0 5px;font:400 12px var(--mono);color:var(--accent2)}
  .why .mention{color:var(--accent2)}
  .why hr{border:0;border-top:1px solid var(--line);margin:.6em 0}
  .why pre.code{margin:.5em 0;padding:.55em .75em;background:var(--bg);border:1px solid var(--line);border-radius:8px;font:400 12px/1.55 var(--mono);color:var(--mut);white-space:pre-wrap;overflow-wrap:anywhere}
  .why blockquote{margin:.5em 0;padding:.45em .85em;border-left:3px solid var(--line2);background:var(--bg);border-radius:0 8px 8px 0;color:var(--mut)}
  .why blockquote p{margin:.2em 0}
  .why blockquote .alert{font:600 9.5px var(--ui);letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:.15em}
  .why blockquote.al-note{border-left-color:#8fa8c9}.why blockquote.al-note .alert{color:#8fa8c9}
  .why blockquote.al-tip{border-left-color:#7fbf9e}.why blockquote.al-tip .alert{color:#7fbf9e}
  .why blockquote.al-important{border-left-color:#b39ddb}.why blockquote.al-important .alert{color:#b39ddb}
  .why blockquote.al-warning{border-left-color:#d9b45b}.why blockquote.al-warning .alert{color:#d9b45b}
  .why blockquote.al-caution{border-left-color:var(--accent)}.why blockquote.al-caution .alert{color:var(--accent)}
  .foot{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font:400 10.5px var(--mono);color:var(--faint)}
  .tag{border:1px solid var(--line);border-radius:5px;padding:0 6px;font-size:10px}
  /* ---- trending ---------------------------------------------------------------- */
  .trendrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .tcard{flex:0 0 auto;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:10px 13px;display:flex;flex-direction:column;gap:2px;min-width:148px;transition:border-color .15s,background .15s}
  .tcard:hover{border-color:rgba(217,119,87,.45);background:var(--panel2)}
  .trow{display:flex;align-items:center;gap:8px}
  .spark{color:var(--accent);opacity:.8}
  .delta{color:var(--accent);font:600 14px var(--ui);font-variant-numeric:tabular-nums}
  .tname{font:500 12.5px var(--ui);color:var(--ink)}
  .tstars{font:400 10px var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
  .risingrow{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:10px 2px 0}
  .risinglabel{font:600 10px var(--ui);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .rchip{font:400 12.5px var(--ui);color:var(--mut)}
  .rchip b{font:600 11px var(--mono);color:var(--accent)}
  .rchip:hover{color:var(--ink)}
  /* ---- footer -------------------------------------------------------------------- */
  footer{margin-top:56px;border-top:1px solid var(--line);padding-top:18px;font:400 11.5px/1.9 var(--mono);color:var(--faint)}
  footer code{background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--mut)}
  footer a{color:var(--accent2);text-decoration:underline;text-underline-offset:2px}
  /* keyboard accessibility */
  .card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .sechead:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}
  .sf:focus-visible,.ctl:focus-visible,.search:focus-visible,.tree a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  /* mobile */
  @media(max-width:880px){
    .wrap{padding:16px 14px 70px}
    .bar .meta{display:none}
    .layout{grid-template-columns:1fr;gap:12px}
    .side{position:sticky;top:52px;max-height:none;z-index:7;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
    .sidehead{display:none}
    .tree{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px;-webkit-overflow-scrolling:touch;padding:6px 0}
    .tree a{flex:0 0 auto;padding:5px 10px;white-space:nowrap;border-left:0}
    .tree a.active{border-left:0}
    .tree .n{margin-left:6px}
    .sidefoot{display:none}
    .toolbar .shown{display:none}.toolbar .srcfilters{order:6}
  }
</style></head><body class="${isCurated ? 'curated' : ''}"><div class="wrap">
  <header class="bar">
    <div class="brand"><span class="dot"></span>${esc(d.title)}</div>
    <span class="meta">${esc(dateline)}${d.windowLabel ? ` · <b>${esc(d.windowLabel)}</b>` : ''} · ${total} items</span>
    <span id="newchip">tracking new items…</span>
    <span class="mode">${esc(d.mode)}</span>
  </header>
  ${toolbar}
  <div class="layout">
    ${tree}
    <main>
      ${trending}
      ${sections || '<p style="color:var(--mut);margin-top:30px">No items yet — run the ingest first.</p>'}
      <footer>
        Built from your local knowledge graph at <code>~/ai-radar/radar.db</code>.
        Hourly ingest is pure Node (GitHub, RSS, HN, Lobsters, Reddit, HF, npm) — no <code>claude -p</code>, no metered calls.
        Refresh passively with <code>node ~/.claude/skills/ai-radar/render.mjs --from-db --open</code>,
        or run <code>/ai-radar</code> for the curated, ranked edition.
        Keys: <code>j</code>/<code>k</code> move · <code>o</code> open · <code>s</code> save · <code>/</code> search ·
        <a href="index.html">report archive</a>
      </footer>
    </main>
  </div>
<script>
(function(){
  var cards=Array.prototype.slice.call(document.querySelectorAll('.card'));
  var secAll=Array.prototype.slice.call(document.querySelectorAll('.sec'));

  // ---- saved (★) + read state, persisted in localStorage across reports (keyed by URL)
  function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k)||'{}'); }catch(e){ return {}; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
  var saved=lsGet('ai-radar:saved'), read=lsGet('ai-radar:read');
  function savedCount(){ var n=0; cards.forEach(function(c){ if(saved[c.dataset.href]) n++; }); return n; }
  function paintSaved(c){ var on=!!saved[c.dataset.href]; c.classList.toggle('saved',on); var b=c.querySelector('.star'); if(b) b.textContent=on?'★':'☆'; }
  function toggleSave(c){ var u=c.dataset.href; if(!u)return; if(saved[u]) delete saved[u]; else saved[u]={t:c.querySelector('.name')&&c.querySelector('.name').textContent||'',at:Date.now()}; lsSet('ai-radar:saved',saved); paintSaved(c); var sn=document.getElementById('savedn'); if(sn) sn.textContent=savedCount(); apply(); }
  function markRead(c){ var u=c.dataset.href; if(!u||read[u])return; read[u]=Date.now(); lsSet('ai-radar:read',read); c.classList.add('read'); }
  function openCard(c){ var u=c.dataset.href; if(u){ markRead(c); window.open(u,'_blank','noopener'); } }

  // whole-card click + keyboard (Enter/Space); inner links still work normally
  cards.forEach(function(c){
    c.setAttribute('tabindex','0'); c.setAttribute('role','link');
    if(read[c.dataset.href]) c.classList.add('read');
    paintSaved(c);
    var star=c.querySelector('.star');
    if(star) star.addEventListener('click',function(e){ e.stopPropagation(); toggleSave(c); });
    c.addEventListener('click',function(e){ if(e.target.closest&&e.target.closest('a'))return; openCard(c); });
    c.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openCard(c); } });
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
    else if(newCount) chip.innerHTML='<b>'+newCount+'</b> new since '+new Date(lastMs).toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    else chip.textContent='nothing new since last visit';
  }
  try{ localStorage.setItem(KEY,new Date().toISOString()); }catch(e){}

  // filter / search / sort — all client-side over the DOM
  var q=document.getElementById('q'), recency=document.getElementById('recency'), sortsel=document.getElementById('sortsel');
  var newonly=document.getElementById('newonly'), hidelow=document.getElementById('hidelow');
  var hideread=document.getElementById('hideread'), savedbtn=document.getElementById('savedbtn'), savedOnly=false;
  var grids=Array.prototype.slice.call(document.querySelectorAll('.grid')), srcOff=new Set();
  function apply(){
    var term=((q&&q.value)||'').toLowerCase().trim();
    var days=recency?parseInt(recency.value,10):0, cut=days?Date.now()-days*86400000:0;
    var no=newonly&&newonly.checked, hl=hidelow&&hidelow.checked, hr=hideread&&hideread.checked;
    var vis=0;
    cards.forEach(function(c){
      var ok=true;
      if(srcOff.has(c.dataset.source)) ok=false;
      if(ok&&term&&(c.dataset.search||'').indexOf(term)<0) ok=false;
      if(ok&&cut&&capMs(c)<cut) ok=false;
      if(ok&&no&&c.dataset.isnew!=='1') ok=false;
      if(ok&&hl&&c.dataset.lowrel==='1') ok=false;
      if(ok&&hr&&read[c.dataset.href]) ok=false;
      if(ok&&savedOnly&&!saved[c.dataset.href]) ok=false;
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
  [q,recency,sortsel,newonly,hidelow,hideread].forEach(function(el){ if(el) el.addEventListener('input',apply); });
  document.querySelectorAll('.sf[data-src]').forEach(function(b){
    b.setAttribute('tabindex','0');
    function t(){ var s=b.dataset.src; if(srcOff.has(s)){srcOff.delete(s);b.classList.remove('off');}else{srcOff.add(s);b.classList.add('off');} apply(); }
    b.addEventListener('click',t);
    b.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); t(); } });
  });
  if(savedbtn){
    var sn=document.getElementById('savedn'); if(sn) sn.textContent=savedCount();
    savedbtn.addEventListener('click',function(){ savedOnly=!savedOnly; savedbtn.classList.toggle('on',savedOnly); apply(); });
  }
  apply();

  // ---- keyboard nav: j/k move between visible cards, o open, s save (HN-style)
  var kIdx=-1;
  function visCards(){ return cards.filter(function(c){ return c.style.display!=='none'; }); }
  function kFocus(i){
    var v=visCards(); if(!v.length) return;
    kIdx=Math.max(0,Math.min(i,v.length-1));
    cards.forEach(function(c){ c.classList.remove('kfocus'); });
    var c=v[kIdx]; c.classList.add('kfocus');
    c.scrollIntoView({block:'center',behavior:'smooth'});
  }
  document.addEventListener('keydown',function(e){
    var t=e.target&&e.target.tagName;
    if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||e.metaKey||e.ctrlKey||e.altKey) return;
    if(e.key==='j'){ e.preventDefault(); kFocus(kIdx+1); }
    else if(e.key==='k'){ e.preventDefault(); kFocus(kIdx-1); }
    else if(e.key==='o'){ var v=visCards(); if(kIdx>=0&&v[kIdx]){ e.preventDefault(); openCard(v[kIdx]); } }
    else if(e.key==='s'){ var v2=visCards(); if(kIdx>=0&&v2[kIdx]){ e.preventDefault(); toggleSave(v2[kIdx]); } }
    else if(e.key==='/'){ e.preventDefault(); if(q) q.focus(); }
  });

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
// NB: no process.exit() after the write — when stdout is a pipe, exit() drops everything
// past the first 64KB buffer. Let the event loop drain and end naturally.
if (has('--json')) {
  process.stdout.write(JSON.stringify(buildFromDb(), null, 2) + '\n');
} else {
  renderReport();
}

function renderReport() {
const data = has('--curated') ? buildFromCurated(val('--curated')) : buildFromDb();
const out = html(data);
const stamp = data.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(RUNTIME, 'reports', `ai-radar-${stamp}.html`);
const latest = path.join(RUNTIME, 'reports', 'latest.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
fs.writeFileSync(latest, out);

// Curated render closes the curation loop: featured items become seen=1 (+score) in the KG,
// so the next /ai-radar run can prefer genuinely-unseen material.
if (has('--curated')) {
  const urls = (data.sections || []).flatMap(s => (s.items || []).map(i => i.url)).filter(Boolean);
  const db = openDb();
  const n = markSeenByUrls(db, urls);
  db.close();
  process.stderr.write(`[render] marked ${n} curated item(s) as featured/seen in the KG\n`);
}

// Regenerate the report archive index (reports/index.html) on every render.
writeArchiveIndex(path.join(RUNTIME, 'reports'));

function writeArchiveIndex(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => /^ai-radar-.*\.html$/.test(f))
    .sort().reverse();
  const rows = files.map(f => {
    const m = f.match(/^ai-radar-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
    const when = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : f;
    const kb = Math.round(fs.statSync(path.join(dir, f)).size / 1024);
    return `<li><a href="${f}">${when}</a><span class="lead"></span><span class="kb">${kb} KB</span></li>`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AI Radar — archive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--bg:#1b1a16;--panel:#24231e;--panel2:#2b2a24;--line:rgba(240,238,230,.085);--line2:rgba(240,238,230,.16);--ink:#f0eee6;--mut:#b9b5a7;--faint:#8b8779;--accent:#d97757}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Familjen Grotesk",-apple-system,sans-serif}
  .wrap{max-width:620px;margin:0 auto;padding:44px 22px}
  .brand{display:flex;align-items:center;gap:9px;font:600 16px/1 "Familjen Grotesk",sans-serif}
  .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 9px rgba(217,119,87,.55)}
  h1{font:600 26px/1.1 "Familjen Grotesk",sans-serif;letter-spacing:-.01em;margin:18px 0 6px}
  p{color:var(--faint);font-size:13px}
  p a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  ul{list-style:none;margin:22px 0;padding:0;counter-reset:n;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
  li{counter-increment:n;display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--line);padding:9px 14px}
  li:last-child{border-bottom:0}
  li:hover{background:var(--panel2)}
  li::before{content:counter(n,decimal-leading-zero);font:500 10px "IBM Plex Mono",monospace;color:var(--faint)}
  li a{color:var(--ink);text-decoration:none;font:500 14px "Familjen Grotesk",sans-serif;font-variant-numeric:tabular-nums}
  li a:hover{color:var(--accent)}
  .lead{flex:1}
  .kb{color:var(--faint);font:400 10.5px "IBM Plex Mono",monospace}
</style></head><body><div class="wrap">
<div class="brand"><span class="dot"></span>AI Radar</div>
<h1>Report archive</h1>
<p><a href="latest.html">latest.html</a> is always the newest render. ${files.length} report(s) kept.</p>
<ul>
${rows}
</ul>
</div></body></html>\n`);
}

process.stdout.write(file + '\n');
if (has('--open')) execFile('open', [file], () => {});
}
