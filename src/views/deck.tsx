import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { pct, timeAgo, availabilityColor, trashIcon, unlinkIcon, addTouchDragSupport, focusIfDesktop } from '../utils';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { findParentFolder, pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import { deckAvailability, cardAvailability, effectiveImportance, isAvailable, deckStability, deckEase, replayFSRS, retentionWindowDays } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';
import type { DeckEntry, StudyStrategy } from '../types';

// Bridge: renders a vanilla SVGSVGElement inside Preact's tree.
function SvgIcon({ icon }: { icon: SVGSVGElement }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(icon); });
  return <span ref={ref} />;
}

function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',    { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths',   { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',     { n: Math.round(d) });
  return t('common.durationLessThanDay');
}

function showStrategyModal(deckId: string): void {
  const body = document.createElement('div');
  body.className = 'space-y-2';
  const desc = document.createElement('p');
  desc.className = 'text-sm text-muted mb-4';
  desc.textContent = t('deck.strategy.desc');
  body.appendChild(desc);

  const strategies: Array<{ id: StudyStrategy; labelKey: string; subKey: string }> = [
    { id: 'random',     labelKey: 'deck.strategy.random',     subKey: 'deck.strategy.random.sub' },
    { id: 'optimal',    labelKey: 'deck.strategy.optimal',    subKey: 'deck.strategy.optimal.sub' },
    { id: 'stochastic', labelKey: 'deck.strategy.stochastic', subKey: 'deck.strategy.stochastic.sub' },
  ];

  for (const s of strategies) {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left card-block hover:border-accent/60 transition-colors cursor-pointer';
    btn.innerHTML = `<div class="text-sm font-medium text-primary">${t(s.labelKey)}</div><div class="text-xs text-muted mt-0.5">${t(s.subKey)}</div>`;
    btn.onclick = () => {
      closeModal();
      const state = appState.value;
      const deck = state.decks[deckId]!;
      const user = getCurrentUser(state);
      const pid  = state.currentProfileId;
      const w    = user.weightByImportance ?? true;
      const pickers: Record<StudyStrategy, () => DeckEntry | null> = {
        random:     () => pickRandom(user, pid, deck, state.cardWorks),
        optimal:    () => pickOptimal(user, pid, deck, state.cards, state.cardWorks, w),
        stochastic: () => pickStochastic(user, pid, deck, state.cards, state.cardWorks, w),
      };
      const entry = pickers[s.id]();
      navigate({ view: 'study', deckId, strategy: s.id, currentCardId: entry?.cardId ?? null });
    };
    body.appendChild(btn);
  }
  showModal(t('deck.strategy.title'), body, [{ label: t('common.cancel'), onClick: closeModal }]);
}

function showImportanceModal(deckId: string, entry: DeckEntry, baseImportance: number): void {
  const body = document.createElement('div'); body.className = 'space-y-3';
  const info = document.createElement('p'); info.className = 'text-xs text-muted';
  info.textContent = t('deck.weight.info', { base: baseImportance });
  const lbl   = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('deck.weight.label');
  const input = document.createElement('input'); input.type = 'number'; input.min = '0.1'; input.step = '0.1'; input.className = 'input';
  if (entry.importanceOverride !== undefined) input.value = String(entry.importanceOverride);
  body.append(info, lbl, input);

  showModal(t('deck.weight.title'), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.apply'), primary: true, onClick: () => {
      const val = parseFloat(input.value);
      closeModal();
      mutate(s => {
        const e = s.decks[deckId]!.entries.find(e => e.cardId === entry.cardId);
        if (!e) return;
        if (isNaN(val) || input.value.trim() === '') delete e.importanceOverride;
        else e.importanceOverride = val;
      });
    }},
  ]);
  focusIfDesktop(input);
}

export function DeckView({ deckId }: { deckId: string }) {
  const state     = appState.value;
  const deck      = state.decks[deckId];
  const user      = getCurrentUser(state);
  const profileId = state.currentProfileId;
  const w         = user.weightByImportance ?? true;

  // Inline name editing
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName]           = useState('');

  // Quick-link dropdown
  const [linkQuery, setLinkQuery] = useState('');

  // Drag-and-drop — ref for active drag id (avoids re-renders on every dragover)
  const draggedId = useRef<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget]     = useState<{ cardId: string; zone: 'before' | 'after' } | null>(null);

  if (!deck) return <div class="flex flex-col h-full view-enter">{t('deck.notFound')}</div>;

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const avail       = deckAvailability(user, profileId, deck, state.cards, state.cardWorks, w);
  const stab        = deckStability(profileId, deck, state.cards, state.cardWorks, w);
  const ease        = deckEase(profileId, deck, state.cards, state.cardWorks, w);
  const stabWindow  = stab > 0 ? retentionWindowDays(stab, user.availabilityThreshold) : 0;
  const candidates  = deck.entries.filter(e => !isAvailable(user, state.cardWorks[`${profileId}:${e.cardId}`])).length;
  const noCards     = deck.entries.length === 0;
  const allMastered = !noCards && candidates === 0;

  // ── Quick-link matches ────────────────────────────────────────────────────────
  const alreadyInDeck = new Set(deck.entries.map(e => e.cardId));
  const linkMatches   = linkQuery
    ? Object.values(state.cards)
        .filter(c => !alreadyInDeck.has(c.id) && c.name.toLowerCase().includes(linkQuery.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 12)
    : [];

  // ── Drag handlers ─────────────────────────────────────────────────────────────
  const onDragStart = (cardId: string, e: DragEvent) => {
    draggedId.current = cardId;
    e.dataTransfer?.setData('text/plain', cardId);
    setTimeout(() => setActiveDragId(cardId), 0);
  };
  const onDragEnd = () => { draggedId.current = null; setActiveDragId(null); setDropTarget(null); };
  const onDragOver = (cardId: string, e: DragEvent) => {
    if (!draggedId.current || draggedId.current === cardId) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: 'before' | 'after' = (e.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
    if (dropTarget?.cardId !== cardId || dropTarget?.zone !== zone) setDropTarget({ cardId, zone });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(null);
  };
  const onDrop = (cardId: string, e: DragEvent) => {
    const fromId = draggedId.current;
    if (!fromId || fromId === cardId) return;
    e.preventDefault();
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = (e.clientY - rect.top) / rect.height < 0.5;
    setDropTarget(null);
    draggedId.current = null;
    mutate(s => {
      const entries = s.decks[deckId]!.entries;
      const from    = entries.findIndex(en => en.cardId === fromId);
      if (from === -1) return;
      const [moved] = entries.splice(from, 1);
      const to      = entries.findIndex(en => en.cardId === cardId);
      if (to === -1) { entries.push(moved); return; }
      entries.splice(before ? to : to + 1, 0, moved);
    });
  };

  return (
    <div class="flex flex-col h-full view-enter">

      {/* ── Top section ── */}
      <div class="shrink-0 px-6 pt-6 pb-4 space-y-6">

        {/* Header */}
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            {isEditingName ? (
              <input
                type="text"
                value={editName}
                autoFocus
                class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full"
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                onBlur={() => {
                  const val = editName.trim();
                  if (val && val !== deck.name) mutate(s => { s.decks[deckId]!.name = val; });
                  setIsEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setIsEditingName(false);
                }}
              />
            ) : (
              <h1
                class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors"
                title="Click to rename"
                onClick={() => { setEditName(deck.name); setIsEditingName(true); }}
              >
                {deck.name}
              </h1>
            )}
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              class="btn-danger px-2"
              title={t('deck.deleteTitle')}
              onClick={() => confirmModal(
                t('deck.delete.title'),
                t('deck.delete.message', { name: deck.name }),
                t('common.delete'),
                () => {
                  const parent = findParentFolder(deckId, 'deck', state);
                  mutate(s => {
                    delete s.decks[deckId];
                    if (parent) s.folders[parent]!.deckIds = s.folders[parent]!.deckIds.filter(id => id !== deckId);
                    else s.rootDeckIds = s.rootDeckIds.filter(id => id !== deckId);
                  });
                  navigate({ view: 'folder', folderId: findParentFolder(deckId, 'deck', state) });
                }
              )}
            >
              <SvgIcon icon={trashIcon()} />
            </button>
          </div>
        </div>

        {/* Metrics */}
        <div class="grid grid-cols-3 gap-3">
          <div class="card-block space-y-2">
            <div class="section-title">{t('deck.section.availability')}</div>
            <div class={`text-2xl font-mono font-semibold ${avail >= 0.75 ? 'text-success' : avail >= 0.4 ? 'text-warn' : avail > 0 ? 'text-danger' : 'text-primary'}`}>
              {pct(avail)}
            </div>
          </div>
          <div class="card-block space-y-2">
            <div class="section-title">{t('deck.section.stability')}</div>
            <div class="text-2xl font-mono font-semibold text-primary">
              {stabWindow > 0 ? formatDays(stabWindow) : '—'}
            </div>
          </div>
          <div class="card-block space-y-2">
            <div class="section-title">{t('deck.section.ease')}</div>
            <div class={`text-2xl font-mono font-semibold ${ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : ease > 0 ? 'text-danger' : 'text-primary'}`}>
              {ease > 0 ? pct(ease) : '—'}
            </div>
          </div>
        </div>

        {/* Study button */}
        <button
          class={(noCards || allMastered)
            ? 'btn w-full py-3 text-base font-semibold bg-elevated text-dim cursor-default'
            : 'btn-primary w-full py-3 text-base font-semibold'}
          onClick={(!noCards && !allMastered) ? () => showStrategyModal(deckId) : undefined}
        >
          {noCards ? t('deck.noCards') : allMastered ? t('deck.allAvailable') : t('deck.study')}
        </button>
      </div>

      {/* ── Cards header + quick-link ── */}
      <div class="shrink-0 flex items-center justify-between px-6 pb-2">
        <span class="section-title">{t('deck.section.cards', { count: deck.entries.length })}</span>

        <div class="relative w-44">
          <input
            type="text"
            value={linkQuery}
            placeholder={t('deck.quickLink.placeholder')}
            class="w-full text-xs bg-transparent text-dim placeholder:text-dim/50 outline-none py-0.5 px-2 border border-dashed border-border rounded hover:border-accent/50 focus:border-accent transition-colors"
            onInput={(e) => setLinkQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setLinkQuery(''); }}
            onBlur={() => setTimeout(() => setLinkQuery(''), 100)}
          />
          {linkQuery && (
            <div class="absolute z-10 left-0 right-0 top-full mt-1 bg-surface border border-border rounded shadow-lg max-h-52 overflow-y-auto">
              {linkMatches.length === 0 ? (
                <p class="text-sm text-dim italic px-3 py-2">{t('deck.quickLink.noMatch')}</p>
              ) : linkMatches.map(card => (
                <div
                  key={card.id}
                  class="px-3 py-2 text-sm text-primary hover:bg-elevated cursor-pointer transition-colors truncate"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    mutate(s => { s.decks[deckId]!.entries.push({ cardId: card.id }); });
                    setLinkQuery('');
                  }}
                >
                  {card.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Cards list ── */}
      <div class="flex-1 overflow-y-auto px-6 pb-6">
        <div class="space-y-3">
          {deck.entries.length === 0 ? (
            <p class="text-sm text-dim italic">{t('deck.empty')}</p>
          ) : (
            <div class="space-y-1">
              {deck.entries.map(entry => {
                const card   = state.cards[entry.cardId];
                if (!card) return null;
                const work     = state.cardWorks[`${profileId}:${entry.cardId}`];
                const k        = cardAvailability(user, work);
                const fsrs     = work ? replayFSRS(work.history) : undefined;
                const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
                const imp      = effectiveImportance(card, entry);
                const lastTs   = work?.history.at(-1)?.ts;
                const isDrop   = dropTarget?.cardId === entry.cardId;

                return (
                  <div
                    key={entry.cardId}
                    draggable
                    ref={(el) => { if (el) addTouchDragSupport(el as HTMLElement); }}
                    class={[
                      'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group',
                      activeDragId === entry.cardId ? 'opacity-40' : '',
                      isDrop && dropTarget?.zone === 'before' ? 'drop-before' : '',
                      isDrop && dropTarget?.zone === 'after'  ? 'drop-after'  : '',
                    ].join(' ')}
                    onDragStart={(e) => onDragStart(entry.cardId, e as unknown as DragEvent)}
                    onDragEnd={() => onDragEnd()}
                    onDragOver={(e) => onDragOver(entry.cardId, e as unknown as DragEvent)}
                    onDragLeave={(e) => onDragLeave(e as unknown as DragEvent)}
                    onDrop={(e) => onDrop(entry.cardId, e as unknown as DragEvent)}
                  >
                    <span class="text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>

                    <span class="flex gap-0.5 items-center shrink-0">
                      <span class={`w-2 h-2 rounded-full ${availabilityColor(k)}`} title={`R: ${pct(k)}`} />
                      <span
                        class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                        title={cardEase !== undefined ? `Ease: ${pct(cardEase)}` : 'Never reviewed'}
                      />
                    </span>

                    <span
                      class="text-sm text-primary flex-1 truncate cursor-pointer hover:text-accent"
                      onClick={() => navigate({ view: 'card', cardId: card.id })}
                    >
                      {card.name}
                    </span>

                    <span class="text-xs font-mono text-dim shrink-0">
                      {lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}
                    </span>

                    <span
                      class={`text-xs font-mono shrink-0 w-6 text-right cursor-pointer hover:text-accent transition-colors ${entry.importanceOverride !== undefined ? 'text-accent' : 'text-dim'}`}
                      title={entry.importanceOverride !== undefined ? t('deck.importanceTitleOverride') : t('deck.importanceTitleDefault')}
                      onClick={() => showImportanceModal(deckId, entry, card.importance)}
                    >
                      ×{imp}
                    </span>

                    <div class="hidden group-hover:flex gap-2">
                      <button
                        class="text-dim hover:text-danger transition-colors cursor-pointer"
                        title={t('deck.removeFromDeck')}
                        onClick={() => mutate(s => { s.decks[deckId]!.entries = s.decks[deckId]!.entries.filter(e => e.cardId !== card.id); })}
                      >
                        <SvgIcon icon={unlinkIcon()} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
