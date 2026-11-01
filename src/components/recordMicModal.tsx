import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { signal, computed, type Signal } from '@preact/signals';
import type { Attachment } from '../types';
import { fileToEntry } from '../utils';
import { attachmentFor } from '../services/attachmentStore';
import { capturing } from '../services/audioSession';
import { fmtTime } from '../services/audioPresets';
import { audioExtension } from '../services/zip';
import { MicSource } from '../session/audio/sources';
import { WakeLockManager } from '../session/audio/capture';
import { pickRecorderMime } from '../session/audio/recorder';
import { MemoryRecorder } from '../thesessionEmbed/memoryRecorder';
import { appState } from '../store';
import { showModal, closeModal, renderModalBody, askUnsavedChanges } from './modal';
import { MicIcon } from './icons';
import { focusIfDesktop } from '../utils';
import { t } from '../services/i18nService';

// ── A file recorded on the spot ──────────────────────────────────────────────
// The third source behind the attachment list's "File" entry: a tune hummed,
// a phrase played, a note to self. Start, Stop — then the same button,
// reading Restart, records a new take in its place (2026-11-01, the user) —
// and the take is added like any picked file — through fileToEntry and
// attachmentFor, the one door every attachment goes through. No listening back in the dialog (the
// user's call, 2026-11-01: the phones' own recorders do not offer it either),
// and no viewer opened afterwards, which no other source does.
//
// The analyser's microphone (MicSource) for the capture, without its
// recognition worklet: it already brings the iPhone's audio session, the
// music constraints, a mono recording tap and the level meter. The take is
// held in memory (MemoryRecorder) — a few minutes of Opus, not the two hours
// the analyser's database chunks were built for.

type Phase = 'idle' | 'opening' | 'recording' | 'stopping' | 'stopped';

/** One take at a time, and the microphone held only while it records: the
 *  phone's mic indicator goes off at Stop, not at the dialog's closing. */
class Take {
  readonly phase = signal<Phase>('idle');
  readonly error = signal<string | null>(null);
  /** The file's extension: the format the recorder will ask for, then the
   *  one it actually gave. */
  readonly extension = signal(extensionOf(pickRecorderMime()));
  /** What the chrono shows once stopped. */
  durationMs = 0;
  private source: MicSource | null = null;
  private recorder: MemoryRecorder | null = null;
  private readonly wake = new WakeLockManager();
  private startedAt = 0;
  private file: Blob | null = null;
  private stopping: Promise<void> | null = null;

  /** From the tap: MicSource.open() must be reached before anything is
   *  awaited, or the iPhone's session will not allow recording. */
  start(): void {
    this.release();
    this.error.value = null;
    // The Play-along's rule: a live recording holding the microphone is not
    // taken from under it.
    if (capturing()) { this.error.value = t('fileViewer.record.error.busy'); return; }
    const source = new MicSource();
    this.source = source;
    this.phase.value = 'opening';
    source.open().then(() => {
      if (this.source !== source) return;   // closed while opening; release() stopped it
      // The microphone gone, or the system taking the sound over (a call, on
      // an iPhone): what was recorded until then is kept, as a stopped take.
      source.onEnded = () => void this.stop();
      source.onStall = (stalled) => { if (stalled) void this.stop(); };
      this.recorder = new MemoryRecorder(source.recordingStream);
      this.recorder.start();
      this.startedAt = Date.now();
      void this.wake.start();
      this.phase.value = 'recording';
    }, (err: unknown) => {
      if (this.source !== source) return;
      this.source = null;
      source.stop();
      const name = err instanceof Error ? err.name : '';
      // Safari says SecurityError where the others say NotAllowedError.
      this.error.value = name === 'NotAllowedError' || name === 'SecurityError'
        ? t('fileViewer.record.error.denied')
        : t('fileViewer.record.error.mic', { message: err instanceof Error ? err.message || err.name : String(err) });
      this.phase.value = 'idle';
    });
  }

  /** Stops the recording and keeps the take. Twice is once. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.phase.value !== 'recording') return Promise.resolve();
    const { recorder, source } = this;
    this.phase.value = 'stopping';
    this.durationMs = Date.now() - this.startedAt;
    this.wake.stop();
    this.stopping = (async () => {
      // The recorder first: closing the source's context before it has
      // handed over its last chunk would cut the end of the take.
      await recorder!.stop();
      const file = await recorder!.file();
      source!.stop();
      if (this.recorder !== recorder) return;   // released meanwhile
      this.source = null;
      this.recorder = null;
      this.file = file;
      this.extension.value = extensionOf(file.type) || this.extension.value;
      this.phase.value = 'stopped';
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  /** The take, once any recording under way has stopped; null if there is none. */
  async settle(): Promise<Blob | null> {
    await this.stop();
    return this.phase.value === 'stopped' ? this.file : null;
  }

  /** Whether leaving would lose something. */
  get holdsTake(): boolean {
    const p = this.phase.value;
    return p === 'recording' || p === 'stopping' || p === 'stopped';
  }

  elapsedMs(): number {
    const p = this.phase.value;
    if (p === 'recording') return Date.now() - this.startedAt;
    return p === 'stopping' || p === 'stopped' ? this.durationMs : 0;
  }

  level(): number {
    return this.source?.getLevel() ?? 0;
  }

  /** Drops the take and gives the microphone back. Safe in any phase. */
  release(): void {
    this.wake.stop();
    const { recorder, source } = this;
    this.recorder = null;
    this.source = null;
    this.file = null;
    this.stopping = null;
    void recorder?.stop();
    source?.stop();
    this.phase.value = 'idle';
  }
}

/** "Enregistrement 2026-11-01 14h32" — what the name box starts with; the
 *  Play-along's takes are named the same way, under their own key. */
export function stampedName(key: 'fileViewer.record.fileName' | 'fileViewer.abc.playAlong.take.fileName' = 'fileViewer.record.fileName'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return t(key, {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
  });
}

/** ".webm", or ".m4a" on an iPhone: the extension the recorder's format
 *  calls for, since a file's type is read back from its extension
 *  (audioSniff). Empty when the browser picks a format we cannot name — the
 *  real one is known at Stop, and shown then. */
function extensionOf(mimeType: string): string {
  const ext = audioExtension(mimeType);
  return ext === 'bin' ? '' : `.${ext}`;
}

/** A recorded take as an attachment, named `base` plus the extension its
 *  format calls for — through fileToEntry and attachmentFor, the one door
 *  every attachment goes through. Also the Play-along's (PlayAlongView.tsx). */
export async function recordingAttachment(file: Blob, base: string): Promise<Attachment> {
  // Without its parameters ("audio/webm;codecs=opus"): the type a picked
  // file of the same format would have been given.
  const mimeType = file.type.split(';')[0]!.trim() || 'audio/webm';
  const entry = await fileToEntry(new File([file], base + extensionOf(mimeType), { type: mimeType }));
  return attachmentFor(entry, appState.value);
}

/** The name row of a take — the dialog's own: the box, the extension fixed
 *  after it and never typed. Enter confirms. */
function TakeNameRow({ name, extension, onEnter }: { name: Signal<string>; extension: string; onEnter: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) focusIfDesktop(inputRef.current); }, []);
  return (
    <div class="flex items-center gap-3">
      <label class="label shrink-0">{t('fileViewer.record.name')}</label>
      <span class="flex items-center gap-1 flex-1 min-w-0">
        <input
          ref={inputRef}
          type="text"
          class="input text-sm py-1.5 min-w-0 flex-1"
          value={name.value}
          onInput={(e) => { name.value = (e.target as HTMLInputElement).value; }}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
        />
        <span class="text-xs font-mono text-dim shrink-0">{extension}</span>
      </span>
    </div>
  );
}

/** Names a recorded take before it is added (2026-11-01, the user: the
 *  Play-along's Keep asks for a name) — `initial` in the box. The name, or
 *  null when the dialog was left. */
export function askRecordingName(file: Blob, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const name = signal(initial);
    let done = false;
    const finish = (value: string | null) => { if (!done) { done = true; cleanup(); resolve(value); } };
    const confirm = () => {
      const value = name.value.trim();
      if (!value) return;
      closeModal();
      finish(value);
    };
    const mimeType = file.type.split(';')[0]!.trim() || 'audio/webm';
    const { el, cleanup } = renderModalBody(<TakeNameRow name={name} extension={extensionOf(mimeType)} onEnter={confirm} />);
    showModal(t('fileViewer.abc.playAlong.take.nameTitle'), el, [
      { label: t('common.add'), primary: true, disabled: computed(() => name.value.trim() === ''), onClick: confirm },
    ], { maxWidth: '24rem', onDismiss: () => finish(null) });
  });
}

/** Where a recording stands, as RecorderRow draws it. */
export type RecorderPhase = 'idle' | 'opening' | 'recording' | 'stopping' | 'stopped';

/** The recording row — the live screen's: a dot, the chrono, the level, and
 *  Start or Stop at the end. The microphone attachment's dialog and the
 *  Play-along's take draw the same one (2026-11-01, the user: « for
 *  coherence »), the Play-along's a little lower (`compact`). Stopped, the
 *  same button reads Restart: a new take in place of the one held. `after`:
 *  what follows the button — the Play-along's save. */
export function RecorderRow({ phase, elapsedMs, level, onStart, onStop, compact = false, after }: {
  phase: RecorderPhase;
  elapsedMs: () => number;
  level: () => number;
  onStart: () => void;
  onStop: () => void;
  compact?: boolean;
  after?: ComponentChildren;
}) {
  const chronoRef = useRef<HTMLSpanElement>(null);
  const vuFillRef = useRef<HTMLDivElement>(null);

  // Chrono and meter written straight to the DOM, as on the live screen
  // (LiveSession.tsx): sixty renders a second for a bar's width is not what
  // a component is for.
  useEffect(() => {
    if (chronoRef.current) chronoRef.current.textContent = fmtTime(elapsedMs() / 1000);
    if (phase !== 'recording') {
      if (vuFillRef.current) vuFillRef.current.style.width = '0%';
      return;
    }
    let rafId = requestAnimationFrame(function vuLoop() {
      if (vuFillRef.current) vuFillRef.current.style.width = `${Math.round(level() * 100)}%`;
      rafId = requestAnimationFrame(vuLoop);
    });
    const chronoId = window.setInterval(() => {
      if (chronoRef.current) chronoRef.current.textContent = fmtTime(elapsedMs() / 1000);
    }, 250);
    return () => { clearInterval(chronoId); cancelAnimationFrame(rafId); };
  }, [phase]);

  const recording = phase === 'recording';
  const size = compact ? 'px-2.5 py-1 text-xs' : 'px-3';
  return (
    <div class={`flex items-center ${compact ? 'gap-2.5 px-2.5 py-1.5' : 'gap-3 p-3'} rounded-lg border border-border bg-bg`}>
      <span class={`w-2.5 h-2.5 rounded-full shrink-0 ${recording ? 'bg-danger animate-pulse' : 'bg-dim'}`} />
      <span ref={chronoRef} class={`${compact ? 'text-xs' : 'text-sm'} font-mono text-primary tabular-nums`}>0:00</span>
      <div class="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden">
        <div ref={vuFillRef} class="h-full bg-accent transition-[width] duration-75" style={{ width: '0%' }} />
      </div>
      {recording || phase === 'stopping' ? (
        <button type="button" class={`btn-danger ${size} shrink-0`} disabled={phase === 'stopping'} onClick={onStop}>
          {t('fileViewer.record.stop')}
        </button>
      ) : (
        <button
          type="button"
          class={`btn-primary ${size} shrink-0 flex items-center gap-1.5`}
          disabled={phase === 'opening'}
          onClick={onStart}
        >
          <MicIcon size={compact ? 12 : 13} />
          {/* A take held: the same button records a new one in its place,
              and says so (2026-11-01, the user). */}
          {t(phase === 'stopped' ? 'fileViewer.record.restart' : 'fileViewer.record.start')}
        </button>
      )}
      {after}
    </div>
  );
}

function RecordBody({ take, name }: { take: Take; name: Signal<string> }) {
  const phase = take.phase.value;
  const error = take.error.value;
  return (
    <div class="space-y-3">
      {/* The paste dialog's name row, the extension fixed after the box and
          never typed — but first here: nothing in the take suggests it, so
          it does not follow what is below it as a pasted text's name does. */}
      <div class="flex items-center gap-3">
        <label class="label shrink-0">{t('fileViewer.record.name')}</label>
        <span class="flex items-center gap-1 flex-1 min-w-0">
          <input
            type="text"
            class="input text-sm py-1.5 min-w-0 flex-1"
            value={name.value}
            onInput={(e) => { name.value = (e.target as HTMLInputElement).value; }}
          />
          <span class="text-xs font-mono text-dim shrink-0">{take.extension.value}</span>
        </span>
      </div>

      {/* The live screen's recording row, its button at the end of it. */}
      <RecorderRow
        phase={phase}
        elapsedMs={() => take.elapsedMs()}
        level={() => take.level()}
        onStart={() => take.start()}
        onStop={() => void take.stop()}
      />

      {error && <p class="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function showRecordMicModal(onAdd: (a: Attachment) => void, onBack: () => void): void {
  const take = new Take();
  const name = signal(stampedName());
  // A file with no name is not a file — the paste dialog's rule.
  const unnamed = computed(() => name.value.trim() === '');
  const { el, cleanup } = renderModalBody(<RecordBody take={take} name={name} />);
  const dispose = () => { take.release(); cleanup(); };
  const leave = () => { closeModal(); dispose(); };
  const add = async () => {
    const file = await take.settle();
    const base = name.value.trim();
    leave();
    if (!file) return;
    onAdd(await recordingAttachment(file, base));
  };
  /** A take is work, recording or stopped: leaving asks first, by the ✕,
   *  Escape, a click outside, the back gesture and the ←, as the paste dialog
   *  does. Adding from the question stops a recording under way first. */
  const settle = (proceed: () => void, afterAdd = true): boolean => {
    if (!take.holdsTake) return false;
    askUnsavedChanges({
      message: t('unsaved.message.recording'),
      saveLabel: t('common.add'),
      canSave: !unnamed.value,
      save: async () => { await add(); return afterAdd; },
      discard: () => {},
      proceed,
    });
    return true;
  };
  const back = () => { leave(); onBack(); };

  // No Cancel (2026-11-01, the user): the ✕ leaves, asking first when a
  // take would be lost.
  showModal(t('fileViewer.record.title'), el, [
    {
      label: t('common.add'),
      primary: true,
      disabled: computed(() => take.phase.value !== 'stopped' || unnamed.value),
      onClick: () => void add(),
    },
  ], {
    maxWidth: '24rem',
    onDismiss: dispose,
    onBack: () => { if (!settle(back, false)) back(); },
    guardDismiss: (dismiss) => settle(dismiss),
  });
}
