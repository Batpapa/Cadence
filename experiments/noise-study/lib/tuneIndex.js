'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Same source as Cadence's indexStore.ts (sessionConfig.ts's TUNE_INDEX_URL) —
// this offline harness just caches it to disk instead of IndexedDB.
const TUNE_INDEX_URL = 'https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json';
const CACHE_DIR = path.resolve(__dirname, '../.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'tune-index.json');

/** Returns the raw index object ({settings, aliases}) — ABC fields kept as-is
 *  here (no need to strip for the offline harness; only matters for WASM
 *  memory pressure in a browser tab, which doesn't apply here). */
async function loadTuneIndex() {
  if (fs.existsSync(CACHE_PATH)) {
    console.log(`[tuneIndex] using cached copy at ${CACHE_PATH}`);
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  }
  console.log(`[tuneIndex] downloading ${TUNE_INDEX_URL} ...`);
  const res = await fetch(TUNE_INDEX_URL);
  if (!res.ok) throw new Error(`Tune index download failed: ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, text);
  console.log(`[tuneIndex] cached to ${CACHE_PATH} (${(text.length / 1e6).toFixed(1)} MB)`);
  return JSON.parse(text);
}

module.exports = { loadTuneIndex };
