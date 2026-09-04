import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import { createPortal } from 'preact/compat';
import type { ComponentChild, RefObject } from 'preact';
import type { AppContext, Card } from '../types';
import { generateId, focusIfDesktop, sortByRelevance } from '../utils';
import { parseCardPackage, parseCardPackageFromText } from '../services/importExport';
import { downloadShare } from '../services/shareService';
import { mutate, appState } from '../store';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo, searchMembers, fetchTunesByIds,
  tuneResultToCard, findByExternalId, fetchMemberSets, buildSetCards, setExternalId, MemberUnavailableError,
  fetchMemberBookmarks, buildTuneCardWithSetting,
  type MemberSearchResult, type TuneSetting,
} from '../services/theSessionService';
import { defaultTuneRepeat } from '../services/abcService';
import { describeTune, tuneFetchStatus, TuneUnavailableError, withTuneIdentity, type SkippedTune } from '../services/tuneFetchError';
import { ensureTuneNameIndex, searchLocalTuneIndex } from '../services/tuneNameIndexService';
import { t } from '../services/i18nService';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import { IrishTuneInfoBody } from './irishTuneInfoImport';
import { showDeckPickerPopover, deckLinkIcon } from './deckSelector';
import { AI_IMPORT_PROMPT } from './aiImportPrompt';
import { fetchTuneById as fetchIriTuneById, tuneToCard as iriTuneToCard } from '../services/irishTuneInfoService';
import { CheckIcon } from './icons';

/** Merges the AI-authored card onto the real fetched one: the fetch is always
 *  authoritative for the tune's identity/ABC (never trust the AI for that —
 *  the whole reason this hydration exists, see the id-hallucination note
 *  below), but the AI's own touches are kept on top rather than discarded —
 *  title override, notes override, tags/attachments appended. Deliberately
 *  NOT merged: defaultImportance — sanitizeCard() always backfills it to 1
 *  when absent, so there's no way to tell "the AI wrote 1" from "the AI wrote
 *  nothing", and silently overriding a genuine 1 would be worse than not
 *  merging it at all. */
/** AI-authored, consumed here only — never persisted as its own field, just
 *  its effect (Attachment.preferredIndex on the merged ABC). Two forms, same
 *  "only if explicitly given, never guessed" rule as externalId itself: a
 *  plain number (1-based position — "the 2nd setting listed", for when the
 *  user told the AI which one by position) or {"settingId": N} (a real
 *  TheSession setting id, e.g. from a #settingN URL the user gave) — resolved
 *  by searching the real fetched settings, never trusted blindly. */
function resolvePreferredSettingIndex(pref: unknown, settings: TuneSetting[]): number | undefined {
  if (typeof pref === 'number') {
    const idx = Math.trunc(pref) - 1;
    return idx >= 0 && idx < settings.length ? idx : undefined;
  }
  if (pref && typeof pref === 'object' && 'settingId' in pref) {
    const settingId = Number((pref as { settingId: unknown }).settingId);
    const idx = settings.findIndex(s => s.id === settingId);
    return idx === -1 ? undefined : idx;
  }
  return undefined;
}

async function hydrateExternalCard(card: Card): Promise<Card> {
  const ext = card.externalId;
  if (!ext) return card;
  const sep = ext.indexOf(':');
  const source = ext.slice(0, sep);
  const id = parseInt(ext.slice(sep + 1), 10);
  if (isNaN(id)) return card;
  // A failure here aborts the whole paste (see doImportPasted) rather than
  // quietly dropping this one card, so it has to say which card it was on —
  // and an AI package can mix both sources, hence the full externalId.
  return withTuneIdentity(ext, card.name || undefined, async () => {
    let fetched: Card | null = null;
    if (source === 'thesession') {
      const tune = await fetchTuneById(id);
      fetched = tuneResultToCard(tune);
      const preferredIndex = resolvePreferredSettingIndex((card as { preferredSetting?: unknown }).preferredSetting, tune.settings);
      if (preferredIndex !== undefined) {
        const abcAttachment = fetched.content.attachments.find(a => a.type === 'file');
        if (abcAttachment && abcAttachment.type === 'file') abcAttachment.preferredIndex = preferredIndex;
      }
    } else if (source === 'irishtuneinfo') {
      fetched = iriTuneToCard(await fetchIriTuneById(id));
    }
    // An externalId naming a source this build doesn't know is not a failure —
    // there is simply nothing to hydrate it with.
    if (!fetched) return card;
    return {
      ...fetched,
      id: card.id,
      guid: card.guid,
      name: card.name || fetched.name,
      tags: [...new Set([...fetched.tags, ...card.tags])],
      content: {
        notes: card.content.notes || fetched.content.notes,
        attachments: [...fetched.content.attachments, ...card.content.attachments],
      },
    };
  });
}

// ── Shared: import a batch of cards from a .cdc package (file or share key) ────
// Dedupes on externalId when present (two independent shares of the same
// TheSession tune land on two different card ids) so the same tune isn't
// re-created — the already-owned card is linked into the target deck instead.

async function importCardPackage(cards: Card[], deckIds: Iterable<string>): Promise<string> {
  let imported = 0;
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

// ── Small shared UI atoms (local to this file — see the top-of-file doc on
// why theSessionImport.tsx and irishTuneInfoImport.tsx each keep their own
// copies rather than sharing one). ────────────────────────────────────────

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
 *  open-time (and whenever `items` changes), portaled to document.body.
 *  Unmounts along with whatever renders it — no manual cleanup needed. */
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

// ── TheSession body ───────────────────────────────────────────────────────────

export interface TheSessionBodyProps {
  ctx: AppContext;
  getTargetDeckIds?: () => Set<string> | undefined;
  onNavigateToCard?: () => void;
  withDeckChoice?: (onReady: () => void) => void;
}

export function TheSessionBody({ ctx, getTargetDeckIds, onNavigateToCard, withDeckChoice = onReady => onReady() }: TheSessionBodyProps) {
  const [tab, setTab] = useState<'tune' | 'member' | 'bookmarks' | 'sets'>('tune');
  const [status, setStatus] = useState<ComponentChild>('');

  const setImportedStatus = (cardId: string, cardName: string) => {
    setStatus(
      <>
        {t('theSession.status.imported', { name: '\x00' }).split('\x00')[0]}
        <span class="text-accent cursor-pointer hover:underline" onClick={() => { ctx.navigate({ view: 'card', cardId }); onNavigateToCard?.(); }}>
          {cardName}
        </span>
        {t('theSession.status.imported', { name: '\x00' }).split('\x00')[1]}
      </>,
    );
  };

  // ── Shared: import a single tune ──────────────────────────────────────────
  const importTune = async (tuneId: number, onSuccess: () => void, setBusy: (b: boolean) => void) => {
    setBusy(true);
    setStatus(t('theSession.status.fetching'));
    try {
      const tune = await fetchTuneById(tuneId);
      const existing = findByExternalId(`thesession:${tune.id}`, appState.value.cards);
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
      setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  /** Shared: import a list of tune IDs (e.g. pasted "1;5;97"), same shape as
   *  the member tunebook batch import below. */
  const importIds = async (
    ids: number[],
    onProgress: (loaded: number, total: number) => void,
    onDone: () => void,
  ): Promise<void> => {
    setStatus(t('theSession.status.fetching'));
    try {
      const existingCardIdByTuneId = buildExistingByTuneId();
      const { tunes, skippedIds, blocked } = await fetchTunesByIds(ids, onProgress, id => existingCardIdByTuneId.has(id));
      const newCards = tunes.map(tune => tuneResultToCard(tune));
      await mutate(s => {
        for (const card of newCards) { s.cards[card.id] = card; }
        const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
        for (const deckId of (getTargetDeckIds?.() ?? [])) {
          const deck = s.decks[deckId]; if (!deck) continue;
          for (const cardId of linkIds) {
            if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        }
      });
      setStatus(batchSummary(newCards.length, skippedIds.length, blocked));
    } catch (e) {
      setStatus(tuneFetchStatus(e, 'theSession.error'));
    } finally {
      onDone();
    }
  };

  return (
    <div class="space-y-3">
      <div class="flex gap-1 p-1 bg-bg rounded-lg">
        <Tab label={t('theSession.tabTune')} active={tab === 'tune'} onClick={() => setTab('tune')} />
        <Tab label={t('theSession.tabMember')} active={tab === 'member'} onClick={() => setTab('member')} />
        <Tab label={t('theSession.tabBookmarks')} active={tab === 'bookmarks'} onClick={() => setTab('bookmarks')} />
        <Tab label={t('theSession.tabSets')} active={tab === 'sets'} onClick={() => setTab('sets')} />
      </div>

      <div class="space-y-3">
        {tab === 'tune' && (
          <TuneTab withDeckChoice={withDeckChoice} setStatus={setStatus} importTune={importTune} importIds={importIds} />
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
  const [suggestions, setSuggestions] = useState<Array<{ id: number; name: string; type: string }>>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  // Kick off the local tune-name index sync as soon as this tab is shown
  // (fire-and-forget) — by the time the user finishes typing, it's usually
  // already resolved. Cheap on every call after the first (see
  // tuneNameIndexService.ts): a single commit-SHA check unless
  // TheSession's tunes.json dump actually changed upstream.
  useEffect(() => { void ensureTuneNameIndex().catch(() => { /* handled per-search below */ }); }, []);

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
        void importIds(ids, (loaded, total) => { setProgress(Math.round((loaded / total) * 100)); setStatus(t('theSession.status.fetchingTunes', { loaded, total })); }, () => {
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
      setInfo(ids.length === 1 ? t('theSession.ids.preview', { count: ids.length }) : t('theSession.ids.previewPlural', { count: ids.length }));
      return;
    }
    if (/^\d+$/.test(trimmed)) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.fetching'));
        try {
          const tune = await fetchTuneById(parseInt(trimmed));
          setPendingId(tune.id); setPendingIds(null);
          setInfo(`${tune.name} · ${tune.type}`);
          setStatus('');
        } catch (e) {
          // 451 is not "no such tune": it exists and was taken down. Calling
          // that "not found" sends the user hunting for a typo they didn't make.
          setStatus(e instanceof TuneUnavailableError ? t('theSession.id.unavailable') : t('theSession.id.notFound'));
        }
      }, 150);
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          let tunes: Array<{ id: number; name: string; type: string }>;
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
            const index = await ensureTuneNameIndex();
            tunes = searchLocalTuneIndex(index, trimmed);
          } catch {
            const remote = await searchTunes(trimmed);
            tunes = sortByRelevance(remote, trimmed);
          }
          setSuggestions(tunes);
          setDropdownOpen(tunes.length > 0);
          setStatus(tunes.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })); }
      }, 300);
    }
  };

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
      <div class="flex gap-2">
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
            if (e.key === 'Escape') setDropdownOpen(false);
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
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={pick}
        renderItem={(tune) => (
          <>
            <div class="flex-1 min-w-0">
              <span class="text-sm text-primary truncate block">{tune.name}</span>
              <span class="text-xs text-dim">{tune.type}</span>
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
  withDeckChoice: (onReady: () => void) => void;
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
  const [, bump] = useState(0);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const showMemberPreview = async (memberId: number) => {
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      const info = await fetchMemberInfo(memberId);
      const isIdSearch = /^\d+$/.test(value.trim());
      const size = t('theSession.member.tuneCount', { n: info.tunebook });
      setInfo(isIdSearch ? `${info.name} · ${size}` : size);
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
      setStatus(memberErrorStatus(e));
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
      await mutate(s => {
        for (const card of newCards) { s.cards[card.id] = card; }
        // Already-owned tunes were skipped above (no re-fetch), but they
        // still belong in the target deck if they were missing there.
        const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
        for (const deckId of (getTargetDeckIds?.() ?? [])) {
          const deck = s.decks[deckId]; if (!deck) continue;
          for (const cardId of linkIds) {
            if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        }
      });
      setProgress(100);
      setStatus(batchSummary(newCards.length, skippedIds.length, blocked));
    } catch (e) {
      setStatus(tuneFetchStatus(e, 'theSession.error'));
    } finally {
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      void showMemberPreview(parseInt(trimmed));
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })); }
      }, 300);
    }
  };

  const pick = (m: MemberSearchResult) => {
    setValue(m.name);
    setDropdownOpen(false);
    void showMemberPreview(m.id);
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
            if (e.key === 'Escape') setDropdownOpen(false);
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => withDeckChoice(() => { void doImportAll(); })}
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
// Same shape as the tunebook tab, with two differences forced by the endpoint.
// Its payload is an activity stream carrying neither `pages` nor `total`, so
// paging stops on the first empty page; and the member page has no bookmark
// counter either (its `settings` field counts settings the member SUBMITTED),
// so unlike the tunebook and the sets there is no size to preview — the count
// only exists once everything has been read.
//
// What makes bookmarks worth their own tab: a bookmark names a SETTING, so each
// tune created here opens on the very version the member starred.

function BookmarksTab({ getTargetDeckIds, withDeckChoice, setStatus }: {
  getTargetDeckIds?: () => Set<string> | undefined;
  withDeckChoice: (onReady: () => void) => void;
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
  const [, bump] = useState(0);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const showMemberPreview = async (memberId: number) => {
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      const found = await fetchMemberInfo(memberId);
      // Only the name: nothing in the member payload counts bookmarks.
      setInfo(found.name);
      selectedMemberIdRef.current = memberId; bump(x => x + 1);
      setStatus('');
    } catch (e) {
      setStatus(memberErrorStatus(e));
      selectedMemberIdRef.current = null; bump(x => x + 1);
    }
  };

  const doImportAll = async () => {
    if (selectedMemberIdRef.current === null) return;
    const memberId = selectedMemberIdRef.current;
    setBusy(true); setProgress(0);
    try {
      // Phase one: read the whole stream. With no total to page towards, the
      // bar cannot be a percentage — the count is the progress.
      const bookmarks = await fetchMemberBookmarks(memberId, (loaded) => {
        setStatus(t('theSession.bookmarks.collecting', { n: loaded }));
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
        setProgress(Math.round(((i + 1) / todo.length) * 100));
        try {
          newCards.push(await buildTuneCardWithSetting(bookmark));
        } catch (e) {
          if (!(e instanceof TuneUnavailableError)) throw e;
          blocked.push({ id: bookmark.tuneId, name: bookmark.name || undefined });
        }
      }

      await mutate(s => {
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
      setStatus(batchSummary(newCards.length, skipped, blocked));
    } catch (e) {
      setStatus(e instanceof MemberUnavailableError ? memberErrorStatus(e) : tuneFetchStatus(e, 'theSession.error'));
    } finally {
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      void showMemberPreview(parseInt(trimmed));
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })); }
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
            if (e.key === 'Escape') setDropdownOpen(false);
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => withDeckChoice(() => { void doImportAll(); })}
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
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={(m) => { setValue(m.name); setDropdownOpen(false); void showMemberPreview(m.id); setStatus(''); }}
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
  withDeckChoice: (onReady: () => void) => void;
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
  const [, bump] = useState(0);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  /** One cheap request that answers "does this member exist, and is there
   *  anything to page through" before any paging begins. */
  const showMemberPreview = async (memberId: number) => {
    selectedMemberIdRef.current = null; bump(x => x + 1);
    setInfo('');
    setStatus(t('theSession.status.fetching'));
    try {
      const found = await fetchMemberInfo(memberId);
      const isIdSearch = /^\d+$/.test(value.trim());
      const size = t('theSession.sets.count', { n: found.sets });
      setInfo(isIdSearch ? `${found.name} · ${size}` : size);
      // A member with no sets is an ordinary account, not an error — say so and
      // leave nothing to press.
      if (found.sets === 0) { setStatus(t('theSession.sets.none')); return; }
      selectedMemberIdRef.current = memberId; bump(x => x + 1);
      setStatus('');
    } catch (e) {
      setStatus(memberErrorStatus(e));
      selectedMemberIdRef.current = null; bump(x => x + 1);
    }
  };

  const doImportAll = async () => {
    if (selectedMemberIdRef.current === null) return;
    const memberId = selectedMemberIdRef.current;
    setBusy(true); setProgress(0);
    let created = 0, imported = 0, skipped = 0;
    try {
      // Phase one: the listing, which for a prolific member runs to dozens of
      // pages (539 sets over 54 requests for member 1) — hence a progress bar
      // rather than a silent wait.
      const sets = await fetchMemberSets(memberId, (loaded, total) => {
        setProgress(Math.round((loaded / total) * 50));
        setStatus(t('theSession.sets.loading', { loaded, total }));
      });

      // Phase two: one set at a time.
      for (let i = 0; i < sets.length; i++) {
        const set = sets[i]!;
        setProgress(50 + Math.round((i / sets.length) * 50));

        // A set already in the library is SKIPPED, exactly as an already-owned
        // tune is: an import never rewrites an existing card, it only files it
        // into the chosen decks. Bringing a set back in line with TheSession is
        // a separate, deliberate act — "Refresh tunes" on its source pin. The
        // check comes before any fetch, so a skipped set costs no network.
        const already = findByExternalId(setExternalId(set.memberId, set.id), appState.value.cards);
        if (already) {
          skipped++;
          await mutate(s => {
            for (const deckId of (getTargetDeckIds?.() ?? [])) {
              const deck = s.decks[deckId]; if (!deck) continue;
              if (!deck.entries.some(e => e.cardId === already.id)) deck.entries.push({ cardId: already.id });
            }
          });
          continue;
        }

        setStatus(t('theSession.sets.importing', { name: set.name, n: i + 1, total: sets.length }));
        // The live cards map is re-read each time so a tune created for an
        // earlier set in this same batch is reused, not fetched twice.
        const { setCard, newTunes } = await buildSetCards(set, appState.value.cards, defaultTuneRepeat(appState.value));
        created += newTunes.length;
        imported++;
        await mutate(s => {
          for (const tune of newTunes) s.cards[tune.id] = tune;
          s.cards[setCard.id] = setCard;
          // The deck choice applies to the SET — that is what was imported.
          // Tunes created along the way land in the library with no deck; they
          // are reachable from the set, and each shows it under "played in
          // these sets". Filing them is the user's call, later or never.
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            if (!deck.entries.some(e => e.cardId === setCard.id)) deck.entries.push({ cardId: setCard.id });
          }
        });
      }
      setProgress(100);
      setStatus(
        t('theSession.sets.done', { sets: imported, tunes: created })
        + (skipped > 0 ? t('theSession.sets.doneSkipped', { count: skipped }) : ''),
      );
    } catch (e) {
      setStatus(tuneFetchStatus(e, 'theSession.error'));
    } finally {
      setBusy(false);
    }
  };

  const onInputChange = (val: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setValue(val);
    setInfo(''); selectedMemberIdRef.current = null; bump(x => x + 1);
    setSuggestions([]); setDropdownOpen(false); setStatus('');
    const trimmed = val.trim();
    if (!trimmed) return;
    if (/^\d+$/.test(trimmed)) {
      void showMemberPreview(parseInt(trimmed));
    } else if (trimmed.length >= 2) {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null; setStatus(t('theSession.status.searching'));
        try {
          const members = await searchMembers(trimmed);
          const sorted = sortByRelevance(members, trimmed);
          setSuggestions(sorted);
          setDropdownOpen(sorted.length > 0);
          setStatus(sorted.length ? '' : t('theSession.noResults'));
        } catch (e) { setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) })); }
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
            if (e.key === 'Escape') setDropdownOpen(false);
            if (e.key === 'Enter' && selectedMemberIdRef.current !== null) void doImportAll();
          }}
        />
        <button
          class="btn-primary text-xs shrink-0"
          disabled={busy || selectedMemberIdRef.current === null}
          onClick={() => withDeckChoice(() => { void doImportAll(); })}
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
        anchorRef={inputRef}
        items={suggestions}
        open={dropdownOpen}
        onPick={(m) => { setValue(m.name); setDropdownOpen(false); void showMemberPreview(m.id); setStatus(''); }}
        renderItem={(m) => <span class="text-sm text-primary truncate">{m.name}</span>}
      />
    </>
  );
}

// ── New Card modal (hierarchical flow) ─────────────────────────────────────────

type Step = 'root' | 'create' | 'import' | 'thesession' | 'irishtuneinfo' | 'json' | 'json-file' | 'share' | 'ai';

const BACK_PARENT: Partial<Record<Step, Step>> = {
  create: 'root', import: 'root',
  thesession: 'import', irishtuneinfo: 'import', json: 'import',
  'json-file': 'json', share: 'json', ai: 'json',
};

function ChoiceCard({ icon, label, desc, accentColor, onClick }: {
  icon: string; label: string; desc: string; accentColor: string; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      class="flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer"
      style={{ transition: 'border-color 0.15s, background 0.15s', borderColor: hover ? accentColor : undefined, background: hover ? `${accentColor}12` : undefined }}
      title={desc}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      <span class="shrink-0 flex items-center" style={{ color: accentColor }} dangerouslySetInnerHTML={{ __html: icon }} />
      <div class="flex-1 text-sm font-medium text-primary">{label}</div>
      <span class="text-dim text-base leading-none shrink-0">›</span>
    </button>
  );
}

const ICON_CREATE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_IMPORT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const ICON_TS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const ICON_ITI = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const ICON_JSON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const ICON_SHARE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
const ICON_AI = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`;

function RootStep({ navigate }: { navigate: (s: Step) => void }) {
  return (
    <>
      <ChoiceCard icon={ICON_CREATE} label={t('newCard.tabCreate')} desc={t('newCard.createDesc')} accentColor="var(--color-accent)" onClick={() => navigate('create')} />
      <ChoiceCard icon={ICON_IMPORT} label={t('newCard.tabImport')} desc={t('newCard.importDesc')} accentColor="var(--color-warn)" onClick={() => navigate('import')} />
    </>
  );
}

function CreateStep({ withDeckChoice, ensureSelectedDeckIds, onOpenCard }: {
  withDeckChoice: (onReady: () => void) => void;
  ensureSelectedDeckIds: () => Set<string>;
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
      for (const deckId of ensureSelectedDeckIds()) { // doCreate only ever runs via withDeckChoice, which guarantees this
        const deck = s.decks[deckId];
        if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
      }
    });
    setStatus(
      <>
        {t('newCard.create.done', { name: '\x00' }).split('\x00')[0]}
        <span class="text-accent cursor-pointer hover:underline" onClick={() => onOpenCard(createdId)}>{trimmed}</span>
        {t('newCard.create.done', { name: '\x00' }).split('\x00')[1]}
      </>,
    );
  };

  return (
    <>
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
      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </>
  );
}

function ImportStep({ navigate }: { navigate: (s: Step) => void }) {
  return (
    <>
      <ChoiceCard icon={ICON_TS}   label={t('newCard.tabTheSession')}    desc={t('newCard.theSessionDesc')}    accentColor="var(--color-success)" onClick={() => navigate('thesession')} />
      <ChoiceCard icon={ICON_ITI}  label={t('newCard.tabIrishTuneInfo')} desc={t('newCard.irishTuneInfoDesc')} accentColor="var(--color-accent)"  onClick={() => navigate('irishtuneinfo')} />
      <ChoiceCard icon={ICON_JSON} label={t('newCard.tabImportJson')}    desc={t('newCard.importJsonDesc')}    accentColor="var(--color-warn)"    onClick={() => navigate('json')} />
    </>
  );
}

function JsonStep({ navigate }: { navigate: (s: Step) => void }) {
  return (
    <>
      <ChoiceCard icon={ICON_JSON}  label={t('library.export.file')} desc={t('newCard.importJsonDesc')} accentColor="var(--color-warn)"    onClick={() => navigate('json-file')} />
      <ChoiceCard icon={ICON_SHARE} label={t('newCard.share.label')} desc={t('newCard.share.desc')}     accentColor="var(--color-accent)"  onClick={() => navigate('share')} />
      <ChoiceCard icon={ICON_AI}    label={t('newCard.tabAi')}       desc={t('newCard.aiDesc')}         accentColor="var(--color-success)" onClick={() => navigate('ai')} />
    </>
  );
}

function JsonFileStep({ ensureSelectedDeckIds, withDeckChoice }: {
  ensureSelectedDeckIds: () => Set<string>;
  withDeckChoice: (onReady: () => void) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const doImportFile = async (file: File) => {
    setBusy(true); setStatus(t('newCard.import.importing'));
    try {
      const cards = await parseCardPackage(file);
      setStatus(await importCardPackage(cards, ensureSelectedDeckIds()));
    } catch (e) {
      setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally { setBusy(false); }
  };

  return (
    <>
      <button
        class="btn-primary w-full text-sm"
        disabled={busy}
        onClick={() => {
          const fileInp = document.createElement('input'); fileInp.type = 'file'; fileInp.accept = '.cdc';
          fileInp.onchange = () => {
            const file = fileInp.files?.[0]; if (!file) return;
            withDeckChoice(() => { void doImportFile(file); });
          };
          fileInp.click();
        }}
      >
        {t('newCard.import.pick')}
      </button>
      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </>
  );
}

function ShareStep({ ensureSelectedDeckIds, withDeckChoice }: {
  ensureSelectedDeckIds: () => Set<string>;
  withDeckChoice: (onReady: () => void) => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const doImport = async () => {
    const trimmed = key.trim();
    if (trimmed.length !== 6) return;
    setBusy(true); setStatus(t('newCard.import.importing'));
    try {
      const text = await downloadShare(trimmed);
      const file = new File([text], `share-${trimmed}.cdc`, { type: 'application/octet-stream' });
      const cards = await parseCardPackage(file);
      setStatus(await importCardPackage(cards, ensureSelectedDeckIds()));
    } catch (e) {
      setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally { setBusy(false); }
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
          onKeyDown={(e) => { if (e.key === 'Enter') withDeckChoice(() => { void doImport(); }); }}
        />
        <button class="btn-primary text-xs shrink-0" disabled={busy || key.trim().length !== 6} onClick={() => withDeckChoice(() => { void doImport(); })}>
          {t('newCard.share.importBtn')}
        </button>
      </div>
      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </>
  );
}

function AiStep({ ensureSelectedDeckIds, withDeckChoice }: {
  ensureSelectedDeckIds: () => Set<string>;
  withDeckChoice: (onReady: () => void) => void;
}) {
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);

  const doImportPasted = async () => {
    setBusy(true);
    setStatus(t('newCard.import.importing'));
    try {
      const cards = parseCardPackageFromText(pasted);
      const toHydrate = cards.filter(c => c.externalId);
      const hydrated: Card[] = cards.filter(c => !c.externalId);
      // All-or-nothing, like every other batch path: the first tune that won't
      // fetch aborts the whole paste and nothing reaches the library. A
      // half-imported package is the worse outcome — the user can't tell which
      // half they got, and re-pasting would then double up what did land.
      for (let i = 0; i < toHydrate.length; i++) {
        if (toHydrate.length > 1) setStatus(t('theSession.status.fetchingTunes', { loaded: i, total: toHydrate.length }));
        hydrated.push(await hydrateExternalCard(toHydrate[i]!));
      }
      setStatus(await importCardPackage(hydrated, ensureSelectedDeckIds()));
    } catch (e) {
      setStatus(tuneFetchStatus(e, 'theSession.error'));
    } finally { setBusy(false); }
  };

  return (
    <>
      <p class="text-xs text-muted leading-relaxed">{t('newCard.ai.intro')}</p>
      <pre class="text-[11px] font-mono text-primary/80 bg-bg border border-border rounded-lg p-3 max-h-48 overflow-y-auto whitespace-pre-wrap">{AI_IMPORT_PROMPT}</pre>
      <button
        class="btn-primary w-full text-sm"
        onClick={() => {
          void navigator.clipboard.writeText(AI_IMPORT_PROMPT);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? t('newCard.ai.copied') : t('newCard.ai.copy')}
      </button>
      <label class="label">{t('newCard.ai.pasteLabel')}</label>
      <textarea
        class="input text-xs font-mono min-h-[6rem] resize-y"
        placeholder={t('newCard.ai.pastePlaceholder')}
        value={pasted}
        onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)}
      />
      <button class="btn-primary w-full text-sm" disabled={busy || !pasted.trim()} onClick={() => withDeckChoice(() => { void doImportPasted(); })}>
        {t('newCard.ai.pasteBtn')}
      </button>
      <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>
    </>
  );
}

function NewCardModal({ ctx, initialDeckIds, onClose }: { ctx: AppContext; initialDeckIds?: string[]; onClose: () => void }) {
  const [step, setStep] = useState<Step>('root');
  const selectedDeckIdsRef = useRef<Set<string> | undefined>(initialDeckIds ? new Set(initialDeckIds) : undefined);
  const deckSelectorOpenRef = useRef(false);
  const [, bump] = useState(0);

  const ensureSelectedDeckIds = (): Set<string> => {
    if (!selectedDeckIdsRef.current) selectedDeckIdsRef.current = new Set();
    return selectedDeckIdsRef.current;
  };

  const showDeckSelector = () => {
    deckSelectorOpenRef.current = true;
    const ids = ensureSelectedDeckIds();
    bump(x => x + 1);
    showDeckPickerPopover(ids, () => bump(x => x + 1), () => { deckSelectorOpenRef.current = false; });
  };

  /** Gate for every creation/import trigger: the first one ever clicked
   *  forces a deliberate deck choice (or explicit "none") before anything is
   *  created — `onReady` runs immediately if already chosen, else once the
   *  forced picker closes (no second click needed). */
  const withDeckChoice = (onReady: () => void): void => {
    if (selectedDeckIdsRef.current !== undefined) { onReady(); return; }
    deckSelectorOpenRef.current = true;
    const ids = ensureSelectedDeckIds();
    bump(x => x + 1);
    showDeckPickerPopover(ids, () => bump(x => x + 1), () => { deckSelectorOpenRef.current = false; onReady(); });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !deckSelectorOpenRef.current) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, []);

  const TITLES: Record<Step, string> = {
    root:         t('newCard.title'),
    create:       t('newCard.tabCreate'),
    import:       t('newCard.tabImport'),
    thesession:   t('newCard.tabTheSession'),
    irishtuneinfo: t('newCard.tabIrishTuneInfo'),
    json:         t('newCard.tabImportJson'),
    'json-file':  t('newCard.tabImportJson'),
    share:        t('newCard.tabImportJson'),
    ai:           t('newCard.tabAi'),
  };

  const onOpenCard = (cardId: string) => { ctx.navigate({ view: 'card', cardId }); onClose(); };

  const ids = selectedDeckIdsRef.current;
  const deckSuffix = ids === undefined ? ' (?)' : ids.size > 0 ? ` (${ids.size})` : '';

  const mouseDownOnOverlay = useRef(false);

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onClose(); }}
    >
      <div
        class="bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col"
        style={{ maxWidth: `min(440px, ${modalMaxW(0.9)})`, maxHeight: modalMaxH(0.85) }}
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            {step !== 'root' && (
              <button class="text-dim hover:text-primary transition-colors cursor-pointer shrink-0" onClick={() => setStep(BACK_PARENT[step] ?? 'root')}>←</button>
            )}
            <h2 class="text-sm font-semibold text-primary truncate">{TITLES[step]}</h2>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <button
              class={`inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${
                ids === undefined ? 'text-warn hover:text-primary' : ids.size > 0 ? 'text-accent' : 'text-dim hover:text-primary'
              }`}
              title={t('newCard.selectDecks')}
              dangerouslySetInnerHTML={{ __html: `${deckLinkIcon}${deckSuffix}` }}
              onClick={showDeckSelector}
            />
            <button class="text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0" onClick={onClose}>✕</button>
          </div>
        </div>

        <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto">
          {step === 'root' && <RootStep navigate={setStep} />}
          {step === 'create' && <CreateStep withDeckChoice={withDeckChoice} ensureSelectedDeckIds={ensureSelectedDeckIds} onOpenCard={onOpenCard} />}
          {step === 'import' && <ImportStep navigate={setStep} />}
          {step === 'thesession' && <TheSessionBody ctx={ctx} getTargetDeckIds={() => selectedDeckIdsRef.current} onNavigateToCard={onClose} withDeckChoice={withDeckChoice} />}
          {step === 'irishtuneinfo' && <IrishTuneInfoBody ctx={ctx} getTargetDeckIds={() => selectedDeckIdsRef.current} onNavigateToCard={onClose} withDeckChoice={withDeckChoice} />}
          {step === 'json' && <JsonStep navigate={setStep} />}
          {step === 'json-file' && <JsonFileStep ensureSelectedDeckIds={ensureSelectedDeckIds} withDeckChoice={withDeckChoice} />}
          {step === 'share' && <ShareStep ensureSelectedDeckIds={ensureSelectedDeckIds} withDeckChoice={withDeckChoice} />}
          {step === 'ai' && <AiStep ensureSelectedDeckIds={ensureSelectedDeckIds} withDeckChoice={withDeckChoice} />}
        </div>
      </div>
    </div>
  );
}

export function showNewCardModal(ctx: AppContext, initialDeckIds?: string[]): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const close = () => { render(null, host); host.remove(); };
  render(<NewCardModal ctx={ctx} initialDeckIds={initialDeckIds} onClose={close} />, host);
}
