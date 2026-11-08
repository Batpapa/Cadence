import { Fragment, type ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { formatBytes, downloadBlob } from '../../utils';
import { PlusIcon, CloudIcon, CloudUpIcon, TrashIcon, ResetIcon, UploadIcon } from '../../components/icons';
import { playIcon, pauseIcon, stopIcon, downloadIcon } from '../../components/playbackIcons';
import type { ContextMenuEntry } from '../../components/contextMenu';
import { confirmModal, alertModal, showModal, closeModalOf, renderModalBody } from '../../components/modal';
import { signal, type Signal } from '@preact/signals';
import {
  deleteSession, loadSessionAudio, saveSessionMeta, forgetSessionAudio,
  uploadSessionAudio, unsyncSessionAudio, fetchSyncedAudio, autoUploadState,
  audioDownloadProgress, audioArrivals, downloadSyncedAudioOnce, keepSyncedAudioHere,
} from '../db';
import { isDriveConnected } from '../../services/driveService';
import type { Analysis, Detection, SyncedAudio, TuneAnalyserModuleData } from '../model';
import { TUNE_ANALYSER_MODULE_KEY } from '../model';
import { alternatePickFields, withManualAlternate, manualAlternateRemovalFields, insertionIndex } from '../model';
import { samePlayedPitch } from '../recognition/pitchSplit';
import { DetectionCard, type DetectionCardOptions } from './DetectionCard';
import { showDetectionTempo } from './LiveTempo';
import { useSlicePlayer } from './PassRow';
import { showShareSessionModal } from './ShareSessionModal';
import { showAnalysisNotesModal } from './AnalysisNotesModal';
import { AnalysisFolderPicker } from './AnalysisFolderPicker';
import { detectAudioFile } from '../audio/clipExtract';
import { audioExtension } from '../../services/zip';
import {
  fmtLongTime, TitleRow, DateRow,
  ClipControls, recutAttachedClip, repinReviewEntry, absorbReviewEntry, dropReviewEntry, repinSessionDate,
} from './sessionUiShared';
import { showBoundEditor, type TwinEdit } from './BoundEditor';
import { showAddDetection } from './AddDetection';
import { lastImportDump, lastLiveDump } from './sessionStore';
import {
  analysisView, analysisStudy, showsDetails, showsEditing, showsFocus,
} from './analysisView';
import { AnalysisViewBar } from './AnalysisViewBar';
import { FocusView, type FocusSpot } from './FocusView';
import { devMode } from '../../services/devMode';
import { appState } from '../../store';
import { headPosition, withChains, withGaps, chainsOf, shortGapsOf, type ListAnn, type ListChain, type ListGap, type ShortGap } from './timelineModel';
import { SetMarkButton, setRows, withCutMark, type SetOpens } from './setBreaks';
import { setDetectionOn } from '../detections';
import { useMediaVolume } from '../../components/useMediaVolume';
import { returningToOffset } from '../../components/scrollRestoration';
import { generateId } from '../../utils';
import { getContext, leaveDeletedPage, navEntry } from '../../store';
import { tunesetsOf, sameTunesets, chainSpan, setCardFor } from '../tunesets';
import { TunesetDetectionCard, chainPlayId, type TunesetCardOptions } from './TunesetDetectionCard';
import { repinSetReview, recutSetClip, setReviewId, type Span } from './tunesetShared';

// ── Screen: summary ───────────────────────────────────────────────────────────
// A finished session: audio player, clickable segment timeline, detection
// list with per-tune edit controls. Uses <DetectionCard> directly as JSX,
// never the detectionCard() bridge — see ImportAnalysis.tsx's header doc for
// why (reentrant render() during this component's own render pass corrupts
// Preact's hooks bookkeeping).
//
// `session` is a mutable Analysis, edited in place (same object
// db.ts/saveSessionMeta persists) — merge/delete/bound-adjust/like all mutate
// it directly and then `bump()` a tick counter to force a re-render, rather
// than mirroring it into Preact state; matches the original's own
// renderList()/renderBar() re-invocation after each mutation.

const BUCKET_SEGMENT: Record<Detection['bucket'], string> = {
  high: 'rgb(34 197 94 / 0.75)',
  medium: 'rgb(245 158 11 / 0.75)',
  low: 'rgb(120 120 120 / 0.55)',
};

/** Diagonal hatching that LEANS THE OTHER WAY from one detection to the next.
 *
 *  Two neighbours of the same confidence would otherwise read as one long
 *  detection, and there is nothing to draw between them: 22 of 37 joins on a
 *  real session OVERLAP, so no boundary exists there to mark. A texture seam
 *  needs no geometry and costs no width — a hairline would have eaten a
 *  segment already down to its 2 px floor, and a second colour per level made
 *  the strip gaudy.
 *
 *  Reversing the ANGLE rather than shifting the phase: a phase break can
 *  vanish when a segment happens to be a whole number of periods wide, and it
 *  would vanish at the joins that need it most. Two stripes meeting nose to
 *  nose make a chevron the width cannot undo. */
//
// Beware the angle: it names the direction of the gradient's AXIS, clockwise
// from straight up, and the stripes run PERPENDICULAR to it. So `-45deg`
// draws rising stripes (/) and `45deg` falling ones (\) — the opposite of
// what the number reads like. The first detection of a session rises.
const hatch = (deg: number) =>
  `repeating-linear-gradient(${deg}deg, rgb(0 0 0 / 0.12) 0 3px, transparent 3px 6px)`;
const HATCH = [hatch(-45), hatch(45)];   // rising, then falling

/** Window for reading two clicks as one gesture. The platform's own dblclick
 *  threshold is not exposed, so this only has to be generous enough to cover
 *  the second click — it never decides anything on its own. */
const DOUBLE_CLICK_MS = 400;

/** The window a re-analysis waits behind while its recording comes from Drive. */
function DriveFetchBody({ progress, bytes }: { progress: Signal<number>; bytes: number }) {
  const pct = Math.round(progress.value * 100);
  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('sessions.reanalyze.fetch.message', { size: formatBytes(bytes) })}</p>
      <div class="h-2 rounded bg-elevated overflow-hidden">
        <div class="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p class="text-xs text-dim font-mono tabular-nums text-right">{pct} %</p>
    </div>
  );
}

/** Where this recording's Drive copy stands. Same readings as the header's own
 *  sync indicator, because it is the same question about a smaller thing. */
type DriveAudioState = 'off' | 'uploading' | 'on' | 'error' | 'waiting' | 'wifi';

const NOT_ON_DRIVE_TITLE: Record<Exclude<DriveAudioState, 'on'>, string> = {
  off:       'sessions.syncAudio.off',
  uploading: 'sessions.syncAudio.uploading',
  error:     'sessions.syncAudio.retry',
  // The automatic copy failed and will be tried again on its own (db.ts).
  waiting:   'sessions.syncAudio.retryPending',
  // Held until this device is on Wi-Fi, as it was told (db.ts).
  wifi:      'sessions.syncAudio.waitingWifi',
};

/** The one state of a recording's whereabouts nothing else on the screen says
 *  (2026-11-05, the user's design): here but NOT on Drive. Here and on Drive is
 *  the ordinary case and shows nothing; on Drive only shows in the player's ▶;
 *  nowhere is the line under the views. So this is a cloud struck through, or
 *  on its way up, or failing — never a green one: a copy that is there is no
 *  news, and the green cloud that REMOVED the copy when touched is what this
 *  replaces. Touched, it offers the copy, confirmed.
 *
 *  Hover never changes the HUE, only its lightness: colour is state here, as on
 *  the header's indicator, and an accent-on-hover idle icon read as an upload
 *  started and stuck (2026-09-08). */
function NotOnDriveBtn({ state, onClick }: { state: Exclude<DriveAudioState, 'on'>; onClick: () => void }) {
  const uploading = state === 'uploading';
  const tone =
    uploading ? 'text-accent animate-pulse cursor-default' :
    state === 'error' || state === 'waiting' ? 'text-danger cursor-pointer' :
    // Not a failure: nothing went wrong, it is waiting as asked.
    state === 'wifi' ? 'text-warn cursor-pointer' :
    'text-dim hover:text-muted cursor-pointer';
  const title = t(NOT_ON_DRIVE_TITLE[state] as Parameters<typeof t>[0]);
  return (
    <button
      class={`relative w-7 h-7 flex items-center justify-center shrink-0 transition-colors ${tone}`}
      title={title}
      aria-label={title}
      disabled={uploading}
      onClick={uploading ? undefined : onClick}
    >
      {uploading ? <CloudUpIcon size={15} /> : (
        <>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
          </svg>
          <span aria-hidden="true" class="absolute left-1/2 top-1/2 w-[19px] h-[1.5px] rounded bg-current -translate-x-1/2 -translate-y-1/2 -rotate-45" />
        </>
      )}
    </button>
  );
}

interface SessionSummaryProps {
  session: Analysis;
  ctx: AppContext;
  onOpenCard: (cardId: string) => void;
  /** `audio`: a recording brought down from Drive for it, not to be stored. */
  onReanalyze: (audio?: Blob) => void;
  /** One detection to arrive on, from a card's "detected in" link. Marks and
   *  scrolls to it; see `targetId` for why that is not the same as selecting. */
  annotationId?: string;
}

export function SessionSummary({ session, ctx, onOpenCard, onReanalyze, annotationId }: SessionSummaryProps) {
  const listWrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // At the app's playback volume (Settings → Misc., per device).
  useMediaVolume(audioRef);
  const timeLblRef = useRef<HTMLSpanElement>(null);
  const playingIdRef = useRef<string | null>(null);
  // The timeline IS the seek bar now — one axis, so there is nothing left to
  // keep aligned. Its head is moved by writing style.left straight from the
  // audio element's own events, never through a re-render.
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Where the user ASKED to be, while the player is still behind it.
  //
  // Setting `currentTime` is a request, not an assignment: the element seeks to
  // the nearest position it can decode — a cluster boundary in a webm — and the
  // `timeupdate` that follows can carry a time slightly BEFORE the one asked
  // for. Clicking the second of two tunes that abut exactly then reads back at
  // `B.start - ε`, which the previous tune still covers and the new one does
  // not: the wrong tune lights, alone. (The bounds themselves are exact —
  // multiples of the analysis hop — so nothing is being rounded here.)
  //
  // So the requested position stands until playback genuinely reaches it, and
  // then hands over. Paused, it stands for good, which is right: paused at the
  // start of a tune IS being at that tune.
  const seekFloorRef = useRef<number | null>(null);
  /** Where the head was last put — what a recording brought down from Drive
   *  starts playing from, the element having had nothing to seek in until then. */
  const headTimeRef = useRef(0);
  /** A play asked for before the recording was loaded: where it starts. */
  const pendingPlayRef = useRef<number | null>(null);
  /** Whether the player's bar is pinned at the top, the list scrolling under
   *  it: read off a mark where the bar stands at rest, which leaves the
   *  scrollport exactly when the bar starts to stick. An observer, not a scroll
   *  handler: the scrolling element is the app's, not this screen's, and the
   *  observer sees clipping by any of them. */
  const pinMarkRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const mark = pinMarkRef.current;
    if (!mark || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setPinned(!!entry && !entry.isIntersecting));
    io.observe(mark);
    return () => io.disconnect();
  }, []);
  const dragRef = useRef<{ moved: boolean; annId: string | null } | null>(null);
  // When the previous click landed, so the second of a double can stand down
  // and leave the work to the dblclick handler.
  const lastClickRef = useRef(0);

  const [, setTick] = useState(0);
  const bump = () => setTick(x => x + 1);

  // Decks pinned in the deck choice modal. Not persisted — resets each time
  // the summary is opened, on purpose: a destination is a decision about the
  // work happening right now (see components/deckSelector.tsx).
  const pinnedDeckIdsRef = useRef<Set<string>>(new Set());

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBytes, setAudioBytes] = useState(0);
  /** The Drive copy of this recording, if there is one.
   *
   *  Read straight off appState on every render rather than snapshotted on
   *  mount (2026-09-08). This is the one field that arrives from ANOTHER
   *  device: the copy is made on the phone, and the laptop learns about it
   *  whenever the next Drive pull lands — which is very often while this screen
   *  is already open. A mount-time snapshot left the recording looking absent
   *  until the page was reloaded, for a feature whose whole point is that the
   *  other device can hear it. */
  const modData = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  const synced: SyncedAudio | null = modData?.syncedAudio?.[session.id] ?? null;
  /** An upload, removal or download in flight — all three touch the network and
   *  none may be started twice. */
  const [busySync, setBusySync] = useState(false);
  /** The last transfer failed. Kept so the indicator stays red afterwards: the
   *  modal explaining it is dismissed in a second, and without this the button
   *  would go back to looking like nothing had been attempted. */
  const [syncFailed, setSyncFailed] = useState(false);
  /** True while the recording is being read out of the local database. */
  const [downloading, setDownloading] = useState(false);
  /** The recording brought down from Drive for THIS visit only (2026-11-05,
   *  the user's design): with it only on Drive, the player's ▶ downloads it
   *  whole and plays it, without storing it — keeping it here is a decision of
   *  its own, in the title's menu. Gone with the screen. */
  const [temp, setTemp] = useState<{ blob: Blob; url: string } | null>(null);
  /** That download's progress, 0–1, while it runs. */
  const [tempProgress, setTempProgress] = useState<number | null>(null);
  /** What the player reads: the recording stored here, else the one brought
   *  down for this visit. Only playback reads this — everything that works on
   *  the stored file (bounds, tempo, clips, re-analysis) still asks `audioUrl`. */
  //
  // The visit's copy first when there is one: kept here meanwhile, the player
  // goes on reading the same file instead of being cut mid-tune by a new source.
  const playUrl = temp?.url ?? audioUrl;
  // Read once per render, not stored: connecting or disconnecting Drive
  // re-renders this screen through the state it changes.
  const driveOn = isDriveConnected();
  const [playing, setPlaying] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  /** The recording is not here but is on Drive: a card's ▶ plays its passage
   *  straight from there (2026-10-10), through the same player as the lists of
   *  passes — the timeline's own element has nothing loaded to seek in. */
  const drivePlayer = useSlicePlayer();
  playingIdRef.current = playingId;
  const sliceEndRef = useRef(0);

  // Not a selection — a READING of where the play head stands. Every detection
  // covering that instant is lit, in the strip and in the list alike: none in a
  // silence, two across a join. Nothing is remembered, so nothing can go stale.
  //
  // `follow` says whether the list should come to it: a head that MOVED (the
  // audio playing, a gesture) yes; a head merely PLACED — the recording
  // loading at 0, a link's detection on a back — no. The page is wherever the
  // reader left it then, and centring the first row took a back from the
  // middle of a long analysis to its top (reported 2026-11-04).
  const [lit, setLit] = useState<{ ids: string[]; gapFrom: number | null; follow?: boolean }>({ ids: [], gapFrom: null });
  // The detection that was POINTED AT — clicked on the strip, or followed here
  // from a card's "detected in" link. A different question from `lit`, which
  // answers "what covers the play head" and is plural by nature: detections
  // overlap at 22 of 37 joins on a real session, so landing on one usually
  // lights two, and the honest reading cannot say which of them was meant.
  //
  // Answered once and gone at the next gesture — after that, "which one did I
  // pick" is a question nobody is still asking, and a stale mark competing with
  // the live reading is exactly what the timeline work removed elsewhere.
  //
  // It also has to survive with NO audio: sessions sync between devices, their
  // recordings do not, so the mark cannot be something the play head sets.
  const [targetId, setTargetId] = useState<string | null>(annotationId ?? null);
  const dropTarget = () => setTargetId(id => (id === null ? id : null));
  // The last reading, as a key, so the list only re-renders when the answer
  // actually changes — a couple of times a tune, not four times a second.
  const litKeyRef = useRef('');
  // The one detection the Focus view shows when the head lights several — the
  // one it already showed, as long as it is still lit, so that crossing a join
  // does not flick between the two. See focusSpot below.
  const focusIdRef = useRef<string | null>(annotationId ?? null);

  /** Moves the head to `tSec` and re-reads what it covers. The single place
   *  the head is written, whether the audio drove it or a pointer did — with
   *  the audio forgotten there is no player to ask, and the strip still works
   *  as a map. */
  const applyHead = (tSec: number, follow = true) => {
    headTimeRef.current = tSec;
    if (headRef.current) headRef.current.style.left = `${Math.min(100, (tSec / (session.duration || 1)) * 100)}%`;
    const pos = headPosition(session.annotations, tSec, session.duration);
    const key = `${pos.ids.join('|')}#${pos.gapFrom ?? ''}`;
    if (key !== litKeyRef.current) { litKeyRef.current = key; setLit({ ...pos, follow }); }
  };

  const persist = () => { void saveSessionMeta(session); };

  // ── The sets of this analysis (2026-10-19) ──
  // Which detections make a set is read off the detections on every render
  // (timelineModel's withChains); the table only carries what that cannot
  // give — an identity for the set's heart and its review — and is brought in
  // line here, written back only when it actually changed.
  // Behind an option while it is iterated on with the testers (2026-10-19):
  // off, nothing here runs and the table is never written.
  const setsOn = setDetectionOn(appState.value);
  const tablePendingRef = useRef(false);
  const reconciled = setsOn ? tunesetsOf(session, generateId) : session.tunesets ?? [];
  if (setsOn && !sameTunesets(session.tunesets, reconciled)) {
    session.tunesets = reconciled;
    tablePendingRef.current = true;
  }
  const records = session.tunesets ?? [];
  useEffect(() => {
    if (!tablePendingRef.current) return;
    tablePendingRef.current = false;
    persist();
  });

  /** A set as it stands: its span and its tunes, read from its detections. */
  const setNow = (detectionIds: string[]): { span: Span; tuneIds: string[] } | null => {
    const chain = detectionIds.map(id => session.annotations.find(a => a.id === id)).filter((d): d is Detection => !!d);
    if (chain.length === 0) return null;
    return { span: chainSpan(chain, session.duration), tuneIds: chain.map(d => d.tuneId) };
  };
  // Taken NOW, at render, before any edit below writes into the detections:
  // what an edit has to compare against to know whether a set moved.
  const setsBefore = new Map(records.map(r => [r.id, setNow(r.detectionIds)]));

  /** What a set drags behind it when its span moves — its rating, then its
   *  clip — the set's twin of settleMoved below. A set whose tunes changed is
   *  looked up again: its card is the one made of the tunes it has NOW. */
  const settleSets = async () => {
    if (!setsOn) return;
    const after = tunesetsOf(session, generateId);
    if (!sameTunesets(session.tunesets, after)) { session.tunesets = after; persist(); }
    const startMs = session.date === null ? NaN : Date.parse(session.date);
    let blob: Blob | undefined | null = null;
    let changed = false;
    for (const r of after) {
      const was = setsBefore.get(r.id);
      const now = setNow(r.detectionIds);
      if (!was || !now) continue;
      if (Math.abs(was.span.start - now.span.start) < 0.001 && Math.abs(was.span.end - now.span.end) < 0.001) continue;
      const setCard = setCardFor(now.tuneIds, getContext().user.cards);
      if (!setCard) continue;
      if (!Number.isNaN(startMs)) {
        changed = await repinSetReview(ctx, setCard.id, setReviewId(session.id, r.id),
          { startMs, end: was.span.end }, { startMs, end: now.span.end }).catch(() => false) || changed;
      }
      if (blob === null) blob = await loadSessionAudio(session.id).catch(() => undefined);
      if (blob) changed = await recutSetClip(ctx, session, setCard.id, was.span, now.span, blob).catch(() => false) || changed;
    }
    if (changed) bump();
  };

  // The automatic copy made when the recording was saved, or its retries: shown
  // here too, so that a recording stopped a moment ago reads as on its way
  // rather than as never copied.
  const autoUpload = synced ? undefined : autoUploadState.value[session.id];
  const driveAudioState: DriveAudioState =
    busySync || autoUpload === 'uploading' ? 'uploading'
      : syncFailed ? 'error'
      : synced ? 'on'
      : autoUpload === 'waiting' ? 'waiting'
      : autoUpload === 'wifi' ? 'wifi'
      : 'off';

  // ── Audio load: streamed via a native <audio> element (no
  // decodeAudioData/waveform — sessions can run for hours). Revokes the
  // object URL whenever it's replaced (forgotten) or on unmount.
  useEffect(() => {
    let cancelled = false;
    void loadSessionAudio(session.id).then(blob => {
      if (cancelled || !blob) return;
      setAudioBytes(blob.size);
      setAudioUrl(URL.createObjectURL(blob));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);

  const failedTransfer = (e: unknown) => alertModal(
    t('sessions.syncAudio.failed.title'),
    t('sessions.syncAudio.failed.message', { error: e instanceof Error ? e.message : String(e) }),
  );

  /** Removes the Drive copy. Confirmed, because it destroys something: the copy
   *  on Drive is what the user's other devices play from — and, with nothing
   *  here (2026-11-05: the title's menu is the first place that can do it
   *  then), the last copy there is. The recording on THIS device is not
   *  touched — see forgetSessionAudio for the other half of that split. */
  const removeFromDrive = () => {
    if (busySync || !synced) return;
    setSyncFailed(false);
    confirmModal(
      t('sessions.syncAudio.remove.title'),
      t(audioUrl ? 'sessions.syncAudio.remove.message' : 'sessions.syncAudio.remove.messageOnly', { size: formatBytes(synced.bytes) }),
      t('sessions.syncAudio.remove.ok'),
      () => {
        setBusySync(true);
        void unsyncSessionAudio(session.id).catch(failedTransfer).finally(() => setBusySync(false));
      },
    );
  };

  /** This device's copy, freed. Two messages, because the act has two different
   *  consequences: with a copy on Drive this frees space and is undone by a
   *  download; without one it is the end of the recording. */
  const forgetHere = () => confirmModal(
    t('sessions.forgetAudio.title'),
    t(synced ? 'sessions.forgetAudio.messageSynced' : 'sessions.forgetAudio.message'),
    t('sessions.forgetAudio'),
    () => { void forgetSessionAudio(session.id).then(() => setAudioUrl(null)); },
  );

  /** Copies this recording to Drive. Confirmed first because it spends the
   *  user's bandwidth and their Drive space. */
  const uploadToDrive = () => {
    if (busySync || synced) return;
    setSyncFailed(false);
    confirmModal(
      t('sessions.syncAudio.confirm.title'),
      t('sessions.syncAudio.confirm.message', { size: formatBytes(audioBytes) }),
      t('sessions.syncAudio.confirm.ok'),
      () => {
        setBusySync(true);
        void uploadSessionAudio(session.id)
          .catch((e: unknown) => { setSyncFailed(true); failedTransfer(e); })
          .finally(() => setBusySync(false));
      },
    );
  };

  // Brought here in the background meanwhile (audioDownloads.ts): picked up
  // without a reload, as the Drive copy itself is.
  const downloadProgress = audioDownloadProgress.value[session.id];
  const arrived = audioArrivals.value.has(session.id);
  useEffect(() => {
    if (!arrived || audioUrl) return;
    let cancelled = false;
    void loadSessionAudio(session.id).then(blob => {
      if (cancelled || !blob) return;
      setAudioBytes(blob.size);
      setAudioUrl(URL.createObjectURL(blob));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [arrived]);

  /** Keeps a recording made on another device on this one. Never on its own
   *  from here: opening a session summary must not spend tens of megabytes of
   *  someone's mobile data without being asked — that is the automatic mode's
   *  decision to make, where the user made it. Already brought down for this
   *  visit, it is stored from there rather than fetched twice. */
  const keepHere = () => {
    if (busySync) return;
    if (temp) {
      const { blob } = temp;
      void keepSyncedAudioHere(session.id, blob).then(() => {
        setAudioBytes(blob.size);
        // A URL of its own: the visit's goes with `temp`, which the player
        // goes on reading — switching its source mid-tune would cut it.
        setAudioUrl(URL.createObjectURL(blob));
      }).catch(failedTransfer);
      return;
    }
    setBusySync(true);
    void fetchSyncedAudio(session.id)
      .then(blob => {
        if (!blob) {
          // fetchSyncedAudio already dropped the dangling record; `synced`
          // follows that state, so the offer disappears on its own.
          alertModal(t('sessions.syncAudio.gone.title'), t('sessions.syncAudio.gone.message'));
          return;
        }
        setAudioBytes(blob.size);
        setAudioUrl(URL.createObjectURL(blob));
      })
      .catch(failedTransfer)
      .finally(() => setBusySync(false));
  };
  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);
  useEffect(() => {
    if (!temp) return;
    return () => URL.revokeObjectURL(temp.url);
  }, [temp]);
  // With nothing loaded, the time label still says how long the recording is:
  // the cloud player's ▶ has a whole session behind it.
  useEffect(() => {
    if (!playUrl && timeLblRef.current) timeLblRef.current.textContent = `0:00 / ${fmtLongTime(session.duration)}`;
  });

  /** The recording for this visit, from Drive: the one already brought down,
   *  else a download whose progress the ▶ shows. Null when it could not be had
   *  — the user told why — or while one is already coming. Asked from a click
   *  only: Drive's token cannot be renewed outside one. */
  const fetchTemp = (): Promise<Blob | null> => {
    if (temp) return Promise.resolve(temp.blob);
    if (tempProgress !== null || busySync || !synced) return Promise.resolve(null);
    setTempProgress(0);
    return downloadSyncedAudioOnce(session.id, setTempProgress)
      .then(blob => {
        if (!blob) {
          alertModal(t('sessions.syncAudio.gone.title'), t('sessions.syncAudio.gone.message'));
          return null;
        }
        setTemp({ blob, url: URL.createObjectURL(blob) });
        return blob;
      })
      .catch((e: unknown) => { failedTransfer(e); return null; })
      .finally(() => setTempProgress(null));
  };

  /** The player's ▶ with the recording only on Drive: brings it down, then
   *  plays it from where the head stands once the element knows the file (see
   *  the 'loadedmetadata' handler). A browser that refuses to start playing so
   *  long after the tap (iOS may) leaves it ready: the next ▶ plays. */
  const playFromDrive = () => {
    void fetchTemp().then(blob => {
      if (blob) pendingPlayRef.current = headTimeRef.current;
    });
  };

  // Play/pause icon toggle.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => { a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); };
    // eslint-disable-next-line
  }, []);

  // Space toggles playback, the way it does in every player — the same rule as
  // the score viewer's, deliberately worded the same.
  //
  // Ignored while a field or a button has focus: a button already answers the
  // space bar by activating itself — including the play button, which reaches
  // the same result by its own route — and swallowing the key inside the
  // session's title field would make it impossible to type a name with spaces.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
      const a = audioRef.current;
      if (!a || !a.src) return;
      e.preventDefault(); // or the page scrolls under it
      dropTarget();
      // stop() only reads refs, so the first render's player is good here.
      if (a.paused) { drivePlayer.stop(); void a.play().catch(() => {}); } else a.pause();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Play head + time label (direct DOM writes on 'timeupdate' — high
  // frequency, not worth a Preact re-render) and per-detection slice
  // playback: pauses at the slice's end bound, clears playingId when the
  // player stops for any reason.
  //
  // 'timeupdate' fires about four times a second, which sounds coarse for a
  // moving head and is not: on a 48 min session in a 700 px strip the head
  // travels a quarter of a pixel per second. No animation frame needed.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    // One number for the head, the label and the reading — they cannot
    // disagree about where we are.
    const headTime = () => {
      const floor = seekFloorRef.current;
      if (floor === null) return a.currentTime;
      if (a.currentTime >= floor) { seekFloorRef.current = null; return a.currentTime; }
      return floor;
    };
    const updateTime = (follow = true) => {
      const t = headTime();
      if (timeLblRef.current) timeLblRef.current.textContent = `${fmtLongTime(t)} / ${fmtLongTime(a.duration || 0)}`;
      applyHead(t, follow);
    };
    // The first reading, not a movement: see `lit`. Or the start of a play the
    // ▶ asked for before the recording was here (playFromDrive): from where
    // the head stood when it was asked.
    const onLoadedMeta = () => {
      const start = pendingPlayRef.current;
      if (start !== null) {
        pendingPlayRef.current = null;
        a.currentTime = start;
        seekFloorRef.current = start;
        // stop() only reads refs, so the first render's player is good here.
        drivePlayer.stop();
        void a.play().catch(() => {});
      }
      updateTime(false);
    };
    const onTimeUpdate = () => {
      updateTime();
      if (playingIdRef.current !== null && a.currentTime >= sliceEndRef.current) a.pause();
    };
    const onPause = () => { if (playingIdRef.current !== null) setPlayingId(null); };
    a.addEventListener('loadedmetadata', onLoadedMeta);
    a.addEventListener('timeupdate', onTimeUpdate);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('loadedmetadata', onLoadedMeta);
      a.removeEventListener('timeupdate', onTimeUpdate);
      a.removeEventListener('pause', onPause);
    };
    // eslint-disable-next-line
  }, []);

  /** Silences a passage still playing from Drive: the recording can arrive
   *  while one does, and the timeline's element would then play over it. True
   *  when that passage was `annId`'s — the press was its stop. */
  const stopDrivePassage = (annId?: string): boolean => {
    const was = drivePlayer.playingId;
    if (was === null) return false;
    drivePlayer.stop();
    return was === annId;
  };

  const playSlice = (ann: Detection) => {
    const a = audioRef.current;
    if (!a) return;
    if (stopDrivePassage(ann.id)) return;
    if (playingIdRef.current === ann.id) { a.pause(); return; }
    sliceEndRef.current = ann.end ?? session.duration;
    // Through seekTo, so this gesture gets the same floor: playing a slice
    // must light its own tune, not the one that ends where it begins.
    seekTo(ann.start);
    void a.play().catch(() => setPlayingId(null));
    setPlayingId(ann.id);
  };

  /** Seconds under a pointer x, from the strip's own box. */
  const timeAtX = (clientX: number): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * session.duration;
  };

  const seekTo = (tSec: number, follow = true) => {
    const a = audioRef.current;
    if (a) { a.currentTime = tSec; seekFloorRef.current = tSec; }
    // Applied here too, not only from the audio events: with the audio
    // forgotten nothing would ever fire them, and the strip is still a map.
    applyHead(tSec, follow);
  };

  /** "I mean THIS detection" — mark it, put the head at its start, bring its
   *  row to the middle.
   *
   *  One function because there is one gesture: clicking a segment on the strip
   *  and following a card's "detected in" link are the same act, expressed
   *  through different surfaces. They were briefly two code paths doing the
   *  same three things, which is one path too many.
   *
   *  The mark is what `lit` cannot give: landing on a detection's start usually
   *  lights two, since detections overlap at most joins, and "what covers this
   *  instant" cannot answer "which one did I pick". It stands down at the next
   *  gesture, like any transient answer.
   *
   *  Scrolled after paint, because arriving from a link happens before the row
   *  exists — and instantly in that case, a smooth scroll from the top of a
   *  long list being an animation nobody asked to watch.
   *
   *  `null` marks and places without scrolling, for a back to a page whose
   *  own offset is being restored. */
  const goToAnn = (ann: Detection, behavior: ScrollBehavior | null = 'smooth') => {
    setTargetId(ann.id);
    // The Focus view shows the one pointed at, not its lit neighbour.
    focusIdRef.current = ann.id;
    seekTo(ann.start, behavior !== null);
    if (behavior === null || showsFocus(analysisView.value)) return;
    requestAnimationFrame(() => {
      listWrapRef.current?.querySelector(`[data-ann-id="${ann.id}"]`)?.scrollIntoView({ behavior, block: 'center' });
    });
  };

  // Arriving from a "detected in" link does exactly what clicking that segment
  // on the strip does — `seekTo` then scroll — because that is the gesture the
  // link stands for, and anything less would leave the arrival half-done.
  //
  // `seekTo` unconditionally, NOT only when there is audio: it guards the
  // element itself and always moves the visual head, which is what lights the
  // row. That matters here more than anywhere, because the recording is loaded
  // asynchronously — at this instant the element usually has no source yet,
  // even for a session that has one, so testing for it lit nothing at all.
  //
  // The amber mark on top of that answers the one question the strip cannot:
  // which of the detections lit by this instant is the one that was clicked.
  //
  // Except for the scroll on a back: the link stays in the route, and the
  // reader had left the page somewhere else since.
  useEffect(() => {
    const ann = annotationId ? session.annotations.find(a => a.id === annotationId) : undefined;
    if (ann) goToAnn(ann, returningToOffset() ? null : 'auto');
    // eslint-disable-next-line
  }, [annotationId, session.id]);

  // …and once the recording finishes loading, the element is put where the head
  // already is. Without this, pressing play after following a link would start
  // from the top while the head says otherwise. Only while the mark still
  // stands: past the first gesture the head belongs to the user.
  useEffect(() => {
    if (!audioUrl || targetId === null) return;
    const ann = session.annotations.find(a => a.id === targetId);
    if (ann) seekTo(ann.start, false);
    // eslint-disable-next-line
  }, [audioUrl]);

  // The list follows the head: whatever is lit stays in the middle of the
  // screen, so the reading is legible without chasing it.
  //
  // `lit` is a fresh object only when the reading actually changed (applyHead
  // compares a key first), so this runs a couple of times per tune rather than
  // four times a second. A silence is a place too — when the head stands in one
  // it is the gap row that gets centred.
  useEffect(() => {
    const wrap = listWrapRef.current;
    // The Focus view has no list to follow: it shows the lit tune in place.
    if (!wrap || !lit.follow || showsFocus(analysisView.value)) return;
    const sel = lit.gapFrom !== null ? `[data-gap-from="${lit.gapFrom}"]`
      : lit.ids.length > 0 ? `[data-ann-id="${lit.ids[0]}"]`
      : null;
    if (sel) wrap.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [lit]);

  // One gesture, read at pointerup: a drag scrubs, a plain click on a segment
  // jumps to that tune's start and selects it, a plain click on the background
  // seeks where you pointed. Deciding at the end is what lets the same press
  // start either a scrub or a click without the two fighting.
  const onBarDown = (e: PointerEvent) => {
    dropTarget();
    const bar = barRef.current;
    if (!bar) return;
    bar.setPointerCapture(e.pointerId);
    dragRef.current = { moved: false, annId: (e.target as HTMLElement).dataset?.seg ?? null };
  };
  const onBarMove = (e: PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current.moved = true;
    seekTo(timeAtX(e.clientX));
  };
  const onBarUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    barRef.current?.releasePointerCapture(e.pointerId);
    if (d.moved) return;                       // scrub: already where it should be
    // Second click of a double: stand down, onBarDoubleClick is about to place
    // the head exactly. Jumping to the tune's start twice would only make the
    // list restart its smooth scroll for nothing.
    const now = Date.now();
    const isSecond = now - lastClickRef.current < DOUBLE_CLICK_MS;
    lastClickRef.current = now;
    if (isSecond) return;
    const ann = d.annId ? session.annotations.find(x => x.id === d.annId) : undefined;
    // A click on the background points at no tune, so it seeks and leaves the
    // mark cleared by onBarDown.
    if (ann) goToAnn(ann); else seekTo(timeAtX(e.clientX));
  };

  // Two readings of the same strip: a click means "this tune", a double-click
  // means "this instant". Deliberately NOT arbitrated by waiting to see whether
  // a second click follows — that would put nearly half a second of lag on
  // every single click, which is the common gesture. The head snaps to the
  // tune's start and then, if a second click comes, refines to the exact point.
  const onBarDoubleClick = (e: MouseEvent) => seekTo(timeAtX(e.clientX));

  // previewBound lived here until 2026-09-20: three seconds of audio played at
  // a bound the user could not see, which was the whole of the old adjustment's
  // feedback. The bound editor listens around the bound in a loop, against a
  // waveform, so there is nothing left for it to do.

  // A debugging aid, offered only in developer mode: a first-time user took
  // it for the list of tunes (2026-10-23). See devMode.ts.
  const dump = !devMode.value ? null
    : lastImportDump.value?.sessionId === session.id ? lastImportDump.value
    : lastLiveDump.value?.sessionId === session.id ? lastLiveDump.value
    : null;

  /** Writes the neighbour bounds that travelled with an edited one — a join
   *  two detections share moves on both sides at once (2026-09-21). Returns
   *  what each one looked like before, which is what re-cutting its clip needs.
   *
   *  A no-op edit is skipped rather than recorded: linking is ON by default, so
   *  every save on a joined detection reports twins, and most of those saves
   *  never moved the join at all. */
  const applyTwinEdits = (twins: TwinEdit[]): Array<{ ann: Detection; previous: { start: number; end: number | null } }> => {
    const moved: Array<{ ann: Detection; previous: { start: number; end: number | null } }> = [];
    for (const edit of twins) {
      const target = session.annotations.find(a => a.id === edit.id);
      if (!target) continue;
      const current = edit.edge === 'start' ? target.start : (target.end ?? session.duration);
      if (Math.abs(current - edit.t) < 0.001) continue;
      const previous = { start: target.start, end: target.end };
      if (edit.edge === 'start') target.start = edit.t; else target.end = edit.t;
      moved.push({ ann: target, previous });
    }
    return moved;
  };

  /** Everything a moved bound drags behind it, for every detection that just
   *  moved — its review entry, then its attached clip. In the background: the
   *  bounds themselves are already saved, so there is nothing to wait for.
   *
   *  The re-pin comes first and runs whatever the recording's fate: it needs
   *  no audio, and it is the one that guards a rating already given. The
   *  re-cut needs the recording, so it simply does not happen on a device that
   *  no longer holds it — a clip cut from nothing would be worse than a stale
   *  one. */
  const settleMoved = async (moved: Array<{ ann: Detection; previous: { start: number; end: number | null } }>) => {
    await settleSets();
    if (moved.length === 0) return;
    let changed = false;
    for (const { ann: target, previous } of moved) {
      changed = await repinReviewEntry(ctx, session, target, previous).catch(() => false) || changed;
    }
    const blob = await loadSessionAudio(session.id).catch(() => undefined);
    if (blob) {
      for (const { ann: target, previous } of moved) {
        changed = await recutAttachedClip(ctx, session, target, previous, blob).catch(() => false) || changed;
      }
    }
    if (changed) bump();
  };

  /** Fills a hole the recogniser left: a tune played here and never
   *  recognised (2026-09-21, user request). The hole seeds the bounds, so the
   *  common case is to listen, name and add without touching them.
   *
   *  Inserted at its place in playing order rather than appended: the list,
   *  the timeline and withGaps all read `annotations` as sorted by start, and
   *  the merge/delete controls address a detection by its index in it. */
  const addDetectionIn = (from: number, len: number) => {
    audioRef.current?.pause();
    showAddDetection({
      seed: { start: from, end: from + len },
      anns: session.annotations,
      duration: session.duration,
      getAudio: () => loadSessionAudio(session.id),
      onAdd: (detection, twins) => {
        session.annotations.splice(insertionIndex(session.annotations, detection.start), 0, detection);
        const moved = applyTwinEdits(twins);
        persist();
        bump();
        void settleMoved(moved);
      },
    });
  };

  // What this device shows of an analysis (analysisView.ts). The callbacks a
  // view leaves out are simply not handed to the cards, which then draw no
  // control for them.
  const view = analysisView.value;
  const details = showsDetails(view);
  const editing = showsEditing(view);
  /** The holes under a silence row's length, and the overlaps — the editor
   *  view's (2026-10-31, the user: every hole shown there). */
  const shortGaps = editing ? shortGapsOf(session.annotations, session.duration) : null;
  const study = analysisStudy.value;
  const focusOn = showsFocus(view);

  /** What the Focus view shows: wherever the head stands, as the list lights
   *  it. A silence when it stands in one; of several tunes lit across a join,
   *  the one already shown, else the last to start (the one being entered);
   *  where nothing is lit — a hole too short to be a silence, or nothing
   *  played yet — the last one shown, else the first. */
  const focusSpot = ((): FocusSpot => {
    const anns = session.annotations;
    if (lit.gapFrom !== null) {
      const gap = withGaps(anns, session.duration).find((x): x is Extract<typeof x, { kind: 'gap' }> => x.kind === 'gap' && x.from === lit.gapFrom);
      if (gap) return { kind: 'gap', gap };
    }
    const held = focusIdRef.current;
    const id = lit.ids.length > 0
      ? (held !== null && lit.ids.includes(held) ? held : lit.ids[lit.ids.length - 1]!)
      : (held !== null && anns.some(a => a.id === held) ? held : anns[0]?.id);
    if (!id) return null;
    focusIdRef.current = id;
    return { kind: 'ann', id };
  })();

  /** The Focus view's arrows and set names: the head goes to that tune's start,
   *  as a click on its segment does. */
  const focusGo = (ann: Detection) => {
    dropTarget();
    focusIdRef.current = ann.id;
    seekTo(ann.start);
    bump();
  };

  const cardOptsFor = (ann: Detection, i: number): DetectionCardOptions => ({
    ctx,
    details,
    study,
    // No ▶ at all when the recording is neither here nor on Drive.
    // From the recording the player has — stored here or brought down for
    // this visit — else straight from Drive, the passage alone.
    onPlay: playUrl ? playSlice : synced ? (a) => { void drivePlayer.play(session.id, a); } : undefined,
    // A passage from Drive goes on playing when the recording arrives under it:
    // its ▶ still says ■ until it is stopped.
    playingId: playUrl ? (playingId ?? drivePlayer.playingId) : drivePlayer.playingId,
    playFromDrive: !playUrl && !!synced,
    playLoadingId: playUrl ? null : drivePlayer.loadingId,
    sessionStartMs: session.date === null ? undefined : Date.parse(session.date),
    sessionId: session.id,
    onOpenCard,
    onCardAdded: bump,
    // The curve is worked out from the recording: only when it is here.
    onTempo: audioUrl ? (a) => showDetectionTempo(a, { audio: () => loadSessionAudio(session.id) }) : undefined,
    getPinnedDeckIds: () => pinnedDeckIdsRef.current,
    onToggleLike: (id) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      target.liked = !target.liked;
      persist();
      bump();
    },
    // No engine to delegate to for a finished session — same mutate-in-place
    // + persist() pattern as onToggleLike above, through the same
    // alternatePickFields both engines use, so a confirmation means exactly
    // the same thing here as it does on a live one.
    onSelectAlternate: (id, pick) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      Object.assign(target, alternatePickFields(target, pick));
      persist();
      bump();
    },
    onAddManualAlternate: (id, tune) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      target.manualAlternates = withManualAlternate(target, tune);
      persist();
      bump();
    },
    onRemoveManualAlternate: (id, tuneId) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      Object.assign(target, manualAlternateRemovalFields(target, tuneId));
      persist();
      bump();
    },
    // Bound adjustment lives in its own screen now (2026-09-20) — the ±5 s
    // steppers that used to sit here are gone from the summary. They asked for
    // a correction of about a second in steps of five, played blind, and wrote
    // every press straight to disk. See BoundEditor.tsx.
    //
    // The summary's own player is stopped on the way in: the editor listens
    // through an element of its own, and two players on the same recording
    // would talk over each other from behind a modal.
    // Only while the recording is on this device (2026-09-21, user request):
    // a bound is placed by ear, so with nothing to listen to there is no
    // adjusting to be done — the range goes back to being plain text, and the
    // player area above already says where the recording is. Same reason the
    // gap rows stop offering to add a detection.
    onEditBounds: !audioUrl || !editing ? undefined : () => {
      audioRef.current?.pause();
      showBoundEditor({
        ann,
        anns: session.annotations,
        duration: session.duration,
        getAudio: () => loadSessionAudio(session.id),
        pauses: session.pauses,
        onSave: (edit) => {
          const previous = { start: ann.start, end: ann.end };
          ann.start = edit.start;
          ann.end = edit.end;
          const stood = Math.abs(previous.start - ann.start) < 0.001
            && Math.abs((previous.end ?? -1) - (ann.end ?? -1)) < 0.001;
          // The edited detection travels with the neighbours a join carried
          // along — a frontier that moved on one side only is exactly the hole
          // or the overlap the link exists to prevent. All of them settle the
          // same way afterwards (rating, then clip), so they go in one list.
          const moved = [
            ...(stood ? [] : [{ ann, previous }]),
            ...applyTwinEdits(edit.twins),
          ];
          persist();
          bump();
          void settleMoved(moved);
        },
      });
    },
    // Download/attach clip — hidden (download) or reduced to just the
    // "already attached" label (attach) once the session's audio has been
    // forgotten (nothing left to extract from). On the meta line since
    // 2026-09-20: a clip is a cut of the very stretch that line names.
    metaActions: () => (
      <ClipControls ann={ann} session={session} audioAvailable={!!audioUrl} getAudio={() => loadSessionAudio(session.id)} ctx={ctx} onAttached={bump} />
    ),
    // Score following (2026-10-28): the score of the version the recogniser
    // heard, its cursor following this recording — from Drive when that is
    // where the recording is. Both of the summary's players stop first, same
    // reason as the bound editor's.
    follow: {
      here: !!audioUrl,
      beforeOpen: () => { audioRef.current?.pause(); drivePlayer.stop(); },
    },
    // Confirmed: the row carries hand-made work (bound adjustments, alternate
    // picks, attached clips) and there is no undo.
    onDelete: !editing ? undefined : () => confirmModal(
      t('sessions.detection.delete.title'),
      t('sessions.detection.delete.message', { name: ann.displayName }),
      t('common.delete'),
      () => {
        // Its passage stops with it — often the very reason for deleting
        // (listened to, found to be talk) — and its card, the only stop button
        // it had, is about to go. Only ITS passage: any other playback stands.
        if (playingIdRef.current === ann.id) audioRef.current?.pause();
        if (drivePlayer.playingId === ann.id) drivePlayer.stop();
        session.annotations.splice(i, 1);
        persist();
        bump();
        // The rating goes with it (user's rule, 2026-09-23): it said this tune
        // was played here, and deleting the detection says it was not. Nothing
        // like deleting the whole analysis, where the playing stands.
        // Then the set it was in, whose span may just have shrunk — one write
        // after the other, never side by side.
        void (async () => {
          if (await dropReviewEntry(ctx, session, ann)) bump();
          await settleSets();
        })();
      },
    ),
    // All that is left of the third row, and it only appears when there is
    // something to merge WITH — the same tune detected twice in a row, which
    // is a false set change. Every other card is now two lines.
    // In the same key only (user's rule, 2026-11-08): the same tune played again
    // in another key is two playings, cut so on purpose (pitchSplit.ts).
    extraControls: () => {
      const prev = session.annotations[i - 1];
      if (!editing || !prev || prev.tuneId !== ann.tuneId || !samePlayedPitch(prev, ann)) return null;
      return (
        <button
          class="text-[11px] text-accent hover:underline cursor-pointer"
          onClick={() => {
            // A merge moves a bound like any other edit — the survivor takes
            // over the other's end — so its rating and its clip settle the
            // same way. On top of that the detection merged AWAY may carry a
            // rating of its own, which the survivor inherits (or, if it was
            // rated too, which goes: one tune, one playing, one review).
            const previous = { start: prev.start, end: prev.end };
            const absorbedEnd = ann.end;
            prev.end = ann.end;
            prev.evidence = [...prev.evidence, ...ann.evidence];
            prev.confidence = Math.max(prev.confidence, ann.confidence);
            prev.bucket = prev.confidence >= 0.7 ? 'high' : prev.confidence >= 0.5 ? 'medium' : 'low';
            session.annotations.splice(i, 1);
            persist();
            bump();
            // One after the other, never side by side: each writes the shared
            // state through its own mutate, and two of those in flight at once
            // would each be working from the state as it was before the other.
            void (async () => {
              await settleMoved([{ ann: prev, previous }]);
              if (await absorbReviewEntry(ctx, session, ann, absorbedEnd, prev)) bump();
            })();
          }}
        >
          {t('sessions.merge')}
        </button>
      );
    },
  });

  /** One detection's row — alone in the list, or inside its set. A plain
   *  function returning a vnode, never a component declared here (see
   *  ClipControls' `slot` for why that matters). */
  /** `withHole`: draws the short hole above it — false for the first tune of
   *  a set or a tune alone, whose hole goes BETWEEN the items (listItem): a
   *  hole that breaks a set is not inside either. */
  const annRow = (ann: Detection, i: number, withHole = true) => {
    const card = (
      <div
        key={ann.id}
        data-ann-id={ann.id}
        // The answer to "which one did I just scroll to": the card is
        // ringed, not merely centred among identical neighbours.
        class={`rounded-lg transition-shadow ${
          ann.id === targetId ? 'ring-2 ring-warn'
          : lit.ids.includes(ann.id) ? 'ring-2 ring-accent' : ''}`}
      >
        <DetectionCard ann={ann} opts={cardOptsFor(ann, i)} />
      </div>
    );
    // The hole above it no silence row shows (developer mode).
    const hole = withHole ? shortGaps?.get(ann.id) : undefined;
    return hole ? <Fragment key={ann.id}>{shortGapRow(hole)}{card}</Fragment> : card;
  };

  /** One item of the list: a set, a tune alone, a silence — with the short
   *  hole before its first tune, when there is one, drawn before it. */
  const listItem = (item: ListGap | ListAnn | ListChain | { kind: 'ann'; ann: Detection; i: number }) => {
    const node = item.kind === 'chain' ? cutMark(item, (
      <TunesetDetectionCard
        key={`set-${item.members[0]!.ann.id}`}
        chain={item.members.map(m => m.ann)}
        opts={setOptsFor(item.members.map(m => m.ann))}
      >
        {setRows(item.rows, r => annRow(r.ann, r.i, r !== item.rows[0]), g => gapRow(g, true), editing ? setOpens : undefined, hasShortGap)}
      </TunesetDetectionCard>
    ))
      : item.kind === 'gap' ? gapRow(item, false)
      // The set marks — unjoin, join — are edits: the editor view's.
      : 'cut' in item ? cutMark(item, annRow(item.ann, item.i, false))
      : annRow(item.ann, item.i, false);
    const firstId = item.kind === 'chain' ? item.members[0]!.ann.id : item.kind === 'ann' ? item.ann.id : null;
    const hole = firstId ? shortGaps?.get(firstId) : undefined;
    return hole ? <Fragment key={`hole-${firstId}`}>{shortGapRow(hole)}{node}</Fragment> : node;
  };

  /** A cut, a link, or the rule again — see model.ts's opensSet. The sets on
   *  either side move with it, and drag their rating and clip (settleSets). */
  const setOpens: SetOpens = (id, opens) => {
    const target = session.annotations.find(a => a.id === id);
    if (!target) return;
    if (opens === undefined) delete target.opensSet; else target.opensSet = opens;
    persist();
    bump();
    void settleSets();
  };

  /** The lit unjoin mark above a tune or a set — in the editor view only. */
  const cutMark = (item: ListAnn | ListChain, node: ComponentChild) => (editing ? withCutMark(item, node, setOpens, hasShortGap) : node);

  /** Whether a detection has a short hole's row above it — which then
   *  carries the set mark of that join, instead of the card's seam. */
  const hasShortGap = (id: string) => !!shortGaps?.has(id);

  /** A hole too short for a silence row, or an overlap, drawn above the
   *  tune after it, in a set or not — it breaks nothing. Read, not worked on
   *  (2026-11-01, the user): no giving it away, and nothing to add in a few
   *  seconds — a detection is offered from GAP_MIN_S up, on silence rows.
   *  The set mark of the join, though, as on every join (2026-11-01, the
   *  user): no silence here, so the two tunes are one set unless cut — the
   *  unjoin button, lit when the user cut. */
  const shortGapRow = (hole: ShortGap) => {
    const cut = session.annotations.find(a => a.id === hole.nextId)?.opensSet === true;
    return (
      <div class="flex items-center gap-3 py-0.5 text-[11px] text-dim">
        <span class="h-px flex-1 bg-border" />
        <span class="shrink-0 px-1 tabular-nums">
          {hole.len > 0 ? t('sessions.gap', { d: fmtLongTime(hole.len) }) : t('sessions.overlap', { d: fmtLongTime(-hole.len) })}
        </span>
        <span class="h-px flex-1 bg-border" />
        {setsOn && (
          <span class="mr-3 flex">
            <SetMarkButton kind="unlink" active={cut} onClick={() => setOpens(hole.nextId, cut ? undefined : true)} />
          </span>
        )}
      </div>
    );
  };

  /** A silence row — between two sets, or inside one linked across it.
   *
   *  What the timeline shows as a hole and the list used to swallow whole:
   *  read end to end, the cards otherwise describe one unbroken concert.
   *
   *  And, since 2026-09-21, the way to fill one: a tune can have been played
   *  here and never recognised. The row is the control because it is the only
   *  thing on the screen that both names the gap and sits in it — a button
   *  elsewhere would have to say which hole it meant. The whole row is the
   *  target, which on a phone is a comfortable strip, and the ⊕ is what says so
   *  without a hover anyone can have (see hoverOnlyWhenSupported). A set linked
   *  across it keeps it all the same (the user's call, 2026-10-20). */
  const gapRow = (item: ListGap, inSet: boolean) => (
    <div
      key={`gap-${item.from}`}
      data-gap-from={item.from}
      // Lit like a card when the head stands in it: a silence is a place in
      // the recording too, and "you are here" has to be answerable there as
      // well.
      class={`flex items-center gap-3 py-1 text-[11px] transition-colors ${
        lit.gapFrom === item.from ? 'text-accent' : 'text-dim'}`}
    >
      <span class={`h-px flex-1 ${lit.gapFrom === item.from ? 'bg-accent/50' : 'bg-border'}`} />
      {/* Filled in the editor view only: outside it a silence
          is read, not worked on (analysisView.ts). */}
      {audioUrl && editing ? (
        <span class="shrink-0 inline-flex items-center gap-1">
          <button
            class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 tabular-nums hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
            title={t('sessions.addDetection.hint')}
            onClick={() => addDetectionIn(item.from, item.len)}
          >
            <PlusIcon size={9} />
            {t('sessions.gap', { d: fmtLongTime(item.len) })}
          </button>
        </span>
      ) : (
        <span class="shrink-0 tabular-nums">{t('sessions.gap', { d: fmtLongTime(item.len) })}</span>
      )}
      <span class={`h-px flex-1 ${lit.gapFrom === item.from ? 'bg-accent/50' : 'bg-border'}`} />
      {item.nextId && editing && (
        <span class="mr-3 flex">
          <SetMarkButton kind="link" active={inSet} onClick={() => setOpens(item.nextId!, inSet ? undefined : false)} />
        </span>
      )}
    </div>
  );

  /** A set played as a whole: one passage from its first tune's start to its
   *  last tune's end, under its own id so its ▶ is the only one lit. */
  const chainAsAnn = (chain: Detection[]): Detection => ({ ...chain[0]!, id: chainPlayId(chain), ...chainSpan(chain, session.duration) });

  const setOptsFor = (chain: Detection[]): TunesetCardOptions => {
    const record = records.find(r => r.detectionIds.length === chain.length && r.detectionIds.every((id, k) => id === chain[k]!.id));
    return {
      ctx,
      session,
      record,
      details,
      study,
      onOpenCard,
      getPinnedDeckIds: () => pinnedDeckIdsRef.current,
      onChanged: bump,
      onPlay: playUrl ? (c) => playSlice(chainAsAnn(c)) : synced ? (c) => { void drivePlayer.play(session.id, chainAsAnn(c)); } : undefined,
      playingId: playUrl ? (playingId ?? drivePlayer.playingId) : drivePlayer.playingId,
      playFromDrive: !playUrl && !!synced,
      playLoadingId: playUrl ? null : drivePlayer.loadingId,
      sessionStartMs: session.date === null ? undefined : Date.parse(session.date),
      onToggleLike: (r) => {
        const target = session.tunesets?.find(x => x.id === r.id);
        if (!target) return;
        if (target.liked) delete target.liked; else target.liked = true;
        persist();
        bump();
      },
      clip: { audioAvailable: !!audioUrl, getAudio: () => loadSessionAudio(session.id) },
    };
  };

  // The session's own name, nothing computed: what the library calls this
  // recording is what the downloaded file is called — accents and spaces
  // included since 2026-10-16; downloadBlob takes out only what no
  // filesystem accepts (they all became "_" before).
  const fileBase = session.name || 'session';

  /** Hands the stored recording over exactly as it is (2026-09-14).
   *
   *  It used to be converted to MP3 on the way out, for players that cannot open
   *  a webm. Measured, that conversion ran at about 5× realtime in the browser —
   *  a quarter of an hour for an hour of session, and a phone that froze on a
   *  long one — while the file itself is ready at once. The original won.
   *
   *  The extension comes from the recorded type. Only a file that type says
   *  nothing about (an import the browser could not type) is identified from its
   *  content. It used to be the type's subtype verbatim, which named an MP3
   *  `.mpeg` and an untyped import `.octet-stream`. */
  const saveFile = async (blob: Blob) => {
    let ext = audioExtension(blob.type || session.mimeType);
    if (ext === 'bin') ext = (await detectAudioFile(blob))?.extension ?? ext;
    downloadBlob(blob, `${fileBase}.${ext}`);
  };
  /** The file, from wherever it is: stored here, or from Drive — the copy
   *  brought down for this visit, or one brought down now (its progress on the
   *  player's ▶), and kept for the rest of the visit, not stored. */
  const downloadAudio = () => {
    if (downloading) return;
    setDownloading(true);
    void (audioUrl ? loadSessionAudio(session.id) : fetchTemp())
      .then(blob => (blob ? saveFile(blob) : undefined))
      .finally(() => setDownloading(false));
  };

  // A recording on a Drive this device is connected to — the only kind it can
  // reach without having it.
  const reachable = !!synced && driveOn;

  /** Re-analysing, confirmed: it replaces the list. On the recording stored
   *  here; else on the one brought down for this visit; else on one brought
   *  down for it now, behind a window that can be cancelled — and in neither
   *  case stored here (2026-11-05, the user's call). */
  const reanalyze = () => confirmModal(
    t('sessions.reanalyze.title'), t('sessions.reanalyze.message'), t('sessions.reanalyze.confirm'),
    () => {
      if (audioUrl) onReanalyze();
      else if (temp) onReanalyze(temp.blob);
      else fetchForReanalysis();
    },
  );

  const fetchForReanalysis = () => {
    const progress = signal(0);
    const abort = new AbortController();
    const { el, cleanup } = renderModalBody(<DriveFetchBody progress={progress} bytes={synced?.bytes ?? 0} />);
    const close = () => { closeModalOf(el); cleanup(); };
    showModal(t('sessions.reanalyze.fetch.title'), el, [
      { label: t('common.cancel'), onClick: () => { abort.abort(); close(); } },
    ], { onDismiss: () => { abort.abort(); cleanup(); } });
    void downloadSyncedAudioOnce(session.id, (f) => { progress.value = f; }, abort.signal)
      .then(blob => {
        if (abort.signal.aborted) return;
        close();
        if (!blob) { alertModal(t('sessions.syncAudio.gone.title'), t('sessions.syncAudio.gone.message')); return; }
        onReanalyze(blob);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        close();
        failedTransfer(e);
      });
  };
  /** Nothing is offered that would start a second transfer over one in
   *  flight: this screen's own, the automatic copy, or a download. */
  const transferring = busySync || driveAudioState === 'uploading' || tempProgress !== null || downloadProgress !== undefined;

  /** The analysis's ⋯ menu (2026-11-05, the user's design): its export, then
   *  what can be done with its recording, under a heading — the library's ⋯
   *  groups its entries the same way. In words, each one: the four unlabelled
   *  icons it replaces were passed by a tester looking for exactly these.
   *  Only what applies NOW is listed. Re-analysing is red with the deletions:
   *  it replaces the list, confirmed, with no undo. */
  const titleMenu: ContextMenuEntry[] = [
    { label: t('sessions.menu.export'), icon: <UploadIcon size={14} />, onClick: () => showShareSessionModal(session) },
    // Out of the audio block (the user's call): it acts on the analysis, the
    // recording is only what it reads.
    ...(audioUrl || temp || (reachable && !transferring) ? [{
      label: t('sessions.menu.reanalyze'), icon: <ResetIcon size={14} />, danger: true, onClick: reanalyze,
    }] : []),
    ...(audioUrl || reachable ? [{ heading: t('sessions.menu.audio') }] : []),
    ...((audioUrl || reachable) && !downloading && (audioUrl || !transferring) ? [{
      label: t('sessions.menu.download'),
      icon: <span class="flex items-center" dangerouslySetInnerHTML={{ __html: downloadIcon(14) }} />,
      onClick: downloadAudio,
    }] : []),
    ...(!audioUrl && reachable && !transferring ? [{
      label: t('sessions.menu.keepHere', { size: formatBytes(synced!.bytes) }),
      icon: <span class="flex items-center" dangerouslySetInnerHTML={{ __html: downloadIcon(14) }} />,
      onClick: keepHere,
    }] : []),
    ...(audioUrl && driveOn && !synced && !transferring ? [{
      label: t('sessions.menu.upload'), icon: <CloudUpIcon size={14} />, onClick: uploadToDrive,
    }] : []),
    ...(audioUrl ? [{
      label: t('sessions.menu.forgetHere'), icon: <TrashIcon size={14} />, danger: true, onClick: forgetHere,
    }] : []),
    ...(reachable && !transferring ? [{
      label: t('sessions.menu.removeDrive'), icon: <TrashIcon size={14} />, danger: true, onClick: removeFromDrive,
    }] : []),
  ];

  /** The timeline — the strip of detections, which IS the seek bar. A function
   *  returning elements rather than a component: one defined in this render
   *  would be a new type at each one, and remount (the dead-button trap). It
   *  sits on the player's line, or on a line of its own without a player.
   *  Remounted when it moves from one to the other, its head is drawn where
   *  it last stood rather than back at the start: the playback events move it
   *  straight in the DOM (applyHead), and that position is what a render
   *  writes too, so the two never disagree. */
  const timeline = (placement: string) => (
    <div
      ref={barRef}
      class={`relative h-5 rounded bg-elevated overflow-hidden cursor-pointer touch-none select-none ${placement}`}
      onPointerDown={onBarDown}
      onPointerMove={onBarMove}
      onPointerUp={onBarUp}
      onPointerCancel={onBarUp}
      onDblClick={onBarDoubleClick}
    >
      {session.annotations.map((ann, i) => {
        const end = ann.end ?? session.duration;
        const isCurrent = lit.ids.includes(ann.id);
        return (
          <div
            key={ann.id}
            data-seg={ann.id}
            class={`absolute top-0 bottom-0 transition-[filter,box-shadow] ${isCurrent ? 'brightness-150 z-[1]' : 'hover:brightness-125'}`}
            style={{
              left: `${(ann.start / session.duration) * 100}%`,
              // Exact width, with a floor in PIXELS rather than in percent:
              // a percentage floor widened short tunes into a lie, and a lie
              // the play head is about to walk across and contradict. Two
              // pixels keep a very short detection clickable without moving
              // where it starts.
              width: `${((end - ann.start) / session.duration) * 100}%`,
              minWidth: '2px',
              backgroundColor: BUCKET_SEGMENT[ann.bucket],
              backgroundImage: HATCH[i % 2],
              ...(isCurrent ? { boxShadow: 'inset 0 0 0 1.5px var(--color-primary)' } : {}),
            }}
            title={ann.displayName}
          />
        );
      })}
      {/* Above the segments, and deaf to pointers so a click lands on the
          segment underneath rather than on the head itself. */}
      <div
        ref={headRef}
        class="absolute top-0 bottom-0 w-0.5 bg-primary pointer-events-none z-[2]"
        style={{ left: `${Math.min(100, (headTimeRef.current / (session.duration || 1)) * 100)}%` }}
      />
    </div>
  );

  /** The player's ▶ badge with the recording only on Drive: a cloud, then the
   *  download's percentage — this visit's, or the background one that got
   *  there first (audioDownloads.ts). */
  const comingFromDrive = !playUrl ? (tempProgress ?? downloadProgress ?? null) : null;

  return (
    <>
      <TitleRow
        getName={() => session.name}
        getDefaultName={() => session.name}
        onRename={(val) => { session.name = val; persist(); }}
        // deleteSession resolves only once the recording is cleared, Drive
        // included — long enough to have gone elsewhere meanwhile. Turning
        // round from THAT page would be a step nobody asked for; the entry
        // left behind is stepped over anyway (store.ts, popstate).
        onDelete={() => {
          const here = navEntry.value;
          void deleteSession(session.id).then(() => { if (navEntry.value === here) leaveDeletedPage(); });
        }}
        menu={titleMenu}
        hasNotes={!!session.notes?.trim()}
        onNotes={() => showAnalysisNotesModal(session.notes ?? '', (notes) => {
          if (notes.trim()) session.notes = notes; else delete session.notes;
          persist();
          bump();
        })}
      />
      <AnalysisFolderPicker ctx={ctx} sessionId={session.id} />
      <DateRow
        getDate={() => session.date}
        setDate={(date) => {
          const previousDate = session.date;
          session.date = date;
          persist();
          // Every rating of this session is filed at "this date plus where the
          // tune ended", so moving the date moves all of them — and the picker
          // only offers minutes, which means re-choosing what looks like the
          // same date still lands seconds away from it.
          void (async () => {
            if (await repinSessionDate(ctx, session, session.annotations, previousDate)) bump();
            // The sets' ratings are filed the same way, so they move too.
            if (date === null || previousDate === null) return;
            const from = Date.parse(previousDate), to = Date.parse(date);
            if (Number.isNaN(from) || Number.isNaN(to)) return;
            let moved = false;
            for (const r of session.tunesets ?? []) {
              const now = setNow(r.detectionIds);
              const setCard = now ? setCardFor(now.tuneIds, getContext().user.cards) : undefined;
              if (!now || !setCard) continue;
              moved = await repinSetReview(ctx, setCard.id, setReviewId(session.id, r.id),
                { startMs: from, end: now.span.end }, { startMs: to, end: now.span.end }) || moved;
            }
            if (moved) bump();
          })();
        }}
        onChange={bump}
      />

      <audio ref={audioRef} class="hidden" src={playUrl ?? undefined} />
      <audio {...drivePlayer.audioProps} />

      {/* Transport and timeline travel together, pinned to the top: the strip
          is the reference you navigate BY, and scrolling the list used to take
          it off the screen at the exact moment you had just clicked it. */}
      {/* What is done WITH the recording — download, copy, re-analyse,
          delete — is in the title's ⋯ menu; the bar only plays it. */}
      {/* Spans everything below, not just the bar: a sticky element can only
          travel within its own parent, so a wrapper cut to the bar's height
          would let it scroll away immediately — which is exactly what it did. */}
      <div class="relative">
        {/* `top-0` rather than a negative offset that cancels the page's own
            padding: the bar then pins at the scrollport edge and its `pt-3`
            shows in both states, so the room above the controls is the same
            number pinned and at rest — it cannot drift apart. And `pt-3`
            matches the `mt-3` between the player and the views, and the `pb-3`
            under them, so the bar sits in equal air throughout. Change one and
            change them all. */}
        {/* Where the bar stands at rest: once this has scrolled out of sight,
            the bar is pinned — see `pinned`. One pixel tall, given back below,
            so that it is something to intersect without moving anything. */}
        <div ref={pinMarkRef} aria-hidden="true" class="h-px -mb-px" />
        <div
          // A line under it once pinned (2026-11-05, the user's call): the list
          // then runs under the bar, and the two need telling apart. Always a
          // border, transparent at rest, so that it showing moves nothing.
          class={`sticky top-0 z-10 bg-bg -mx-6 px-6 pt-3 pb-3 border-b transition-colors ${pinned ? 'border-border' : 'border-transparent'}`}
          data-tour="summary-player"
        >
          {/* One line since 2026-11-05 (the user's call, for the room): ▶ ■,
              the timeline between them and the time. Without a player the
              timeline keeps a line of its own, still a map of the analysis. */}
          {(playUrl || reachable) ? (
            <div class="flex items-center gap-2">
              {/* With the recording only on Drive (2026-11-05, the user's
                  design): the same ▶, a cloud on it; pressed, the recording is
                  brought down for this visit — the cloud turning into its
                  percentage — and plays from where the head stands. */}
              <span class="relative shrink-0">
                <button
                  class="w-7 h-7 p-0 rounded-full flex items-center justify-center bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:cursor-default"
                  title={playUrl ? undefined : t('sessions.playFromDrive.whole', { size: formatBytes(synced?.bytes ?? 0) })}
                  aria-label={playUrl ? undefined : t('sessions.playFromDrive.whole', { size: formatBytes(synced?.bytes ?? 0) })}
                  disabled={!playUrl && (comingFromDrive !== null || busySync)}
                  onClick={() => {
                    const a = audioRef.current;
                    if (!a) return;
                    if (!playUrl) { playFromDrive(); return; }
                    if (a.paused) { stopDrivePassage(); void a.play(); } else a.pause();
                  }}
                  dangerouslySetInnerHTML={{ __html: playing ? pauseIcon(12) : playIcon(12) }}
                />
                {!playUrl && (comingFromDrive !== null ? (
                  <span class="absolute -right-2.5 -bottom-1.5 px-1 rounded bg-elevated border border-border text-[9px] leading-[13px] font-mono tabular-nums text-accent pointer-events-none">
                    {Math.round(comingFromDrive * 100)}%
                  </span>
                ) : (
                  <span class="absolute -right-1 -bottom-0.5 text-accent pointer-events-none drop-shadow-sm"><CloudIcon size={11} /></span>
                ))}
              </span>
              <button
                class="w-7 h-7 p-0 rounded-full flex items-center justify-center shrink-0 text-dim hover:text-primary transition-colors"
                onClick={() => { const a = audioRef.current; if (!a) return; a.pause(); a.currentTime = 0; }}
                dangerouslySetInnerHTML={{ __html: stopIcon(12) }}
              />
              {timeline('flex-1 min-w-0')}
              {/* Static text: the player writes it straight into the node (see
                  updateTime), and so does the effect giving the length before
                  anything is loaded. */}
              <span ref={timeLblRef} class="shrink-0 text-[11px] font-mono text-dim tabular-nums">0:00 / 0:00</span>
              {/* At the end of the line since the timeline came onto it: it used
                  to sit over that end, out of the bar, to scroll away with the
                  page — the time is there now. Pinned with the bar, then: it
                  only offers a copy, confirmed, nothing destructive. */}
              {audioUrl && driveOn && driveAudioState !== 'on' && (
                <NotOnDriveBtn state={driveAudioState} onClick={uploadToDrive} />
              )}
            </div>
          ) : (
            <>
              {/* Says why there is no player, instead of just not drawing one.
                  A session opened on another device carries its annotations
                  but not its recording, and the controls silently vanishing
                  reads as a bug — which is exactly how it was reported.

                  A copy on Drive this device can reach gets the player above,
                  its ▶ bringing it down (2026-11-05; it was a "Download the
                  audio" line here). Keeping it on the device is in the title's
                  ⋯ menu.

                  Nowhere to be had: a plain "no audio" (2026-11-04). It used to
                  say the recording "stays where it was recorded", which was
                  false for one forgotten here without a Drive copy — gone for
                  good — and hid a copy on Drive behind a disconnected Drive. */}
              <p class="text-xs text-muted">{t(synced ? 'sessions.audioOnDriveNeedsConnection' : 'sessions.noAudio')}</p>
              {timeline('mt-3')}
            </>
          )}
          {/* How much of each tune is shown, as tabs pinned with the player
              (the user's design): the view is changed while reading the list,
              wherever it is scrolled. Under the player since 2026-11-05, the
              timeline having come onto the player's line (the user's call). */}
          <div class="mt-3"><AnalysisViewBar /></div>
        </div>

        <div class="flex items-center gap-2 mt-3">
          {dump && (
            <button
              class="text-[11px] text-dim hover:text-primary hover:underline cursor-pointer ml-auto"
              onClick={() => {
                const blob = new Blob([JSON.stringify(dump.windows, null, 1)], { type: 'application/json' });
                downloadBlob(blob, `${session.name || 'session'}-windows.json`);
              }}
            >
              {t('sessions.dumpWindows')}
            </button>
          )}
        </div>

        {/* `analysis-list`: its width decides where every card's name goes
            (styles.css). */}
        <div ref={listWrapRef} class="analysis-list mt-3 space-y-2">
          {focusOn ? (
            <FocusView
              anns={session.annotations}
              spot={focusSpot}
              chains={setsOn ? chainsOf(session.annotations, session.duration) : []}
              renderCard={(ann, note) => <DetectionCard key={ann.id} ann={ann} opts={{ ...cardOptsFor(ann, session.annotations.indexOf(ann)), focus: true, focusNote: note }} />}
              onGo={focusGo}
            />
          ) : (setsOn
            ? withChains(session.annotations, session.duration)
            : withGaps(session.annotations, session.duration)
          ).map(listItem)}
        </div>
      </div>
    </>
  );
}
