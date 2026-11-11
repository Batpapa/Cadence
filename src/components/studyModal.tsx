import type { ComponentType, ComponentChildren, RefObject } from 'preact';
import { useState, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { CustomSelect } from './customSelect';
import { pickRandom, pickOptimal, pickStochastic, pickSequential } from '../services/deckService';
import { buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { showModal, closeModal, renderModalBody, MODAL_W } from './modal';
import { Switch, ChoiceCard } from './ui';
import { DiceIcon, BullseyeIcon, WeightedBarsIcon, SequentialIcon, ArrowRightIcon, StudyIcon } from './icons';
import type { Deck, StudyStrategy, DeckEntry } from '../types';

export interface StudyModalOpts {
  /** Pre-built card pool to study. Context chips and strategy will be applied on top. */
  entries: DeckEntry[];
  /** Label shown in the modal header and passed to the study view. */
  title: string;
  /** Pre-selected context chip. Pass the deckId for deck-based study, null for Défaut. */
  defaultContext?: string | null;
  /** When set, the study view uses this deck's live entries as its source of truth. */
  deckId?: string;
}

/** Icon and colour for each strategy. Exported because the study header shows
 *  the same glyph the picker did — that icon is how you recognise, mid-session,
 *  which mode you started. The DRAWING tells them apart; the colour is the
 *  accent for all four (raw sky/emerald/violet/amber did not follow the
 *  themes, and a status hue on a choice says nothing about it). */
export const STRATEGY_ICONS: Record<StudyStrategy, { Icon: ComponentType<{ size?: number }>; color: string; bg: string }> = {
  random:     { Icon: DiceIcon,         color: 'text-accent', bg: 'bg-accent/10' },
  optimal:    { Icon: BullseyeIcon,     color: 'text-accent', bg: 'bg-accent/10' },
  stochastic: { Icon: WeightedBarsIcon, color: 'text-accent', bg: 'bg-accent/10' },
  sequential: { Icon: SequentialIcon,   color: 'text-accent', bg: 'bg-accent/10' },
};

// `sequential` last on purpose: it is the only one that can be absent (deck
// study only), and a list whose LAST item comes and goes is far less jarring
// than one whose first does.
const STRATEGIES: Array<{ id: StudyStrategy; labelKey: string; subKey: string }> = [
  { id: 'optimal',    labelKey: 'deck.strategy.optimal',    subKey: 'deck.strategy.optimal.sub' },
  { id: 'stochastic', labelKey: 'deck.strategy.stochastic', subKey: 'deck.strategy.stochastic.sub' },
  { id: 'random',     labelKey: 'deck.strategy.random',     subKey: 'deck.strategy.random.sub' },
  { id: 'sequential', labelKey: 'deck.strategy.sequential', subKey: 'deck.strategy.sequential.sub' },
];

/** A labelled row around the app's one Switch (ui.tsx): the label on the left,
 *  as this dialog always had it. */
function SwitchRow({ label, value, tour, onChange }: { label: string; value: boolean; tour?: string; onChange: (v: boolean) => void }) {
  return (
    <div class="flex items-center justify-between gap-3" data-tour={tour}>
      <span class="label mb-0">{label}</span>
      <Switch checked={value} label={label} onChange={onChange} />
    </div>
  );
}

function StudyModalBody({ entries, title, defaultContext = null, deckId }: StudyModalOpts) {
  const user = appState.value;

  const cardIdSet = new Set(entries.map(e => e.cardId));
  const contextDecks = Object.values(user.decks)
    .filter(d => d.entries.some(e => cardIdSet.has(e.cardId)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const [selectedContext, setSelectedContext] = useState<string | null>(defaultContext);
  const [useWeight, setUseWeight] = useState(user.weightByImportance ?? true);
  // Off = study as if the mastery threshold were 100%: mastered cards are
  // proposed again. Study flow only — deck metrics keep the real threshold.
  const [exclMastered, setExclMastered] = useState(user.excludeMastered ?? true);

  const ctxSelectOpts = [
    { value: '', label: t('deck.context.default') },
    ...contextDecks.map(d => ({ value: d.id, label: d.name })),
  ];

  const pool: Deck = deckId
    ? (user.decks[deckId] ?? { id: deckId, name: title, entries })
    : { id: '__virtual', name: title, entries };
  const excluded = entries.length - buildContextualEntries(pool, selectedContext, user).length;

  const pickStrategy = (id: StudyStrategy) => {
    closeModal();
    const u = appState.value;
    const pid = u.currentProfileId;

    const ctxEntries = buildContextualEntries(pool, selectedContext, u);
    const ctxPool: Deck = { ...pool, entries: ctxEntries };

    const pickers: Record<StudyStrategy, () => DeckEntry | null> = {
      random:     () => pickRandom(u, pid, ctxPool, u.cardWorks, exclMastered),
      optimal:    () => pickOptimal(u, pid, ctxPool, u.cards, u.cardWorks, useWeight, exclMastered),
      stochastic: () => pickStochastic(u, pid, ctxPool, u.cards, u.cardWorks, useWeight, exclMastered),
      // No current card yet — the walk starts at the top of the deck.
      sequential: () => pickSequential(u, pid, ctxPool, u.cardWorks, exclMastered, null),
    };
    const firstCard = pickers[id]();

    navigate({
      view:           'study',
      deckId,
      cardIds:        deckId ? undefined : entries.map(e => e.cardId),
      studyTitle:     deckId ? undefined : title,
      strategy:       id,
      currentCardId:  firstCard?.cardId ?? null,
      contextDeckId:  selectedContext,
    });
  };

  return (
    <div class="space-y-4">
      {/* The three settings, one block for the walkthrough to light. */}
      <div class="space-y-4" data-tour="study-options">
      <div>
        <div class="flex items-center gap-3">
          <label class="label mb-0 shrink-0">{t('deck.context.title')}</label>
          <CustomSelect
            value={selectedContext ?? ''}
            options={ctxSelectOpts}
            onChange={(v) => setSelectedContext(v || null)}
            triggerClass="flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent"
          />
        </div>
        {excluded > 0 && <p class="text-xs text-warn mt-1">{t('study.excludedByContext', { n: excluded })}</p>}
      </div>

      <SwitchRow
        label={t('settings.weightByImportance')}
        value={useWeight}
        onChange={v => { setUseWeight(v); void mutate(s => { s.weightByImportance = v; }); }}
      />
      <SwitchRow
        label={t('study.excludeMastered')}
        value={exclMastered}
        tour="study-exclude"
        onChange={v => { setExclMastered(v); void mutate(s => { s.excludeMastered = v; }); }}
      />
      </div>

      <div class="border-t border-border" />

      <div>
        <div class="label mb-2">{t('deck.strategy.title')}</div>
        <div class="space-y-2">
          {/* Sequential needs an order the user actually chose. A folder or
              library pool has none — at the root it is literally the cards
              object's insertion order — so the option is only offered when a
              real deck is being studied. */}
          {STRATEGIES.filter(s => s.id !== 'sequential' || !!deckId).map(s => {
            const ic = STRATEGY_ICONS[s.id];
            return (
              <ChoiceCard
                key={s.id}
                tour={`study-${s.id}`}
                icon={<span class={`w-10 h-10 rounded-xl ${ic.bg} ${ic.color} flex items-center justify-center`}><ic.Icon size={20} /></span>}
                label={t(s.labelKey)}
                desc={t(s.subKey)}
                trailing={<ArrowRightIcon size={16} />}
                onClick={() => pickStrategy(s.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function showStudyModal(opts: StudyModalOpts): void {
  const { el, cleanup } = renderModalBody(<StudyModalBody {...opts} />);
  showModal(opts.title, el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}

/** The Study button of the deck and folder headers: it opens the dialog above.
 *  (A split button that started at once with the last strategy was tried on
 *  2026-11-11 and taken back the same day: the author prefers the dialog every
 *  time.) */
export function StudyButton({ opts, label, title, tour, disabled, showLabel = true }: {
  opts: StudyModalOpts;
  label: string;
  title?: string;
  tour?: string;
  disabled?: boolean;
  /** False: the icon alone (see ShrinkLabel); the button then carries the
   *  label as its name. */
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      class="btn-study px-3 text-sm font-medium inline-flex items-center gap-1.5 shrink-0 relative"
      title={title}
      aria-label={showLabel ? undefined : label}
      data-tour={tour}
      disabled={disabled}
      onClick={() => showStudyModal(opts)}
    >
      <ShrinkIcon><StudyIcon size={16} /></ShrinkIcon>
      <ShrinkLabel shown={showLabel}>{label}</ShrinkLabel>
    </button>
  );
}

/** A header action's label that `useHiddenHeaderLabels` can take away. Hidden,
 *  it is still laid out — out of the flow, invisible — so its width can still
 *  be measured. The button holding it needs `relative`. */
export function ShrinkLabel({ shown, children }: { shown: boolean; children: string }) {
  return <span data-shrink-label class={shown ? 'whitespace-nowrap' : 'absolute invisible pointer-events-none whitespace-nowrap'}>{children}</span>;
}

/** The icon beside a ShrinkLabel, one text line tall (text-sm: 20 px). Alone,
 *  a 16 px icon left the button 4 px shorter than with its label — the button
 *  jumped as the label went, and fell under the 32 px target. */
export function ShrinkIcon({ children }: { children: ComponentChildren }) {
  return <span class="h-5 flex items-center shrink-0">{children}</span>;
}

/** For a header row laid out [title][actions holding ShrinkLabels]: how many
 *  of those labels to hide, taken in the actions' order — the label at index i
 *  shows when i >= the answer. The actions stay top right whatever happens (the
 *  author, 2026-11-11); when the row runs short the labels go first, one after
 *  the other (on the home: Smart edit's, then Study all's), and the title wraps
 *  only once they all have.
 *
 *  The rule: the fewest labels hidden such that the title ON ONE LINE, the gap,
 *  and the actions with the remaining labels fit the row. Each term is
 *  measured the same way whichever labels are currently shown — the title's
 *  text by the sum of its line boxes (wrapped or not), each label by its own
 *  box, laid out even when hidden — so the answer cannot flip itself back and
 *  forth. A row that measures itself loops otherwise (2026-09: the page froze
 *  on a scrollbar). Pure CSS was tried first: the shrinking was continuous, the
 *  label went while the button was still wide and empty, and the actions could
 *  be squeezed off the row. Units: everything is divided by the row's own
 *  rendered/layout ratio, so the app's CSS zoom does not mix two pixel spaces.
 *  While the name is being edited (an input, no h1), the answer stays. */
export function useHiddenHeaderLabels(rowRef: RefObject<HTMLElement>, deps: unknown[]): number {
  const [hidden, setHidden] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const decide = () => {
      const title = row.firstElementChild as HTMLElement | null;
      const actions = row.lastElementChild as HTMLElement | null;
      const h1 = title?.querySelector('h1');
      const labels = actions ? Array.from(actions.querySelectorAll<HTMLElement>('[data-shrink-label]')) : [];
      if (!title || !actions || !h1 || labels.length === 0) return;
      const cs = getComputedStyle(row);
      const rowW = parseFloat(cs.width);
      const scale = row.getBoundingClientRect().width / rowW || 1;
      const range = document.createRange();
      range.selectNodeContents(h1);
      const lines = Array.from(range.getClientRects());
      // A wrapped title loses the space at each break: one is added back per
      // break, rounded up (0.35em), so an error hides the label a little
      // early rather than letting the title wrap beside it.
      const text = lines.reduce((s, r) => s + r.width, 0)
        + Math.max(0, lines.length - 1) * 0.35 * parseFloat(getComputedStyle(h1).fontSize) * scale;
      const titleW = (h1.getBoundingClientRect().left - title.getBoundingClientRect().left + text) / scale;
      // Each label's share of its button: its box and the gap before it.
      const widths = labels.map(l => l.getBoundingClientRect().width / scale
        + parseFloat(getComputedStyle(l.parentElement!).columnGap || '0'));
      const actionsFull = actions.getBoundingClientRect().width / scale
        + labels.reduce((s, l, i) => s + (l.classList.contains('absolute') ? widths[i]! : 0), 0);
      let need = titleW + (parseFloat(cs.columnGap) || 0) + actionsFull - (rowW + 0.5);
      let n = 0;
      while (need > 0 && n < labels.length) need -= widths[n++]!;
      setHidden(n);
    };
    decide();
    const ro = new ResizeObserver(decide);
    ro.observe(row);
    // The webfont may land after the first measure, widening the text.
    void document.fonts?.ready.then(decide);
    return () => ro.disconnect();
  }, deps);
  return hidden;
}
