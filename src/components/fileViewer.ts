import type { FileEntry } from '../types';
import { fileToEntry, entryToObjectUrl } from '../utils';

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

function isPreviewable(entry: FileEntry): boolean {
  const m = entry.mimeType;
  return m.startsWith('audio/') || m.startsWith('image/') || m.startsWith('video/') ||
    m === 'application/pdf' || isText(entry) || isAbc(entry);
}

function mimeIcon(entry: FileEntry): string {
  const m = entry.mimeType;
  if (isAbc(entry))            return '𝄞';
  if (m.startsWith('audio/'))  return '♫';
  if (m.startsWith('video/'))  return '▶';
  if (m.startsWith('image/'))  return '▣';
  if (m === 'application/pdf') return '≣';
  if (isText(entry))           return '¶';
  return '◈';
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

function showPreviewModal(entry: FileEntry): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4';
  dialog.style.maxWidth = '90vw';
  dialog.style.maxHeight = '90vh';
  dialog.style.width = modalWidth(entry);

  // Header
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-xs font-mono text-muted truncate'; titleEl.textContent = entry.name;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0 ml-4';
  let stopAudio: () => void = () => {};
  const closeModal = () => { stopAudio(); overlay.remove(); document.removeEventListener('keydown', onKey); };
  // onKey declared below — hoisted via var-like closure; assigned after dialog.append
  let onKey: (e: KeyboardEvent) => void;

  closeBtn.textContent = '✕'; closeBtn.onclick = closeModal;
  header.append(titleEl, closeBtn);

  // Body
  const body = document.createElement('div');
  body.className = 'flex-1 overflow-auto p-4 flex items-center justify-center';

  const m = entry.mimeType;

  if (m.startsWith('audio/')) {
    const audio = document.createElement('audio'); audio.controls = true; audio.className = 'w-full';
    audio.src = entryToObjectUrl(entry);
    body.appendChild(audio);

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

    // Playback controls area
    const controls = document.createElement('div');
    controls.id = `abc-controls-${Date.now()}`;
    container.appendChild(controls);

    // Notation area
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
      err.textContent = 'Could not render ABC notation.';
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

// ── File entry row ────────────────────────────────────────────────────────────

function renderFileEntry(entry: FileEntry, onRemove: () => void, editable: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-2 px-3 py-1.5 rounded border border-border group';

  const icon = document.createElement('span');
  icon.className = 'text-[11px] text-dim shrink-0 w-4 text-center font-mono';
  icon.textContent = mimeIcon(entry);

  const name = document.createElement('span');
  name.className = 'text-xs font-mono truncate flex-1';
  if (isPreviewable(entry)) {
    name.className += ' text-muted hover:text-primary cursor-pointer transition-colors';
    name.onclick = () => showPreviewModal(entry);
  } else {
    name.className += ' text-dim';
  }
  name.textContent = entry.name;

  const dl = document.createElement('a');
  dl.href = entryToObjectUrl(entry); dl.download = entry.name;
  dl.className = 'text-xs text-dim hover:text-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100';
  dl.textContent = '↓'; dl.title = 'Download';

  wrap.append(icon, name, dl);

  if (editable) {
    const rm = document.createElement('button');
    rm.className = 'text-dim hover:text-danger text-xs transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100';
    rm.textContent = '✕'; rm.title = 'Remove'; rm.onclick = onRemove;
    wrap.appendChild(rm);
  }

  return wrap;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderFiles(options: {
  files: FileEntry[]; editable: boolean;
  onAdd?: (e: FileEntry) => void;
  onRemove?: (i: number) => void;
}): HTMLElement {
  const { files, editable } = options;
  const onAdd = options.onAdd ?? (() => {});
  const onRemove = options.onRemove ?? (() => {});

  const wrap = document.createElement('div'); wrap.className = 'space-y-2';

  const header = document.createElement('div'); header.className = 'flex items-center justify-between';
  const titleEl = document.createElement('span'); titleEl.className = 'section-title';
  titleEl.textContent = files.length > 0 ? `Attachments (${files.length})` : 'Attachments';
  header.appendChild(titleEl);

  if (editable) {
    const addBtn = document.createElement('label');
    addBtn.className = 'btn-ghost text-xs cursor-pointer'; addBtn.textContent = '+ Add';
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.className = 'hidden'; fileInput.multiple = true;
    fileInput.onchange = async () => {
      if (!fileInput.files) return;
      for (const file of Array.from(fileInput.files)) { onAdd(await fileToEntry(file)); }
      fileInput.value = '';
    };
    addBtn.appendChild(fileInput);
    header.appendChild(addBtn);
  }
  wrap.appendChild(header);

  if (files.length > 0) {
    const list = document.createElement('div'); list.className = 'space-y-1';
    files.forEach((entry, i) => list.appendChild(renderFileEntry(entry, () => onRemove(i), editable)));
    wrap.appendChild(list);
  }

  return wrap;
}

export function renderNotes(notes: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'markdown text-sm leading-relaxed';
  if (!notes.trim()) { wrap.innerHTML = '<p class="text-dim italic">No notes.</p>'; return wrap; }
  import('marked').then(({ marked }) => {
    wrap.innerHTML = marked.parse(notes) as string;
    wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }).catch(() => { wrap.textContent = notes; });
  return wrap;
}
