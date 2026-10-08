// The library's own file, as text: an alias in webpack.config.js.
import signalsmithStretchSource from 'signalsmith-stretch.mjs?raw';
import type { FileEntry } from '../types';
import { t } from '../services/i18nService';
import { playIcon, pauseIcon, stopIcon, repeatIcon } from './playbackIcons';

// ── How the sound is made ────────────────────────────────────────────────────
// Signalsmith Stretch (npm `signalsmith-stretch`, MIT): its author's own Web
// Audio release, a WebAssembly time-stretcher in an AudioWorklet that plays a
// buffer by itself — tempo, transposition in (fractional) semitones, an A-B
// loop, all scheduled in the time the sound is HEARD, its own latency
// compensated. This player only tells it what to play, and when.
//
// History, so nobody walks the same road again (2026-10-09). SoundTouch in a
// ScriptProcessorNode ran on the page's main thread and crackled throughout
// on a Galaxy A22. Moved to an AudioWorklet, it crackled for 2-3 s at every
// start (its JavaScript not yet optimised), clicked at every loop seam, at
// every stop and every seek — each fixed by hand in turn (warm-up, reserve,
// gain dips, output fades, deferred suspension) until the user asked whether
// we were reinventing the wheel. We were: a dedicated engine, compiled ahead
// of time, handles every one of these itself.

let currentAudioCtx: AudioContext | null = null;

/** `playback`: this is listening, not playing an instrument, so a larger
 *  output buffer costs nothing and Chrome on Android takes one. */
function newPlayerContext(): AudioContext {
  return new AudioContext({ latencyHint: 'playback' });
}
let currentDispose: (() => void) | null = null;

export function stopCurrentAudio(): void {
  // Disconnect the node explicitly instead of relying on AudioContext.close()
  // alone — on some Android/Chrome builds close() didn't silence an in-flight
  // node immediately, letting a new instance's audio overlap the old one for
  // a moment (reported as "duplicated playback with a slight offset").
  currentDispose?.();
  currentAudioCtx?.close();
  currentAudioCtx = null;
  currentDispose = null;
}

// ── The engine ───────────────────────────────────────────────────────────────

/** What a schedule() call can set (the library's README). Times in seconds:
 *  `output` on the context's clock, `input` and the loop in the file. */
interface StretchSchedule {
  output?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  loopStart?: number;
  loopEnd?: number;
}

/** The AudioWorkletNode the library returns, with the methods it attaches.
 *  It ships no types. */
type StretchNode = AudioWorkletNode & {
  schedule(change: StretchSchedule): Promise<unknown>;
  addBuffers(channels: Float32Array[]): Promise<number>;
  /** Input plus output latency, in seconds: how far ahead a change has to be
   *  scheduled to be taken exactly on time. */
  latency(): Promise<number>;
};

type StretchFactory = (ctx: BaseAudioContext) => Promise<StretchNode>;
let stretchFactory: Promise<StretchFactory> | null = null;

/** The library, loaded as the very file it ships. It builds its AudioWorklet
 *  module from its own functions' source text (`${Module}`), which a bundler's
 *  minifier would rewrite — renamed variables that no longer exist once that
 *  text runs alone in the worklet. Through a Blob URL it stays untouched, and
 *  is part of the bundle: nothing for the service worker to miss offline. */
function loadStretch(): Promise<StretchFactory> {
  stretchFactory ??= (async () => {
    const url = URL.createObjectURL(new Blob([signalsmithStretchSource], { type: 'text/javascript' }));
    const mod = await import(/* webpackIgnore: true */ url) as { default: StretchFactory };
    return mod.default;
  })();
  return stretchFactory;
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function decodeAudio(entry: FileEntry, ctx: AudioContext): Promise<AudioBuffer> {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)!;
  return ctx.decodeAudioData(arr.buffer);
}

function buildWaveformData(buffer: AudioBuffer, numBars = 120): number[] {
  const ch = buffer.getChannelData(0);
  const block = Math.floor(ch.length / numBars);
  const raw = Array.from({ length: numBars }, (_, i) => {
    let s = 0;
    for (let j = 0; j < block; j++) s += Math.abs(ch[i * block + j] ?? 0);
    return s / block;
  });
  const maxVal = Math.max(...raw, 1e-4);
  return raw.map(v => v / maxVal);
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

function setSliderStyle(inp: HTMLInputElement, min: number, max: number, value: number, color: string): void {
  inp.style.setProperty('--pct', `${((value - min) / (max - min)) * 100}%`);
  inp.style.setProperty('--thumb-color', color);
}

// ── Component ────────────────────────────────────────────────────────────────

export function renderAudioPlayer(entry: FileEntry): HTMLElement {
  injectSliderStyle();

  // ── Playback state ──
  let audioCtx: AudioContext | null = null;
  let buffer:   AudioBuffer  | null = null;
  let stretch:  StretchNode  | null = null;
  /** How far ahead changes are scheduled — the node's own latency. */
  let lead = 0.1;

  // Where playback is, in the file's seconds: `anchorPos` comes out of the
  // node at context time `anchorOut`, advancing at `anchorRate` — the same
  // model the node keeps, re-anchored at every change sent to it.
  // `pausedPos` is the position while nothing plays.
  let anchorPos  = 0;
  let anchorOut  = 0;
  let anchorRate = 1;
  let pausedPos  = 0;
  /** The region's natural end without repeat, as a timer: the node only
   *  falls silent there, and the player has to know it stopped. */
  let endTimer   = 0;

  let playing    = false;
  let repeat     = true;
  let duration   = 1;
  let regionStart = 0;
  let regionEnd   = 1;
  let rafId      = 0;

  let tempo     = 100;   // %
  let transpose = 0;     // semitones
  let pitch     = 0;     // cents

  const rate = () => tempo / 100;
  const semitones = () => transpose + pitch / 100;
  /** The output device's own buffer — large on Android with `playback`. */
  const deviceLag = () => audioCtx?.outputLatency || audioCtx?.baseLatency || 0;

  /** The position at the node's output at context time `at`. It loops
   *  between the region's bounds, so the position wraps the same way: past
   *  regionEnd, back to regionStart. */
  const positionAt = (at: number) => {
    if (!playing) return pausedPos;
    const p = anchorPos + Math.max(0, at - anchorOut) * anchorRate;
    if (p < regionEnd) return p;
    if (!repeat) return regionEnd;
    return regionStart + ((p - regionEnd) % Math.max(regionEnd - regionStart, 1e-3));
  };
  /** What is being HEARD — the playhead, and where a marker set "here" goes. */
  const getCurrentPos = () => (audioCtx ? positionAt(audioCtx.currentTime - deviceLag()) : pausedPos);

  // ── UI elements ──
  const root = document.createElement('div');
  root.style.cssText = 'width:100%;padding:14px 16px;box-sizing:border-box;display:flex;flex-direction:column;gap:10px';

  const loading = document.createElement('div');
  loading.style.cssText = 'font-size:11px;color:var(--color-dim);text-align:center;padding:20px 0';
  loading.textContent = t('audioPlayer.loading');
  root.appendChild(loading);

  // Waveform
  const waveSection = document.createElement('div');
  waveSection.style.cssText = 'display:none;flex-direction:column;gap:4px';

  const waveWrap = document.createElement('div');
  waveWrap.style.cssText = 'position:relative;height:56px;cursor:pointer;user-select:none;touch-action:none';

  const waveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  waveSvg.setAttribute('height', '56');
  waveSvg.style.cssText = 'display:block;width:100%;pointer-events:none';

  const playhead = document.createElement('div');
  playhead.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:var(--color-accent);pointer-events:none;z-index:3';

  // Wider invisible hit box than the visible bar — a 3px target is unusable
  // with a finger on mobile. The bar stays centered in the box so the
  // visual position (driven by updateUI's .left assignment on the outer
  // element) is unchanged.
  const mkHandle = (): HTMLDivElement => {
    const h = document.createElement('div');
    h.style.cssText = 'position:absolute;top:0;bottom:0;width:20px;cursor:ew-resize;z-index:4;transform:translateX(-10px);touch-action:none;display:flex;justify-content:center';
    const bar = document.createElement('div');
    bar.style.cssText = 'width:3px;height:100%;background:var(--color-accent);pointer-events:none';
    h.appendChild(bar);
    return h;
  };
  const startHandle = mkHandle();
  const endHandle = mkHandle();

  waveWrap.append(waveSvg, playhead, startHandle, endHandle);

  const timeRow = document.createElement('div');
  timeRow.style.cssText = 'display:flex;justify-content:space-between;font-size:9px;color:var(--color-dim);font-family:"IBM Plex Mono",monospace';
  const timeCurrent = document.createElement('span');
  const timeRegion  = document.createElement('span'); timeRegion.style.textAlign = 'center';
  const timeDur     = document.createElement('span');
  timeRow.append(timeCurrent, timeRegion, timeDur);
  waveSection.append(waveWrap, timeRow);

  // Transport
  const transport = document.createElement('div');
  transport.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap';

  const mkBtn = (html: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.innerHTML = html; b.title = title;
    b.style.cssText = 'padding:5px 8px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--color-border);border-radius:4px;color:var(--color-muted);cursor:pointer;line-height:1';
    b.onmouseenter = () => { b.style.borderColor = 'var(--color-accent)'; b.style.color = 'var(--color-primary)'; };
    b.onmouseleave = () => { if (b.dataset['active'] !== '1') { b.style.borderColor = 'var(--color-border)'; b.style.color = 'var(--color-muted)'; } };
    return b;
  };
  const mkSmall = (text: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = 'padding:2px 6px;font-size:9px;font-family:"IBM Plex Mono",monospace;background:transparent;border:1px solid var(--color-border);border-radius:3px;color:var(--color-dim);cursor:pointer';
    b.onmouseenter = () => { b.style.borderColor = 'var(--color-dim)'; b.style.color = 'var(--color-muted)'; };
    b.onmouseleave = () => { b.style.borderColor = 'var(--color-border)'; b.style.color = 'var(--color-dim)'; };
    return b;
  };

  const playBtn     = mkBtn(playIcon(),   t('audioPlayer.play'));
  const stopBtn     = mkBtn(stopIcon(),   t('audioPlayer.stop'));
  const repeatBtn   = mkBtn(repeatIcon(), t('audioPlayer.repeat'));
  const setStartBtn = mkSmall('[←', t('audioPlayer.setStart.title'));
  const setEndBtn   = mkSmall('→]', t('audioPlayer.setEnd.title'));
  const resetBtn    = mkSmall(t('audioPlayer.reset'), t('audioPlayer.reset.title'));
  repeatBtn.dataset['active'] = '1';
  repeatBtn.style.borderColor = 'var(--color-accent)';
  repeatBtn.style.color       = 'var(--color-accent)';

  const spacer = document.createElement('div'); spacer.style.flex = '1';
  transport.append(playBtn, stopBtn, repeatBtn, spacer, setStartBtn, setEndBtn, resetBtn);

  // Sliders
  const slidersSection = document.createElement('div');
  slidersSection.style.cssText = 'display:none;border-top:1px solid var(--color-border);padding-top:12px';
  const slidersGrid = document.createElement('div');
  slidersGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px';

  const mkSlider = (
    label: string, min: number, max: number, step: number, def: number,
    color: string, fmt: (v: number) => string, onInput: (v: number) => void,
  ): HTMLElement => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    const hdr  = document.createElement('div'); hdr.style.cssText  = 'display:flex;justify-content:space-between;align-items:center';
    const lbl  = document.createElement('span'); lbl.style.cssText = 'font-size:9px;color:var(--color-dim);text-transform:uppercase;letter-spacing:0.08em'; lbl.textContent = label;

    // Left side: label + reset button
    const left = document.createElement('div'); left.style.cssText = 'display:inline-flex;align-items:center;gap:3px';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺'; resetBtn.title = 'Reset';
    resetBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:10px;color:var(--color-dim);padding:0;opacity:0;pointer-events:none;transition:opacity 0.15s;line-height:1';

    left.append(lbl, resetBtn);

    // Right side: value (editable on click)
    const val = document.createElement('span');
    val.style.cssText = `font-size:11px;font-family:'IBM Plex Mono',monospace;color:${color};font-weight:500;cursor:pointer;`;
    val.textContent = fmt(def);

    const editInp = document.createElement('input');
    editInp.type = 'text';
    editInp.style.cssText = `display:none;font-size:11px;font-family:'IBM Plex Mono',monospace;color:${color};font-weight:500;background:transparent;border:none;border-bottom:1px solid ${color};outline:none;width:38px;text-align:right;padding:0`;

    const range = document.createElement('input'); range.type = 'range'; range.className = 'cad-range';
    range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(def);
    setSliderStyle(range, min, max, def, color);

    const update = (v: number) => {
      val.textContent = fmt(v);
      setSliderStyle(range, min, max, v, color);
      resetBtn.style.opacity = v === def ? '0' : '1';
      resetBtn.style.pointerEvents = v === def ? 'none' : 'auto';
      onInput(v);
    };

    range.oninput = () => update(parseFloat(range.value));

    resetBtn.onclick = () => { range.value = String(def); update(def); };

    val.onclick = () => {
      val.style.display = 'none'; editInp.style.display = 'inline';
      editInp.value = range.value; editInp.focus(); editInp.select();
    };
    const commitEdit = () => {
      const raw = parseFloat(editInp.value);
      if (!isNaN(raw)) {
        const clamped = Math.max(min, Math.min(max, Math.round(raw / step) * step));
        range.value = String(clamped); update(clamped);
      }
      editInp.style.display = 'none'; val.style.display = 'inline';
    };
    editInp.addEventListener('input', () => { editInp.value = editInp.value.replace(/[^\d\-\.]/g, ''); });
    editInp.addEventListener('blur', commitEdit);
    editInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
      if (e.key === 'Escape') { editInp.style.display = 'none'; val.style.display = 'inline'; }
    });

    hdr.append(left, val, editInp); wrap.append(hdr, range); return wrap;
  };

  slidersGrid.append(
    mkSlider(t('audioPlayer.tempo'),     30, 200,  1, 100, 'var(--color-accent)',  v => `${v}%`,                v => { tempo     = v; applyEffects(); }),
    mkSlider(t('audioPlayer.transpose'), -12, 12, 1,   0, 'var(--color-warn)',    v => `${v>=0?'+':''}${v} st`, v => { transpose = v; applyEffects(); }),
    mkSlider(t('audioPlayer.pitch'),  -100, 100,  1,   0, 'var(--color-success)', v => `${v>=0?'+':''}${v} ¢`,  v => { pitch     = v; applyEffects(); }),
  );
  slidersSection.appendChild(slidersGrid);
  root.append(waveSection, transport, slidersSection);

  // ── Waveform render ──
  let waveData: number[] = [];

  // Called on every animation frame while playing, so it does almost nothing
  // then: the bars are built once per width, and a frame only recolours the
  // ones whose state changed — usually none, the playhead crossing a bar every
  // duration/120 seconds. It used to empty the SVG and recreate all 120 bars
  // sixty times a second, ~7 000 elements a second plus their garbage — on
  // the thread that, until 2026-10-09, also computed the sound (see the top
  // of this file). The sound has its own thread now; a phone's main thread
  // still has better things to do.
  let bars: SVGRectElement[] = [];
  let barFills: string[] = [];
  let barsWidth = -1;

  const renderWave = (pos: number) => {
    const n = waveData.length; if (!n) return;
    const W = waveWrap.offsetWidth || 400;
    const H = 56;
    if (W !== barsWidth || bars.length !== n) {
      barsWidth = W;
      waveSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      waveSvg.setAttribute('width', String(W));
      waveSvg.innerHTML = '';
      const barW = Math.max(1, (W / n) * 0.65);
      const gap  = W / n;
      bars = []; barFills = [];
      for (let i = 0; i < n; i++) {
        const h = Math.max(3, (waveData[i] ?? 0) * H * 0.8 + H * 0.08);
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(i * gap)); rect.setAttribute('y', String((H - h) / 2));
        rect.setAttribute('width', String(barW)); rect.setAttribute('height', String(h));
        rect.setAttribute('rx', '1');
        waveSvg.appendChild(rect);
        bars.push(rect); barFills.push('');
      }
    }
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n * duration;
      const inReg = t >= regionStart && t <= regionEnd;
      const played = t <= pos;
      const fill = inReg && played ? 'var(--color-accent)' : inReg ? 'var(--color-accent-subtle)' : 'var(--color-border)';
      if (barFills[i] !== fill) { barFills[i] = fill; bars[i]!.setAttribute('fill', fill); }
    }
  };

  // Tracks what's currently rendered inside playBtn so updateUI (called on
  // every rAF tick while playing, ~60/s) only touches its innerHTML on an
  // actual play/pause state change. Churning it every frame regardless was
  // destroying and recreating the SVG under the user's pointer continuously
  // — if a click's mousedown/mouseup landed either side of one of those
  // ~16ms swaps, the browser had no live element to dispatch "click" to, so
  // the click was silently dropped. Pause is only clickable while playing
  // (i.e. exactly while this churn was running), which is why it looked
  // specifically broken.
  let iconIsPause = false;

  const updateUI = () => {
    const pos = getCurrentPos();
    renderWave(pos);
    playhead.style.left    = `${(pos / duration) * 100}%`;
    startHandle.style.left = `${(regionStart / duration) * 100}%`;
    endHandle.style.left   = `${(regionEnd   / duration) * 100}%`;
    timeCurrent.textContent = fmtTime(pos);
    timeRegion.textContent  = `${fmtTime(regionStart)} → ${fmtTime(regionEnd)}`;
    timeDur.textContent     = fmtTime(duration);
    if (playing !== iconIsPause) {
      playBtn.innerHTML = playing ? pauseIcon() : playIcon();
      iconIsPause = playing;
    }
  };

  // ── Playback ──

  /** Tells the node everything, effective `lead` from now — the node's own
   *  latency, so the change is taken exactly on time rather than "caught up"
   *  with. From `from` when given (a seek), else from wherever playback will
   *  be by then. A schedule() call drops whatever was scheduled after it, the
   *  region's end included, so this is the one place that schedules, and it
   *  re-arms that end every time. */
  const sendState = (from?: number) => {
    if (!stretch || !audioCtx) return;
    const out = audioCtx.currentTime + lead;
    const input = from ?? positionAt(out);
    anchorPos = input;
    anchorOut = out;
    anchorRate = rate();
    void stretch.schedule({
      output: out,
      active: true,
      input,
      rate: anchorRate,
      semitones: semitones(),
      // Equal bounds disable the loop (library README).
      loopStart: repeat ? regionStart : 0,
      loopEnd: repeat ? regionEnd : 0,
    });
    clearTimeout(endTimer);
    if (!repeat) {
      const end = out + Math.max(0, regionEnd - input) / anchorRate;
      void stretch.schedule({ output: end, active: false });
      endTimer = window.setTimeout(handleEnd, (end - audioCtx.currentTime + deviceLag()) * 1000);
    }
  };

  /** The sliders: taken at once while playing, read at the next play else. */
  const applyEffects = () => { if (playing) sendState(); };

  let suspendTimer = 0;
  /** An inactive node still runs its DSP on silence, so the context sleeps
   *  while nothing plays — a moment after a stop, never with it, so the node
   *  has faded out first. */
  const suspendSoon = () => {
    clearTimeout(suspendTimer);
    suspendTimer = window.setTimeout(() => {
      if (!playing && audioCtx?.state === 'running') void audioCtx.suspend();
    }, 400);
  };

  /** Pause and stop: the node goes inactive NOW — not `lead` ahead: the
   *  library then fades out as it catches up, rather than cutting. */
  const halt = () => {
    cancelAnimationFrame(rafId);
    clearTimeout(endTimer);
    playing = false;
    if (stretch && audioCtx) void stretch.schedule({ output: audioCtx.currentTime, active: false });
    updateUI();
    suspendSoon();
  };

  /** The region's natural end, without repeat: the node has already stopped
   *  itself (sendState scheduled it); the player catches up. */
  const handleEnd = () => {
    cancelAnimationFrame(rafId);
    playing = false;
    pausedPos = regionStart;
    updateUI();
    suspendSoon();
  };

  /** For a change of region or of repeat: carries on from where playback
   *  is, under the new bounds. */
  const restartHere = () => { if (playing) sendState(); };

  const seek = (offsetSecs: number) => {
    const pos = Math.max(0, Math.min(offsetSecs, duration));
    pausedPos = pos;
    if (playing) sendState(pos);
  };

  const teardown = () => {
    cancelAnimationFrame(rafId);
    clearTimeout(endTimer);
    clearTimeout(suspendTimer);
    stretch?.disconnect();
    stretch = null;
    playing = false;
  };

  /** One channel array per channel of the file. Copied into the worklet. */
  const loadInto = (node: StretchNode, b: AudioBuffer) =>
    node.addBuffers(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));

  /** The context and the node — built once, and again if another player's
   *  stopCurrentAudio() closed them under this one. */
  const ensureGraph = async () => {
    if (audioCtx && audioCtx.state !== 'closed' && stretch) return;
    stopCurrentAudio();
    const ctx = newPlayerContext();
    audioCtx = ctx;
    currentAudioCtx = ctx;
    currentDispose = teardown;
    const create = await loadStretch();
    const node = await create(ctx);
    node.connect(ctx.destination);
    stretch = node;
    lead = await node.latency();
    if (buffer) await loadInto(node, buffer);
  };

  const rafLoop = () => {
    updateUI();
    rafId = requestAnimationFrame(rafLoop);
  };

  const doPlay = async () => {
    await ensureGraph();
    if (!audioCtx || !stretch || !buffer) return;
    clearTimeout(suspendTimer);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    // Past the region's end there is nothing to play: from its start.
    if (pausedPos >= regionEnd) pausedPos = regionStart;
    playing = true;
    sendState(pausedPos);
    rafId = requestAnimationFrame(rafLoop);
    updateUI();
  };

  const doPause = () => {
    if (!playing) return;
    pausedPos = getCurrentPos();
    halt();
  };

  const doStop = () => {
    pausedPos = regionStart;
    halt();
  };

  // ── Controls ──
  stopBtn.onclick  = () => { doStop(); };
  playBtn.onclick  = () => { playing ? doPause() : void doPlay(); };
  repeatBtn.onclick = () => {
    repeat = !repeat;
    restartHere();
    repeatBtn.dataset['active'] = repeat ? '1' : '0';
    repeatBtn.style.borderColor = repeat ? 'var(--color-accent)' : 'var(--color-border)';
    repeatBtn.style.color       = repeat ? 'var(--color-accent)' : 'var(--color-muted)';
  };
  setStartBtn.onclick = () => { regionStart = Math.min(getCurrentPos(), regionEnd - 0.5); seek(regionStart); updateUI(); };
  setEndBtn.onclick   = () => {
    regionEnd = Math.max(getCurrentPos(), regionStart + 0.5);
    restartHere();
    updateUI();
  };
  resetBtn.onclick    = () => { regionStart = 0; regionEnd = duration; seek(0); updateUI(); };

  // Waveform drag → seek (follows pointer while held — Pointer Events cover
  // mouse, touch and pen with one set of listeners; the mouse-only version
  // of this never worked on mobile at all).
  waveWrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const doSeek = (ev: PointerEvent) => {
      const rect = waveWrap.getBoundingClientRect();
      const pos  = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * duration;
      seek(pos);
      updateUI();
    };
    doSeek(e);
    const onMove = (ev: PointerEvent) => doSeek(ev);
    const onUp   = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  });

  // Handle drag
  const addDrag = (handle: HTMLElement, isStart: boolean) => {
    handle.addEventListener('click', e => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const onMove = (ev: PointerEvent) => {
        const rect = waveWrap.getBoundingClientRect();
        const pos  = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * duration;
        if (isStart) regionStart = Math.min(pos, regionEnd - 0.5);
        else         regionEnd   = Math.max(pos, regionStart + 0.5);
        updateUI();
      };
      // The node gets the new bounds once, on release.
      const onUp = () => {
        window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
        restartHere();
      };
      window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    });
  };
  addDrag(startHandle, true);
  addDrag(endHandle, false);

  // ── Init ──
  void (async () => {
    try {
      await ensureGraph();
      buffer   = await decodeAudio(entry, audioCtx!);
      duration = buffer.duration;
      regionEnd = duration;
      waveData = buildWaveformData(buffer);
      await loadInto(stretch!, buffer);
      // Silent until the user hits play.
      suspendSoon();

      loading.remove();
      waveSection.style.display    = 'flex';
      transport.style.display      = 'flex';
      slidersSection.style.display = 'block';
      updateUI();
    } catch (err) {
      loading.textContent = t('audioPlayer.error', { msg: err instanceof Error ? err.message : String(err) });
    }
  })();

  return root;
}
