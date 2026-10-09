import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileEntry } from '../types';
import { t } from '../services/i18nService';
import { playIcon, pauseIcon, stopIcon, repeatIcon } from './playbackIcons';
import { AudioEngine, type AudioEffects } from './audioEngine';

export { stopCurrentAudio } from './audioEngine';

// ── The audio player's screen ────────────────────────────────────────────────
// Waveform with an A-B region, transport, and three sliders (tempo,
// transposition, fine pitch) over the engine in audioEngine.ts.
//
// Preact since 2026-10-10, from a hand-built DOM, as the first step towards
// saved settings per file (presets): settings that the screen can be TOLD,
// not only ones the user drags. Same behaviour as before, on purpose — the
// sound half moved untouched, and the parts that change sixty times a second
// (playhead, current time, the bars' colours) are still written straight to
// the DOM from the animation frame, never through a render.

// ── Slider CSS (injected once) ───────────────────────────────────────────────

function injectSliderStyle(): void {
  if (document.getElementById('cadence-audio-style')) return;
  const s = document.createElement('style');
  s.id = 'cadence-audio-style';
  s.textContent = `
    .cad-range{-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;width:100%}
    .cad-range::-webkit-slider-runnable-track{height:3px;background:linear-gradient(to right,var(--thumb-color,var(--color-accent)) var(--pct,50%),var(--color-border) var(--pct,50%));border-radius:99px}
    .cad-range::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--thumb-color,var(--color-accent));margin-top:-4.5px}
  `;
  document.head.appendChild(s);
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

const MONO = '"IBM Plex Mono",monospace';
const WAVE_H = 56;
/** A region is never shorter than this. */
const MIN_REGION_S = 0.5;
/** Below this width the three sliders go one under the other (2026-10-10, the
 *  user): side by side, a label and a value such as "TRANSPOSE +12 st" no
 *  longer fit a third of a phone. */
const SLIDERS_IN_A_ROW_MIN_PX = 420;

// ── Pieces ───────────────────────────────────────────────────────────────────

function TransportButton({ html, title, active, onClick }: {
  html: string; title: string; active?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      class={'px-2 py-[5px] inline-flex items-center justify-center bg-transparent border rounded cursor-pointer leading-none '
        + (active ? 'border-accent text-accent hover:text-primary' : 'border-border text-muted hover:border-accent hover:text-primary')}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={onClick}
    />
  );
}

function SmallButton({ text, title, onClick }: { text: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      class="px-1.5 py-0.5 text-[9px] bg-transparent border border-border rounded-[3px] text-dim cursor-pointer hover:border-dim hover:text-muted"
      style={{ fontFamily: MONO }}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

/** A labelled range with its value shown, editable by a click on the value,
 *  and a ↺ back to the default once it is moved. Controlled: the value comes
 *  from the player, so it can be set from outside the slider too. */
function Slider({ label, min, max, step, def, color, fmt, value, onChange }: {
  label: string; min: number; max: number; step: number; def: number; color: string;
  fmt: (v: number) => string; value: number; onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    // Only when editing starts, not at every keystroke.
    // eslint-disable-next-line
  }, [editing === null]);

  const commit = () => {
    const raw = parseFloat(editing ?? '');
    if (!isNaN(raw)) onChange(Math.max(min, Math.min(max, Math.round(raw / step) * step)));
    setEditing(null);
  };
  const atDefault = value === def;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
          <span style={{ fontSize: '9px', color: 'var(--color-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
          <button
            type="button"
            title="Reset"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '10px', color: 'var(--color-dim)',
              padding: 0, lineHeight: 1, transition: 'opacity 0.15s',
              opacity: atDefault ? 0 : 1, pointerEvents: atDefault ? 'none' : 'auto',
            }}
            onClick={() => onChange(def)}
          >↺</button>
        </div>
        {editing === null ? (
          <span
            style={{ fontSize: '11px', fontFamily: MONO, color, fontWeight: 500, cursor: 'pointer' }}
            onClick={() => setEditing(String(value))}
          >{fmt(value)}</span>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={editing}
            style={{
              fontSize: '11px', fontFamily: MONO, color, fontWeight: 500, background: 'transparent', border: 'none',
              borderBottom: `1px solid ${color}`, outline: 'none', width: '38px', textAlign: 'right', padding: 0,
            }}
            onInput={(e) => setEditing((e.target as HTMLInputElement).value.replace(/[^\d\-.]/g, ''))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') setEditing(null);
            }}
          />
        )}
      </div>
      <input
        type="range"
        class="cad-range"
        min={min} max={max} step={step} value={value}
        style={{ '--pct': `${((value - min) / (max - min)) * 100}%`, '--thumb-color': color }}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

// ── The player ───────────────────────────────────────────────────────────────

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; duration: number; waveform: number[] }
  | { kind: 'error'; msg: string };

interface Region { start: number; end: number }

function AudioPlayer({ entry }: { entry: FileEntry }) {
  const [playing, setPlaying] = useState(false);
  const engineRef = useRef<AudioEngine | null>(null);
  engineRef.current ??= new AudioEngine(setPlaying);
  const engine = engineRef.current;

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [repeat, setRepeat] = useState(true);
  const [region, setRegionState] = useState<Region>({ start: 0, end: 1 });
  const [effects, setEffectsState] = useState<AudioEffects>({ tempo: 100, transpose: 0, pitch: 0 });
  const [waveW, setWaveW] = useState(400);

  const duration = status.kind === 'ready' ? status.duration : 1;
  // What the animation frame reads: never a render's copy, which would be the
  // first render's for a loop started once.
  const regionRef = useRef(region);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const waveWrapRef = useRef<HTMLDivElement>(null);
  const waveSvgRef = useRef<SVGSVGElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeCurrentRef = useRef<HTMLSpanElement>(null);
  /** The colour each bar was last given, so a frame only touches the bars
   *  whose state changed — usually none. */
  const barFills = useRef<{ el: Element; fill: string }[]>([]);

  const setRegion = (r: Region) => {
    regionRef.current = r;
    engine.setRegionBounds(r.start, r.end);
    setRegionState(r);
  };

  /** The parts that move while playing: playhead, current time, the bars'
   *  colours. Straight to the DOM — see this file's header. */
  const updateMoving = () => {
    const pos = engine.position();
    const d = durationRef.current;
    if (playheadRef.current) playheadRef.current.style.left = `${(pos / d) * 100}%`;
    if (timeCurrentRef.current) timeCurrentRef.current.textContent = fmtTime(pos);
    const rects = waveSvgRef.current?.children;
    if (!rects) return;
    const n = rects.length;
    const { start, end } = regionRef.current;
    for (let i = 0; i < n; i++) {
      const el = rects[i]!;
      const t = (i + 0.5) / n * d;
      const inReg = t >= start && t <= end;
      const fill = inReg && t <= pos ? 'var(--color-accent)' : inReg ? 'var(--color-accent-subtle)' : 'var(--color-border)';
      const cached = barFills.current[i];
      if (cached?.el === el && cached.fill === fill) continue;
      el.setAttribute('fill', fill);
      barFills.current[i] = { el, fill };
    }
  };

  // Load once.
  useEffect(() => {
    injectSliderStyle();
    let alive = true;
    engine.load(entry).then(
      (r) => {
        if (!alive) return;
        setRegion({ start: 0, end: r.duration });
        setStatus({ kind: 'ready', ...r });
      },
      (err: unknown) => { if (alive) setStatus({ kind: 'error', msg: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line
  }, []);

  // The waveform's width, for its bars.
  useEffect(() => {
    const el = waveWrapRef.current;
    if (!el) return;
    setWaveW(el.offsetWidth || 400);
    const ro = new ResizeObserver(() => setWaveW(el.offsetWidth || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, [status.kind]);

  // Every render may have moved a bound or the bars: redraw the moving parts.
  useEffect(updateMoving);

  // The animation frame runs only while playing.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const loop = () => { updateMoving(); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line
  }, [playing]);

  // A ref, not the render's `effects`: two slider events can land before the
  // next render, and the second must build on the first.
  const effectsRef = useRef(effects);
  const setEffect = (patch: Partial<AudioEffects>) => {
    const next = { ...effectsRef.current, ...patch };
    effectsRef.current = next;
    setEffectsState(next);
    engine.setEffects(next);
  };

  /** A position on the waveform from a pointer's x. */
  const posAt = (clientX: number) => {
    const rect = waveWrapRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * durationRef.current;
  };

  // Waveform drag → seek (follows pointer while held — Pointer Events cover
  // mouse, touch and pen with one set of listeners; the mouse-only version
  // of this never worked on mobile at all).
  const onWaveDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const doSeek = (ev: PointerEvent) => { engine.seek(posAt(ev.clientX)); updateMoving(); };
    doSeek(e);
    const onUp = () => {
      window.removeEventListener('pointermove', doSeek);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', doSeek);
    window.addEventListener('pointerup', onUp);
  };

  // Handle drag. The node gets the new bounds once, on release.
  const onHandleDown = (isStart: boolean) => (e: PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const onMove = (ev: PointerEvent) => {
      const pos = posAt(ev.clientX);
      const r = regionRef.current;
      setRegion(isStart
        ? { start: Math.min(pos, r.end - MIN_REGION_S), end: r.end }
        : { start: r.start, end: Math.max(pos, r.start + MIN_REGION_S) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      engine.applyRegion();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const setStartHere = () => {
    const r = regionRef.current;
    const start = Math.min(engine.position(), r.end - MIN_REGION_S);
    setRegion({ start, end: r.end });
    engine.seek(start);
  };
  const setEndHere = () => {
    const r = regionRef.current;
    setRegion({ start: r.start, end: Math.max(engine.position(), r.start + MIN_REGION_S) });
    engine.applyRegion();
  };
  const resetRegion = () => {
    setRegion({ start: 0, end: durationRef.current });
    engine.seek(0);
  };

  if (status.kind !== 'ready') {
    return (
      <div style={{ width: '100%', padding: '14px 16px', boxSizing: 'border-box' }}>
        <div style={{ fontSize: '11px', color: 'var(--color-dim)', textAlign: 'center', padding: '20px 0' }}>
          {status.kind === 'loading' ? t('audioPlayer.loading') : t('audioPlayer.error', { msg: status.msg })}
        </div>
      </div>
    );
  }

  // The player's own width, not the screen's: it lives in a dialog, and the
  // waveform already measures it.
  const stacked = waveW < SLIDERS_IN_A_ROW_MIN_PX;
  const bars = status.waveform;
  const n = bars.length;
  const barW = Math.max(1, (waveW / n) * 0.65);
  const gap = waveW / n;

  return (
    <div style={{ width: '100%', padding: '14px 16px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Waveform */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div
          ref={waveWrapRef}
          style={{ position: 'relative', height: `${WAVE_H}px`, cursor: 'pointer', userSelect: 'none', touchAction: 'none' }}
          onPointerDown={onWaveDown}
        >
          <svg
            ref={waveSvgRef}
            height={WAVE_H}
            width={waveW}
            viewBox={`0 0 ${waveW} ${WAVE_H}`}
            style={{ display: 'block', width: '100%', pointerEvents: 'none' }}
          >
            {/* No `fill` here: updateMoving owns it. */}
            {bars.map((v, i) => {
              const h = Math.max(3, v * WAVE_H * 0.8 + WAVE_H * 0.08);
              return <rect key={i} x={i * gap} y={(WAVE_H - h) / 2} width={barW} height={h} rx={1} />;
            })}
          </svg>
          <div
            ref={playheadRef}
            style={{ position: 'absolute', top: 0, bottom: 0, width: '1px', background: 'var(--color-accent)', pointerEvents: 'none', zIndex: 3 }}
          />
          {/* Wider invisible hit box than the visible bar — a 3px target is
              unusable with a finger on mobile. */}
          {([true, false] as const).map(isStart => (
            <div
              key={String(isStart)}
              style={{
                position: 'absolute', top: 0, bottom: 0, width: '20px', cursor: 'ew-resize', zIndex: 4,
                transform: 'translateX(-10px)', touchAction: 'none', display: 'flex', justifyContent: 'center',
                left: `${((isStart ? region.start : region.end) / duration) * 100}%`,
              }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onHandleDown(isStart)}
            >
              <div style={{ width: '3px', height: '100%', background: 'var(--color-accent)', pointerEvents: 'none' }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--color-dim)', fontFamily: MONO }}>
          <span ref={timeCurrentRef} />
          <span style={{ textAlign: 'center' }}>{`${fmtTime(region.start)} → ${fmtTime(region.end)}`}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* Transport */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <TransportButton
          html={playing ? pauseIcon() : playIcon()}
          title={t('audioPlayer.play')}
          onClick={() => { if (engine.isPlaying()) engine.pause(); else void engine.play(); }}
        />
        <TransportButton html={stopIcon()} title={t('audioPlayer.stop')} onClick={() => engine.stop()} />
        <TransportButton
          html={repeatIcon()}
          title={t('audioPlayer.repeat')}
          active={repeat}
          onClick={() => { const next = !repeat; setRepeat(next); engine.setRepeat(next); }}
        />
        <div style={{ flex: 1 }} />
        <SmallButton text="[←" title={t('audioPlayer.setStart.title')} onClick={setStartHere} />
        <SmallButton text="→]" title={t('audioPlayer.setEnd.title')} onClick={setEndHere} />
        <SmallButton text={t('audioPlayer.reset')} title={t('audioPlayer.reset.title')} onClick={resetRegion} />
      </div>

      {/* Sliders */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
        <div style={stacked
          ? { display: 'grid', gridTemplateColumns: '1fr', gap: '10px 0' }
          : { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
          <Slider label={t('audioPlayer.tempo')} min={30} max={200} step={1} def={100} color="var(--color-accent)"
            fmt={v => `${v}%`} value={effects.tempo} onChange={v => setEffect({ tempo: v })} />
          <Slider label={t('audioPlayer.transpose')} min={-12} max={12} step={1} def={0} color="var(--color-warn)"
            fmt={v => `${v >= 0 ? '+' : ''}${v} st`} value={effects.transpose} onChange={v => setEffect({ transpose: v })} />
          <Slider label={t('audioPlayer.pitch')} min={-100} max={100} step={1} def={0} color="var(--color-success)"
            fmt={v => `${v >= 0 ? '+' : ''}${v} ¢`} value={effects.pitch} onChange={v => setEffect({ pitch: v })} />
        </div>
      </div>
    </div>
  );
}

/** Mounts a player for `entry` into a fresh element. Unmount it with
 *  unmountAudioPlayer when its dialog goes. */
export function renderAudioPlayer(entry: FileEntry): HTMLElement {
  const host = document.createElement('div');
  host.style.width = '100%';
  render(<AudioPlayer entry={entry} />, host);
  return host;
}

export function unmountAudioPlayer(host: HTMLElement): void {
  render(null, host);
}
