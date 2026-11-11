import { useState } from 'preact/hooks';
import type { AppContext, AppState, Card } from '../../types';
import { t } from '../../services/i18nService';
import { PlusIcon, AddClipIcon, ClipAttachedIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { showDeckChoiceModal, decksContainingCard, isInEveryDeck, deckAddIcon } from '../../components/deckSelector';
import { fileToEntry, downloadBlob, generateId } from '../../utils';
import { attachmentFor, uploadAttachmentSoon, condemnAttachmentFile } from '../../services/attachmentStore';
import { tunesetAbcPlaceholder, addTunesetAbcOnConvert, defaultTuneRepeat } from '../../services/abcService';
import { retargetedHistory } from '../../services/reviewEntries';
import { extractClip } from '../audio/clipExtract';
import { getContext } from '../../store';
import { detectionReviewId, reviewEntryTs } from '../reviewLink';
import { cardsByTuneId, setCardFor } from '../tunesets';
import { buildTunesetCard } from '../../services/tunesetCard';
import { fmtTime, type ClipSessionRef, type PreparedClip } from './sessionUiShared';
import { hasLibrary } from '../../services/pageMode';

// ── What a set heard in an analysis can be put through (2026-10-19) ──────────
// The set's own twins of the detection's clip, rating and deck controls
// (sessionUiShared.tsx). Same rules, one difference that runs through all of
// them: the card they act on is the SET card — the one made of exactly these
// tunes in exactly this order (tunesets.ts's setCardFor) — never a tune's.

export interface Span { start: number; end: number }

/** An attached clip's identity — the same shape as a detection's (session id
 *  fragment + start second): it lives on a different card, so the two never meet. */
function setClipKey(session: ClipSessionRef, span: Span): string {
  return `${session.id.slice(0, 8)}·${Math.round(span.start)}`;
}

function setClipFileName(session: ClipSessionRef, setName: string, span: Span, extension: string): string {
  const range = `${fmtTime(span.start)}–${fmtTime(span.end)}`.replace(/:/g, 'm');
  return `${setName} — ${session.name} (${range}).${extension}`;
}

export function isSetClipAttached(session: ClipSessionRef, setCard: Card | undefined, span: Span): boolean {
  if (!setCard) return false;
  const key = setClipKey(session, span);
  return setCard.content.attachments.some(a => a.type === 'file' && a.clipOf === key);
}

/** Cuts the whole set out of the recording and attaches it to the set card. */
export async function attachSetClip(
  ctx: AppContext,
  session: ClipSessionRef,
  setCardId: string,
  span: Span,
  audio: Blob,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const setCard = getContext().user.cards[setCardId];
  if (!setCard || isSetClipAttached(session, setCard, span)) return;
  const prepared = await prepareSetClip(session, setCard, span, audio, onProgress);
  let filed = false;
  await ctx.mutate(s => { filed = fileSetClip(s, setCardId, prepared); });
  if (filed) uploadAttachmentSoon(prepared.att);
}

/** attachSetClip's first half — the set's twin of prepareClip
 *  (sessionUiShared.tsx), for a batch that files every clip in one write. */
export async function prepareSetClip(
  session: ClipSessionRef,
  setCard: Card,
  span: Span,
  audio: Blob,
  onProgress?: (ratio: number) => void,
): Promise<PreparedClip> {
  const clip = await extractClip(audio, span.start, span.end, onProgress);
  const entry = await fileToEntry(new File([clip.blob], setClipFileName(session, setCard.name, span, clip.extension), { type: clip.blob.type }));
  return { att: await attachmentFor(entry, getContext().user), clipOf: setClipKey(session, span) };
}

/** attachSetClip's second half, inside a recipe. Whether it filed the clip. */
export function fileSetClip(s: AppState, setCardId: string, prepared: PreparedClip): boolean {
  const card = s.cards[setCardId];
  if (!card || card.content.attachments.some(a => a.type === 'file' && a.clipOf === prepared.clipOf)) return false;
  card.content.attachments.push({ ...prepared.att, clipOf: prepared.clipOf });
  return true;
}

/** Re-cuts the set's clip after a bound of one of its tunes moved the set's
 *  span — silent, as a detection's own re-cut is (sessionUiShared's
 *  recutAttachedClip), and for the same reason: the clip promises the span. */
export async function recutSetClip(
  ctx: AppContext,
  session: ClipSessionRef,
  setCardId: string,
  previous: Span,
  span: Span,
  audio: Blob,
): Promise<boolean> {
  const card = getContext().user.cards[setCardId];
  if (!card) return false;
  const oldKey = setClipKey(session, previous);
  const existing = card.content.attachments.find(a => a.type === 'file' && a.clipOf === oldKey);
  if (!existing || existing.type !== 'file') return false;
  const oldExt = existing.name.split('.').pop() ?? '';
  const wasDefaultName = existing.name === setClipFileName(session, card.name, previous, oldExt);

  const clip = await extractClip(audio, span.start, span.end);
  const name = wasDefaultName ? setClipFileName(session, card.name, span, clip.extension) : existing.name;
  const entry = await fileToEntry(new File([clip.blob], name, { type: clip.blob.type }));
  const att = await attachmentFor(entry, getContext().user);
  let replaced = false;
  await ctx.mutate(s => {
    const target = s.cards[setCardId];
    if (!target) return;
    const i = target.content.attachments.findIndex(a => a.type === 'file' && a.clipOf === oldKey);
    if (i === -1) return;
    target.content.attachments[i] = { ...att, clipOf: setClipKey(session, span) };
    replaced = true;
  });
  if (replaced) {
    void condemnAttachmentFile(existing);
    uploadAttachmentSoon(att);
  }
  return replaced;
}

/** Where a set's rating is filed: under the set's own id in the analysis's
 *  table, at the instant the set ended. Same shape as a detection's
 *  (reviewLink.ts) — the set's id is a UUID too — so deleting the analysis
 *  finds and releases it exactly as it does a tune's. */
export function setReviewId(sessionId: string, tunesetId: string): string {
  return detectionReviewId(sessionId, tunesetId);
}

/** Follows the set's rating to where the set now ends, or to a new date. */
export async function repinSetReview(
  ctx: AppContext,
  setCardId: string,
  reviewId: string,
  from: { startMs: number; end: number },
  to: { startMs: number; end: number },
): Promise<boolean> {
  const fromTs = reviewEntryTs(from.startMs, from.end);
  const toTs = reviewEntryTs(to.startMs, to.end);
  if (fromTs === toTs) return false;
  let changed = false;
  await ctx.mutate(s => {
    const work = s.cardWorks[`${s.currentProfileId}:${setCardId}`];
    if (!work) return;
    const history = retargetedHistory(work.history, reviewId, fromTs, { id: reviewId, ts: toTs });
    if (!history) return;
    work.history = history;
    changed = true;
  });
  return changed;
}

/** Download the whole set as one file, and attach it to the set card. */
export function SetClipControls({ session, setCard, span, audioAvailable, getAudio, ctx, onAttached, disabled }: {
  session: ClipSessionRef;
  setCard: Card | undefined;
  span: Span;
  audioAvailable: boolean;
  getAudio: () => Promise<Blob | undefined>;
  ctx: AppContext;
  onAttached?: () => void;
  /** The set is still being decoded: nothing is cut from a guess. */
  disabled?: boolean;
}) {
  const [downloadTitle, setDownloadTitle] = useState(t('sessions.set.downloadClip'));
  const [downloading, setDownloading] = useState(false);
  /** As ClipControls' (sessionUiShared.tsx): the reason a download failed,
   *  which the tooltip lost to the `finally` straight away. */
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [attachText, setAttachText] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  /** An explicit failure, where the text was tested for a leading ⚠. */
  const [attachError, setAttachError] = useState<string | null>(null);
  const already = isSetClipAttached(session, setCard, span);
  const failed = attachError !== null;

  const doDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      const clip = await extractClip(audio, span.start, span.end, r => setDownloadTitle(t('sessions.extracting', { pct: Math.round(r * 100) })));
      downloadBlob(clip.blob, setClipFileName(session, setCard?.name ?? t('sessions.set.label'), span, clip.extension));
    } catch (err) {
      setDownloadError(String(err));
    } finally {
      setDownloading(false);
      setDownloadTitle(t('sessions.set.downloadClip'));
    }
  };

  const doAttach = async () => {
    if (!setCard) return;
    setAttaching(true);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      await attachSetClip(ctx, session, setCard.id, span, audio, r => setAttachText(t('sessions.extracting', { pct: Math.round(r * 100) })));
      setAttachText(null);
      setAttaching(false);
      onAttached?.();
    } catch (err) {
      setAttachText(null);
      setAttachError(String(err));
    }
  };

  const canAttach = !!setCard && !disabled && audioAvailable;
  return (
    <>
      {audioAvailable && (
        <button
          class="icon-btn hover:text-accent disabled:hover:text-dim"
          title={downloadTitle}
          aria-label={t('sessions.set.downloadClip')}
          disabled={downloading || disabled}
          dangerouslySetInnerHTML={{ __html: downloadIcon(14) }}
          onClick={() => { void doDownload(); }}
        />
      )}
      {downloadError && <span class="text-2xs text-danger">{downloadError}</span>}
      {(already || audioAvailable) && (
        <button
          class={`icon-btn ${
            already ? 'text-success hover:text-success hover:bg-transparent cursor-default'
              : failed ? 'text-danger hover:text-danger px-1 disabled:opacity-100 cursor-default'
              : canAttach ? `text-accent ${attaching ? 'cursor-default' : 'hover:text-accent/70'}`
              : 'text-accent'}`}
          title={already ? t('sessions.set.attached') : !setCard ? t('sessions.set.attachNeedsCard') : attachError ?? attachText ?? t('sessions.set.attach')}
          aria-label={already ? t('sessions.set.attached') : t('sessions.set.attach')}
          disabled={!already && (!canAttach || attaching)}
          onClick={already ? undefined : () => { void doAttach(); }}
        >
          {already ? <ClipAttachedIcon size={14} />
            : failed ? <span class="text-2xs">{attachError}</span>
            : attachText ? <span class="text-2xs font-mono tabular-nums">{attachText}</span>
            : <AddClipIcon size={14} />}
        </button>
      )}
    </>
  );
}

/** Files the set card in decks, or creates it — the set's twin of the tune's
 *  TuneDeckButton. Creating needs a card for every tune first (a set is made
 *  of cards); until then the + LOOKS disabled but still answers a tap, with
 *  the reason, which a phone has no tooltip to give (the user's rule,
 *  2026-10-19: the reason only on demand). */
export function TunesetDeckButton({ tuneIds, setCard, settled, ctx, getPinnedDeckIds, onChanged, onExplain, byTune: givenByTune }: {
  tuneIds: string[];
  setCard: Card | undefined;
  /** Still being decoded: nothing to create from yet. */
  settled: boolean;
  ctx: AppContext;
  getPinnedDeckIds?: () => Set<string>;
  onChanged?: () => void;
  /** Asked to say why the + does nothing — the names of the missing tunes. */
  onExplain: (missing: string[] | null) => void;
  /** `cardsByTuneId` of the cards, from a list drawing one button per row:
   *  rebuilt by every button, it cost seconds per click (bench, 2026-11-10). */
  byTune?: ReadonlyMap<string, Card>;
}) {
  const [busy, setBusy] = useState(false);
  // A 24 px disc drawn inside a 32 px target (styles.css, .icon-disc).
  const round = 'group icon-btn hover:bg-transparent';

  // The standalone analyser has no library to file a set in (pageMode.ts).
  if (!hasLibrary()) return null;
  if (setCard) {
    const everyDeck = isInEveryDeck(setCard.id);
    const label = everyDeck ? t('deckChoice.inEveryDeck') : t('sessions.linkToDeck');
    return (
      <button
        class={`${round} ${everyDeck ? 'opacity-40' : ''}`}
        title={label}
        aria-label={label}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          showDeckChoiceModal({
            pinned: getPinnedDeckIds?.() ?? new Set(),
            alreadyIn: decksContainingCard(setCard.id),
            onConfirm: (deckIds) => {
              setBusy(true);
              void ctx.mutate(s => {
                for (const deckId of deckIds) {
                  const deck = s.decks[deckId];
                  if (deck && !deck.entries.some(e => e.cardId === setCard.id)) deck.entries.push({ cardId: setCard.id });
                }
              }).finally(() => { setBusy(false); onChanged?.(); });
            },
          });
        }}
      >
        <span class="icon-disc" dangerouslySetInnerHTML={{ __html: deckAddIcon }} />
      </button>
    );
  }

  const byTune = givenByTune ?? cardsByTuneId(getContext().user.cards);
  const missing = tuneIds.filter(id => !byTune.has(id));
  const ready = settled && missing.length === 0;

  const create = (deckIds: string[]) => {
    setBusy(true);
    void ctx.mutate(s => {
      // Re-checked inside the write: the same set can have been created by
      // another route — another analysis, another device — meanwhile.
      const existing = setCardFor(tuneIds, s.cards);
      let id = existing?.id;
      if (!existing) {
        const map = cardsByTuneId(s.cards);
        const tunes = tuneIds.map(x => map.get(x)).filter((c): c is Card => !!c);
        if (tunes.length !== tuneIds.length) return;
        const card = buildTunesetCard(tunes, {
          defaultRepeat: defaultTuneRepeat(s),
          attachments: addTunesetAbcOnConvert(s) ? [tunesetAbcPlaceholder()] : [],
          newId: generateId,
        });
        s.cards[card.id] = card;
        id = card.id;
      }
      for (const deckId of deckIds) {
        const deck = s.decks[deckId];
        if (deck && id && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
      }
    }).finally(() => { setBusy(false); onChanged?.(); });
  };

  return (
    <button
      class={`${round} ${ready ? '' : 'opacity-40 cursor-default'}`}
      title={t('sessions.set.create')}
      aria-label={t('sessions.set.create')}
      aria-disabled={!ready}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        if (!ready) { onExplain(settled ? missing : null); return; }
        showDeckChoiceModal({ pinned: getPinnedDeckIds?.() ?? new Set(), onConfirm: create });
      }}
    >
      <span class="icon-disc"><PlusIcon size={12} /></span>
    </button>
  );
}
