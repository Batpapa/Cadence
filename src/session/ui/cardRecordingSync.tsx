import { useEffect, useRef, useState } from 'preact/hooks';
import type { AudioSyncState, AudioSyncView } from '../../components/fileViewer';
import type { CardRecording } from '../../components/cardAudioSync';
import { attachmentBlob, AttachmentNotHere } from '../../services/attachmentStore';
import { getAttachmentBlob } from '../../services/attachmentDb';
import { fetchRemoteFile, remoteDisplayName, refusalMessage, RemoteFileError } from '../../services/remoteFile';
import { followAudio, type FollowAudio, type FollowStatus } from '../scoreFollowClient';
import { scoreContour, bareScore, meterOf } from '../../components/syncedScore';
import { showModal, closeModal, renderModalBody, alertModal } from '../../components/modal';
import { showRemoteFailure } from '../../components/remoteFailure';
import { qualityColour, faded } from '../../components/followColour';
import { CloudIcon, LinkIcon } from '../../components/icons';
import { formatBytes } from '../../utils';
import { t } from '../../services/i18nService';
import {
  mountScoreFollow, alignedVerdict, failureText, settingOfVersion, stageText, sizeUnknown, type FollowTarget,
} from './ScoreFollowView';

// ── Which of a card's recordings the score follows ───────────────────────────
// The part of components/cardAudioSync.ts loaded when it is used: the chooser
// for a card with several recordings, and the follow itself (ScoreFollowView,
// the whole recording as its target).
//
// The chooser lists them; one is picked by a press. "Compare" (2026-10-31,
// the user) aligns the score on to each in turn — the whole of each, the
// tempo found on a stretch then held loosely, as for a detection — and sorts
// them from the best aligned to the worst, each with its figure. It chooses
// none: the figure is one thing more to go by, against a press. The user
// waits for it, its button filling as a progress bar (each recording by its
// weight), and pressed again it is cancelled; a recording only on Drive comes
// down for it, and so does a link's (2026-11-01). An
// alignment made stays known to the page (scoreFollowClient), so the one
// then picked is followed at once.

const RECORDING: FollowTarget = { kind: 'recording' };

/** What a recording is called: the file's name, the link's as its row says. */
function nameOf(r: CardRecording): string {
  return r.kind === 'file' ? r.att.name : remoteDisplayName(r.entry.title, r.entry.url);
}

/** Which recording, for the alignments kept: two files of one size are not
 *  the same one. A link's file may change on its server: its size, also in
 *  the key (scoreFollowClient), then tells. */
function recordingId(r: CardRecording): string {
  return r.kind === 'file' ? r.att.external?.id ?? `${r.att.name}|${r.att.data.length}` : `link:${r.entry.url}`;
}

/** What a download is kept by: the attachment or the link itself. */
const keyOf = (r: CardRecording): object => (r.kind === 'file' ? r.att : r.entry);

/** A recording's bytes on their way, shared by whoever asks: its progress to
 *  each, stopped once all who asked have walked away. */
interface Download {
  blob: Promise<Blob>;
  listeners: Set<(s: FollowStatus) => void>;
  users: number;
  stop: AbortController;
}

/** Each recording's bytes, asked once per opening of the viewer: another
 *  version is the same recording, and so is the one picked after comparing.
 *  Nothing of a link is kept beyond: a link is a URL, not bytes (2026-09-29,
 *  the user). */
const downloads = new WeakMap<object, Download>();
function recordingBlob(r: CardRecording, onStatus?: (s: FollowStatus) => void, signal?: AbortSignal): Promise<Blob> {
  const key = keyOf(r);
  let d = downloads.get(key);
  if (!d) {
    const stop = new AbortController();
    const listeners = new Set<(s: FollowStatus) => void>();
    const tell = (loaded: number, total: number | null) => {
      const s: FollowStatus = total ? { stage: 'download', ratio: Math.min(1, loaded / total) } : { stage: 'download', ratio: 0, received: loaded };
      for (const l of listeners) l(s);
    };
    const blob = r.kind === 'file'
      // Opening it is a gesture: Drive may ask for its token. Not stopped:
      // what comes down from Drive stays on this device, worth finishing.
      ? attachmentBlob(r.att, true, tell)
      : fetchRemoteFile(r.entry.url, { signal: stop.signal, onProgress: tell }).then(f => f.blob);
    const made: Download = { blob, listeners, users: 0, stop };
    downloads.set(key, made);
    blob.catch(() => { if (downloads.get(key) === made) downloads.delete(key); });
    d = made;
  }
  const own = d;
  own.users++;
  if (onStatus) own.listeners.add(onStatus);
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    if (onStatus) own.listeners.delete(onStatus);
    own.users--;
  };
  own.blob.then(leave, leave);
  signal?.addEventListener('abort', () => {
    leave();
    if (own.users === 0) own.stop.abort();
  }, { once: true });
  return own.blob;
}

/** Why an attachment could not be had, as opening it would say
 *  (withResolvedEntry) — its keys spelled out, so the i18n test sees them. */
function missingText(e: unknown, name: string): { title: string; message: string } {
  if (e instanceof AttachmentNotHere) {
    switch (e.reason) {
      case 'not-uploaded': return { title: t('attachment.missing.not-uploaded.title'), message: t('attachment.missing.not-uploaded.message', { name }) };
      case 'offline': return { title: t('attachment.missing.offline.title'), message: t('attachment.missing.offline.message', { name }) };
      case 'gone': return { title: t('attachment.missing.gone.title'), message: t('attachment.missing.gone.message', { name }) };
    }
  }
  return { title: t('attachment.failed.title'), message: t('attachment.failed.message', { name }) };
}

/** Why a recording could not be had, short (a chooser's row) and in full —
 *  a link's as its row would say it (remoteFailure.ts). */
function failure(r: CardRecording, e: unknown): { short: string; full: string } {
  if (r.kind === 'link') {
    if (!(e instanceof RemoteFileError)) console.warn('[audio-sync] could not fetch ' + r.entry.url, e);
    return { short: t('embed.file.failedTitle'), full: e instanceof RemoteFileError ? refusalMessage(e.refusal) : t('embed.error') };
  }
  if (!(e instanceof AttachmentNotHere)) console.warn('[audio-sync] could not resolve ' + r.att.name, e);
  const { title, message } = missingText(e, r.att.name);
  return { short: e instanceof AttachmentNotHere ? title : failureText('error'), full: message };
}

/** The recording as the follow reads it — or undefined, having said why
 *  (nothing, when the view closed meanwhile). */
async function recordingAudio(r: CardRecording, onStatus: (s: FollowStatus) => void, signal: AbortSignal): Promise<FollowAudio | undefined> {
  try {
    return { blob: await recordingBlob(r, onStatus, signal), start: 0, id: recordingId(r) };
  } catch (e) {
    if (signal.aborted) return undefined;
    if (r.kind === 'link') {
      showRemoteFailure(r.entry, failure(r, e).full);
    } else {
      const { title, message } = missingText(e, r.att.name);
      if (!(e instanceof AttachmentNotHere)) console.warn('[audio-sync] could not resolve ' + r.att.name, e);
      alertModal(title, message);
    }
    return undefined;
  }
}

/** Where the recording's bytes are: here, only on Drive, or behind a link. */
type Whereabouts = 'here' | 'drive' | 'link';
async function whereabouts(r: CardRecording): Promise<Whereabouts> {
  if (r.kind === 'link') return 'link';
  const ext = r.att.external;
  if (!ext) return 'here';
  try { return (await getAttachmentBlob(ext.id)) ? 'here' : 'drive'; } catch { return 'drive'; }
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'working'; status: FollowStatus | null }
  | { kind: 'done'; verdict: AudioSyncState }
  | { kind: 'failed'; text: string; title?: string };

/** Where a row sorts once compared: its share of notes on the score, an
 *  alignment of a part only below every figure, a failure last. */
function rank(s: RowState): number {
  if (s.kind === 'done') return s.verdict.kind !== 'aligning' && s.verdict.percent !== undefined ? s.verdict.percent : -1;
  return -2;
}

/** Bytes a recording weighs — its share of the compare's progress bar; a
 *  link's is not known before it is read. */
function weightOf(r: CardRecording): number | null {
  if (r.kind === 'link') return null;
  return r.att.external?.bytes ?? Math.floor((r.att.data.length * 3) / 4);
}

/** Every recording's weight, a link counted as the mean of the others — as
 *  much as all the others when they are all links. */
function weightsOf(recordings: CardRecording[]): number[] {
  const known = recordings.map(weightOf);
  const sizes = known.filter((w): w is number => w !== null);
  const mean = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 1;
  return known.map(w => w ?? mean);
}

/** Settles when `signal` aborts: followAudio, stopped, never does. */
function aborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

function RecordingChooser({ recordings, version, stop, onPick }: {
  recordings: CardRecording[];
  /** The version on the viewer's screen, the one compared. */
  version: string;
  stop: AbortSignal;
  onPick: (r: CardRecording) => void;
}) {
  const [states, setStates] = useState<RowState[]>(() => recordings.map(() => ({ kind: 'idle' })));
  const [order, setOrder] = useState<number[]>(() => recordings.map((_, i) => i));
  /** The compare under way — pressed again, it is cancelled. */
  const run = useRef<AbortController | null>(null);
  /** How far the compare has gone, 0–1, each recording counted by its weight. */
  const [progress, setProgress] = useState<number | null>(null);
  const [where, setWhere] = useState<Whereabouts[] | null>(null);
  useEffect(() => { void Promise.all(recordings.map(whereabouts)).then(setWhere); }, []);

  const setRow = (i: number, s: RowState) => setStates(prev => prev.map((p, k) => (k === i ? s : p)));

  const compare = async () => {
    const own = new AbortController();
    run.current = own;
    const cut = own.signal;
    // The dialog closed: the compare goes with it.
    stop.addEventListener('abort', () => own.abort(), { once: true });
    const weights = weightsOf(recordings);
    const total = weights.reduce((a, b) => a + b, 0);
    const share = (i: number) => (total > 0 ? weights[i]! / total : 1 / recordings.length);
    let before = 0;
    setProgress(0);
    const done: RowState[] = recordings.map(() => ({ kind: 'idle' }));
    const contour = await scoreContour(bareScore(version), meterOf(version));
    for (let i = 0; i < recordings.length && !cut.aborted; i++) {
      const rec = recordings[i]!;
      let row: RowState;
      if (!contour) {
        row = { kind: 'failed', text: failureText('no_contour') };
      } else {
        setRow(i, { kind: 'working', status: null });
        try {
          // Its download is said on its row; the bar moves with the
          // alignments only — how long a download takes is not known.
          const blob = await Promise.race([
            recordingBlob(rec, (status) => { if (!cut.aborted) setRow(i, { kind: 'working', status }); }, cut),
            aborted(cut),
          ]);
          if (blob === 'aborted') break;
          const result = await Promise.race([
            followAudio({ blob, start: 0, id: recordingId(rec) }, contour, settingOfVersion(version), null,
              (status) => {
                if (cut.aborted) return;
                setRow(i, { kind: 'working', status });
                setProgress(before + share(i) * status.ratio);
              }, cut),
            aborted(cut),
          ]);
          if (result === 'aborted') break;
          row = typeof result === 'string' ? { kind: 'failed', text: failureText(result) } : { kind: 'done', verdict: alignedVerdict(result, RECORDING) };
        } catch (e) {
          if (cut.aborted) break;
          const why = failure(rec, e);
          row = { kind: 'failed', text: why.short, title: why.full };
        }
      }
      done[i] = row;
      setRow(i, row);
      before += share(i);
      setProgress(before);
    }
    if (stop.aborted) return;
    if (run.current === own) { run.current = null; setProgress(null); }
    if (cut.aborted) {
      // Cancelled: what was compared stays, the recording under way is not.
      setStates(prev => prev.map(s => (s.kind === 'working' ? { kind: 'idle' } : s)));
      return;
    }
    setOrder(recordings.map((_, i) => i).sort((a, b) => rank(done[b]!) - rank(done[a]!)));
  };

  const comparing = progress !== null;
  // The best figure so far is set in a pill.
  const best = Math.max(-1, ...states.map(rank));
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('cardAudioSync.intro')}</p>
      <div class="space-y-2">
        {order.map((i) => {
          const rec = recordings[i]!;
          const s = states[i]!;
          return (
            <button
              key={i}
              type="button"
              class="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-border bg-bg text-left cursor-pointer transition-colors hoverable:border-accent"
              onClick={() => onPick(rec)}
            >
              <span class="flex-1 min-w-0 flex items-center gap-1.5">
                <span class="text-sm font-medium text-primary truncate">{nameOf(rec)}</span>
                {where?.[i] === 'drive' && <span class="inline-flex items-center shrink-0 text-dim" title={t('cardAudioSync.onDrive')}><CloudIcon size={12} /></span>}
                {where?.[i] === 'link' && <span class="inline-flex items-center shrink-0 text-dim" title={t('cardAudioSync.link')}><LinkIcon size={12} /></span>}
              </span>
              <RowFigure state={s} best={best >= 0 && rank(s) === best} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="btn-soft w-full relative overflow-hidden"
        onClick={() => { if (run.current) run.current.abort(); else void compare(); }}
      >
        {comparing && (
          <span
            class="absolute inset-y-0 left-0 bg-accent/30 transition-[width] duration-300 pointer-events-none"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
        <span class="relative">{comparing ? t('cardAudioSync.comparing') : t('cardAudioSync.compare')}</span>
      </button>
    </div>
  );
}

/** A row's end: how far its alignment has gone, then how well it fits — the
 *  toggle's colours and words (AudioSyncState). */
function RowFigure({ state, best }: { state: RowState; best: boolean }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'working') {
    const ratio = state.status?.ratio ?? 0;
    // A download whose size is not told: what has come down.
    const figure = sizeUnknown(state.status) ? formatBytes(state.status!.received ?? 0) : `${Math.round(ratio * 100)} %`;
    return <span class="shrink-0 text-xs text-accent font-mono" title={stageText(state.status)}>{figure}</span>;
  }
  if (state.kind === 'failed') return <span class="shrink-0 text-xs text-danger max-w-[45%] text-right" title={state.title}>{state.text}</span>;
  const v = state.verdict;
  const percent = v.kind !== 'aligning' ? v.percent : undefined;
  const colour = percent !== undefined ? qualityColour(percent / 100) : 'var(--color-danger)';
  // The best one in a pill of its colour: white on amber would not read, so
  // the pill is its colour faded, the figure the colour itself.
  return (
    <span
      class={`shrink-0 text-xs font-mono font-medium ${best ? 'px-2 py-0.5 rounded-full border' : ''}`}
      style={best ? { color: colour, borderColor: colour, background: faded(colour, 0.15) } : { color: colour }}
      title={v.title}
    >
      {percent !== undefined ? `${percent} %` : '—'}
    </span>
  );
}

/** Which of `recordings` to follow `version` with, or null when the question
 *  was walked away from. */
export function chooseRecording(recordings: CardRecording[], version: string): Promise<CardRecording | null> {
  return new Promise((resolve) => {
    const stop = new AbortController();
    let settled = false;
    // A comparison still running goes with the dialog: its worker is stopped.
    const finish = (r: CardRecording | null) => {
      if (settled) return;
      settled = true;
      stop.abort();
      resolve(r);
    };
    let leave = () => {};
    const { el, cleanup } = renderModalBody(
      <RecordingChooser recordings={recordings} version={version} stop={stop.signal} onPick={(r) => { leave(); finish(r); }} />,
    );
    // closeModal only pops: the body is unmounted here, as onDismiss would.
    leave = () => { closeModal(); cleanup(); };
    showModal(t('fileViewer.abc.audioSync'), el, [], { onDismiss: () => { cleanup(); finish(null); } });
  });
}

/** The follow of `r`, the whole recording, in the viewer's `host`. */
export function mountRecordingFollow(host: HTMLElement, r: CardRecording, opts: {
  version: string;
  face: 'sheet' | 'text';
  expanded: boolean;
  onState: (s: AudioSyncState) => void;
  forced: boolean;
}): AudioSyncView {
  return mountScoreFollow(host, { ...opts, target: RECORDING, getAudio: (onStatus, signal) => recordingAudio(r, onStatus, signal) });
}
