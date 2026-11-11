import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import type { ComponentChild } from 'preact';
import type { AppContext, Card } from '../types';
import { generateId, focusIfDesktop, sortByRelevance, ownFormatAccept } from '../utils';
import { parseCardPackage } from '../services/importExport';
import { externaliseIncoming, uploadAttachmentSoon, mutateWithRule } from '../services/attachmentStore';
import { downloadShare } from '../services/shareService';
import { mutate, appState } from '../store';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo, searchMembers, fetchTunesByIds,
  tuneResultToCard, findByExternalId, fetchMemberSets, buildSetCards, setExternalId, MemberUnavailableError,
  fetchMemberBookmarks, fetchMemberBookmarkCount, buildTuneCardWithSetting,
  type MemberSearchResult,
} from '../services/theSessionService';
import { defaultTuneRepeat } from '../services/abcService';
import { describeTune, tuneFetchStatus, TuneUnavailableError, type SkippedTune } from '../services/tuneFetchError';
import { ensureTuneSearchIndex, searchLocalTuneIndex } from '../services/tuneNameIndexService';
import { t } from '../services/i18nService';
import { theSessionOffered, irishTuneInfoOffered } from '../services/extensions';
import { modalMaxH, modalMaxW } from '../services/zoomService';
import { IrishTuneInfoBody } from './irishTuneInfoImport';
import { InputRow, SuggestDropdown, errorLine, successLine } from './importAtoms';
import { showDeckChoiceModal } from './deckSelector';
import { CheckIcon, ArrowLeftIcon, ArrowRightIcon, CrossIcon, ImportTrayIcon, SearchIcon, GlobeIcon, FileIcon, ShareIcon } from './icons';
import { ChoiceCard, InlineStatus, Segmented } from './ui';
import { registerOverlay } from './overlayStack';
import { usePinnedTop, MODAL_BACKDROP, MODAL_TITLE_CLASS, MODAL_W } from './modal';

// ── Shared: import a batch of cards from a .cdc package (file or share key) ────
// Dedupes on externalId when present (two independent shares of the same
// TheSession tune land on two different card ids) so the same tune isn't
// re-created — the already-owned card is linked into the target deck instead.

async function importCardPackage(cards: Card[], deckIds: Iterable<string>): Promise<string> {
  let imported = 0;
  // Before the mutate, because its callback is synchronous and the rule is
  // not: a package's files arrive inline whatever their size, and one that
  // belongs outside the blob has to be put there on the way in — the same
  // constructor the file picker and the analyser's clips go through.
  const moved = await externaliseIncoming(cards, appState.value);
  await mutate(s => {
    for (const card of cards) {
      const existing = card.externalId ? findByExternalId(card.externalId, s.cards) : s.cards[card.id];
      if (!existing) { s.cards[card.id] = card; imported++; }
      const targetId = existing?.id ?? card.id;
      for (const deckId of deckIds) {
        const deck = s.decks[deckId]; if (!deck) continue;
        if (!deck.entries.some(e => e.cardId === targetId)) deck.entries.push({ cardId: targetId });
      }
    }
  });
  for (const att of moved) uploadAttachmentSoon(att);
  const skipped = cards.length - imported;
  let summary = t('theSession.status.batchDone', { count: imported });
  if (skipped > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skipped }) + '.';
  return summary;
}

/** A failed member lookup, told apart: removed, never existed, or the network.
 *  Collapsing the three would send the user looking for the wrong problem. */
function memberErrorStatus(e: unknown): string {
  if (e instanceof MemberUnavailableError) {
    return t(e.reason === 'gone' ? 'theSession.member.gone' : 'theSession.member.notFound');
  }
  return t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
}

/** "✓ 3 imported, 2 already in library skipped, 1 removed from TheSession: …"
 *  — every extra clause is appended to the base sentence so the full stop
 *  lands once, at the end (same shape as irishTuneInfoImport's
 *  buildBatchSummary). */
function batchSummary(imported: number, skipped: number, blocked: SkippedTune[]): string {
  const base = t('theSession.status.batchDone', { count: imported });
  const extras: string[] = [];
  if (skipped > 0) extras.push(t('theSession.status.batchSkipped', { count: skipped }));
  if (blocked.length > 0) {
    extras.push(t(blocked.length === 1 ? 'theSession.status.batchBlocked' : 'theSession.status.batchBlockedPlural',
      { count: blocked.length, tunes: blocked.map(describeTune).join(', ') }));
  }
  return extras.length > 0 ? base.replace('.', '') + extras.join('') + '.' : base;
}

/** Cards already owned, by TheSession tune ID — shared by every batch path
 *  (member tunebook, pasted ID list) to skip re-fetching and still link the
 *  existing card into the target deck. */
function buildExistingByTuneId(): Map<number, string> {
  const map = new Map<number, string>();
  for (const card of Object.values(appState.value.cards)) {
    if (card.externalId?.startsWith('thesession:')) {
      const id = parseInt(card.externalId.slice('thesession:'.length));
      if (!isNaN(id)) map.set(id, card.id);
    }
  }
  return map;
}

/** Parses a pasted delimited ID list ("1;5;97", "1, 5, 97", "1 5 97") — returns
 *  [] unless there are at least two distinct positive integers, so a lone ID
 *  still falls through to the regular single-tune lookup. */
function parseIdList(text: string): number[] {
  if (!/^\d+(?:[;,\s]+\d+)+[;,\s]*$/.test(text)) return [];
  return [...new Set(text.split(/[;,\s]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0))];
}

/** Only the newest lookup gets to write. Every tab here previews what the user
 *  is typing, and typing an ID means several previews are in flight at once —
 *  each keystroke of "12" starts one. Without this, the LAST ANSWER TO ARRIVE
 *  wins rather than the last one asked for, and the two are not the same order:
 *  member 1 (the site's founder, eleven aggregate counts) answers in ~310 ms
 *  where an ordinary member or a 410 answers in ~130 ms. So "12" showed member
 *  1 — and, far worse than a wrong caption, ARMED THE IMPORT on him: the field
 *  read 12, the button would have fetched Jeremy's 526 tunes.
 *
 *  `cancel()` on every edit is half the point: it also stops an answer landing
 *  on a field the user has since cleared or changed. Debouncing merely reduces
 *  the number of racers; only this decides which one counts. */
function useLatestOnly() {
  const seq = useRef(0);
  return {
    /** Claims the slot; the returned test says whether it is still ours. */
    begin: () => { const mine = ++seq.current; return () => mine === seq.current; },
    /** Abandons whatever is in flight — its answer will not be written. */
    cancel: () => { seq.current++; },
  };
}

// ── TheSession body ───────────────────────────────────────────────────────────

export interface TheSessionBodyProps {
  ctx: AppContext;
  getTargetDeckIds?: () => Set<string> | undefined;
  onNavigateToCard?: () => void;
  withDeckChoice?: (onReady: () => void, onCancel?: () => void) => void;
  /** Opens the tune tab with this already in its lookup field, as if typed.
   *  One id previews that tune; several joined with ';' arm the batch — the
   *  field's own parser decides, so a caller never has to know which. */
  initialQuery?: string;
}

export function TheSessionBody({ ctx, getTargetDeckIds, onNavigateToCard, withDeckChoice = onReady => onReady(), initialQuery }: TheSessionBodyProps) {
  const [tab, setTab] = useState<'tune' | 'member' | 'bookmarks' | 'sets'>('tune');
  const [status, setStatus] = useState<ComponentChild>('');

  const setImportedStatus = (cardId: string, cardName: string) => {
    setStatus(successLine(
      <>
        {t('theSession.status.imported', { name: '\x00' }).split('\x00')[0]}
        <span class="text-accent cursor-pointer hover:underline" data-tour="ts-imported" onClick={() => { ctx.navigate({ view: 'card', cardId }); onNavigateToCard?.(); }}>
          {cardName}
        </span>
        {t('theSession.status.imported', { name: '\x00' }).split('\x00')[1]}
      </>,
    ));
  };

  // ── Shared: import a single tune ──────────────────────────────────────────
  // Fetch, THEN ask where it goes, THEN write. The order matters twice over: a
  // lookup that fails or returns nothing never gets to ask a pointless
  // question, and dismissing the deck modal imports nothing at all.
  const importTune = async (tuneId: number, onSuccess: () => void, setBusy: (b: boolean) => void) => {
    setBusy(true);
    setStatus(t('theSession.status.fetching'));
    let tune;
    try {
      tune = await fetchTuneById(tuneId);
    } catch (e) {
      setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })));
      setBusy(false);
      return;
    }
    const existing = findByExternalId(`thesession:${tune.id}`, appState.value.cards);
    withDeckChoice(() => { void (async () => {
      if (existing) {
        await mutate(s => {
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === existing.id)) deck.entries.push({ cardId: existing.id });
          }
        });
        setStatus(t('theSession.status.alreadyInLibrary', { name: tune.name }));
        setBusy(false);
      } else {
        const card = tuneResultToCard(tune);
        await mutateWithRule(s => {
          s.cards[card.id] = card;
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
          }
        });
        setImportedStatus(card.id, card.name);
        onSuccess();
      }
    })(); }, () => { setStatus(''); setBusy(false); });
  };

  /** Shared: import a list of tune IDs (e.g. pasted "1;5;97"), same shape as
   *  the member tunebook batch import below. */
  const importIds = async (
    ids: number[],
    onProgress: (loaded: number, total: number) => void,
    onDone: () => void,
  ): Promise<void> => {
    setStatus(t('theSession.status.fetching'));
    let fetched;
    try {
      const existingCardIdByTuneId = buildExistingByTuneId();
      const { tunes, skippedIds, blocked } = await fetchTunesByIds(ids, onProgress, id => existingCardIdByTuneId.has(id));
      fetched = { newCards: tunes.map(tune => tuneResultToCard(tune)), skippedIds, blocked, existingCardIdByTuneId };
    } catch (e) {
      setStatus(errorLine(tuneFetchStatus(e, 'theSession.error')));
      onDone();
      return;
    }
    const { newCards, skippedIds, blocked, existingCardIdByTuneId } = fetched;
    // The whole batch came back empty (every id blocked or unknown): there is
    // no card to place, so the deck question would have no subject.
    if (newCards.length === 0 && skippedIds.length === 0) {
      setStatus(<InlineStatus tone="warn">{batchSummary(0, 0, blocked)}</InlineStatus>);
      onDone();
      return;
    }
    withDeckChoice(() => { void (async () => {
      await mutateWithRule(s => {
        for (const card of newCards) { s.cards[card.id] = card; }
        const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
        for (const deckId of (getTargetDeckIds?.() ?? [])) {
          const deck = s.decks[deckId]; if (!deck) continue;
          for (const cardId of linkIds) {
            if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        }
      });
      setStatus(successLine(batchSummary(newCards.length, skippedIds.length, blocked)));
      onDone();
    })(); }, () => { setStatus(''); onDone(); });
  };

  return (
    <div class="space-y-3">
      <div data-tour="ts-tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'tune', label: t('theSession.tabTune') },
            { value: 'member', label: t('theSession.tabMember') },
            { value: 'bookmarks', label: t('theSession.tabBookmarks') },
            { value: 'sets', label: t('theSession.tabSets') },
          ]}
        />
      </div>

      <div class="space-y-3">
        {tab === 'tune' && (
          <TuneTab setStatus={setStatus} importTune={importTune} importIds={importIds} initialQuery={initialQuery} />
        )}
        {tab === 'member' && (
          <MemberTab getTargetDeckIds={getTargetDeckIds} withDeckChoice={withDeckChoice} setStatus={setStatus} />
        )}
        {tab === 'bookmarks' && (
          <BookmarksTab getTargetDeckIds={getTargetDeckIds} withDeckChoice={withDeckChoice} setStatus={setStatus} />
        )}
        {tab === 'sets' && (
          <SetsTab getTargetDeckIds={getTargetDeckIds} withDeckChoice={withDeckChoice} setStatus={setStatus} />
        )}
      </div>

      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </div>
  );
}

// ── Tab: Tune (ID, name search, or a pasted "1;5;97" ID list) ─────────────────

function TuneTab({ setStatus, importTune, importIds, initialQuery }: {
  setStatus: (c: ComponentChild) => void;
  importTune: (tuneId: number, onSuccess: () => void, setBusy: (b: boolean) => void) => Promise<void>;
  importIds: (ids: number[], onProgress: (loaded: number, total: number) => void, onDone: () => void) => Promise<void>;
  initialQuery?: string;
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
  const [suggestions, setSuggestions] = useState<Array<{ id: number; name: string; type: string; via?: string }>>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useLatestOnly();

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // Kick off the local tune-name index sync as soon as this tab is shown
  // (fire-and-forget) — by the time the user finishes typing, it's usually
  // already resolved. Cheap on every call after the first (see
  // tuneNameIndexService.ts): a single commit-SHA check unless
  // TheSession's tunes.json dump actually changed upstream.
  useEffect(() => { void ensureTuneSearchIndex().catch(() => { /* handled per-search below */ }); }, []);

  // Resets `busy` too — typing invalidates whatever the last import's outcome
  // was, and this is called at the top of every keystroke, so a stale "busy"
  // from a just-finished single-tune import (never explicitly cleared on its
  // success path, same as the original) never permanently blocks the button
  // once a fresh valid query comes in.
  const clearResult = () => { setPendingId(null); setPendingIds(null); setInfo(''); setBusy(false); };

  const doImport = () => {
    if (pendingIds) {
      const ids = pendingIds;
      setBusy(true);
      setBatchBusy(true);
      setProgress(0);
      void importIds(ids, (loaded, total) => { setProgress(Math.round((loaded / total) * 100)); setStatus(t('theSession.status.fetchingTunes', { loaded, total })); }, () => {
        setBusy(false); setBatchBusy(false); setProgress(null); setValue(''); clearResult();
      });
      return;
    }
    if (pendingId === null) return;
    void importTune(pendingId, () => { setValue(''); clearResult(); }, setBusy);
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    latest.cancel();
    setValue(val);
    clearResult(); setStatus(''); setSuggestions([]); setDropdownOpen(false);
    const trimmed = val.trim();
    if (!trimmed) return;
    const ids = parseIdList(trimmed);
    if (ids.length > 0) {
      setPendingIds(ids); setPendingId(null);
      setInfo(ids.length === 1 ? t('theSession.ids.preview', { count: ids.length }) : t('theSession.ids.previewPlural', { count: ids.length }));
      return;
    }
    if (/^\d+$/.test(trimmed)) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.fetching'));
        const fresh = latest.begin();
        try {
          const tune = await fetchTuneById(parseInt(trimmed));
          if (!fresh()) return;
          setPendingId(tune.id); setPendingIds(null);
          setInfo(`${tune.name} · ${tune.type}`);
          setStatus('');
        } catch (e) {
          if (!fresh()) return;
          // 451 is not "no such tune": it exists and was taken down. Calling
          // that "not found" sends the user hunting for a typo they didn't make.
          setStatus(errorLine(e instanceof TuneUnavailableError ? t('theSession.id.unavailable') : t('theSession.id.notFound')));
        }
      }, 150);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          let tunes: Array<{ id: number; name: string; type: string; via?: string }>;
          try {
            // Local-first: TheSession's own /tunes/search has proven
            // unreliable in practice. Falls back to it below only if the
            // local index genuinely isn't available (offline on a device
            // that has never synced it, or the sync itself failed).
            //
            // Deliberately NOT extended to "the index returned no match":
            // the index mirrors adactio/TheSession-data and lags the live
            // site, so a tune added in the last few days is absent from it —
            // but querying the unreliable remote search on every empty result
            // is a worse trade than missing those few. Settled call, don't
            // re-add it.
            const index = await ensureTuneSearchIndex();
            tunes = searchLocalTuneIndex(index, trimmed);
          } catch {
            const remote = await searchTunes(trimmed);
            // TheSession names the alias it matched on; shown the same way.
            tunes = sortByRelevance(remote, trimmed).map(r => ({ ...r, via: r.alias }));
          }
          setSuggestions(tunes);
          setDropdownOpen(tunes.length > 0);
          setStatus(tunes.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
      }, 300);
    }
  };

  // Arrived with something to look up (repairing a broken card reference):
  // play it through the SAME path a keystroke takes, so one id previews and
  // several arm the batch without this knowing the difference. Once, on mount
  // — afterwards the field belongs to the user.
  useEffect(() => { if (initialQuery) onInputChange(initialQuery); }, []);

  const pick = (tune: { id: number; name: string; type: string }) => {
    setValue(tune.name);
    setDropdownOpen(false);
    setPendingId(tune.id); setPendingIds(null);
    setInfo(`${tune.name} · ${tune.type}`);
    setStatus('');
  };

  const knownIds = () => new Set(
    Object.values(appState.value.cards)
      .map(c => c.externalId)
      .filter((id): id is string => !!id && id.startsWith('thesession:'))
      .map(id => parseInt(id.slice('thesession:'.length), 10)),
  );

  return (
    <>
      <div class="flex gap-2" data-tour="ts-tune">
        <InputRow
          inputRef={inputRef}
          placeholder={t('theSession.tune.placeholder')}
          title={t('theSession.ids.hint')}
          value={value}
          info={info}
          disabled={batchBusy}
          onInput={onInputChange}
          onFocus={() => { if (suggestions.length) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDropdownOpen(false); }
            if (e.key === 'Enter' && (pendingId !== null || pendingIds !== null)) doImport();
          }}
        />
        <button class="btn-primary text-xs shrink-0" disabled={busy || (pendingId === null && pendingIds === null)} onClick={doImport}>
          {t('theSession.id.import')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <SuggestDropdown
        tourFloat
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={pick}
        renderItem={(tune) => (
          <>
            <div class="flex-1 min-w-0">
              <span class="text-sm text-primary truncate block">{tune.name}</span>
              <span class="text-xs text-dim truncate block">
                {tune.via !== undefined ? `${tune.type} · ${t('search.viaAlias', { alias: tune.via })}` : tune.type}
              </span>
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

// ── Tab: Member (ID or name search) ────────────────────────────────────────────

function MemberTab({ getTargetDeckIds, withDeckChoice, setStatus }: {
  getTargetDeckIds?: () => Set<string> | undefined;
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
  setStatus: (c: ComponentChild) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MemberSearchResult[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selectedMemberIdRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useLatestOnly();
  const [, bump] = useState(0);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // `byId` is passed, never re-derived from `value`: this runs after a debounce
  // and after a state update, so the `value` it closes over is the one from the
  // render that scheduled it — the text BEFORE the keystroke that asked for
  // this preview. The caller is the only one who knows without guessing.
  const showMemberPreview = async (memberId: number, byId: boolean) => {
    const fresh = latest.begin();
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      const info = await fetchMemberInfo(memberId);
      if (!fresh()) return;
      const size = t(info.tunebook === 1 ? 'theSession.member.tuneCount' : 'theSession.member.tuneCountPlural', { n: info.tunebook });
      setInfo(byId ? `${info.name} · ${size}` : size);
      // An empty tunebook is a perfectly ordinary account, not an error —
      // say so, and leave nothing to press.
      if (info.tunebook === 0) {
        setStatus(t('theSession.member.emptyTunebook'));
        selectedMemberIdRef.current = null; bump(x => x + 1);
        return;
      }
      selectedMemberIdRef.current = memberId; bump(x => x + 1);
      setStatus('');
    } catch (e) {
      if (!fresh()) return;
      setStatus(errorLine(memberErrorStatus(e)));
      selectedMemberIdRef.current = null; bump(x => x + 1);
    }
  };

  const doImportAll = async () => {
    if (selectedMemberIdRef.current === null) return;
    const memberId = selectedMemberIdRef.current;
    setBusy(true);
    setProgress(0);
    setStatus(t('theSession.status.fetchingPage'));
    try {
      const existingCardIdByTuneId = buildExistingByTuneId();
      const { tunes, skippedIds, blocked } = await fetchMemberTunes(memberId, (loaded, total, phase) => {
        setProgress(Math.round((loaded / total) * 100));
        setStatus(phase === 'pages' ? t('theSession.status.collectingIds', { loaded, total }) : t('theSession.status.fetchingTunes', { loaded, total }));
      }, id => existingCardIdByTuneId.has(id));
      const newCards = tunes.map(tune => tuneResultToCard(tune));
      // The tunebook yielded nothing to file — asking for a destination would
      // be a question about no cards at all.
      if (newCards.length === 0 && skippedIds.length === 0) {
        setProgress(100);
        setStatus(<InlineStatus tone="warn">{batchSummary(0, 0, blocked)}</InlineStatus>);
        setBusy(false);
        return;
      }
      withDeckChoice(() => { void (async () => {
        await mutateWithRule(s => {
          for (const card of newCards) { s.cards[card.id] = card; }
          // Already-owned tunes were skipped above (no re-fetch), but they
          // still belong in the chosen decks if they were missing there.
          const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            for (const cardId of linkIds) {
              if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
            }
          }
        });
        setProgress(100);
        setStatus(successLine(batchSummary(newCards.length, skippedIds.length, blocked)));
        setBusy(false);
      })(); }, () => { setStatus(''); setProgress(null); setBusy(false); });
    } catch (e) {
      setStatus(errorLine(tuneFetchStatus(e, 'theSession.error')));
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    latest.cancel();
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      // Debounced like the name search beside it, which always was. An ID is
      // typed digit by digit and every prefix is a valid member, so "12345"
      // used to ask TheSession about five different people — and show whichever
      // answered last.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void showMemberPreview(parseInt(trimmed), true);
      }, 300);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
      }, 300);
    }
  };

  const pick = (m: MemberSearchResult) => {
    setValue(m.name);
    setDropdownOpen(false);
    void showMemberPreview(m.id, false);
    setStatus('');
  };

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('theSession.member.placeholder')}
          value={value}
          info={info}
          disabled={busy}
          onInput={onInputChange}
          onFocus={() => { if (suggestions.length) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDropdownOpen(false); }
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => void doImportAll()}
        >
          {t('theSession.member.importAll')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <SuggestDropdown
        tourFloat
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={pick}
        renderItem={(m) => <span class="text-sm text-primary truncate">{m.name}</span>}
      />
    </>
  );
}

// ── Tab: Bookmarks (the settings a member has starred) ────────────────────────
// The same shape as the tunebook and sets tabs, down to the two-phase bar: the
// bookmarks endpoint reports `total` and `pages`, so the listing is a fraction
// and the size can be previewed before anything is imported.
//
// The preview costs its own request rather than reading the member payload's
// `bookmarks` field, which counts recordings and discussions too — see the
// Bookmarks section of theSessionService for the arithmetic.
//
// What makes bookmarks worth their own tab: a bookmark names a SETTING, so each
// tune created here opens on the very version the member starred.

function BookmarksTab({ getTargetDeckIds, withDeckChoice, setStatus }: {
  getTargetDeckIds?: () => Set<string> | undefined;
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
  setStatus: (c: ComponentChild) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MemberSearchResult[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selectedMemberIdRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useLatestOnly();
  const [, bump] = useState(0);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // `byId` is passed, never re-derived from `value`: this runs after a debounce
  // and after a state update, so the `value` it closes over is the one from the
  // render that scheduled it — the text BEFORE the keystroke that asked for
  // this preview. The caller is the only one who knows without guessing.
  const showMemberPreview = async (memberId: number, byId: boolean) => {
    const fresh = latest.begin();
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      // Together, not one then the other: this tab is the only one whose
      // preview needs two requests, and chaining them would make it the
      // slowest of the four for no reason.
      const [found, n] = await Promise.all([fetchMemberInfo(memberId), fetchMemberBookmarkCount(memberId)]);
      if (!fresh()) return;
      const size = t('theSession.bookmarks.count', { n });
      setInfo(byId ? `${found.name} · ${size}` : size);
      // A member who has bookmarked nothing is an ordinary account, not an
      // error — say so, and leave nothing to press.
      if (n === 0) { setStatus(t('theSession.bookmarks.none')); return; }
      selectedMemberIdRef.current = memberId; bump(x => x + 1);
      setStatus('');
    } catch (e) {
      if (!fresh()) return;
      setStatus(errorLine(memberErrorStatus(e)));
      selectedMemberIdRef.current = null; bump(x => x + 1);
    }
  };

  const doImportAll = async () => {
    if (selectedMemberIdRef.current === null) return;
    const memberId = selectedMemberIdRef.current;
    setBusy(true); setProgress(0);
    try {
      // Phase one: the listing, paged towards the total the endpoint reports.
      const bookmarks = await fetchMemberBookmarks(memberId, (loaded, total) => {
        setProgress(Math.round((loaded / total) * 50));
        setStatus(t('theSession.bookmarks.collecting', { loaded, total }));
      });
      if (bookmarks.length === 0) {
        setStatus(t('theSession.bookmarks.none'));
        setProgress(null);
        return;
      }

      // Phase two: create what is missing. An already-owned tune is skipped
      // whole, exactly as in every other import path — its starred setting is
      // the user's own choice and no import gets to overwrite it.
      const existingByTuneId = buildExistingByTuneId();
      const todo = bookmarks.filter(b => !existingByTuneId.has(b.tuneId));
      const skipped = bookmarks.length - todo.length;
      const newCards: Card[] = [];
      const blocked: SkippedTune[] = [];
      for (let i = 0; i < todo.length; i++) {
        const bookmark = todo[i]!;
        setStatus(t('theSession.status.fetchingTunes', { loaded: i + 1, total: todo.length }));
        setProgress(50 + Math.round(((i + 1) / todo.length) * 50));
        try {
          newCards.push(await buildTuneCardWithSetting(bookmark));
        } catch (e) {
          if (!(e instanceof TuneUnavailableError)) throw e;
          blocked.push({ id: bookmark.tuneId, name: bookmark.name || undefined });
        }
      }

      // Everything is fetched by now, so the deck question is asked over a
      // known set of cards — and skipped entirely when there is none.
      if (newCards.length === 0 && skipped === 0) {
        setProgress(100);
        setStatus(<InlineStatus tone="warn">{batchSummary(0, 0, blocked)}</InlineStatus>);
        setBusy(false);
        return;
      }
      withDeckChoice(() => { void (async () => {
        await mutateWithRule(s => {
          for (const card of newCards) s.cards[card.id] = card;
          // Bookmarks ARE tunes, so the deck choice applies to them directly —
          // unlike a set import, where the deck belongs to the set card and the
          // tunes it pulls in land unfiled.
          const linkIds = [
            ...newCards.map(c => c.id),
            ...bookmarks.map(b => existingByTuneId.get(b.tuneId)).filter((id): id is string => !!id),
          ];
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            for (const cardId of linkIds) {
              if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
            }
          }
        });
        setProgress(100);
        setStatus(successLine(batchSummary(newCards.length, skipped, blocked)));
        setBusy(false);
      })(); }, () => { setStatus(''); setProgress(null); setBusy(false); });
    } catch (e) {
      setStatus(errorLine(e instanceof MemberUnavailableError ? memberErrorStatus(e) : tuneFetchStatus(e, 'theSession.error')));
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    latest.cancel();
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      // Debounced like the name search beside it, which always was. An ID is
      // typed digit by digit and every prefix is a valid member, so "12345"
      // used to ask TheSession about five different people — and show whichever
      // answered last.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void showMemberPreview(parseInt(trimmed), true);
      }, 300);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
      }, 300);
    }
  };

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('theSession.member.placeholder')}
          value={value}
          info={info}
          disabled={busy}
          onInput={onInputChange}
          onFocus={() => { if (suggestions.length) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDropdownOpen(false); }
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => void doImportAll()}
        >
          {t('theSession.member.importAll')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <SuggestDropdown
        tourFloat
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={(m) => { setValue(m.name); setDropdownOpen(false); void showMemberPreview(m.id, false); setStatus(''); }}
        renderItem={(m) => <span class="text-sm text-primary truncate">{m.name}</span>}
      />
    </>
  );
}

// ── Tab: Sets (a member's published sets) ─────────────────────────────────────
// Sets are only ever reachable through their member: TheSession has no set
// search, and /sets/{id} is a 404 — the member is part of a set's very address.
// So this shares the tunebook tab's member lookup and differs after it: instead
// of importing everything, it lists what the member has and lets you pick.

function SetsTab({ getTargetDeckIds, withDeckChoice, setStatus }: {
  getTargetDeckIds?: () => Set<string> | undefined;
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
  setStatus: (c: ComponentChild) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MemberSearchResult[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selectedMemberIdRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useLatestOnly();
  const [, bump] = useState(0);
  /** False once the dialog is closed: an import under way stops, and writes
   *  nothing (importSets). */
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  /** One cheap request that answers "does this member exist, and is there
   *  anything to page through" before any paging begins. */
  // `byId` is passed, never re-derived from `value`: this runs after a debounce
  // and after a state update, so the `value` it closes over is the one from the
  // render that scheduled it — the text BEFORE the keystroke that asked for
  // this preview. The caller is the only one who knows without guessing.
  const showMemberPreview = async (memberId: number, byId: boolean) => {
    const fresh = latest.begin();
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      const found = await fetchMemberInfo(memberId);
      if (!fresh()) return;
      const size = t('theSession.sets.count', { n: found.sets });
      setInfo(byId ? `${found.name} · ${size}` : size);
      // A member with no sets is an ordinary account, not an error — say so and
      // leave nothing to press.
      if (found.sets === 0) { setStatus(t('theSession.sets.none')); return; }
      selectedMemberIdRef.current = memberId; bump(x => x + 1);
      setStatus('');
    } catch (e) {
      if (!fresh()) return;
      setStatus(errorLine(memberErrorStatus(e)));
      selectedMemberIdRef.current = null; bump(x => x + 1);
    }
  };

  const doImportAll = async () => {
    if (selectedMemberIdRef.current === null) return;
    const memberId = selectedMemberIdRef.current;
    setBusy(true); setProgress(0);
    let sets;
    try {
      // Phase one: the listing, which for a prolific member runs to dozens of
      // pages (539 sets over 54 requests for member 1) — hence a progress bar
      // rather than a silent wait.
      sets = await fetchMemberSets(memberId, (loaded, total) => {
        setProgress(Math.round((loaded / total) * 50));
        setStatus(t('theSession.sets.loading', { loaded, total }));
      });
    } catch (e) {
      setStatus(errorLine(tuneFetchStatus(e, 'theSession.error')));
      setBusy(false);
      return;
    }
    if (sets.length === 0) {
      setProgress(100);
      setStatus(t('theSession.sets.done', { sets: 0, tunes: 0 }));
      setBusy(false);
      return;
    }
    // The deck answer is taken here, once the listing has proved there is
    // something to file, and before the sets themselves are fetched — the
    // part that takes long.
    withDeckChoice(() => { void importSets(sets!); }, () => { setStatus(''); setProgress(null); setBusy(false); });
  };

  /** All or nothing (2026-11-06): every set is fetched first, then ONE write
   *  files them all — as the tunebook import above does. It used to write set
   *  by set, which copied the whole library per set and left half an import
   *  behind when it stopped. Closing the dialog part-way now writes nothing,
   *  and so does a failure: the error is said, the library is untouched. */
  const importSets = async (sets: Awaited<ReturnType<typeof fetchMemberSets>>) => {
    let created = 0, imported = 0, skipped = 0;
    try {
      /** Sets already in the library, to be filed into the chosen decks only. */
      const alreadyIds: string[] = [];
      const built: { setCard: Card; newTunes: Card[] }[] = [];
      /** Tunes this run is creating, so a tune two sets play is created once:
       *  nothing is in the state until the end. */
      const createdInRun: Record<string, Card> = {};
      // Phase two: one set at a time.
      for (let i = 0; i < sets.length; i++) {
        if (!aliveRef.current) return;
        const set = sets[i]!;
        setProgress(50 + Math.round((i / sets.length) * 50));

        // A set already in the library is SKIPPED, exactly as an already-owned
        // tune is: an import never rewrites an existing card, it only files it
        // into the chosen decks. Bringing a set back in line with TheSession is
        // a separate, deliberate act — "Refresh tunes" on its source pin. The
        // check comes before any fetch, so a skipped set costs no network.
        const already = findByExternalId(setExternalId(set.memberId, set.id), appState.value.cards);
        if (already) { skipped++; alreadyIds.push(already.id); continue; }

        setStatus(t('theSession.sets.importing', { name: set.name, n: i + 1, total: sets.length }));
        const one = await buildSetCards(set, { ...appState.value.cards, ...createdInRun }, defaultTuneRepeat(appState.value));
        for (const tune of one.newTunes) createdInRun[tune.id] = tune;
        built.push(one);
        created += one.newTunes.length;
        imported++;
      }
      if (!aliveRef.current) return;
      setStatus(t('sessions.batch.saving'));
      await mutateWithRule(s => {
        const file = (cardId: string) => {
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        };
        for (const id of alreadyIds) file(id);
        for (const { setCard, newTunes } of built) {
          for (const tune of newTunes) s.cards[tune.id] = tune;
          s.cards[setCard.id] = setCard;
          // The deck choice applies to the SET — that is what was imported.
          // Tunes created along the way land in the library with no deck; they
          // are reachable from the set, and each shows it under "played in
          // these sets". Filing them is the user's call, later or never.
          file(setCard.id);
        }
      });
      setProgress(100);
      setStatus(successLine(
        t('theSession.sets.done', { sets: imported, tunes: created })
        + (skipped > 0 ? t('theSession.sets.doneSkipped', { count: skipped }) : ''),
      ));
    } catch (e) {
      setStatus(errorLine(tuneFetchStatus(e, 'theSession.error')));
    } finally {
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    latest.cancel();
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      // Debounced like the name search beside it, which always was. An ID is
      // typed digit by digit and every prefix is a valid member, so "12345"
      // used to ask TheSession about five different people — and show whichever
      // answered last.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void showMemberPreview(parseInt(trimmed), true);
      }, 300);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
      }, 300);
    }
  };

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('theSession.member.placeholder')}
          value={value}
          info={info}
          disabled={busy}
          onInput={onInputChange}
          onFocus={() => { if (suggestions.length) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDropdownOpen(false); }
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => void doImportAll()}
        >
          {t('theSession.sets.importAll')}
        </button>
      </div>

      {progress !== null && (
        <div class="space-y-1">
          <div class="knowledge-bar"><div class="knowledge-fill bg-accent" style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      <SuggestDropdown
        tourFloat
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={(m) => { setValue(m.name); setDropdownOpen(false); void showMemberPreview(m.id, false); setStatus(''); }}
        renderItem={(m) => <span class="text-sm text-primary truncate">{m.name}</span>}
      />
    </>
  );
}

// ── New Card modal (hierarchical flow) ─────────────────────────────────────────

type Step = 'root' | 'create' | 'import' | 'thesession' | 'irishtuneinfo' | 'json' | 'json-file' | 'share';

const BACK_PARENT: Partial<Record<Step, Step>> = {
  create: 'root', import: 'root',
  thesession: 'import', irishtuneinfo: 'import', json: 'import',
  'json-file': 'json', share: 'json',
};

/** Whether Cadence's own cards are the only thing to import from: TheSession
 *  and irishtune.info are the Irish trad extension's options
 *  (services/extensions.ts). */
function onlyCadenceCards(): boolean {
  return !theSessionOffered() && !irishTuneInfoOffered();
}

/** Where ← leads. When only Cadence's own cards are left, the import step IS
 *  theirs (ImportStep), so its two choices climb straight to it. */
function backParent(step: Step): Step {
  if (onlyCadenceCards() && (step === 'json-file' || step === 'share')) return 'import';
  return BACK_PARENT[step] ?? 'root';
}

/** The import entry's line: the sources actually offered. */
function importDescKey(): string {
  if (onlyCadenceCards()) return 'newCard.importDescPlain';
  return irishTuneInfoOffered() ? 'newCard.importDesc' : 'newCard.importDescTheSession';
}

/** The rows of this wizard are the shared ChoiceCard (components/ui.tsx): its
 *  description is on screen, where it used to be only a tooltip — which a
 *  finger never sees. The icons are all in the accent: the warn and success
 *  they used to wear per row warned of nothing and succeeded at nothing. */
const ICON_SIZE = 20;
/** A page with a pencil — "start a blank one". No icon in icons.tsx draws it
 *  (PencilIcon is the bare pencil of "rename"), so it stays here. */
const ICON_CREATE = `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

const nextStep = <ArrowRightIcon size={16} />;

function RootStep({ navigate }: { navigate: (s: Step) => void }) {
  return (
    <>
      <ChoiceCard icon={<span class="flex" dangerouslySetInnerHTML={{ __html: ICON_CREATE }} />} label={t('newCard.tabCreate')} desc={t('newCard.createDesc')} trailing={nextStep} tour="newcard-create" onClick={() => navigate('create')} />
      <ChoiceCard icon={<ImportTrayIcon size={ICON_SIZE} />} label={t('newCard.tabImport')} desc={t(importDescKey())} trailing={nextStep} tour="newcard-import" onClick={() => navigate('import')} />
    </>
  );
}

function CreateStep({ withDeckChoice, getChosenDeckIds, onOpenCard }: {
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
  getChosenDeckIds: () => Set<string>;
  onOpenCard: (cardId: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ComponentChild>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { inputRef.current?.focus(); return; }
    setBusy(true);
    let createdId = '';
    await mutate(s => {
      const id   = generateId();
      const guid = generateId();
      createdId = id;
      s.cards[id] = { id, guid, name: trimmed, defaultImportance: 1, tags: [], content: { notes: '', attachments: [] } };
      for (const deckId of getChosenDeckIds()) { // doCreate only ever runs via withDeckChoice, which guarantees this
        const deck = s.decks[deckId];
        if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
      }
    });
    setStatus(successLine(
      <>
        {t('newCard.create.done', { name: '\x00' }).split('\x00')[0]}
        <span class="text-accent cursor-pointer hover:underline" data-tour="newcard-open" onClick={() => onOpenCard(createdId)}>{trimmed}</span>
        {t('newCard.create.done', { name: '\x00' }).split('\x00')[1]}
      </>,
    ));
    // `busy` was set on the way in and never cleared, so the button stayed
    // disabled for good and this step could only ever create ONE card per
    // opening (bug found in a browser on 2026-09-06, older than the deck work).
    // It matters more now: pinning a deck exists precisely so that the second,
    // third and fourth card cost fewer clicks than the first.
    setBusy(false);
    setName('');
    inputRef.current?.focus();
  };

  return (
    <>
      {/* One block for the walkthrough to light: the field and its button,
          not the line saying what was made (walkthrough/). */}
      <div class="flex flex-col gap-3" data-tour="newcard-form">
      <label class="label">{t('newCard.nameLabel')}</label>
      <input
        ref={inputRef}
        type="text"
        class="input"
        placeholder={t('newCard.namePlaceholder')}
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') withDeckChoice(() => { void doCreate(); }); }}
      />
      <button class="btn-primary w-full mt-1" disabled={busy} onClick={() => withDeckChoice(() => { void doCreate(); })}>
        {t('newCard.createBtn')}
      </button>
      </div>
      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </>
  );
}

function ImportStep({ navigate }: { navigate: (s: Step) => void }) {
  // TheSession and irishtune.info are the Irish trad extension's options
  // (services/extensions.ts). With neither, only Cadence's own cards are
  // left, and a menu of one entry would be a click for nothing: their two
  // ways in are shown right here.
  if (onlyCadenceCards()) return <JsonStep navigate={navigate} />;
  return (
    <>
      {theSessionOffered() && (
        <ChoiceCard icon={<SearchIcon size={ICON_SIZE} />} label={t('newCard.tabTheSession')} desc={t('newCard.theSessionDesc')} trailing={nextStep} tour="newcard-thesession" onClick={() => navigate('thesession')} />
      )}
      {irishTuneInfoOffered() && (
        <ChoiceCard icon={<GlobeIcon size={ICON_SIZE} />} label={t('newCard.tabIrishTuneInfo')} desc={t('newCard.irishTuneInfoDesc')} trailing={nextStep} tour="newcard-iti" onClick={() => navigate('irishtuneinfo')} />
      )}
      {/* A page, not the import tray: the tray is the entry that led here. */}
      <ChoiceCard icon={<FileIcon size={ICON_SIZE} />} label={t('newCard.tabImportJson')} desc={t('newCard.importJsonDesc')} trailing={nextStep} onClick={() => navigate('json')} />
    </>
  );
}

function JsonStep({ navigate }: { navigate: (s: Step) => void }) {
  return (
    <>
      <ChoiceCard icon={<FileIcon size={ICON_SIZE} />} label={t('library.export.file')} desc={t('newCard.importJsonDesc')} trailing={nextStep} onClick={() => navigate('json-file')} />
      <ChoiceCard icon={<ShareIcon size={ICON_SIZE} />} label={t('newCard.share.label')} desc={t('newCard.share.desc')} trailing={nextStep} onClick={() => navigate('share')} />
    </>
  );
}

function JsonFileStep({ getChosenDeckIds, withDeckChoice }: {
  getChosenDeckIds: () => Set<string>;
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ComponentChild>('');

  const doImportFile = async (file: File) => {
    setBusy(true); setStatus(t('newCard.import.importing'));
    let cards;
    try {
      cards = await parseCardPackage(file);
    } catch (e) {
      setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })));
      setBusy(false);
      return;
    }
    if (cards.length === 0) { setStatus(t('newCard.import.empty')); setBusy(false); return; }
    withDeckChoice(
      () => { void (async () => {
        try { setStatus(successLine(await importCardPackage(cards, getChosenDeckIds()))); }
        catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
        finally { setBusy(false); }
      })(); },
      () => { setStatus(''); setBusy(false); },
    );
  };

  return (
    <>
      <button
        class="btn-primary w-full text-sm"
        disabled={busy}
        onClick={() => {
          const fileInp = document.createElement('input'); fileInp.type = 'file';
          const accept = ownFormatAccept('.cdc');
          if (accept) fileInp.accept = accept;
          fileInp.onchange = () => {
            const file = fileInp.files?.[0]; if (!file) return;
            void doImportFile(file);
          };
          fileInp.click();
        }}
      >
        {t('newCard.import.pick')}
      </button>
      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </>
  );
}

function ShareStep({ getChosenDeckIds, withDeckChoice }: {
  getChosenDeckIds: () => Set<string>;
  withDeckChoice: (onReady: () => void, onCancel?: () => void) => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ComponentChild>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const doImport = async () => {
    const trimmed = key.trim();
    if (trimmed.length !== 6) return;
    setBusy(true); setStatus(t('newCard.import.importing'));
    let cards;
    try {
      const text = await downloadShare(trimmed);
      const file = new File([text], `share-${trimmed}.cdc`, { type: 'application/octet-stream' });
      cards = await parseCardPackage(file);
    } catch (e) {
      setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })));
      setBusy(false);
      return;
    }
    if (cards.length === 0) { setStatus(t('newCard.import.empty')); setBusy(false); return; }
    withDeckChoice(
      () => { void (async () => {
        try { setStatus(successLine(await importCardPackage(cards, getChosenDeckIds()))); }
        catch (e) { setStatus(errorLine(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }))); }
        finally { setBusy(false); }
      })(); },
      () => { setStatus(''); setBusy(false); },
    );
  };

  return (
    <>
      <div class="flex gap-2">
        <InputRow
          inputRef={inputRef}
          placeholder={t('newCard.share.placeholder')}
          value={key}
          info=""
          maxLength={6}
          disabled={busy}
          onInput={setKey}
          onKeyDown={(e) => { if (e.key === 'Enter') void doImport(); }}
        />
        <button class="btn-primary text-xs shrink-0" disabled={busy || key.trim().length !== 6} onClick={() => void doImport()}>
          {t('newCard.share.importBtn')}
        </button>
      </div>
      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </>
  );
}

/** Opens the modal straight on one source's lookup, already filled in.
 *
 *  The only caller today is the repair of a broken card reference, which knows
 *  exactly which tune is missing and where it came from. Deliberately routed
 *  through this modal rather than importing behind the user's back: the deck
 *  gate lives here (`withDeckChoice`), and nothing should be created without
 *  that decision having been offered. */
export interface NewCardPreset {
  source: 'thesession' | 'irishtuneinfo';
  /** One id, or several joined with ';' — the field's own parser decides. */
  query: string;
}

function NewCardModal({ ctx, initialDeckIds, preset, onClose }: { ctx: AppContext; initialDeckIds?: string[]; preset?: NewCardPreset; onClose: () => void }) {
  // A preset skips the menu entirely: the user did not come here to choose a
  // source, they came to repair one precise reference.
  const [step, setStep] = useState<Step>(preset?.source ?? 'root');
  // Pins live in this modal and die with it, and the decks the last confirmed
  // choice named are what the tabs below read. The header button that used to
  // set a destination once for the whole modal is gone (2026-09-06): the
  // question is now asked at each add, where the user is looking.
  const pinnedDeckIdsRef = useRef<Set<string>>(new Set());
  const chosenDeckIdsRef = useRef<Set<string>>(new Set(initialDeckIds ?? []));

  /** Gate for every creation/import trigger — a single tune or a whole batch,
   *  which is one "add" either way. `onReady` runs ONLY on confirm: dismissing
   *  the modal cancels the import itself, not just the deck choice, and
   *  `onCancel` is how the caller lets go of the work it already did. Asked
   *  even with no deck in the library: the modal's "+ new deck" is then the
   *  way to make the first one (the user's rule, 2026-10-30).
   *
   *  Callers fetch BEFORE calling this, and skip it entirely when the fetch came
   *  back empty: choosing a destination for zero cards asks a question whose
   *  answer cannot matter. */
  const withDeckChoice = (onReady: () => void, onCancel?: () => void): void => {
    showDeckChoiceModal({
      pinned: pinnedDeckIdsRef.current,
      // Opened from a deck view: that deck is the context, so it starts ticked
      // every time — ticked, not pinned, and free to be unticked.
      preTicked: initialDeckIds ?? [],
      onConfirm: (deckIds) => { chosenDeckIdsRef.current = new Set(deckIds); onReady(); },
      onDismiss: onCancel,
    });
  };

  // Escape comes through the overlay registry now (main.ts), which knows this
  // overlay's place among everything else on screen. The `!anyModalOpen()`
  // guard that used to be needed here was this file compensating for not
  // having that order — a modal raised from this screen would otherwise have
  // been closed along with the screen underneath it.

  const TITLES: Record<Step, string> = {
    root:         t('newCard.title'),
    create:       t('newCard.tabCreate'),
    import:       t('newCard.tabImport'),
    thesession:   t('newCard.tabTheSession'),
    irishtuneinfo: t('newCard.tabIrishTuneInfo'),
    // Each step after the JSON one is named by the row that led to it: the
    // three of them used to share "Cadence Cards", so the title never moved.
    json:         t('newCard.tabImportJson'),
    'json-file':  t('library.export.file'),
    share:        t('newCard.share.label'),
  };

  const onOpenCard = (cardId: string) => { ctx.navigate({ view: 'card', cardId }); onClose(); };

  const mouseDownOnOverlay = useRef(false);
  // ← pressed twice to climb two steps, the TheSession tabs gone through one
  // by one: every step and tab is its own height. See usePinnedTop.
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pinned = usePinnedTop(true, overlayRef, dialogRef);

  return (
    <div
      ref={overlayRef}
      class={`fixed inset-0 z-50 flex ${pinned.overlayClass} justify-center ${MODAL_BACKDROP}`}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onClose(); }}
    >
      <div
        ref={dialogRef}
        class="bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col"
        style={{ maxWidth: `min(${MODAL_W.m}, ${modalMaxW(0.9)})`, maxHeight: modalMaxH(0.85), ...pinned.dialogStyle }}
        onPointerDownCapture={pinned.onPointerDownCapture}
        onKeyDownCapture={pinned.onKeyDownCapture}
      >
        {/* The shell's header (modal.tsx), drawn here because this dialog is
            not in the shared stack: same row, same title, same two buttons. */}
        <div class="flex items-center justify-between gap-2 px-5 py-2.5 min-h-[3.25rem] border-b border-border shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            {step !== 'root' && (
              <button class="icon-btn -ml-2 shrink-0" title={t('modal.back')} aria-label={t('modal.back')} onClick={() => setStep(backParent(step))}><ArrowLeftIcon size={16} /></button>
            )}
            <h2 class={MODAL_TITLE_CLASS}>{TITLES[step]}</h2>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button class="icon-btn -mr-2" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}><CrossIcon size={16} /></button>
          </div>
        </div>

        <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto">
          {step === 'root' && <RootStep navigate={setStep} />}
          {step === 'create' && <CreateStep withDeckChoice={withDeckChoice} getChosenDeckIds={() => chosenDeckIdsRef.current} onOpenCard={onOpenCard} />}
          {step === 'import' && <ImportStep navigate={setStep} />}
          {step === 'thesession' && <TheSessionBody ctx={ctx} getTargetDeckIds={() => chosenDeckIdsRef.current} onNavigateToCard={onClose} withDeckChoice={withDeckChoice} initialQuery={preset?.source === 'thesession' ? preset.query : undefined} />}
          {step === 'irishtuneinfo' && <IrishTuneInfoBody ctx={ctx} getTargetDeckIds={() => chosenDeckIdsRef.current} onNavigateToCard={onClose} withDeckChoice={withDeckChoice} initialQuery={preset?.source === 'irishtuneinfo' ? preset.query : undefined} />}
          {step === 'json' && <JsonStep navigate={setStep} />}
          {step === 'json-file' && <JsonFileStep getChosenDeckIds={() => chosenDeckIdsRef.current} withDeckChoice={withDeckChoice} />}
          {step === 'share' && <ShareStep getChosenDeckIds={() => chosenDeckIdsRef.current} withDeckChoice={withDeckChoice} />}
        </div>
      </div>
    </div>
  );
}

export function showNewCardModal(ctx: AppContext, initialDeckIds?: string[], preset?: NewCardPreset): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  // Declared like any dialog, though it is not in the shared stack: without
  // this the back gesture navigated behind it, which is exactly the report
  // that prompted the registry.
  let unregister = () => {};
  const close = () => { unregister(); render(null, host); host.remove(); };
  unregister = registerOverlay(close);
  render(<NewCardModal ctx={ctx} initialDeckIds={initialDeckIds} preset={preset} onClose={close} />, host);
}
