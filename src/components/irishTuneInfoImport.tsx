import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChild, RefObject } from 'preact';
import type { AppContext, Card } from '../types';
import { focusIfDesktop, sortByRelevance } from '../utils';
import { mutate, appState } from '../store';
import {
  searchTunes, fetchTuneById, fetchPlaylist, fetchTunesByIds, fetchAudioFile,
  tuneToCard, isServerWarm,
  type TuneSearchResult,
} from '../services/irishTuneInfoService';
import { findByExternalId, fetchTunesByIds as fetchTunesByIdsTheSession, tuneResultToCard } from '../services/theSessionService';
import { ensureItiMapping } from '../services/itiMappingService';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';
import { getZoom } from '../services/zoomService';
import { CheckIcon } from './icons';

// ── Tab helpers (same look as theSessionImport's — kept as a local copy
// rather than shared, matching how these two files already don't share code
// with each other). ───────────────────────────────────────────────────────

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      class={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
        active ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-elevated'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Input that looks like .input but has an inline right-side info span,
 *  wired to a floating <SuggestDropdown>. */
function InputRow({ placeholder, value, onInput, info, inputRef, title, onKeyDown, onFocus, onBlur, maxLength, disabled }: {
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  info: string;
  inputRef: RefObject<HTMLInputElement>;
  title?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <div class="flex-1 relative flex items-center bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent overflow-hidden" title={title}>
      <input
        ref={inputRef}
        type="text"
        class="flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim"
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={(e) => {
          // Pasting a newline-separated list into a single-line input drops
          // the newlines on some browsers — normalize to ';' before it hits onInput.
          const text = e.clipboardData?.getData('text');
          if (!text || !/[\r\n]/.test(text)) return;
          e.preventDefault();
          const el = e.target as HTMLInputElement;
          const cleaned = text.replace(/[\r\n]+/g, ';');
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          const next = el.value.slice(0, start) + cleaned + el.value.slice(end);
          onInput(next);
        }}
      />
      <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim bg-bg pl-2 pointer-events-none whitespace-nowrap">{info}</span>
    </div>
  );
}

/** Floating suggestion list anchored under an input — position computed at
 *  open-time (and whenever `items` changes), portaled to document.body so it
 *  isn't clipped by the modal's own overflow. Unmounts (and is removed from
 *  the DOM) along with whatever renders it — no manual cleanup needed, unlike
 *  the old vanilla version's MutationObserver-based self-teardown. */
function SuggestDropdown<T>({ anchorRef, items, renderItem, onPick, open }: {
  anchorRef: RefObject<HTMLElement>;
  items: T[];
  renderItem: (item: T) => ComponentChild;
  onPick: (item: T) => void;
  open: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !anchorRef.current || items.length === 0) { setPos(null); return; }
    const z = getZoom() / 100;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: (rect.bottom + 4) / z, left: rect.left / z, width: rect.width / z });
    // eslint-disable-next-line
  }, [open, items]);

  if (!open || !pos || items.length === 0) return null;

  return createPortal((
    <div
      class="fixed z-[100] bg-elevated border border-border rounded-lg shadow-2xl overflow-y-auto"
      style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px`, maxHeight: '220px' }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          class="flex items-center gap-3 px-3 py-2 hover:bg-bg cursor-pointer"
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
        >
          {renderItem(item)}
        </div>
      ))}
    </div>
  ), document.body);
}

const fetchingMsg  = () => isServerWarm() ? t('irishTuneInfo.status.fetching')  : t('irishTuneInfo.status.wakingServer');
const searchingMsg = () => isServerWarm() ? t('irishTuneInfo.status.searching') : t('irishTuneInfo.status.wakingServer');

/** Parses a pasted delimited ID list ("1;5;97", "1, 5, 97", "1 5 97") — returns
 *  [] unless there are at least two distinct positive integers, so a lone ID
 *  still falls through to the regular single-tune lookup. */
function parseIdList(text: string): number[] {
  if (!/^\d+(?:[;,\s]+\d+)+[;,\s]*$/.test(text)) return [];
  return [...new Set(text.split(/[;,\s]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0))];
}

/** Cards already owned, by IrishTuneInfo tune ID — shared by every batch
 *  path (playlist, pasted ID list) to skip re-fetching and still link the
 *  existing card into the target deck. */
function buildExistingByTuneId(): Map<number, string> {
  const map = new Map<number, string>();
  for (const card of Object.values(appState.value.cards)) {
    if (card.externalId?.startsWith('irishtuneinfo:')) {
      const id = parseInt(card.externalId.slice('irishtuneinfo:'.length));
      if (!isNaN(id)) map.set(id, card.id);
    }
  }
  return map;
}

type MappingCheck = { mapped: { itiId: number; sessionId: number; name: string }[]; unmapped: number[] };

/** TheSession redirect: if a mapping exists for some of the IDs about to be
 *  imported, offer to import those specific ones from TheSession instead
 *  (recommended — richer, community-curated data). Best-effort: a sync
 *  failure never blocks the underlying IrishTuneInfo import. */
async function checkMapping(itiIds: number[], setStatus: (c: ComponentChild) => void): Promise<MappingCheck> {
  try {
    // Only ticks during an actual (re)sync of the full collection (the
    // common case — mapping already up to date — resolves via a single
    // page-1 fetch with no progress callback at all).
    const mappingDb = await ensureItiMapping(p => {
      setStatus(t('irishTuneInfo.status.checkingMappingProgress', { done: p.done, total: p.total }));
    });
    const mapped: { itiId: number; sessionId: number; name: string }[] = [];
    const unmapped: number[] = [];
    for (const id of itiIds) {
      const entry = mappingDb.byItiId[id];
      if (entry) mapped.push({ itiId: id, sessionId: entry.sessionId, name: entry.name });
      else unmapped.push(id);
    }
    return { mapped, unmapped };
  } catch (e) {
    // Best-effort: never let a mapping-sync failure block the underlying
    // IrishTuneInfo import. Logged (not surfaced to the user) so a silent
    // failure is still diagnosable via devtools.
    console.warn('[itiMapping] TheSession mapping check failed, continuing without it', e);
    return { mapped: [], unmapped: itiIds };
  }
}

/** Two-choice prompt (same shape as sessionModule.tsx's "long file" warning),
 *  but dismissable (X / click outside) — closing it that way is treated as
 *  'cancel', not as picking "Keep IrishTuneInfo": callers must abort the
 *  whole import in that case, exactly as if Import had never been clicked.
 *  TheSession is the recommended choice, so its button is primary and says
 *  so explicitly rather than presenting a neutral pick. */
function promptUseTheSession(mapped: { name: string }[], totalRequested: number): Promise<'thesession' | 'iti' | 'cancel'> {
  return new Promise(resolve => {
    const p = document.createElement('p');
    p.className = 'text-sm text-muted leading-relaxed';
    p.textContent = mapped.length === 1
      ? t('irishTuneInfo.mapping.offerSingle', { name: mapped[0]!.name })
      : t('irishTuneInfo.mapping.offerPlural', { count: mapped.length, total: totalRequested });
    showModal(t('irishTuneInfo.mapping.title'), p, [
      { label: t('irishTuneInfo.mapping.keepIti'), onClick: () => { closeModal(); resolve('iti'); } },
      { label: t('irishTuneInfo.mapping.useTheSession'), primary: true, onClick: () => { closeModal(); resolve('thesession'); } },
    ], true, '28rem', () => resolve('cancel'));
  });
}

/** Fetches+builds cards EXCLUSIVELY via theSessionService (fetchTunesByIds +
 *  tuneResultToCard) — never merged with any IrishTuneInfo data already
 *  fetched for these tunes. Dedupes on `thesession:<id>`, same convention as
 *  buildExistingByTuneId. Does NOT touch the store: callers combine this
 *  with another fetch phase (the remaining IrishTuneInfo import, if any) and
 *  commit everything via commitCards() only once every phase has succeeded
 *  — a failure partway through must never leave only half the batch
 *  imported into the library. */
async function fetchViaTheSession(
  sessionIds: number[],
  onProgress: (loaded: number, total: number) => void,
): Promise<{ newCards: Card[]; linkIds: string[]; displayCards: { id: string; name: string }[] }> {
  const existingCardIdBySessionId = new Map<number, string>();
  for (const card of Object.values(appState.value.cards)) {
    if (card.externalId?.startsWith('thesession:')) {
      const id = parseInt(card.externalId.slice('thesession:'.length));
      if (!isNaN(id)) existingCardIdBySessionId.set(id, card.id);
    }
  }
  const { tunes, skippedIds } = await fetchTunesByIdsTheSession(sessionIds, onProgress, id => existingCardIdBySessionId.has(id));
  const newCards = tunes.map(tune => tuneResultToCard(tune));
  const existingIds = skippedIds.map(id => existingCardIdBySessionId.get(id)!);
  return {
    newCards,
    linkIds: [...newCards.map(c => c.id), ...existingIds],
    displayCards: [
      ...newCards.map(c => ({ id: c.id, name: c.name })),
      ...existingIds.map(id => ({ id, name: appState.value.cards[id]?.name ?? '' })),
    ],
  };
}

/** Writes a set of newly-built cards plus a set of already-known card ids
 *  into the store and links all of them to the current target deck(s), in
 *  one single mutate() call — the only place either batch path below
 *  actually commits anything, and only once every fetch phase has already
 *  succeeded. */
function commitCards(newCards: Card[], linkIds: string[], getTargetDeckIds?: () => Set<string> | undefined): Promise<void> {
  return mutate(s => {
    for (const card of newCards) { s.cards[card.id] = card; }
    for (const deckId of (getTargetDeckIds?.() ?? [])) {
      const deck = s.decks[deckId]; if (!deck) continue;
      for (const cardId of linkIds) {
        if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
      }
    }
  });
}

/** Combines the batch-import summary segments (imported / redirected to
 *  TheSession / already-in-library skipped) into one sentence — factored
 *  out since both batch paths below build this. */
function buildBatchSummary(newCount: number, skippedCount: number, redirectedCount: number): string {
  let summary = t('irishTuneInfo.status.batchDone', { count: newCount });
  const extras: string[] = [];
  if (redirectedCount > 0) extras.push(t('irishTuneInfo.status.batchRedirected', { count: redirectedCount }));
  if (skippedCount > 0) extras.push(t('irishTuneInfo.status.batchSkipped', { count: skippedCount }));
  if (extras.length > 0) summary = summary.replace('.', '') + extras.join('') + '.';
  return summary;
}

// ── Body ──────────────────────────────────────────────────────────────────────

export interface IrishTuneInfoBodyProps {
  ctx: AppContext;
  getTargetDeckIds?: () => Set<string> | undefined;
  onNavigateToCard?: () => void;
  withDeckChoice?: (onReady: () => void) => void;
}

export function IrishTuneInfoBody({ ctx, getTargetDeckIds, onNavigateToCard, withDeckChoice = onReady => onReady() }: IrishTuneInfoBodyProps) {
  const [tab, setTab] = useState<'tune' | 'playlist'>('tune');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [status, setStatus] = useState<ComponentChild>('');

  const setImportedStatus = (cardId: string, cardName: string) => {
    setStatus(
      <>
        {t('irishTuneInfo.status.imported', { name: '\x00' }).split('\x00')[0]}
        <span class="text-accent cursor-pointer hover:underline" onClick={() => { ctx.navigate({ view: 'card', cardId }); onNavigateToCard?.(); }}>
          {cardName}
        </span>
        {t('irishTuneInfo.status.imported', { name: '\x00' }).split('\x00')[1]}
      </>,
    );
  };

  // ── Shared: import a single tune ──────────────────────────────────────────
  const importTune = async (tuneId: number, onSuccess: () => void, setBusy: (b: boolean) => void) => {
    setBusy(true);
    setStatus(t('irishTuneInfo.status.checkingMapping'));
    const { mapped } = await checkMapping([tuneId], setStatus);
    if (mapped.length > 0) {
      const choice = await promptUseTheSession(mapped, 1);
      if (choice === 'cancel') {
        setStatus('');
        setBusy(false);
        return;
      }
      if (choice === 'thesession') {
        setStatus(fetchingMsg());
        try {
          const { newCards, linkIds, displayCards } = await fetchViaTheSession([mapped[0]!.sessionId], () => {});
          await commitCards(newCards, linkIds, getTargetDeckIds);
          const card = displayCards[0]!;
          setImportedStatus(card.id, card.name);
          onSuccess();
        } catch (e) {
          setStatus(t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) }));
        } finally {
          setBusy(false);
        }
        return;
      }
      // choice === 'iti': fall through to the regular IrishTuneInfo path below.
    }
    setStatus(fetchingMsg());
    try {
      const tune = await fetchTuneById(tuneId);
      const existing = findByExternalId(`irishtuneinfo:${tune.id}`, appState.value.cards);
      if (existing) {
        await mutate(s => {
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === existing.id)) deck.entries.push({ cardId: existing.id });
          }
        });
        setStatus(t('irishTuneInfo.status.alreadyInLibrary', { name: tune.name }));
        setBusy(false);
      } else {
        const audioFile = includeAudio && tune.featuredAudioUrl ? await fetchAudioFile(tune.featuredAudioUrl, `${tune.name}.mp3`) : null;
        const card = tuneToCard(tune, audioFile);
        await mutate(s => {
          s.cards[card.id] = card;
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
          }
        });
        setImportedStatus(card.id, card.name);
        onSuccess();
      }
    } catch (e) {
      setStatus(t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  /** Shared: import a list of tune IDs (e.g. pasted "1;5;97"), same shape as
   *  the playlist batch import. */
  const importIds = async (
    ids: number[],
    onProgress: (loaded: number, total: number) => void,
    onDone: () => void,
  ): Promise<void> => {
    setStatus(t('irishTuneInfo.status.checkingMapping'));
    const { mapped, unmapped } = await checkMapping(ids, setStatus);
    let useRedirect = false;
    if (mapped.length > 0) {
      const choice = await promptUseTheSession(mapped, ids.length);
      if (choice === 'cancel') {
        setStatus('');
        onDone();
        return;
      }
      useRedirect = choice === 'thesession';
    }
    const remainingIds = useRedirect ? unmapped : ids;

    // One continuous bar/status across both phases (TheSession redirect
    // fetch, then the remaining IrishTuneInfo fetch) instead of two separate
    // "X/N" progressions that each reset to 0.
    const totalToFetch = (useRedirect ? mapped.length : 0) + remainingIds.length;
    let doneSoFar = 0;
    const onCombinedProgress = (loadedInPhase: number) => onProgress(doneSoFar + loadedInPhase, totalToFetch);

    setStatus(fetchingMsg());
    try {
      // Every phase is fetched FIRST — nothing is written to the library
      // until every phase below has actually succeeded, so a failure partway
      // through (e.g. the IrishTuneInfo fetch dies right after the TheSession
      // one already finished) never leaves the library with only half the
      // batch imported.
      let sessionFetch: Awaited<ReturnType<typeof fetchViaTheSession>> | null = null;
      if (useRedirect) {
        sessionFetch = await fetchViaTheSession(mapped.map(m => m.sessionId), onCombinedProgress);
        doneSoFar = mapped.length;
      }

      let itiNewCards: Card[] = [];
      let itiSkippedIds: number[] = [];
      let existingCardIdByTuneId: Map<number, string> | null = null;
      if (remainingIds.length > 0) {
        existingCardIdByTuneId = buildExistingByTuneId();
        const { tunes, skippedIds } = await fetchTunesByIds(remainingIds, onCombinedProgress, id => existingCardIdByTuneId!.has(id), includeAudio);
        itiNewCards = tunes.map(({ tune, audioFile }) => tuneToCard(tune, audioFile));
        itiSkippedIds = skippedIds;
      }

      const allNewCards = [...(sessionFetch?.newCards ?? []), ...itiNewCards];
      const linkIds = [
        ...(sessionFetch?.linkIds ?? []),
        ...itiNewCards.map(c => c.id),
        ...itiSkippedIds.map(id => existingCardIdByTuneId!.get(id)!),
      ];
      await commitCards(allNewCards, linkIds, getTargetDeckIds);

      const redirectedCount = sessionFetch?.displayCards.length ?? 0;
      setStatus(buildBatchSummary(itiNewCards.length, itiSkippedIds.length, redirectedCount));
    } catch (e) {
      setStatus(t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      onDone();
    }
  };

  return (
    <div class="space-y-3">
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          class="card-checkbox"
          checked={includeAudio}
          onChange={(e) => setIncludeAudio((e.target as HTMLInputElement).checked)}
        />
        <span class="text-xs text-muted">{t('irishTuneInfo.includeAudio')}</span>
      </label>

      <div class="flex gap-1 p-1 bg-bg rounded-lg">
        <Tab label={t('irishTuneInfo.tabTune')} active={tab === 'tune'} onClick={() => setTab('tune')} />
        <Tab label={t('irishTuneInfo.tabPlaylist')} active={tab === 'playlist'} onClick={() => setTab('playlist')} />
      </div>

      <div class="space-y-3">
        {tab === 'tune' ? (
          <TuneTab
            withDeckChoice={withDeckChoice}
            setStatus={setStatus}
            importTune={importTune}
            importIds={importIds}
          />
        ) : (
          <PlaylistTab
            includeAudio={includeAudio}
            getTargetDeckIds={getTargetDeckIds}
            withDeckChoice={withDeckChoice}
            setStatus={setStatus}
          />
        )}
      </div>

      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </div>
  );
}

// ── Tab: Tune (ID, name search, or a pasted "1;5;97" ID list) ─────────────────

function TuneTab({ withDeckChoice, setStatus, importTune, importIds }: {
  withDeckChoice: (onReady: () => void) => void;
  setStatus: (c: ComponentChild) => void;
  importTune: (tuneId: number, onSuccess: () => void, setBusy: (b: boolean) => void) => Promise<void>;
  importIds: (ids: number[], onProgress: (loaded: number, total: number) => void, onDone: () => void) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [info, setInfo] = useState('');
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [pendingIds, setPendingIds] = useState<number[] | null>(null);
  // `busy` gates only the Import button (matches importTune's own
  // busy-signal — stays disabled after a successful single-tune import,
  // same as the original, until a new query produces a fresh result).
  // `batchBusy` additionally disables the INPUT — only during a pendingIds
  // batch fetch, matching the original's `inp.disabled` which was never
  // touched by the single-tune path.
  const [busy, setBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<TuneSearchResult[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null); // null = hidden

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // Resets `busy` too — typing invalidates whatever the last import's outcome
  // was, and this is called at the top of every keystroke, so a stale "busy"
  // from a just-finished single-tune import (never explicitly cleared on its
  // success path, same as the original) never permanently blocks the button
  // once a fresh valid query comes in.
  const clearResult = () => { setPendingId(null); setPendingIds(null); setInfo(''); setBusy(false); };

  const doImport = () => {
    if (pendingIds) {
      const ids = pendingIds;
      withDeckChoice(() => {
        setBusy(true);
        setBatchBusy(true);
        setProgress(0);
        void importIds(ids, (loaded, total) => { setProgress(Math.round((loaded / total) * 100)); setStatus(t('irishTuneInfo.status.fetchingTunes', { loaded, total })); }, () => {
          setBusy(false); setBatchBusy(false); setProgress(null); setValue(''); clearResult();
        });
      });
      return;
    }
    if (pendingId === null) return;
    withDeckChoice(() => { void importTune(pendingId, () => { setValue(''); clearResult(); }, setBusy); });
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setValue(val);
    clearResult(); setStatus(''); setSuggestions([]); setDropdownOpen(false);
    const trimmed = val.trim();
    if (!trimmed) return;
    const ids = parseIdList(trimmed);
    if (ids.length > 0) {
      setPendingIds(ids); setPendingId(null);
      setInfo(ids.length === 1 ? t('irishTuneInfo.ids.preview', { count: ids.length }) : t('irishTuneInfo.ids.previewPlural', { count: ids.length }));
      return;
    }
    if (/^\d+$/.test(trimmed)) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(fetchingMsg());
        try {
          const tune = await fetchTuneById(parseInt(trimmed));
          setPendingId(tune.id); setPendingIds(null);
          setInfo(`${tune.name} · ${tune.rhythm}`);
          setStatus('');
        } catch { setStatus(t('irishTuneInfo.id.notFound')); }
      }, 150);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(searchingMsg());
        try {
          const tunes = await searchTunes(trimmed);
          const sorted = sortByRelevance(tunes, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('irishTuneInfo.noResults'));
        } catch (e) { setStatus(t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) })); }
      }, 300);
    }
  };

  const pick = (tune: TuneSearchResult) => {
    setValue(tune.name);
    setDropdownOpen(false);
    setPendingId(tune.id); setPendingIds(null);
    setInfo(`${tune.name} · ${tune.rhythm}`);
    setStatus('');
  };

  const knownIds = () => new Set(
    Object.values(appState.value.cards)
      .map(c => c.externalId)
      .filter((id): id is string => !!id && id.startsWith('irishtuneinfo:'))
      .map(id => parseInt(id.slice('irishtuneinfo:'.length), 10)),
  );

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('irishTuneInfo.tune.placeholder')}
          title={t('irishTuneInfo.ids.hint')}
          value={value}
          info={info}
          disabled={batchBusy}
          onInput={onInputChange}
          onFocus={() => { if (suggestions.length) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDropdownOpen(false);
            if (e.key === 'Enter' && (pendingId !== null || pendingIds !== null)) doImport();
          }}
        />
        <button class="btn-primary text-xs shrink-0" disabled={busy || (pendingId === null && pendingIds === null)} onClick={doImport}>
          {t('irishTuneInfo.id.import')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <SuggestDropdown
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={pick}
        renderItem={(tune) => (
          <>
            <div class="flex-1 min-w-0">
              <span class="text-sm text-primary truncate block">{tune.name}</span>
              <span class="text-xs text-dim">{tune.rhythm}</span>
            </div>
            {knownIds().has(tune.id) && (
              <span class="text-success shrink-0" title={t('common.alreadyInLibrary')}><CheckIcon size={12} /></span>
            )}
          </>
        )}
      />
    </>
  );
}

// ── Tab: Playlist (username → import all) ─────────────────────────────────────

function PlaylistTab({ includeAudio, getTargetDeckIds, withDeckChoice, setStatus }: {
  includeAudio: boolean;
  getTargetDeckIds?: () => Set<string> | undefined;
  withDeckChoice: (onReady: () => void) => void;
  setStatus: (c: ComponentChild) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // Populated by showPreview, which already has every tune's ID for free
  // (fetchPlaylist returns {id,name} per tune) — checked against the
  // TheSession mapping right there so doImportAll never needs a second
  // username→ids round trip just to know what it's about to fetch.
  const pendingUsernameRef = useRef<string | null>(null);
  const pendingMappedRef = useRef<{ itiId: number; sessionId: number; name: string }[]>([]);
  const pendingUnmappedIdsRef = useRef<number[]>([]);
  const pendingCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);

  const showPreview = async (username: string) => {
    pendingUsernameRef.current = null; pendingMappedRef.current = []; pendingUnmappedIdsRef.current = []; pendingCountRef.current = 0;
    bump(x => x + 1);
    setInfo('');
    setStatus(fetchingMsg());
    try {
      const playlist = await fetchPlaylist(username);
      const n = playlist.tunes.length;
      setInfo(n === 1 ? t('irishTuneInfo.playlist.preview', { count: n }) : t('irishTuneInfo.playlist.previewPlural', { count: n }));
      // Checked here (not just shown) so doImportAll never needs a second
      // username→ids round trip — the TheSession-redirect prompt itself
      // only appears once the user actually clicks Import, not here.
      const { mapped, unmapped } = await checkMapping(playlist.tunes.map(pt => pt.id), setStatus);
      pendingMappedRef.current = mapped; pendingUnmappedIdsRef.current = unmapped;
      pendingCountRef.current = n;
      pendingUsernameRef.current = username; // gates only "found the user" — the button itself also checks pendingCountRef (empty playlist stays disabled)
      bump(x => x + 1);
      setStatus('');
    } catch {
      setStatus(<>{t('irishTuneInfo.playlist.notFound')}<br /><span class="text-warn">{t('irishTuneInfo.playlist.makePublicHint')}</span></>);
    }
  };

  const doImportAll = async () => {
    if (pendingUsernameRef.current === null) return;
    setBusy(true);
    setProgress(0);

    let useRedirect = false;
    const pendingMapped = pendingMappedRef.current;
    const pendingUnmappedIds = pendingUnmappedIdsRef.current;
    if (pendingMapped.length > 0) {
      const choice = await promptUseTheSession(pendingMapped, pendingMapped.length + pendingUnmappedIds.length);
      if (choice === 'cancel') {
        setStatus('');
        setProgress(null);
        setBusy(false);
        return;
      }
      useRedirect = choice === 'thesession';
    }
    const ids = useRedirect ? pendingUnmappedIds : [...pendingMapped.map(m => m.itiId), ...pendingUnmappedIds];

    // One continuous bar/status across both phases (TheSession redirect
    // fetch, then the remaining IrishTuneInfo fetch) instead of two
    // separate "X/N" progressions that each reset to 0.
    const totalToFetch = (useRedirect ? pendingMapped.length : 0) + ids.length;
    let doneSoFar = 0;
    const onCombinedProgress = (loadedInPhase: number) => {
      const done = doneSoFar + loadedInPhase;
      setProgress(Math.round((done / totalToFetch) * 100));
      setStatus(t('irishTuneInfo.status.fetchingTunes', { loaded: done, total: totalToFetch }));
    };

    setStatus(fetchingMsg());
    try {
      // Every phase is fetched FIRST — nothing is written to the library
      // until every phase below has actually succeeded, so a failure
      // partway through (e.g. the IrishTuneInfo fetch dies right after the
      // TheSession one already finished) never leaves the library with
      // only half the batch imported.
      let sessionFetch: Awaited<ReturnType<typeof fetchViaTheSession>> | null = null;
      if (useRedirect) {
        sessionFetch = await fetchViaTheSession(pendingMapped.map(m => m.sessionId), onCombinedProgress);
        doneSoFar = pendingMapped.length;
      }

      let itiNewCards: Card[] = [];
      let itiSkippedIds: number[] = [];
      let existingCardIdByTuneId: Map<number, string> | null = null;
      if (ids.length > 0) {
        existingCardIdByTuneId = buildExistingByTuneId();
        const { tunes, skippedIds } = await fetchTunesByIds(ids, onCombinedProgress, id => existingCardIdByTuneId!.has(id), includeAudio);
        itiNewCards = tunes.map(({ tune, audioFile }) => tuneToCard(tune, audioFile));
        itiSkippedIds = skippedIds;
      }

      const allNewCards = [...(sessionFetch?.newCards ?? []), ...itiNewCards];
      const linkIds = [
        ...(sessionFetch?.linkIds ?? []),
        ...itiNewCards.map(c => c.id),
        ...itiSkippedIds.map(id => existingCardIdByTuneId!.get(id)!),
      ];
      await commitCards(allNewCards, linkIds, getTargetDeckIds);

      setProgress(100);
      const redirectedCount = sessionFetch?.displayCards.length ?? 0;
      setStatus(buildBatchSummary(itiNewCards.length, itiSkippedIds.length, redirectedCount));
    } catch (e) {
      setStatus(t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setValue(val);
    setInfo(''); pendingUsernameRef.current = null; bump(x => x + 1); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    timerRef.current = setTimeout(() => { timerRef.current = null; void showPreview(trimmed); }, 400);
  };

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('irishTuneInfo.playlist.placeholder')}
          value={value}
          info={info}
          disabled={busy}
          onInput={onInputChange}
          onKeyDown={(e) => { if (e.key === 'Enter' && pendingUsernameRef.current !== null) void doImportAll(); }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || pendingUsernameRef.current === null || pendingCountRef.current === 0}
          onClick={() => withDeckChoice(() => { void doImportAll(); })}
        >
          {t('irishTuneInfo.playlist.importAll')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}
    </>
  );
}
