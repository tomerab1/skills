// sources/github.mjs — discover repos + releases via the `gh` CLI (already authed).
// Pure HTTP through gh; no LLM. Records star snapshots into the metrics table so the
// knowledge graph can compute "trending" (star velocity) over successive hourly runs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { upsertItem, upsertEntity, recordMetric } from '../db.mjs';

const exec = promisify(execFile);
const log = (...a) => process.stderr.write('[github] ' + a.join(' ') + '\n');

async function gh(args) {
  const { stdout } = await exec('gh', args, { maxBuffer: 8 * 1024 * 1024, timeout: 45000 });
  return stdout;
}

async function searchRepos(query, minStars) {
  try {
    const out = await gh([
      'search', 'repos', query,
      '--sort', 'stars', '--order', 'desc', '--limit', '15',
      '--json', 'fullName,description,stargazersCount,forksCount,url,updatedAt,createdAt',
    ]);
    const rows = JSON.parse(out || '[]');
    return rows.filter(r => (r.stargazersCount || 0) >= (minStars || 0));
  } catch (e) {
    log('search failed:', query, '—', e.shortMessage || e.message);
    return [];
  }
}

async function latestReleases(fullName) {
  try {
    const out = await gh([
      'api', `repos/${fullName}/releases`,
      '--jq', '.[0:2] | map({tag:.tag_name, name:.name, url:.html_url, published:.published_at, body:.body})',
    ]);
    return JSON.parse(out || '[]');
  } catch {
    return []; // repo may have no releases — fine.
  }
}

export async function ingestGitHub(db, cfg) {
  const g = cfg.github || {};
  let added = 0, scanned = 0;

  // 1) Trending / search-driven repo discovery.
  for (const q of (g.searchQueries || [])) {
    const repos = await searchRepos(q, g.minStars);
    for (const r of repos) {
      scanned++;
      const isNew = upsertItem(db, {
        source: 'github', kind: 'repo', title: r.fullName, url: r.url,
        summary: r.description || '', author: r.fullName.split('/')[0], published: r.createdAt,
        tags: ['repo', q.split(' ')[0]], raw: r,
      });
      if (isNew) added++;
      const entId = upsertEntity(db, { type: 'repo', name: r.fullName, url: r.url, meta: { stars: r.stargazersCount } });
      upsertEntity(db, { type: 'org', name: r.fullName.split('/')[0], url: `https://github.com/${r.fullName.split('/')[0]}` });
      recordMetric(db, r.fullName, 'stars', r.stargazersCount);
      recordMetric(db, r.fullName, 'forks', r.forksCount);
    }
  }

  // 2) Releases from explicitly watched repos (high-signal: anthropics, MCP, etc.).
  for (const repo of (g.watchRepos || [])) {
    const rels = await latestReleases(repo);
    for (const rel of rels) {
      scanned++;
      const isNew = upsertItem(db, {
        source: 'github', kind: 'release',
        title: `${repo} ${rel.tag || rel.name || ''}`.trim(),
        url: rel.url, summary: (rel.body || '').slice(0, 600),
        author: repo.split('/')[0], published: rel.published,
        tags: ['release', repo], raw: rel,
      });
      if (isNew) added++;
      upsertEntity(db, { type: 'repo', name: repo, url: `https://github.com/${repo}` });
    }
  }

  log(`scanned ${scanned}, new ${added}`);
  return { scanned, added };
}
