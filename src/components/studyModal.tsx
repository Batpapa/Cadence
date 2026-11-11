import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { CustomSelect } from './customSelect';
import { pickRandom, pickOptimal, pickStochastic, pickSequential } from '../services/deckService';
import { buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { showModal, closeModal, renderModalBody, MODAL_W } from './modal';
import { Switch, ChoiceCard } from './ui';
import { DiceIcon, BullseyeIcon, WeightedBarsIcon, SequentialIcon, ArrowRightIcon, StudyIcon, ChevronDownIcon } from './icons';
import type { Deck, StudyStrategy, DeckEntry, User } from '../types';

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

/** The strategy the Study button's one press starts with: the last one picked
 *  in the dialog, Optimal before any. Sequential needs a deck's own order
 *  (see the dialog's list), so a pool without one falls back to Optimal —
 *  without forgetting it: the next deck still walks in order. A value this
 *  bundle does not know — a strategy added by a later version, arriving
 *  through Drive — reads as Optimal too: indexing the icons on it would take
 *  every Study button down with it. */
export function rememberedStrategy(user: User, deckId: string | undefined): StudyStrategy {
  const s = user.studyStrategy;
  if (!s || !Object.hasOwn(STRATEGY_ICONS, s)) return 'optimal';
  return s === 'sequential' && !deckId ? 'optimal' : s;
}

/** Opens the study view on `opts`' pool. Returns false, having opened
 *  nothing, when no card would come up and `evenIfEmpty` is not set. */
function startStudy(
  { entries, title, deckId }: Pick<StudyModalOpts, 'entries' | 'title' | 'deckId'>,
  strategy: StudyStrategy, context: string | null, useWeight: boolean, exclMastered: boolean, evenIfEmpty: boolean,
): boolean {
  const u = appState.value;
  const pid = u.currentProfileId;
  const pool: Deck = deckId
    ? (u.decks[deckId] ?? { id: deckId, name: title, entries })
    : { id: '__virtual', name: title, entries };
  const ctxPool: Deck = { ...pool, entries: buildContextualEntries(pool, context, u) };

  const pickers: Record<StudyStrategy, () => DeckEntry | null> = {
    random:     () => pickRandom(u, pid, ctxPool, u.cardWorks, exclMastered),
    optimal:    () => pickOptimal(u, pid, ctxPool, u.cards, u.cardWorks, useWeight, exclMastered),
    stochastic: () => pickStochastic(u, pid, ctxPool, u.cards, u.cardWorks, useWeight, exclMastered),
    // No current card yet — the walk starts at the top of the deck.
    sequential: () => pickSequential(u, pid, ctxPool, u.cardWorks, exclMastered, null),
  };
  const firstCard = pickers[strategy]();
  if (!firstCard && !evenIfEmpty) return false;

  navigate({
    view:           'study',
    deckId,
    cardIds:        deckId ? undefined : entries.map(e => e.cardId),
    studyTitle:     deckId ? undefined : title,
    strategy,
    currentCardId:  firstCard?.cardId ?? null,
    contextDeckId:  context,
  });
  return true;
}

/** Study in one press (2026-11-11): the remembered strategy, the pool's own
 *  context, the weighting and mastered-card settings as last left. It used
 *  to be the dialog every time, then a strategy to pick, never remembered.
 *  When nothing would come up, the dialog opens instead: it holds the
 *  « exclude mastered » switch that is the way out of that case, where a
 *  session would only have opened on « Session complete ». */
function studyNow(opts: StudyModalOpts): void {
  const u = appState.value;
  const started = startStudy(opts, rememberedStrategy(u, opts.deckId), opts.defaultContext ?? null,
    u.weightByImportance ?? true, u.excludeMastered ?? true, false);
  if (!started) showStudyModal(opts);
}

/** The app's one Study button: the green action starts at once (studyNow),
 *  the narrow part beside it — the remembered strategy's glyph and a chevron —
 *  opens the dialog to change the context, the weighting or the strategy. */
export function StudyButton({ opts, label, title, tour, disabled }: {
  opts: StudyModalOpts;
  label: string;
  title?: string;
  /** Walkthrough name of the whole button; the dialog part is always
   *  `study-open-options`. */
  tour?: string;
  disabled?: boolean;
}) {
  const strategy = rememberedStrategy(appState.value, opts.deckId);
  const ic = STRATEGY_ICONS[strategy];
  const strategyName = t(`deck.strategy.${strategy}`);
  return (
    <div class="inline-flex shrink-0" data-tour={tour}>
      <button
        type="button"
        class="btn-study rounded-r-none px-3 text-sm font-medium inline-flex items-center gap-1.5"
        title={title ? `${title} · ${strategyName}` : strategyName}
        disabled={disabled}
        onClick={() => studyNow(opts)}
      >
        <StudyIcon size={16} />
        {label}
      </button>
      <button
        type="button"
        class="btn-study rounded-l-none border-l border-white/25 px-2 min-w-8 inline-flex items-center justify-center gap-1"
        title={t('study.options', { strategy: strategyName })}
        aria-label={t('study.options', { strategy: strategyName })}
        data-tour="study-open-options"
        disabled={disabled}
        onClick={() => showStudyModal(opts)}
      >
        <ic.Icon size={14} />
        <ChevronDownIcon size={12} />
      </button>
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
  const remembered = rememberedStrategy(user, deckId);

  const pickStrategy = (id: StudyStrategy) => {
    closeModal();
    // Remembered for the Study button's next one press. Not when nothing
    // changes: every write is a save and a Drive upload.
    if ((appState.value.studyStrategy ?? 'optimal') !== id) void mutate(s => { s.studyStrategy = id; });
    startStudy({ entries, title, deckId }, id, selectedContext, useWeight, exclMastered, true);
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
            // The one the Study button starts with: picking any row both
            // starts and remembers, so the dialog says which one that is.
            const last = s.id === remembered;
            return (
              <ChoiceCard
                key={s.id}
                tour={`study-${s.id}`}
                class={last ? 'border-accent/60' : ''}
                icon={<span class={`w-10 h-10 rounded-xl ${ic.bg} ${ic.color} flex items-center justify-center`}><ic.Icon size={20} /></span>}
                label={last
                  ? <span class="inline-flex items-center gap-2">{t(s.labelKey)}<span class="badge bg-accent/10 text-accent">{t('study.lastUsed')}</span></span>
                  : t(s.labelKey)}
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
