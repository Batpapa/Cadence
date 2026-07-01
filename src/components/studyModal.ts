import { appState, navigate } from '../store';
import { pickRandom, pickOptimal, pickStochastic } from '../services/deckService';
import { buildContextualEntries } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { modalMaxH, modalMaxW } from '../services/zoomService';
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

export function showStudyModal(opts: StudyModalOpts): void {
  const user = appState.value;
  const { entries, title, defaultContext = null, deckId } = opts;

  // ── Shell ──────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col';
  dialog.style.cssText = `max-width:min(${modalMaxW(0.9)}, 28rem); max-height:${modalMaxH(0.85)};`;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-4 border-b border-border shrink-0';

  const titleEl = document.createElement('h2');
  titleEl.className = 'text-xs font-semibold text-muted uppercase tracking-widest truncate';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0';
  closeBtn.textContent = '✕';

  header.append(titleEl, closeBtn);

  const body = document.createElement('div');
  body.className = 'px-5 py-4 overflow-y-auto flex-1 space-y-4';

  dialog.append(header, body);
  overlay.appendChild(dialog);

  const close = () => overlay.remove();
  closeBtn.onclick = close;
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', e => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', e => { if (e.target === overlay && mouseDownOnOverlay) close(); });

  // ── Context picker ─────────────────────────────────────────────────────────
  const cardIdSet = new Set(entries.map(e => e.cardId));
  const contextDecks = Object.values(user.decks)
    .filter(d => d.entries.some(e => cardIdSet.has(e.cardId)))
    .sort((a, b) => a.name.localeCompare(b.name));

  let selectedContext: string | null = defaultContext;

  const ctxRow = document.createElement('div');
  ctxRow.className = 'flex items-center gap-3';

  const ctxLabel = document.createElement('label');
  ctxLabel.className = 'text-xs font-semibold text-muted uppercase tracking-widest shrink-0';
  ctxLabel.textContent = t('deck.context.title');

  const ctxSelect = document.createElement('select') as HTMLSelectElement;
  ctxSelect.className = 'flex-1 text-sm bg-surface border border-border rounded px-2 py-1.5 text-primary outline-none cursor-pointer focus:border-accent';

  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = t('deck.context.default');
  ctxSelect.appendChild(defOpt);

  for (const d of contextDecks) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    ctxSelect.appendChild(opt);
  }

  ctxSelect.value = defaultContext ?? '';

  const ctxWarn = document.createElement('p');
  ctxWarn.className = 'text-xs text-warn mt-1';

  const updateCtxWarn = () => {
    if (!selectedContext) { ctxWarn.textContent = ''; return; }
    const pool: Deck = deckId
      ? (user.decks[deckId] ?? { id: deckId, name: title, entries })
      : { id: '__virtual', name: title, entries };
    const kept     = buildContextualEntries(pool, selectedContext, user);
    const excluded = entries.length - kept.length;
    ctxWarn.textContent = excluded > 0 ? t('study.excludedByContext', { n: excluded }) : '';
  };

  ctxSelect.onchange = () => {
    selectedContext = ctxSelect.value || null;
    updateCtxWarn();
  };
  updateCtxWarn();

  ctxRow.append(ctxLabel, ctxSelect);
  const ctxBlock = document.createElement('div');
  ctxBlock.append(ctxRow, ctxWarn);
  body.appendChild(ctxBlock);

  // ── Divider ────────────────────────────────────────────────────────────────
  const divider = document.createElement('div');
  divider.className = 'border-t border-border';
  body.appendChild(divider);

  // ── Strategy buttons ───────────────────────────────────────────────────────
  const stratTitle = document.createElement('div');
  stratTitle.className = 'text-xs font-semibold text-muted uppercase tracking-widest mb-2';
  stratTitle.textContent = t('deck.strategy.title');
  body.appendChild(stratTitle);

  const STRATEGY_ICONS: Record<StudyStrategy, { svg: string; color: string; bg: string }> = {
    random: {
      svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="4"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/></svg>`,
      color: 'text-sky-400',
      bg:    'bg-sky-400/10',
    },
    optimal: {
      svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`,
      color: 'text-emerald-400',
      bg:    'bg-emerald-400/10',
    },
    stochastic: {
      svg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="2" y="12" width="5" height="10" rx="1"/><rect x="9.5" y="4" width="5" height="18" rx="1"/><rect x="17" y="8" width="5" height="14" rx="1"/></svg>`,
      color: 'text-violet-400',
      bg:    'bg-violet-400/10',
    },
  };

  const strategies: Array<{ id: StudyStrategy; labelKey: string; subKey: string }> = [
    { id: 'random',     labelKey: 'deck.strategy.random',     subKey: 'deck.strategy.random.sub' },
    { id: 'optimal',    labelKey: 'deck.strategy.optimal',    subKey: 'deck.strategy.optimal.sub' },
    { id: 'stochastic', labelKey: 'deck.strategy.stochastic', subKey: 'deck.strategy.stochastic.sub' },
  ];

  for (const s of strategies) {
    const ic = STRATEGY_ICONS[s.id];
    const btn = document.createElement('button');
    btn.className = 'w-full text-left card-block hover:border-accent/60 transition-colors cursor-pointer';
    btn.innerHTML = `<div class="flex gap-3.5 items-center"><div class="shrink-0 w-10 h-10 rounded-xl ${ic.bg} ${ic.color} flex items-center justify-center">${ic.svg}</div><div class="flex-1 min-w-0"><div class="text-sm font-medium text-primary">${t(s.labelKey)}</div><div class="text-xs text-muted mt-0.5">${t(s.subKey)}</div></div><div class="shrink-0 text-dim text-base leading-none">›</div></div>`;
    btn.onclick = () => {
      close();
      const u = appState.value;
      const pid = u.currentProfileId;
      const w   = u.weightByImportance ?? true;

      // Pool: live deck when deckId provided; frozen snapshot otherwise
      const pool: Deck = deckId
        ? (u.decks[deckId] ?? { id: deckId, name: title, entries })
        : { id: '__virtual', name: title, entries };

      const ctxEntries = buildContextualEntries(pool, selectedContext, u);
      const ctxPool: Deck = { ...pool, entries: ctxEntries };

      const pickers: Record<StudyStrategy, () => DeckEntry | null> = {
        random:     () => pickRandom(u, pid, ctxPool, u.cardWorks),
        optimal:    () => pickOptimal(u, pid, ctxPool, u.cards, u.cardWorks, w),
        stochastic: () => pickStochastic(u, pid, ctxPool, u.cards, u.cardWorks, w),
      };
      const firstCard = pickers[s.id]();

      navigate({
        view:           'study',
        deckId,
        cardIds:        deckId ? undefined : entries.map(e => e.cardId),
        studyTitle:     deckId ? undefined : title,
        strategy:       s.id,
        currentCardId:  firstCard?.cardId ?? null,
        contextDeckId:  selectedContext,
      });
    };
    body.appendChild(btn);
  }

  document.body.appendChild(overlay);
}
