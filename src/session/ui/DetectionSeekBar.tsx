import { useEffect, useRef } from 'preact/hooks';
import { makePeakBuffer, readInto, levelOver, type PeakBuffer } from '../audio/localWaveform';
import { fmtTime } from './sessionUiShared';
import { t } from '../../services/i18nService';

// ── A detection's own seek bar (N3f, 2026-11-23, the user) ───────────────────
// On a session of three hours the analysis's timeline gives a tune a few
// pixels: on a phone there is no getting about inside it. This bar is the
// tune's alone — under its name, the card's whole width — on the card the
// head is in only (the user's choice: one bar, on what is playing or where
// the head was put; it moves to the next tune as the playing does). Pressed
// or dragged, the recording goes there; the head is read at every frame, the
// summary's player is never re-rendered for it. With the recording on this
// device, its waveform behind (localWaveform.ts: the tune's stretch alone is
// decoded, an envelope of 10 ms peaks kept) — stopped if the bar goes first.

/** A waveform being worked out, or worked out. */
interface Wave {
  buf: PeakBuffer;
  /** The bars drawing it — one at most, in practice. */
  listeners: Set<() => void>;
  /** Read to the end (or found unreadable): nothing left to stop. */
  done: boolean;
  /** Let go of before it was done: the decoding still to start must not. */
  stopped: boolean;
  job: { cancel: () => void } | null;
}

/** Waveforms worked out, by stretch: the bar comes and goes with the head, and
 *  each time back would decode the tune again. A handful: a few hundred KB. */
const waves = new Map<string, Wave>();
const KEPT = 6;

function waveOf(key: string, start: number, end: number, getAudio: () => Promise<Blob | undefined>): Wave {
  const known = waves.get(key);
  if (known) return known;
  const made: Wave = { buf: makePeakBuffer(start, end), listeners: new Set(), done: false, stopped: false, job: null };
  waves.set(key, made);
  if (waves.size > KEPT) {
    const [oldKey, old] = waves.entries().next().value!;
    waves.delete(oldKey);
    if (old.listeners.size === 0) stop(old);
  }
  const tell = () => { for (const l of made.listeners) l(); };
  void getAudio().then((blob) => {
    if (!blob || made.stopped) return;
    made.job = readInto(blob, made.buf, start, end, tell, () => { made.done = true; made.job = null; tell(); });
  }, () => {});
  return made;
}

function stop(w: Wave): void {
  if (w.done) return;
  w.stopped = true;
  w.job?.cancel();
  w.job = null;
}

/** The bar showing `w` is gone. An unfinished waveform is stopped there and
 *  forgotten — the tune changed (an arrow in the Focus view, the head moving
 *  on) and its decoding would only compete with the next tune's (2026-11-23,
 *  the user). It used to run to the end, on the grounds that the bar is
 *  often back soon: then it starts again, from the beginning. A finished one
 *  is kept. */
function letGo(key: string, w: Wave): void {
  if (w.done || w.listeners.size > 0) return;
  stop(w);
  if (waves.get(key) === w) waves.delete(key);
}

/** Arrow keys' step, in seconds. */
const STEP_S = 2;

export function DetectionSeekBar({ sessionId, start, end, now, seek, getAudio }: {
  sessionId: string;
  /** The detection's bounds, in session time. */
  start: number;
  end: number;
  /** Where the head is now, in session time. */
  now: () => number;
  /** Sends the recording there. */
  seek: (t: number) => void;
  /** The recording, when it is on this device: its waveform is drawn. */
  getAudio?: () => Promise<Blob | undefined>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const span = Math.max(0.001, end - start);
  const key = `${sessionId}|${start.toFixed(3)}|${end.toFixed(3)}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    const bar = barRef.current;
    if (!canvas || !bar) return;
    const wave = getAudio ? waveOf(key, start, end, getAudio) : null;
    /** Each column's level, worked out again only when the width or the
     *  waveform changed. */
    let columns: Float32Array | null = null;
    const onWave = () => { columns = null; };
    wave?.listeners.add(onWave);
    let raf = 0, lastX = -1, lastW = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const t = Math.max(start, Math.min(end, now()));
      const x = Math.round(((t - start) / span) * w);
      if (x === lastX && w === lastW && columns) return;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); columns = null; }
      lastW = w;
      if (!columns) {
        columns = new Float32Array(w);
        if (wave) for (let i = 0; i < w; i++) columns[i] = levelOver(wave.buf, start + (i / w) * span, start + ((i + 1) / w) * span);
      }
      lastX = x;
      if (elapsedRef.current) elapsedRef.current.textContent = fmtTime(t - start);
      const g = canvas.getContext('2d');
      if (!g) return;
      const css = getComputedStyle(canvas);
      const played = css.getPropertyValue('--color-accent').trim() || '#3b82f6';
      const rest = css.getPropertyValue('--color-dim').trim() || '#888';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const mid = h / 2;
      if (wave) {
        // A column per pixel, mirrored round the middle — a floor of a pixel,
        // so a silence still reads as the track.
        for (let i = 0; i < w; i++) {
          const half = Math.max(0.5, columns[i]! * (h / 2 - 1));
          g.fillStyle = i < x ? played : rest;
          g.fillRect(i, mid - half, 1, half * 2);
        }
      } else {
        g.fillStyle = rest;
        g.fillRect(0, mid - 1.5, w, 3);
        g.fillStyle = played;
        g.fillRect(0, mid - 1.5, x, 3);
      }
      // The head: across the whole height.
      g.fillStyle = played;
      g.fillRect(Math.min(w - 2, Math.max(0, x - 1)), 0, 2, h);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      if (!wave) return;
      wave.listeners.delete(onWave);
      letGo(key, wave);
    };
  }, [key, !!getAudio]);

  /** Seconds under a pointer x, within the tune. */
  const timeAt = (clientX: number): number => {
    const r = barRef.current!.getBoundingClientRect();
    return start + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  const down = useRef(false);
  const onDown = (e: PointerEvent) => {
    e.stopPropagation();
    down.current = true;
    barRef.current?.setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
  };
  const onMove = (e: PointerEvent) => { if (down.current) seek(timeAt(e.clientX)); };
  const onUp = (e: PointerEvent) => {
    if (!down.current) return;
    down.current = false;
    barRef.current?.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const t = now() + (e.key === 'ArrowRight' ? STEP_S : -STEP_S);
    seek(Math.max(start, Math.min(end, t)));
  };

  return (
    <div class="flex items-center gap-2 min-w-0">
      <span ref={elapsedRef} class="shrink-0 text-2xs font-mono text-muted tabular-nums w-10 text-right">{fmtTime(0)}</span>
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label={t('sessions.seekBar')}
        aria-valuemin={0}
        aria-valuemax={Math.round(span)}
        class="relative flex-1 min-w-0 h-8 cursor-pointer touch-none rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <canvas ref={canvasRef} class="absolute inset-0 w-full h-full" />
      </div>
      <span class="shrink-0 text-2xs font-mono text-muted tabular-nums w-10">{fmtTime(span)}</span>
    </div>
  );
}
