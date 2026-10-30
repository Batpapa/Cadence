import { appState } from '../store';
import type { User } from '../types';
import { pickOptimal } from '../services/deckService';
import { isDriveFeatureEnabled } from '../services/driveService';
import { onScreen, type TourTarget } from './targets';
import { irishTradEnabled, theSessionOffered, irishTuneInfoOffered, tuneAnalyserOffered, trendingOffered, type ExtensionId } from '../services/extensions';
import { sessionsOf } from '../session/detections';
import { CARD_TYPE_TUNE, isTuneset } from '../services/cardTypeService';
import { decksInSidebarOrder, revealDeckInSidebar } from '../components/sidebar';

// ── Guided walkthroughs (2026-10-27) ─────────────────────────────────────────
// Short scenarios in which the user does the real thing, step by step: the
// step's element is lit, a bubble says what to do, and nothing else on screen
// answers until it is done (engine.ts). Listed in the help's « Visites
// guidées » tab; one never finished shows a dot there, on its row and on the
// ? button, until it is.
//
// Some are for everyone, some come with an extension option (`offered`), the
// same way the help's extension lines do. A brand-new user is taken through
// the first one as soon as they have said what Cadence is for (main.ts).
//
// A step points at an element by its `data-tour` name, never by a selector on
// classes or text: those change with every redesign, and a walkthrough that
// silently lost its target would be found by a new user, not by a test.
// Several elements may carry one name — the header's Home button and the
// bottom bar's — and the one on screen is used (targets.ts).
//
// What a step talks about is ON SCREEN, lit (the author's rule, 2026-10-27):
// a menu is opened before its entries are described, the side panel before
// its tree. Whatever extra steps that takes.
//
// What the user makes on the way is real and stays: the card of « Créer une
// carte », the deck of « Ranger dans un paquet », the review of « Réviser ».

export interface TourStep {
  /** None: the bubble sits in the middle of the screen. Several: the first
   *  one on screen. A function: a name only known once the run has begun —
   *  the deck the user has just created. */
  target?: TourTarget | TourTarget[] | (() => TourTarget);
  titleKey: string;
  textKey: string;
  /** Sentences added to the text when their element is on screen too — an
   *  entry a menu only has sometimes. */
  extras?: { textKey: string; when: TourTarget }[];
  /** What the user does with the lit element:
   *  - none: nothing, it is only shown; a « Suivant » button moves on;
   *  - 'click': press it — which does what it always does — to move on;
   *  - 'do': anything inside it (type, tick, pick), and move on with
   *    « Suivant », or by themselves once `until` holds. */
  action?: 'click' | 'do';
  /** For 'do': the step is done — checked on every frame. No « Suivant »
   *  then: the result is what moves the walkthrough on. */
  until?: () => boolean;
  /** Inside the lit element, what stays out of reach: a dialog's ✕ and its
   *  Cancel, which would end what the step is about. */
  deny?: TourTarget[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Skipped, when its turn comes, if its element is not on screen — what a
   *  page shows only sometimes, a score's version arrows with one version. */
  optional?: boolean;
  /** How long to wait for the element, in ms, when longer than usual: a
   *  module downloading what it shows. */
  wait?: number;
  /** Left out of the run when false at its start — a button that only exists
   *  once there are cards, say. Decided up front so the count is right. */
  available?: () => boolean;
  /** Run on « Suivant » — or, on a 'click' step, once the press has done
   *  what it does — before the next step: the walkthrough tidying up after
   *  itself — closing the menu it had them open, emptying the search it had
   *  them type, putting away the side panel where it covers the page. */
  after?: (act: TourAct) => void;
}

/** What the walkthrough may do in the user's place, between two steps. */
export interface TourAct {
  /** Press an element. */
  click: (target: TourTarget) => void;
  /** Press somewhere neutral: what closes on a press outside closes. */
  pressOutside: () => void;
  /** Empty a text field, as if the user had. */
  clear: (target: TourTarget) => void;
}

export interface Scenario {
  id: string;
  titleKey: string;
  descKey: string;
  /** False when it belongs to an extension option that is off. */
  offered: () => boolean;
  /** The extension it comes with: listed under it in the help, its bubble
   *  framed in the extension's colour. */
  extension?: ExtensionId;
  /** What it needs before it can be run — at least one card to file or to
   *  review — and the line saying so in its place in the list. */
  requires?: { met: () => boolean; hintKey: string };
  steps: () => TourStep[];
}

const cardCount = () => Object.keys(appState.value.cards).length;
const deckIds = () => Object.keys(appState.value.decks);
const reviewCount = () => Object.values(appState.value.cardWorks).reduce((n, w) => n + w.history.length, 0);
const needsACard = { met: () => cardCount() > 0, hintKey: 'walkthrough.needsCard' };

/** A deck with cards in it, the first the side panel lists, wherever it is
 *  filed: the panel reaches any depth in one press (2026-10-30) — Home only
 *  showed the decks at its root, and the example library has none there. */
function deckWithCards(): string | undefined {
  const u = appState.value;
  return decksInSidebarOrder(u).find(id => (u.decks[id]?.entries.length ?? 0) > 0);
}
const needsADeck = { met: () => !!deckWithCards(), hintKey: 'walkthrough.needsDeck' };

/** The steps that open `deckId` from the side panel: the panel opened if it
 *  is put away, the deck's row shown — its two dots, when `dots` — then
 *  pressed. Its folders are unfolded up front, the row must be there to light.
 *  Where the panel slides over the page (a narrow window), it is put away
 *  once the deck is open: what follows is on the page beneath (the author,
 *  2026-10-30). */
function openDeckFromSidebar(deckId: string, openKeys: { titleKey: string; textKey: string }, dots: boolean): TourStep[] {
  revealDeckInSidebar(deckId, appState.value);
  const row = `sidebar-deck-${deckId}`;
  return [
    { target: 'sidebar', action: 'click', titleKey: 'walkthrough.discover.sidebar.title', textKey: 'walkthrough.discover.sidebar.open',
      available: () => !onScreen('sidebar-panel') },
    ...(dots ? [{ target: row, side: 'right' as const, titleKey: 'walkthrough.progress.dots.title', textKey: 'walkthrough.progress.dots.text' }] : []),
    { target: row, side: 'right', action: 'click', ...openKeys, after: act => act.click('sidebar-backdrop') },
  ];
}
const profileIds = () => appState.value.profileIds ?? [];
const tuneCount = () => Object.values(appState.value.cards).filter(c => c.type === CARD_TYPE_TUNE).length;
const analysisCount = () => Object.keys(sessionsOf(appState.value)).length;

/** Whether « Tout étudier » would find anything to review right now, with
 *  the user's own setting for mastered cards — the session's own question. */
function anythingToReview(): boolean {
  const u = appState.value;
  const pool = { id: '__walkthrough', name: '', entries: Object.keys(u.cards).map(cardId => ({ cardId })) };
  return pickOptimal(u, u.currentProfileId, pool, u.cards, u.cardWorks, true, u.excludeMastered ?? true) !== null;
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: 'discover',
    titleKey: 'walkthrough.discover.title',
    descKey: 'walkthrough.discover.desc',
    offered: () => true,
    // The header decides at its width what it keeps and what goes into ⋮
    // (Search first, then Help): the run is laid out for the header as it is
    // when it starts, on Home.
    steps: () => [
      { titleKey: 'walkthrough.discover.welcome.title', textKey: 'walkthrough.discover.welcome.text' },
      { target: 'nav-library', action: 'click', titleKey: 'walkthrough.discover.library.title', textKey: 'walkthrough.discover.library.text' },
      { target: 'new-card', titleKey: 'walkthrough.discover.newCard.title', textKey: 'walkthrough.discover.newCard.text' },
      { target: 'nav-home', action: 'click', titleKey: 'walkthrough.discover.home.title', textKey: 'walkthrough.discover.home.text' },
      { target: 'dashboard', titleKey: 'walkthrough.discover.dashboard.title', textKey: 'walkthrough.discover.dashboard.text' },
      { target: 'activity', titleKey: 'walkthrough.discover.activity.title', textKey: 'walkthrough.discover.activity.text' },
      { target: 'study-all', titleKey: 'walkthrough.discover.study.title', textKey: 'walkthrough.discover.study.text',
        available: () => cardCount() > 0 },
      { target: 'folders', titleKey: 'walkthrough.discover.folders.title', textKey: 'walkthrough.discover.folders.text' },
      { target: 'decks', titleKey: 'walkthrough.discover.decks.title', textKey: 'walkthrough.discover.decks.text' },
      // The side panel: opened by the user if it is put away, then shown.
      // Left open — it is where they will find their decks from now on —
      // except where it slides over the page, which the steps after need.
      { target: 'sidebar', action: 'click', titleKey: 'walkthrough.discover.sidebar.title', textKey: 'walkthrough.discover.sidebar.open',
        available: () => !onScreen('sidebar-panel') },
      { target: 'sidebar', titleKey: 'walkthrough.discover.sidebar.title', textKey: 'walkthrough.discover.sidebar.toggle',
        available: () => onScreen('sidebar-panel') },
      { target: 'sidebar-panel', side: 'right', titleKey: 'walkthrough.discover.sidebarPanel.title', textKey: 'walkthrough.discover.sidebarPanel.text',
        after: act => act.click('sidebar-backdrop') },
      { target: 'nav-modules', titleKey: 'walkthrough.discover.modules.title', textKey: 'walkthrough.discover.modules.text' },
      { target: 'search', titleKey: 'walkthrough.discover.search.title', textKey: 'walkthrough.discover.search.text',
        available: () => onScreen('search') },
      { target: 'more', action: 'click', titleKey: 'walkthrough.discover.menu.title', textKey: 'walkthrough.discover.menu.open' },
      { target: 'menu', side: 'left', titleKey: 'walkthrough.discover.menu.title', textKey: 'walkthrough.discover.menu.text',
        extras: [{ textKey: 'walkthrough.discover.menu.install', when: 'menu-install' }],
        // Closed again on the way to ?, unless Search is still to be shown in it.
        after: act => { if (onScreen('search') && onScreen('help')) act.click('more'); } },
      { target: 'menu-search', titleKey: 'walkthrough.discover.search.title', textKey: 'walkthrough.discover.search.inMenu',
        available: () => !onScreen('search'),
        after: act => { if (onScreen('help')) act.click('more'); } },
      { target: 'help', titleKey: 'walkthrough.discover.help.title', textKey: 'walkthrough.discover.help.text',
        available: () => onScreen('help') },
      { target: 'menu-help', titleKey: 'walkthrough.discover.help.title', textKey: 'walkthrough.discover.help.inMenu',
        available: () => !onScreen('help') },
    ],
  },

  {
    id: 'createCard',
    titleKey: 'walkthrough.createCard.title',
    descKey: 'walkthrough.createCard.desc',
    offered: () => true,
    steps: () => {
      const before = cardCount();
      const created = () => cardCount() > before;
      // With no deck at all, Cadence asks nothing and the card is made at once.
      const hasDecks = () => deckIds().length > 0;
      return [
        { target: 'nav-library', action: 'click', titleKey: 'walkthrough.createCard.library.title', textKey: 'walkthrough.createCard.library.text' },
        { target: 'new-card', action: 'click', titleKey: 'walkthrough.createCard.newCard.title', textKey: 'walkthrough.createCard.newCard.text' },
        { target: 'newcard-create', action: 'click', titleKey: 'walkthrough.createCard.create.title', textKey: 'walkthrough.createCard.create.text' },
        { target: 'newcard-form', action: 'do', until: () => created() || onScreen('modal'),
          titleKey: 'walkthrough.createCard.name.title', textKey: 'walkthrough.createCard.name.textDecks', available: hasDecks },
        { target: 'newcard-form', action: 'do', until: created,
          titleKey: 'walkthrough.createCard.name.title', textKey: 'walkthrough.createCard.name.text', available: () => !hasDecks() },
        { target: 'modal', action: 'do', until: created, deny: ['modal-close'],
          titleKey: 'walkthrough.createCard.decks.title', textKey: 'walkthrough.createCard.decks.text', available: hasDecks },
        { target: 'newcard-open', action: 'click', titleKey: 'walkthrough.createCard.open.title', textKey: 'walkthrough.createCard.open.text' },
        // The card it opened on — the one just made.
        { target: 'card-name', titleKey: 'walkthrough.createCard.cardName.title', textKey: 'walkthrough.createCard.cardName.text' },
        { target: 'card-decks', titleKey: 'walkthrough.createCard.cardDecks.title', textKey: 'walkthrough.createCard.cardDecks.text' },
        { target: 'card-stats', titleKey: 'walkthrough.createCard.stats.title', textKey: 'walkthrough.createCard.stats.text' },
        { target: 'card-type', titleKey: 'walkthrough.createCard.type.title', textKey: 'walkthrough.createCard.type.text' },
        { target: 'card-tags', titleKey: 'walkthrough.createCard.tags.title', textKey: 'walkthrough.createCard.tags.text' },
        { target: 'card-notes-edit', action: 'click', titleKey: 'walkthrough.createCard.notes.title', textKey: 'walkthrough.createCard.notes.edit' },
        { target: 'card-notes-text', action: 'do', titleKey: 'walkthrough.createCard.notes.title', textKey: 'walkthrough.createCard.notes.write' },
        { target: 'card-notes-edit', action: 'click', titleKey: 'walkthrough.createCard.notes.title', textKey: 'walkthrough.createCard.notes.save' },
        { target: 'card-notes', titleKey: 'walkthrough.createCard.notes.title', textKey: 'walkthrough.createCard.notes.result' },
        { target: 'card-attachments', titleKey: 'walkthrough.createCard.attachments.title', textKey: 'walkthrough.createCard.attachments.text' },
        { target: 'card-history', titleKey: 'walkthrough.createCard.history.title', textKey: 'walkthrough.createCard.history.text' },
      ];
    },
  },

  {
    id: 'fileInDeck',
    titleKey: 'walkthrough.fileInDeck.title',
    descKey: 'walkthrough.fileInDeck.desc',
    offered: () => true,
    requires: needsACard,
    steps: () => {
      const before = new Set(deckIds());
      const newDeck = () => deckIds().find(id => !before.has(id));
      const entries = () => appState.value.decks[newDeck() ?? '']?.entries.length ?? 0;
      return [
        { target: 'new-deck', action: 'click', titleKey: 'walkthrough.fileInDeck.newDeck.title', textKey: 'walkthrough.fileInDeck.newDeck.text' },
        { target: 'modal', action: 'do', until: () => !!newDeck(), deny: ['modal-close', 'modal-cancel'],
          titleKey: 'walkthrough.fileInDeck.name.title', textKey: 'walkthrough.fileInDeck.name.text' },
        { target: () => `deck-${newDeck()}`, action: 'click', titleKey: 'walkthrough.fileInDeck.open.title', textKey: 'walkthrough.fileInDeck.open.text' },
        // The field's list of matches hangs below it, over the card list: the
        // whole cards area is lit (styles.css keeps it tall enough), its other
        // buttons and rows held.
        { target: 'deck-cards', action: 'do', until: () => entries() > 0, deny: ['deck-library-btn', 'deck-add-btn', 'deck-card-list'],
          titleKey: 'walkthrough.fileInDeck.link.title', textKey: 'walkthrough.fileInDeck.link.text' },
        { target: 'deck-card-list', titleKey: 'walkthrough.fileInDeck.list.title', textKey: 'walkthrough.fileInDeck.list.text' },
        { target: 'deck-add-btn', titleKey: 'walkthrough.fileInDeck.add.title', textKey: 'walkthrough.fileInDeck.add.text' },
        { target: 'deck-location', titleKey: 'walkthrough.fileInDeck.location.title', textKey: 'walkthrough.fileInDeck.location.text' },
        { target: 'deck-star', action: 'click', titleKey: 'walkthrough.fileInDeck.star.title', textKey: 'walkthrough.fileInDeck.star.text' },
        { target: 'nav-home', action: 'click', titleKey: 'walkthrough.fileInDeck.home.title', textKey: 'walkthrough.fileInDeck.home.text' },
        { target: 'favorites', titleKey: 'walkthrough.fileInDeck.favorites.title', textKey: 'walkthrough.fileInDeck.favorites.text' },
      ];
    },
  },

  {
    id: 'review',
    titleKey: 'walkthrough.review.title',
    descKey: 'walkthrough.review.desc',
    offered: () => true,
    requires: needsACard,
    steps: () => {
      const before = reviewCount();
      return [
        { target: 'study-all', action: 'click', titleKey: 'walkthrough.review.start.title', textKey: 'walkthrough.review.start.text' },
        { target: 'study-options', titleKey: 'walkthrough.review.options.title', textKey: 'walkthrough.review.options.text' },
        // Everything already known: nothing would come up. Mastered cards are
        // let in, by the user, for this session and the next.
        { target: 'study-exclude', action: 'do', until: () => appState.value.excludeMastered === false,
          titleKey: 'walkthrough.review.exclude.title', textKey: 'walkthrough.review.exclude.text', available: () => !anythingToReview() },
        { target: 'study-optimal', action: 'click', titleKey: 'walkthrough.review.optimal.title', textKey: 'walkthrough.review.optimal.text' },
        { target: 'study-card', titleKey: 'walkthrough.review.card.title', textKey: 'walkthrough.review.card.text' },
        { target: 'study-ratings', action: 'do', until: () => reviewCount() > before,
          titleKey: 'walkthrough.review.rate.title', textKey: 'walkthrough.review.rate.text' },
        { target: 'study-top', titleKey: 'walkthrough.review.top.title', textKey: 'walkthrough.review.top.text' },
      ];
    },
  },

  {
    id: 'protectData',
    titleKey: 'walkthrough.protectData.title',
    descKey: 'walkthrough.protectData.desc',
    offered: () => true,
    // Ends on Drive, settings open, so that connecting is the very next thing
    // the user can do. Not a step of its own: Google's window, and the
    // question Cadence may ask when Drive already holds data, would open
    // under the walkthrough's veil.
    steps: () => [
      { target: 'more', action: 'click', titleKey: 'walkthrough.protectData.menu.title', textKey: 'walkthrough.protectData.menu.text' },
      { target: 'menu-settings', action: 'click', titleKey: 'walkthrough.protectData.settings.title', textKey: 'walkthrough.protectData.settings.text' },
      { target: 'settings-nav-storage', action: 'click', titleKey: 'walkthrough.protectData.storage.title', textKey: 'walkthrough.protectData.storage.text' },
      { target: 'backup-buttons', titleKey: 'walkthrough.protectData.backup.title', textKey: 'walkthrough.protectData.backup.text' },
      { target: 'settings-nav-user', action: 'click', titleKey: 'walkthrough.protectData.user.title', textKey: 'walkthrough.protectData.user.text',
        available: isDriveFeatureEnabled },
      { target: 'settings-drive', titleKey: 'walkthrough.protectData.drive.title', textKey: 'walkthrough.protectData.drive.text',
        available: isDriveFeatureEnabled },
    ],
  },

  {
    id: 'library',
    titleKey: 'walkthrough.library.title',
    descKey: 'walkthrough.library.desc',
    offered: () => true,
    requires: needsACard,
    // Ends on the export choices, left open: making a share key sends the
    // cards to the share server, which is the user's to decide.
    steps: () => [
      { target: 'nav-library', action: 'click', titleKey: 'walkthrough.library.open.title', textKey: 'walkthrough.library.open.text' },
      { target: 'library-search', action: 'do', titleKey: 'walkthrough.library.search.title', textKey: 'walkthrough.library.search.text',
        after: act => act.clear('library-search') },
      { target: 'library-filters', action: 'do', titleKey: 'walkthrough.library.filters.title', textKey: 'walkthrough.library.filters.text' },
      { target: 'library-sort', action: 'click', titleKey: 'walkthrough.library.sort.title', textKey: 'walkthrough.library.sort.text' },
      { target: 'library-sort-menu', action: 'do', until: () => !onScreen('library-sort-menu'),
        titleKey: 'walkthrough.library.sortMenu.title', textKey: 'walkthrough.library.sortMenu.text' },
      { target: 'library-sort-dir', titleKey: 'walkthrough.library.sortDir.title', textKey: 'walkthrough.library.sortDir.text' },
      { target: 'library-map', action: 'click', titleKey: 'walkthrough.library.map.title', textKey: 'walkthrough.library.map.text' },
      { target: 'library-cardmap', titleKey: 'walkthrough.library.cardMap.title', textKey: 'walkthrough.library.cardMap.text',
        after: act => act.click('library-map') },
      { target: 'library-select-all', action: 'do', until: () => onScreen('library-actions'),
        titleKey: 'walkthrough.library.select.title', textKey: 'walkthrough.library.select.text' },
      { target: 'library-actions', titleKey: 'walkthrough.library.actions.title', textKey: 'walkthrough.library.actions.text' },
      { target: 'library-bulk', action: 'click', titleKey: 'walkthrough.library.bulk.title', textKey: 'walkthrough.library.bulk.text' },
      { target: 'context-menu', titleKey: 'walkthrough.library.bulkMenu.title', textKey: 'walkthrough.library.bulkMenu.text',
        after: act => act.pressOutside() },
      { target: 'library-export', action: 'click', titleKey: 'walkthrough.library.export.title', textKey: 'walkthrough.library.export.text' },
      { target: 'export-body', titleKey: 'walkthrough.library.formats.title', textKey: 'walkthrough.library.formats.text' },
      { target: 'export-cdc', action: 'click', titleKey: 'walkthrough.library.cdc.title', textKey: 'walkthrough.library.cdc.text' },
      { target: 'export-body', titleKey: 'walkthrough.library.share.title', textKey: 'walkthrough.library.share.text' },
    ],
  },

  {
    id: 'progress',
    titleKey: 'walkthrough.progress.title',
    descKey: 'walkthrough.progress.desc',
    offered: () => true,
    requires: needsADeck,
    steps: () => {
      const deckId = deckWithCards()!;
      return [
        { target: 'dashboard', titleKey: 'walkthrough.progress.dashboard.title', textKey: 'walkthrough.progress.dashboard.text' },
        { target: 'activity', action: 'do', deny: ['activity-library'], titleKey: 'walkthrough.progress.activity.title', textKey: 'walkthrough.progress.activity.text' },
        ...openDeckFromSidebar(deckId, { titleKey: 'walkthrough.progress.openDeck.title', textKey: 'walkthrough.progress.openDeck.text' }, true),
        { target: 'deck-stats', titleKey: 'walkthrough.progress.deckStats.title', textKey: 'walkthrough.progress.deckStats.text' },
        { target: 'deck-card-list', titleKey: 'walkthrough.progress.deckCards.title', textKey: 'walkthrough.progress.deckCards.text' },
        { target: 'deck-row-name', action: 'click', titleKey: 'walkthrough.progress.openCard.title', textKey: 'walkthrough.progress.openCard.text' },
        { target: 'card-stats', titleKey: 'walkthrough.progress.cardStats.title', textKey: 'walkthrough.progress.cardStats.text' },
        { target: 'card-history', titleKey: 'walkthrough.progress.history.title', textKey: 'walkthrough.progress.history.text' },
        { target: 'more', action: 'click', titleKey: 'walkthrough.progress.menu.title', textKey: 'walkthrough.progress.menu.text' },
        { target: 'menu-settings', action: 'click', titleKey: 'walkthrough.progress.settings.title', textKey: 'walkthrough.progress.settings.text' },
        { target: 'settings-threshold', titleKey: 'walkthrough.progress.threshold.title', textKey: 'walkthrough.progress.threshold.text' },
      ];
    },
  },

  {
    id: 'importance',
    titleKey: 'walkthrough.importance.title',
    descKey: 'walkthrough.importance.desc',
    offered: () => true,
    requires: needsADeck,
    steps: () => {
      const deckId = deckWithCards()!;
      // The first card of the deck — the first row, the one the steps light.
      const entry = () => appState.value.decks[deckId]?.entries[0];
      const before = entry()?.importance;
      return [
        { titleKey: 'walkthrough.importance.intro.title', textKey: 'walkthrough.importance.intro.text' },
        ...openDeckFromSidebar(deckId, { titleKey: 'walkthrough.importance.openDeck.title', textKey: 'walkthrough.importance.openDeck.text' }, false),
        { target: 'deck-card-list', titleKey: 'walkthrough.importance.column.title', textKey: 'walkthrough.importance.column.text' },
        { target: 'deck-importance', action: 'do', until: () => entry()?.importance !== before,
          titleKey: 'walkthrough.importance.set.title', textKey: 'walkthrough.importance.set.text' },
        // Undone by the user, unless the card had a value of its own here
        // before: clearing it would lose what they had set.
        { target: 'deck-importance', action: 'do', until: () => entry()?.importance === undefined,
          titleKey: 'walkthrough.importance.reset.title', textKey: 'walkthrough.importance.reset.text', available: () => before === undefined },
        { target: 'deck-importance', titleKey: 'walkthrough.importance.reset.title', textKey: 'walkthrough.importance.resetInfo',
          available: () => before !== undefined },
        { target: 'deck-row-name', action: 'click', titleKey: 'walkthrough.importance.openCard.title', textKey: 'walkthrough.importance.openCard.text' },
        { target: 'card-importance', titleKey: 'walkthrough.importance.base.title', textKey: 'walkthrough.importance.base.text' },
      ];
    },
  },

  {
    id: 'profiles',
    titleKey: 'walkthrough.profiles.title',
    descKey: 'walkthrough.profiles.desc',
    offered: () => true,
    // Makes a profile, goes into it, comes back and deletes it: the user ends
    // where they started, having seen each move once.
    steps: () => {
      const original = appState.value.currentProfileId;
      const before = new Set(profileIds());
      const made = () => profileIds().find(id => !before.has(id));
      return [
        { target: 'profile', action: 'click', titleKey: 'walkthrough.profiles.button.title', textKey: 'walkthrough.profiles.button.text' },
        { target: 'profile-manage', action: 'click', titleKey: 'walkthrough.profiles.menu.title', textKey: 'walkthrough.profiles.menu.text' },
        { target: 'profile-add', action: 'do', until: () => !!made(), titleKey: 'walkthrough.profiles.add.title', textKey: 'walkthrough.profiles.add.text' },
        { target: 'modal-close', action: 'click', titleKey: 'walkthrough.profiles.close.title', textKey: 'walkthrough.profiles.close.text' },
        { target: 'profile', action: 'click', titleKey: 'walkthrough.profiles.switch.title', textKey: 'walkthrough.profiles.switch.text' },
        { target: () => `profile-${made()}`, action: 'click', titleKey: 'walkthrough.profiles.pick.title', textKey: 'walkthrough.profiles.pick.text' },
        { target: 'dashboard', titleKey: 'walkthrough.profiles.empty.title', textKey: 'walkthrough.profiles.empty.text' },
        { target: 'profile', action: 'click', titleKey: 'walkthrough.profiles.back.title', textKey: 'walkthrough.profiles.back.text' },
        { target: `profile-${original}`, action: 'click', titleKey: 'walkthrough.profiles.pickBack.title', textKey: 'walkthrough.profiles.pickBack.text' },
        { target: 'profile', action: 'click', titleKey: 'walkthrough.profiles.tidy.title', textKey: 'walkthrough.profiles.tidy.text' },
        { target: 'profile-manage', action: 'click', titleKey: 'walkthrough.profiles.tidy.title', textKey: 'walkthrough.profiles.manage.text' },
        { target: () => `profile-delete-${made()}`, action: 'click', titleKey: 'walkthrough.profiles.delete.title', textKey: 'walkthrough.profiles.delete.text' },
        { target: 'modal-confirm', action: 'click', titleKey: 'walkthrough.profiles.confirm.title', textKey: 'walkthrough.profiles.confirm.text' },
        { target: 'modal', titleKey: 'walkthrough.profiles.done.title', textKey: 'walkthrough.profiles.done.text' },
      ];
    },
  },

  // ── Irish traditional music (services/extensions.ts) ──

  {
    id: 'theSession',
    titleKey: 'walkthrough.theSession.title',
    descKey: 'walkthrough.theSession.desc',
    extension: 'irishTrad',
    offered: theSessionOffered,
    // Ends in the score, left open: playing on is the point.
    steps: () => {
      const before = cardCount();
      const created = () => cardCount() > before;
      const hasDecks = () => deckIds().length > 0;
      return [
        { target: 'nav-library', action: 'click', titleKey: 'walkthrough.theSession.library.title', textKey: 'walkthrough.theSession.library.text' },
        { target: 'new-card', action: 'click', titleKey: 'walkthrough.theSession.newCard.title', textKey: 'walkthrough.theSession.newCard.text' },
        { target: 'newcard-import', action: 'click', titleKey: 'walkthrough.theSession.import.title', textKey: 'walkthrough.theSession.import.text' },
        { target: 'newcard-iti', titleKey: 'walkthrough.theSession.iti.title', textKey: 'walkthrough.theSession.iti.text', available: irishTuneInfoOffered },
        { target: 'newcard-thesession', action: 'click', titleKey: 'walkthrough.theSession.source.title', textKey: 'walkthrough.theSession.source.text' },
        { target: 'ts-tabs', titleKey: 'walkthrough.theSession.tabs.title', textKey: 'walkthrough.theSession.tabs.text' },
        // Above the field: its list of matches opens below it.
        { target: 'ts-tune', action: 'do', side: 'top', until: () => created() || onScreen('modal'),
          titleKey: 'walkthrough.theSession.tune.title', textKey: 'walkthrough.theSession.tune.text' },
        { target: 'modal', action: 'do', until: created, deny: ['modal-close'],
          titleKey: 'walkthrough.createCard.decks.title', textKey: 'walkthrough.createCard.decks.text', available: hasDecks },
        { target: 'ts-imported', action: 'click', titleKey: 'walkthrough.theSession.open.title', textKey: 'walkthrough.theSession.open.text' },
        { target: 'card-source', action: 'do', until: () => onScreen('context-menu'),
          titleKey: 'walkthrough.theSession.badge.title', textKey: 'walkthrough.theSession.badge.text' },
        { target: 'context-menu', titleKey: 'walkthrough.theSession.refresh.title', textKey: 'walkthrough.theSession.refresh.text',
          after: act => act.pressOutside() },
        { target: 'card-importance', titleKey: 'walkthrough.theSession.importance.title', textKey: 'walkthrough.theSession.importance.text' },
        { target: 'incipit', optional: true, titleKey: 'walkthrough.theSession.incipit.title', textKey: 'walkthrough.theSession.incipit.text' },
        { target: 'attachment-abc', action: 'click', titleKey: 'walkthrough.theSession.score.title', textKey: 'walkthrough.theSession.score.text' },
        { target: 'abc-score', action: 'do', titleKey: 'walkthrough.theSession.cursor.title', textKey: 'walkthrough.theSession.cursor.text' },
        { target: 'abc-play', action: 'do', titleKey: 'walkthrough.theSession.play.title', textKey: 'walkthrough.theSession.play.text' },
        { target: 'abc-practice', action: 'do', deny: ['abc-transpose'], titleKey: 'walkthrough.theSession.practice.title', textKey: 'walkthrough.theSession.practice.text' },
        { target: 'abc-bounds', action: 'do', titleKey: 'walkthrough.theSession.bounds.title', textKey: 'walkthrough.theSession.bounds.text' },
        { target: 'abc-versions', optional: true, titleKey: 'walkthrough.theSession.versions.title', textKey: 'walkthrough.theSession.versions.text' },
        { target: 'abc-tabs', titleKey: 'walkthrough.theSession.text.title', textKey: 'walkthrough.theSession.text.text' },
        { target: 'abc-fullscreen', titleKey: 'walkthrough.theSession.fullscreen.title', textKey: 'walkthrough.theSession.fullscreen.text' },
        { target: 'abc-gear', titleKey: 'walkthrough.theSession.prefs.title', textKey: 'walkthrough.theSession.prefs.text' },
      ];
    },
  },

  {
    id: 'tuneSets',
    titleKey: 'walkthrough.tuneSets.title',
    descKey: 'walkthrough.tuneSets.desc',
    extension: 'irishTrad',
    offered: irishTradEnabled,
    requires: { met: () => tuneCount() >= 2, hintKey: 'walkthrough.needsTunes' },
    steps: () => {
      const before = new Set(Object.keys(appState.value.cards));
      const made = () => Object.values(appState.value.cards).find(c => !before.has(c.id));
      const created = () => !!made();
      const tunes = () => made()?.tunes?.length ?? 0;
      const hasDecks = () => deckIds().length > 0;
      return [
        { target: 'nav-library', action: 'click', titleKey: 'walkthrough.tuneSets.library.title', textKey: 'walkthrough.tuneSets.library.text' },
        { target: 'new-card', action: 'click', titleKey: 'walkthrough.createCard.newCard.title', textKey: 'walkthrough.createCard.newCard.text' },
        { target: 'newcard-create', action: 'click', titleKey: 'walkthrough.createCard.create.title', textKey: 'walkthrough.createCard.create.text' },
        { target: 'newcard-form', action: 'do', until: () => created() || onScreen('modal'),
          titleKey: 'walkthrough.tuneSets.name.title', textKey: 'walkthrough.tuneSets.name.text' },
        { target: 'modal', action: 'do', until: created, deny: ['modal-close'],
          titleKey: 'walkthrough.createCard.decks.title', textKey: 'walkthrough.createCard.decks.text', available: hasDecks },
        { target: 'newcard-open', action: 'click', titleKey: 'walkthrough.createCard.open.title', textKey: 'walkthrough.createCard.open.text' },
        { target: 'card-type-btn', action: 'click', titleKey: 'walkthrough.tuneSets.type.title', textKey: 'walkthrough.tuneSets.type.text' },
        { target: 'context-menu', action: 'do', until: () => { const c = made(); return !!c && isTuneset(c); },
          titleKey: 'walkthrough.tuneSets.pick.title', textKey: 'walkthrough.tuneSets.pick.text' },
        { target: 'card-tunes', titleKey: 'walkthrough.tuneSets.tunes.title', textKey: 'walkthrough.tuneSets.tunes.text' },
        { target: 'card-tunes-add', action: 'click', titleKey: 'walkthrough.tuneSets.add.title', textKey: 'walkthrough.tuneSets.add.text' },
        { target: 'modal', action: 'do', until: () => tunes() >= 1, deny: ['modal-close'],
          titleKey: 'walkthrough.tuneSets.pickTune.title', textKey: 'walkthrough.tuneSets.pickTune.text' },
        { target: 'card-tunes-add', action: 'click', titleKey: 'walkthrough.tuneSets.add2.title', textKey: 'walkthrough.tuneSets.add2.text' },
        { target: 'modal', action: 'do', until: () => tunes() >= 2, deny: ['modal-close'],
          titleKey: 'walkthrough.tuneSets.pickTune.title', textKey: 'walkthrough.tuneSets.pickTune.text' },
        { target: 'card-tunes', titleKey: 'walkthrough.tuneSets.list.title', textKey: 'walkthrough.tuneSets.list.text' },
        { target: 'card-autoname', optional: true, titleKey: 'walkthrough.tuneSets.autoName.title', textKey: 'walkthrough.tuneSets.autoName.text' },
        { target: 'incipit', optional: true, titleKey: 'walkthrough.tuneSets.incipit.title', textKey: 'walkthrough.tuneSets.incipit.text' },
        { target: 'attachment-abc', optional: true, titleKey: 'walkthrough.tuneSets.score.title', textKey: 'walkthrough.tuneSets.score.text' },
      ];
    },
  },

  {
    id: 'analyser',
    titleKey: 'walkthrough.analyser.title',
    descKey: 'walkthrough.analyser.desc',
    extension: 'irishTrad',
    offered: tuneAnalyserOffered,
    // Records nothing and imports nothing: a recording wants the microphone
    // and live music, an import a file picked from the device — nobody could
    // finish on the spot. Those are shown; an existing analysis is gone into.
    steps: () => {
      const hasAnalyses = () => analysisCount() > 0;
      return [
        { target: 'nav-modules', action: 'click', titleKey: 'walkthrough.analyser.modules.title', textKey: 'walkthrough.analyser.modules.text' },
        { target: 'module-sessions', action: 'click', deny: ['module-pin-sessions'], titleKey: 'walkthrough.analyser.open.title', textKey: 'walkthrough.analyser.open.text' },
        { target: 'analyser-start', titleKey: 'walkthrough.analyser.start.title', textKey: 'walkthrough.analyser.start.text' },
        { target: 'analyser-pitch', titleKey: 'walkthrough.analyser.pitch.title', textKey: 'walkthrough.analyser.pitch.text' },
        { target: 'analyser-gear', titleKey: 'walkthrough.analyser.gear.title', textKey: 'walkthrough.analyser.gear.text' },
        { target: 'analyser-tabs', action: 'do', titleKey: 'walkthrough.analyser.tabs.title', textKey: 'walkthrough.analyser.tabs.text',
          after: act => act.click('analyser-tab-sessions') },
        { target: 'analyser-start', titleKey: 'walkthrough.analyser.first.title', textKey: 'walkthrough.analyser.first.text', available: () => !hasAnalyses() },
        { target: 'analysis-row', action: 'click', titleKey: 'walkthrough.analyser.analysis.title', textKey: 'walkthrough.analyser.analysis.text', available: hasAnalyses },
        { target: 'summary-views', titleKey: 'walkthrough.analyser.views.title', textKey: 'walkthrough.analyser.views.text', available: hasAnalyses },
        { target: 'summary-player', titleKey: 'walkthrough.analyser.player.title', textKey: 'walkthrough.analyser.player.text', available: hasAnalyses },
        { target: 'summary-audio', optional: true, titleKey: 'walkthrough.analyser.audio.title', textKey: 'walkthrough.analyser.audio.text', available: hasAnalyses },
        { target: 'detection', titleKey: 'walkthrough.analyser.detection.title', textKey: 'walkthrough.analyser.detection.text', available: hasAnalyses },
        { target: 'detection', titleKey: 'walkthrough.analyser.detectedIn.title', textKey: 'walkthrough.analyser.detectedIn.text', available: hasAnalyses },
      ];
    },
  },

  {
    id: 'trending',
    titleKey: 'walkthrough.trending.title',
    descKey: 'walkthrough.trending.desc',
    extension: 'irishTrad',
    offered: trendingOffered,
    steps: () => [
      { target: 'nav-modules', action: 'click', titleKey: 'walkthrough.trending.modules.title', textKey: 'walkthrough.trending.modules.text' },
      { target: 'module-trending', action: 'click', deny: ['module-pin-trending'], titleKey: 'walkthrough.trending.open.title', textKey: 'walkthrough.trending.open.text' },
      // The first opening on a device downloads the whole history first.
      { target: 'trending-controls', action: 'do', wait: 180000, titleKey: 'walkthrough.trending.controls.title', textKey: 'walkthrough.trending.controls.text' },
      { target: 'trending-row', titleKey: 'walkthrough.trending.row.title', textKey: 'walkthrough.trending.row.text' },
      { target: 'trending-sheet', action: 'click', titleKey: 'walkthrough.trending.sheet.title', textKey: 'walkthrough.trending.sheet.text' },
      { target: 'modal', action: 'do', wait: 20000, deny: ['modal-close', 'abc-transpose'], titleKey: 'walkthrough.trending.listen.title', textKey: 'walkthrough.trending.listen.text',
        after: act => act.click('modal-close') },
      { target: 'trending-refresh', titleKey: 'walkthrough.trending.refresh.title', textKey: 'walkthrough.trending.refresh.text' },
      { target: 'nav-modules', action: 'click', titleKey: 'walkthrough.trending.back.title', textKey: 'walkthrough.trending.back.text' },
      { target: 'module-pin-trending', titleKey: 'walkthrough.trending.pin.title', textKey: 'walkthrough.trending.pin.text' },
    ],
  },
];

type UserLike = Pick<User, 'walkthroughs'>;

/** Reads the open user unless given one — through the signal, so the dots
 *  redraw the moment a scenario is finished. */
export function scenarioDone(id: string, user: UserLike = appState.value): boolean {
  return !!user.walkthroughs?.[id];
}

export function offeredScenarios(): Scenario[] {
  return SCENARIOS.filter(s => s.offered());
}

/** Whether anything is left to discover: the dot on ? and on the tab. */
export function anyScenarioPending(user: UserLike = appState.value): boolean {
  return offeredScenarios().some(s => !scenarioDone(s.id, user));
}
