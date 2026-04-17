import type { AppContext } from '../types';
import { pct, timeAgo, trashIcon } from '../utils';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { renderNotes, renderFiles } from '../components/fileViewer';
import { decksContainingCard } from '../services/deckService';
import { cardKnowledge, masteryWindowDays } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';

export function renderCardView(ctx: AppContext, cardId: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const card = state.cards[cardId];
  if (!card) { wrap.textContent = 'Card not found.'; return wrap; }

  const user = getCurrentUser(state);
  const work = state.cardWorks[`${user.id}:${cardId}`];
  const k = cardKnowledge(user, work);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'flex items-start justify-between gap-4';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h1');
  title.className = 'text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors';
  title.textContent = card.name; title.title = 'Click to rename';
  title.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = card.name;
    inp.className = 'text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full';
    title.replaceWith(inp); inp.focus(); inp.select();
    const commit = () => {
      const val = inp.value.trim();
      if (val && val !== card.name) { ctx.mutate(s => { s.cards[cardId]!.name = val; }); }
      else { inp.replaceWith(title); }
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.replaceWith(title); }
    });
  };

  // Deck tags
  const deckIds = decksContainingCard(cardId, state);
  const tags = document.createElement('div'); tags.className = 'flex flex-wrap gap-1.5 mt-1.5';
  for (const dId of deckIds) {
    const deck = state.decks[dId]; if (!deck) continue;
    const tag = document.createElement('span');
    tag.className = 'text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 transition-colors';
    tag.textContent = deck.name; tag.onclick = () => ctx.navigate({ view: 'deck', deckId: dId });
    tags.appendChild(tag);
  }
  const addToDeckChip = document.createElement('span');
  addToDeckChip.className = 'text-xs px-2 py-0.5 rounded-full border border-dashed border-border text-dim cursor-pointer hover:text-primary hover:border-muted transition-colors';
  addToDeckChip.textContent = '+'; addToDeckChip.title = 'Add to deck';
  addToDeckChip.onclick = () => {
    const available = Object.values(state.decks)
      .filter(d => !d.entries.some(e => e.cardId === cardId))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (available.length === 0) {
      const p = document.createElement('p'); p.className = 'text-sm text-muted';
      p.textContent = 'This card is already in all existing decks.';
      showModal('Add to deck', p, [{ label: 'Close', onClick: closeModal }]);
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

    showModal('Add to deck', body, [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Add', primary: true, onClick: () => {
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

  const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = 'Delete card'; deleteBtn.appendChild(trashIcon());
  deleteBtn.onclick = () => confirmModal('Delete Card', `Permanently delete "${card.name}"? It will be removed from all decks.`, 'Delete', () => {
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

  // ── Knowledge, Half-life & Importance ──
  const statsRow = document.createElement('div'); statsRow.className = 'grid grid-cols-3 gap-3';

  // Knowledge
  const knBox = document.createElement('div'); knBox.className = 'card-block space-y-1';
  const knLabel = document.createElement('div'); knLabel.className = 'section-title'; knLabel.textContent = 'Knowledge';
  const knVal = document.createElement('div'); knVal.className = 'text-lg font-mono font-semibold text-primary'; knVal.textContent = pct(k);
  const knSub = document.createElement('div'); knSub.className = 'text-xs text-muted';
  knSub.textContent = work?.history.length ? `${work.history.length} session${work.history.length > 1 ? 's' : ''} · last ${timeAgo(work.history.at(-1)!.ts)}` : 'Never reviewed';
  knBox.append(knLabel, knVal, knSub);

  // Importance
  const impBox = document.createElement('div'); impBox.className = 'card-block space-y-1';
  const impLabel = document.createElement('div'); impLabel.className = 'section-title'; impLabel.textContent = 'Importance';
  const impRow = document.createElement('div'); impRow.className = 'flex items-center gap-2';
  const impVal = document.createElement('span'); impVal.className = 'text-lg font-mono font-semibold text-primary'; impVal.textContent = `×${card.importance}`;
  const impEditBtn = document.createElement('button'); impEditBtn.className = 'text-xs text-dim hover:text-accent cursor-pointer transition-colors'; impEditBtn.textContent = 'Edit';
  impEditBtn.onclick = () => {
    const b = document.createElement('div'); b.className = 'space-y-2';
    const l = document.createElement('label'); l.className = 'label'; l.textContent = 'Base importance (>0)';
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0.1'; inp.step = '0.1'; inp.value = String(card.importance); inp.className = 'input';
    b.append(l, inp);
    showModal('Importance', b, [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Save', primary: true, onClick: () => {
        const val = parseFloat(inp.value);
        if (!isNaN(val) && val > 0) { closeModal(); ctx.mutate(s => { s.cards[cardId]!.importance = val; }); }
      }},
    ]);
    setTimeout(() => inp.focus(), 30);
  };
  impRow.append(impVal, impEditBtn);
  impBox.append(impLabel, impRow);

  // Mastery window (FSRS)
  const S = work?.stability;
  const mw = S !== undefined ? masteryWindowDays(S, user.masteryThreshold) : undefined;
  const hlBox = document.createElement('div'); hlBox.className = 'card-block space-y-1';
  const hlLabel = document.createElement('div'); hlLabel.className = 'section-title'; hlLabel.textContent = 'Mastery window';
  const hlVal = document.createElement('div'); hlVal.className = 'text-lg font-mono font-semibold text-primary';
  hlVal.textContent = mw === undefined ? '—' : mw >= 1 ? `${Math.round(mw)}d` : `${Math.round(mw * 24)}h`;
  const hlSub = document.createElement('div'); hlSub.className = 'text-xs text-muted';
  hlSub.textContent = mw === undefined ? 'not yet reviewed' : 'from review until next needed';
  hlBox.append(hlLabel, hlVal, hlSub);

  statsRow.append(knBox, hlBox, impBox);
  wrap.appendChild(statsRow);

  // ── Tags ──
  const tagsSection = document.createElement('div'); tagsSection.className = 'space-y-2';
  const tagsHeader = document.createElement('div'); tagsHeader.className = 'flex items-center justify-between';
  const tagsTitle = document.createElement('span'); tagsTitle.className = 'section-title'; tagsTitle.textContent = 'Tags';
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
      label.title = 'Click to rename';
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
    // Add tag input
    const addInput = document.createElement('input');
    addInput.type = 'text'; addInput.placeholder = '+'; addInput.title = 'Add tag'; addInput.className = 'text-xs bg-transparent border-none outline-none text-dim placeholder-dim w-6 focus:w-24 transition-all';
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
  const notesTitle = document.createElement('span'); notesTitle.className = 'section-title'; notesTitle.textContent = 'Notes';
  let editingNotes = false;
  let notesDraft = card.content.notes;

  const toggleEditBtn = document.createElement('button'); toggleEditBtn.className = 'btn-ghost text-xs'; toggleEditBtn.textContent = 'Edit';
  const notesContent = document.createElement('div'); notesContent.appendChild(renderNotes(card.content.notes));

  toggleEditBtn.onclick = () => {
    editingNotes = !editingNotes;
    toggleEditBtn.textContent = editingNotes ? 'Preview' : 'Edit';
    notesContent.innerHTML = '';
    if (editingNotes) {
      const ta = document.createElement('textarea'); ta.value = notesDraft; ta.className = 'input w-full font-mono text-xs resize-none'; ta.rows = 12;
      ta.addEventListener('input', () => { notesDraft = ta.value; });
      ta.addEventListener('blur', () => { ctx.save(s => { s.cards[cardId]!.content.notes = notesDraft; }); });
      notesContent.appendChild(ta);
      setTimeout(() => ta.focus(), 30);
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

  // ── Review history ──
  {
    const histSection = document.createElement('div'); histSection.className = 'space-y-2';
    const histTitle = document.createElement('span'); histTitle.className = 'section-title';
    histTitle.textContent = work?.history.length ? `Review history (${work.history.length} session${work.history.length > 1 ? 's' : ''})` : 'Review history';
    histSection.appendChild(histTitle);
    const list = document.createElement('div'); list.className = 'flex flex-wrap gap-1.5';

    const ratingIcon: Record<string, string>  = { again: '✗', hard: '△', good: '○', easy: '✓' };
    const ratingColor: Record<string, string> = { again: 'text-danger', hard: 'text-warn', good: 'text-accent', easy: 'text-success' };
    const sorted = work ? [...work.history].sort((a, b) => b.ts - a.ts) : [];
    for (const entry of sorted) {
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
      rmBtn.onclick = () => { ctx.mutate(s => { const w = s.cardWorks[`${s.currentUserId}:${cardId}`]; if (w) w.history = w.history.filter(e => e.ts !== entry.ts); }); };
      badge.appendChild(rmBtn); list.appendChild(badge);
    }

    // + chip to log a session
    const addChip = document.createElement('span');
    addChip.className = 'inline-flex items-center text-xs px-2 py-0.5 rounded-full border border-dashed border-border text-dim cursor-pointer hover:text-primary hover:border-muted transition-colors';
    addChip.textContent = '+'; addChip.title = 'Log session';
    addChip.onclick = () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const defaultVal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      let selectedRating: import('../types').SessionRating = 'good';
      const body = document.createElement('div'); body.className = 'space-y-4';
      const dtLbl = document.createElement('label'); dtLbl.className = 'label'; dtLbl.textContent = 'Date & time';
      const inp = document.createElement('input'); inp.type = 'datetime-local'; inp.value = defaultVal; inp.className = 'input';
      const ratingLbl = document.createElement('div'); ratingLbl.className = 'label'; ratingLbl.textContent = 'Quality';
      const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';
      const ratingDefs: Array<{ rating: import('../types').SessionRating; label: string; activeClass: string }> = [
        { rating: 'again', label: '✗ Failed',    activeClass: 'bg-danger/20 text-danger border-danger/40' },
        { rating: 'hard',  label: '△ Struggled', activeClass: 'bg-warn/20 text-warn border-warn/40' },
        { rating: 'good',  label: '○ Got it',    activeClass: 'bg-accent/20 text-accent border-accent/40' },
        { rating: 'easy',  label: '✓ Nailed it', activeClass: 'bg-success/20 text-success border-success/40' },
      ];
      const idleClass = 'btn border border-border text-muted hover:text-primary hover:bg-elevated text-xs py-1.5';
      for (const def of ratingDefs) {
        const btn = document.createElement('button');
        btn.className = def.rating === 'good' ? `btn border text-xs py-1.5 transition-colors ${def.activeClass}` : `${idleClass} transition-colors`;
        btn.textContent = def.label;
        btn.onclick = () => {
          selectedRating = def.rating;
          ratingRow.querySelectorAll('button').forEach(b => { b.className = `${idleClass} transition-colors`; });
          btn.className = `btn border text-xs py-1.5 transition-colors ${def.activeClass}`;
        };
        ratingRow.appendChild(btn);
      }
      body.append(dtLbl, inp, ratingLbl, ratingRow);
      showModal('Log practice session', body, [
        { label: 'Cancel', onClick: closeModal },
        { label: 'Save', primary: true, onClick: () => {
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
      setTimeout(() => inp.focus(), 30);
    };
    list.appendChild(addChip);

    histSection.appendChild(list);
    wrap.appendChild(histSection);
  }

  return wrap;
}
