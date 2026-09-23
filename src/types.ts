// ── Content (shareable) ─────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  data: string; // base64
  mimeType: string;
}

/** What a link attachment DOES when it is opened: `embed` plays it in a modal
 *  iframe, `link` leaves the app for a new tab. Never read off the field
 *  directly — `linkMode()` in embedService is the single reader, because an
 *  absent one means `embed` (every link stored before 2026-09-22 was one). */
export type LinkMode = 'embed' | 'link';

export interface EmbedEntry {
  id: string;
  url: string;       // original URL as pasted by user
  /** The row's label. Fetched via oEmbed at add time for an embed; typed by
   *  hand, and mandatory, for an external link — nothing can be read off a
   *  cross-origin page, and a bare URL is not a name. */
  title?: string;
  embedUrl?: string; // resolved iframe src, stored to avoid re-fetching
  /** Written explicitly on both sides since 2026-09-22 — see LinkMode. */
  mode?: LinkMode;
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
      /** Set on a clip cut from an analysis: which detection it is, as
       *  `{first 8 characters of the session id}·{start in whole seconds}`. How
       *  the analysis tells the clip is already attached, whatever the file has
       *  since been renamed to. It was a tag inside the name until schema V8. */
      clipOf?: string;
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
  /** Other names the card is known by — "Reaping the Rye" for Cooley's. Filled
   *  from the source on import and on "Refresh aliases", then the user's to
   *  edit. Searched like `name`. Absent and empty mean the same; read and write
   *  through aliasService.ts, which holds the rules. */
  aliases?: string[];
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
  /** Set when this rating was filed from somewhere that still exists and has
   *  to find it again — to show it as already given, to take it back, or to
   *  follow it when what it describes is corrected (2026-09-23).
   *
   *  OPAQUE here, and deliberately so: whoever files the entry owns the
   *  string's shape and is the only one that reads into it, which is what
   *  keeps a card's history from knowing about any module. Everything in the
   *  core compares it and nothing more — see services/reviewEntries.ts.
   *
   *  Absent on every rating given in the study flow or typed on the card page,
   *  and on everything filed before ids existed. An id whose owner is gone is
   *  dropped rather than left dangling, and the rating stays. */
  id?: string;
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
  /** Write a set's repeats out in its fused score. Absent = no, which is the
   *  default: the counts still live on each tune and still show as ×N in the
   *  card view, they are only spelled out in the notation when this is on. */
  abcIncludeRepeats?: boolean;
  /** Which face a score opens on, in the viewer and in an incipit alike.
   *  Absent = 'sheet' — see `abcOpenMode` in abcService, the single reader.
   *  Someone who edits ABC by hand all day sets it once instead of pressing
   *  the same tab on every score. */
  abcOpenMode?: AbcOpenMode;

  // Score engraving — how ABC READS. Measured on 2026-09-21: with no
  // `staffwidth` abcjs lays every score out at its own default of 740 units
  // and the box then stretches or crushes the result, so the engraved staff
  // came out at 3,9 mm on a phone and 13,6 mm on a wide screen — against the
  // 7 mm of printed music. The width is now the box's own, and what adapts is
  // how many bars a line holds. See `engraveOptions` in fileViewer.
  /** Bars per line the score aims for. Absent = DEFAULT_BARS_PER_LINE, which
   *  is the carrure most of this music is written in. A request, not an order:
   *  abcjs will not compress music below its own minimum, so a narrow screen
   *  gets fewer bars than asked and the staff keeps its size. */
  abcBarsPerLine?: number;
  /** Absent = the app's theme decides — see `abcPaper` in abcService. */
  abcPaper?: AbcPaper;
  // The metronome is NOT here, deliberately (2026-09-22): it belongs to the
  // session, not to the reader. You put a click on while you are learning a
  // passage and you do not want the next score you open to start clicking.
  // It lives in the viewer and starts off every time.
  /** How much the playback swings, as abcjs counts it: 50 is straight, 60 is
   *  3:2, 66 is a 2:1 triplet feel, 75 is a dotted eighth against a sixteenth
   *  and is its ceiling. Absent = straight. Only `X/4` and `X/8` metres swing
   *  at all, which is every metre this music is written in. */
  abcSwing?: number;

  // abcZoomPercent lived here until 2026-09-21 — how big the notation was
  // drawn, as a percentage. The score zoom is gone (see fileViewer's note on
  // why, and what to know before rebuilding it). A value stored by whoever
  // used it stays in their synced blob, harmlessly, and is simply not read.

  // Misc.
  /** How many times a tune is played through when it JOINS a set — three is
   *  the Irish convention, and the number is the tradition's, not the tune's.
   *  Absent = DEFAULT_TUNE_REPEAT. Stamped onto the reference at insertion,
   *  never read back as a fallback: changing this must not silently re-voice
   *  every set already built, nor make an exported set mean something else on
   *  the machine that opens it. */
  defaultTuneRepeat?: number;
  /** Whether turning a card into a set also gives it the fused score. Absent =
   *  yes, so both values are written explicitly (see `addTunesetAbcOnConvert`
   *  in abcService, the single reader). Applies to the two MANUAL conversions
   *  — the card view's type selector and the library's bulk change — and to
   *  nothing else: it is not an invariant, and a set someone stripped the
   *  score from must stay stripped. */
  addTunesetAbcOnConvert?: boolean;
  /** Where to show a tune's opening bars — see `components/incipit.tsx`.
   *  Absent = 'card', the default: the reminder is the feature, and one that
   *  has to be switched on is one nobody finds. */
  incipitDisplay?: IncipitDisplay;

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

/** How the tune ranking is ordered. Here rather than beside its component for
 *  the same reason `LibrarySort` is: it travels in the route. */
export type TuneSort = 'alpha' | 'lastHeard' | 'count';

/** Where a tune's opening bars are shown. `card` is the card page alone;
 *  `study` means the card page AND a review — it is a superset, not a third
 *  place, so the three values read as one dial from less to more. */
export type IncipitDisplay = 'none' | 'card' | 'study';

/** Which face a score shows FIRST — the drawn stave or the ABC source. Both
 *  the full viewer and an incipit read it, and both keep their own switch, so
 *  this decides where you land and never where you can go. */
export type AbcOpenMode = 'sheet' | 'text';

/** The paper a score is drawn on. Not a theme of its own: `white` is the sheet
 *  of paper this viewer always forced, `dark` is the app's own surface with the
 *  ink inverted, `sepia` is the warm page people read long from. Absent means
 *  the app's theme decides — see `abcPaper` in abcService, the single reader. */
export type AbcPaper = 'dark' | 'sepia' | 'white';

export type Route =
  | { view: 'folder'; folderId: string | null }
  // `reviewedFrom`/`reviewedTo` are YYYY-MM-DD and bound a card's REVIEWS, not
  // the card itself: a card matches when the current profile reviewed it at
  // least once inside the range. Either end may stand alone (an open interval).
  // Local days, resolved to [00:00, 23:59:59.999] where they are read.
  // `types` has no OR flag of its own: a card holds ONE type, so several
  // included types can only ever mean "any of these" — see LibraryView.
  // `decks` also carries deck FOLDERS, keyed `folder:<id>` (components/
  // filterChips.ts) — one map, so one AND/OR toggle covers both. The sessions
  // route's `analyses` does the same for analysis folders. A key naming
  // something deleted since is ignored where it is read, not rejected here.
  // `cards` limits the library to those card ids; absent = every card. Generic
  // on purpose — any screen can hand over a set of cards (the analyser's tunes
  // tab is the first), and the library does not know or say where it came from.
  // It is state like the filters, kept in the route, so coming back from a card
  // lands on the same limited list; it goes when the user removes it.
  | { view: 'library'; search?: string; tags?: [string, FilterState][]; decks?: [string, FilterState][]; types?: [string, FilterState][]; sort?: LibrarySort; sortAsc?: boolean; tagOr?: boolean; deckOr?: boolean; reviewedFrom?: string; reviewedTo?: string; cards?: string[] }
  | { view: 'deck'; deckId: string }
  | { view: 'card'; cardId: string; contextDeckId?: string }
  // `skippedCardIds` is the cards set aside by a skip in the round under way.
  // It travels in the route and NOT in the user's data: it describes this
  // sitting, not what is known — a reload resumes the round, a new session
  // starts a fresh one, and nothing of it reaches IndexedDB or Drive.
  | { view: 'study'; deckId?: string; cardIds?: string[]; studyTitle?: string; strategy: StudyStrategy; currentCardId?: string | null; contextDeckId?: string | null; skippedCardIds?: string[] }
  | { view: 'modules' }
  // `annotationId` points at one detection inside the session — a "detected in"
  // link from a card, where two passes through the same tune are two distinct
  // destinations. It marks the row it names; it does not select it, which stays
  // the play head's job (see SessionSummary).
  // `search` is the library screen's search box, carried the same way the card
  // library carries its filters: a search is a place you were, so back returns
  // to the list you were looking at rather than to an empty one.
  // Everything that shapes the library screen travels in the route, exactly as
  // the card library's filters do: leaving for a detection and coming back has
  // to land on the list you left, not on its defaults. Absent means the
  // default, so a plain `{view:'sessions'}` stays a plain one.
  | {
      view: 'sessions'; sessionId?: string; annotationId?: string; search?: string;
      tab?: 'sessions' | 'tunes';
      /** Which folder the analyses list is open on; absent = the root. */
      folder?: string;
      sort?: TuneSort; sortAsc?: boolean; others?: [string, FilterState][]; othersOr?: boolean;
      analyses?: [string, FilterState][]; analysesOr?: boolean;
      dances?: [string, FilterState][]; modes?: [string, FilterState][];
    }
  // `from`/`to` are YYYY-MM-DD, snapped to the closest synced snapshot on load.
  // Deliberately excludes the deck-picker target — that stays session-only, never persisted.
  // `deflate` absent means ON — see DEFLATE_BY_DEFAULT. A refusal is therefore
  // written as an explicit `false`, never as an omission.
  | { view: 'trending'; from?: string; to?: string; gainMode?: TrendingGainMode; minTunebooks?: number; deflate?: boolean };

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
