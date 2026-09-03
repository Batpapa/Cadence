import LZString from 'lz-string';
import type { FileEntry } from '../types';
import { entryToObjectUrl, arrayBufferToBase64, focusIfDesktop } from '../utils';
import { getMarked } from './markdown';
import { mkCustomSelect } from './customSelectVanilla';
import { starIconElement, iconElement, ExternalLinkIcon, GearIcon } from './icons';
import { t } from '../services/i18nService';
import { TUNE_TEMPOS, isAbcFile, decodeAbc, splitAbcTunes } from '../services/abcService';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import { showModal } from './modal';
import { appState, mutate } from '../store';

// ── ABC Transcription Tools share-link integration ────────────────────────────
// https://michaeleskin.com/abctools/userguide.html#generate_share_link — the
// documented, sanctioned integration format: LZ-String-compress the ABC text
// into a URL-safe string and pass it as `lzw=`. format=noten/editor=1 opens
// the tune straight into the editor with standard notation, matching what
// this modal already shows.
const ABC_TOOLS_BASE_URL = 'https://michaeleskin.com/abctools/abctools.html';

function abcToolsShareUrl(tuneText: string): string {
  const titleMatch = tuneText.match(/^T:\s*(.+)/m);
  const name = titleMatch ? titleMatch[1]!.trim() : 'Cadence_Tune';
  const params = new URLSearchParams({
    lzw: LZString.compressToEncodedURIComponent(tuneText),
    format: 'noten',
    name,
    editor: '1',
  });
  return `${ABC_TOOLS_BASE_URL}?${params.toString()}`;
}

// General MIDI program numbers (0-indexed) for instruments relevant to Irish
// trad — GM happens to have dedicated Fiddle/Whistle/Banjo/Bagpipe patches.
const ABC_INSTRUMENTS = [
  { value: '',    labelKey: 'fileViewer.abc.instrument.default' },
  { value: '110', labelKey: 'fileViewer.abc.instrument.fiddle' },
  { value: '78',  labelKey: 'fileViewer.abc.instrument.whistle' },
  { value: '73',  labelKey: 'fileViewer.abc.instrument.flute' },
  { value: '21',  labelKey: 'fileViewer.abc.instrument.accordion' },
  { value: '105', labelKey: 'fileViewer.abc.instrument.banjo' },
  { value: '109', labelKey: 'fileViewer.abc.instrument.pipes' },
  { value: '25',  labelKey: 'fileViewer.abc.instrument.guitar' },
];

/** Score playback speed, as a percentage of what is written. The bounds are
 *  what abcjs will actually warp to without the audio falling apart, and the
 *  low end is the point of the setting: a tune you are learning is worth
 *  hearing at half speed. */
const DEFAULT_TEMPO_PERCENT = 100;
const MIN_TEMPO_PERCENT = 10;
const MAX_TEMPO_PERCENT = 300;

function abcTempoPercent(): number {
  const stored = appState.value.abcTempoPercent;
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_TEMPO_PERCENT;
  return Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, Math.round(stored)));
}

// ── MIME helpers ──────────────────────────────────────────────────────────────

function isText(entry: FileEntry): boolean {
  return entry.mimeType.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt');
}

function isMarkdown(entry: FileEntry): boolean {
  return entry.mimeType === 'text/markdown' || entry.name.endsWith('.md');
}


function injectDefaultTempo(abc: string): string {
  if (/^Q:/m.test(abc)) return abc;
  const rMatch = abc.match(/^R:\s*(.+)/m);
  const tempo = rMatch ? TUNE_TEMPOS[rMatch[1]!.trim().toLowerCase()] : undefined;
  if (!tempo) return abc;
  return abc.replace(/^(K:[^\n]*)/m, `$1\nQ: ${tempo}`);
}

/** How far before a clicked note to seek — see the click handler for why an
 *  exact seek lands on the wrong note. */
const SEEK_BACKOFF_MS = 10;

/** The nearest scrolling box, starting with the element itself — the score has
 *  its own viewport, and it is that one, not the modal around it, that should
 *  move. Walking on up is a fallback for whatever hosts a score tomorrow. */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** Playback preferences, reachable from any score's header and stored on the
 *  user, so they travel with everything else through Drive. They describe the
 *  listener rather than the tune: which instrument to hear it on, and how fast
 *  a score should open when you are still learning it.
 *
 *  `onApply` re-primes the score that is open, so a change is heard at once
 *  instead of at the next opening. */
export function showAbcPrefsModal(onApply: () => void): void {
  const body = document.createElement('div');
  body.className = 'space-y-4';

  /** One setting per line: its name on the left, its control on the right. */
  const row = (labelKey: string, control: HTMLElement): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'flex items-center justify-between gap-3';
    const label = document.createElement('label');
    label.className = 'label shrink-0';
    label.textContent = t(labelKey);
    line.append(label, control);
    return line;
  };

  // ── Default speed ──
  const speedControl = document.createElement('div');
  speedControl.className = 'flex items-center gap-2 shrink-0';
  const speedInput = document.createElement('input');
  speedInput.type = 'number';
  speedInput.min = String(MIN_TEMPO_PERCENT);
  speedInput.max = String(MAX_TEMPO_PERCENT);
  speedInput.step = '5';
  speedInput.className = 'input w-20 text-sm';
  speedInput.value = String(abcTempoPercent());
  const speedUnit = document.createElement('span');
  speedUnit.className = 'text-xs text-dim';
  speedUnit.textContent = '%';
  speedControl.append(speedInput, speedUnit);

  /** Saved on every change, with no confirmation step: each setting is one
   *  value, instantly undone by setting it back. A Cancel button would only
   *  invite the question of what it reverts. */
  const persist = () => {
    const raw = parseInt(speedInput.value, 10);
    const percent = isNaN(raw) ? DEFAULT_TEMPO_PERCENT
      : Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, raw));
    speedInput.value = String(percent);
    const instrument = getInstrument();
    void mutate(st => {
      // Absent rather than stored when it is the default: nothing to carry
      // through Drive, and nothing to explain to a future reader.
      if (percent === DEFAULT_TEMPO_PERCENT) delete st.abcTempoPercent; else st.abcTempoPercent = percent;
      if (instrument === '') delete st.abcInstrument; else st.abcInstrument = parseInt(instrument, 10);
    });
  };

  // Speed is SAVED ONLY. Re-priming the score would stop whatever is playing —
  // renderTune pauses and rebuilds the audio buffer — and it could not even
  // change the speed, which is frozen at the moment the score opened. All
  // disruption, no effect.
  //
  // `change`, not `input`: typing "150" passes through "1" and "15", and each
  // would be written as a preference nobody asked for.
  speedInput.addEventListener('change', persist);

  // ── Instrument ──
  const stored = appState.value.abcInstrument;
  const { el: instrSelect, getValue: getInstrument } = mkCustomSelect(
    ABC_INSTRUMENTS.map(i => ({ value: i.value, label: t(i.labelKey) })),
    stored === undefined ? '' : String(stored),
    // The instrument DOES re-prime: hearing it is the whole point of picking
    // one, and it is a change the current score can actually take on.
    () => { persist(); onApply(); },
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
  );
  // The select's own wrapper is `flex:1`, so it takes what the label leaves.
  instrSelect.style.maxWidth = '14rem';

  body.append(
    row('fileViewer.abc.prefs.speed', speedControl),
    row('fileViewer.abc.instrument', instrSelect),
  );

  // No footer: nothing to confirm, so nothing to press. The ✕ is the only way
  // out, and it closes on a state that has already been saved.
  showModal(t('fileViewer.abc.prefs.title'), body, []);
  focusIfDesktop(speedInput);
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function modalWidth(entry: FileEntry): string {
  const m = entry.mimeType;
  if (m.startsWith('audio/') || (isText(entry) && !isAbcFile(entry))) return '560px';
  return '860px';
}

export interface PreviewModalOpts {
  /** Multi-tune ABC files: which splitAbcTunes() index to open at — the
   *  attachment's stored `preferredIndex`, if any. */
  initialIndex?: number;
  /** Called when the user stars a version as the new default. Independent of
   *  `onSave` — available in read-only contexts (study) too, since picking a
   *  favorite version isn't "editing" the card's content. */
  onSetPreferredIndex?: (index: number) => void;
}

export function showPreviewModal(entry: FileEntry, onSave?: (data: string) => void, opts?: PreviewModalOpts): void {
  // Overlay/dialog/header/close-button/outside-click/Escape are the shared
  // Preact modal shell (modal.tsx, 2026-08-26) now — only this format-specific
  // body is still hand-built here. `stopAudio`/`closed` (assigned deeper in
  // the audio/abc branches below) are read by onDismiss, called once the
  // modal actually closes for any reason (✕, outside click, Escape).
  let stopAudio: () => void = () => {};
  let closed = false;
  const onDismiss = () => { closed = true; stopAudio(); };

  const body = document.createElement('div');
  body.className = 'w-full flex items-center justify-center';

  // Filled in by the ABC branch; the header gear needs a way to re-prime the
  // score once preferences change, and only that branch knows how.
  let reapplyAbcPrefs: (() => void) | null = null;

  const m = entry.mimeType;
  // 0.85 (not 0.9) to match the shared modal shell's own dialog max-height
  // (modal.tsx) now that this modal is portaled through it — media sized
  // against a bigger budget than the dialog actually allows would overflow.
  const mediaMaxH = `calc(${modalMaxH(0.85)} - 80px)`;

  if (m.startsWith('audio/')) {
    body.classList.replace('items-center', 'items-start');
    import('./audioPlayer').then(({ renderAudioPlayer, stopCurrentAudio }) => {
      // Modal may already have been dismissed while this dynamic import was
      // in flight — don't spin up an AudioContext nobody will ever close.
      if (closed) return;
      body.appendChild(renderAudioPlayer(entry));
      stopAudio = stopCurrentAudio;
    });

  } else if (m.startsWith('video/')) {
    const video = document.createElement('video'); video.controls = true; video.className = 'max-w-full rounded';
    video.style.maxHeight = mediaMaxH;
    video.src = entryToObjectUrl(entry);
    body.appendChild(video);

  } else if (m.startsWith('image/')) {
    const img = document.createElement('img'); img.src = entryToObjectUrl(entry); img.alt = entry.name;
    img.className = 'max-w-full object-contain rounded';
    img.style.maxHeight = mediaMaxH;
    img.style.cursor = 'zoom-in';

    img.addEventListener('click', () => {
      const lightbox = document.createElement('div');
      lightbox.style.cssText = 'position:fixed;inset:0;z-index:100;background:black;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
      const big = document.createElement('img');
      big.src = img.src; big.alt = img.alt;
      big.style.cssText = `max-width:${modalMaxW(1.0)};max-height:${modalMaxH(1.0)};object-fit:contain;`;
      lightbox.appendChild(big);
      const closeLightbox = () => { lightbox.remove(); document.removeEventListener('keydown', onLightboxKey); };
      const onLightboxKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); closeLightbox(); } };
      document.addEventListener('keydown', onLightboxKey, true);
      lightbox.addEventListener('click', closeLightbox);
      document.body.appendChild(lightbox);
    });

    body.appendChild(img);

  } else if (m === 'application/pdf') {
    const embed = document.createElement('embed'); embed.src = entryToObjectUrl(entry);
    embed.type = 'application/pdf'; embed.className = 'w-full rounded';
    embed.style.height = mediaMaxH;
    body.appendChild(embed);

  } else if (isAbcFile(entry)) {
    body.classList.replace('items-center', 'items-start');
    let abcText = decodeAbc(entry);

    const tunes = splitAbcTunes(abcText);
    const versionCount = tunes.length;
    let currentIndex = Math.max(0, Math.min(versionCount - 1, opts?.initialIndex ?? 0));
    let favoriteIndex = opts?.initialIndex;
    let currentMode: 'sheet' | 'text' = 'sheet';
    // Set when a text-mode edit is saved while notation is hidden — abcjs's
    // resize handling can make the SVG visibly reflow back in even inside a
    // display:none container (see setAbcMode's comment below), so the
    // re-render is deferred until the Sheet tab is actually reopened instead
    // of running immediately into the hidden view.
    let sheetNeedsRerender = false;
    // Both come from the user's preferences now; the score itself has no say,
    // and no per-score override — one place to set it, one place to look.
    let selectedProgram: number | undefined = appState.value.abcInstrument;
    // Read ONCE, when the score opens, and never again. The setting is "how
    // fast a score starts", so changing it must leave the score already open
    // exactly as it is — including a speed the user has since dialled in on the
    // transport. The instrument, by contrast, is re-read on every re-prime:
    // hearing the change at once is the point of choosing one.
    const openingTempoPercent = abcTempoPercent();

    const container = document.createElement('div');
    container.className = 'w-full space-y-3';

    // ── Top row: Sheet/ABC tabs (left) + version nav (right, multi-tune files only) ──
    const topRow = document.createElement('div');
    topRow.className = 'flex items-center justify-between gap-2';

    const tabBar = document.createElement('div');
    tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg w-fit';
    const mkAbcTab = (label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer';
      return b;
    };
    const sheetTabBtn = mkAbcTab(t('fileViewer.abc.sheetTab'));
    const textTabBtn  = mkAbcTab(t('fileViewer.abc.textTab'));
    sheetTabBtn.onclick = () => setAbcMode('sheet');
    textTabBtn.onclick  = () => setAbcMode('text');
    tabBar.append(sheetTabBtn, textTabBtn);

    const versionNav = document.createElement('div');
    versionNav.className = `flex items-center gap-1 p-1 bg-bg rounded-lg w-fit ${versionCount <= 1 ? 'hidden' : ''}`;
    const mkNavBtn = (glyph: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = glyph;
      b.className = 'px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer text-muted hover:text-primary hover:bg-elevated disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted';
      return b;
    };
    const prevBtn = mkNavBtn('←');
    const versionLabel = document.createElement('span');
    versionLabel.className = 'px-1 text-xs font-medium text-muted tabular-nums';
    const nextBtn = mkNavBtn('→');
    prevBtn.onclick = () => goToVersion(currentIndex - 1);
    nextBtn.onclick = () => goToVersion(currentIndex + 1);
    versionNav.append(prevBtn, versionLabel, nextBtn);

    // ★ "set as default version" — independent of onSave, works read-only too
    // (picking a favorite version isn't editing the card's content). Declared
    // before goToVersion() below so it can refresh the star on every navigation.
    let updateStarBtn: (() => void) | null = null;
    const onSetPreferredIndex = opts?.onSetPreferredIndex;
    if (onSetPreferredIndex) {
      const starBtn = document.createElement('button');
      updateStarBtn = () => {
        const isFavorite = currentIndex === favoriteIndex;
        starBtn.innerHTML = '';
        starBtn.appendChild(starIconElement(isFavorite, 12));
        starBtn.className = `px-2 py-1 rounded transition-colors cursor-pointer ${isFavorite ? 'text-warn' : 'text-muted hover:text-warn'}`;
        starBtn.title = t(isFavorite ? 'fileViewer.abc.isDefault' : 'fileViewer.abc.setDefault');
      };
      starBtn.onclick = () => {
        favoriteIndex = currentIndex;
        onSetPreferredIndex(currentIndex);
        updateStarBtn!();
      };
      updateStarBtn();
      versionNav.insertBefore(starBtn, nextBtn);
    }

    const abcToolsLink = document.createElement('a');
    abcToolsLink.target = '_blank';
    abcToolsLink.rel = 'noopener noreferrer';
    abcToolsLink.title = t('fileViewer.abc.openInAbcTools');
    abcToolsLink.className = 'px-2 py-1 rounded transition-colors cursor-pointer text-muted hover:text-accent shrink-0';
    abcToolsLink.appendChild(iconElement(ExternalLinkIcon, 13));

    topRow.append(tabBar, versionNav, abcToolsLink);
    container.appendChild(topRow);

    const uid = Date.now();
    const controls = document.createElement('div');
    controls.id = `abc-controls-${uid}`;
    // Pinned to the top of the modal while it scrolls, the same way the tune
    // analyser pins its own transport. Without this, following the cursor down
    // a long score pushed play/stop out of view — and reaching them meant
    // scrolling back up against the very scrolling that carried them away.
    //
    // `-top-4` cancels the modal body's own `py-4`: a scroll container's
    // padding is part of its scrollport, so content passes visibly through it,
    // and a bar pinned at `top-0` would leave that 16px strip of score showing
    // above itself. Offset by exactly the padding, it lands flush against the
    // header instead. Opaque background and a stacking order, or the notation
    // shows through.
    controls.className = 'sticky -top-4 z-10 bg-elevated py-2';
    container.appendChild(controls);

    const notation = document.createElement('div');
    // Its own scrolling viewport, capped well below the modal's height: the
    // score is the only thing that should move while the cursor advances. When
    // the modal body was the scroller, centring a staff dragged the tabs and
    // the transport controls out of view along with it.
    notation.className = 'w-full bg-white rounded p-2 overflow-y-auto';
    notation.style.maxHeight = modalMaxH(0.5);
    notation.style.color = '#000';
    notation.id = `abc-notation-${uid}`;
    container.appendChild(notation);

    // ── Raw ABC text of the SELECTED tune only — editable and saved back to
    // the attachment when the caller passed a save callback (card view);
    // read-only otherwise (study).
    const textarea = document.createElement('textarea');
    textarea.className = 'hidden w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent';
    textarea.spellcheck = false;
    textarea.readOnly = !onSave;
    textarea.value = tunes[0] ?? '';
    container.appendChild(textarea);

    const saveRow = document.createElement('div');
    saveRow.className = 'hidden flex items-center justify-end gap-2';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'text-xs text-dim';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary text-xs';
    saveBtn.textContent = t('fileViewer.abc.save');
    saveBtn.disabled = true;
    saveRow.append(saveStatus, saveBtn);
    container.appendChild(saveRow);

    body.appendChild(container);

    let doRenderTune: ((index: number) => void) | null = null;

    // The "X:n" header line is the tune's identity within the file (what
    // splitAbcTunes keys the version split on) — never shown/editable, so the
    // user can't desync it from its position and corrupt the file structure.
    function splitXLine(tune: string): { xLine: string; body: string } {
      const nl = tune.indexOf('\n');
      const firstLine = nl === -1 ? tune : tune.slice(0, nl);
      if (/^X:\s*\d+/.test(firstLine)) return { xLine: firstLine, body: nl === -1 ? '' : tune.slice(nl + 1) };
      return { xLine: '', body: tune };
    }
    const currentBody = (): string => splitXLine(tunes[currentIndex] ?? '').body;

    function goToVersion(index: number): void {
      currentIndex = Math.max(0, Math.min(versionCount - 1, index));
      prevBtn.disabled = currentIndex === 0;
      nextBtn.disabled = currentIndex === versionCount - 1;
      versionLabel.textContent = `${currentIndex + 1}/${versionCount}`;
      updateStarBtn?.();
      abcToolsLink.href = abcToolsShareUrl(tunes[currentIndex] ?? '');
      if (currentMode === 'sheet') {
        doRenderTune?.(currentIndex);
      } else {
        textarea.value = currentBody();
        saveBtn.disabled = true;
        saveStatus.textContent = '';
      }
    }

    function setAbcMode(mode: 'sheet' | 'text'): void {
      currentMode = mode;
      const active = 'bg-accent text-white';
      const inactive = 'text-muted hover:text-primary hover:bg-elevated';
      sheetTabBtn.className = `px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${mode === 'sheet' ? active : inactive}`;
      textTabBtn.className  = `px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${mode === 'text'  ? active : inactive}`;
      // Sheet + synth toolbar fully hidden in text mode, not just visually behind
      // it — inline style.display, not just the 'hidden' class: abcjs's own
      // resize handling can otherwise leave the notation SVG visibly reflowing.
      controls.style.display = mode === 'sheet' ? '' : 'none';
      notation.style.display = mode === 'sheet' ? '' : 'none';
      textarea.style.display = mode === 'text' ? 'block' : 'none';
      if (onSave) saveRow.style.display = mode === 'text' ? 'flex' : 'none';
      if (mode === 'sheet' && sheetNeedsRerender) {
        sheetNeedsRerender = false;
        doRenderTune?.(currentIndex);
      }
      if (mode === 'text') {
        textarea.value = currentBody();
        saveBtn.disabled = true;
        saveStatus.textContent = '';
        focusIfDesktop(textarea);
      }
    }

    if (onSave) {
      textarea.addEventListener('input', () => {
        saveBtn.disabled = textarea.value === currentBody();
        saveStatus.textContent = '';
      });
      saveBtn.onclick = () => {
        const { xLine } = splitXLine(tunes[currentIndex] ?? '');
        tunes[currentIndex] = xLine ? `${xLine}\n${textarea.value}` : textarea.value;
        // Tunes already carry their trailing separator from splitAbcTunes —
        // plain '\n' join reconstructs the file without doubling blank lines.
        abcText = tunes.join('\n');
        onSave(arrayBufferToBase64(new TextEncoder().encode(abcText).buffer));
        saveBtn.disabled = true;
        saveStatus.textContent = t('fileViewer.abc.saved');
        sheetNeedsRerender = true; // re-render lazily once Sheet is reopened — see setAbcMode
        abcToolsLink.href = abcToolsShareUrl(tunes[currentIndex] ?? '');
      };
    }

    goToVersion(currentIndex); // initializes prev/next disabled state + label (respects opts.initialIndex)
    setAbcMode('sheet');

    import('abcjs').then((abcjs) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let synthControl: any = null;

      // Cursor + note highlighting during playback — abcjs drives this via
      // TimingCallbacks internally once a cursorControl is passed to
      // SynthController.load(). Re-queries the SVG/cursor by ID each call
      // rather than caching elements, since renderAbc replaces the SVG
      // wholesale on every version switch.
      // Keeps the played staff in the middle of what is visible of the score —
      // a fused set runs to several systems, and reading it meant scrolling by
      // hand while playing.
      //
      // Driven off `ev.top`, the staff line's own y, so this fires ONCE per
      // system rather than on every note: scrolling eight times a second would
      // be unusable, and would fight anyone touching the scrollbar.
      let lastCursorTop: number | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const followCursor = (ev: any) => {
        if (ev.top == null || ev.top === lastCursorTop) return;
        lastCursorTop = ev.top;
        const scroller = nearestScroller(notation);
        if (!scroller) return;
        // The cursor line, whose y1/y2 were just set to this system's extent,
        // measures the staff exactly — better than a note, which sits wherever
        // its pitch puts it and would drag the centring up or down with the
        // melody.
        const marker = (notation.querySelector('.abcjs-cursor') as SVGGraphicsElement | null)
          ?? ((ev.elements?.[0]?.[0] ?? null) as SVGGraphicsElement | null);
        if (!marker) return;
        // Both rects come from the same (zoomed) coordinate space, but
        // scrollBy works in unzoomed layout pixels — see zoomService's note on
        // CSS zoom and getBoundingClientRect.
        const z = getZoom() / 100;
        const m = marker.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        // Centre the current staff in what is visible of the score. Near the
        // start or the end there is not enough score to centre against; the
        // browser clamps the scroll to its bounds, which IS the best available
        // position, so no special case is needed for either edge.
        const delta = (m.top + m.height / 2 - s.top) / z - scroller.clientHeight / 2;
        if (Math.abs(delta) < 1) return;
        scroller.scrollBy({
          top: delta,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      };

      const cursorControl = {
        beatSubdivisions: 2,
        onStart: () => {
          lastCursorTop = null;
          const svg = notation.querySelector('svg');
          if (!svg || svg.querySelector('.abcjs-cursor')) return;
          const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          cursor.setAttribute('class', 'abcjs-cursor');
          cursor.setAttribute('x1', '0'); cursor.setAttribute('y1', '0');
          cursor.setAttribute('x2', '0'); cursor.setAttribute('y2', '0');
          svg.appendChild(cursor);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEvent: (ev: any) => {
          if (ev.measureStart && ev.left === null) return; // 2nd half of a tie across a measure line
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          for (const note of ev.elements ?? []) {
            for (const el of note) el.classList.add('abcjs-highlight');
          }
          const cursor = notation.querySelector('.abcjs-cursor');
          if (cursor && ev.left != null) {
            cursor.setAttribute('x1', String(ev.left - 2));
            cursor.setAttribute('x2', String(ev.left - 2));
            cursor.setAttribute('y1', String(ev.top));
            cursor.setAttribute('y2', String(ev.top + ev.height));
          }
          followCursor(ev);
        },
        onFinished: () => {
          lastCursorTop = null;
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          const cursor = notation.querySelector('.abcjs-cursor');
          cursor?.setAttribute('x1', '0'); cursor?.setAttribute('x2', '0');
          cursor?.setAttribute('y1', '0'); cursor?.setAttribute('y2', '0');
        },
      };

      // Resolves once the audio buffer for the current render is built. Held so
      // a caller can act after the tune is actually playable, rather than after
      // the notation has merely been drawn.
      let primed: Promise<unknown> = Promise.resolve();

      const renderTune = (index: number) => {
        const visualObj = abcjs.renderAbc(notation.id, injectDefaultTempo(tunes[index] ?? ''), {
          responsive: 'resize',
          add_classes: true,
          paddingright: 0,
          paddingleft: 0,
          format: { gchordfont: 'Verdana 12', annotationfont: 'Verdana 12' },
          // Clicking a note makes abcjs paint it as "selected", and it only
          // repaints on the NEXT click — so the clicked note stayed coloured
          // alongside whatever the playback cursor was colouring, showing two
          // marked notes at once. Selection is still what carries the click; it
          // just has nothing to say visually here, the cursor jumping to the
          // note being the answer. Painting it the foreground colour is how
          // abcjs is asked to keep quiet.
          selectionColor: '#000',
          // Click a note, play from there. `dragging` is left off, so this
          // only ever selects — abcjs's note-dragging (which would edit
          // pitches) needs that flag and never gets it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          clickListener: (abcElem: any, _tuneNumber: number, _classes: string, _analysis: unknown, _drag: unknown, ev?: MouseEvent) => {
            // Only a click that actually landed ON a note may move the cursor.
            // Without a direct hit abcjs falls back to "nearest selectable",
            // which happily returns something on the other side of the page —
            // and a click meant for empty space would jump the playhead.
            //
            // A click on drawn ink targets that glyph; a click on blank staff
            // targets the <svg> itself, since a <g> has no geometry to hit. So
            // the root being the target IS the miss. abcjs's own full-synth
            // example does not guard this at all — it is the answer to a
            // problem the example never has, its score being one short line.
            const target = ev?.target as Element | undefined;
            if (!target || target.nodeName.toLowerCase() === 'svg') return;
            // "Is this a sounding note", written the way the library's own
            // example writes it: no MIDI pitches, nothing to play from — which
            // also rules out clefs, barlines, tempo marks and rests.
            if (!abcElem?.midiPitches) return;
            // The MIDI flattener stamps every element it schedules with its own
            // position, so the score already knows when each note is played —
            // no mapping to build. An element inside a `:|` repeat carries an
            // array, one entry per pass; the earliest is the predictable pick.
            const ms = abcElem?.currentTrackMilliseconds;
            const at = Array.isArray(ms) ? ms[0] : ms;
            if (typeof at !== 'number' || !synthControl) return;
            // Land just BEFORE the note, never exactly on it. abcjs picks the
            // current event with a strict `milliseconds < currentTime`, and the
            // note's stamp and the timing table are computed down two different
            // float paths — when rounding leaves the table a hair lower, an
            // exact seek steps past the note and selects the next one. A few
            // milliseconds of margin is far below the shortest note in this
            // music (a sixteenth in a fast reel is about 80ms) and puts the
            // comparison out of reach of the noise.
            try { synthControl.seek(Math.max(0, at - SEEK_BACKOFF_MS) / 1000, 'seconds'); }
            catch { /* not primed yet */ }
          },
        });


        if (visualObj && visualObj.length > 0) {
          if (!synthControl) {
            synthControl = new abcjs.synth.SynthController();
            stopAudio = () => { try { synthControl.pause(); } catch { /* ignore */ } };
            synthControl.load(`#${controls.id}`, cursorControl, {
              displayLoop: true,
              displayRestart: true,
              displayPlay: true,
              displayProgress: true,
              displayWarp: true,
            });
          } else {
            // Switching tunes on an already-used controller: if playback ever
            // started, abcjs can keep the previous tune's primed audio bound
            // and silently ignore setTune() — stop it first so the rebind
            // below actually takes.
            try { synthControl.pause(); } catch { /* ignore */ }
          }
          // userAction: true on every call (not just the first) — abcjs needs
          // this to actually re-prime the AudioContext-backed buffer for the
          // new tune instead of silently keeping the old one queued.
          const audioParams = selectedProgram !== undefined ? { program: selectedProgram } : {};
          primed = synthControl.setTune(visualObj[0]!, true, audioParams).then(() => {
            // After setTune, never before: warping rebuilds the audio buffer,
            // so it needs a tune to rebuild from. Skipped at 100% — it would
            // throw away and re-render the buffer to arrive where it already is.
            if (openingTempoPercent !== DEFAULT_TEMPO_PERCENT) {
              try { synthControl.setWarp(openingTempoPercent); } catch { /* ignore */ }
            }
          }).catch(() => {});
        }
      };

      doRenderTune = renderTune;

      // Changing instrument without losing your place. The audio cannot simply
      // be re-voiced: abcjs pre-renders the whole performance into one buffer
      // from the chosen soundfont, so a new instrument means a new buffer.
      // What CAN be preserved is the position and whether it was playing —
      // which is exactly the dance abcjs itself does in setWarp.
      //
      // `setTune` resets `isStarted` to false and the position to zero, so both
      // have to be read BEFORE the re-render and put back after. Expect a short
      // silence while the buffer is rebuilt; there is no way around that one.
      reapplyAbcPrefs = () => {
        const wasPlaying = !!synthControl?.isStarted;
        const at = synthControl?.percent ?? 0;
        selectedProgram = appState.value.abcInstrument;
        renderTune(currentIndex);
        void primed.then(() => {
          if (!synthControl) return;
          try {
            if (wasPlaying) void synthControl.play().then(() => synthControl.seek(at));
            else synthControl.seek(at);
          } catch { /* nothing primed to resume */ }
        });
      };
      renderTune(currentIndex);
    }).catch(() => {
      const err = document.createElement('p');
      err.className = 'text-sm text-dim italic';
      err.textContent = t('fileViewer.abcError');
      body.appendChild(err);
    });

  } else if (isText(entry)) {
    body.classList.replace('items-center', 'items-start');
    const text = decodeAbc(entry);
    if (isMarkdown(entry)) {
      const rendered = document.createElement('div');
      rendered.className = 'markdown text-sm leading-relaxed w-full';
      getMarked().then(marked => {
        rendered.innerHTML = marked.parse(text) as string;
        rendered.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      }).catch(() => { rendered.textContent = text; });
      body.appendChild(rendered);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'text-xs font-mono text-primary/90 whitespace-pre-wrap break-all w-full';
      pre.textContent = text;
      body.appendChild(pre);
    }
  }

  showModal(
    entry.name, body, [], true, modalWidth(entry), onDismiss,
    // Scores only: none of this applies to an image, a PDF or a recording.
    isAbcFile(entry)
      ? {
          icon: iconElement(GearIcon, 15),
          title: t('fileViewer.abc.prefs.title'),
          onClick: () => showAbcPrefsModal(() => reapplyAbcPrefs?.()),
        }
      : undefined,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderNotes(notes: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'markdown text-sm leading-relaxed';
  // Empty notes render as nothing at all: the card page hides the body when
  // there is none, and study never calls this with an empty string.
  if (!notes.trim()) return wrap;
  getMarked().then(marked => {
    wrap.innerHTML = marked.parse(notes) as string;
    wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }).catch(() => { wrap.textContent = notes; });
  return wrap;
}
