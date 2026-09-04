import type { Card, FileEntry, Attachment } from '../types';
import { generateId } from '../utils';
import { TuneUnavailableError, withTuneIdentity, type SkippedTune } from './tuneFetchError';
import { CARD_TYPE_TUNE, CARD_TYPE_TUNESET } from './cardTypeService';
import { TUNESET_ABC_NAME } from './abcService';

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

/** A member lookup that failed for a reason worth telling apart: TheSession
 *  answers 410 for an account that existed and was removed, and 404 for one
 *  that never did. "This member is gone" and "no such member" send the user to
 *  different next steps, so they must not collapse into one message. */
export class MemberUnavailableError extends Error {
  constructor(public readonly reason: 'gone' | 'notFound') {
    super(reason);
    this.name = 'MemberUnavailableError';
  }
}

/** The member's own page, which is the cheapest possible first request: it
 *  carries the name AND the size of both collections, so a caller knows before
 *  fetching anything whether there is a tunebook or a set list to page through
 *  at all — member 1 has 539 sets across 54 pages, and 54 requests fired on a
 *  mere selection would be indefensible. */
export async function fetchMemberInfo(memberId: number): Promise<{ name: string; tunebook: number; sets: number }> {
  const res = await fetch(`${BASE}/members/${memberId}?format=json`);
  if (res.status === 410) throw new MemberUnavailableError('gone');
  if (res.status === 404) throw new MemberUnavailableError('notFound');
  if (!res.ok) throw new Error(`TheSession member fetch failed: ${res.status}`);
  const data = (await res.json()) as { name?: string; tunebook?: number; sets?: number };
  return {
    name: data.name ?? `Member ${memberId}`,
    tunebook: data.tunebook ?? 0,
    sets: data.sets ?? 0,
  };
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
    // Anything fetched from a tune database is a tune, by construction. Set at
    // the source so every path that creates one — the import screens, the
    // trending module, the session analyser's "add to library", the card
    // page's migrate action — agrees without each having to remember.
    type: CARD_TYPE_TUNE,
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

/** Turns an already-imported card into the TheSession version of the same
 *  tune, in place: everything the source owns — name, tags, notes, score,
 *  importance, type and `externalId` — comes from `tune`, while `id` and
 *  `guid` stay, so decks, review history and every reference to this card
 *  survive the change of source.
 *
 *  In place rather than by replacement (`s.cards[id] = …`) because the bulk
 *  runner hands fields a card, not the map it lives in; the wipe-then-assign
 *  is what makes it equivalent — an IrishTuneInfo-only field left behind would
 *  be a leftover of a source this card no longer has. */
export function applyTheSessionMigration(card: Card, tune: TuneResult): void {
  const fetched = tuneResultToCard(tune);
  const { id, guid } = card;
  for (const key of Object.keys(card)) delete (card as unknown as Record<string, unknown>)[key];
  Object.assign(card, fetched, { id, guid });
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

// ── Sets ──────────────────────────────────────────────────────────────────────
// A TheSession "set" is a member's ordered list of SETTINGS — specific versions
// of tunes, not tunes — and it is not addressable on its own: /sets/{id} is a
// 404, only /members/{memberId}/sets/{id} resolves. There is no global search
// either, so sets are always discovered through the member who wrote them,
// exactly like a tunebook.

export interface SetSetting {
  /** TheSession setting id — which VERSION of the tune this set plays. */
  id: number;
  /** The tune's id. Carried nowhere but inside `url`, hence the parse. */
  tuneId: number;
  name: string;
  type: string;
  key: string;
}

export interface SetResult {
  id: number;
  memberId: number;
  name: string;
  tags: string[];
  settings: SetSetting[];
}

interface RawSetSetting { id: number; name: string; url: string; type?: string; key?: string }
interface RawSet { id: number; name: string; tags?: string[]; member?: { id: number }; settings?: RawSetSetting[] }
interface RawMemberSetsResponse { pages?: number; total?: number; sets?: RawSet[] }

/** "https://thesession.org/tunes/1633#setting46304" → 1633. The tune id appears
 *  in no field of its own, so a set is unusable without this. */
function tuneIdFromSettingUrl(url: string): number | null {
  const m = /\/tunes\/(\d+)/.exec(url ?? '');
  return m ? parseInt(m[1]!, 10) : null;
}

function toSetResult(raw: RawSet, memberId: number): SetResult {
  const settings: SetSetting[] = [];
  for (const s of raw.settings ?? []) {
    const tuneId = tuneIdFromSettingUrl(s.url);
    // A setting we cannot trace back to a tune is dropped rather than faked:
    // the set is still usable, just shorter, and nothing points at a wrong tune.
    if (tuneId === null) continue;
    settings.push({ id: s.id, tuneId, name: s.name, type: s.type ?? '', key: s.key ?? '' });
  }
  return {
    id: raw.id,
    memberId: raw.member?.id ?? memberId,
    name: raw.name,
    tags: raw.tags ?? [],
    settings,
  };
}

/** Every set a member has published, paginated the same way their tunebook is. */
export async function fetchMemberSets(
  memberId: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<SetResult[]> {
  const first = await fetch(`${BASE}/members/${memberId}/sets?format=json`);
  if (!first.ok) throw new Error(`TheSession sets fetch failed: ${first.status}`);
  const firstData = (await first.json()) as RawMemberSetsResponse;
  const pages = firstData.pages ?? 1;
  const out = (firstData.sets ?? []).map(s => toSetResult(s, memberId));
  onProgress?.(1, pages);

  for (let page = 2; page <= pages; page++) {
    const res = await fetch(`${BASE}/members/${memberId}/sets?format=json&page=${page}`);
    if (!res.ok) throw new Error(`TheSession sets page ${page} failed: ${res.status}`);
    const data = (await res.json()) as RawMemberSetsResponse;
    out.push(...(data.sets ?? []).map(s => toSetResult(s, memberId)));
    onProgress?.(page, pages);
  }
  return out;
}

/** The identity of a set, and the only externalId shape sets ever take.
 *
 *  The member is part of it because the set id alone cannot rebuild the URL —
 *  /sets/{id} is a 404. A dash, not a second colon: `externalSourceLink` splits
 *  on the FIRST colon, and several places test `startsWith('thesession:')` and
 *  then parseInt the rest, which `thesession:set:…` would pass and then fail on.
 *  The dash form is correctly excluded from those tune-only paths. */
export function setExternalId(memberId: number, setId: number): string {
  return `thesession-set:${memberId}-${setId}`;
}

/** Records which setting of a tune this card should open on, by TheSession
 *  setting id rather than by position.
 *
 *  `preferredIndex` is a position in the merged ABC file, whose blocks follow
 *  `tune.settings` — an order TheSession can change under us — so the id has to
 *  be resolved against the settings we just fetched, never assumed. A single
 *  setting produces one un-merged attachment per setting, where the notion of
 *  a preferred index has nothing to choose between. */
function applyPreferredSetting(card: Card, tune: TuneResult, settingId: number): void {
  if (tune.settings.length < 2) return;
  const index = tune.settings.findIndex(s => s.id === settingId);
  if (index === -1) return;
  const abc = card.content.attachments.find(a => a.type === 'file');
  if (abc && abc.type === 'file') abc.preferredIndex = index;
}

/** Turns one TheSession set into the cards Cadence needs for it, WITHOUT
 *  touching app state — the caller decides how to apply the result, which is
 *  what lets the import screen and the card page's "refresh" action share this.
 *
 *  Missing tunes are fetched and created with the set's own setting starred:
 *  the set names a specific version, and dropping that would show the reader
 *  the most popular setting instead of the one this set actually plays. A tune
 *  already in the library is reused untouched — its starred setting is the
 *  user's own choice and no import gets to overwrite it.
 *
 *  `existing` should be the live cards map; when it already holds this set, its
 *  id and guid are kept so decks, review history and references stay attached.
 *
 *  `defaultRepeat` is required rather than defaulted here: TheSession records
 *  no repeats at all, so the number is entirely the reader's convention, and a
 *  silent fallback in this file is exactly how one import path would end up
 *  disagreeing with the others. Callers read it from the user
 *  (abcService's defaultTuneRepeat). */
export async function buildSetCards(
  set: SetResult,
  existing: Record<string, Card>,
  defaultRepeat: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ setCard: Card; newTunes: Card[] }> {
  const newTunes: Card[] = [];
  const byTuneId = new Map<number, Card>();

  for (let i = 0; i < set.settings.length; i++) {
    const setting = set.settings[i]!;
    onProgress?.(i, set.settings.length);
    // A tune listed twice in one set is fetched once.
    if (byTuneId.has(setting.tuneId)) continue;
    const already = findByExternalId(`thesession:${setting.tuneId}`, existing);
    if (already) { byTuneId.set(setting.tuneId, already); continue; }
    const tune = await fetchTuneForBatch(setting.tuneId, setting.name);
    const card = tuneResultToCard(tune);
    applyPreferredSetting(card, tune, setting.id);
    newTunes.push(card);
    byTuneId.set(setting.tuneId, card);
  }
  onProgress?.(set.settings.length, set.settings.length);

  const externalId = setExternalId(set.memberId, set.id);
  const previous = findByExternalId(externalId, existing);

  // What a refresh must NOT trample: how many times the user decided each tune
  // goes round. TheSession says which tunes are in the set; how they are played
  // is the user's own reading of it.
  const keptRepeats = new Map((previous?.tunes ?? []).map(ref => [ref.id, ref.repeat]));

  const tunes = set.settings
    .map(s => byTuneId.get(s.tuneId))
    .filter((c): c is Card => !!c)
    .map(c => ({
      id: c.id, guid: c.guid, externalId: c.externalId, title: c.name,
      repeat: keptRepeats.get(c.id) ?? defaultRepeat,
    }));

  const setCard: Card = {
    id: previous?.id ?? generateId(),
    guid: previous?.guid ?? generateId(),
    // Replaced on the first normalisation by the tunes joined with " / " —
    // computedName is on, so this is only what it is called until then.
    name: set.name,
    defaultImportance: previous?.defaultImportance ?? 1,
    tags: [...new Set(['TheSession', ...set.tags, ...(previous?.tags ?? [])])],
    type: CARD_TYPE_TUNESET,
    computedName: previous ? previous.computedName : true,
    tunes,
    externalId,
    // A refresh keeps whatever the user has attached or written; only the tune
    // list is TheSession's to dictate. A NEW set comes with its fused score
    // already attached — it is the point of importing a set, and nobody should
    // have to go and ask for it. Deliberately not re-added on a refresh:
    // removing it is a choice, and a refresh has no business undoing it.
    content: previous?.content ?? {
      notes: '',
      attachments: [{
        type: 'file', name: TUNESET_ABC_NAME, mimeType: 'text/vnd.abc',
        data: '', generatedBy: 'tuneset',
      }],
    },
  };
  return { setCard, newTunes };
}

/** One set, by the pair that addresses it. Same payload as a listing entry,
 *  plus each setting's ABC — which Cadence does not use, taking each tune's own
 *  card as the source of notation instead. */
export async function fetchSet(memberId: number, setId: number): Promise<SetResult> {
  const res = await fetch(`${BASE}/members/${memberId}/sets/${setId}?format=json`);
  if (!res.ok) throw new Error(`TheSession set fetch failed: ${res.status}`);
  return toSetResult((await res.json()) as RawSet, memberId);
}

/** "thesession-set:1-147730" → { memberId: 1, setId: 147730 }, or null. */
export function parseSetExternalId(externalId: string | undefined): { memberId: number; setId: number } | null {
  const prefix = 'thesession-set:';
  if (!externalId?.startsWith(prefix)) return null;
  const [member, set] = externalId.slice(prefix.length).split('-');
  const memberId = parseInt(member ?? '', 10);
  const setId = parseInt(set ?? '', 10);
  return isNaN(memberId) || isNaN(setId) ? null : { memberId, setId };
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────
// A member's bookmarks come back as an activity stream — a different shape from
// the tunebook and the set list — and a bookmark can point at several kinds of
// thing. Only "setting" concerns us: it names a specific version of a tune,
// which is exactly what a tune card can star.
//
// Two limits of this endpoint shape the code below. It carries NO `pages` or
// `total`, so paging stops on the first empty page rather than at a known
// count; and the member page has no bookmark counter either (its `settings`
// field counts settings the member SUBMITTED), so the size is only known once
// the whole thing has been read.

export interface BookmarkedSetting {
  tuneId: number;
  settingId: number;
  name: string;
}

interface RawActivityObject { url?: string; objectType?: string; id?: string; displayName?: string }
interface RawBookmarkItem { object?: RawActivityObject; target?: RawActivityObject }
interface RawBookmarksResponse { items?: RawBookmarkItem[] }

/** "settings:thesession:41297" → 41297, with the URL fragment as a fallback. */
function settingIdFromBookmark(object: RawActivityObject): number | null {
  const fromId = /(?:^|:)(\d+)$/.exec(object.id ?? '');
  if (fromId) return parseInt(fromId[1]!, 10);
  const fromUrl = /#setting(\d+)/.exec(object.url ?? '');
  return fromUrl ? parseInt(fromUrl[1]!, 10) : null;
}

function toBookmarkedSetting(item: RawBookmarkItem): BookmarkedSetting | null {
  if (item.object?.objectType !== 'setting') return null;
  // The tune is named twice — as the bookmark's `target`, and inside the
  // setting's own URL. Prefer the target, fall back to the URL.
  const tuneId = tuneIdFromSettingUrl(item.target?.url ?? '') ?? tuneIdFromSettingUrl(item.object.url ?? '');
  const settingId = settingIdFromBookmark(item.object);
  if (tuneId === null || settingId === null) return null;
  return { tuneId, settingId, name: item.object.displayName ?? item.target?.displayName ?? '' };
}

/** How many bookmarks to ask for per request. The endpoint honours `perpage`,
 *  which turns member 1's 362 bookmarks from 37 requests into 8. */
const BOOKMARKS_PER_PAGE = 50;

/** Every setting a member has bookmarked, oldest page last.
 *
 *  Paging stops on the first SHORT page — a page returning fewer than it was
 *  asked for is the last one — so a complete read costs no extra empty
 *  request. This is the only termination available: the endpoint reports
 *  neither `pages` nor `total`, and the member page has no bookmark counter to
 *  divide either (verified against member 1, whose 362 bookmarks match none of
 *  its figures; `settings` counts settings SUBMITTED, not bookmarked).
 *
 *  A `bookmarks` field HAS been requested from TheSession's admin (2026-09-03).
 *  If it appears, read it in fetchMemberInfo and this becomes a known number of
 *  pages — ceil(n / BOOKMARKS_PER_PAGE) — which buys the preview line the other
 *  two tabs have and turns the progress count into a real percentage. The short
 *  page stop below stays correct either way, so nothing here has to be undone.
 *
 *  `maxPages` is a guard, not a limit anyone should hit: without a total to
 *  page towards, a malformed response that never runs short would otherwise
 *  loop for ever. */
export async function fetchMemberBookmarks(
  memberId: number,
  onProgress?: (loaded: number, page: number) => void,
  maxPages = 200,
): Promise<BookmarkedSetting[]> {
  const out: BookmarkedSetting[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(`${BASE}/members/${memberId}/bookmarks?format=json&perpage=${BOOKMARKS_PER_PAGE}&page=${page}`);
    if (res.status === 410) throw new MemberUnavailableError('gone');
    if (res.status === 404) throw new MemberUnavailableError('notFound');
    if (!res.ok) throw new Error(`TheSession bookmarks fetch failed: ${res.status}`);
    const items = ((await res.json()) as RawBookmarksResponse).items ?? [];
    if (items.length === 0) break;
    for (const item of items) {
      const bookmark = toBookmarkedSetting(item);
      // Anything that is not a bookmarked setting — a bookmarked recording,
      // event, discussion — is simply not ours to import.
      if (!bookmark) continue;
      // One card per tune: a member who bookmarked two settings of the same
      // tune gets the first, the card having only one starred version.
      if (seen.has(bookmark.tuneId)) continue;
      seen.add(bookmark.tuneId);
      out.push(bookmark);
    }
    onProgress?.(out.length, page);
    // Short page = last page. Saves the extra request an empty-page stop needs.
    if (items.length < BOOKMARKS_PER_PAGE) break;
  }
  return out;
}

/** Fetches a tune and builds its card with one specific setting starred —
 *  the rule shared by set import, set refresh and bookmark import. */
export async function buildTuneCardWithSetting(bookmark: BookmarkedSetting): Promise<Card> {
  const tune = await fetchTuneForBatch(bookmark.tuneId, bookmark.name || undefined);
  const card = tuneResultToCard(tune);
  applyPreferredSetting(card, tune, bookmark.settingId);
  return card;
}
