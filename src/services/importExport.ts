import type { AppState, Card, EmbedEntry } from '../types';
import { toDateStr, generateId } from '../utils';
import { SCHEMA_VERSION } from './migration';

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

/** Card-only export — no history, no decks, no personal data. */
export function exportCards(cards: Card[]): void {
  const pkg = { schemaVersion: SCHEMA_VERSION, cards };
  download(JSON.stringify(pkg, null, 2), `cadence-cards-${toDateStr(new Date())}.cdc`);
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
}

export async function parseCardPackage(file: File): Promise<Card[]> {
  if (!file.name.endsWith('.cdc')) throw new Error('Expected a .cdc file');
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid file'); }
  if (!isCardPackage(data)) throw new Error('File is not a valid card package');
  const from = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  migrateRawCards(data.cards, from);
  return data.cards as Card[];
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
      return entry?.importanceOverride !== undefined ? String(entry.importanceOverride) : '';
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
