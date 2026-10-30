import type { AppState, Card, CardRef, Deck, Folder } from '../types';
import type { Lang } from './i18nService';
import { generateId, withTimeout } from '../utils';
import { fetchTuneById, tuneResultToCard, type TuneResult } from './theSessionService';
import { CARD_TYPE_TUNESET } from './cardTypeService';
import { defaultTuneRepeat, tunesetAbcPlaceholder } from './abcService';
import { TUNESET_NAME_SEPARATOR } from './stateNormalise';

// ── A first library to learn from (2026-10-30) ───────────────────────────────
// A brand-new user can start with a few example folders, decks and cards that
// match the usage they picked in the welcome window, so the app explains
// itself by example. Offered once, at creation, and nowhere else: a reset
// does not bring them back, and switching the Irish extension on later does
// not offer its examples (the author's calls).
//
// Nothing marks a card as an example: they are ordinary cards from the moment
// they are written, and are deleted like any other.
//
// The Irish examples' tunes are NOT shipped with the app: TheSession's data
// would bring its own licence along (the ODbL), which the author does not want
// to carry (2026-10-30). They are fetched in the user's browser at creation,
// through the same call as the TheSession import.

interface SampleCard { name: string; notes: string }
interface SampleDeck { name: string; cards: SampleCard[] }
interface SampleFolder { name: string; folders?: SampleFolder[]; decks?: SampleDeck[] }

/** The general-purpose examples, in the user's own language. The vocabulary
 *  deck teaches the OTHER of the two languages. Each answer sits behind a
 *  spoiler in the notes, which is how a card hides its answer in study. */
const DEFAULT_SAMPLES: Record<Lang, SampleFolder[]> = {
  fr: [
    {
      name: 'Langue',
      decks: [{
        name: 'Anglais',
        cards: [
          { name: 'Chien', notes: 'En anglais : ||dog||' },
          { name: 'Maison', notes: 'En anglais : ||house||' },
          { name: 'Voiture', notes: 'En anglais : ||car||' },
          { name: 'Manger', notes: 'En anglais : ||to eat||' },
          { name: 'Amour', notes: 'En anglais : ||love||' },
        ],
      }],
    },
    {
      name: 'Géographie',
      decks: [{
        name: 'Capitales',
        cards: [
          { name: 'Nicaragua', notes: 'La capitale du Nicaragua est ||Managua||.' },
          { name: 'Irlande', notes: "La capitale de l'Irlande est ||Dublin||." },
          { name: 'Brésil', notes: 'La capitale du Brésil est ||Brasília||.' },
          { name: 'Afrique du Sud', notes: "La capitale administrative de l'Afrique du Sud est ||Pretoria||." },
          { name: 'Bhoutan', notes: 'La capitale du Bhoutan est ||Thimphou||.' },
          { name: 'Fidji', notes: 'La capitale des Fidji est ||Suva||.' },
        ],
      }],
    },
  ],
  en: [
    {
      name: 'Language',
      decks: [{
        name: 'French',
        cards: [
          { name: 'Dog', notes: 'In French: ||chien||' },
          { name: 'House', notes: 'In French: ||maison||' },
          { name: 'Car', notes: 'In French: ||voiture||' },
          { name: 'To eat', notes: 'In French: ||manger||' },
          { name: 'Love', notes: 'In French: ||amour||' },
        ],
      }],
    },
    {
      name: 'Geography',
      decks: [{
        name: 'Capitals',
        cards: [
          { name: 'Nicaragua', notes: 'The capital of Nicaragua is ||Managua||.' },
          { name: 'Ireland', notes: 'The capital of Ireland is ||Dublin||.' },
          { name: 'Brazil', notes: 'The capital of Brazil is ||Brasília||.' },
          { name: 'South Africa', notes: 'The administrative capital of South Africa is ||Pretoria||.' },
          { name: 'Bhutan', notes: 'The capital of Bhutan is ||Thimphu||.' },
          { name: 'Fiji', notes: 'The capital of Fiji is ||Suva||.' },
        ],
      }],
    },
  ],
};

/** A deck of the Irish examples: TheSession tune ids, and the sets among them
 *  as lists of those ids in playing order. */
interface IrishDeck { name: string; tunes: number[]; sets?: number[][] }
interface IrishFolder { name: string; decks: IrishDeck[] }

const IRISH_LAYOUT: Record<Lang, IrishFolder[]> = {
  fr: [
    { name: 'Sessions', decks: [{ name: 'Ma session locale', tunes: [64, 1, 13298, 11060, 9092] }] },
    {
      name: 'Moi',
      decks: [
        { name: 'Mon répertoire', tunes: [64, 11060, 729, 1299], sets: [[64, 1299, 729]] },
        { name: 'À apprendre', tunes: [55] },
      ],
    },
  ],
  en: [
    { name: 'Sessions', decks: [{ name: 'My local session', tunes: [64, 1, 13298, 11060, 9092] }] },
    {
      name: 'Me',
      decks: [
        { name: 'My repertoire', tunes: [64, 11060, 729, 1299], sets: [[64, 1299, 729]] },
        { name: 'To learn', tunes: [55] },
      ],
    },
  ],
};

/** Every tune the Irish examples need, once each. Both languages lay out the
 *  same tunes, so either one answers. */
export function irishSampleTuneIds(): number[] {
  const ids = IRISH_LAYOUT.en.flatMap(f => f.decks.flatMap(d => [...d.tunes, ...(d.sets ?? []).flat()]));
  return [...new Set(ids)];
}

/** Long enough for TheSession on a slow line; short enough that the welcome
 *  window does not seem stuck. */
const IRISH_FETCH_TIMEOUT_MS = 20_000;

/** The Irish examples' tunes, fetched from TheSession. All or nothing: a
 *  library with holes in it would teach the wrong thing, so one failure
 *  rejects the whole. */
export async function fetchIrishSampleTunes(): Promise<TuneResult[]> {
  return withTimeout(
    Promise.all(irishSampleTuneIds().map(id => fetchTuneById(id))),
    IRISH_FETCH_TIMEOUT_MS,
    'TheSession did not answer in time',
  );
}

function newCard(name: string, notes: string): Card {
  return { id: generateId(), guid: generateId(), name, defaultImportance: 1, tags: [], content: { notes, attachments: [] } };
}

/** Writes a folder and what it holds into `s`, at the root. `deckCards` gives
 *  each deck its cards, already present in `s.cards`. */
function addFolder<D>(s: AppState, name: string, decks: D[], deckName: (d: D) => string, deckCards: (d: D) => Card[]): void {
  const folder: Folder = { id: generateId(), name, folderIds: [], deckIds: [] };
  for (const d of decks) {
    const deck: Deck = { id: generateId(), name: deckName(d), entries: deckCards(d).map(c => ({ cardId: c.id })) };
    s.decks[deck.id] = deck;
    folder.deckIds.push(deck.id);
  }
  s.folders[folder.id] = folder;
  s.rootFolderIds.push(folder.id);
}

/** The general-purpose examples, written into `s`. */
export function addDefaultSamples(s: AppState, lang: Lang): void {
  for (const f of DEFAULT_SAMPLES[lang]) {
    addFolder(s, f.name, f.decks ?? [], d => d.name, d => d.cards.map(c => {
      const card = newCard(c.name, c.notes);
      s.cards[card.id] = card;
      return card;
    }));
  }
}

/** The Irish examples, written into `s` from tunes fetched beforehand (see
 *  fetchIrishSampleTunes). A tune listed in two decks is ONE card in both —
 *  which is the point of decks, and worth showing. A set is built the way the
 *  TheSession set import builds one: its name follows its tunes, each tune
 *  goes round the user's default number of times, and it comes with its fused
 *  score. */
export function addIrishSamples(s: AppState, lang: Lang, tunes: TuneResult[]): void {
  const byId = new Map<number, Card>();
  const cardOf = (id: number): Card => {
    let card = byId.get(id);
    if (!card) {
      const tune = tunes.find(t => t.id === id);
      if (!tune) throw new Error(`Sample tune ${id} was not fetched`);
      card = tuneResultToCard(tune);
      s.cards[card.id] = card;
      byId.set(id, card);
    }
    return card;
  };
  const repeat = defaultTuneRepeat(s);
  const setOf = (ids: number[]): Card => {
    const members = ids.map(cardOf);
    const refs: CardRef[] = members.map(c => ({ id: c.id, guid: c.guid, externalId: c.externalId, title: c.name, repeat }));
    const set: Card = {
      ...newCard(members.map(c => c.name).join(TUNESET_NAME_SEPARATOR), ''),
      type: CARD_TYPE_TUNESET,
      computedName: true,
      tunes: refs,
    };
    set.content.attachments = [tunesetAbcPlaceholder()];
    s.cards[set.id] = set;
    return set;
  };
  for (const f of IRISH_LAYOUT[lang]) {
    addFolder(s, f.name, f.decks, d => d.name, d => [...d.tunes.map(cardOf), ...(d.sets ?? []).map(setOf)]);
  }
}
