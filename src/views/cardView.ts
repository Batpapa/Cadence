import type { AppContext } from '../types';
import { pct, trashIcon, makeInlineEditable, unlinkIcon, focusIfDesktop } from '../utils';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { renderNotes } from '../components/fileViewer';
import { renderAttachmentList } from '../components/attachmentList';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, retentionWindowDays, replayFSRS } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';

export function renderCardView(ctx: AppContext, cardId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const card = state.cards[cardId];
  if (!card) { wrap.textContent = t('card.notFound'); return wrap; }

  const user = getCurrentUser(state);
  const work = state.cardWorks[`${state.currentProfileId}:${cardId}`];
  const k = cardAvailability(user, work);

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
    unlinkBtn.className = 'hidden group-hover:inline-flex items-center cursor-pointer hover:text-danger leading-none';
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

  // ── Stats: Disponibilité | Ancrage | Aisance | Importance ──
  const statsRow = document.createElement('div'); statsRow.className = 'grid grid-cols-4 gap-3';

  const fsrsState = work ? replayFSRS(work.history) : undefined;

  const mkStatBox = (label: string, value: string, valueClass = 'text-primary'): HTMLElement => {
    const box = document.createElement('div'); box.className = 'card-block space-y-1';
    const lbl = document.createElement('div'); lbl.className = 'section-title'; lbl.textContent = label;
    const val = document.createElement('div'); val.className = `text-lg font-mono font-semibold ${valueClass}`; val.textContent = value;
    box.append(lbl, val);
    return box;
  };

  // Availability (R)
  const rColor = k >= 0.75 ? 'text-success' : k >= 0.4 ? 'text-warn' : k > 0 ? 'text-danger' : 'text-dim';
  statsRow.appendChild(mkStatBox(t('card.section.availability'), k > 0 ? pct(k) : '—', rColor));

  // Stability
  const S = fsrsState?.stability;
  const stabWindow = S !== undefined ? retentionWindowDays(S, user.availabilityThreshold) : undefined;
  const formatDays = (d: number) => d >= 365 ? t('common.durationYears', { n: (d / 365).toFixed(1) }) : d >= 30 ? t('common.durationMonths', { n: Math.round(d / 30) }) : d >= 1 ? t('common.durationDays', { n: Math.round(d) }) : t('common.durationLessThanDay');
  statsRow.appendChild(mkStatBox(t('card.section.stability'), stabWindow !== undefined ? formatDays(stabWindow) : '—'));

  // Ease (inverse Difficulty)
  const D = fsrsState?.difficulty;
  const ease = D !== undefined ? (10 - D) / 9 : undefined;
  const easeColor = ease === undefined ? 'text-dim' : ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : 'text-danger';
  statsRow.appendChild(mkStatBox(t('card.section.ease'), ease !== undefined ? pct(ease) : '—', easeColor));

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
  statsRow.appendChild(impBox);

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
      rm.className = 'hidden group-hover:inline-flex items-center text-dim hover:text-danger cursor-pointer leading-none';
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

  // ── Attachments ──
  wrap.appendChild(renderAttachmentList({
    attachments: card.content.attachments, editable: true,
    onAdd:     (a) => ctx.mutate(s => { s.cards[cardId]!.content.attachments.push(a); }),
    onRemove:  (i) => ctx.mutate(s => { s.cards[cardId]!.content.attachments.splice(i, 1); }),
    onReorder: (from, insertBefore) => ctx.mutate(s => {
      const atts = s.cards[cardId]!.content.attachments;
      const [moved] = atts.splice(from, 1);
      atts.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, moved!);
    }),
  }));

  // ── Review history ──
  {
    const histSection = document.createElement('div'); histSection.className = 'space-y-2';
    const histHeader = document.createElement('div'); histHeader.className = 'flex items-center justify-between';
    const histTitle = document.createElement('span'); histTitle.className = 'section-title';
    histTitle.textContent = t('card.section.reviewHistory');
    const logBtn = document.createElement('button'); logBtn.className = 'btn-ghost text-xs'; logBtn.textContent = t('card.logSession.chip');
    histHeader.append(histTitle, logBtn);
    histSection.appendChild(histHeader);
    const list = document.createElement('div'); list.className = 'space-y-2';

    type SessionRating = import('../types').SessionRating;
    const ratingColors: Record<string, string> = { again: '#f87171', hard: '#fbbf24', good: '#8b7cf8', easy: '#4ade80' };
    const ratingLabels: Record<string, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
    const ratingDefs: Array<{ rating: SessionRating; key: string; activeClass: string }> = [
      { rating: 'again', key: 'rating.again', activeClass: 'bg-danger/20 text-danger border-danger/40' },
      { rating: 'hard',  key: 'rating.hard',  activeClass: 'bg-warn/20 text-warn border-warn/40' },
      { rating: 'good',  key: 'rating.good',  activeClass: 'bg-accent/20 text-accent border-accent/40' },
      { rating: 'easy',  key: 'rating.easy',  activeClass: 'bg-success/20 text-success border-success/40' },
    ];
    const idleClass = 'btn border border-border text-muted hover:text-primary hover:bg-elevated text-xs py-1.5';
    const pad = (n: number) => String(n).padStart(2, '0');
    const toInputVal = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

    const mkSessionForm = (defaultTs: number, defaultRating: SessionRating) => {
      let selectedRating: SessionRating = defaultRating;
      const body = document.createElement('div'); body.className = 'space-y-4';
      const dtLbl = document.createElement('label'); dtLbl.className = 'label'; dtLbl.textContent = t('card.logSession.dateLabel');
      const inp = document.createElement('input'); inp.type = 'datetime-local'; inp.value = toInputVal(defaultTs); inp.className = 'input';
      const ratingLbl = document.createElement('div'); ratingLbl.className = 'label'; ratingLbl.textContent = t('card.logSession.qualityLabel');
      const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';
      for (const def of ratingDefs) {
        const btn = document.createElement('button');
        btn.className = def.rating === defaultRating ? `btn border text-xs py-1.5 transition-colors ${def.activeClass}` : `${idleClass} transition-colors`;
        btn.textContent = t(def.key);
        btn.onclick = () => {
          selectedRating = def.rating;
          ratingRow.querySelectorAll('button').forEach(b => { b.className = `${idleClass} transition-colors`; });
          btn.className = `btn border text-xs py-1.5 transition-colors ${def.activeClass}`;
        };
        ratingRow.appendChild(btn);
      }
      body.append(dtLbl, inp, ratingLbl, ratingRow);
      return { body, inp, getRating: () => selectedRating };
    };

    const openSessionModal = (defaultTs: number, defaultRating: SessionRating, onSave: (ts: number, rating: SessionRating) => void, onDelete?: () => void) => {
      const { body, inp, getRating } = mkSessionForm(defaultTs, defaultRating);
      showModal(onDelete ? t('card.logSession.editTitle') : t('card.logSession.title'), body, [
        ...(onDelete ? [{ label: '', icon: trashIcon(), danger: true, align: 'start' as const, onClick: () => { closeModal(); onDelete(); } }] : []),
        { label: t('common.cancel'), onClick: closeModal },
        { label: t('common.save'), primary: true, onClick: () => {
          const ts = inp.value ? new Date(inp.value).getTime() : defaultTs;
          if (isNaN(ts)) return;
          closeModal(); onSave(ts, getRating());
        }},
      ]);
      focusIfDesktop(inp);
    };

    logBtn.onclick = () => openSessionModal(Date.now(), 'good', (ts, rating) => {
      ctx.mutate(s => {
        const key = `${s.currentProfileId}:${cardId}`;
        if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
        s.cardWorks[key]!.history.push({ ts, rating });
        s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
      });
    });

    const sorted = work ? [...work.history].sort((a, b) => a.ts - b.ts) : [];
    if (sorted.length > 0) {
      const grid = document.createElement('div'); grid.className = 'flex flex-wrap gap-[3px]';
      for (const entry of sorted) {
        const originalIndex = work!.history.findIndex(e => e.ts === entry.ts && e.rating === entry.rating);
        const dot = document.createElement('div');
        dot.style.cssText = `width:10px;height:10px;border-radius:2px;background:${ratingColors[entry.rating] ?? '#555'};opacity:0.75;cursor:pointer;flex-shrink:0;`;
        dot.title = `${new Date(entry.ts).toLocaleDateString()} — ${ratingLabels[entry.rating] ?? entry.rating}`;
        dot.onclick = () => openSessionModal(entry.ts, entry.rating,
          (ts, rating) => ctx.mutate(s => {
            const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
            if (h) { h.splice(originalIndex, 1, { ts, rating }); h.sort((a, b) => a.ts - b.ts); }
          }),
          () => ctx.mutate(s => { s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history.splice(originalIndex, 1); }),
        );
        grid.appendChild(dot);
      }
      list.appendChild(grid);
    }

    histSection.appendChild(list);
    wrap.appendChild(histSection);
  }

  return wrap;
}
