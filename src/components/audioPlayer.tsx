import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AudioPreset, FileEntry } from '../types';
import { generateId } from '../utils';
import { t } from '../services/i18nService';
import { playIcon, pauseIcon, stopIcon, repeatIcon } from './playbackIcons';
import { AudioEngine, type AudioEffects } from './audioEngine';
import { CustomSelect } from './customSelect';
import { StarIcon, PencilIcon, TrashIcon, CheckIcon, PlusIcon } from './icons';
import {
  AUDIO_LIMITS, MIN_REGION_S, fmtTime, neutralSettings, fitSettings, sameSettings, settingsOf, suggestedPresetName,
  type AudioSettings, type AudioPresetsBinding,
} from '../services/audioPresets';

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

const MONO = '"IBM Plex Mono",monospace';
const WAVE_H = 56;
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
              if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
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

// ── The preset bar ───────────────────────────────────────────────────────────

interface PresetActions {
  save: () => void;
  create: (name: string) => void;
  rename: (name: string) => void;
  toggleDefault: () => void;
  remove: () => void;
}

function IconButton({ title, onClick, children, class: extra = '' }: {
  title: string; onClick: () => void; children: ComponentChildren; class?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      class={`p-1.5 rounded inline-flex items-center justify-center cursor-pointer transition-colors hover:bg-elevated ${extra || 'text-muted hover:text-primary'}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A name being typed: for a new preset, or for the one on screen. */
type Naming = { mode: 'create' | 'rename'; value: string };

/** The top of the player (2026-10-10, laid out like the score viewer at the
 *  user's request): the named presets in our own select, "no preset" first,
 *  with the star and the pencil of the preset on screen — or, while a name is
 *  being typed, the field for it. Changing preset drops unsaved changes
 *  without asking, as changing version does in the score viewer. */
function PresetHeader({ presets, currentId, defaultId, dirty, suggestedName, naming, setNaming, onChoose, actions }: {
  presets: AudioPreset[];
  currentId: string | null;
  defaultId: string | undefined;
  dirty: boolean;
  suggestedName: string;
  naming: Naming | null;
  setNaming: (n: Naming | null) => void;
  onChoose: (id: string | null) => void;
  actions: PresetActions;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!naming) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    // Only when naming starts.
    // eslint-disable-next-line
  }, [naming === null]);

  const current = presets.find(p => p.id === currentId) ?? null;
  const confirm = () => {
    if (!naming) return;
    if (naming.mode === 'create') actions.create(naming.value); else actions.rename(naming.value);
    setNaming(null);
  };

  if (naming) {
    return (
      <div class="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          class="flex-1 min-w-0 text-xs bg-bg text-primary border border-accent rounded px-2 py-1.5 outline-none"
          aria-label={t('audioPlayer.preset.name')}
          placeholder={suggestedName}
          value={naming.value}
          onInput={(e) => setNaming({ ...naming, value: (e.target as HTMLInputElement).value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            // This field, not the dialog: see main.ts's Escape.
            if (e.key === 'Escape') { e.preventDefault(); setNaming(null); }
          }}
        />
        <IconButton title={t('common.confirm')} onClick={confirm} class="text-accent"><CheckIcon size={14} /></IconButton>
        <IconButton title={t('common.cancel')} onClick={() => setNaming(null)}><span class="text-sm leading-none">✕</span></IconButton>
      </div>
    );
  }

  return (
    <div class="flex items-center gap-1">
      <div class="flex-1 min-w-0 max-w-[18rem]">
        <CustomSelect
          value={currentId ?? ''}
          options={[
            { value: '', label: t('audioPlayer.preset.none') },
            ...presets.map(p => ({ value: p.id, label: p.id === defaultId ? `${p.name} ★` : p.name })),
          ]}
          onChange={(v) => onChoose(v || null)}
          renderTrigger={(label, open, toggle) => (
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs bg-bg text-primary border border-border rounded px-2 py-1.5 cursor-pointer hover:border-accent w-full"
              aria-label={t('audioPlayer.preset.list')}
              onClick={toggle}
            >
              <span class={`truncate flex-1 text-left ${currentId ? '' : 'text-muted'}`}>{label}</span>
              {dirty && <span class="text-warn shrink-0" title={t('audioPlayer.preset.modified')}>●</span>}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        />
      </div>
      {current && (
        <>
          <IconButton
            title={t(current.id === defaultId ? 'audioPlayer.preset.isDefault' : 'audioPlayer.preset.setDefault')}
            onClick={actions.toggleDefault}
            class={current.id === defaultId ? 'text-warn' : 'text-muted hover:text-warn'}
          >
            <StarIcon size={13} filled={current.id === defaultId} />
          </IconButton>
          <IconButton title={t('audioPlayer.preset.rename')} onClick={() => setNaming({ mode: 'rename', value: current.name })}>
            <PencilIcon size={13} />
          </IconButton>
        </>
      )}
    </div>
  );
}

/** The bottom of the player, as under the score viewer's source: what writes
 *  — a new preset from these settings, and deleting the one on screen —
 *  grouped on the left; Save on the right, enabled once something differs
 *  from the preset (always on "no preset", where it asks a name first). */
function PresetFooter({ current, dirty, suggestedName, setNaming, actions }: {
  current: AudioPreset | null;
  dirty: boolean;
  suggestedName: string;
  setNaming: (n: Naming | null) => void;
  actions: PresetActions;
}) {
  return (
    <div class="flex items-center justify-between gap-2 flex-wrap">
      {current ? (
        <div class="flex items-center gap-1 p-1 bg-bg rounded-lg w-fit">
          <IconButton title={t('audioPlayer.preset.saveNew.title')} onClick={() => setNaming({ mode: 'create', value: suggestedName })}>
            <PlusIcon size={13} />
          </IconButton>
          <IconButton title={t('audioPlayer.preset.delete')} onClick={actions.remove} class="text-muted hover:text-danger">
            <TrashIcon size={13} />
          </IconButton>
        </div>
      ) : <span />}
      <button
        type="button"
        class="btn-primary text-xs"
        disabled={!!current && !dirty}
        title={t(current ? 'audioPlayer.preset.save.title' : 'audioPlayer.preset.save.titleNone')}
        onClick={() => { if (current) actions.save(); else setNaming({ mode: 'create', value: suggestedName }); }}
      >
        {t('audioPlayer.preset.save')}
      </button>
    </div>
  );
}

// ── The player ───────────────────────────────────────────────────────────────

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; duration: number; waveform: number[] }
  | { kind: 'error'; msg: string };

interface Region { start: number; end: number }

function AudioPlayer({ entry, binding }: { entry: FileEntry; binding?: AudioPresetsBinding }) {
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
        // Opens on the starred preset, if it is still there.
        const starred = binding?.presets.find(p => p.id === binding.defaultId);
        if (starred) {
          setCurrentId(starred.id);
          applySettings(fitSettings(settingsOf(starred), r.duration));
        }
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

  // ── Presets (audioPresets.ts) ──
  // The list is held here while the player is open and sent whole to the
  // binding at each change: the player is its one writer meanwhile.
  const [presets, setPresets] = useState<AudioPreset[]>(binding?.presets ?? []);
  const [defaultId, setDefaultId] = useState<string | undefined>(binding?.defaultId);
  /** The preset on screen; null is "no preset". */
  const [currentId, setCurrentId] = useState<string | null>(null);
  /** Shared by the top, where the name is typed, and the bottom, whose
   *  buttons ask for one. */
  const [naming, setNaming] = useState<Naming | null>(null);

  const current: AudioSettings = { start: region.start, end: region.end, ...effects, repeat };
  const currentPreset = presets.find(p => p.id === currentId) ?? null;
  const dirty = !!currentPreset && !sameSettings(current, fitSettings(settingsOf(currentPreset), duration));

  /** Everything the screen shows, at once — and playback, if running, carries
   *  on from the new region's start. */
  const applySettings = (s: AudioSettings) => {
    setRegion({ start: s.start, end: s.end });
    setEffect({ tempo: s.tempo, transpose: s.transpose, pitch: s.pitch });
    setRepeat(s.repeat);
    engine.setRepeat(s.repeat);
    engine.seek(s.start);
  };

  const choosePreset = (id: string | null) => {
    setCurrentId(id);
    const p = presets.find(x => x.id === id);
    applySettings(p ? fitSettings(settingsOf(p), duration) : neutralSettings(duration));
  };

  const commitPresets = (next: AudioPreset[], nextDefault: string | undefined) => {
    setPresets(next);
    setDefaultId(nextDefault);
    binding?.onChange(next, nextDefault);
  };

  const presetActions: PresetActions = {
    // Over the preset on screen. On "no preset" the bar asks for a name and
    // calls `create` instead.
    save: () => {
      if (!currentPreset) return;
      commitPresets(presets.map(p => (p.id === currentPreset.id ? { ...p, ...current } : p)), defaultId);
    },
    create: (name) => {
      const p: AudioPreset = { id: generateId(), name: name.trim() || suggestedPresetName(current), ...current };
      commitPresets([...presets, p], defaultId);
      setCurrentId(p.id);
    },
    rename: (name) => {
      if (!currentPreset || !name.trim()) return;
      commitPresets(presets.map(p => (p.id === currentPreset.id ? { ...p, name: name.trim() } : p)), defaultId);
    },
    toggleDefault: () => {
      if (!currentPreset) return;
      commitPresets(presets, defaultId === currentPreset.id ? undefined : currentPreset.id);
    },
    // The settings stay on screen, now as "no preset": deleting a preset is
    // not a reason to jump somewhere else in the tune.
    remove: () => {
      if (!currentPreset) return;
      commitPresets(presets.filter(p => p.id !== currentPreset.id), defaultId === currentPreset.id ? undefined : defaultId);
      setCurrentId(null);
    },
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
      {binding && (
        <PresetHeader
          presets={presets}
          currentId={currentId}
          defaultId={defaultId}
          dirty={dirty}
          suggestedName={suggestedPresetName(current)}
          naming={naming}
          setNaming={setNaming}
          onChoose={choosePreset}
          actions={presetActions}
        />
      )}

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
          <Slider label={t('audioPlayer.tempo')} min={AUDIO_LIMITS.tempo.min} max={AUDIO_LIMITS.tempo.max} step={1} def={AUDIO_LIMITS.tempo.def} color="var(--color-accent)"
            fmt={v => `${v}%`} value={effects.tempo} onChange={v => setEffect({ tempo: v })} />
          <Slider label={t('audioPlayer.transpose')} min={AUDIO_LIMITS.transpose.min} max={AUDIO_LIMITS.transpose.max} step={1} def={AUDIO_LIMITS.transpose.def} color="var(--color-warn)"
            fmt={v => `${v >= 0 ? '+' : ''}${v} st`} value={effects.transpose} onChange={v => setEffect({ transpose: v })} />
          <Slider label={t('audioPlayer.pitch')} min={AUDIO_LIMITS.pitch.min} max={AUDIO_LIMITS.pitch.max} step={1} def={AUDIO_LIMITS.pitch.def} color="var(--color-success)"
            fmt={v => `${v >= 0 ? '+' : ''}${v} ¢`} value={effects.pitch} onChange={v => setEffect({ pitch: v })} />
        </div>
      </div>

      {/* Under the sliders, Save and what writes (the user, 2026-10-10) —
          as under the score viewer's source. */}
      {binding && (
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
          <PresetFooter
            current={currentPreset}
            dirty={dirty}
            suggestedName={suggestedPresetName(current)}
            setNaming={setNaming}
            actions={presetActions}
          />
        </div>
      )}
    </div>
  );
}

/** Mounts a player for `entry` into a fresh element. Unmount it with
 *  unmountAudioPlayer when its dialog goes. With `presets`, it has its preset
 *  bar; without, it is the bare player. */
export function renderAudioPlayer(entry: FileEntry, presets?: AudioPresetsBinding): HTMLElement {
  const host = document.createElement('div');
  host.style.width = '100%';
  render(<AudioPlayer entry={entry} binding={presets} />, host);
  return host;
}

export function unmountAudioPlayer(host: HTMLElement): void {
  render(null, host);
}
