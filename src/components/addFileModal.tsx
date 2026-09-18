import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { ComponentChild } from 'preact';
import type { Attachment } from '../types';
import { fileToEntry, focusIfDesktop } from '../utils';
import { showModal, closeModal, renderModalBody } from './modal';
import { CustomSelect } from './customSelect';
import { FileIcon, ClipboardIcon } from './icons';
import { t } from '../services/i18nService';
import {
  TEXT_FORMAT_IDS, TEXT_FORMATS, detectTextFormat, suggestedTextName, textAttachment,
  type TextFormatId,
} from '../services/textAttachment';

// ── Where a file comes from ──────────────────────────────────────────────────
// Two sources behind the attachment list's "File" entry: the device's own
// picker, and a text pasted straight in. The second exists because the formats
// this app reads best — an ABC above all, but also a plain note or a markdown
// one — usually arrive as text in a clipboard, out of a forum post or another
// app, and writing them to a file first only to pick that file back up is a
// detour nobody asked for.
//
// A choice screen rather than two entries in the "+" menu: the menu answers
// "what kind of thing am I attaching" (a file, a link, a card), and where a
// file comes from is a different question, asked only once the first is
// settled.

/** The device's own picker, several files at a time — each stored exactly as
 *  it arrives, with fileToEntry deciding its type (see audioSniff). */
function pickFiles(onAdd: (a: Attachment) => void): void {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = async () => {
    for (const file of Array.from(inp.files ?? [])) {
      const entry = await fileToEntry(file);
      onAdd({ type: 'file', ...entry });
    }
  };
  inp.click();
}

/** One source, named and nothing more: "from the device" and "from the
 *  clipboard" each say the whole of what they do. */
function SourceRow({ icon, label, onClick }: {
  icon: ComponentChild;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="flex items-center gap-3.5 w-full px-4 py-3 rounded-xl border border-border bg-bg text-left cursor-pointer transition-colors hoverable:border-accent"
      onClick={onClick}
    >
      <span class="shrink-0 flex items-center text-accent">{icon}</span>
      <span class="flex-1 min-w-0 text-sm font-medium text-primary">{label}</span>
      <span class="text-dim text-base leading-none shrink-0">›</span>
    </button>
  );
}

/** The "File" entry of the attachment list's "+" menu. */
export function showAddFileModal(onAdd: (a: Attachment) => void): void {
  // Each row closes this dialog BEFORE opening what it leads to: the paste
  // dialog is a modal of its own, and leaving this one underneath would stack
  // two dialogs where the user made one choice. Assigned after the body is
  // rendered, which is where the unmount it has to run comes from.
  let leave = () => {};
  const { el, cleanup } = renderModalBody(
    <div class="space-y-2">
      <SourceRow
        icon={<FileIcon size={18} />}
        label={t('fileViewer.source.device')}
        onClick={() => { leave(); pickFiles(onAdd); }}
      />
      <SourceRow
        icon={<ClipboardIcon size={18} />}
        label={t('fileViewer.source.clipboard')}
        onClick={() => { leave(); showPasteTextModal(onAdd); }}
      />
    </div>,
  );
  leave = () => { closeModal(); cleanup(); };
  showModal(t('fileViewer.source.title'), el, [], { maxWidth: '24rem', onDismiss: cleanup });
}

// ── The paste dialog ─────────────────────────────────────────────────────────
// A box to paste into, a name, and a format. The clipboard is NOT read for the
// user: navigator.clipboard.readText() raises a permission prompt on Chromium
// and does not exist for a page at all on Firefox, so a "Paste" button would
// do nothing for a good half of the people who pressed it. A focused box
// answers Ctrl+V on a desktop and a long press on a phone, everywhere.

/** What the footer's Add reads — the body renders from its own state and
 *  writes here, being mounted outside the shell that owns the button. */
interface Draft { text: string; base: string; format: TextFormatId }

function PasteTextBody({ draft, disabled }: { draft: Draft; disabled: Signal<boolean> }) {
  const [text, setText] = useState('');
  const [base, setBase] = useState('');
  const [format, setFormat] = useState<TextFormatId>(draft.format);
  // Both follow the pasted text until the user touches them; from then on what
  // they chose stands, however the text changes underneath it.
  const nameTouched = useRef(false);
  const formatTouched = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+V lands in the box without aiming at it first. Through
  // focusIfDesktop for both of its properties: no keyboard thrown up on a
  // phone, where pasting is a long press on the box anyway, and a deferred
  // focus — this tree is rendered detached and only mounted by the modal shell
  // afterwards, so focusing it now would reach an element in no document.
  useLayoutEffect(() => { if (areaRef.current) focusIfDesktop(areaRef.current); }, []);

  const setName = (value: string) => {
    setBase(value);
    draft.base = value;
    // A file with no name is not a file: the rows show the name, renaming
    // starts from it, and a download would be called ".abc".
    disabled.value = value.trim() === '';
  };

  const setFmt = (next: TextFormatId) => {
    setFormat(next);
    draft.format = next;
    if (!nameTouched.current) setName(suggestedTextName(draft.text, next));
  };

  const onText = (value: string) => {
    setText(value);
    draft.text = value;
    const fmt = formatTouched.current ? format : detectTextFormat(value);
    if (fmt !== format) { setFormat(fmt); draft.format = fmt; }
    if (!nameTouched.current) setName(suggestedTextName(value, fmt));
  };

  return (
    <div class="space-y-3">
      <textarea
        ref={areaRef}
        class="w-full h-64 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent"
        spellcheck={false}
        placeholder={t('fileViewer.paste.placeholder')}
        value={text}
        onInput={(e) => onText((e.target as HTMLTextAreaElement).value)}
      />

      <div class="flex items-center gap-3">
        <label class="label shrink-0">{t('fileViewer.paste.name')}</label>
        <span class="flex items-center gap-1 flex-1 min-w-0">
          <input
            type="text"
            class="input text-sm py-1.5 min-w-0 flex-1"
            value={base}
            onInput={(e) => { nameTouched.current = true; setName((e.target as HTMLInputElement).value); }}
          />
          {/* Fixed, never typed — the picker below owns it, exactly as the
              attachment row's rename field keeps the extension out of reach. */}
          <span class="text-xs font-mono text-dim shrink-0">{TEXT_FORMATS[format].ext}</span>
        </span>
      </div>

      <div class="flex items-center gap-3">
        <label class="label shrink-0">{t('fileViewer.paste.format')}</label>
        {/* Wrapped so the trigger takes the width the name field above takes,
            the select's own root being a plain block that would otherwise
            shrink to its longest label. */}
        <div class="flex-1 min-w-0">
          <CustomSelect
            value={format}
            options={TEXT_FORMAT_IDS.map(id => ({ value: id, label: t(TEXT_FORMATS[id].labelKey) }))}
            onChange={(v) => { formatTouched.current = true; setFmt(v as TextFormatId); }}
            triggerClass="flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent"
          />
        </div>
      </div>
    </div>
  );
}

function showPasteTextModal(onAdd: (a: Attachment) => void): void {
  const draft: Draft = { text: '', base: '', format: 'txt' };
  // Starts refused: the name is empty, and nothing has been pasted yet.
  const disabled = signal(true);

  const { el, cleanup } = renderModalBody(<PasteTextBody draft={draft} disabled={disabled} />);
  const leave = () => { closeModal(); cleanup(); };

  // Deliberately no floor on the TEXT: an empty file with a name is a usable
  // thing now that a .txt and a .md can be written in the viewer — a blank
  // page to fill in, which is the one case where "add" with nothing pasted is
  // exactly what was meant.
  showModal(t('fileViewer.paste.title'), el, [
    { label: t('common.cancel'), onClick: leave },
    {
      label: t('common.add'),
      primary: true,
      disabled,
      onClick: () => { leave(); onAdd(textAttachment(draft.base, draft.text, draft.format)); },
    },
  ], {
    maxWidth: '34rem',
    onDismiss: cleanup,
    // Back to the two sources: this dialog is the second half of one choice,
    // and picking the wrong half should cost an arrow rather than a reopening.
    onBack: () => { leave(); showAddFileModal(onAdd); },
  });
}
