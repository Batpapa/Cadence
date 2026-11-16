// ── The page's side of the cards' index (cardIndex.ts) ───────────────────────
// What the recognition worker cannot do itself: read the cards. Here the tune
// cards' ABC — attached, kept out of the state, or linked — is gathered for a
// recognition, and a card's version is read back for the views (its score,
// meter, key), by the ids cardIndex.ts defines.
// Installed by the app (main.ts): the standalone pages and the TheSession
// widget have no cards and never install it.

import type { AppState, Card, EmbedEntry, FileAttachment } from '../../types';
import { cardScoreIndex, decodeAbc, isAbcFile, isAbcLink, parseAbcBlock, splitAbcTunes } from '../../services/abcService';
import { attachmentBlob } from '../../services/attachmentStore';
import { fetchAbcLink, peekAbcLink } from '../../services/abcLink';
import { kvGet, kvSet } from '../db';
import { isTune } from '../../services/cardTypeService';
import { abcVersionHash, cardGuidOf, cardTuneId, cardVersionHashOf, type CardIndexTune, type CardIndexVersion } from './cardIndex';
import { setCardSettingResolver, type SettingAbcMeta } from './indexStore';
import { setRecognitionSources } from '../recognitionClient';
import { recognitionIndexesOf, recognitionPlan } from './recognitionIndexes';
import { sessionsOf } from '../detections';

/** "Dmaj", "Edor", "Am", "G" (an ABC `K:`) → "Dmajor", "Edorian", "Aminor",
 *  "Gmajor", as the index spells modes (keyName.ts reads that spelling). What
 *  it cannot read is passed on as it came. */
export function abcKeyToMode(key: string): string {
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(key.trim());
  if (!m) return key;
  const word = m[3]!.toLowerCase();
  const modes: [string, string][] = [
    ['maj', 'major'], ['ion', 'major'], ['min', 'minor'], ['aeo', 'minor'], ['dor', 'dorian'],
    ['mix', 'mixolydian'], ['lyd', 'lydian'], ['phr', 'phrygian'], ['loc', 'locrian'],
  ];
  const mode = word === '' ? 'major' : word === 'm' ? 'minor' : modes.find(([p]) => word.startsWith(p))?.[1];
  return mode ? `${m[1]}${m[2]}${mode}` : key;
}

/** An ABC `M:` as the index writes meters: "C" is 4/4, "C|" 2/2, nothing 4/4
 *  (abc2midi's own default). */
function meterOf(field: string): string {
  if (field === 'C') return '4/4';
  if (field === 'C|') return '2/2';
  return /^\d+\/\d+$/.test(field) ? field : '4/4';
}

/** The tune type a card says: its `R:` first, else a `type::` tag. */
function danceOf(rhythm: string, card: Card): string {
  if (rhythm) return rhythm.toLowerCase();
  const tag = card.tags.find(tg => tg.toLowerCase().startsWith('type::'));
  return tag ? tag.slice('type::'.length).toLowerCase() : '';
}

/** Where a card's ABC is: a file attached (in the state, or kept out of it), or
 *  a link to an `.abc` (abcLink.ts). A set's fused score is not one: it is
 *  derived from other cards, and a tuneset is not a tune. */
type AbcSource = { kind: 'file'; file: FileAttachment } | { kind: 'link'; link: EmbedEntry };

function abcSources(card: Card): AbcSource[] {
  return (card.content?.attachments ?? []).flatMap((a): AbcSource[] => {
    if (a.type === 'file' && isAbcFile(a) && a.generatedBy !== 'tuneset') return [{ kind: 'file', file: a }];
    if (isAbcLink(a)) return [{ kind: 'link', link: a }];
    return [];
  });
}

/** A version of a card, its ABC as it is in the file, by its id's hash. */
const versionsByHash = new Map<string, { abc: string; card: Card }>();

// ── Linked scores (the user, 2026-11-16) ──
// Fetched when a recognition starts, all at once, each given LINK_TIMEOUT_MS —
// past it, the link sits that recognition out rather than holding the start.
// The last text each link gave is kept on this device (KV_LINK_ABC, never
// synced, the links still on a tune card only): a live session is often
// offline, and that is when recognising matters most. Read in its place when
// the link cannot be had; the link stays the source whenever it answers.
const LINK_TIMEOUT_MS = 4000;
const KV_LINK_ABC = 'cardLinkAbc';

/** At most this many files read at once: a device that holds none of the
 *  externalised ABC yet would otherwise ask Drive for hundreds together. */
const READS_AT_ONCE = 8;

async function eachLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** An ABC file's text: in the state, or wherever attachmentStore keeps it
 *  (this device, then Drive — never asking for a token). Null if neither. */
async function fileText(f: FileAttachment): Promise<string | null> {
  if (!f.external) {
    try { return decodeAbc(f); } catch { return null; }
  }
  try { return await (await attachmentBlob(f, false)).text(); } catch { return null; }
}

/** A link's text, fetched now (within LINK_TIMEOUT_MS), else the last one it
 *  gave on this device (`kept`). What is used goes into `seen`, the links'
 *  record as it should now be kept. */
async function linkText(link: EmbedEntry, kept: Record<string, string>, seen: Record<string, string>): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_TIMEOUT_MS);
  try {
    const text = decodeAbc(await fetchAbcLink(link, ctrl.signal));
    seen[link.url] = text;
    return text;
  } catch {
    const last = kept[link.url];
    if (last === undefined) return null;
    seen[link.url] = last;
    return last;
  } finally {
    clearTimeout(timer);
  }
}

const sourceText = (s: AbcSource, kept: Record<string, string>, seen: Record<string, string>) =>
  (s.kind === 'file' ? fileText(s.file) : linkText(s.link, kept, seen));

/** Synchronously: a file in the state, or a link this visit has already
 *  fetched. Null where only a fetch would tell. */
function sourceTextNow(s: AbcSource): string | null {
  const entry = s.kind === 'file' ? (s.file.external ? null : s.file) : peekAbcLink(s.link.url);
  if (!entry) return null;
  try { return decodeAbc(entry); } catch { return null; }
}

const keptLinks = async () => (await kvGet<Record<string, string>>(KV_LINK_ABC).catch(() => undefined)) ?? {};

function versionsOf(text: string, card: Card): CardIndexVersion[] {
  const out: CardIndexVersion[] = [];
  for (const abc of splitAbcTunes(text)) {
    const block = parseAbcBlock(abc);
    if (!block.music) continue;
    versionsByHash.set(abcVersionHash(abc), { abc, card });
    out.push({ abc, meter: meterOf(block.meter), mode: abcKeyToMode(block.key), dance: danceOf(block.rhythm, card) });
  }
  return out;
}

/** The TheSession tune a card is ("thesession:N"), else null. */
function theSessionTuneOf(card: Card): string | null {
  const ext = card.externalId;
  if (!ext?.startsWith('thesession:')) return null;
  const id = ext.slice('thesession:'.length);
  return /^\d+$/.test(id) ? id : null;
}

/** Every tune card's versions, for a recognition about to start. The reads go
 *  together (READS_AT_ONCE at a time), so the slowest — a Drive download, a
 *  link out of time — sets the wait, not their sum. */
export async function cardIndexTunes(cards: Record<string, Card>, onRead?: (done: number, total: number) => void): Promise<CardIndexTune[]> {
  const kept = await keptLinks();
  const seen: Record<string, string> = {};
  const reads = Object.values(cards).filter(isTune).flatMap(card => abcSources(card).map(source => ({ card, source })));
  let done = 0;
  onRead?.(0, reads.length);
  const texts = await eachLimited(reads, READS_AT_ONCE, async r => {
    const text = await sourceText(r.source, kept, seen);
    onRead?.(++done, reads.length);
    return text;
  });
  const byCard = new Map<Card, CardIndexVersion[]>();
  reads.forEach((r, i) => {
    const text = texts[i];
    if (!text) return;
    const list = byCard.get(r.card) ?? [];
    list.push(...versionsOf(text, r.card));
    byCard.set(r.card, list);
  });
  if (JSON.stringify(seen) !== JSON.stringify(kept)) await kvSet(KV_LINK_ABC, seen).catch(() => { /* a cache: the link is asked again */ });
  return [...byCard].filter(([, versions]) => versions.length > 0)
    .map(([card, versions]) => ({ guid: card.guid, theSessionTuneId: theSessionTuneOf(card), name: card.name, versions }));
}

function metaOf(abc: string, card: Card): SettingAbcMeta {
  const block = parseAbcBlock(abc);
  return {
    abc, meter: meterOf(block.meter), mode: abcKeyToMode(block.key), dance: danceOf(block.rhythm, card),
    tune_id: theSessionTuneOf(card) ?? cardTuneId(card.guid),
  };
}

/** The tune card a card setting id belongs to, or null (gone, or no longer a
 *  tune). */
function cardOfSetting(settingId: string, cards: Record<string, Card>): Card | null {
  const guid = cardGuidOf(settingId);
  const card = guid ? Object.values(cards).find(c => c.guid === guid) : undefined;
  return card && isTune(card) ? card : null;
}

/** The version a card setting id names, if it has been read: by the gathering
 *  for a recognition, or by an earlier lookup. */
function knownVersion(settingId: string, card: Card): SettingAbcMeta | null {
  const hash = cardVersionHashOf(settingId);
  const known = hash ? versionsByHash.get(hash) : undefined;
  return known && known.card.guid === card.guid ? metaOf(known.abc, card) : null;
}

/** The card's score — its first ABC, attached or linked, what the score
 *  button opens — as a source. */
function scoreSource(card: Card): AbcSource | null {
  const attachments = card.content?.attachments ?? [];
  const score = attachments[cardScoreIndex(attachments)];
  if (!score) return null;
  if (score.type === 'file') return { kind: 'file', file: score };
  return isAbcLink(score) ? { kind: 'link', link: score } : null;
}

/** The card's score as it is now, at its favourite version (a link has none:
 *  its first): what a version id shows once its ABC has been edited away. */
function currentScore(card: Card, score: AbcSource, text: string | null): SettingAbcMeta | null {
  const blocks = text ? splitAbcTunes(text) : [];
  if (!blocks.length) return null;
  const favourite = score.kind === 'file' ? score.file.preferredIndex ?? 0 : 0;
  return metaOf(blocks[Math.max(0, Math.min(blocks.length - 1, favourite))]!, card);
}

/** The version as an analysis received from elsewhere carries it
 *  (Analysis.cardVersions): what stands in for a card this device has not got,
 *  or no longer holds that version of. */
function carriedVersion(settingId: string, state: AppState): SettingAbcMeta | null {
  const abc = carriedVersions(state).get(settingId);
  if (!abc) return null;
  const block = parseAbcBlock(abc);
  const guid = cardGuidOf(settingId);
  return {
    abc, meter: meterOf(block.meter), mode: abcKeyToMode(block.key), dance: block.rhythm.toLowerCase(),
    tune_id: guid ? cardTuneId(guid) : settingId,
  };
}

/** Every carried version, gathered once per state: a list naming a tune per
 *  row asks for one per row, and every analysis would be read for each. */
let carried: { state: AppState; versions: Map<string, string> } | null = null;
function carriedVersions(state: AppState): Map<string, string> {
  if (carried?.state === state) return carried.versions;
  const versions = new Map<string, string>();
  for (const session of Object.values(sessionsOf(state))) {
    for (const [id, abc] of Object.entries(session.cardVersions ?? {})) if (!versions.has(id)) versions.set(id, abc);
  }
  carried = { state, versions };
  return versions;
}

/** Synchronously: the version read off the card (already, or now from what the
 *  page holds), else as a received analysis carries it, else the card's score
 *  as it is. Null where only a fetch would tell. */
function cardSettingMetaNow(settingId: string, state: AppState): SettingAbcMeta | null {
  const card = cardOfSetting(settingId, state.cards);
  if (card) {
    const known = knownVersion(settingId, card);
    if (known) return known;
    for (const s of abcSources(card)) {
      const text = sourceTextNow(s);
      if (text) versionsOf(text, card);
    }
    const found = knownVersion(settingId, card);
    if (found) return found;
  }
  const carried = carriedVersion(settingId, state);
  if (carried) return carried;
  const score = card ? scoreSource(card) : null;
  return card && score ? currentScore(card, score, sourceTextNow(score)) : null;
}

/** The same, reading a file kept out of the state or a link if it must. */
async function cardSettingMetaLoad(settingId: string, state: AppState): Promise<SettingAbcMeta | null> {
  const card = cardOfSetting(settingId, state.cards);
  const kept = card ? await keptLinks() : {};
  if (card) {
    const known = knownVersion(settingId, card);
    if (known) return known;
    const texts = await eachLimited(abcSources(card), READS_AT_ONCE, s => sourceText(s, kept, {}));
    for (const text of texts) if (text) versionsOf(text, card);
    const found = knownVersion(settingId, card);
    if (found) return found;
  }
  const carried = carriedVersion(settingId, state);
  if (carried) return carried;
  const score = card ? scoreSource(card) : null;
  return card && score ? currentScore(card, score, await sourceText(score, kept, {})) : null;
}

/** Wires the cards in: recognitions search the indexes the user chose, in
 *  their order (recognitionIndexes.ts), the tune cards' versions among them,
 *  and the views can read a card's version. The state is read at the moment
 *  of use. */
export function installCardRecognition(state: () => AppState): void {
  const cards = () => state().cards;
  setRecognitionSources(() => ({
    ...recognitionPlan(recognitionIndexesOf(state())),
    gatherCards: (onRead) => cardIndexTunes(cards(), onRead),
  }));
  setCardSettingResolver({
    now: (settingId) => cardSettingMetaNow(settingId, state()),
    load: (settingId) => cardSettingMetaLoad(settingId, state()),
  });
}
