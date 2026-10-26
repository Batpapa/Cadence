// ── TheSession popularity history, precomputed (2026-10-26) ───────────────────
// The trending module's history, built once here instead of on every device:
// a first sync in the browser replays ~360 weekly snapshots, ~267 MB, which is
// minutes of waiting — fine once in the app, absurd for the standalone
// Trending page, which has nothing to keep it in. Served as
// data/popularity.json next to the app (~14 MB, ~0.7 MB as GitHub Pages sends
// it compressed); both the page and the app's first sync start from it.
//
// Read by src/trending/publishedHistory.ts. Same walk as
// services/trendingSyncService.ts, in plain JS for Node — keep
// the two in step (the file format is trending/db.ts's PopularityDb). It
// starts from the file already published, so a weekly run fetches one or two
// snapshots; only when that file cannot be had (first deploy) does it replay
// the whole history.
//
//   node scripts/build-popularity.mjs [--out dist/data/popularity.json] [--from <url|path|none>]
//
// GITHUB_TOKEN, when set (the deploy workflow), lifts the API's 60 requests an
// hour: the commit list alone is four of them.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OWNER = 'adactio';
const REPO = 'TheSession-data';
const FILE_PATH = 'json/tune_popularity.json';
const PUBLISHED = 'https://batpapa.github.io/Cadence/data/popularity.json';
const BATCH_SIZE = 10;

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const out = arg('--out', 'dist/data/popularity.json');
const from = arg('--from', PUBLISHED);

const apiHeaders = process.env.GITHUB_TOKEN
  ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  : { Accept: 'application/vnd.github+json' };

async function fetchAllCommits() {
  const commits = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(FILE_PATH)}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: apiHeaders });
    if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
    const data = await res.json();
    if (data.length === 0) break;
    for (const c of data) commits.push({ sha: c.sha, date: c.commit.committer.date });
    if (data.length < 100) break;
  }
  return commits.reverse(); // newest-first from the API; applied oldest-first
}

async function fetchSnapshot(sha) {
  const res = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${FILE_PATH}`);
  if (!res.ok) throw new Error(`Snapshot fetch failed (${sha}): ${res.status}`);
  return res.json();
}

/** trendingSyncService.ts's applySnapshot, line for line. */
function applySnapshot(db, date, entries) {
  const prevCount = db.snapshots.length;
  const seen = new Map();
  for (const e of entries) {
    const count = typeof e.tunebooks === 'string' ? parseInt(e.tunebooks, 10) : e.tunebooks;
    seen.set(e.tune_id, count);
    db.names[e.tune_id] = e.name;
  }
  db.snapshots.push(date);
  for (const [id, values] of Object.entries(db.tunes)) values.push(seen.has(id) ? seen.get(id) : null);
  for (const id of seen.keys()) {
    if (!(id in db.tunes)) db.tunes[id] = [...new Array(prevCount).fill(null), seen.get(id)];
  }
}

const isDb = (d) => d && Array.isArray(d.snapshots) && d.tunes && d.names;

async function loadStart() {
  if (from === 'none') return null;
  try {
    const text = /^https?:/.test(from)
      ? await (async () => { const r = await fetch(from); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })()
      : existsSync(from) ? readFileSync(from, 'utf8') : null;
    const db = text && JSON.parse(text);
    if (isDb(db)) return db;
  } catch (e) {
    console.warn(`[popularity] no usable starting file at ${from} (${e.message}): full history`);
  }
  return null;
}

const db = (await loadStart()) ?? { snapshots: [], tunes: {}, names: {} };
const known = new Set(db.snapshots);
const pending = (await fetchAllCommits()).filter(c => !known.has(c.date));
console.log(`[popularity] ${db.snapshots.length} snapshots to start from, ${pending.length} to add`);

for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  const batch = pending.slice(i, i + BATCH_SIZE);
  const snapshots = await Promise.all(batch.map(c => fetchSnapshot(c.sha)));
  batch.forEach((c, j) => applySnapshot(db, c.date, snapshots[j]));
  console.log(`[popularity] ${Math.min(i + BATCH_SIZE, pending.length)}/${pending.length}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(db));
console.log(`[popularity] ${out}: ${db.snapshots.length} snapshots, ${Object.keys(db.tunes).length} tunes, last ${db.snapshots.at(-1)}`);
