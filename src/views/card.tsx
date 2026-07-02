import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate } from '../store';
import { pct, focusIfDesktop } from '../utils';
import { TrashIcon, iconElement } from '../components/icons';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { renderNotes } from '../components/fileViewer';
import { renderAttachmentList } from '../components/attachmentList';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, retentionWindowDays, replayFSRS } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { CustomSelect } from '../components/customSelect';
import type { SessionRating } from '../types';

// ── Local bridges ─────────────────────────────────────────────────────────────

function VanillaEl({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(el); });
  return <div ref={ref} />;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function CardMetric({ label, value, colorClass = 'text-primary' }: {
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
  if (d >= 365) return t('common.durationYears',  { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths', { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',   { n: Math.round(d) });
  return t('common.durationLessThanDay');
}

const RATING_COLORS: Record<string, string> = { again: 'var(--color-danger)', hard: 'var(--color-warn)', good: 'var(--color-accent)', easy: 'var(--color-success)' };
const RATING_LABELS: Record<string, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
const RATING_DEFS: Array<{ rating: SessionRating; key: string; activeClass: string }> = [
  { rating: 'again', key: 'rating.again', activeClass: 'bg-danger/20 text-danger border-danger/40' },
  { rating: 'hard',  key: 'rating.hard',  activeClass: 'bg-warn/20 text-warn border-warn/40' },
  { rating: 'good',  key: 'rating.good',  activeClass: 'bg-accent/20 text-accent border-accent/40' },
  { rating: 'easy',  key: 'rating.easy',  activeClass: 'bg-success/20 text-success border-success/40' },
];
const IDLE_BTN = 'btn border border-border text-muted hover:text-primary hover:bg-elevated text-xs py-1.5';
const pad = (n: number) => String(n).padStart(2, '0');
const toInputVal = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function mkSessionForm(defaultTs: number, defaultRating: SessionRating) {
  let selected: SessionRating = defaultRating;
  const body      = document.createElement('div'); body.className = 'space-y-4';
  const dtLbl     = document.createElement('label'); dtLbl.className = 'label'; dtLbl.textContent = t('card.logSession.dateLabel');
  const inp       = document.createElement('input'); inp.type = 'datetime-local'; inp.value = toInputVal(defaultTs); inp.className = 'input';
  const ratingLbl = document.createElement('div'); ratingLbl.className = 'label'; ratingLbl.textContent = t('card.logSession.qualityLabel');
  const ratingRow = document.createElement('div'); ratingRow.className = 'grid grid-cols-4 gap-2';
  for (const def of RATING_DEFS) {
    const btn = document.createElement('button');
    btn.className = def.rating === defaultRating
      ? `btn border text-xs py-1.5 transition-colors ${def.activeClass}`
      : `${IDLE_BTN} transition-colors`;
    btn.textContent = t(def.key);
    btn.onclick = () => {
      selected = def.rating;
      ratingRow.querySelectorAll('button').forEach(b => { (b as HTMLElement).className = `${IDLE_BTN} transition-colors`; });
      btn.className = `btn border text-xs py-1.5 transition-colors ${def.activeClass}`;
    };
    ratingRow.appendChild(btn);
  }
  body.append(dtLbl, inp, ratingLbl, ratingRow);
  return { body, inp, getRating: () => selected };
}

function openSessionModal(
  defaultTs: number,
  defaultRating: SessionRating,
  onSave: (ts: number, rating: SessionRating) => void,
  onDelete?: () => void,
) {
  const { body, inp, getRating } = mkSessionForm(defaultTs, defaultRating);
  showModal(onDelete ? t('card.logSession.editTitle') : t('card.logSession.title'), body, [
    ...(onDelete ? [{ label: '', icon: iconElement(TrashIcon), danger: true, align: 'start' as const, onClick: () => { closeModal(); onDelete(); } }] : []),
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.save'), primary: true, onClick: () => {
      const ts = inp.value ? new Date(inp.value).getTime() : defaultTs;
      if (isNaN(ts)) return;
      closeModal(); onSave(ts, getRating());
    }},
  ]);
  focusIfDesktop(inp);
}

function showManageDecksModal(cardId: string) {
  const user     = appState.value;
  const allDecks = Object.values(user.decks).sort((a, b) => a.name.localeCompare(b.name));
  if (allDecks.length === 0) {
    const p = document.createElement('p'); p.className = 'text-sm text-muted'; p.textContent = t('card.allDecks');
    showModal(t('card.manageDecks.title'), p, [{ label: t('common.close'), onClick: closeModal }]);
    return;
  }
  const checks = new Map<string, HTMLInputElement>();
  const body = document.createElement('div'); body.className = 'space-y-1 max-h-64 overflow-y-auto';
  for (const deck of allDecks) {
    const isLinked = deck.entries.some(e => e.cardId === cardId);
    const row  = document.createElement('label'); row.className = 'flex items-center gap-3 px-2 py-2 rounded cursor-pointer hover:bg-elevated transition-colors';
    const chk  = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'card-checkbox'; chk.checked = isLinked;
    const name = document.createElement('span'); name.className = 'text-sm text-primary'; name.textContent = deck.name;
    checks.set(deck.id, chk);
    row.append(chk, name);
    body.appendChild(row);
  }
  showModal(t('card.manageDecks.title'), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.save'), primary: true, onClick: () => {
      closeModal();
      mutate(s => {
        for (const [deckId, chk] of checks) {
          const deck = s.decks[deckId]; if (!deck) continue;
          const linked = deck.entries.some(e => e.cardId === cardId);
          if (chk.checked && !linked)  deck.entries.push({ cardId });
          if (!chk.checked && linked)  deck.entries = deck.entries.filter(e => e.cardId !== cardId);
        }
      });
    }},
  ]);
}

// ── Main component ────────────────────────────────────────────────────────────

export function CardView({ cardId, contextDeckId }: { cardId: string; contextDeckId?: string }) {
  const user  = appState.value;
  const card  = user.cards[cardId];
  const work  = user.cardWorks[`${user.currentProfileId}:${cardId}`];

  // All hooks before conditional returns
  const [isEditingName,  setIsEditingName]  = useState(false);
  const [editName,       setEditName]       = useState('');
  const [editingTag,     setEditingTag]     = useState<string | null>(null);
  const [tagEditValue,   setTagEditValue]   = useState('');
  const [newTag,         setNewTag]         = useState('');
  const [isEditingImportance, setIsEditingImportance] = useState(false);
  const [importanceDraft,     setImportanceDraft]     = useState('');
  const [importanceCtx,       setImportanceCtx]       = useState(contextDeckId ?? ''); // '' = Défaut
  const importanceRef = useRef<HTMLInputElement>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesDraft,     setNotesDraft]     = useState(card?.content.notes ?? '');
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditingNotes && notesRef.current) focusIfDesktop(notesRef.current);
  }, [isEditingNotes]);

  useLayoutEffect(() => {
    if (isEditingImportance && importanceRef.current) {
      importanceRef.current.focus();
      importanceRef.current.select();
    }
  }, [isEditingImportance]);

  if (!card) return <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">{t('card.notFound')}</div>;

  // ── Derived values ────────────────────────────────────────────────────────────
  const k          = cardAvailability(user, work);
  const fsrsState  = work ? replayFSRS(work.history) : undefined;
  const stabWindow = fsrsState?.stability !== undefined ? retentionWindowDays(fsrsState.stability, user.availabilityThreshold) : undefined;
  const ease       = fsrsState?.difficulty !== undefined ? (10 - fsrsState.difficulty) / 9 : undefined;
  const deckIds    = decksContainingCard(cardId, user);
  const sorted     = work ? [...work.history].sort((a, b) => a.ts - b.ts) : [];

  const rColor    = k >= 0.75 ? 'text-success' : k >= 0.4 ? 'text-warn' : k > 0 ? 'text-danger' : 'text-dim';
  const easeColor = ease === undefined ? 'text-dim' : ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : 'text-danger';

  return (
    <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">

      {/* ── Header ── */}
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
                if (val && val !== card.name) mutate(s => { s.cards[cardId]!.name = val; });
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
              onClick={() => { setEditName(card.name); setIsEditingName(true); }}
            >
              {card.name}
            </h1>
          )}

          {/* Deck chips */}
          <div class="flex flex-wrap gap-1.5 mt-1.5">
            {deckIds.map(dId => {
              const deck = user.decks[dId]; if (!deck) return null;
              return (
                <span
                  key={dId}
                  class="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer"
                  title={deckPath(dId, user)}
                  onClick={() => navigate({ view: 'deck', deckId: dId })}
                >
                  {deck.name}
                </span>
              );
            })}
            <span
              class="inline-flex items-center gap-1 text-xs text-dim hover:text-primary transition-colors cursor-pointer"
              title={t('card.manageDecks')}
              onClick={() => showManageDecksModal(cardId)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </span>
          </div>
        </div>

        <button
          class="btn-danger px-2 shrink-0"
          title={t('card.deleteTitle')}
          onClick={() => confirmModal(
            t('card.delete.title'),
            t('card.delete.message', { name: card.name }),
            t('common.delete'),
            () => {
              void mutate(s => {
                delete s.cards[cardId];
                for (const deck of Object.values(s.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
                delete s.cardWorks[`${s.currentProfileId}:${cardId}`];
              });
              navigate({ view: 'folder', folderId: null });
            },
          )}
        >
          <TrashIcon />
        </button>
      </div>

      {/* ── Stats ── */}
      <div class="stats-container border-y border-border">
      <div class="stats-grid py-3 px-4 gap-x-4 gap-y-3 justify-items-center">
        <CardMetric
          label={t('card.section.availability')}
          value={k > 0 ? pct(k) : '—'}
          colorClass={rColor}
        />
        <CardMetric
          label={t('card.section.stability')}
          value={stabWindow !== undefined ? formatDays(stabWindow) : '—'}
        />
        <CardMetric
          label={t('card.section.ease')}
          value={ease !== undefined ? pct(ease) : '—'}
          colorClass={easeColor}
        />
        <div class="flex items-baseline gap-1.5">
          <span class="text-[10px] font-medium uppercase tracking-wider text-dim shrink-0">{t('card.section.importance')}</span>
          {deckIds.length > 0 && (
            <CustomSelect
              value={importanceCtx}
              options={[
                { value: '', label: t('card.context.default') },
                ...deckIds.map(dId => ({ value: dId, label: user.decks[dId]?.name ?? dId })),
              ]}
              onChange={setImportanceCtx}
              triggerClass="text-[10px] bg-surface border border-border/50 rounded px-1.5 py-0.5 text-dim cursor-pointer hover:border-accent/50 max-w-[7rem] flex items-center gap-1"
            />
          )}
          {isEditingImportance ? (
            <input
              ref={importanceRef}
              type="number" min={importanceCtx === '' ? '0.1' : '0'} step="0.1"
              value={importanceDraft}
              class="text-sm font-mono font-semibold bg-transparent border-b border-accent outline-none text-primary w-16 p-0 leading-none"
              onInput={(e) => setImportanceDraft((e.target as HTMLInputElement).value)}
              onBlur={() => {
                const raw = importanceDraft.trim();
                if (importanceCtx === '') {
                  const val = parseFloat(raw);
                  if (!isNaN(val) && val > 0) mutate(s => { s.cards[cardId]!.defaultImportance = val; });
                } else {
                  mutate(s => {
                    const deck = s.decks[importanceCtx];
                    if (!deck) return;
                    const entry = deck.entries.find(e => e.cardId === cardId);
                    if (!entry) return;
                    if (raw === '') {
                      delete entry.importance;
                    } else {
                      const val = parseFloat(raw);
                      if (!isNaN(val) && val >= 0) entry.importance = val;
                    }
                  });
                }
                setIsEditingImportance(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setIsEditingImportance(false);
              }}
            />
          ) : (
            <span
              class={`text-sm font-mono font-semibold cursor-text hover:text-accent transition-colors ${
                importanceCtx !== '' &&
                user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)?.importance === undefined
                  ? 'text-dim' : 'text-primary'
              }`}
              onClick={() => {
                const ctxEntry = importanceCtx !== ''
                  ? user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)
                  : undefined;
                setImportanceDraft(
                  importanceCtx === ''
                    ? String(card.defaultImportance)
                    : ctxEntry?.importance !== undefined ? String(ctxEntry.importance) : '',
                );
                setIsEditingImportance(true);
              }}
              title={importanceCtx === '' ? t('card.importance.label') : t('card.importance.labelDeck')}
            >
              ×{importanceCtx === ''
                ? card.defaultImportance
                : (user.decks[importanceCtx]?.entries.find(e => e.cardId === cardId)?.importance
                    ?? card.defaultImportance)}
            </span>
          )}
        </div>
      </div>
      </div>

      {/* ── Tags ── */}
      <div class="space-y-2">
        <span class="section-title">{t('card.section.tags')}</span>
        <div class="flex flex-wrap items-center gap-1.5">
          {(card.tags ?? []).map(tag => (
            <span key={tag} class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-elevated border border-border text-muted group">
              {editingTag === tag ? (
                <input
                  type="text"
                  value={tagEditValue}
                  autoFocus
                  class="text-xs bg-transparent border-none outline-none text-primary w-16"
                  onInput={(e) => setTagEditValue((e.target as HTMLInputElement).value)}
                  onBlur={() => {
                    const val = tagEditValue.trim().replace(/,/g, '');
                    if (val && val !== tag && !(card.tags ?? []).includes(val))
                      mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.map(tg => tg === tag ? val : tg); });
                    setEditingTag(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingTag(null);
                  }}
                />
              ) : (
                <span
                  class="cursor-text hover:text-primary transition-colors"
                  title={t('card.renameTag')}
                  onClick={() => { setEditingTag(tag); setTagEditValue(tag); }}
                >
                  {tag}
                </span>
              )}
              <button
                class="hidden group-hover:inline-flex items-center text-dim hover:text-danger cursor-pointer leading-none"
                onClick={() => mutate(s => { const c = s.cards[cardId]; if (c) c.tags = c.tags.filter(tg => tg !== tag); })}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder="+"
            value={newTag}
            class="text-xs bg-transparent border-none outline-none text-dim placeholder-dim w-6 focus:w-24 transition-all"
            onInput={(e) => setNewTag((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = newTag.trim().replace(/,/g, '');
                if (val && !(card.tags ?? []).includes(val))
                  mutate(s => { const c = s.cards[cardId]; if (c) { if (!c.tags) c.tags = []; c.tags.push(val); } });
                setNewTag('');
              }
              if (e.key === 'Escape') setNewTag('');
            }}
          />
        </div>
      </div>

      {/* ── Notes ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('card.section.notes')}</span>
          <button class="btn-ghost text-xs" onClick={() => {
            if (isEditingNotes) void mutate(s => { s.cards[cardId]!.content.notes = notesDraft; });
            setIsEditingNotes(v => !v);
          }}>
            {isEditingNotes ? t('card.preview') : t('card.edit')}
          </button>
        </div>
        {isEditingNotes ? (
          <textarea
            ref={notesRef}
            value={notesDraft}
            class="input w-full font-mono text-xs resize-none"
            rows={12}
            onInput={(e) => setNotesDraft((e.target as HTMLTextAreaElement).value)}
            onBlur={(e) => {
              const val = (e.target as HTMLTextAreaElement).value;
              setNotesDraft(val);
              void mutate(s => { s.cards[cardId]!.content.notes = val; });
            }}
          />
        ) : (
          <VanillaEl el={renderNotes(notesDraft)} />
        )}
      </div>

      {/* ── Attachments ── */}
      <VanillaEl el={renderAttachmentList({
        attachments: card.content.attachments,
        editable: true,
        onAdd:     (a) => mutate(s => { s.cards[cardId]!.content.attachments.push(a); }),
        onRemove:  (i) => mutate(s => { s.cards[cardId]!.content.attachments.splice(i, 1); }),
        onReorder: (from, insertBefore) => mutate(s => {
          const atts = s.cards[cardId]!.content.attachments;
          const [moved] = atts.splice(from, 1);
          atts.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, moved!);
        }),
      })} />

      {/* ── Review history ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('card.section.reviewHistory')}</span>
          <button class="btn-ghost text-xs" onClick={() =>
            openSessionModal(Date.now(), 'good', (ts, rating) => mutate(s => {
              const key = `${s.currentProfileId}:${cardId}`;
              if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
              s.cardWorks[key]!.history.push({ ts, rating });
              s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
            }))
          }>
            {t('card.logSession.chip')}
          </button>
        </div>
        {sorted.length > 0 && (
          <div class="flex flex-wrap gap-[3px]">
            {sorted.map((entry, i) => {
              const originalIndex = work!.history.findIndex(e => e.ts === entry.ts && e.rating === entry.rating);
              return (
                <div
                  key={i}
                  style={{ width: '10px', height: '10px', borderRadius: '2px', background: RATING_COLORS[entry.rating] ?? 'var(--color-dim)', opacity: 0.75, cursor: 'pointer', flexShrink: 0 }}
                  title={`${new Date(entry.ts).toLocaleDateString()} — ${RATING_LABELS[entry.rating] ?? entry.rating}`}
                  onClick={() => openSessionModal(entry.ts, entry.rating,
                    (ts, rating) => mutate(s => {
                      const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
                      if (h) { h.splice(originalIndex, 1, { ts, rating }); h.sort((a, b) => a.ts - b.ts); }
                    }),
                    () => mutate(s => { s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history.splice(originalIndex, 1); }),
                  )}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
