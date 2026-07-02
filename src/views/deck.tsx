import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { pct, timeAgo, availabilityColor, addTouchDragSupport } from '../utils';
import { TrashIcon, UnlinkIcon, StarIcon } from '../components/icons';
import { confirmModal } from '../components/modal';
import { findParentFolder } from '../services/deckService';
import { deckAvailability, cardAvailability, effectiveImportance, isAvailable, deckStability, deckEase, replayFSRS, retentionWindowDays } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { showStudyModal } from '../components/studyModal';


function DeckMetric({ label, value, colorClass = 'text-primary' }: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <div class="flex items-baseline gap-2">
      <span class="text-[10px] font-medium uppercase tracking-wider text-dim">{label}</span>
      <span class={`text-sm font-mono font-semibold ${colorClass}`}>{value}</span>
    </div>
  );
}

function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',    { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths',   { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',     { n: Math.round(d) });
  return t('common.durationLessThanDay');
}



export function DeckView({ deckId }: { deckId: string }) {
  const user      = appState.value;
  const deck      = user.decks[deckId];
  const profileId = user.currentProfileId;
  const w         = user.weightByImportance ?? true;

  // Inline name editing
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName]           = useState('');

  // Quick-link dropdown
  const [linkQuery, setLinkQuery] = useState('');

  // Inline deck importance editing
  const [editingImportanceId, setEditingImportanceId] = useState<string | null>(null);
  const [importanceDraft, setImportanceDraft] = useState('');
  const importanceInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (editingImportanceId && importanceInputRef.current) {
      importanceInputRef.current.focus();
      importanceInputRef.current.select();
    }
  }, [editingImportanceId]);

  // Drag-and-drop — ref for active drag id (avoids re-renders on every dragover)
  const draggedId = useRef<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget]     = useState<{ cardId: string; zone: 'before' | 'after' } | null>(null);

  if (!deck) return <div class="flex flex-col h-full view-enter">{t('deck.notFound')}</div>;

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const avail       = deckAvailability(user, profileId, deck, user.cards, user.cardWorks, w);
  const stab        = deckStability(profileId, deck, user.cards, user.cardWorks, w);
  const ease        = deckEase(profileId, deck, user.cards, user.cardWorks, w);
  const stabWindow  = stab > 0 ? retentionWindowDays(stab, user.availabilityThreshold) : 0;
  const candidates  = deck.entries.filter(e => !isAvailable(user, user.cardWorks[`${profileId}:${e.cardId}`])).length;
  const noCards     = deck.entries.length === 0;
  const allMastered = !noCards && candidates === 0;

  // ── Quick-link matches ────────────────────────────────────────────────────────
  const alreadyInDeck = new Set(deck.entries.map(e => e.cardId));
  const linkMatches   = linkQuery
    ? Object.values(user.cards)
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
    <div class="overflow-y-auto h-full view-enter">

      {/* ── Top section ── */}
      <div class="px-6 pt-6 pb-4 space-y-6">

        {/* Header */}
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0 flex items-center gap-2">
            <button
              class={`shrink-0 flex items-center transition-colors cursor-pointer ${deck.favorite ? 'text-yellow-400' : 'text-dim hover:text-yellow-400'}`}
              title={deck.favorite ? t('deck.unfavorite') : t('deck.favorite')}
              onClick={() => mutate(s => { const d = s.decks[deckId]; if (d) d.favorite = !d.favorite; })}
            >
              <StarIcon size={20} filled={!!deck.favorite} />
            </button>
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
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              class={noCards || allMastered
                ? 'btn px-3 bg-elevated text-dim cursor-default text-sm font-medium'
                : 'btn px-3 bg-success/80 hover:bg-success text-white transition-colors cursor-pointer text-sm font-medium'}
              onClick={(!noCards && !allMastered) ? () => showStudyModal({ entries: deck.entries, title: deck.name, defaultContext: deckId, deckId }) : undefined}
            >
              {t('deck.study')}
            </button>
            <button
              class="btn-danger px-2"
              title={t('deck.deleteTitle')}
              onClick={() => confirmModal(
                t('deck.delete.title'),
                t('deck.delete.message', { name: deck.name }),
                t('common.delete'),
                () => {
                  const parent = findParentFolder(deckId, 'deck', user);
                  mutate(s => {
                    delete s.decks[deckId];
                    if (parent) s.folders[parent]!.deckIds = s.folders[parent]!.deckIds.filter(id => id !== deckId);
                    else s.rootDeckIds = s.rootDeckIds.filter(id => id !== deckId);
                  });
                  navigate({ view: 'folder', folderId: findParentFolder(deckId, 'deck', user) });
                }
              )}
            >
              <TrashIcon />
            </button>
          </div>
        </div>

        {/* Metrics — single evenly-spaced inline row */}
        <div class="stats-container border-y border-border">
        <div class="stats-grid py-3 px-4 gap-x-4 gap-y-3 justify-items-center">
          <DeckMetric
            label={t('deck.section.availability')}
            value={pct(avail)}
            colorClass={avail >= 0.75 ? 'text-success' : avail >= 0.4 ? 'text-warn' : avail > 0 ? 'text-danger' : 'text-primary'}
          />
          <DeckMetric
            label={t('deck.section.stability')}
            value={stabWindow > 0 ? formatDays(stabWindow) : '—'}
          />
          <DeckMetric
            label={t('deck.section.ease')}
            value={ease > 0 ? pct(ease) : '—'}
            colorClass={ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : ease > 0 ? 'text-danger' : 'text-primary'}
          />
          <DeckMetric
            label={t('deck.section.mastery')}
            value={noCards ? '—' : `${deck.entries.length - candidates}/${deck.entries.length}`}
            colorClass={allMastered ? 'text-success' : 'text-primary'}
          />
        </div>
        </div>

      </div>

      {/* ── Cards header + quick-link ── */}
      <div class="flex items-center justify-between px-6 pb-2">
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
      <div class="px-6 pb-6">
        <div class="space-y-3">
          {deck.entries.length === 0 ? (
            <p class="text-sm text-dim italic">{t('deck.empty')}</p>
          ) : (
            <div class="space-y-1">
              {(() => {
                const impColWidth = Math.max(...deck.entries.map(e => {
                  const c = user.cards[e.cardId]; if (!c) return 2;
                  return String(`×${effectiveImportance(c, e)}`).length;
                }));
                return deck.entries.map(entry => {
                const card   = user.cards[entry.cardId];
                if (!card) return null;
                const work     = user.cardWorks[`${profileId}:${entry.cardId}`];
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
                      <span class={`w-2 h-2 rounded-full ${availabilityColor(k)}`} title={t('card.dot.recall', { pct: pct(k) })} />
                      <span
                        class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                        title={cardEase !== undefined ? t('card.dot.ease', { pct: pct(cardEase) }) : t('card.neverReviewed')}
                      />
                    </span>

                    <span
                      class="text-sm text-primary flex-1 truncate cursor-pointer hover:text-accent"
                      onClick={() => navigate({ view: 'card', cardId: card.id, contextDeckId: deckId })}
                    >
                      {card.name}
                    </span>

                    <span class="hidden sm:block text-xs font-mono text-dim shrink-0">
                      {lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}
                    </span>

                    {editingImportanceId === entry.cardId ? (
                      <input
                        ref={importanceInputRef}
                        type="number" min="0" step="0.1"
                        value={importanceDraft}
                        style={{ width: `${impColWidth}ch` }}
                        class="text-xs font-mono text-right p-0 bg-transparent border-b border-accent outline-none text-primary shrink-0 leading-none"
                        onInput={(e) => setImportanceDraft((e.target as HTMLInputElement).value)}
                        onBlur={() => {
                          const val = parseFloat(importanceDraft);
                          mutate(s => {
                            const e = s.decks[deckId]!.entries.find(e => e.cardId === entry.cardId);
                            if (!e) return;
                            if (isNaN(val) || importanceDraft.trim() === '') delete e.importance;
                            else e.importance = val;
                          });
                          setEditingImportanceId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditingImportanceId(null);
                        }}
                      />
                    ) : (
                      <span
                        style={{ width: `${impColWidth}ch` }}
                        class={`text-xs font-mono shrink-0 text-right cursor-pointer hover:text-accent transition-colors ${entry.importance !== undefined ? 'text-accent' : 'text-dim'}`}
                        title={entry.importance !== undefined ? t('deck.importanceTitleDeck') : t('deck.importanceTitleDefault')}
                        onClick={() => { setImportanceDraft(entry.importance !== undefined ? String(entry.importance) : ''); setEditingImportanceId(entry.cardId); }}
                      >
                        ×{imp}
                      </span>
                    )}

                    <div class="hidden group-hover:flex gap-2">
                      <button
                        class="text-dim hover:text-danger transition-colors cursor-pointer"
                        title={t('deck.removeFromDeck')}
                        onClick={() => mutate(s => { s.decks[deckId]!.entries = s.decks[deckId]!.entries.filter(e => e.cardId !== card.id); })}
                      >
                        <UnlinkIcon />
                      </button>
                    </div>
                  </div>
                );
              });
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
