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

/** What the browser last answered. `undefined` while the boot request is still
 *  in flight, `null` when the browser implements no StorageManager at all.
 *  A signal because the header shows a warning from it and the request settles
 *  after the first render. */
export const storagePersisted = signal<boolean | null | undefined>(undefined);

/** Last known usage and quota, in bytes, or null when the browser will not say.
 *  Signals for the same reason as above: the header's warning depends on them,
 *  and they are refreshed after a recording is saved — the one moment usage
 *  moves by hundreds of megabytes. */
export const storageUsage = signal<number | null>(null);
export const storageQuota = signal<number | null>(null);

/** Re-reads the browser's estimate into the signals above. Cheap, and safe to
 *  call from anywhere: every failure mode reports "unknown" rather than
 *  throwing. */
export async function refreshStorageEstimate(): Promise<void> {
  try {
    const est = await navigator.storage?.estimate?.();
    storageUsage.value = est?.usage ?? null;
    storageQuota.value = est?.quota ?? null;
  } catch {
    storageUsage.value = null;
    storageQuota.value = null;
  }
}

/** Two independent dangers, not one.
 *
 *  `refused` / `unknown` are about DURABILITY: the browser may delete
 *  everything to reclaim space.
 *
 *  `full` is about CAPACITY, and it is worse. A persistent grant is not lost
 *  when the origin fills up — there is no demotion back to best-effort, and
 *  under Firefox a persistent origin is given a LARGER quota, not a smaller
 *  one. What happens at the quota is that writes start failing with
 *  QuotaExceededError, and SessionFileRecorder swallows exactly those:
 *  "storage pressure — keep recording, chunk lost". So a full origin loses
 *  pieces of the recording in progress, silently, while everything on screen
 *  looks normal. That is why it outranks the durability warning and why it is
 *  shown in red rather than amber. */
export type StorageRisk = 'none' | 'refused' | 'unknown' | 'full';

/** Ratio of the quota at which writes are close enough to failing to be worth
 *  interrupting someone over. Not a free-space figure in bytes: quotas differ
 *  by two orders of magnitude between a phone and a desktop, so a proportion
 *  travels where a threshold does not. */
const FULL_RATIO = 0.8;

/** Pure, so the rule can be tested without a browser.
 *
 *  `null` persisted — the browser implements no StorageManager — counts as a
 *  warning: a browser that will not say whether our data is safe is not a
 *  browser whose silence should be read as a yes.
 *
 *  `undefined` does not. It means the boot request has simply not settled yet,
 *  and warning there would flash a triangle on every cold start that resolves
 *  away a moment later — which is how people learn to ignore triangles. The
 *  distinction lives here rather than in the component so it is covered by a
 *  test rather than by a reader remembering it. */
export function assessStorage(
  persisted: boolean | null | undefined,
  usage?: number | null,
  quota?: number | null,
): StorageRisk {
  // Capacity first: it is the one that is already losing data rather than
  // merely risking it, and it applies whether or not persistence was granted.
  if (typeof usage === 'number' && typeof quota === 'number' && quota > 0 && usage / quota >= FULL_RATIO) {
    return 'full';
  }
  if (persisted === true || persisted === undefined) return 'none';
  if (persisted === false) return 'refused';
  return 'unknown';
}

export interface StorageReport {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
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
    // The capacity half of the warning needs numbers, and boot is where they
    // first become available.
    void refreshStorageEstimate();
    return result;
  } catch {
    storagePersisted.value = null;
    return null;
  }
}

export async function storageReport(): Promise<StorageReport> {
  let persisted: boolean | null = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch { /* unsupported or refused — reported as unknown */ }
  storagePersisted.value = persisted;

  await refreshStorageEstimate();
  const usage = storageUsage.value;
  const quota = storageQuota.value;

  return { persisted, usage, quota };
}
