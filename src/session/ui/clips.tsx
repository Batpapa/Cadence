import { useState } from 'preact/hooks';
import { cardOfTuneId } from '../detections';
import type { AppContext, AppState, FileAttachment } from '../../types';
import { t } from '../../services/i18nService';
import { AddClipIcon, ClipAttachedIcon } from '../../components/icons';
import { downloadIcon } from '../../components/playbackIcons';
import { fileToEntry, downloadBlob } from '../../services/fileTransfer';
import { attachmentFor, uploadAttachmentSoon, condemnAttachmentFile } from '../../services/attachmentStore';
import { extractClip } from '../audio/clipExtract';
import { legacyClipTag } from '../../services/attachmentNames';
import { getContext } from '../../store';
import type { Detection } from '../model';
import { tuneName } from './tuneNames';
import { fmtTime } from './sessionUiShared';

// ── A detection's passage, cut and put on its tune's card ────────────────────
// The helpers and the controls. Out of sessionUiShared.tsx since 2026-11-26.

/** The subset of Analysis the clip-extraction helpers actually need —
 *  lets a still-in-progress LiveSession/ImportSession (no Analysis row
 *  saved yet) build a lightweight literal instead. */
export interface ClipSessionRef {
  id: string;
  name: string;
  date: string | null;
  duration: number;
}

/** Stable identity of a clip — session id fragment + start second, so it
 *  survives session renames and detection relabels. What an attached clip
 *  stores in `clipOf` (see the Attachment type); it lived in the file name
 *  until schema V8. */
function clipKey(session: ClipSessionRef, ann: Detection): string {
  return `${session.id.slice(0, 8)}·${Math.round(ann.start)}`;
}

/** `extension` is the clip's own (see ExtractedClip): a clip keeps the
 *  recording's container, so the name cannot assume one.
 *
 *  The tune is named as the screen names it (tuneName), never by the raw
 *  `displayName`: that one comes from the recognition index, lowercased, and
 *  used to put "the silver spear" in the file next to "The Silver Spear" on the
 *  card.
 *
 *  No identifying tag in it any more: an attached clip is recognised by its
 *  `clipOf` field (2026-09-15), so the name is only what a person reads. */
export function clipFileName(session: ClipSessionRef, ann: Detection, extension: string): string {
  const sessionName = session.name;
  const range = `${fmtTime(ann.start)}–${fmtTime(ann.end ?? session.duration)}`.replace(/:/g, 'm');
  return `${tuneName(ann).text} — ${sessionName} (${range}).${extension}`;
}

/** True when this exact clip is already attached, whatever it was renamed to.
 *  The name is still read as a fallback: a device on an older build keeps
 *  writing the tag there, and a card synced from it has no `clipOf`. */
export function isClipAttached(session: ClipSessionRef, ann: Detection): boolean {
  const card = cardOfTuneId(ann.tuneId, getContext().user.cards);
  if (!card) return false;
  const key = clipKey(session, ann);
  return card.content.attachments.some(a => a.type === 'file' && (a.clipOf === key || legacyClipTag(a.name)?.key === key));
}

/** A clip cut and stored, not yet on its card. */
export interface PreparedClip { att: FileAttachment; clipOf: string }

/** attachClip's first half: cuts the detection's passage and builds its
 *  attachment, without touching the state — so a batch can cut a hundred and
 *  file them in ONE write (TuneRankingPanel's attachClips). An external file
 *  is already stored locally by then; one that never gets filed is left to
 *  the local sweep, as an import's skipped duplicate is (attachmentStore.ts). */
export async function prepareClip(
  session: ClipSessionRef,
  ann: Detection,
  audio: Blob,
  onProgress?: (ratio: number) => void,
): Promise<PreparedClip> {
  const clip = await extractClip(audio, ann.start, ann.end ?? session.duration, onProgress);
  const entry = await fileToEntry(new File([clip.blob], clipFileName(session, ann, clip.extension), { type: clip.blob.type }));
  // A clip is the biggest thing this app attaches by itself — the ten that
  // dominated one real library were nearly all clips — so it goes through the
  // same rule as a hand-picked file (services/attachmentStore.ts).
  return { att: await attachmentFor(entry, getContext().user), clipOf: clipKey(session, ann) };
}

/** attachClip's second half, inside a recipe: puts the clip on its tune's
 *  card unless that card is gone or already holds it. Whether it did. */
export function fileClip(s: AppState, tuneId: string, prepared: PreparedClip): boolean {
  const card = cardOfTuneId(tuneId, s.cards);
  if (!card || card.content.attachments.some(a => a.type === 'file' && a.clipOf === prepared.clipOf)) return false;
  card.content.attachments.push({ ...prepared.att, clipOf: prepared.clipOf });
  return true;
}

/** Extracts the detection's audio slice as a standalone file, in the
 *  recording's own format, and attaches it to the card — independent from the
 *  session file. `audio` is already
 *  resolved by the caller (loadSessionAudio for a saved session, or a
 *  lazily-assembled Blob for a still-in-progress live/import one — see
 *  ClipControls below). */
export async function attachClip(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
  audio: Blob,
  onProgress?: (ratio: number) => void,
): Promise<boolean> {
  // getContext(): ctx.user is a snapshot from modal-open time — cards added
  // since (e.g. via "Add to Cadence" on a result) would be missed.
  if (!cardOfTuneId(ann.tuneId, getContext().user.cards)) return false;
  if (isClipAttached(session, ann)) return true;

  const prepared = await prepareClip(session, ann, audio, onProgress);
  let filed = false;
  await ctx.mutate(s => { filed = fileClip(s, ann.tuneId, prepared); });
  if (filed) uploadAttachmentSoon(prepared.att);
  return true;
}

/** Re-cuts a clip that was already on the card, after its detection's bounds
 *  moved. Silent, and nothing to decide (2026-09-20, user request).
 *
 *  It has to exist because a clip is keyed by where it starts — see clipKey.
 *  Move the bound and the old attachment stops matching: the card would go
 *  back to offering "attach", the stale clip would sit there for good, and
 *  accepting the offer would leave two clips of the same tune, one of them
 *  cut on bounds nobody believes any more. Re-cutting keeps the promise the
 *  attachment makes — that it holds exactly the span the detection names.
 *
 *  `previous` is where the detection used to begin and end; `ann` already
 *  carries the new bounds. Returns whether anything was replaced, which is
 *  false in the ordinary case of a tune with no clip attached.
 *
 *  A clip the user RENAMED keeps its name. Told apart from a default one by
 *  rebuilding what the default would have been at the old bounds: anything
 *  else was typed by a person and is not ours to overwrite. */
export async function recutAttachedClip(
  ctx: AppContext,
  session: ClipSessionRef,
  ann: Detection,
  previous: { start: number; end: number | null },
  audio: Blob,
): Promise<boolean> {
  const card = cardOfTuneId(ann.tuneId, getContext().user.cards);
  if (!card) return false;

  const wasAnn = { ...ann, start: previous.start, end: previous.end };
  const oldKey = clipKey(session, wasAnn);
  const at = card.content.attachments.findIndex(
    a => a.type === 'file' && (a.clipOf === oldKey || legacyClipTag(a.name)?.key === oldKey),
  );
  if (at === -1) return false;

  const existing = card.content.attachments[at];
  if (!existing || existing.type !== 'file') return false;
  const oldExt = existing.name.split('.').pop() ?? '';
  const wasDefaultName = existing.name === clipFileName(session, wasAnn, oldExt);

  const clip = await extractClip(audio, ann.start, ann.end ?? session.duration);
  const name = wasDefaultName ? clipFileName(session, ann, clip.extension) : existing.name;
  const entry = await fileToEntry(new File([clip.blob], name, { type: clip.blob.type }));

  const att = await attachmentFor(entry, getContext().user);
  let replaced = false;
  await ctx.mutate(s => {
    const target = cardOfTuneId(ann.tuneId, s.cards);
    if (!target) return;
    // Found again by key rather than by the index read above: the state may
    // have moved on between the extraction and this write.
    const i = target.content.attachments.findIndex(
      a => a.type === 'file' && (a.clipOf === oldKey || legacyClipTag(a.name)?.key === oldKey),
    );
    if (i === -1) return;
    // Replaced in place, so the clip keeps its position among the card's
    // attachments — it is the same clip, re-cut, not a new one.
    target.content.attachments[i] = { ...att, clipOf: clipKey(session, ann) };
    replaced = true;
  });
  // Only once the new clip is in the state: the bytes of the old one are then
  // referenced by nothing, and a re-cut that did not happen must not take them.
  if (replaced) {
    void condemnAttachmentFile(existing);
    uploadAttachmentSoon(att);
    // The old clip's local bytes are left to the sweep, which is the only
    // thing that counts the snapshots as references — see card.tsx's onRemove.
  }
  return true;
}

/** Download-clip + attach-to-card controls, shared by the summary, live, and
 *  import-in-progress feeds — a finalized detection can show up before a
 *  session is fully done (see ViterbiResult.convergedThroughIndex), so this
 *  isn't summary-only. `getAudio` is a lazy Blob provider so a live recording
 *  only pays to assemble its (still-growing) chunk dump when the user
 *  actually clicks, not on every render. `audioAvailable` mirrors the
 *  summary's existing "hidden once the session's audio has been forgotten"
 *  rule — always true for live/import, where there's no such action yet. */
export function ClipControls({ ann, session, audioAvailable, getAudio, ctx, onAttached, aligned }: {
  ann: Detection;
  session: ClipSessionRef;
  audioAvailable: boolean;
  getAudio: () => Promise<Blob | undefined>;
  ctx: AppContext;
  onAttached?: () => void;
  /** Keep both slots even when their button is absent, so that several of
   *  these stacked one under the other line their glyphs up. Off by default:
   *  in a free-flowing row (the analysis summary's, which also holds the bound
   *  controls and a merge link) a reserved empty slot is just a hole. */
  aligned?: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadTitle, setDownloadTitle] = useState(t('sessions.downloadClip'));
  /** Why the last download failed. It was written into the tooltip and wiped
   *  by the `finally` in the same tick, so nobody ever read it. */
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachText, setAttachText] = useState<string | null>(null);
  /** Why attaching failed: an explicit flag, where the text used to be tested
   *  for a leading ⚠. */
  const [attachError, setAttachError] = useState<string | null>(null);

  const known = cardOfTuneId(ann.tuneId, getContext().user.cards);
  const already = known ? isClipAttached(session, ann) : false;

  const doDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      const clip = await extractClip(audio, ann.start, ann.end ?? session.duration, ratio => {
        setDownloadTitle(t('sessions.extracting', { pct: Math.round(ratio * 100) }));
      });
      downloadBlob(clip.blob, clipFileName(session, ann, clip.extension));
    } catch (err) {
      setDownloadError(String(err));
    } finally {
      setDownloading(false);
      setDownloadTitle(t('sessions.downloadClip'));
    }
  };

  const doAttach = async () => {
    setAttaching(true);
    try {
      const audio = await getAudio();
      if (!audio) throw new Error(t('sessions.clip.unavailable'));
      await attachClip(ctx, session, ann, audio, ratio => {
        setAttachText(t('sessions.extracting', { pct: Math.round(ratio * 100) }));
      });
      onAttached?.();
    } catch (err) {
      setAttachText(null);
      setAttachError(String(err));
    }
  };

  // doAttach leaves `attaching` set on failure — the control stays disabled
  // and carries the reason, which is the behaviour this had before it became a
  // glyph. The reason has to stay READABLE, so a failed slot gives up its fixed
  // width: a message in a 32px box would be a message nobody can read, and on a
  // phone there is no tooltip to fall back on. One row out of line is a cheap
  // price, and it points at the row that went wrong.
  const failed = attachError !== null;

  /** A slot rather than nothing, when the caller asks for it — see `aligned`.
   *
   *  ⚠️ A plain function returning a vnode, NOT a component — never write
   *  `const Slot = (props) => ...` and render it as `<Slot>`. A component
   *  declared inside a render is a NEW function on every pass, so Preact reads
   *  it as a different type and unmounts the old subtree to mount a fresh one
   *  each time. The buttons in it were then destroyed between mousedown and
   *  mouseup and the browser never fired a click at all: the control looked
   *  perfectly normal and did nothing (2026-09-12). Calling a function inlines
   *  the vnode into this component's own tree, where the diff can keep it. */
  const slot = (children: preact.ComponentChildren, wide = false) =>
    aligned && !wide ? <span class="w-8 flex items-center justify-center shrink-0">{children}</span> : <>{children}</>;

  return (
    <>
      {slot(audioAvailable && (
        <>
          <button
            class="icon-btn hover:text-accent"
            title={downloadTitle}
            aria-label={t('sessions.downloadClip')}
            disabled={downloading}
            dangerouslySetInnerHTML={{ __html: downloadIcon(14) }}
            onClick={() => { void doDownload(); }}
          />
          {downloadError && <span class="text-2xs text-danger">{downloadError}</span>}
        </>
      ), !!downloadError)}

      {/* Add clip as a standalone MP3 attachment (known card only) — hidden
         once the session's audio has been forgotten, unless a clip was
         already extracted before that (nothing left to extract, but still
         worth showing as done).

         A glyph rather than the words it used to be: it sits in a row of
         glyphs, and one text link among them broke both the alignment and the
         eye. The waveform says which object, the plus and the tick say which
         of the two states it is in. While the MP3 is being cut the percentage
         replaces the glyph — the same trade the summary's download makes, and
         for the same reason: two hours of audio takes a while, and a control
         that looked idle would be pressed again. */}
      {known && (already || audioAvailable) && slot(
        <button
          class={`icon-btn ${
            already ? 'text-success hover:text-success hover:bg-transparent cursor-default'
              : failed ? 'text-danger hover:text-danger px-1 disabled:opacity-100 cursor-default'
              : `text-accent ${attaching ? 'cursor-default' : 'hover:text-accent/70'}`}`}
          title={already ? t('sessions.attached') : attachError ?? attachText ?? t('sessions.attach')}
          aria-label={already ? t('sessions.attached') : t('sessions.attach')}
          disabled={!already && attaching}
          onClick={already ? undefined : () => { void doAttach(); }}
        >
          {already ? <ClipAttachedIcon size={14} />
            : failed ? <span class="text-2xs">{attachError}</span>
            : attachText ? <span class="text-2xs font-mono tabular-nums">{attachText}</span>
            : <AddClipIcon size={14} />}
        </button>,
        failed,
      )}
    </>
  );
}
