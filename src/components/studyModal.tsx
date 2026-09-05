import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { CustomSelect } from './customSelect';
import { pickRandom, pickOptimal, pickStochastic, pickSequential } from '../services/deckService';
import { buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { showModal, closeModal, renderModalBody } from './modal';
import { DiceIcon, BullseyeIcon, WeightedBarsIcon, SequentialIcon } from './icons';
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
 *  which mode you started. */
export const STRATEGY_ICONS: Record<StudyStrategy, { Icon: ComponentType<{ size?: number }>; color: string; bg: string }> = {
  random:     { Icon: DiceIcon,         color: 'text-sky-400',     bg: 'bg-sky-400/10' },
  optimal:    { Icon: BullseyeIcon,     color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  stochastic: { Icon: WeightedBarsIcon, color: 'text-violet-400',  bg: 'bg-violet-400/10' },
  sequential: { Icon: SequentialIcon,   color: 'text-amber-400',   bg: 'bg-amber-400/10' },
};

// `sequential` last on purpose: it is the only one that can be absent (deck
// study only), and a list whose LAST item comes and goes is far less jarring
// than one whose first does.
const STRATEGIES: Array<{ id: StudyStrategy; labelKey: string; subKey: string }> = [
  { id: 'random',     labelKey: 'deck.strategy.random',     subKey: 'deck.strategy.random.sub' },
  { id: 'optimal',    labelKey: 'deck.strategy.optimal',    subKey: 'deck.strategy.optimal.sub' },
  { id: 'stochastic', labelKey: 'deck.strategy.stochastic', subKey: 'deck.strategy.stochastic.sub' },
  { id: 'sequential', labelKey: 'deck.strategy.sequential', subKey: 'deck.strategy.sequential.sub' },
];

function Switch({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <span class="text-xs font-semibold text-muted uppercase tracking-widest">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        class={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${value ? 'bg-accent' : 'bg-border'}`}
        onClick={() => onChange(!value)}
      >
        <span class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0'}`} />
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
      <div>
        <div class="flex items-center gap-3">
          <label class="text-xs font-semibold text-muted uppercase tracking-widest shrink-0">{t('deck.context.title')}</label>
          <CustomSelect
            value={selectedContext ?? ''}
            options={ctxSelectOpts}
            onChange={(v) => setSelectedContext(v || null)}
            triggerClass="flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent"
          />
        </div>
        {excluded > 0 && <p class="text-xs text-warn mt-1">{t('study.excludedByContext', { n: excluded })}</p>}
      </div>

      <Switch
        label={t('settings.weightByImportance')}
        value={useWeight}
        onChange={v => { setUseWeight(v); void mutate(s => { s.weightByImportance = v; }); }}
      />
      <Switch
        label={t('study.excludeMastered')}
        value={exclMastered}
        onChange={v => { setExclMastered(v); void mutate(s => { s.excludeMastered = v; }); }}
      />

      <div class="border-t border-border" />

      <div>
        <div class="text-xs font-semibold text-muted uppercase tracking-widest mb-2">{t('deck.strategy.title')}</div>
        <div class="space-y-2">
          {/* Sequential needs an order the user actually chose. A folder or
              library pool has none — at the root it is literally the cards
              object's insertion order — so the option is only offered when a
              real deck is being studied. */}
          {STRATEGIES.filter(s => s.id !== 'sequential' || !!deckId).map(s => {
            const ic = STRATEGY_ICONS[s.id];
            return (
              <button
                key={s.id}
                class="w-full text-left card-block hover:border-accent/60 transition-colors cursor-pointer"
                onClick={() => pickStrategy(s.id)}
              >
                <div class="flex gap-3.5 items-center">
                  <div class={`shrink-0 w-10 h-10 rounded-xl ${ic.bg} ${ic.color} flex items-center justify-center`}><ic.Icon size={20} /></div>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-primary">{t(s.labelKey)}</div>
                    <div class="text-xs text-muted mt-0.5">{t(s.subKey)}</div>
                  </div>
                  <div class="shrink-0 text-dim text-base leading-none">›</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function showStudyModal(opts: StudyModalOpts): void {
  const { el, cleanup } = renderModalBody(<StudyModalBody {...opts} />);
  showModal(opts.title, el, [], { maxWidth: '28rem', onDismiss: cleanup });
}
