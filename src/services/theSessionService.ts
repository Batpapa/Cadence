import type { Card, FileEntry, Attachment } from '../types';
import { generateId } from '../utils';
import { TuneUnavailableError, withTuneIdentity, type SkippedTune } from './tuneFetchError';

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
  // `name` is present on the real tunebook payload, and it is the only place a
  // batch import ever learns a tune's name *before* fetching it — which is what
  // lets a phase-2 failure be reported by name rather than by bare number.
  // Optional so a trimmed response still parses.
  tunes: Array<{ id: number; name?: string }>;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function searchTunes(query: string): Promise<TuneSearchResult[]> {
  const res = await fetch(`${BASE}/tunes/search?q=${encodeURIComponent(query)}&format=json`);
  if (!res.ok) throw new Error(`TheSession search failed: ${res.status}`);
  const data = (await res.json()) as RawSearchResponse;
  return data.tunes ?? [];
}

export async function fetchTuneById(id: number): Promise<TuneResult> {
  // `orderby` (not `order`) is TheSession API's actual parameter name for
  // this — the previous `order=popular` was silently ignored (unrecognized
  // param), so settings always came back in default (id-ascending) order
  // despite the request looking like it asked for popularity order. Verified
  // directly against the live API (2026-08-24): `order=popular` produces the
  // exact same ordering as no param at all; `orderby=popular` produces a
  // genuinely different one.
  const res = await fetch(`${BASE}/tunes/${id}?format=json&orderby=popular`);
  if (res.status === 451) throw new TuneUnavailableError(`thesession:${id}`);
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

/** fetchTuneById for the batch paths: a failure names the tune it happened on. */
function fetchTuneForBatch(id: number, name?: string): Promise<TuneResult> {
  return withTuneIdentity(`thesession:${id}`, name, () => fetchTuneById(id));
}

export async function fetchMemberInfo(memberId: number): Promise<{ name: string; total: number }> {
  const res = await fetch(`${BASE}/members/${memberId}/tunebook?format=json`);
  if (!res.ok) throw new Error(`Member not found`);
  const data = (await res.json()) as { total: number; member: { name: string } };
  return { name: data.member?.name ?? `Member ${memberId}`, total: data.total ?? 0 };
}

export async function fetchMemberTunes(
  memberId: number,
  onProgress: (loaded: number, total: number, phase: 'pages' | 'tunes') => void,
  skipId?: (id: number) => boolean
): Promise<{ tunes: TuneResult[]; skippedIds: number[]; blocked: SkippedTune[] }> {
  // Phase 1 — collect unique tune IDs by paginating tunebook
  const first = await fetch(`${BASE}/members/${memberId}/tunebook?format=json`);
  if (!first.ok) throw new Error(`TheSession member fetch failed: ${first.status}`);
  const firstData = (await first.json()) as MemberTunesResponse;
  const pages = firstData.pages ?? 1;

  // id → name from the listing, so a phase-2 failure can be named, not just numbered.
  const seen = new Map<number, string | undefined>();
  const addIds = (d: MemberTunesResponse) => {
    for (const t of d.tunes ?? []) if (!seen.has(t.id)) seen.set(t.id, t.name);
  };
  addIds(firstData);
  onProgress(1, pages, 'pages');

  for (let page = 2; page <= pages; page++) {
    const res = await fetch(`${BASE}/members/${memberId}/tunebook?format=json&page=${page}`);
    if (!res.ok) throw new Error(`TheSession page ${page} failed: ${res.status}`);
    addIds((await res.json()) as MemberTunesResponse);
    onProgress(page, pages, 'pages');
  }

  // Phase 2 — fetch only tunes not already in the library
  const allIds = [...seen.keys()];
  const ids = skipId ? allIds.filter(id => !skipId(id)) : allIds;
  const skippedIds = skipId ? allIds.filter(id => skipId(id)) : [];
  const tunes: TuneResult[] = [];
  const blocked: SkippedTune[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    try {
      tunes.push(await fetchTuneForBatch(id, seen.get(id)));
    } catch (e) {
      if (!(e instanceof TuneUnavailableError)) throw e;
      blocked.push({ id, name: seen.get(id) });
    }
    onProgress(i + 1, ids.length, 'tunes');
  }
  return { tunes, skippedIds, blocked };
}

/** Fetches a user-supplied list of tune IDs (e.g. pasted "1;5;97"), skipping
 *  IDs already in the library — same shape as fetchMemberTunes' phase 2. */
export async function fetchTunesByIds(
  ids: number[],
  onProgress: (loaded: number, total: number) => void,
  skipId?: (id: number) => boolean,
  /** Names the caller already knows (an IrishTuneInfo→TheSession mapping), so
   *  a failure here can be reported by name rather than by bare id. */
  names?: Map<number, string>,
): Promise<{ tunes: TuneResult[]; skippedIds: number[]; blocked: SkippedTune[] }> {
  const unique = [...new Set(ids)];
  const toFetch = skipId ? unique.filter(id => !skipId(id)) : unique;
  const skippedIds = skipId ? unique.filter(id => skipId(id)) : [];
  const tunes: TuneResult[] = [];
  const blocked: SkippedTune[] = [];
  for (let i = 0; i < toFetch.length; i++) {
    const id = toFetch[i]!;
    try {
      tunes.push(await fetchTuneForBatch(id, names?.get(id)));
    } catch (e) {
      if (!(e instanceof TuneUnavailableError)) throw e;
      blocked.push({ id, name: names?.get(id) });
    }
    onProgress(i + 1, toFetch.length);
  }
  return { tunes, skippedIds, blocked };
}

// ── ABC generation ────────────────────────────────────────────────────────────

/** "Dmajor" → "D", "Edorian" → "Edor", "Aminor" → "Am" — TheSession/FolkFriend mode names to ABC keys. */
export function theSessionKeyToAbc(key: string): string {
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

function settingToAbcBlock(setting: TuneSetting, tune: TuneResult, index: number): string {
  const key = theSessionKeyToAbc(setting.key);
  return [
    `X: ${index}`,
    `T: ${tune.name}`,
    `Z: ${setting.member.name}`,
    `S: ${setting.url}`,
    `R: ${tune.type}`,
    `M: ${tuneTypeToMeter(tune.type)}`,
    `L: 1/8`,
    `K: ${key}`,
    setting.abc.replace(/!/g, '\n'),
  ].join('\n');
}

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function settingToAbcFile(setting: TuneSetting, tune: TuneResult): FileEntry {
  const key = theSessionKeyToAbc(setting.key);
  return {
    name: `${tune.name} - Setting ${setting.id} (${key}).abc`,
    mimeType: 'text/plain',
    data: toBase64(settingToAbcBlock(setting, tune, setting.id)),
  };
}

export function settingsToMergedAbcFile(settings: TuneSetting[], tune: TuneResult): FileEntry {
  const abc = settings.map((s, i) => settingToAbcBlock(s, tune, i + 1)).join('\n\n');
  return {
    name: `${tune.name}.abc`,
    mimeType: 'text/plain',
    data: toBase64(abc),
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

export function tuneResultToCard(tune: TuneResult): Card {
  const tags: string[] = ['TheSession'];
  if (tune.type) tags.push(tune.type);
  if (tune.topKey) tags.push(tune.topKey);
  const settings = tune.settings;
  // Always merged (2026-08-24) — was previously a togglable option, but the
  // only place that ever turned it off was theSessionImport.ts's checkbox;
  // every other import path (trending, IrishTuneInfo, card refresh, session
  // analyzer "add to library") always called this with merge on already.
  // Merging is now unconditional, everywhere a TheSession tune becomes a
  // card.
  const merge = settings.length > 1;
  const attachments: Attachment[] = merge
    ? [{ type: 'file' as const, ...settingsToMergedAbcFile(settings, tune), generatedBy: 'thesession' as const }]
    : settings.map(s => ({ type: 'file' as const, ...settingToAbcFile(s, tune), generatedBy: 'thesession' as const })) as Attachment[];
  return {
    id: generateId(),
    guid: generateId(),
    name: tune.name,
    defaultImportance: theSessionImportance(tune),
    tags,
    externalId: `thesession:${tune.id}`,
    content: {
      // No source link here: the card page shows a clickable pin from `externalId` (see utils.ts externalSourceLink).
      notes: '',
      attachments,
    },
  };
}

// ── Refreshing an already-imported card ──────────────────────────────────────
// A card's TheSession-derived fields are frozen at import time, but upstream
// they keep moving: tunes get renamed, settings are added, popularity drifts.
// These apply one freshly fetched tune onto an existing card, each touching a
// single field so a refresh never clobbers anything the user has since edited.
// Shared by the card page's source-pin menu and the library's bulk refresh, so
// both stay one rule rather than two drifting copies.

/** Popularity, as importance: a tune in 400 tunebooks matters more than one in 3. */
export function theSessionImportance(tune: TuneResult): number {
  return tune.tunebooks > 0 ? tune.tunebooks : 1;
}

/** Replaces only `name` — tags/notes/attachments untouched. */
export function applyTheSessionName(card: Card, tune: TuneResult): void {
  card.name = tune.name;
}

/** Replaces only `defaultImportance`. Per-deck overrides are left alone: those
 *  are the user's own judgement about a deck, not TheSession's about the world. */
export function applyTheSessionImportance(card: Card, tune: TuneResult): void {
  card.defaultImportance = theSessionImportance(tune);
}

/** Replaces only the ABC attachment(s) this card got from a previous
 *  TheSession fetch (found via `generatedBy`). If none are tagged (a card
 *  imported before that field existed, or whose ABC was removed manually), the
 *  fresh one is appended instead — never blocked on finding an original. */
export function applyTheSessionAbc(card: Card, tune: TuneResult): void {
  const fresh = settingsToMergedAbcFile(tune.settings, tune);
  const old = card.content.attachments.find(a => a.type === 'file' && a.generatedBy === 'thesession');
  const oldPreferredIndex = old?.type === 'file' ? old.preferredIndex : undefined;
  // Only carried over if it's still a valid tune index in the freshly fetched
  // ABC (settingsToMergedAbcFile emits one tune per setting) — a setting
  // removed on TheSession since shouldn't leave the card pointing at a version
  // that no longer exists.
  const preferredIndex = oldPreferredIndex !== undefined && oldPreferredIndex < tune.settings.length ? oldPreferredIndex : undefined;
  const kept = card.content.attachments.filter(a => !(a.type === 'file' && a.generatedBy === 'thesession'));
  kept.push({ type: 'file', ...fresh, generatedBy: 'thesession', ...(preferredIndex !== undefined ? { preferredIndex } : {}) });
  card.content.attachments = kept;
}

export interface MemberSearchResult {
  id: number;
  name: string;
  url: string;
  bio: string;
}

export async function searchMembers(query: string): Promise<MemberSearchResult[]> {
  const res = await fetch(`${BASE}/members/search?q=${encodeURIComponent(query)}&format=json`);
  if (!res.ok) throw new Error(`Member search failed: ${res.status}`);
  const data = (await res.json()) as { members?: MemberSearchResult[] };
  return data.members ?? [];
}

/** Returns the existing card with this externalId, or undefined. */
export function findByExternalId(externalId: string, cards: Record<string, import('../types').Card>): import('../types').Card | undefined {
  return Object.values(cards).find(c => c.externalId === externalId);
}
