import type { AppContext } from '../types';
import { pct, timeAgo, trashIcon, makeInlineEditable, unlinkIcon, focusIfDesktop } from '../utils';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { renderNotes, renderFiles } from '../components/fileViewer';
import { renderEmbeds } from '../components/embedViewer';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardKnowledge, masteryWindowDays, replayFSRS } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';

export function renderCardView(ctx: AppContext, cardId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const card = state.cards[cardId];
  if (!card) { wrap.textContent = t('card.notFound'); return wrap; }

  const user = getCurrentUser(state);
  const work = state.cardWorks[`${user.id}:${cardId}`];
  const k = cardKnowledge(user, work);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'flex items-start justify-between gap-4';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = card.name;
  makeInlineEditable(title, card.name, val => ctx.mutate(s => { s.cards[cardId]!.name = val; }));

  // Deck tags
  const deckIds = decksContainingCard(cardId, state);
  const tags = document.createElement('div'); tags.className = 'flex flex-wrap gap-1.5 mt-1.5';
  for (const dId of deckIds) {
    const deck = state.decks[dId]; if (!deck) continue;
    const tag = document.createElement('span');
    tag.className = 'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent group transition-colors hover:bg-accent/20';

    const nameEl = document.createElement('span');
    nameEl.className = 'cursor-pointer'; nameEl.textContent = deck.name;
    nameEl.title = deckPath(dId, state);
    nameEl.onclick = () => ctx.navigate({ view: 'deck', deckId: dId });

    const unlinkBtn = document.createElement('button');
    unlinkBtn.className = 'opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:text-danger leading-none';
    unlinkBtn.title = t('card.removeFromDeck');
    unlinkBtn.appendChild(unlinkIcon(10));
    unlinkBtn.onclick = (e) => {
      e.stopPropagation();
      ctx.mutate(s => { const d = s.decks[dId]; if (d) d.entries = d.entries.filter(e => e.cardId !== cardId); });
    };

    tag.append(nameEl, unlinkBtn);
    tags.appendChild(tag);
  }
  const addToDeckChip = document.createElement('span');
  addToDeckChip.className = 'text-xs px-2 py-0.5 rounded-full border border-dashed border-border text-dim cursor-pointer hover:text-primary hover:border-muted transition-colors';
  addToDeckChip.textContent = '+'; addToDeckChip.title = t('card.addToDeck');
  addToDeckChip.onclick = () => {
    const available = Object.values(state.decks)
      .filter(d => !d.entries.some(e => e.cardId === cardId))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (available.length === 0) {
      const p = document.createElement('p'); p.className = 'text-sm text-muted';
      p.textContent = t('card.allDecks');
      showModal(t('card.addToDeck.title'), p, [{ label: t('common.close'), onClick: closeModal }]);
      return;
    }

    const selected = new Set<string>();
    const body = document.createElement('div'); body.className = 'space-y-1 max-h-64 overflow-y-auto';

    for (const deck of available) {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-3 px-2 py-2 rounded cursor-pointer hover:bg-elevated transition-colors';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'card-checkbox';
      chk.onchange = () => { if (chk.checked) selected.add(deck.id); else selected.delete(deck.id); };
      const name = document.createElement('span'); name.className = 'text-sm text-primary'; name.textContent = deck.name;
      row.append(chk, name);
      body.appendChild(row);
    }

    showModal(t('card.addToDeck.title'), body, [
      { label: t('common.cancel'), onClick: closeModal },
      { label: t('common.add'), primary: true, onClick: () => {
        if (selected.size === 0) return;
        closeModal();
        ctx.mutate(s => {
          for (const dId of selected) {
            const d = s.decks[dId]; if (d) d.entries.push({ cardId });
          }
        });
      }},
    ]);
  };
  tags.appendChild(addToDeckChip);
  titleWrap.append(title, tags);

  const headerActions = document.createElement('div'); headerActions.className = 'flex gap-2 shrink-0';

  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = t('card.deleteTitle'); deleteBtn.appendChild(trashIcon());
  deleteBtn.onclick = () => confirmModal(t('card.delete.title'), t('card.delete.message', { name: card.name }), t('common.delete'), () => {
    ctx.mutate(s => {
      delete s.cards[cardId];
      for (const deck of Object.values(s.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
      delete s.cardWorks[`${s.currentUserId}:${cardId}`];
    });
    ctx.navigate({ view: 'folder', folderId: null });
  });

  headerActions.append(deleteBtn);
  header.append(titleWrap, headerActions);
  wrap.appendChild(header);

  // ── Knowledge, Mastery window & Importance ──
  const statsRow = document.createElement('div'); statsRow.className = 'grid grid-cols-3 gap-3';

  // Knowledge
  const knBox = document.createElement('div'); knBox.className = 'card-block space-y-1';
  const knLabel = document.createElement('div'); knLabel.className = 'section-title'; knLabel.textContent = t('card.section.knowledge');
  const knVal = document.createElement('div'); knVal.className = 'text-lg font-mono font-semibold text-primary'; knVal.textContent = pct(k);
  const knSub = document.createElement('div'); knSub.className = 'text-xs text-muted';
  if (work?.history.length) {
    const count = work.history.length;
    knSub.textContent = t(count > 1 ? 'card.knowledgeSubPlural' : 'card.knowledgeSub', { count, ago: timeAgo(work.history.at(-1)!.ts) });
  } else {
    knSub.textContent = t('card.neverReviewed');
  }
  knBox.append(knLabel, knVal, knSub);

  // Importance
  const impBox = document.createElement('div'); impBox.className = 'card-block space-y-1';
  const impLabel = document.createElement('div'); impLabel.className = 'section-title'; impLabel.textContent = t('card.section.importance');
  const impRow = document.createElement('div'); impRow.className = 'flex items-center gap-2';
  const impVal = document.createElement('span'); impVal.className = 'text-lg font-mono font-semibold text-primary'; impVal.textContent = `×${card.importance}`;
  const impEditBtn = document.createElement('button'); impEditBtn.className = 'text-xs text-dim hover:text-accent cursor-pointer transition-colors'; impEditBtn.textContent = t('card.edit');
  impEditBtn.onclick = () => {
    const b = document.createElement('div'); b.className = 'space-y-2';
    const l = document.createElement('label'); l.className = 'label'; l.textContent = t('card.importance.label');
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0.1'; inp.step = '0.1'; inp.value = String(card.importance); inp.className = 'input';
    b.append(l, inp);
    showModal(t('card.importance.title'), b, [
      { label: t('common.cancel'), onClick: closeModal },
      { label: t('common.save'), primary: true, onClick: () => {
        const val = parseFloat(inp.value);
        if (!isNaN(val) && val > 0) { closeModal(); ctx.mutate(s => { s.cards[cardId]!.importance = val; }); }
      }},
    ]);
    focusIfDesktop(inp);
  };
  impRow.append(impVal, impEditBtn);
  impBox.append(impLabel, impRow);

  // Mastery window (FSRS)
  const fsrsState = work ? replayFSRS(work.history) : undefined;
  const mw = fsrsState ? masteryWindowDays(fsrsState.stability, user.masteryThreshold) : undefined;
  const hlBox = document.createElement('div'); hlBox.className = 'card-block space-y-1';
  const hlLabel = document.createElement('div'); hlLabel.className = 'section-title'; hlLabel.textContent = t('card.section.masteryWindow');
  const hlVal = document.createElement('div'); hlVal.className = 'text-lg font-mono font-semibold text-primary';
  hlVal.textContent = mw === undefined ? '—' : mw >= 1 ? `${Math.round(mw)}d` : `${Math.round(mw * 24)}h`;
  const hlSub = document.createElement('div'); hlSub.className = 'text-xs text-muted';
  hlSub.textContent = mw === undefined ? t('card.masteryWindowNone') : t('card.masteryWindowDuration');
  hlBox.append(hlLabel, hlVal, hlSub);

  statsRow.append(knBox, hlBox, impBox);
  wrap.appendChild(statsRow);

  // ── Tags ──
  const tagsSection = document.createElement('div'); tagsSection.className = 'space-y-2';
  const tagsHeader = document.createElement('div'); tagsHeader.className = 'flex items-center justify-between';
  const tagsTitle = document.createElement('span'); tagsTitle.className = 'section-title'; tagsTitle.textContent = t('card.section.tags');
  tagsHeader.appendChild(tagsTitle);
  tagsSection.appendChild(tagsHeader);

  const tagsBody = document.createElement('div'); tagsBody.className = 'flex flex-wrap items-center gap-1.5';

  const refreshTags = () => {
    tagsBody.innerHTML = '';
    for (const tag of (card.tags ?? [])) {
      const chip = document.createElement('span');
      chip.className = 'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-elevated border border-border text-muted group';
      const label = document.createElement('span');
      label.textContent = tag;
      label.className = 'cursor-text hover:text-primary transition-colors';
      label.title = t('card.renameTag');
      label.onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = tag;
        inp.className = 'text-xs bg-transparent border-none outline-none text-primary w-16';
        label.replaceWith(inp); inp.focus(); inp.select();
        const commit = () => {
          const val = inp.value.trim().toLowerCase().replace(/,/g, '');
          if (val && val !== tag && !(card.tags ?? []).includes(val)) {
            ctx.mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.map(t => t === tag ? val : t); });
          } else { inp.replaceWith(label); }
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { inp.replaceWith(label); }
        });
      };
      const rm = document.createElement('button');
      rm.className = 'opacity-0 group-hover:opacity-100 text-dim hover:text-danger transition-all cursor-pointer leading-none';
      rm.textContent = '✕';
      rm.onclick = () => { ctx.mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.filter(t => t !== tag); }); };
      chip.append(label, rm);
      tagsBody.appendChild(chip);
    }
    const addInput = document.createElement('input');
    addInput.type = 'text'; addInput.placeholder = '+'; addInput.title = t('card.addToDeck'); addInput.className = 'text-xs bg-transparent border-none outline-none text-dim placeholder-dim w-6 focus:w-24 transition-all';
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = addInput.value.trim().toLowerCase().replace(/,/g, '');
        if (val && !(card.tags ?? []).includes(val)) {
          ctx.mutate(s => { const c = s.cards[cardId]; if (c) { if (!c.tags) c.tags = []; c.tags.push(val); } });
        } else { addInput.value = ''; }
      }
      if (e.key === 'Escape') addInput.blur();
    });
    tagsBody.appendChild(addInput);
  };

  refreshTags();
  tagsSection.appendChild(tagsBody);
  wrap.appendChild(tagsSection);

  // ── Notes ──
  const notesSection = document.createElement('div'); notesSection.className = 'space-y-2';
  const notesHeader = document.createElement('div'); notesHeader.className = 'flex items-center justify-between';
  const notesTitle = document.createElement('span'); notesTitle.className = 'section-title'; notesTitle.textContent = t('card.section.notes');
  let editingNotes = false;
  let notesDraft = card.content.notes;

  const toggleEditBtn = document.createElement('button'); toggleEditBtn.className = 'btn-ghost text-xs'; toggleEditBtn.textContent = t('card.edit');
  const notesContent = document.createElement('div'); notesContent.appendChild(renderNotes(card.content.notes));

  toggleEditBtn.onclick = () => {
    editingNotes = !editingNotes;
    toggleEditBtn.textContent = editingNotes ? t('card.preview') : t('card.edit');
    notesContent.innerHTML = '';
    if (editingNotes) {
      const ta = document.createElement('textarea'); ta.value = notesDraft; ta.className = 'input w-full font-mono text-xs resize-none'; ta.rows = 12;
      ta.addEventListener('input', () => { notesDraft = ta.value; });
      ta.addEventListener('blur', () => { ctx.save(s => { s.cards[cardId]!.content.notes = notesDraft; }); });
      notesContent.appendChild(ta);
      focusIfDesktop(ta);
    } else {
      ctx.save(s => { s.cards[cardId]!.content.notes = notesDraft; });
      notesContent.appendChild(renderNotes(notesDraft));
    }
  };

  notesHeader.append(notesTitle, toggleEditBtn);
  notesSection.append(notesHeader, notesContent);
  wrap.appendChild(notesSection);

  // ── Files ──
  wrap.appendChild(renderFiles({
    files: card.content.files, editable: true,
    onAdd:    (e) => ctx.mutate(s => { s.cards[cardId]!.content.files.push(e); }),
    onRemove: (i) => ctx.mutate(s => { s.cards[cardId]!.content.files.splice(i, 1); }),
  }));

  // ── Embeds ──
  const embeds = card.content.embeds ?? [];
  wrap.appendChild(renderEmbeds({
    embeds, editable: true,
    onAdd:    (e) => ctx.mutate(s => { const c = s.cards[cardId]!; c.content.embeds = [...(c.content.embeds ?? []), e]; }),
    onRemove: (i) => ctx.mutate(s => { const c = s.cards[cardId]!; (c.content.embeds ?? []).splice(i, 1); }),
  }));

  // ── Review history ──
  {
    const histSection = document.createElement('div'); histSection.className = 'space-y-2';
    const count = work?.history.length ?? 0;
    const histTitle = document.createElement('span'); histTitle.className = 'section-title';
    histTitle.textContent = count > 0
      ? t(count > 1 ? 'card.section.reviewHistoryCountPlural' : 'card.section.reviewHistoryCount', { count })
      : t('card.section.reviewHistory');
    histSection.appendChild(histTitle);
    const list = document.createElement('div'); list.className = 'flex flex-wrap gap-1.5';

    const ratingIcon: Record<string, string>  = { again: '✗', hard: '△', good: '○', easy: '✓' };
    const ratingColor: Record<string, string> = { again: 'text-danger', hard: 'text-warn', good: 'text-accent', easy: 'text-success' };
    const sorted = work ? [...work.history].sort((a, b) => a.ts - b.ts) : [];
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      const originalIndex = work!.history.indexOf(entry);
      const badge = document.createElement('span');
      badge.className = 'inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 bg-elevated rounded text-muted group';
      const dateLabel = document.createElement('span'); dateLabel.textContent = new Date(entry.ts).toLocaleString();
      if (entry.rating) {
        const rIcon = document.createElement('span');
        rIcon.className = `text-[10px] ${ratingColor[entry.rating] ?? ''}`;
        rIcon.textContent = ratingIcon[entry.rating] ?? '';
        badge.appendChild(rIcon);
      }
      badge.appendChild(dateLabel);
      const rmBtn = document.createElement('button');
      rmBtn.className = 'opacity-0 group-hover:opacity-100 text-dim hover:text-danger transition-all cursor-pointer leading-none';
      rmBtn.textContent = '✕';
      rmBtn.onclick = () => { ctx.mutate(s => { const w = s.cardWorks[`${s.currentUserId}:${cardId}`]; if (w) w.history.splice(originalIndex, 1); }); };
      badge.appendChild(rmBtn); list.appendChild(badge);
    }

    // + chip to log a session
    const addChip = document.createElement('span');
    addChip.className = 'inline-flex items-center text-xs px-2 py-0.5 rounded-full border border-dashed border-border text-dim cursor-pointer hover:text-primary hover:border-muted transition-colors';
    addChip.textContent = '+'; addChip.title = t('card.logSession.chip');
    addChip.onclick = () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const defaultVal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      let selectedRating: import('../types').SessionRating = 'good';
      const body = document.createElement('div'); body.className = 'space-y-4';
      const dtLbl = document.createElement('label'); dtLbl.className = 'label'; dtLbl.textContent = t('card.logSession.dateLabel');
      const inp = document.createElement('input'); inp.type = 'datetime-local'; inp.value = defaultVal; inp.className = 'input';
      const ratingLbl = document.createElement('div'); ratingLbl.className = 'label'; ratingLbl.textContent = t('card.logSession.qualityLabel');
      const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';
      const ratingDefs: Array<{ rating: import('../types').SessionRating; key: string; activeClass: string }> = [
        { rating: 'again', key: 'rating.again', activeClass: 'bg-danger/20 text-danger border-danger/40' },
        { rating: 'hard',  key: 'rating.hard',  activeClass: 'bg-warn/20 text-warn border-warn/40' },
        { rating: 'good',  key: 'rating.good',  activeClass: 'bg-accent/20 text-accent border-accent/40' },
        { rating: 'easy',  key: 'rating.easy',  activeClass: 'bg-success/20 text-success border-success/40' },
      ];
      const idleClass = 'btn border border-border text-muted hover:text-primary hover:bg-elevated text-xs py-1.5';
      for (const def of ratingDefs) {
        const btn = document.createElement('button');
        btn.className = def.rating === 'good' ? `btn border text-xs py-1.5 transition-colors ${def.activeClass}` : `${idleClass} transition-colors`;
        btn.textContent = t(def.key);
        btn.onclick = () => {
          selectedRating = def.rating;
          ratingRow.querySelectorAll('button').forEach(b => { b.className = `${idleClass} transition-colors`; });
          btn.className = `btn border text-xs py-1.5 transition-colors ${def.activeClass}`;
        };
        ratingRow.appendChild(btn);
      }
      body.append(dtLbl, inp, ratingLbl, ratingRow);
      showModal(t('card.logSession.title'), body, [
        { label: t('common.cancel'), onClick: closeModal },
        { label: t('common.save'), primary: true, onClick: () => {
          const ts = inp.value ? new Date(inp.value).getTime() : Date.now();
          if (isNaN(ts)) return;
          closeModal();
          ctx.mutate(s => {
            const key = `${s.currentUserId}:${cardId}`;
            if (!s.cardWorks[key]) s.cardWorks[key] = { userId: s.currentUserId, cardId, history: [] };
            s.cardWorks[key]!.history.push({ ts, rating: selectedRating });
            s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
          });
        }},
      ]);
      focusIfDesktop(inp);
    };
    list.appendChild(addChip);

    histSection.appendChild(list);
    wrap.appendChild(histSection);
  }

  return wrap;
}
