import type { AppState, Card } from '../types';
import { toDateStr } from '../utils';
import { migrateState, SCHEMA_VERSION } from './migration';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAppState(data: unknown): data is AppState {
  if (!isRecord(data)) return false;
  return (
    isRecord(data['users']) &&
    isRecord(data['cards']) &&
    isRecord(data['decks']) &&
    isRecord(data['cardWorks']) &&
    isRecord(data['folders']) &&
    Array.isArray(data['rootFolderIds']) &&
    Array.isArray(data['rootDeckIds'])
  );
}

/** Full backup — all AppState including personal data. */
export function exportBackup(state: AppState): void {
  download(JSON.stringify(state, null, 2), `cadence-backup-${toDateStr(new Date())}.json`);
}

/** Card-only export — no history, no decks, no personal data. */
export function exportCards(cards: Card[]): void {
  const pkg = { schemaVersion: SCHEMA_VERSION, cards };
  download(JSON.stringify(pkg, null, 2), `cadence-cards-${toDateStr(new Date())}.json`);
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
}

export async function parseCardPackage(file: File): Promise<Card[]> {
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
  if (!isCardPackage(data)) throw new Error('File is not a valid card package');
  const from = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
  migrateRawCards(data.cards, from);
  return data.cards as Card[];
}

export async function parseImport(file: File): Promise<AppState> {
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
  if (!isAppState(data)) throw new Error('File is not a valid Cadence backup');
  migrateState(data);
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
