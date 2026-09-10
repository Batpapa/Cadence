import type { AppState, FileEntry } from './types';
import { t } from './services/i18nService';
import { SCHEMA_VERSION } from './services/migration';

export function generateId(): string {
  return crypto.randomUUID();
}

/** Rejects with `message` if `promise` hasn't settled within `ms` — turns a
 *  silent hang (blocked IndexedDB upgrade, a stuck OAuth popup) into a
 *  surfaced, recoverable error instead of freezing the app forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

// Only the URL: the pin's colour names the site, and the tooltip now shows the
// stored `externalId` itself, so no source ever needs a display name here.
const EXTERNAL_SOURCES: Record<string, { url: (id: string) => string }> = {
  thesession: { url: id => `https://thesession.org/tunes/${id}` },
  irishtuneinfo: { url: id => `https://www.irishtune.info/tune/${id}/` },
  // A set's id alone cannot rebuild its URL — thesession.org/sets/{id} is a 404,
  // only /members/{memberId}/sets/{id} resolves — so the id carries both, as
  // "{member}-{set}", and the pin shows that pair whole: it IS the set's
  // address here, and hiding half of it made the pin unquotable.
  'thesession-set': {
    url: id => {
      const [member, set] = id.split('-');
      return `https://thesession.org/members/${member}/sets/${set}`;
    },
  },
};

/** "thesession:52302" → { source: "thesession", id: "52302", label: "thesession:52302",
 *  url: "https://thesession.org/tunes/52302" }. `id` alone is what the card page's pin
 *  shows (the source is already carried by the pin's colour); `label` is the `externalId`
 *  verbatim, which is what the tooltip spells out — the stored value, quotable as-is into
 *  a bug report or a search, rather than a prettied-up rendering of it.
 *  Reconstructed from the id alone (no slug needed by either source) — independent of
 *  `content.notes`, which the user can freely edit away. */
export function externalSourceLink(externalId: string | undefined): { source: string; id: string; label: string; url: string } | null {
  if (!externalId) return null;
  const sep = externalId.indexOf(':');
  if (sep === -1) return null;
  const source = externalId.slice(0, sep);
  const id = externalId.slice(sep + 1);
  const def = EXTERNAL_SOURCES[source];
  if (!def) return null;
  return { source, id, label: externalId, url: def.url(id) };
}

export function isMobileDevice(): boolean {
  return window.innerWidth < 768 && navigator.maxTouchPoints > 0;
}

/** Focus an input only on desktop (mouse+hover device). Prevents keyboard popup on mobile. */
export function focusIfDesktop(el: HTMLElement): void {
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    // `preventScroll` because focusing an element inside a scrollable container
    // scrolls that container to reveal it — and the library's search field sits
    // at the top of the card list. Returning to the library was therefore
    // restored to the right position and then yanked back to the top 30 ms
    // later by this very call (2026-09-08). Giving a field focus is not a
    // request to move the page.
    setTimeout(() => el.focus({ preventScroll: true }), 30);
  }
}

/** True on a touch-primary device (phone/tablet), false on desktop (mouse+hover) —
 *  same signal as focusIfDesktop, inverted. Not width-based (unlike isMobileDevice):
 *  stable across resizing/orientation, which matters for a one-time capability check
 *  like "will backgrounding this tab cut off microphone access" rather than a layout
 *  decision. Deliberately not OS-specific — the restriction isn't unique to one OS
 *  and this only needs "is background capture likely to be interrupted here". */
export function isTouchPrimaryDevice(): boolean {
  return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function availabilityColor(k: number): string {
  if (k >= 0.75) return 'bg-success';
  if (k >= 0.4)  return 'bg-warn';
  return 'bg-danger';
}

export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor(diff / 60000);
  if (days > 30) return t('time.ago.months', { n: Math.floor(days / 30) });
  if (days > 0)  return t('time.ago.days',   { n: days });
  if (hours > 0) return t('time.ago.hours',  { n: hours });
  if (minutes > 0) return t('time.ago.minutes', { n: minutes });
  return t('time.ago.justNow');
}

export const DAY_NAMES_KEYS = [
  'time.days.sun', 'time.days.mon', 'time.days.tue', 'time.days.wed',
  'time.days.thu', 'time.days.fri', 'time.days.sat',
] as const;

export function fileToEntry(file: File): Promise<FileEntry> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target!.result as string;
      const base64 = dataUrl.split(',')[1] ?? '';
      resolve({ name: file.name, data: base64, mimeType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function entryToObjectUrl(entry: FileEntry): string {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: entry.mimeType });
  return URL.createObjectURL(blob);
}

/** Chunked to avoid "Maximum call stack size exceeded" on large buffers (spread args limit). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Inverse of arrayBufferToBase64. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

/** Human-readable byte size, for the places where storage weight is the point
 *  being made (removing a user, embedding session audio, sharing a recording).
 *  Deliberately coarse: one decimal below 10 units and none above, because
 *  these numbers exist to convey an order of magnitude, not an exact figure.
 *  Uses MB/GB in the everyday (1024-based) sense the rest of the app already
 *  displays. */
/** Client-side "save as": a Blob URL, clicked once, revoked immediately.
 *  Shared by every export in the app rather than re-typed in each — the revoke
 *  is the part that gets forgotten when this is copied around, and a leaked
 *  object URL pins its whole Blob in memory for the life of the document. */
export function downloadTextFile(content: string, filename: string, mime: string): void {
  downloadBlob(new Blob([content], { type: mime }), filename);
}

/** The same save-as for something that is already bytes. Separate from the
 *  text helper rather than widening it to BlobPart: a function called
 *  downloadTextFile handed a Uint8Array reads as a bug at every call site,
 *  and the archive path is bytes all the way down. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copies text, and says whether it worked.
 *
 *  `navigator.clipboard` is absent outside a secure context and can be refused
 *  by permission, so the textarea + execCommand path stays: it is deprecated,
 *  not gone, and it is the only thing that works when the modern API is not
 *  there. The caller gets a boolean rather than a rejected promise because
 *  "the copy did not happen" is a normal outcome to show in the UI, not an
 *  error to log. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* refused or unavailable — try the old way below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen rather than hidden: execCommand needs a focusable, selectable
    // element, and display:none is neither.
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function emptyState(): AppState {
  return {
    id: '',
    name: 'Default',
    language: 'en',
    availabilityThreshold: 0.9,
    weightByImportance: true,
    forgettingRate: 1,
    profileIds: [],
    currentProfileId: '',
    profiles: {},
    cards: {},
    decks: {},
    cardWorks: {},
    folders: {},
    rootFolderIds: [],
    rootDeckIds: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ── Tune display name normalization ───────────────────────────────────────────
// Both FolkFriend's tune index (ffWorker.ts) and TheSession's static GitHub
// data dump (adactio/TheSession-data — trendingSyncService.ts's
// json/tune_popularity.json, tuneNameIndexService.ts's json/tunes.json) store
// names in library-catalog sort order — the leading article moved to the end
// so the name alphabetizes under its real first word ("Kesh, The", so it
// sorts under K, not T). That's a sorting convention, not how anyone actually
// says or writes the name — flip it back for display ("The Kesh"). NOT
// needed for thesession.org's own live JSON API (theSessionService.ts,
// actual tune/card import) — verified (2026-08-24) it already returns
// natural order ("The Kesh"), only the static data dump has this quirk.

const TRAILING_ARTICLE = /^(.+),\s*(the|an?)$/i;

export function normalizeDisplayName(name: string): string {
  const m = TRAILING_ARTICLE.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
}

// ── Reading a recognised name before the real one arrives ────────────────────
// The recognition index holds its names ENTIRELY in lower case — measured, not
// assumed: 0 capitals across its 46 867 aliases, "'ma' mcnulty's favourite"
// included. Case was dropped because matching ignores it.
//
// This is the LAST resort for showing one, and deliberately temporary: the
// name a detection really deserves is its card's, or TheSession's own from the
// name index (see sessionUiShared's `tuneName`, which reaches for those first
// and starts the index downloading when it is missing). This only fills the
// seconds in between, and does the job better than the CSS `capitalize` it
// replaces — that one produced "Mcgoldrick's" and "The Bucks Of Oranmore".
//
// Rules, therefore, are acceptable HERE and nowhere else: nothing is stored
// from this, and whatever it gets wrong is corrected the moment the index
// lands.

/** Words that stay lower case inside a title, but not at either end of one.
 *  English and Irish both, since the index carries plenty of Irish names. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of',
  'off', 'on', 'or', 'the', 'to', 'up', 'with',
  'na', 'nan', 'agus', 'don', 'de', 'do', 'le', 'go',
]);

/** Capitals a first-letter rule cannot produce. `Mc` is safe to expand — an
 *  Irish or Scottish name is what it always is. `Mac` is NOT: "Macklin" and
 *  "Machine" would become "MacKlin" and "MacHine", so it gets its own capital
 *  and nothing more. */
function fixInternalCaps(word: string): string {
  if (/^mc[a-z]/.test(word)) return 'Mc' + word.charAt(2).toUpperCase() + word.slice(3);
  if (/^o'[a-z]/.test(word)) return "O'" + word.charAt(2).toUpperCase() + word.slice(3);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function titleCaseTuneName(name: string): string {
  // Anything already carrying a capital came from a source that kept them —
  // TheSession, or a person typing. Re-casing that can only do harm.
  if (/[A-Z]/.test(name)) return name;

  return name.split('/').map(segment => {
    const parts = segment.split(/(\s+)/);           // separators kept
    const wordIdx = parts.map((p, i) => (i % 2 === 0 && p ? i : -1)).filter(i => i >= 0);
    const first = wordIdx[0];
    const last = wordIdx[wordIdx.length - 1];

    return parts.map((part, i) => {
      if (i % 2 === 1 || !part) return part;         // whitespace
      const lower = part.toLowerCase();
      // The bare word decides: "of," and "of" are the same word.
      const bare = lower.replace(/[^a-zà-ÿ']/g, '');
      if (i !== first && i !== last && SMALL_WORDS.has(bare)) return lower;
      // Hyphenated names get each half capitalised ("sean-nós" → "Sean-Nós").
      return lower.split('-').map(fixInternalCaps).join('-');
    }).join('');
  }).join('/');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 0 (best) to 6 (no match), used by sortByRelevance to rank search results.
 *  Ranks are anchored on WHERE/HOW the query sits relative to word
 *  boundaries in `name` — a match at the very start beats one merely aligned
 *  to a word boundary further in, which in turn beats a match buried
 *  mid-word with no boundary alignment at all (e.g. querying "inch" against
 *  "The Mystery Inch" — whole word — should outrank "The Goldfinch" — the
 *  query is just a fragment of "finch" — even though neither starts with the
 *  query). \b is JS's built-in word-boundary regex anchor (transition
 *  between a \w character — letter/digit/underscore — and a non-\w one, or
 *  string start/end) — cheap and good enough here; it doesn't know about
 *  apostrophes/accents as "part of a word" the way a linguist would, but
 *  that's an acceptable rough edge for tune-name search, not something this
 *  needs to get perfectly right. */
/** scoreMatch's fallback return value — no callsite should hardcode this
 *  number to test "did it match at all" (`< NO_SCORE_MATCH`); a past bug
 *  (commandPalette.ts hardcoding the OLD fallback value of 4 as its
 *  match/no-match cutoff) silently started dropping real matches the moment
 *  scoreMatch grew two more ranked tiers below the old ones, without any
 *  type error to catch it — the threshold and the fallback value were never
 *  actually tied together in the code, just coincidentally equal. */
export const NO_SCORE_MATCH = 6;

export function scoreMatch(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  if (n === q)               return 0;
  if (n.startsWith(q + ' ')) return 1; // starts with the query as its own whole first word
  if (n.startsWith(q))       return 2; // starts with the query, mid-word (e.g. "inchindown" vs "inch")
  const qEsc = escapeRegExp(q);
  if (new RegExp(`\\b${qEsc}\\b`).test(n)) return 3; // query is a whole word somewhere else in the name
  if (new RegExp(`\\b${qEsc}`).test(n))    return 4; // query starts some other word in the name, without completing it
  if (n.includes(q))         return 5; // query is buried inside a word, no boundary alignment at all
  return NO_SCORE_MATCH;
}

export function sortByRelevance<T extends { name: string }>(items: T[], query: string): T[] {
  return [...items].sort((a, b) => {
    const sd = scoreMatch(a.name, query) - scoreMatch(b.name, query);
    return sd !== 0 ? sd : a.name.localeCompare(b.name);
  });
}

// ── Touch drag & drop support ─────────────────────────────────────────────────
// Translates touchstart/touchmove/touchend into synthetic DragEvents so that
// existing dragstart/dragover/drop handlers work on mobile without changes.

export function addTouchDragSupport(el: HTMLElement): void {
  const LONG_PRESS_MS = 250;
  const MOVE_CANCEL_PX = 8;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0, startY = 0;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let lastDragTarget: Element | null = null;

  const dispatchDrag = (type: string, target: Element, clientX: number, clientY: number) =>
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

  const activate = (touch: Touch) => {
    dragging = true;
    dispatchDrag('dragstart', el, touch.clientX, touch.clientY);
    const rect = el.getBoundingClientRect();
    ghost = el.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '9999',
      opacity: '0.75', margin: '0', boxSizing: 'border-box',
      width: rect.width + 'px', height: rect.height + 'px',
      left: rect.left + 'px', top: rect.top + 'px',
    });
    document.body.appendChild(ghost);
  };

  const cleanup = () => {
    ghost?.remove(); ghost = null;
    dragging = false; lastDragTarget = null;
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0]!;
    startX = touch.clientX; startY = touch.clientY;
    pressTimer = setTimeout(() => activate(touch), LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const touch = e.touches[0]!;
    if (!dragging) {
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_CANCEL_PX) {
        clearTimeout(pressTimer!); pressTimer = null;
      }
      return;
    }
    e.preventDefault();
    if (ghost) {
      ghost.style.left = touch.clientX - el.offsetWidth / 2 + 'px';
      ghost.style.top  = touch.clientY - el.offsetHeight / 2 + 'px';
      ghost.style.visibility = 'hidden';
    }
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (ghost) ghost.style.visibility = '';
    if (target !== lastDragTarget) {
      if (lastDragTarget) dispatchDrag('dragleave', lastDragTarget, touch.clientX, touch.clientY);
      lastDragTarget = target;
    }
    if (target) dispatchDrag('dragover', target, touch.clientX, touch.clientY);
  }, { passive: false });

  const endDrag = (clientX: number, clientY: number) => {
    clearTimeout(pressTimer!); pressTimer = null;
    if (!dragging) return;
    if (ghost) ghost.style.visibility = 'hidden';
    const target = document.elementFromPoint(clientX, clientY);
    cleanup();
    if (target) dispatchDrag('drop', target, clientX, clientY);
    dispatchDrag('dragend', el, clientX, clientY);
  };

  el.addEventListener('touchend',    (e) => { const tc = e.changedTouches[0]!; endDrag(tc.clientX, tc.clientY); });
  el.addEventListener('touchcancel', (e) => { const tc = e.changedTouches[0]!; endDrag(tc.clientX, tc.clientY); });
}
