import type { AppState, Card } from '../types';
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

function download(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
