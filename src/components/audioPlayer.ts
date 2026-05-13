import { SoundTouch, SimpleFilter, WebAudioBufferSource, getWebAudioNode } from '@soundtouchjs/core';
import type { FileEntry } from '../types';
import { t } from '../services/i18nService';

// ── Global audio context (one at a time) ────────────────────────────────────

let currentAudioCtx: AudioContext | null = null;

export function stopCurrentAudio(): void {
  currentAudioCtx?.close();
  currentAudioCtx = null;
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
  let audioCtx:    AudioContext    | null = null;
  let buffer:      AudioBuffer     | null = null;
  let st:          SoundTouch      | null = null;
  let filter:      SimpleFilter    | null = null;
  let scriptNode:  ScriptProcessorNode | null = null;

  let playing    = false;
  let repeat     = true;
  let duration   = 1;
  let regionStart = 0;
  let regionEnd   = 1;
  let rafId      = 0;

  let tempo     = 100;   // %
  let transpose = 0;     // semitones
  let pitch     = 0;     // cents

  const sampleRate = () => buffer?.sampleRate ?? 44100;
  const getCurrentPos = () =>
    filter ? Math.min(filter.sourcePosition / sampleRate(), regionEnd) : regionStart;

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
  waveWrap.style.cssText = 'position:relative;height:56px;cursor:pointer;user-select:none';

  const waveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  waveSvg.setAttribute('height', '56');
  waveSvg.style.cssText = 'display:block;width:100%;pointer-events:none';

  const playhead = document.createElement('div');
  playhead.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:var(--color-accent);pointer-events:none;z-index:3';

  const startHandle = document.createElement('div');
  startHandle.style.cssText = 'position:absolute;top:0;bottom:0;width:3px;background:var(--color-accent);cursor:ew-resize;z-index:4;transform:translateX(-1px)';
  const endHandle = document.createElement('div');
  endHandle.style.cssText = 'position:absolute;top:0;bottom:0;width:3px;background:var(--color-accent);cursor:ew-resize;z-index:4;transform:translateX(-1px)';

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

  const mkBtn = (text: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = 'padding:3px 8px;font-size:13px;background:transparent;border:1px solid var(--color-border);border-radius:4px;color:var(--color-muted);cursor:pointer;font-family:"IBM Plex Mono",monospace;line-height:1.4';
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

  const playBtn     = mkBtn('▶',  t('audioPlayer.play'));
  const stopBtn     = mkBtn('■',  t('audioPlayer.stop'));
  const repeatBtn   = mkBtn('↻',  t('audioPlayer.repeat'));
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

  const renderWave = (pos: number) => {
    const n = waveData.length; if (!n) return;
    const W = waveWrap.offsetWidth || 400;
    const H = 56;
    waveSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    waveSvg.setAttribute('width', String(W));
    waveSvg.innerHTML = '';
    const barW = Math.max(1, (W / n) * 0.65);
    const gap  = W / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n * duration;
      const inReg = t >= regionStart && t <= regionEnd;
      const played = t <= pos;
      const fill = inReg && played ? 'var(--color-accent)' : inReg ? 'var(--color-accent-subtle)' : 'var(--color-border)';
      const h = Math.max(3, (waveData[i] ?? 0) * H * 0.8 + H * 0.08);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(i * gap)); rect.setAttribute('y', String((H - h) / 2));
      rect.setAttribute('width', String(barW)); rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '1'); rect.setAttribute('fill', fill);
      waveSvg.appendChild(rect);
    }
  };

  const updateUI = () => {
    const pos = getCurrentPos();
    renderWave(pos);
    playhead.style.left    = `${(pos / duration) * 100}%`;
    startHandle.style.left = `${(regionStart / duration) * 100}%`;
    endHandle.style.left   = `${(regionEnd   / duration) * 100}%`;
    timeCurrent.textContent = fmtTime(pos);
    timeRegion.textContent  = `${fmtTime(regionStart)} → ${fmtTime(regionEnd)}`;
    timeDur.textContent     = fmtTime(duration);
    playBtn.textContent     = playing ? '⏸' : '▶';
  };

  // ── SoundTouch pipeline ──
  const applyEffects = () => {
    if (!st) return;
    st.tempo = tempo / 100;
    st.pitchSemitones = transpose + pitch / 100;
  };

  const seek = (offsetSecs: number) => {
    if (!filter || !buffer) return;
    const frame = Math.round(Math.max(0, Math.min(offsetSecs, duration)) * sampleRate());
    filter.sourcePosition = frame; // clears SoundTouch buffers + sets read head
  };

  const teardown = () => {
    cancelAnimationFrame(rafId);
    scriptNode?.disconnect();
    scriptNode = null;
    filter = null;
    st = null;
  };

  const buildPipeline = () => {
    teardown();
    if (!audioCtx || !buffer) return;

    const source = new WebAudioBufferSource(buffer);
    st = new SoundTouch();
    applyEffects();

    filter = new SimpleFilter(source, st, () => {
      // Natural end of buffer
      handleEnd();
    });

    seek(regionStart);

    scriptNode = getWebAudioNode(audioCtx, filter, (srcPos) => {
      // Called from onaudioprocess — check region end
      if (srcPos / sampleRate() >= regionEnd) handleEnd();
    });
    scriptNode.connect(audioCtx.destination);
  };

  const handleEnd = () => {
    if (repeat) {
      seek(regionStart);
    } else {
      // Synchronous: update state before any event loop tick can interleave
      cancelAnimationFrame(rafId);
      playing = false;
      seek(regionStart);
      void audioCtx?.suspend();
      updateUI();
    }
  };

  const rafLoop = () => {
    updateUI();
    rafId = requestAnimationFrame(rafLoop);
  };

  const doPlay = async () => {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      currentAudioCtx = audioCtx;
      buildPipeline();
    }
    if (!scriptNode) buildPipeline();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    playing = true;
    rafId = requestAnimationFrame(rafLoop);
    updateUI();
  };

  const doPause = async () => {
    cancelAnimationFrame(rafId);
    if (audioCtx?.state === 'running') await audioCtx.suspend();
    playing = false;
    updateUI();
  };

  const doStop = () => {
    cancelAnimationFrame(rafId);
    playing = false;
    seek(regionStart);
    void audioCtx?.suspend();
    updateUI();
  };

  // ── Controls ──
  stopBtn.onclick  = () => { doStop(); };
  playBtn.onclick  = () => { playing ? void doPause() : void doPlay(); };
  repeatBtn.onclick = () => {
    repeat = !repeat;
    repeatBtn.dataset['active'] = repeat ? '1' : '0';
    repeatBtn.style.borderColor = repeat ? 'var(--color-accent)' : 'var(--color-border)';
    repeatBtn.style.color       = repeat ? 'var(--color-accent)' : 'var(--color-muted)';
  };
  setStartBtn.onclick = () => { regionStart = Math.min(getCurrentPos(), regionEnd - 0.5); seek(regionStart); updateUI(); };
  setEndBtn.onclick   = () => { regionEnd   = Math.max(getCurrentPos(), regionStart + 0.5); updateUI(); };
  resetBtn.onclick    = () => { regionStart = 0; regionEnd = duration; seek(0); updateUI(); };

  // Waveform drag → seek (follows mouse while held)
  waveWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const doSeek = (ev: MouseEvent) => {
      const rect = waveWrap.getBoundingClientRect();
      const pos  = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * duration;
      seek(pos);
      updateUI();
    };
    doSeek(e);
    const onMove = (ev: MouseEvent) => doSeek(ev);
    const onUp   = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });

  // Handle drag
  const addDrag = (handle: HTMLElement, isStart: boolean) => {
    handle.addEventListener('click', e => e.stopPropagation());
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const onMove = (ev: MouseEvent) => {
        const rect = waveWrap.getBoundingClientRect();
        const pos  = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * duration;
        if (isStart) regionStart = Math.min(pos, regionEnd - 0.5);
        else         regionEnd   = Math.max(pos, regionStart + 0.5);
        updateUI();
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
  };
  addDrag(startHandle, true);
  addDrag(endHandle, false);

  // ── Init ──
  void (async () => {
    try {
      stopCurrentAudio();
      audioCtx = new AudioContext();
      currentAudioCtx = audioCtx;
      await audioCtx.suspend(); // stay silent until user hits play

      buffer   = await decodeAudio(entry, audioCtx);
      duration = buffer.duration;
      regionEnd = duration;
      waveData = buildWaveformData(buffer);

      buildPipeline();

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
