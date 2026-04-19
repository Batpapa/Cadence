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

export type Attachment =
  | ({ type: 'file' } & FileEntry)
  | ({ type: 'embed' } & EmbedEntry);

export interface Card {
  id: string;
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

export interface User {
  id: string;
  availabilityThreshold: number; // default: 0.9 — cards above this R are excluded from study
  weightByImportance: boolean; // default: true — weight deck knowledge bars by card importance
  language: 'en' | 'fr';     // default: 'en'
}

/** Maps directly to FSRS grades: 1=Again · 2=Hard · 3=Good · 4=Easy */
export type SessionRating = 'again' | 'hard' | 'good' | 'easy';

export interface SessionEntry {
  ts: number;           // timestamp in ms
  rating: SessionRating;
}

export interface CardWork {
  userId: string;
  cardId: string;
  history: SessionEntry[];
}

export interface Folder {
  userId: string;
  id: string;
  name: string;
  folderIds: string[];
  deckIds: string[];
}

// ── App state ────────────────────────────────────────────────────────────────

export interface AppState {
  schemaVersion?: number;
  users: Record<string, User>;
  currentUserId: string;
  cards: Record<string, Card>;
  decks: Record<string, Deck>;
  cardWorks: Record<string, CardWork>; // key: `${userId}:${cardId}`
  folders: Record<string, Folder>;
  rootFolderIds: string[];
  rootDeckIds: string[];
}

// ── Routing ──────────────────────────────────────────────────────────────────

export type StudyStrategy = 'random' | 'optimal' | 'stochastic';

export type Route =
  | { view: 'folder'; folderId: string | null }
  | { view: 'library' }
  | { view: 'deck'; deckId: string }
  | { view: 'card'; cardId: string }
  | { view: 'study'; deckId: string; strategy: StudyStrategy; currentCardId?: string | null };

export interface AppContext {
  state: AppState;
  route: Route;
  navigate: (route: Route) => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  mutate: (fn: (state: AppState) => void) => Promise<void>;
  save: (fn: (state: AppState) => void) => Promise<void>;
}
