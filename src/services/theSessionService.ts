import type { Card, FileEntry } from '../types';
import { generateId } from '../utils';

const BASE = 'https://thesession.org';

// ── API shapes ────────────────────────────────────────────────────────────────

/** Returned by /tunes/search — lightweight, no tunebooks or settings. */
export interface TuneSearchResult {
  id: number;
  name: string;
  type: string;
  url: string;
}

export interface TuneSetting {
  id: number;
  url: string;
  key: string;
  abc: string;
  member: { id: number; name: string; url: string };
  date: string;
}

/** Returned by /tunes/{id} — full data including tunebooks and settings. */
export interface TuneResult {
  id: number;
  name: string;
  type: string;
  url: string;
  tunebooks: number;
  topKey: string | null; // most represented key across settings
  settings: TuneSetting[];
}

interface RawSearchResponse {
  tunes: TuneSearchResult[];
}

interface RawTuneResponse {
  id: number;
  name: string;
  type: string;
  url: string;
  tunebooks: number;
  settings?: TuneSetting[];
}

interface MemberTunesResponse {
  pages: number;
  tunes: Array<{ id: number }>;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function searchTunes(query: string): Promise<TuneSearchResult[]> {
  const res = await fetch(`${BASE}/tunes/search?q=${encodeURIComponent(query)}&format=json`);
  if (!res.ok) throw new Error(`TheSession search failed: ${res.status}`);
  const data = (await res.json()) as RawSearchResponse;
  return data.tunes ?? [];
}

export async function fetchTuneById(id: number): Promise<TuneResult> {
  const res = await fetch(`${BASE}/tunes/${id}?format=json&order=popular`);
  if (!res.ok) throw new Error(`TheSession fetch failed: ${res.status}`);
  const data = (await res.json()) as RawTuneResponse;
  return {
    id: data.id,
    name: data.name,
    type: data.type,
    url: data.url,
    tunebooks: data.tunebooks,
    topKey: mostCommonKey(data.settings ?? []),
    settings: data.settings ?? [],
  };
}

export async function fetchMemberInfo(memberId: number): Promise<{ name: string; total: number }> {
  const res = await fetch(`${BASE}/members/${memberId}/tunebook?format=json`);
  if (!res.ok) throw new Error(`Member not found`);
  const data = (await res.json()) as { total: number; member: { name: string } };
  return { name: data.member?.name ?? `Member ${memberId}`, total: data.total ?? 0 };
}

export async function fetchMemberTunes(
  memberId: number,
  onProgress: (loaded: number, total: number, phase: 'pages' | 'tunes') => void
): Promise<TuneResult[]> {
  // Phase 1 — collect unique tune IDs by paginating settings
  const first = await fetch(`${BASE}/members/${memberId}/tunebook?format=json`);
  if (!first.ok) throw new Error(`TheSession member fetch failed: ${first.status}`);
  const firstData = (await first.json()) as MemberTunesResponse;
  const pages = firstData.pages ?? 1;

  const seen = new Set<number>();
  const addIds = (d: MemberTunesResponse) => {
    for (const t of d.tunes ?? []) seen.add(t.id);
  };
  addIds(firstData);
  onProgress(1, pages, 'pages');

  for (let page = 2; page <= pages; page++) {
    const res = await fetch(`${BASE}/members/${memberId}/tunebook?format=json&page=${page}`);
    if (!res.ok) throw new Error(`TheSession page ${page} failed: ${res.status}`);
    addIds((await res.json()) as MemberTunesResponse);
    onProgress(page, pages, 'pages');
  }

  // Phase 2 — fetch each tune individually to get full data
  const ids = [...seen];
  const tunes: TuneResult[] = [];
  for (let i = 0; i < ids.length; i++) {
    tunes.push(await fetchTuneById(ids[i]!));
    onProgress(i + 1, ids.length, 'tunes');
  }
  return tunes;
}

// ── ABC generation ────────────────────────────────────────────────────────────

function theSessionKeyToAbc(key: string): string {
  const modes: Record<string, string> = {
    major: '', minor: 'm', dorian: 'dor', mixolydian: 'mix',
    lydian: 'lyd', phrygian: 'phr', locrian: 'loc',
  };
  for (const [full, abbr] of Object.entries(modes)) {
    if (key.toLowerCase().endsWith(full)) {
      return key.slice(0, key.length - full.length) + abbr;
    }
  }
  return key;
}

function tuneTypeToMeter(type: string): string {
  const map: Record<string, string> = {
    reel: '4/4', jig: '6/8', 'slip jig': '9/8', hornpipe: '4/4',
    polka: '2/4', waltz: '3/4', mazurka: '3/4', barndance: '4/4',
    slide: '12/8', strathspey: '4/4', 'three-two': '3/2', march: '4/4',
  };
  return map[type.toLowerCase()] ?? '4/4';
}

function settingToAbcFile(setting: TuneSetting, tune: TuneResult): FileEntry {
  const key = theSessionKeyToAbc(setting.key);
  const abc = [
    `X: ${setting.id}`,
    `T: ${tune.name}`,
    `Z: ${setting.member.name}`,
    `S: ${setting.url}`,
    `R: ${tune.type}`,
    `M: ${tuneTypeToMeter(tune.type)}`,
    `L: 1/8`,
    `K: ${key}`,
    setting.abc.replace(/!/g, '\n'),
  ].join('\n');
  // encode UTF-8 → base64
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(abc)));
  return {
    name: `${tune.name} - Setting ${setting.id} (${key}).abc`,
    mimeType: 'text/plain',
    data: b64,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mostCommonKey(settings: Array<{ key: string }>): string | null {
  if (settings.length === 0) return null;
  const counts = new Map<string, number>();
  for (const s of settings) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  let best = ''; let bestCount = 0;
  for (const [key, count] of counts) { if (count > bestCount) { bestCount = count; best = key; } }
  return best || null;
}

export function tuneResultToCard(tune: TuneResult, opts: { onlyFirstSetting?: boolean } = {}): Card {
  const tags: string[] = ['thesession'];
  if (tune.type) tags.push(tune.type.toLowerCase());
  if (tune.topKey) tags.push(tune.topKey.toLowerCase());
  const settings = (opts.onlyFirstSetting ?? true) ? tune.settings.slice(0, 1) : tune.settings;
  return {
    id: generateId(),
    name: tune.name,
    importance: tune.tunebooks > 0 ? tune.tunebooks : 1,
    tags,
    externalId: `thesession:${tune.id}`,
    content: {
      notes: `[↗ TheSession](${tune.url || `https://thesession.org/tunes/${tune.id}`})`,
      files: settings.map(s => settingToAbcFile(s, tune)),
    },
  };
}

/** Returns the existing card with this externalId, or undefined. */
export function findByExternalId(externalId: string, cards: Record<string, import('../types').Card>): import('../types').Card | undefined {
  return Object.values(cards).find(c => c.externalId === externalId);
}
