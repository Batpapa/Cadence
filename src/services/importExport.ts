import type { AppState, Card } from '../types';
import { toDateStr, generateId } from '../utils';
import { arrayBufferToBase64, downloadTextFile, downloadCadenceFile } from './fileTransfer';
import { SCHEMA_VERSION, stampTuneType, settleImportTags } from './migration';
import { migrateClipTags } from './attachmentNames';
import { migrateAudioMimeTypes } from './audioSniff';
import { cardAliases } from './aliasService';
import { externalAttachmentBlobs, type ExportGate } from './attachmentStore';
import { sanitizeAudioPresets } from './audioPresets';
import { buildZipBlob, readZipBlob, isZipBlob, type ZipBlobEntry } from './zip';
import { buildBackup } from './fullBackup';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Backup — all user data except id (id is device-local) and the recordings:
 *  the small one of the two backup choices (fullBackup.ts, where the format
 *  lives — a zip since 2026-11-15).
 *
 *  Serialised compact, not indented (2026-09-10). Two-space indentation was
 *  measured at x2.04 on a realistic library — it doubled every backup, every
 *  snapshot and every shared card package for the benefit of a file nobody
 *  opens in a text editor. Anyone who does can run it through a prettifier. */
export async function exportBackup(user: AppState, gate: ExportGate): Promise<boolean> {
  const zip = await buildBackup(user, gate, false);
  if (!zip) return false;
  downloadCadenceFile(zip, `cadence-backup-${toDateStr(new Date())}.cdb`);
  // Launched, not finished: a browser never says when a download is done —
  // which is why the AI assistant asks the user to confirm it themselves.
  return true;
}

/** Same format as exportBackup, for a stored safety-net snapshot: restoring
 *  one goes through the ordinary Settings → Backup → Import path, so no
 *  second restore machinery exists to drift out of sync with the first. */
export async function exportSnapshotBackup(state: AppState, ts: number, gate: ExportGate): Promise<void> {
  const zip = await buildBackup(state, gate, false);
  if (zip) downloadCadenceFile(zip, `cadence-snapshot-${toDateStr(new Date(ts))}.cdb`);
}

// ── Card packages (.cdc) ─────────────────────────────────────────────────────
// A zip since 2026-11-15 (zip.ts, STORE): `cards.json`, and beside it
// `attachments/<external id>` for every externalised attachment — the layout
// of a backup (fullBackup.ts). Until then the bytes were put back INTO the
// JSON as base64: a third larger, and one string the size of everything.
//
// The cards written keep `external`, minus `driveFileId` for those whose bytes
// are in the archive: that id names a file in the exporter's Drive. An
// attachment the gate let through unresolved travels AS IT IS, `driveFileId`
// included — for anyone else it degrades to "no longer on Drive", which is
// true, where dropping the id would promise "not sent yet", a wait that never
// ends.
//
// JSON stays a .cdc too, and is read for good: it is what a person or an AI
// writes by hand (parseCardPackageFromText), and what was exported before.

const CDC_DATA_ENTRY = 'cards.json';
const CDC_ATTACH_DIR = 'attachments/';

/** The package of `cards`, without downloading it. Null if the gate refused
 *  an export missing some of its attachments. */
export async function cardPackageBlob(cards: Card[], gate: ExportGate): Promise<Blob | null> {
  const copy = structuredClone(cards);
  const { blobs, missing } = await externalAttachmentBlobs(copy);
  if (missing.length > 0 && !(await gate(missing))) return null;
  for (const card of copy) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type === 'file' && att.external && blobs.has(att.external.id)) delete att.external.driveFileId;
    }
  }
  const entries: ZipBlobEntry[] = [{ name: CDC_DATA_ENTRY, data: JSON.stringify({ schemaVersion: SCHEMA_VERSION, cards: copy }) }];
  for (const [extId, blob] of blobs) entries.push({ name: CDC_ATTACH_DIR + extId, data: blob });
  return buildZipBlob(entries);
}

/** Card-only export — no history, no decks, no personal data. */
export async function exportCards(cards: Card[], gate: ExportGate): Promise<void> {
  const zip = await cardPackageBlob(cards, gate);
  if (zip) downloadCadenceFile(zip, `cadence-cards-${toDateStr(new Date())}.cdc`);
}

/** The cards of an archived package, as the JSON reader expects them: the
 *  import takes files INLINE and decides itself, by the receiver's own rule,
 *  which go outside the blob (externaliseIncoming). So each archived file's
 *  bytes go back into its `data` — one attachment at a time, never one string
 *  for the lot. */
async function readCardPackageZip(file: Blob): Promise<unknown> {
  const items = await readZipBlob(file);
  const dataItem = items.find(i => i.name === CDC_DATA_ENTRY);
  if (!dataItem) throw new Error('File is not a valid card package');
  let data: unknown;
  try { data = JSON.parse(await dataItem.text()); } catch { throw new Error('Invalid file'); }
  if (!isCardPackage(data)) throw new Error('File is not a valid card package');
  const bytes = new Map(items.filter(i => i.name.startsWith(CDC_ATTACH_DIR)).map(i => [i.name.slice(CDC_ATTACH_DIR.length), i]));
  for (const raw of data.cards) {
    const content = isRecord(raw) ? raw['content'] : null;
    if (!isRecord(content) || !Array.isArray(content['attachments'])) continue;
    for (const att of content['attachments']) {
      if (!isRecord(att) || att['type'] !== 'file' || !isRecord(att['external'])) continue;
      const item = bytes.get(String(att['external']['id']));
      if (!item) continue;   // unresolved at export: travels as it is
      att['data'] = arrayBufferToBase64(await (await item.copy()).arrayBuffer());
      delete att['external'];
    }
  }
  return data;
}

function isCardPackage(data: unknown): data is { schemaVersion?: number; cards: unknown[] } {
  return isRecord(data) && Array.isArray(data['cards']);
}

function migrateRawCards(cards: unknown[], from: number): void {
  if (from < 2) {
    for (const raw of cards) {
      const content = (raw as Record<string, unknown>)['content'] as Record<string, unknown>;
      if (!content) continue;
      const files  = (content['files']  as Array<Record<string, unknown>>) ?? [];
      const embeds = (content['embeds'] as Array<Record<string, unknown>>) ?? [];
      if ('files' in content || 'embeds' in content) {
        content['attachments'] = [
          ...files.map(f => ({ type: 'file',  ...f })),
          ...embeds.map(e => ({ type: 'embed', ...e })),
        ];
        delete content['files'];
        delete content['embeds'];
      }
    }
  }
  if (from < 5) {
    for (const raw of cards) {
      const card = raw as Record<string, unknown>;
      if (!card['guid']) card['guid'] = generateId();
    }
  }
  if (from < 6) {
    for (const raw of cards) {
      const card = raw as Record<string, unknown>;
      if ('importance' in card && !('defaultImportance' in card)) {
        card['defaultImportance'] = card['importance'];
        delete card['importance'];
      }
    }
  }
  // Shares migration.ts's rule rather than restating it: a package exported
  // before card types existed must arrive typed, or its tunes would be
  // invisible to the tuneset editor on the receiving device.
  if (from < 7) {
    for (const raw of cards) stampTuneType(raw as Record<string, unknown>);
  }
  // Same function as migration.ts's V7 → V8, for the same reason: a package
  // exported before it must not bring clip tags back into attachment names.
  if (from < 8) {
    for (const raw of cards) migrateClipTags(raw as Record<string, unknown>);
  }
  // Same function as migration.ts's V8 → V9, for the same reason: a package
  // exported before it carries attachments typed from their extension, and its
  // audio would open in a <video> element on the receiving device too.
  if (from < 9) {
    for (const raw of cards) migrateAudioMimeTypes(raw as Record<string, unknown>);
  }
  // Same function as migration.ts's V9 → V10, for the same reason: a package
  // exported before 2026-11-09 carries the source's tag and type and key flat.
  if (from < 10) {
    for (const raw of cards) settleImportTags(raw as Record<string, unknown>);
  }
}

function isPlaceholderId(v: unknown): boolean {
  if (typeof v === 'number') return v < 0;
  if (typeof v === 'string') return /^-\d+$/.test(v);
  return false;
}

/** AI-crafted files can reference a sibling card within the same batch by
 *  giving it a small negative "id" (e.g. -1, -2…) — real ids (crypto.randomUUID())
 *  never start with "-", so a placeholder can never collide with or be mistaken
 *  for a genuine one (e.g. a card re-imported from an actual Cadence export).
 *  Replaces every placeholder card id with a real id/guid, then rewrites any
 *  "card" attachment pointing at that placeholder to the real id/guid. */
function resolvePlaceholderIds(cards: unknown[]): void {
  const idMap = new Map<string, { id: string; guid: string }>();
  for (const raw of cards) {
    if (!isRecord(raw) || !isPlaceholderId(raw['id'])) continue;
    const id = generateId();
    const guid = generateId();
    idMap.set(String(raw['id']), { id, guid });
    raw['id'] = id;
    raw['guid'] = guid;
  }
  if (idMap.size === 0) return;
  const remap = (ref: unknown) => {
    if (!isRecord(ref)) return;
    const target = idMap.get(String(ref['id']));
    if (target) { ref['id'] = target.id; ref['guid'] = target.guid; }
  };
  for (const raw of cards) {
    if (!isRecord(raw)) continue;
    const content = raw['content'];
    if (isRecord(content) && Array.isArray(content['attachments'])) {
      for (const att of content['attachments']) {
        if (isRecord(att) && att['type'] === 'card') remap(att);
      }
    }
    // A tuneset's tunes are references too, and a package that defines a set
    // alongside its tunes leans on placeholders exactly like an attachment
    // does — miss this and the set arrives with every tune unresolved.
    if (Array.isArray(raw['tunes'])) for (const ref of raw['tunes']) remap(ref);
  }
}

/** Accepts a plain-text "text" shorthand for file attachments (easier for a
 *  hand/AI-crafted file to produce than base64) and backfills whatever else
 *  is missing so every attachment type is safe to render. */
function sanitizeAttachment(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw['type'] === 'embed') {
    if (typeof raw['id'] !== 'string' || !raw['id']) raw['id'] = generateId();
    if (typeof raw['url'] !== 'string') raw['url'] = '';
    // Anything that is not one of the two known modes is dropped rather than
    // kept: linkMode() would read it as an embed anyway, and a stored value no
    // reader recognises is the sort of thing a later version mistakes for a
    // deliberate choice.
    if (raw['mode'] !== 'link' && raw['mode'] !== 'embed') delete raw['mode'];
    sanitizeAudioPresets(raw);
  } else if (raw['type'] === 'file') {
    if (typeof raw['data'] !== 'string' && typeof raw['text'] === 'string') {
      raw['data'] = arrayBufferToBase64(new TextEncoder().encode(raw['text']).buffer);
    }
    delete raw['text'];
    if (typeof raw['data'] !== 'string') raw['data'] = '';
    if (typeof raw['mimeType'] !== 'string') raw['mimeType'] = 'text/plain';
    if (typeof raw['name'] !== 'string') raw['name'] = 'file.txt';
    sanitizeAudioPresets(raw);
  } else if (raw['type'] === 'card') {
    sanitizeCardRef(raw);
  }
  return raw;
}

/** The three fields every card reference must carry, whatever role it plays —
 *  an attachment or one of a tuneset's tunes. `externalId` is left alone: it's
 *  optional, and an absent one simply skips that resolution step. */
function sanitizeCardRef(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw['id'] !== 'string') raw['id'] = '';
  if (typeof raw['guid'] !== 'string') raw['guid'] = '';
  if (typeof raw['title'] !== 'string') raw['title'] = '';
  // Optional, and only meaningful inside a set. Anything that is not a number
  // is dropped rather than coerced — clampRepeat already reads absent as one
  // pass, so there is nothing to guess.
  if ('repeat' in raw && typeof raw['repeat'] !== 'number') delete raw['repeat'];
  return raw;
}

/** Fills in safe defaults for any field a hand/AI-crafted card might omit —
 *  the app assumes every card has these (e.g. `card.tags.length` with no
 *  optional chaining), so a sparse file would otherwise crash the UI. */
function sanitizeCard(raw: unknown): Card {
  const card = raw as Record<string, unknown>;
  const content = isRecord(card['content']) ? card['content'] : {};
  // Defensive: "externalId" belongs at the top level, but an AI occasionally
  // nests it inside "content" instead (it visually sits next to "notes"/
  // "attachments" in the schema) — hoist it so the fetch step below still finds it.
  if (typeof card['externalId'] !== 'string' && typeof content['externalId'] === 'string') {
    card['externalId'] = content['externalId'];
  }
  delete content['externalId'];
  if (typeof card['id'] !== 'string' || !card['id']) card['id'] = generateId();
  if (typeof card['guid'] !== 'string' || !card['guid']) card['guid'] = generateId();
  if (typeof card['name'] !== 'string') card['name'] = '';
  if (typeof card['defaultImportance'] !== 'number') card['defaultImportance'] = 1;
  if (!Array.isArray(card['tags'])) card['tags'] = [];
  // `type` is an open string: anything unknown degrades to an ordinary card
  // (cardTypeService), so only the wrong SHAPE is worth rejecting here.
  if ('type' in card && typeof card['type'] !== 'string') delete card['type'];
  // Same defence for the auto-name flag: only a real `true` turns it on, so a
  // truthy string or number from a hand-written package cannot start rewriting
  // a card's name.
  if ('computedName' in card && card['computedName'] !== true) delete card['computedName'];
  // Aliases: strings only, blanks dropped, and an empty list written as no
  // list — the shape aliasService.ts keeps everywhere else.
  if ('aliases' in card) {
    const aliases = Array.isArray(card['aliases'])
      ? card['aliases'].filter((a): a is string => typeof a === 'string').map(a => a.trim()).filter(a => a !== '')
      : [];
    if (aliases.length > 0) card['aliases'] = aliases; else delete card['aliases'];
  }
  // A tuneset's tunes get the same defensive pass as its attachments — a
  // hand-written or AI-crafted package can put anything in here.
  if ('tunes' in card) {
    card['tunes'] = Array.isArray(card['tunes'])
      ? card['tunes'].filter(isRecord).map(sanitizeCardRef)
      : [];
  }
  if (typeof content['notes'] !== 'string') content['notes'] = '';
  content['attachments'] = Array.isArray(content['attachments']) ? content['attachments'].map(sanitizeAttachment) : [];
  card['content'] = content;
  return card as unknown as Card;
}

/** Fallback for "card" attachments still without a real id/guid after
 *  `resolvePlaceholderIds` (e.g. the AI didn't use a placeholder id) — matches
 *  against the other cards in the same batch by exact name instead. Cards
 *  already carrying real ids (e.g. re-imported from a genuine Cadence export) are untouched. */
function resolveLocalCardRefs(cards: Card[]): void {
  const byName = new Map<string, Card>();
  for (const c of cards) if (!byName.has(c.name)) byName.set(c.name, c);
  for (const c of cards) {
    // Both roles a reference plays, for the same reason: a set whose tunes were
    // named but not id'd must find them in its own batch.
    const refs = [...c.content.attachments.filter(a => a.type === 'card'), ...(c.tunes ?? [])];
    for (const ref of refs) {
      if (ref.id) continue;
      const target = byName.get(ref.title);
      if (target && target !== c) { ref.id = target.id; ref.guid = target.guid; }
    }
  }
}

/** Strips a leading/trailing markdown code fence (```` ```json ... ``` ````) —
 *  pasted AI output often keeps it even when only the block content was meant. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return match ? match[1]! : trimmed;
}

function parseCardPackageText(text: string): Card[] {
  let data: unknown;
  try { data = JSON.parse(stripCodeFence(text)); } catch { throw new Error('Invalid file'); }
  return parseCardPackageData(data);
}

function parseCardPackageData(data: unknown): Card[] {
  if (!isCardPackage(data)) throw new Error('File is not a valid card package');
  const from = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  migrateRawCards(data.cards, from);
  resolvePlaceholderIds(data.cards);
  const cards = data.cards.map(sanitizeCard);
  resolveLocalCardRefs(cards);
  typeSetMembers(cards);
  return cards;
}

/** A set may only contain tunes, so a card listed in some set's `tunes` within
 *  the same package is a tune — whatever the author remembered to write.
 *
 *  Only fills a MISSING type: an explicit one is the author's statement and is
 *  never overwritten, which also means a set mistakenly listed inside another
 *  set stays a set rather than being silently destroyed. Without this, an
 *  AI-written package that forgets `"type": "tune"` imports a set whose
 *  members can never be edited back in, since the picker only offers tunes. */
function typeSetMembers(cards: Card[]): void {
  const byId = new Map(cards.map(c => [c.id, c]));
  for (const c of cards) {
    if (c.type !== 'tuneset') continue;
    for (const ref of c.tunes ?? []) {
      const target = byId.get(ref.id);
      if (target && !target.type) target.type = 'tune';
    }
  }
}

export async function parseCardPackage(file: File): Promise<Card[]> {
  if (!file.name.endsWith('.cdc')) throw new Error('Expected a .cdc file');
  if (await isZipBlob(file)) return parseCardPackageData(await readCardPackageZip(file));
  return parseCardPackageText(await file.text());
}

/** Same as `parseCardPackage`, for JSON pasted directly as text (e.g. an AI's
 *  chat reply) instead of a saved file. */
export function parseCardPackageFromText(text: string): Card[] {
  return parseCardPackageText(text);
}

// ── Read-only card exports ───────────────────────────────────────────────────
// TXT and CSV carry the SAME fields, which is why they share `cardFacts` below
// rather than each reaching into the card themselves. Two independent readers
// drift the moment a field is added to one of them; one reader cannot.

interface CardFacts {
  name: string;
  aliases: string;
  type: string;
  tags: string;
  decks: string;
  importances: string;
  tunes: string;
  notes: string;
  reviewCount: string;
  reviews: string;
}

function cardFacts(card: Card, user: AppState): CardFacts {
  const cardDecks = Object.values(user.decks).filter(d => d.entries.some(e => e.cardId === card.id));
  const history = user.cardWorks[`${user.currentProfileId}:${card.id}`]?.history ?? [];
  return {
    name: card.name,
    aliases: cardAliases(card).join('; '),
    type: card.type ?? '',
    tags: (card.tags ?? []).join('; '),
    decks: cardDecks.map(d => d.name).join('; '),
    importances: cardDecks.map(d => {
      const entry = d.entries.find(e => e.cardId === card.id);
      return entry?.importance !== undefined ? String(entry.importance) : '';
    }).join('; '),
    // A set IS its list of members, so leaving this out exports a named empty
    // container. Same rendering in both files.
    tunes: (card.tunes ?? [])
      .map(ref => `${ref.title}${ref.repeat && ref.repeat > 1 ? ` ×${ref.repeat}` : ''}`)
      .join('; '),
    notes: card.content.notes,
    reviewCount: String(history.length),
    reviews: history.map(e => `${new Date(e.ts).toISOString().slice(0, 10)}:${e.rating}`).join('; '),
  };
}

/** RFC 4180-ish: quote only when needed, double the quotes inside, and flatten
 *  newlines rather than emitting a multi-line field. */
function csvEscape(v: string): string {
  const s = v.replace(/\n|\r\n?/g, '\\n');
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export — read-only, no reimport intended. */
export function exportCardsCSV(cards: Card[], user: AppState): void {
  const rows: string[][] = [
    ['Name', 'Aliases', 'Type', 'Tags', 'Decks', 'Importance per deck', 'Tunes', 'Notes', 'Review count', 'Reviews'],
  ];
  for (const card of cards) {
    const f = cardFacts(card, user);
    rows.push([f.name, f.aliases, f.type, f.tags, f.decks, f.importances, f.tunes, f.notes, f.reviewCount, f.reviews]);
  }
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  // BOM: without it Excel reads the file as the system codepage and mangles
  // every accented card name.
  downloadTextFile('﻿' + csv, `cadence-cards-${toDateStr(new Date())}.csv`, 'text/csv;charset=utf-8');
}

/** Plain-text export — the same fields as the CSV, laid out to be read rather
 *  than parsed. Labels are English literals like the CSV's headers: an exported
 *  file travels outside the app and is usually read somewhere other than the
 *  exporting device's locale. */
export function cardsTextReport(cards: Card[], user: AppState): string {
  const out: string[] = [
    `Cadence — cards export — ${toDateStr(new Date())}`,
    `${cards.length} card${cards.length === 1 ? '' : 's'}`,
  ];

  for (const card of cards) {
    const f = cardFacts(card, user);
    out.push('', '─'.repeat(60), f.name || '(untitled)');
    // Only lines that carry something: a file full of empty "Tags:" rows is
    // harder to skim than one that simply omits them.
    const field = (label: string, value: string) => { if (value) out.push(`  ${(label + ':').padEnd(10)}${value}`); };
    field('Aliases', f.aliases);
    field('Type', f.type);
    field('Tags', f.tags);
    // The CSV keeps decks and their importances in two columns because a
    // spreadsheet wants them separable; read by a human they belong together.
    field('Decks', f.decks
      ? f.decks.split('; ').map((d, i) => {
        const imp = f.importances.split('; ')[i];
        return imp ? `${d} (importance ${imp})` : d;
      }).join('; ')
      : '');
    field('Tunes', f.tunes);
    field('Reviews', f.reviewCount === '0' ? '' : `${f.reviewCount} — ${f.reviews}`);
    if (f.notes.trim()) {
      out.push('  Notes:');
      for (const line of f.notes.split(/\r?\n/)) out.push(`    ${line}`);
    }
  }

  return out.join('\r\n');
}

/** The same report, as a downloaded file. */
export function exportCardsTXT(cards: Card[], user: AppState): void {
  downloadTextFile(cardsTextReport(cards, user),
    `cadence-cards-${toDateStr(new Date())}.txt`, 'text/plain;charset=utf-8');
}
