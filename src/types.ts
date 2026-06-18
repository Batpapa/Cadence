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

export interface CardReferenceAttachment {
  type: 'card';
  id: string;          // local UUID — fast path
  guid: string;        // stable guid — cross-device
  externalId?: string; // TheSession etc. — portable
  title: string;       // snapshot of card name, fallback if unresolved
}

export type Attachment =
  | ({ type: 'file' } & FileEntry)
  | ({ type: 'embed' } & EmbedEntry)
  | CardReferenceAttachment;

export interface Card {
  id: string;
  guid: string;
  name: string;
  importance: number; // default: 1
  tags: string[];
  externalId?: string; // e.g. "thesession:1197"
  content: {
    notes: string;
    attachments: Attachment[];
  };
}

export interface DeckEntry {
  cardId: string;
  importanceOverride?: number;
}

export interface Deck {
  id: string;
  name: string;
  entries: DeckEntry[];
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

  // Schema versioning
  schemaVersion?: number;
}

/** AppState is the active User — kept as alias to minimise call-site changes. */
export type AppState = User;

// ── Routing ──────────────────────────────────────────────────────────────────

export type StudyStrategy = 'random' | 'optimal' | 'stochastic';

export type FilterState = 'include' | 'exclude';

export type Route =
  | { view: 'folder'; folderId: string | null }
  | { view: 'library'; search?: string; tags?: [string, FilterState][]; decks?: [string, FilterState][] }
  | { view: 'deck'; deckId: string }
  | { view: 'card'; cardId: string }
  | { view: 'study'; deckId: string; strategy: StudyStrategy; currentCardId?: string | null };

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
