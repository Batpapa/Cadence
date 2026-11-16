import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import { t } from '../../services/i18nService';
import { focusIfDesktop, rankByRelevance, sortByRelevance } from '../../utils';
import { getContext } from '../../store';
import { isTune } from '../../services/cardTypeService';
import { hasLibrary } from '../../services/pageMode';
import { detectionTuneId } from '../detections';
import { cardScoreSettingId } from '../recognition/cardIndex';
import { recognitionIndexesOf, type RecognitionIndexId } from '../recognition/recognitionIndexes';
import { tuneName } from './sessionUiShared';
import type { Card } from '../../types';
import { fetchTuneById, searchTunes, tuneTypeToMeter, type TuneResult } from '../../services/theSessionService';
import { TuneUnavailableError } from '../../services/tuneFetchError';
import { ensureTuneSearchIndex, searchLocalTuneIndex } from '../../services/tuneNameIndexService';
import { PlusIcon } from '../../components/icons';
import { InlineStatus } from '../../components/ui';
import type { DetectionAlternate } from '../model';

// ── Naming a tune by hand ─────────────────────────────────────────────────────
// Two users of one field:
//
//   ManualTunePick    — "Another tune…" at the foot of the alternates picker,
//                       for when the right tune is not among the candidates the
//                       recogniser saw at all (2026-09-13, user request).
//   AddDetection      — the identity line of a detection being added by hand
//                       over a stretch the recogniser left empty (2026-09-21).
//
// They differ only in their chrome, so the lookup itself — debounce, local
// index then remote, id resolution, and the guard that keeps a stale answer
// from landing — lives once in TuneLookupField below and is wrapped twice.
//
// Needs the network to confirm, deliberately, as adding a card does: the
// setting a detection points at is TheSession's MOST POPULAR one for the tune,
// and only the live API knows which that is (`orderby=popular`, settings[0]).
// Neither local data set carries popularity. Measured on 40 tunes spread over
// the catalogue: that setting was in the recognition index every time, so the
// ABC preview and the key filter keep working on a hand-picked detection.
//
// The results list sits inline rather than floating over its surroundings:
// both callers already are a modal, and a portal over one is one more layer to
// get wrong on a phone for no gain.

// The lookup searches the recognition indexes (2026-11-16): the ones switched
// on in the analyser's options, in their order (recognitionIndexes.ts) — no
// index is the implicit one, so every suggestion says which it comes from. A
// tune the recogniser can find from a card's ABC (cardIndex.ts) can be named
// from the card, with no network: its own tune id, TheSession's when it is a
// TheSession tune, and the card's score as the version shown.
//
// A tune in two indexes (a card imported from TheSession) is offered once, by
// the earlier index — the recogniser's own rule on equal scores. Two cards of
// one tune both stay: they are two scores.
//
// A suggestion is named as the detection will be once picked (tuneName: the
// card's name, else TheSession's). TheSession's dump does not always say what
// its site does — tune 55 is "Kesh" there and "The Kesh" on thesession.org — so
// the list showed "Kesh" and the detection "The Kesh", from the user's card
// (2026-11-16).

/** What a suggestion, and the tune resolved, say besides the name: dance, key,
 *  source — in that order (the user, 2026-11-16), no meter: the dance says it. */
interface TuneFactsLine {
  type: string;
  /** "Gmajor", as the rest of the analyser writes keys; absent when unknown. */
  key?: string;
  source: RecognitionIndexId;
}

const factsText = (f: TuneFactsLine): string =>
  [f.type, f.key, t(SOURCE_LABEL[f.source])].filter(Boolean).join(' · ');

interface Suggestion extends TuneFactsLine {
  tuneId: string;
  name: string;
  via?: string;
  /** Set on a card's suggestion. */
  card?: Card;
}

/** At most this many cards among the suggestions. */
const MAX_CARD_SUGGESTIONS = 8;

/** Each index's word on a suggestion. */
const SOURCE_LABEL: Record<RecognitionIndexId, string> = {
  cards: 'sessions.tunePick.source.cards',
  thesession: 'sessions.tunePick.source.thesession',
};

/** The indexes a lookup searches, in the analyser's order: one switched off
 *  there is not offered here either. A page without a library has no cards. */
function lookupOrder(): RecognitionIndexId[] {
  if (!hasLibrary()) return ['thesession'];
  return recognitionIndexesOf(getContext().user).filter(c => c.on).map(c => c.id);
}

const tuneCards = (): Card[] => Object.values(getContext().user.cards).filter(isTune);

/** The tune cards a query names (by name or alias), best first. */
function cardSuggestions(query: string): Suggestion[] {
  return rankByRelevance(tuneCards(), query).slice(0, MAX_CARD_SUGGESTIONS).map(({ item, via }) => ({
    tuneId: detectionTuneId(item), name: item.name, ...cardFacts(item), card: item,
    ...(via !== undefined ? { via } : {}),
  }));
}

/** A TheSession tune as a suggestion, under the name its detection will show.
 *  When that is not TheSession's (a card renamed), TheSession's comes under it.
 *  The key is the local index's (one setting's), absent from the remote search's
 *  answer: the resolved line then gives the key of the version picked. */
function theSessionSuggestion(r: { id: number; name: string; type: string; mode?: string }, via: string | undefined): Suggestion {
  const tuneId = String(r.id);
  const name = tuneName({ tuneId, displayName: r.name }).text;
  const shownVia = via ?? (name === r.name ? undefined : r.name);
  return {
    tuneId, name, type: r.type, ...(r.mode ? { key: r.mode } : {}), source: 'thesession',
    ...(shownVia !== undefined ? { via: shownVia } : {}),
  };
}

/** The lists in index order, as far as they have answered, each without the
 *  tunes an earlier index already offers. */
function mergeSuggestions(order: readonly RecognitionIndexId[], lists: ReadonlyMap<RecognitionIndexId, Suggestion[]>): Suggestion[] {
  const out: Suggestion[] = [];
  const offered = new Set<string>();
  for (const id of order) {
    const list = lists.get(id);
    if (!list) break;
    const fresh = list.filter(s => !offered.has(s.tuneId));
    out.push(...fresh);
    for (const s of fresh) offered.add(s.tuneId);
  }
  return out;
}

/** A card's value under a tag group (`type::`, `key::`), as written; empty when
 *  it has none. */
function cardTagValue(card: Card, group: string): string {
  const prefix = `${group}::`;
  const tag = card.tags.find(tg => tg.toLowerCase().startsWith(prefix));
  return tag ? tag.slice(prefix.length) : '';
}

/** A card's dance and key, off its `type::` and `key::` tags (what an import
 *  writes, and what the card shows). */
function cardFacts(card: Card): TuneFactsLine {
  const key = cardTagValue(card, 'key');
  return { type: cardTagValue(card, 'type').toLowerCase(), ...(key ? { key } : {}), source: 'cards' };
}

/** Searches the recognition indexes by name or id and reports the tune currently resolved —
 *  `null` whenever there is none, which is what a caller's commit control
 *  watches to know whether it would do anything.
 *
 *  It reports rather than commits: adding to a list and starting a detection
 *  are different acts, and neither is "having typed a name". */
export function TuneLookupField({ onResolved, trailing, onSubmit, autoFocus = true }: {
  onResolved: (tune: DetectionAlternate | null) => void;
  /** Rendered on the input's own row — the caller's commit button, where it
   *  has one. */
  trailing?: ComponentChild;
  /** Enter, once a tune is resolved. */
  onSubmit?: () => void;
  /** Desktop only either way (focusIfDesktop), and off where typing is not
   *  the first thing to do: in the add-detection editor the first act is to
   *  LISTEN, and a focused field would swallow the space bar that plays. */
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const [status, setStatusText] = useState('');
  /** The status line is a failure — shown in red, where it was the grey of
   *  "searching". Every status sets it, so a later one clears it. */
  const [statusError, setStatusError] = useState(false);
  const setStatus = (text: string, error = false) => { setStatusText(text); setStatusError(error); };
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  /** The tune resolved, as the line under the field names it. */
  const [pending, setPending] = useState<({ name: string } & TuneFactsLine) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only the answer to the LAST thing typed may land — typing an id starts one
  // lookup per keystroke, and they do not come back in the order they left.
  // Same guard as the new-card modal's (theSessionImport.tsx's useLatestOnly).
  const seq = useRef(0);
  const begin = () => { const mine = ++seq.current; return () => mine === seq.current; };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); seq.current++; }, []);
  useEffect(() => { if (autoFocus && inputRef.current) focusIfDesktop(inputRef.current); }, []);

  /** Told to the caller as a detection's identity, or `null` while there is
   *  none. A tune with no setting has nothing a detection could point at, so
   *  it never reaches here. */
  const report = (tune: TuneResult | null) => {
    // The key of the version the detection will point at (settings[0]).
    const key = tune?.settings[0]?.key;
    setPending(tune && {
      name: tuneName({ tuneId: String(tune.id), displayName: tune.name }).text,
      type: tune.type, ...(key ? { key } : {}), source: 'thesession',
    });
    onResolved(tune && {
      tuneId: String(tune.id),
      settingId: String(tune.settings[0]!.id),
      // Lower case, as every detection name is (see Detection.displayName):
      // the views re-case it from the card or the name index anyway.
      displayName: tune.name.toLowerCase(),
      dance: tune.type,
      meter: tuneTypeToMeter(tune.type),
      // Never shown — a hand-picked tune has no score, and says "manual" instead.
      meanScore: 0,
    });
  };

  /** A card picked: resolved at once. Its version is the card's score as it
   *  is (cardScoreSettingId), whichever ABC it holds when it is shown. */
  const reportCard = (card: Card) => {
    seq.current++;
    const facts = cardFacts(card);
    const dance = facts.type;
    setPending({ name: card.name, ...facts });
    setStatus('');
    onResolved({
      tuneId: detectionTuneId(card),
      settingId: cardScoreSettingId(card.guid),
      displayName: card.name.toLowerCase(),
      dance,
      meter: tuneTypeToMeter(dance),
      meanScore: 0,
    });
  };

  /** The same three answers the new-card modal gives: taken down, no such
   *  tune, or anything else — the network, most of the time — in its own words. */
  const describeError = (e: unknown): string =>
    e instanceof TuneUnavailableError ? t('theSession.id.unavailable')
      : e instanceof Error && /: 404$/.test(e.message) ? t('theSession.id.notFound')
      : t('theSession.error', { message: e instanceof Error ? e.message : String(e) });

  /** TheSession's tune `id`, fetched: true once reported, else the failure in
   *  words — or null when a later keystroke made the answer moot. */
  const fetchTheSession = async (id: number, fresh: () => boolean): Promise<true | string | null> => {
    setStatus(t('theSession.status.fetching'));
    try {
      const tune = await fetchTuneById(id);
      if (!fresh()) return null;
      if (tune.settings.length === 0) return t('theSession.id.notFound');
      report(tune);
      setStatus('');
      return true;
    } catch (e) {
      return fresh() ? describeError(e) : null;
    }
  };

  const resolve = async (id: number) => {
    const fresh = begin();
    report(null);
    const answer = await fetchTheSession(id, fresh);
    if (typeof answer === 'string') setStatus(answer, true);
  };

  /** An id typed: the first index in the user's order that has that tune
   *  answers, so it is never ambiguous. Only TheSession's ids are numbers — a
   *  card answers for the TheSession tune it was imported from. */
  const resolveId = async (q: string) => {
    const fresh = begin();
    report(null);
    let failure = t('theSession.id.notFound');
    for (const source of lookupOrder()) {
      if (source === 'cards') {
        const card = tuneCards().find(c => detectionTuneId(c) === q);
        if (card) { reportCard(card); return; }
        continue;
      }
      const answer = await fetchTheSession(parseInt(q, 10), fresh);
      if (answer === null || answer === true) return;
      failure = answer;
    }
    if (fresh()) setStatus(failure, true);
  };

  const onInput = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    seq.current++;
    setValue(val);
    report(null);
    setSuggestions([]);
    setStatus('');
    const q = val.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) {
      timerRef.current = setTimeout(() => { timerRef.current = null; void resolveId(q); }, 150);
      return;
    }
    if (q.length < 2) return;
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      const fresh = begin();
      const order = lookupOrder();
      const lists = new Map<RecognitionIndexId, Suggestion[]>();
      /** Shown as far as the order has answered: the cards at once when they
       *  come first, after TheSession's results otherwise. */
      const show = () => { const all = mergeSuggestions(order, lists); setSuggestions(all); return all.length; };
      if (order.includes('cards')) lists.set('cards', cardSuggestions(q));
      if (!order.includes('thesession')) {
        setStatus(show() ? '' : t('theSession.noResults'));
        return;
      }
      show();
      setStatus(t('theSession.status.searching'));
      try {
        let tunes: Suggestion[];
        try {
          // Local first, remote only when there is no local index at all —
          // the new-card modal's settled rule, for the same reasons.
          tunes = searchLocalTuneIndex(await ensureTuneSearchIndex(), q).map(r => theSessionSuggestion(r, r.via));
        } catch {
          tunes = sortByRelevance(await searchTunes(q), q).map(r => theSessionSuggestion(r, r.alias));
        }
        if (!fresh()) return;
        lists.set('thesession', tunes);
        setStatus(show() ? '' : t('theSession.noResults'));
      } catch (e) {
        if (!fresh()) return;
        // TheSession unreachable: the cards still stand, wherever they rank.
        lists.set('thesession', []);
        show();
        setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }), true);
      }
    }, 300);
  };

  const pickSuggestion = (tune: Suggestion) => {
    setValue(tune.name);
    setSuggestions([]);
    if (tune.card) reportCard(tune.card);
    else void resolve(parseInt(tune.tuneId, 10));
  };

  return (
    <div class="space-y-2">
      <div class="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          class="input flex-1 min-w-0 text-sm"
          placeholder={t('theSession.tune.placeholder')}
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pending) { e.preventDefault(); onSubmit?.(); } }}
        />
        {trailing}
      </div>

      {pending && <p class="text-xs text-muted truncate">{pending.name} · {factsText(pending)}</p>}
      {status && (statusError
        ? <InlineStatus tone="error">{status}</InlineStatus>
        : <p class="text-xs text-dim">{status}</p>)}

      {suggestions.length > 0 && (
        <div class="max-h-48 overflow-y-auto rounded border border-border divide-y divide-border/50">
          {suggestions.map(tune => (
            <button
              key={tune.card ? `card:${tune.card.id}` : tune.tuneId}
              type="button"
              class="w-full block px-3 py-1.5 text-left hover:bg-bg cursor-pointer"
              onClick={() => pickSuggestion(tune)}
            >
              {/* The facts under the name, as the alternates list above writes
                  them: beside it, three of them left a phone's name a few
                  letters wide. The alias goes right under the name it stands
                  for, the facts after. */}
              <span class="text-sm text-primary truncate block">{tune.name}</span>
              {tune.via !== undefined && <span class="text-xs text-dim truncate block">{t('search.viaAlias', { alias: tune.via })}</span>}
              <span class="text-xs text-dim truncate block">{factsText(tune)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Another tune…" — the alternates picker's way in. "Add" only adds (user
 *  request): the tune joins the variants list and is ticked from there like any
 *  other, so choosing it and naming it are never the same gesture. The field
 *  folds away once it has added, which both shows the new row and discards the
 *  lookup's state with it. */
export function ManualTunePick({ onAdd }: { onAdd: (tune: DetectionAlternate) => void }) {
  const [open, setOpen] = useState(false);
  const [tune, setTune] = useState<DetectionAlternate | null>(null);

  const add = () => {
    if (!tune) return;
    onAdd(tune);
    setTune(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        class="w-full flex items-center gap-3 px-5 py-2.5 text-left text-sm text-muted hover:bg-bg hover:text-primary transition-colors cursor-pointer border-t border-border/50"
        onClick={() => setOpen(true)}
      >
        <span class="w-4 shrink-0 flex items-center justify-center"><PlusIcon size={12} /></span>
        {t('sessions.alternates.other')}
      </button>
    );
  }

  return (
    <div class="px-5 py-3 border-t border-border/50">
      <TuneLookupField
        onResolved={setTune}
        onSubmit={add}
        trailing={
          <button type="button" class="btn-primary text-xs shrink-0" disabled={!tune} onClick={add}>
            {t('common.add')}
          </button>
        }
      />
    </div>
  );
}
