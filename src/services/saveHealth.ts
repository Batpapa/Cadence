import { signal } from '@preact/signals';

/** What could not be written to this device — the one state every local write
 *  failure reports into, so the user hears about it once and in one voice.
 *
 *  Why it exists (2026-10-01): every write could fail — a full device, a
 *  database the browser refuses to open — and none said so. `mutate` updated
 *  the screen, then its save threw into forty `void mutate(…)` calls that
 *  nobody awaited: the change stayed visible, was not on disk, was not pushed
 *  to Drive, and vanished at the next launch. A live recording lost its chunks
 *  with a comment for company. */

export type SaveFailureKind =
  /** The library itself (AppState): retried until it goes through. */
  | 'library'
  /** Chunks of the recording in progress: lost for good, cannot be retried. */
  | 'recording';

export interface SaveFailure {
  kinds: SaveFailureKind[];
  /** The browser said the storage is full — as opposed to any other refusal. */
  quota: boolean;
  /** The error's own name, for the "anything else" case. */
  reason: string;
}

export const saveFailure = signal<SaveFailure | null>(null);

/** QuotaExceededError is the standard name; Firefox has also used
 *  NS_ERROR_DOM_QUOTA_REACHED, and IndexedDB can wrap it as an AbortError whose
 *  inner error carries the name. */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  const inner = (e as { inner?: { name?: string }; target?: { error?: { name?: string } } } | null);
  return /quota/i.test(name) || /quota/i.test(inner?.inner?.name ?? '') || /quota/i.test(inner?.target?.error?.name ?? '');
}

// Symbol.for, not Symbol: the dev server's error overlay reads it too (webpack.config.js).
const REPORTED = Symbol.for('cadence.saveReported');

/** `mutate` still rejects after reporting (see store.ts), and forty call sites
 *  are `void mutate(…)`: each would add an "uncaught" error on top of a
 *  failure the user has already been told about. Marked here, silenced by the
 *  listener main.ts installs. */
export function isReportedSaveError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as Record<symbol, unknown>)[REPORTED] === true;
}

export function swallowReportedSaveRejections(): void {
  window.addEventListener('unhandledrejection', ev => { if (isReportedSaveError(ev.reason)) ev.preventDefault(); });
}

export function reportSaveFailure(kind: SaveFailureKind, e: unknown): void {
  try { if (e && typeof e === 'object') (e as Record<symbol, unknown>)[REPORTED] = true; } catch { /* frozen */ }
  console.error('[save] ' + kind + ' could not be written to this device', e);
  const prev = saveFailure.value;
  if (prev?.kinds.includes(kind)) return;
  saveFailure.value = {
    kinds: [...(prev?.kinds ?? []), kind],
    quota: (prev?.quota ?? false) || isQuotaError(e),
    reason: (e as { name?: string } | null)?.name || String(e),
  };
}

export function reportSaveRecovered(kind: SaveFailureKind): void {
  const prev = saveFailure.value;
  if (!prev?.kinds.includes(kind)) return;
  const kinds = prev.kinds.filter(k => k !== kind);
  saveFailure.value = kinds.length ? { ...prev, kinds } : null;
}
