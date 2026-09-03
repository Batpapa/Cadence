import type { AppState, Card, EmbedEntry } from '../types';
import { toDateStr, generateId, arrayBufferToBase64 } from '../utils';
import { SCHEMA_VERSION, stampTuneType } from './migration';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidBackup(data: unknown): data is Record<string, unknown> {
  if (!isRecord(data)) return false;
  // Old format: has users map + cards
  const isOldFormat = isRecord(data['users']) && isRecord(data['cards']);
  // New format: has cards + profiles directly (id may be absent — stripped on export)
  const isNewFormat = isRecord(data['cards']) && isRecord(data['profiles']);
  return isOldFormat || isNewFormat;
}

/** Full backup — all user data except id (id is device-local). */
export function exportBackup(user: AppState): void {
  const { id: _id, ...data } = user;
  download(JSON.stringify(data, null, 2), `cadence-backup-${toDateStr(new Date())}.cdb`);
}

/** Same format as exportBackup, for a stored safety-net snapshot: restoring
 *  one goes through the ordinary Settings → Backup → Import path, so no
 *  second restore machinery exists to drift out of sync with the first. */
export function exportSnapshotBackup(state: AppState, ts: number): void {
  const { id: _id, ...data } = state as AppState & { id?: string };
  download(JSON.stringify(data, null, 2), `cadence-snapshot-${toDateStr(new Date(ts))}.cdb`);
}

/** Serializes cards to CDC JSON string without downloading. */
export function cardPackageText(cards: Card[]): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, cards }, null, 2);
}

/** Card-only export — no history, no decks, no personal data. */
export function exportCards(cards: Card[]): void {
  download(cardPackageText(cards), `cadence-cards-${toDateStr(new Date())}.cdc`);
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
  } else if (raw['type'] === 'file') {
    if (typeof raw['data'] !== 'string' && typeof raw['text'] === 'string') {
      raw['data'] = arrayBufferToBase64(new TextEncoder().encode(raw['text']).buffer);
    }
    delete raw['text'];
    if (typeof raw['data'] !== 'string') raw['data'] = '';
    if (typeof raw['mimeType'] !== 'string') raw['mimeType'] = 'text/plain';
    if (typeof raw['name'] !== 'string') raw['name'] = 'file.txt';
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
  return parseCardPackageText(await file.text());
}

/** Same as `parseCardPackage`, for JSON pasted directly as text (e.g. an AI's
 *  chat reply) instead of a saved file. */
export function parseCardPackageFromText(text: string): Card[] {
  return parseCardPackageText(text);
}

export async function parseImport(file: File): Promise<Record<string, unknown>> {
  if (!file.name.endsWith('.cdb')) throw new Error('Expected a .cdb file');
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid file'); }
  if (!isValidBackup(data)) throw new Error('File is not a valid Cadence backup');
  return data;
}

/** CSV export — read-only, no reimport intended. */
export function exportCardsCSV(cards: Card[], user: AppState): void {
  const escape = (v: string): string => {
    const s = v.replace(/\n|\r\n?/g, '\\n');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = ['Name', 'Tags', 'Decks', 'Importance per deck', 'Notes', 'External links', 'Review count', 'Reviews'];
  const rows: string[][] = [headers];

  for (const card of cards) {
    const cardDecks = Object.values(user.decks).filter(d => d.entries.some(e => e.cardId === card.id));
    const deckNames = cardDecks.map(d => d.name);
    const deckImportances = cardDecks.map(d => {
      const entry = d.entries.find(e => e.cardId === card.id);
      return entry?.importance !== undefined ? String(entry.importance) : '';
    });
    const embeds = (card.content.attachments ?? [])
      .filter((a): a is { type: 'embed' } & EmbedEntry => a.type === 'embed')
      .map(a => a.url);
    const work = user.cardWorks[`${user.currentProfileId}:${card.id}`];
    const history = work?.history ?? [];
    const reviews = history.map(e => `${new Date(e.ts).toISOString().slice(0, 10)}:${e.rating}`);

    rows.push([
      card.name,
      (card.tags ?? []).join(';'),
      deckNames.join(';'),
      deckImportances.join(';'),
      card.content.notes,
      embeds.join(';'),
      String(history.length),
      reviews.join(';'),
    ]);
  }

  const csv = rows.map(row => row.map(escape).join(',')).join('\r\n');
  downloadRaw('﻿' + csv, `cadence-cards-${toDateStr(new Date())}.csv`, 'text/csv;charset=utf-8');
}

function download(json: string, filename: string): void {
  downloadRaw(json, filename, 'application/json');
}

function downloadRaw(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
