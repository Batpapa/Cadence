import type { AppState, Attachment, Card, CardRef, SessionRating } from '../../types';
import { generateId, arrayBufferToBase64 } from '../../utils';
import { removeCards } from '../cardService';
import { isFolderDescendant, moveFolderToParent, moveDeckToParent } from '../deckService';
import { CARD_TYPES, applyCardType, isTune, isTuneset } from '../cardTypeService';
import { findSetsContaining } from '../cardRefService';
import { safeExternalUrl } from '../embedService';
import { typeFromUrl } from '../remoteFile';

// ── Smart edit: the operations (2026-10-11) ──────────────────────────────────
// What an external tool (a script, an AI) sends back is a LIST OF OPERATIONS,
// never the whole library rewritten: the data goes out as a view of the
// library, and what comes back transforms it. A rewritten document gets
// shortened or abridged — by an AI especially — and every card dropped would
// read as a deletion. Here, whatever is not named stays as it is, and a
// deletion is always an operation of its own.
//
// All or nothing, decided by the user: the batch is run first on a copy of the
// state ("Verify"), and the smallest invalid operation blocks the whole of it.
// The same function then runs on the real state, with the same ids for what it
// creates — `newIds`, drawn once — so what was checked is what lands.
//
// Pure: no network (tunes from TheSession are fetched beforehand, see
// fetchExternal.ts, and handed in through `fetched`), no store, no i18n — an
// error is a code and its parameters, which the screen puts into words.

const RATINGS: readonly SessionRating[] = ['again', 'hard', 'good', 'easy'];

/** One problem, on one operation (`op` is its 1-based position; 0 = the
 *  answer as a whole). */
export interface OpError {
  op: number;
  name?: string;
  code: string;
  params?: Record<string, string | number>;
}

type ChangeKind = 'card' | 'deck' | 'folder' | 'profile';

/** One line of the summary: what happened to one thing, all its operations
 *  together. */
interface Change {
  kind: ChangeKind;
  id: string;
  action: 'create' | 'update' | 'delete';
  name: string;
  /** Fields an update touched (field names of the operations). */
  fields: string[];
  /** Reviews that go with a deleted card or profile. */
  lostReviews?: number;
  /** Decks that go with a deleted folder. */
  lostDecks?: string[];
}

export interface Summary {
  changes: Change[];
  reviewsAdded: number;
  reviewsRemoved: number;
}

export interface ApplyContext {
  /** `new:…` id → the real id it gets. Drawn by `prepare`, reused as is. */
  newIds: Map<string, string>;
  /** Cards fetched from their source, by the `new:…` id of their createCard. */
  fetched: Map<string, Card>;
  now: number;
}

interface ApplyResult { errors: OpError[]; summary: Summary }

type Raw = Record<string, unknown>;
type Op = Raw & { op: string };

// ── Reading the answer ───────────────────────────────────────────────────────

/** The format of a list of operations, required in every one. The format may
 *  change: a list written for another version — a script kept since, an
 *  answer built on old instructions — is refused rather than misread. */
export const OPS_FORMAT = 'cadence-smart-ops-1';

/** The operations in what was pasted: a fenced ```json block if there is one
 *  (an AI often talks around it), else the outermost braces. */
export function parseAnswer(text: string): { ops: Op[] } | { error: OpError } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  let body = fenced ? fenced[1]! : text;
  if (!fenced) {
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a === -1 || b <= a) return { error: { op: 0, code: 'noJson' } };
    body = body.slice(a, b + 1);
  }
  let data: unknown;
  try { data = JSON.parse(body); } catch (e) {
    return { error: { op: 0, code: 'badJson', params: { message: e instanceof Error ? e.message : String(e) } } };
  }
  const format = (data as Raw | null)?.['format'];
  if (format === undefined) return { error: { op: 0, code: 'noFormat', params: { expected: OPS_FORMAT } } };
  if (format !== OPS_FORMAT) return { error: { op: 0, code: 'badFormat', params: { found: String(format), expected: OPS_FORMAT } } };
  const ops = (data as Raw | null)?.['operations'];
  if (!Array.isArray(ops)) return { error: { op: 0, code: 'noOperations' } };
  return { ops: ops as Op[] };
}

// ── The operations and their fields ──────────────────────────────────────────

const FIELDS: Record<string, readonly string[]> = {
  createProfile: ['id', 'name'],
  renameProfile: ['id', 'name'],
  deleteProfile: ['id'],
  createFolder: ['id', 'name', 'parentId'],
  updateFolder: ['id', 'name', 'parentId'],
  deleteFolder: ['id'],
  createDeck: ['id', 'name', 'folderId', 'favorite', 'cards'],
  updateDeck: ['id', 'name', 'folderId', 'favorite'],
  deleteDeck: ['id'],
  addToDeck: ['deckId', 'cards'],
  removeFromDeck: ['deckId', 'cardIds'],
  createCard: ['id', 'name', 'type', 'tags', 'aliases', 'defaultImportance', 'notes', 'externalId', 'preferredSetting',
    'tunes', 'computedName', 'attachments', 'decks'],
  updateCard: ['id', 'name', 'type', 'tags', 'aliases', 'defaultImportance', 'notes', 'tunes', 'computedName',
    'addAttachments', 'removeAttachments'],
  deleteCard: ['id'],
  addReviews: ['profileId', 'cardId', 'entries'],
  removeReviews: ['profileId', 'cardId', 'dates', 'all'],
};

const CREATES: Record<string, ChangeKind> = {
  createProfile: 'profile', createFolder: 'folder', createDeck: 'deck', createCard: 'card',
};

/** Thrown inside one operation, caught by the loop: the operation is
 *  abandoned and reported, the rest still checked. */
class Fail {
  constructor(readonly code: string, readonly params?: Record<string, string | number>) {}
}

/** Draws the real ids of everything the batch creates, and refuses a `new:`
 *  id given twice. Run once, at Verify; its map then serves both runs. An id
 *  that is not a `new:` one is left to its operation to refuse. */
export function prepare(ops: Op[]): { newIds: Map<string, string>; errors: OpError[] } {
  const newIds = new Map<string, string>();
  const errors: OpError[] = [];
  ops.forEach((op, i) => {
    if (!op || typeof op !== 'object' || !(op.op in CREATES) || !isNewId(op['id'])) return;
    const id = op['id'] as string;
    if (newIds.has(id)) errors.push({ op: i + 1, name: op.op, code: 'duplicateNewId', params: { id } });
    else newIds.set(id, generateId());
  });
  return { newIds, errors };
}

function isNewId(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('new:') && v.length > 4;
}

/** Runs the batch on `state`, in place. Every operation is checked against
 *  the state as the previous ones left it, which is what makes "create, then
 *  use" work and "use, then create" fail. */
export function applyOps(state: AppState, ops: Op[], ctx: ApplyContext): ApplyResult {
  const errors: OpError[] = [];
  const summary: Summary = { changes: [], reviewsAdded: 0, reviewsRemoved: 0 };
  const run = new Runner(state, ctx, summary);
  ops.forEach((op, i) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      errors.push({ op: i + 1, code: 'notObject' });
      return;
    }
    const name = typeof op.op === 'string' ? op.op : '';
    const allowed = FIELDS[name];
    if (!allowed) {
      errors.push({ op: i + 1, code: 'unknownOp', params: { name: String(op.op ?? '') } });
      return;
    }
    const extra = Object.keys(op).find(k => k !== 'op' && !allowed.includes(k));
    if (extra) {
      errors.push({ op: i + 1, name, code: 'unknownField', params: { field: extra } });
      return;
    }
    try {
      (run[name as keyof Runner] as (op: Op) => void).call(run, op);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      errors.push({ op: i + 1, name, code: e.code, params: e.params });
    }
  });
  return { errors, summary };
}

// ── Field readers ────────────────────────────────────────────────────────────

function str(op: Op, field: string): string {
  const v = op[field];
  if (typeof v !== 'string') throw new Fail(v === undefined ? 'missingField' : 'badField', { field });
  return v;
}

function name(op: Op, field = 'name'): string {
  const v = str(op, field).trim();
  if (!v) throw new Fail('emptyName');
  return v;
}

function optStr(op: Op, field: string): string | undefined {
  return op[field] === undefined ? undefined : str(op, field);
}

function strList(op: Op, field: string): string[] {
  const v = op[field];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Fail('badField', { field });
  return (v as string[]).map(s => s.trim()).filter(Boolean);
}

function bool(op: Op, field: string): boolean {
  if (typeof op[field] !== 'boolean') throw new Fail('badField', { field });
  return op[field] as boolean;
}

function positive(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Fail('badField', { field });
  return v;
}

function list(op: Op, field: string): unknown[] {
  if (!Array.isArray(op[field])) throw new Fail(op[field] === undefined ? 'missingField' : 'badField', { field });
  return op[field] as unknown[];
}

/** A date as the export writes it (ISO 8601), never later than now. */
function date(v: unknown, now: number): number {
  const ts = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(ts)) throw new Fail('badDate', { value: String(v) });
  if (ts > now) throw new Fail('futureDate', { value: String(v) });
  return ts;
}

function utf8Base64(text: string): string {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// ── The operations ───────────────────────────────────────────────────────────

class Runner {
  constructor(private s: AppState, private ctx: ApplyContext, private sum: Summary) {}

  // Resolution: a real id must exist; a `new:` one must have been created by an
  // EARLIER operation of the batch.
  private resolve(kind: ChangeKind, raw: unknown, field: string): string {
    if (typeof raw !== 'string' || !raw) throw new Fail(raw === undefined ? 'missingField' : 'badField', { field });
    const id = raw.startsWith('new:') ? this.ctx.newIds.get(raw) : raw;
    const exists = !!id && (
      kind === 'card' ? !!this.s.cards[id]
        : kind === 'deck' ? !!this.s.decks[id]
          : kind === 'folder' ? !!this.s.folders[id]
            : !!this.s.profiles[id]);
    if (!exists) throw new Fail(raw.startsWith('new:') ? 'notCreatedYet' : 'unknownId', { id: raw, kind });
    return id!;
  }

  private card(raw: unknown, field = 'id'): Card { return this.s.cards[this.resolve('card', raw, field)]!; }

  /** The real id of what a create operation makes. */
  private newId(op: Op): string {
    const id = isNewId(op['id']) ? this.ctx.newIds.get(op['id']) : undefined;
    if (!id) throw new Fail('newIdExpected');
    return id;
  }

  /** A folder, or the root for null / absent. */
  private parent(op: Op, field: string): string | null {
    return op[field] === undefined || op[field] === null ? null : this.resolve('folder', op[field], field);
  }

  private note(kind: ChangeKind, id: string, action: Change['action'], label: string, fields: string[] = []): Change {
    const prev = this.sum.changes.find(c => c.kind === kind && c.id === id);
    if (prev) {
      // A thing created then edited in the same batch stays "created"; one
      // edited then deleted becomes "deleted".
      if (action === 'delete') prev.action = 'delete';
      prev.name = label;
      for (const f of fields) if (!prev.fields.includes(f)) prev.fields.push(f);
      return prev;
    }
    const change: Change = { kind, id, action, name: label, fields: [...fields] };
    this.sum.changes.push(change);
    return change;
  }

  private reviewCount(match: (key: string) => boolean): number {
    let n = 0;
    for (const [key, w] of Object.entries(this.s.cardWorks)) if (match(key)) n += w.history.length;
    return n;
  }

  // ── Profiles ──

  createProfile(op: Op): void {
    const id = this.newId(op);
    const label = name(op);
    this.s.profiles[id] = { id, name: label };
    this.s.profileIds.push(id);
    this.note('profile', id, 'create', label);
  }

  renameProfile(op: Op): void {
    const id = this.resolve('profile', op['id'], 'id');
    const label = name(op);
    this.s.profiles[id]!.name = label;
    this.note('profile', id, 'update', label, ['name']);
  }

  deleteProfile(op: Op): void {
    const id = this.resolve('profile', op['id'], 'id');
    if (this.s.profileIds.length <= 1) throw new Fail('lastProfile');
    const lost = this.reviewCount(k => k.startsWith(`${id}:`));
    for (const key of Object.keys(this.s.cardWorks)) if (key.startsWith(`${id}:`)) delete this.s.cardWorks[key];
    const label = this.s.profiles[id]!.name;
    delete this.s.profiles[id];
    this.s.profileIds = this.s.profileIds.filter(p => p !== id);
    if (this.s.currentProfileId === id) this.s.currentProfileId = this.s.profileIds[0]!;
    this.note('profile', id, 'delete', label).lostReviews = lost;
  }

  // ── Folders ──

  createFolder(op: Op): void {
    const id = this.newId(op);
    const label = name(op);
    const parentId = this.parent(op, 'parentId');
    this.s.folders[id] = { id, name: label, folderIds: [], deckIds: [] };
    if (parentId) this.s.folders[parentId]!.folderIds.push(id); else this.s.rootFolderIds.push(id);
    this.note('folder', id, 'create', label);
  }

  updateFolder(op: Op): void {
    const id = this.resolve('folder', op['id'], 'id');
    const folder = this.s.folders[id]!;
    const fields: string[] = [];
    if (op['name'] !== undefined) { folder.name = name(op); fields.push('name'); }
    if ('parentId' in op) {
      const parentId = this.parent(op, 'parentId');
      if (parentId === id || (parentId && isFolderDescendant(this.s, id, parentId))) throw new Fail('folderCycle');
      moveFolderToParent(this.s, id, parentId);
      fields.push('parentId');
    }
    this.note('folder', id, 'update', folder.name, fields);
  }

  deleteFolder(op: Op): void {
    const id = this.resolve('folder', op['id'], 'id');
    const label = this.s.folders[id]!.name;
    const lostDecks: string[] = [];
    const drop = (fid: string) => {
      const f = this.s.folders[fid];
      if (!f) return;
      for (const sub of f.folderIds) drop(sub);
      for (const d of f.deckIds) {
        if (this.s.decks[d]) lostDecks.push(this.s.decks[d]!.name);
        delete this.s.decks[d];
      }
      delete this.s.folders[fid];
    };
    drop(id);
    this.s.rootFolderIds = this.s.rootFolderIds.filter(f => f !== id);
    for (const f of Object.values(this.s.folders)) f.folderIds = f.folderIds.filter(x => x !== id);
    this.note('folder', id, 'delete', label).lostDecks = lostDecks;
  }

  // ── Decks ──

  private addEntries(deckId: string, raw: unknown[]): void {
    const deck = this.s.decks[deckId]!;
    for (const item of raw) {
      if (!item || typeof item !== 'object') throw new Fail('badField', { field: 'cards' });
      const entry = item as Raw;
      const cardId = this.resolve('card', entry['cardId'], 'cardId');
      const importance = entry['importance'] === undefined ? undefined : positive(entry['importance'], 'importance');
      const existing = deck.entries.find(e => e.cardId === cardId);
      if (existing) { if (importance !== undefined) existing.importance = importance; }
      else deck.entries.push(importance === undefined ? { cardId } : { cardId, importance });
    }
  }

  createDeck(op: Op): void {
    const id = this.newId(op);
    const label = name(op);
    const folderId = this.parent(op, 'folderId');
    this.s.decks[id] = { id, name: label, entries: [] };
    if (op['favorite'] !== undefined && bool(op, 'favorite')) this.s.decks[id]!.favorite = true;
    moveDeckToParent(this.s, id, folderId);
    if (op['cards'] !== undefined) this.addEntries(id, list(op, 'cards'));
    this.note('deck', id, 'create', label);
  }

  updateDeck(op: Op): void {
    const id = this.resolve('deck', op['id'], 'id');
    const deck = this.s.decks[id]!;
    const fields: string[] = [];
    if (op['name'] !== undefined) { deck.name = name(op); fields.push('name'); }
    if (op['favorite'] !== undefined) {
      if (bool(op, 'favorite')) deck.favorite = true; else delete deck.favorite;
      fields.push('favorite');
    }
    if ('folderId' in op) { moveDeckToParent(this.s, id, this.parent(op, 'folderId')); fields.push('folderId'); }
    this.note('deck', id, 'update', deck.name, fields);
  }

  deleteDeck(op: Op): void {
    const id = this.resolve('deck', op['id'], 'id');
    const label = this.s.decks[id]!.name;
    delete this.s.decks[id];
    this.s.rootDeckIds = this.s.rootDeckIds.filter(d => d !== id);
    for (const f of Object.values(this.s.folders)) f.deckIds = f.deckIds.filter(d => d !== id);
    this.note('deck', id, 'delete', label);
  }

  addToDeck(op: Op): void {
    const id = this.resolve('deck', op['deckId'], 'deckId');
    this.addEntries(id, list(op, 'cards'));
    this.note('deck', id, 'update', this.s.decks[id]!.name, ['cards']);
  }

  removeFromDeck(op: Op): void {
    const id = this.resolve('deck', op['deckId'], 'deckId');
    const deck = this.s.decks[id]!;
    for (const raw of list(op, 'cardIds')) {
      const cardId = this.resolve('card', raw, 'cardIds');
      if (!deck.entries.some(e => e.cardId === cardId)) throw new Fail('notInDeck', { id: String(raw) });
      deck.entries = deck.entries.filter(e => e.cardId !== cardId);
    }
    this.note('deck', id, 'update', deck.name, ['cards']);
  }

  // ── Cards ──

  private ref(card: Card): CardRef {
    return { id: card.id, guid: card.guid, ...(card.externalId ? { externalId: card.externalId } : {}), title: card.name };
  }

  /** A set's tune list, every member a tune and not the set itself. */
  private tunes(card: Card, raw: unknown): CardRef[] {
    if (!Array.isArray(raw)) throw new Fail('badField', { field: 'tunes' });
    return raw.map(item => {
      if (!item || typeof item !== 'object') throw new Fail('badField', { field: 'tunes' });
      const entry = item as Raw;
      const tune = this.card(entry['cardId'], 'cardId');
      if (tune.id === card.id || !isTune(tune)) throw new Fail('notATune', { name: tune.name });
      const ref = this.ref(tune);
      if (entry['repeat'] !== undefined) {
        const n = entry['repeat'];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20) throw new Fail('badField', { field: 'repeat' });
        if (n > 1) ref.repeat = n;
      }
      return ref;
    });
  }

  private attachment(raw: unknown): Attachment {
    if (!raw || typeof raw !== 'object') throw new Fail('badField', { field: 'attachments' });
    const a = raw as Op;
    if (a['type'] === 'file') {
      const fileName = name(a, 'name');
      const hasText = typeof a['text'] === 'string';
      const hasB64 = typeof a['base64'] === 'string';
      if (hasText === hasB64) throw new Fail('textOrBase64');
      const b64 = hasB64 ? (a['base64'] as string).replace(/\s+/g, '') : '';
      if (hasB64 && !BASE64.test(b64)) throw new Fail('badBase64', { name: fileName });
      const mimeType = optStr(a, 'mimeType')?.trim()
        || typeFromUrl(`https://cadence.invalid/${encodeURIComponent(fileName)}`)
        || (hasText ? 'text/plain' : 'application/octet-stream');
      return { type: 'file', name: fileName, mimeType, data: hasText ? utf8Base64(a['text'] as string) : b64 };
    }
    if (a['type'] === 'embed') {
      const url = str(a, 'url').trim();
      if (!safeExternalUrl(url)) throw new Fail('badUrl', { url });
      const mode = a['mode'] === undefined ? 'embed' : a['mode'];
      if (mode !== 'embed' && mode !== 'link') throw new Fail('badField', { field: 'mode' });
      const title = optStr(a, 'title')?.trim();
      if (mode === 'link' && !title) throw new Fail('linkNeedsTitle', { url });
      return { type: 'embed', id: generateId(), url, mode, ...(title ? { title } : {}) };
    }
    if (a['type'] === 'card') return { type: 'card', ...this.ref(this.card(a['cardId'], 'cardId')) };
    throw new Fail('badField', { field: 'type' });
  }

  /** The fields createCard and updateCard share, written onto `card`. */
  private common(card: Card, op: Op, fields: string[]): void {
    if (op['type'] !== undefined) {
      const type = op['type'] === null ? '' : str(op, 'type');
      if (type && !(CARD_TYPES as readonly string[]).includes(type)) throw new Fail('badField', { field: 'type' });
      if (type !== 'tune' && findSetsContaining(card.id, this.s.cards).length > 0) throw new Fail('typeLocked', { name: card.name });
      applyCardType(card, type);
      fields.push('type');
    }
    if (op['tags'] !== undefined) { card.tags = [...new Set(strList(op, 'tags'))]; fields.push('tags'); }
    if (op['aliases'] !== undefined) {
      const aliases = [...new Set(strList(op, 'aliases'))];
      if (aliases.length) card.aliases = aliases; else delete card.aliases;
      fields.push('aliases');
    }
    if (op['defaultImportance'] !== undefined) {
      card.defaultImportance = positive(op['defaultImportance'], 'defaultImportance');
      fields.push('defaultImportance');
    }
    if (op['notes'] !== undefined) { card.content.notes = str(op, 'notes'); fields.push('notes'); }
    if (op['tunes'] !== undefined) {
      if (!isTuneset(card)) throw new Fail('tunesNotSet');
      card.tunes = this.tunes(card, op['tunes']);
      fields.push('tunes');
    }
    if (op['computedName'] !== undefined) {
      if (!isTuneset(card)) throw new Fail('computedNotSet');
      if (bool(op, 'computedName')) card.computedName = true; else delete card.computedName;
      fields.push('computedName');
    }
  }

  createCard(op: Op): void {
    const id = this.newId(op);
    const key = op['id'] as string;
    const externalId = optStr(op, 'externalId')?.trim();
    if (op['preferredSetting'] !== undefined && !externalId?.startsWith('thesession:')) {
      throw new Fail('badField', { field: 'preferredSetting' });
    }
    let card: Card;
    if (externalId) {
      if (!/^(thesession|irishtuneinfo):\d+$/.test(externalId)) throw new Fail('badField', { field: 'externalId' });
      const already = Object.values(this.s.cards).find(c => c.externalId === externalId);
      if (already) throw new Fail('duplicateExternal', { name: already.name });
      const fetched = this.ctx.fetched.get(key);
      if (!fetched) throw new Fail('notFetched', { id: externalId });
      card = structuredClone(fetched);
      card.id = id;
      card.guid = generateId();
      if (op['name'] !== undefined) card.name = name(op);
    } else {
      card = {
        id, guid: generateId(), name: name(op), defaultImportance: 1, tags: [],
        content: { notes: '', attachments: [] },
      };
    }
    // In the library from here, so that a set may list itself as… nothing,
    // and its own tunes resolve: `common` reads through the state.
    this.s.cards[id] = card;
    const fetchedTags = card.tags;
    this.common(card, op, []);
    // A fetched tune keeps its source's tags, the operation's are added to them.
    if (externalId && op['tags'] !== undefined) card.tags = [...new Set([...fetchedTags, ...card.tags])];
    if (op['attachments'] !== undefined) {
      card.content.attachments.push(...list(op, 'attachments').map(a => this.attachment(a)));
    }
    if (op['decks'] !== undefined) {
      for (const deckRaw of list(op, 'decks')) {
        const deckId = this.resolve('deck', deckRaw, 'decks');
        this.addEntries(deckId, [{ cardId: key }]);
      }
    }
    this.note('card', id, 'create', card.name);
  }

  updateCard(op: Op): void {
    const card = this.card(op['id']);
    const fields: string[] = [];
    if (op['name'] !== undefined) { card.name = name(op); fields.push('name'); }
    this.common(card, op, fields);
    if (op['removeAttachments'] !== undefined) {
      const atts = card.content.attachments;
      const doomed = list(op, 'removeAttachments').map(raw => {
        const r = (raw ?? {}) as Raw;
        const index = r['index'];
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= atts.length) {
          throw new Fail('attachmentIndex', { index: String(index) });
        }
        if (r['match'] !== matchOf(atts[index]!)) throw new Fail('attachmentMismatch', { index });
        return index;
      });
      card.content.attachments = atts.filter((_, i) => !doomed.includes(i));
      fields.push('removeAttachments');
    }
    if (op['addAttachments'] !== undefined) {
      card.content.attachments.push(...list(op, 'addAttachments').map(a => this.attachment(a)));
      fields.push('addAttachments');
    }
    this.note('card', card.id, 'update', card.name, fields);
  }

  deleteCard(op: Op): void {
    const card = this.card(op['id']);
    const lost = this.reviewCount(k => k.endsWith(`:${card.id}`));
    removeCards(this.s, [card.id]);
    this.note('card', card.id, 'delete', card.name).lostReviews = lost;
  }

  // ── Reviews ──

  private work(op: Op): { key: string; card: Card } {
    const profileId = this.resolve('profile', op['profileId'], 'profileId');
    const card = this.card(op['cardId'], 'cardId');
    return { key: `${profileId}:${card.id}`, card };
  }

  addReviews(op: Op): void {
    const { key, card } = this.work(op);
    const entries = list(op, 'entries');
    const work = this.s.cardWorks[key] ?? { profileId: key.slice(0, key.indexOf(':')), cardId: card.id, history: [] };
    for (const raw of entries) {
      if (!Array.isArray(raw) || raw.length !== 2) throw new Fail('badField', { field: 'entries' });
      const ts = date(raw[0], this.ctx.now);
      const rating = raw[1] as SessionRating;
      if (!RATINGS.includes(rating)) throw new Fail('badRating', { value: String(raw[1]) });
      if (work.history.some(h => h.ts === ts)) throw new Fail('reviewExists', { date: String(raw[0]) });
      work.history.push({ ts, rating });
    }
    work.history.sort((a, b) => a.ts - b.ts);
    this.s.cardWorks[key] = work;
    this.sum.reviewsAdded += entries.length;
  }

  removeReviews(op: Op): void {
    const { key } = this.work(op);
    const work = this.s.cardWorks[key];
    const all = op['all'] === undefined ? false : bool(op, 'all');
    if (all === (op['dates'] !== undefined)) throw new Fail('datesOrAll');
    if (all) {
      this.sum.reviewsRemoved += work?.history.length ?? 0;
      delete this.s.cardWorks[key];
      return;
    }
    for (const raw of list(op, 'dates')) {
      const ts = typeof raw === 'string' ? Date.parse(raw) : NaN;
      const at = Number.isNaN(ts) ? -1 : work?.history.findIndex(h => h.ts === ts) ?? -1;
      if (at === -1) throw new Fail('reviewMissing', { date: String(raw) });
      work!.history.splice(at, 1);
      this.sum.reviewsRemoved++;
    }
    if (work && work.history.length === 0) delete this.s.cardWorks[key];
  }
}

/** What an attachment is named by in the export, and must be named by again
 *  to be removed: a file's name, a link's URL, a card reference's card id. */
function matchOf(att: Attachment): string {
  return att.type === 'file' ? att.name : att.type === 'embed' ? att.url : att.id;
}

/** Whether the batch takes anything away — the screen marks those. */
export function hasDeletions(summary: Summary): boolean {
  return summary.reviewsRemoved > 0 || summary.changes.some(c => c.action === 'delete');
}

