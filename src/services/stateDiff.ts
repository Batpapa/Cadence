import type { AppState, Card, Deck, Folder, Profile, SessionEntry } from '../types';

// ── Comparing two copies of one user's state ─────────────────────────────────
// Written for the Drive conflict path (2026-09-02), which has two jobs that
// look alike but are not:
//
//   1. "Are these the same?" — decides whether the user is shown a modal at
//      all. Must be TOTAL: if it ever answers "same" while something differs,
//      that something is silently discarded. So it is a plain deep comparison
//      of everything, NOT the sum of the categories below.
//   2. "What differs?" — for the screen that explains the conflict. Only needs
//      to cover what is worth reading, and may legitimately summarise.
//
// Keeping them separate is the whole point: `statesEqual` can be trusted
// because it knows nothing about the app's shape, while `diffStates` can be
// improved freely without ever risking a silent loss.

// ── 1. Total comparison ──────────────────────────────────────────────────────

/** Fields that are per-install bookkeeping rather than user data, and so must
 *  never make two copies look different. `id` is stamped locally on whatever
 *  arrives from Drive; the two underscore fields are the sync envelope. */
const IGNORED_TOP_LEVEL = new Set(['id', '_lastModified', '_deviceId']);

/** Deep structural equality.
 *
 *  Two details that matter here rather than in a generic deep-equal:
 *  - a missing key and an explicitly `undefined` one are the SAME, because a
 *    round trip through JSON drops `excludeMastered: undefined` and we must not
 *    read that as a change;
 *  - array order is significant, because it is meaningful everywhere it appears
 *    (deck entries, root ordering, review history). */
function deepEqual(a: unknown, b: unknown, ignoreKeys?: Set<string>): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }

  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const keep = (k: string) => !ignoreKeys?.has(k) && !(ao[k] === undefined && bo[k] === undefined);
  const ak = Object.keys(ao).filter(k => keep(k) && ao[k] !== undefined);
  const bk = Object.keys(bo).filter(k => keep(k) && bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every(k => k in bo && deepEqual(ao[k], bo[k]));
}

/** The question the conflict path actually asks before deciding to interrupt
 *  the user. Total by construction — it walks whatever is there. */
export function statesEqual(a: AppState, b: AppState): boolean {
  return deepEqual(a, b, IGNORED_TOP_LEVEL);
}

// ── 2. Readable difference ───────────────────────────────────────────────────

export interface CollectionDiff {
  onlyLocal: string[];
  onlyDrive: string[];
  /** Present on both sides, but not identical. */
  changed: string[];
}

export interface ReviewDiff {
  onlyLocal: number;
  onlyDrive: number;
  /** Timestamp of the most recent review the OTHER side does not have — the
   *  one number that tells you how much work a choice would cost. */
  latestOnlyLocal: number | null;
  latestOnlyDrive: number | null;
}

export interface FieldDiff { field: string; local: unknown; drive: unknown }

export interface ModuleDiff { key: string; onlyLocal: number; onlyDrive: number; changed: number }

export interface StateDiff {
  reviews: ReviewDiff;
  cards: CollectionDiff;
  decks: CollectionDiff;
  folders: CollectionDiff;
  profiles: CollectionDiff;
  settings: FieldDiff[];
  modules: ModuleDiff[];
  /** True when the categories above found nothing. NOT the same question as
   *  `statesEqual` — something outside them (ordering, an unknown field) can
   *  still differ, which is precisely why the two are separate. */
  summarised: boolean;
  /** Set when every difference is on ONE side only: that side simply has more,
   *  the other has nothing of its own. This is the signature of a push whose
   *  acknowledgement was lost — the Drive copy is then our own earlier state,
   *  an ancestor rather than a rival. A genuine two-writer conflict has
   *  additions on both sides and leaves this null. */
  oneSided: 'local' | 'drive' | null;
}

function collectionDiff<T>(local: Record<string, T> = {}, drive: Record<string, T> = {}): CollectionDiff {
  const onlyLocal: string[] = [], onlyDrive: string[] = [], changed: string[] = [];
  for (const id of Object.keys(local)) {
    if (!(id in drive)) onlyLocal.push(id);
    else if (!deepEqual(local[id], drive[id])) changed.push(id);
  }
  for (const id of Object.keys(drive)) if (!(id in local)) onlyDrive.push(id);
  return { onlyLocal, onlyDrive, changed };
}

/** Reviews are compared as a MULTISET of (cardWork, timestamp, rating): two
 *  reviews of the same card at the same instant with the same rating are
 *  genuinely indistinguishable, and counting them by identity would report a
 *  phantom difference whenever one side happens to hold two of them. */
function reviewKeys(state: AppState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [workKey, work] of Object.entries(state.cardWorks ?? {})) {
    for (const e of (work?.history ?? []) as SessionEntry[]) {
      const k = `${workKey}|${e.ts}|${e.rating}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

function reviewDiff(local: AppState, drive: AppState): ReviewDiff {
  const l = reviewKeys(local), d = reviewKeys(drive);
  let onlyLocal = 0, onlyDrive = 0;
  let latestOnlyLocal: number | null = null, latestOnlyDrive: number | null = null;
  const tsOf = (k: string) => Number(k.split('|')[1]);

  for (const [k, n] of l) {
    const extra = n - (d.get(k) ?? 0);
    if (extra <= 0) continue;
    onlyLocal += extra;
    latestOnlyLocal = Math.max(latestOnlyLocal ?? 0, tsOf(k));
  }
  for (const [k, n] of d) {
    const extra = n - (l.get(k) ?? 0);
    if (extra <= 0) continue;
    onlyDrive += extra;
    latestOnlyDrive = Math.max(latestOnlyDrive ?? 0, tsOf(k));
  }
  return { onlyLocal, onlyDrive, latestOnlyLocal, latestOnlyDrive };
}

/** Scalar settings, listed explicitly: a generic "every non-object field" scan
 *  would silently start reporting any future field, including ones that are
 *  bookkeeping rather than a user choice. */
const SETTING_FIELDS = [
  'name', 'language', 'availabilityThreshold', 'weightByImportance',
  'excludeMastered', 'forgettingRate', 'currentProfileId', 'schemaVersion',
] as const;

function settingsDiff(local: AppState, drive: AppState): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of SETTING_FIELDS) {
    const a = local[f], b = drive[f];
    if (!deepEqual(a, b)) out.push({ field: f, local: a, drive: b });
  }
  // Ordering of the two root lists is a user choice (drag-and-drop), so a
  // reorder is a real difference — reported as one line rather than a list.
  for (const f of ['rootFolderIds', 'rootDeckIds'] as const) {
    if (!deepEqual(local[f], drive[f])) out.push({ field: f, local: local[f], drive: drive[f] });
  }
  return out;
}

/** Modules are typed `unknown` on purpose (types.ts must not depend on any
 *  module's shape), so this stays structural: for a module whose value is a
 *  record of records — which is the shape they all have, e.g. the Sessions
 *  module's `{ sessions: {...} }` — count the entries that differ. */
function modulesDiff(local: AppState, drive: AppState): ModuleDiff[] {
  const keys = new Set([...Object.keys(local.modules ?? {}), ...Object.keys(drive.modules ?? {})]);
  const out: ModuleDiff[] = [];
  for (const key of keys) {
    const l = local.modules?.[key], d = drive.modules?.[key];
    if (deepEqual(l, d)) continue;
    const entries = (v: unknown): Record<string, unknown> => {
      if (!v || typeof v !== 'object') return {};
      const inner = Object.values(v as Record<string, unknown>)[0];
      // `{ sessions: { id: {...} } }` → count the sessions, not the one wrapper
      // key; anything flatter is counted as-is.
      return (inner && typeof inner === 'object' && !Array.isArray(inner))
        ? inner as Record<string, unknown>
        : v as Record<string, unknown>;
    };
    const c = collectionDiff(entries(l), entries(d));
    out.push({ key, onlyLocal: c.onlyLocal.length, onlyDrive: c.onlyDrive.length, changed: c.changed.length });
  }
  return out;
}

export function diffStates(local: AppState, drive: AppState): StateDiff {
  const reviews = reviewDiff(local, drive);
  const cards = collectionDiff<Card>(local.cards, drive.cards);
  const decks = collectionDiff<Deck>(local.decks, drive.decks);
  const folders = collectionDiff<Folder>(local.folders, drive.folders);
  const profiles = collectionDiff<Profile>(local.profiles, drive.profiles);
  const settings = settingsDiff(local, drive);
  const modules = modulesDiff(local, drive);

  const cols = [cards, decks, folders, profiles];
  const localOnly = reviews.onlyLocal > 0 || cols.some(c => c.onlyLocal.length > 0)
    || modules.some(m => m.onlyLocal > 0);
  const driveOnly = reviews.onlyDrive > 0 || cols.some(c => c.onlyDrive.length > 0)
    || modules.some(m => m.onlyDrive > 0);
  // A field edited on both sides, or an entity present on both and differing,
  // is a real divergence — it disqualifies the one-sided reading even when all
  // the ADDITIONS happen to sit on the same side.
  const bothTouched = settings.length > 0 || cols.some(c => c.changed.length > 0)
    || modules.some(m => m.changed > 0);

  const summarised = !localOnly && !driveOnly && !bothTouched;
  const oneSided = bothTouched || (localOnly && driveOnly) ? null
    : localOnly ? 'local' : driveOnly ? 'drive' : null;

  return { reviews, cards, decks, folders, profiles, settings, modules, summarised, oneSided };
}
