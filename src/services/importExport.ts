import type { AppState } from '../types';
import { toDateStr } from '../utils';

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
export function exportFull(state: AppState): void {
  download(JSON.stringify(state, null, 2), `cadence-full-${toDateStr(new Date())}.json`);
}

/** Content-only export — cards and decks, no personal data. */
export function exportContent(state: AppState): void {
  const payload = { cards: state.cards, decks: state.decks };
  download(JSON.stringify(payload, null, 2), `cadence-content-${toDateStr(new Date())}.json`);
}

export async function parseImport(file: File): Promise<AppState> {
  const text = await file.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
  if (!isAppState(data)) throw new Error('File is not a valid Cadence backup');
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
