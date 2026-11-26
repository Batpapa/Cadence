import { focusIfDesktop } from '../services/device';
import { renderMarkdown } from './markdown';
import { t } from '../services/i18nService';
import { decodeAbc } from '../services/abcService';
import { askUnsavedChanges } from './modal';
import type { FileEntry } from '../types';
import type { ViewerContext } from './viewerShared';

// ── A text attachment in the file viewer: a note, markdown or plain ──────────

function isMarkdown(entry: FileEntry): boolean {
  return entry.mimeType === 'text/markdown' || entry.name.endsWith('.md');
}

export function mountTextViewer(ctx: ViewerContext): void {
  const { entry, body, save } = ctx;
  body.classList.replace('items-center', 'items-start');
  // Reassigned by a save, which is what the box is compared against to know
  // whether there is anything left to write.
  let text = decodeAbc(entry);
  const markdown = isMarkdown(entry);

  const container = document.createElement('div');
  container.className = 'w-full space-y-3';
  body.appendChild(container);

  const rendered = document.createElement('div');
  rendered.className = 'markdown text-sm leading-relaxed w-full';
  const paint = () => {
    renderMarkdown(text).then(html => {
      rendered.innerHTML = html;
      rendered.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    }).catch(() => { rendered.textContent = text; });
  };

  if (!save) {
    // Read-only — study, a shared session's preview: exactly what this was
    // before editing existed. A page to read, or the text as it is written.
    if (markdown) {
      paint();
      container.appendChild(rendered);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'text-xs font-mono text-primary/90 whitespace-pre-wrap break-all w-full';
      pre.textContent = text;
      container.appendChild(pre);
    }
  } else {
    // ── Editable ──
    // A text attachment can now be WRITTEN here — pasted in empty and filled
    // in, or corrected — which the ABC branch above has always been able to
    // do and these two could not: a typo cost a delete and a re-paste.
    //
    // Markdown alone gets the two faces, for the same reason a score does:
    // the rendered page is what the note is FOR, the source is where it is
    // written. A .txt is its own source, so tabs would offer a choice
    // between a thing and itself.
    const textarea = document.createElement('textarea');
    textarea.className = 'w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent';
    textarea.spellcheck = false;
    textarea.value = text;

    const saveRow = document.createElement('div');
    saveRow.className = 'flex items-center justify-end gap-2';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'text-xs text-dim';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary text-xs';
    saveBtn.textContent = t('common.save');
    saveBtn.disabled = true;
    saveRow.append(saveStatus, saveBtn);

    textarea.addEventListener('input', () => {
      saveBtn.disabled = textarea.value === text;
      saveStatus.textContent = '';
    });

    /** Saves what the box holds; true once it is written. */
    const saveText = async (): Promise<boolean> => {
      const next = textarea.value;
      saveBtn.disabled = true;
      // Awaited, then applied: a save may ask something first and be
      // refused (PreviewSaveResult's `false`).
      const outcome = await save(next);
      if (outcome === 'failed') {
        saveStatus.textContent = t('fileViewer.saveFailed');
        saveBtn.disabled = false;
        return false;
      }
      if (outcome === 'refused') {
        saveBtn.disabled = textarea.value === text;
        return false;
      }
      text = next;
      saveStatus.textContent = t('fileViewer.text.saved');
      // The rendered face is showing what was saved a moment ago, so it is
      // repainted even while hidden: unlike a score's SVG, markdown costs
      // nothing to redraw and has no layout to reflow visibly.
      if (markdown) paint();
      return true;
    };
    saveBtn.onclick = () => { void saveText(); };
    ctx.hooks.guardClose = (dismiss) => {
      if (textarea.value === text) return false;
      askUnsavedChanges({ message: t('unsaved.message.text'), save: saveText, discard: () => { textarea.value = text; }, proceed: dismiss });
      return true;
    };

    if (!markdown) {
      container.append(textarea, saveRow);
    } else {
      const tabBar = document.createElement('div');
      // The segmented control, at the ABC faces' height: the same rail,
      // and it was 24 px against their 36.
      tabBar.className = 'seg seg-lg w-fit';
      const mkTab = (label: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = 'seg-btn';
        return b;
      };
      const renderedTab = mkTab(t('fileViewer.text.renderedTab'));
      const sourceTab = mkTab(t('fileViewer.text.sourceTab'));
      tabBar.append(renderedTab, sourceTab);

      const setTextMode = (mode: 'rendered' | 'source') => {
        renderedTab.className = `seg-btn${mode === 'rendered' ? ' seg-btn-on' : ''}`;
        sourceTab.className = `seg-btn${mode === 'source' ? ' seg-btn-on' : ''}`;
        rendered.style.display = mode === 'rendered' ? '' : 'none';
        textarea.style.display = mode === 'source' ? 'block' : 'none';
        saveRow.style.display = mode === 'source' ? 'flex' : 'none';
        if (mode === 'source') focusIfDesktop(textarea);
      };
      renderedTab.onclick = () => setTextMode('rendered');
      sourceTab.onclick = () => setTextMode('source');

      container.append(tabBar, rendered, textarea, saveRow);
      paint();
      // Opens on the page, not on its source: reading is what one opens a
      // note for, and the tab is right there for the other half. An EMPTY
      // note is the exception — a blank page added to be written in, whose
      // rendered face is nothing at all.
      setTextMode(text.trim() === '' ? 'source' : 'rendered');
    }
  }
}
