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
//
// ⚠️ THIS HALF NEEDS MAINTENANCE WHEN THE MODEL CHANGES. Everything below is
// hand-written categories: `SETTING_FIELDS` is an explicit list, and the
// collection diffs name `cards` / `decks` / `folders` / `profiles` one by one.
// A field or a collection added to AppState and not added here does not show
// up in the summary table — it did not show up at all until section 3 existed,
// which is how a user was once asked to choose between two copies with an
// empty panel in front of them.
//
// Section 3 does NOT need that maintenance: it walks whatever is there. So a
// new field is never invisible any more — at worst it is only in the detail
// rather than in the summary. Adding it here is about making it READABLE, not
// about making it visible.

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

// ── 3. Exhaustive difference ─────────────────────────────────────────────────
// Added 2026-09-09 after a real conflict where the panel had nothing to say:
// two copies, 46 cards and 61 reviews each, 38 seconds apart, and every
// category above reported zero. The user was asked to choose between them with
// no way to see what "them" meant.
//
// That gap is structural, not a missing case. Section 1 is total and section 2
// is a set of hand-written categories, so anything outside those categories —
// an ordering, a field added since, a module's inner shape — is invisible
// exactly when it is the only thing there is to look at.
//
// This walks the same tree `deepEqual` walks, by the same rules, and names
// every leaf that differs. It cannot come back empty when `statesEqual` says
// the copies differ; if it ever does, that disagreement is itself reported
// rather than swallowed.

export interface PathDiff {
  /** Dotted path from the root, e.g. `cards.a1b2.content.notes`. */
  path: string;
  kind: 'onlyLocal' | 'onlyDrive' | 'changed';
  local: unknown;
  drive: unknown;
}

/** Hard stop, so a copy that diverged wholesale cannot produce a list nothing
 *  can render or send. The caller is told how many were left out. */
const MAX_PATHS = 500;

/** Every leaf on which the two copies disagree.
 *
 *  Mirrors `deepEqual`'s rules deliberately: a missing key and an explicit
 *  `undefined` are the same thing, and array order is significant. Arrays of
 *  different lengths are reported as one entry rather than as every shifted
 *  index after the insertion point — the shift is one fact, not fifty. */
export function deepDiffPaths(local: unknown, drive: unknown, ignoreKeys?: Set<string>): { paths: PathDiff[]; truncated: number } {
  const paths: PathDiff[] = [];
  let truncated = 0;

  const push = (d: PathDiff) => {
    if (paths.length < MAX_PATHS) paths.push(d);
    else truncated++;
  };

  const walk = (a: unknown, b: unknown, path: string, ignore?: Set<string>): void => {
    if (deepEqual(a, b, ignore)) return;

    const aObj = a !== null && typeof a === 'object';
    const bObj = b !== null && typeof b === 'object';
    const aArr = Array.isArray(a), bArr = Array.isArray(b);

    if (aArr || bArr) {
      if (!aArr || !bArr || a.length !== b.length) { push({ path, kind: 'changed', local: a, drive: b }); return; }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], path ? path + '.' + i : String(i));
      return;
    }

    if (aObj && bObj) {
      const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
      for (const k of keys) {
        if (ignore?.has(k)) continue;
        // Both absent-or-undefined is not a difference, same as deepEqual.
        if (ao[k] === undefined && bo[k] === undefined) continue;
        const sub = path ? path + '.' + k : k;
        if (ao[k] === undefined) { push({ path: sub, kind: 'onlyDrive', local: undefined, drive: bo[k] }); continue; }
        if (bo[k] === undefined) { push({ path: sub, kind: 'onlyLocal', local: ao[k], drive: undefined }); continue; }
        walk(ao[k], bo[k], sub);
      }
      return;
    }

    push({ path: path || '(root)', kind: 'changed', local: a, drive: b });
  };

  walk(local, drive, '', ignoreKeys);
  return { paths, truncated };
}

/** The exhaustive comparison of two states, using the same ignore list as
 *  `statesEqual` so the two can never disagree about what counts. */
export function statePathDiff(local: AppState, drive: AppState): { paths: PathDiff[]; truncated: number } {
  return deepDiffPaths(local, drive, IGNORED_TOP_LEVEL);
}

/** One value, short enough to sit in a table cell or a support message.
 *  Objects are summarised by shape rather than dumped: at this level the
 *  question is "what changed", and the path already says where to look. */
export function briefValue(v: unknown, max = 120): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.length + ' element' + (v.length === 1 ? '' : 's') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return '{' + keys.slice(0, 4).join(', ') + (keys.length > 4 ? ', …' : '') + '}';
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
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
