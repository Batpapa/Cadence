// ── Content (shareable) ─────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  data: string; // base64
  mimeType: string;
}

export interface EmbedEntry {
  id: string;
  url: string;       // original URL as pasted by user
  title?: string;    // fetched via oEmbed at add time
  embedUrl?: string; // resolved iframe src, stored to avoid re-fetching
}

/** A pointer to another card, independent of the role that pointer plays.
 *  Two roles carry it today: an attachment (a mention, alongside files and
 *  embeds) and a tuneset's `tunes` list (the set's definition). Resolution
 *  order is id → guid → externalId — see resolveCardRef. */
export interface CardRef {
  id: string;          // local UUID — fast path
  guid: string;        // stable guid — cross-device
  externalId?: string; // TheSession etc. — portable
  title: string;       // snapshot of card name, fallback if unresolved
  /** How many times this tune is played HERE. A property of the tune's place in
   *  this set, not of the tune: the same reel can go round twice in one set and
   *  three times in another. Absent = once.
   *
   *  Only a tuneset's `tunes` list reads it — a reference among a card's
   *  attachments is a mention, and a mention is not played. */
  repeat?: number;
}

export type CardReferenceAttachment = { type: 'card' } & CardRef;

export type Attachment =
  | ({ type: 'file' } & FileEntry & {
      /** Multi-tune ABC files only: which splitAbcTunes() index to open by
       *  default — a per-attachment "favorite version", set explicitly from
       *  the preview modal. Absent = today's default (index 0). */
      preferredIndex?: number;
      /** How this attachment came to be, when it was not added by hand.
       *
       *  'thesession' — fetched from the source (tuneResultToCard's ABC file).
       *  Lets "Refresh ABC" find and replace it precisely instead of guessing
       *  by filename, which breaks as soon as the card is renamed.
       *
       *  'tuneset' — a set's fused score, DERIVED from its member tunes. Its
       *  `data` is deliberately empty: only the intent to have this attachment
       *  is stored, and the notation is rebuilt at the moment it is shown, so
       *  it can never go stale and costs nothing in the synced blob. This is
       *  also the marker that makes it non-editable and unique on a card —
       *  never its name, which a user could give to a file of their own.
       *
       *  Absent on manually-added or pre-existing attachments. */
      generatedBy?: 'thesession' | 'tuneset';
    })
  | ({ type: 'embed' } & EmbedEntry)
  | CardReferenceAttachment;

export interface Card {
  id: string;
  guid: string;
  name: string;
  defaultImportance: number; // default: 1
  tags: string[];
  externalId?: string; // e.g. "thesession:1197"
  /** Open specialisation — deliberately a bare string, never a closed union:
   *  Cadence is generalist first, and a new kind of card must not require
   *  touching this file. Absent = an ordinary card, which is what every card
   *  created before 2026-09 and every non-music card is. Known values live in
   *  cardTypeService.ts (`tune`, `tuneset`); an unknown one degrades to
   *  "ordinary" rather than breaking a view. */
  type?: string;
  /** A tuneset's DEFINITION: its tunes, in playing order. Read only when
   *  `type` is 'tuneset' — `type` is the truth, this is merely its payload, so
   *  an absent list on a tuneset is an empty set (not "not a set"). Retyping a
   *  card away from 'tuneset' DROPS the list (applyCardType); one arriving on
   *  a non-set card through an import is ignored rather than read. Deliberately
   *  separate from `content.attachments`: a set must be able to reference a
   *  card WITHOUT that card becoming one of its tunes. */
  tunes?: CardRef[];
  /** When true, `name` is DERIVED from `tunes` and rewritten on every state
   *  change (stateNormalise) — the card's tunes joined with " / ". Read only
   *  on a set, and dropped alongside `tunes` when a card stops being one.
   *
   *  `name` still holds the real, current string: the value is materialised,
   *  not computed at each read, so the 39-odd places that display, sort,
   *  search, export and snapshot a card name keep working untouched. Typing a
   *  name by hand clears this flag — otherwise the rename would be silently
   *  undone by the next normalisation. */
  computedName?: boolean;
  content: {
    notes: string;
    attachments: Attachment[];
  };
}

export interface DeckEntry {
  cardId: string;
  importance?: number; // deck-specific importance; falls back to card.defaultImportance when absent
}

export interface Deck {
  id: string;
  name: string;
  entries: DeckEntry[];
  favorite?: boolean;
}

// ── Personal data ────────────────────────────────────────────────────────────

/** Maps directly to FSRS grades: 1=Again · 2=Hard · 3=Good · 4=Easy */
export type SessionRating = 'again' | 'hard' | 'good' | 'easy';

export interface SessionEntry {
  ts: number;           // timestamp in ms
  rating: SessionRating;
}

export interface Profile {
  id: string;
  name: string;
}

export interface CardWork {
  profileId: string;
  cardId: string;
  history: SessionEntry[];
}

export interface Folder {
  id: string;
  name: string;
  folderIds: string[];
  deckIds: string[];
}

// ── User = entire state for one person ───────────────────────────────────────

export interface User {
  // Identity
  id: string;
  name: string;
  language: 'en' | 'fr';

  // Study settings
  availabilityThreshold: number;
  weightByImportance: boolean;
  /** Exclude mastered cards from study picks (default true). Off = study as if
   *  the mastery threshold were 100% — study flow only, deck metrics keep the
   *  real threshold. */
  excludeMastered?: boolean;
  forgettingRate: number; // λ: scales S → S/λ for scheduling; 1 = FSRS default, >1 = faster forgetting

  // Score playback — how ABC sounds, wherever a score is opened. Global rather
  // than per card: it describes the listener (which instrument they want to
  // hear, how fast they can follow), not the tune.
  /** Percentage of the written tempo a score opens at. Absent = 100. */
  abcTempoPercent?: number;
  /** General MIDI program. Absent = whatever the ABC itself asks for. */
  abcInstrument?: number;

  // Profiles
  profileIds: string[];
  currentProfileId: string;
  profiles: Record<string, Profile>;

  // Content
  cards: Record<string, Card>;
  decks: Record<string, Deck>;
  cardWorks: Record<string, CardWork>; // key: `${profileId}:${cardId}`
  folders: Record<string, Folder>;
  rootFolderIds: string[];
  rootDeckIds: string[];

  /** Per-module extension data, synced with the rest of this blob (Drive,
   *  IndexedDB) — e.g. the Sessions feature's recorded-session metadata
   *  (see session/model.ts's TuneAnalyserModuleData). Loosely typed here
   *  (types.ts is foundational and shouldn't depend on any one module's
   *  shape); each module casts its own key via its own typed accessor. Keep
   *  entries small — this whole object is structuredClone'd on every
   *  mutate() call across the app (store.ts) — large/binary data (audio,
   *  crash-recovery scratch) belongs in a module's own local-only database
   *  instead, never here. */
  modules?: Record<string, unknown>;

  // Schema versioning
  schemaVersion?: number;
}

/** AppState is the active User — kept as alias to minimise call-site changes. */
export type AppState = User;

// ── Routing ──────────────────────────────────────────────────────────────────

/** `sequential` walks the deck's own entry order (the one set by drag-and-drop
 *  in the deck view) and loops at the end. Unlike the other three it is only
 *  offered when studying an actual deck: a folder or library pool has no order
 *  the user deliberately chose. */
export type StudyStrategy = 'random' | 'optimal' | 'stochastic' | 'sequential';

export type FilterState = 'include' | 'exclude';

export type LibrarySort = 'alpha' | 'lastReviewed' | 'lastAdded' | 'importance' | 'recall' | 'difficulty';

export type TrendingGainMode = 'absolute' | 'percent';

export type Route =
  | { view: 'folder'; folderId: string | null }
  | { view: 'library'; search?: string; tags?: [string, FilterState][]; decks?: [string, FilterState][]; sort?: LibrarySort; sortAsc?: boolean; tagOr?: boolean; deckOr?: boolean }
  | { view: 'deck'; deckId: string }
  | { view: 'card'; cardId: string; contextDeckId?: string }
  | { view: 'study'; deckId?: string; cardIds?: string[]; studyTitle?: string; strategy: StudyStrategy; currentCardId?: string | null; contextDeckId?: string | null }
  | { view: 'modules' }
  | { view: 'sessions'; sessionId?: string }
  // `from`/`to` are YYYY-MM-DD, snapped to the closest synced snapshot on load.
  // Deliberately excludes the deck-picker target — that stays session-only, never persisted.
  | { view: 'trending'; from?: string; to?: string; gainMode?: TrendingGainMode; minTunebooks?: number };

export interface AppContext {
  user: AppState;
  route: Route;
  navigate: (route: Route) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  mutate: (fn: (user: AppState) => void) => Promise<void>;
}
