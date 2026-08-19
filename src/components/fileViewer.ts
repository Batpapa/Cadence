import LZString from 'lz-string';
import type { FileEntry } from '../types';
import { entryToObjectUrl, arrayBufferToBase64, focusIfDesktop } from '../utils';
import { getMarked } from './markdown';
import { mkCustomSelect } from './customSelectVanilla';
import { starIconElement, iconElement, ExternalLinkIcon } from './icons';
import { t } from '../services/i18nService';
import { modalMaxH, modalMaxW } from '../services/zoomService';

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

// ── MIME helpers ──────────────────────────────────────────────────────────────

function isText(entry: FileEntry): boolean {
  return entry.mimeType.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt');
}

function isMarkdown(entry: FileEntry): boolean {
  return entry.mimeType === 'text/markdown' || entry.name.endsWith('.md');
}

function isAbc(entry: FileEntry): boolean {
  return entry.name.endsWith('.abc') || entry.mimeType === 'text/vnd.abc';
}


const TUNE_TEMPOS: Record<string, string> = {
  jig:          '3/8=120',
  reel:         '1/4=190',
  'slip jig':   '3/8=120',
  hornpipe:     '1/4=190',
  polka:        '1/4=150',
  slide:        '3/8=135',
  waltz:        '1/4=180',
  barndance:    '1/4=190',
  strathspey:   '1/4=190',
  'three-two':  '1/4=105',
  mazurka:      '1/4=180',
  march:        '1/4=190',
};

function injectDefaultTempo(abc: string): string {
  if (/^Q:/m.test(abc)) return abc;
  const rMatch = abc.match(/^R:\s*(.+)/m);
  const tempo = rMatch ? TUNE_TEMPOS[rMatch[1]!.trim().toLowerCase()] : undefined;
  if (!tempo) return abc;
  return abc.replace(/^(K:[^\n]*)/m, `$1\nQ: ${tempo}`);
}

function splitAbcTunes(abc: string): string[] {
  const lines = abc.split('\n');
  const tunes: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^X:\s*\d+/.test(line) && current.length > 0) {
      tunes.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) tunes.push(current.join('\n'));
  return tunes.filter(t => t.trim());
}

function decodeText(entry: FileEntry): string {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new TextDecoder().decode(arr);
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function modalWidth(entry: FileEntry): string {
  const m = entry.mimeType;
  if (m.startsWith('audio/') || (isText(entry) && !isAbc(entry))) return '560px';
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
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4';
  dialog.style.maxWidth = modalMaxW(0.9);
  dialog.style.maxHeight = modalMaxH(0.9);
  dialog.style.width = modalWidth(entry);

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-xs font-mono text-muted truncate'; titleEl.textContent = entry.name;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0 ml-4';
  let stopAudio: () => void = () => {};
  let closed = false;
  const closeModal = () => { closed = true; stopAudio(); overlay.remove(); document.removeEventListener('keydown', onKey); };
  let onKey: (e: KeyboardEvent) => void;

  closeBtn.textContent = '✕'; closeBtn.onclick = closeModal;
  header.append(titleEl, closeBtn);

  const body = document.createElement('div');
  body.className = 'flex-1 min-h-0 overflow-auto p-4 flex items-center justify-center';

  const m = entry.mimeType;
  const mediaMaxH = `calc(${modalMaxH(0.9)} - 80px)`;

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

  } else if (isAbc(entry)) {
    body.classList.replace('items-center', 'items-start');
    let abcText = decodeText(entry);

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
    let selectedProgram: number | undefined = undefined; // undefined = ABC's own %%MIDI program / abcjs default

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

    // ── Instrument picker — sheet mode only, affects the next setTune() call.
    const instrumentRow = document.createElement('div');
    instrumentRow.className = 'flex items-center gap-2';
    const instrumentLabel = document.createElement('span');
    instrumentLabel.className = 'text-xs text-dim shrink-0';
    instrumentLabel.textContent = t('fileViewer.abc.instrument');
    const { el: instrumentSelectEl } = mkCustomSelect(
      ABC_INSTRUMENTS.map(i => ({ value: i.value, label: t(i.labelKey) })),
      '',
      (v) => { selectedProgram = v ? parseInt(v) : undefined; doRenderTune?.(currentIndex); },
      'flex items-center gap-2 text-xs bg-bg border border-border rounded px-2 py-1 text-muted cursor-pointer hover:border-accent',
    );
    instrumentRow.append(instrumentLabel, instrumentSelectEl);
    container.appendChild(instrumentRow);

    const uid = Date.now();
    const controls = document.createElement('div');
    controls.id = `abc-controls-${uid}`;
    container.appendChild(controls);

    const notation = document.createElement('div');
    notation.className = 'w-full bg-white rounded p-2';
    notation.style.pointerEvents = 'none';
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
      instrumentRow.style.display = mode === 'sheet' ? 'flex' : 'none';
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
      const cursorControl = {
        beatSubdivisions: 2,
        onStart: () => {
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
        },
        onFinished: () => {
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          const cursor = notation.querySelector('.abcjs-cursor');
          cursor?.setAttribute('x1', '0'); cursor?.setAttribute('x2', '0');
          cursor?.setAttribute('y1', '0'); cursor?.setAttribute('y2', '0');
        },
      };

      const renderTune = (index: number) => {
        const visualObj = abcjs.renderAbc(notation.id, injectDefaultTempo(tunes[index] ?? ''), {
          responsive: 'resize',
          add_classes: true,
          paddingright: 0,
          paddingleft: 0,
          format: { gchordfont: 'Verdana 12', annotationfont: 'Verdana 12' },
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
          synthControl.setTune(visualObj[0]!, true, audioParams).catch(() => {});
        }
      };

      doRenderTune = renderTune;
      renderTune(currentIndex);
    }).catch(() => {
      const err = document.createElement('p');
      err.className = 'text-sm text-dim italic';
      err.textContent = t('fileViewer.abcError');
      body.appendChild(err);
    });

  } else if (isText(entry)) {
    body.classList.replace('items-center', 'items-start');
    const text = decodeText(entry);
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

  dialog.append(header, body);
  overlay.appendChild(dialog);

  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.onclick = (e) => { if (e.target === overlay && mouseDownOnOverlay) closeModal(); };
  onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderNotes(notes: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'markdown text-sm leading-relaxed';
  if (!notes.trim()) { wrap.innerHTML = `<p class="text-dim italic">${t('fileViewer.noNotes')}</p>`; return wrap; }
  getMarked().then(marked => {
    wrap.innerHTML = marked.parse(notes) as string;
    wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }).catch(() => { wrap.textContent = notes; });
  return wrap;
}
