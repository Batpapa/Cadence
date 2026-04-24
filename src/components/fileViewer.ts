import type { FileEntry } from '../types';
import { entryToObjectUrl } from '../utils';
import { t } from '../services/i18nService';

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

export function showPreviewModal(entry: FileEntry): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4';
  dialog.style.maxWidth = '90vw';
  dialog.style.maxHeight = '90vh';
  dialog.style.width = modalWidth(entry);

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-xs font-mono text-muted truncate'; titleEl.textContent = entry.name;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0 ml-4';
  let stopAudio: () => void = () => {};
  const closeModal = () => { stopAudio(); overlay.remove(); document.removeEventListener('keydown', onKey); };
  let onKey: (e: KeyboardEvent) => void;

  closeBtn.textContent = '✕'; closeBtn.onclick = closeModal;
  header.append(titleEl, closeBtn);

  const body = document.createElement('div');
  body.className = 'flex-1 overflow-auto p-4 flex items-center justify-center';

  const m = entry.mimeType;

  if (m.startsWith('audio/')) {
    body.classList.replace('items-center', 'items-start');
    import('./audioPlayer').then(({ renderAudioPlayer, stopCurrentAudio }) => {
      body.appendChild(renderAudioPlayer(entry));
      stopAudio = stopCurrentAudio;
    });

  } else if (m.startsWith('video/')) {
    const video = document.createElement('video'); video.controls = true; video.className = 'max-w-full max-h-full rounded';
    video.src = entryToObjectUrl(entry);
    body.appendChild(video);

  } else if (m.startsWith('image/')) {
    const img = document.createElement('img'); img.src = entryToObjectUrl(entry); img.alt = entry.name;
    img.className = 'max-w-full max-h-full object-contain rounded';
    body.appendChild(img);

  } else if (m === 'application/pdf') {
    const embed = document.createElement('embed'); embed.src = entryToObjectUrl(entry);
    embed.type = 'application/pdf'; embed.className = 'w-full rounded';
    embed.style.height = '75vh';
    body.appendChild(embed);

  } else if (isAbc(entry)) {
    body.classList.replace('items-center', 'items-start');
    const abcText = decodeText(entry);

    const container = document.createElement('div');
    container.className = 'w-full space-y-3';

    const controls = document.createElement('div');
    controls.id = `abc-controls-${Date.now()}`;
    container.appendChild(controls);

    const notation = document.createElement('div');
    notation.className = 'w-full bg-white rounded p-2';
    notation.style.pointerEvents = 'none';
    notation.style.color = '#000';
    notation.id = `abc-notation-${Date.now()}`;
    container.appendChild(notation);

    body.appendChild(container);

    import('abcjs').then((abcjs) => {
      const visualObj = abcjs.renderAbc(notation.id, abcText, {
        responsive: 'resize',
        add_classes: true,
        paddingright: 0,
        paddingleft: 0,
        format: { gchordfont: 'Verdana 12', annotationfont: 'Verdana 12' },
      });
      if (visualObj && visualObj.length > 0) {
        const synthControl = new abcjs.synth.SynthController();
        stopAudio = () => { try { synthControl.pause(); } catch { /* ignore */ } };
        synthControl.load(`#${controls.id}`, null, {
          displayLoop: true,
          displayRestart: true,
          displayPlay: true,
          displayProgress: true,
          displayWarp: true,
        });
        synthControl.setTune(visualObj[0]!, false, {}).catch(() => {});
      }
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
      import('marked').then(({ marked }) => {
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
  import('marked').then(({ marked }) => {
    wrap.innerHTML = marked.parse(notes) as string;
    wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }).catch(() => { wrap.textContent = notes; });
  return wrap;
}
