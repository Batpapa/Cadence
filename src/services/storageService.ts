// ── Storage durability ───────────────────────────────────────────────────────
// Written 2026-09-09, after a user opened Cadence and found the welcome screen:
// no local users, everything gone, on an installed PWA holding many hours of
// recordings. No code path in this app can empty the user store, and no
// persisted name had changed — which leaves the browser's own eviction.
//
// By default a site's storage is "best-effort": the browser may delete ALL of
// it — IndexedDB, localStorage and the caches together — without asking, when
// the device runs short of space. That policy is designed for rebuildable
// caches. Cadence puts hours of audio there, and for anyone not syncing to
// Drive it is the ONLY copy of their work. Asking for "persistent" removes the
// automatic deletion; only the user can then clear it, from browser or OS
// settings.
//
// Chrome and Safari decide silently, on the interaction history of the site —
// an installed PWA is normally granted it with no prompt. Firefox asks the user.
// Because the decision rests on history rather than on any particular click,
// there is no clever moment to ask: the request is made once per launch from
// main.ts, and a refusal gets its next chance at the next launch or from the
// button in the storage panel.

import { signal } from '@preact/signals';
import { localSessionAudioStats } from '../session/db';

/** What the browser last answered. `undefined` while the boot request is still
 *  in flight, `null` when the browser implements no StorageManager at all.
 *  A signal because the header shows a warning from it and the request settles
 *  after the first render. */
export const storagePersisted = signal<boolean | null | undefined>(undefined);

/** What the warning triangle means, and it is ONLY about durability — never
 *  about free space. A device that is merely getting full is not in danger of
 *  losing anything, and a triangle that is sometimes on for a reason the user
 *  cannot act on is a triangle they stop reading. Free space is shown inside
 *  the panel, where it informs rather than alarms. */
export type StorageRisk = 'none' | 'refused' | 'unknown';

/** Pure, so the rule can be tested without a browser.
 *
 *  `null` — the browser implements no StorageManager — counts as a warning: a
 *  browser that will not say whether our data is safe is not a browser whose
 *  silence should be read as a yes.
 *
 *  `undefined` does not. It means the boot request has simply not settled yet,
 *  and warning there would flash a triangle on every cold start that resolves
 *  away a moment later — which is how people learn to ignore triangles. The
 *  distinction lives here rather than in the component so it is covered by a
 *  test rather than by a reader remembering it. */
export function assessStorage(persisted: boolean | null | undefined): StorageRisk {
  if (persisted === true || persisted === undefined) return 'none';
  if (persisted === false) return 'refused';
  return 'unknown';
}

export interface StorageReport {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  /** Bytes of this user's local recordings, or null if unreadable. */
  audioBytes: number | null;
  audioCount: number | null;
}

/** Asks the browser to stop evicting this origin automatically, and records
 *  the answer in `storagePersisted`. Returns what the browser said, or null
 *  when it does not implement the API.
 *
 *  Already-persistent is checked first: `persist()` on a granted origin is
 *  harmless, but the check is cheaper and keeps the call out of the way of
 *  whatever heuristics a browser applies to repeated requests. */
export async function ensurePersistentStorage(): Promise<boolean | null> {
  const sm = navigator.storage;
  if (!sm?.persist || !sm.persisted) {
    storagePersisted.value = null;
    return null;
  }
  try {
    const already = await sm.persisted();
    const result = already ? true : await sm.persist();
    storagePersisted.value = result;
    return result;
  } catch {
    storagePersisted.value = null;
    return null;
  }
}

export async function storageReport(userId: string): Promise<StorageReport> {
  let persisted: boolean | null = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch { /* unsupported or refused — reported as unknown */ }
  storagePersisted.value = persisted;

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? null;
    quota = est?.quota ?? null;
  } catch { /* same */ }

  const stats = await localSessionAudioStats(userId);
  return { persisted, usage, quota, audioBytes: stats?.bytes ?? null, audioCount: stats?.count ?? null };
}
