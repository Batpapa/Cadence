import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, renderModalBody, askUnsavedChanges } from '../../components/modal';
import { renderNotes } from '../../components/fileViewer';
import { PencilIcon } from '../../components/icons';
import { focusIfDesktop } from '../../utils';

// ── An analysis's notes (2026-10-15) ──────────────────────────────────────────
// Free text on a whole analysis — who played, where, what happened. Behind a
// button beside the share one rather than on the page (the user's choice): the
// summary is a working screen, and a note that is read now and then has no
// business pushing the timeline down.
//
// Two states rather than the file viewer's Rendered/Source tabs (the user's
// call, 2026-10-15): the page is what a note is FOR, so that is all there is
// until "Edit" — and saving goes straight back to it. Opens on the page,
// except an empty note, whose page is nothing: that one opens to be written.

/** What the body and the shell's dismissal guard both read. The guard is
 *  declared to showModal before the body exists and outside its tree, so the
 *  two meet here rather than in Preact state. */
interface NotesBox {
  /** Last saved text — what "unsaved" is measured against. */
  saved: string;
  draft: string;
  save: () => boolean;
}

function NotesBody({ box, onSave }: { box: NotesBox; onSave: (notes: string) => void }) {
  const [draft, setDraft] = useState(box.draft);
  const [saved, setSaved] = useState(box.saved);
  const [editing, setEditing] = useState(!box.saved.trim());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renderedRef = useRef<HTMLDivElement>(null);

  // Repainted from what was SAVED: the page shows the note as it stands.
  // `editing` too, because leaving the editor mounts a fresh, empty div.
  useLayoutEffect(() => {
    renderedRef.current?.replaceChildren(renderNotes(saved));
  }, [saved, editing]);
  useLayoutEffect(() => {
    if (editing && textareaRef.current) focusIfDesktop(textareaRef.current);
  }, [editing]);

  const setBoth = (v: string) => { box.draft = v; setDraft(v); };

  box.save = () => {
    const next = box.draft;
    onSave(next);
    box.saved = next;
    setSaved(next);
    setEditing(false);
    return true;
  };

  if (!editing) {
    return (
      <div class="w-full space-y-4">
        {saved.trim()
          ? <div ref={renderedRef} />
          : <p class="text-sm text-dim italic">{t('sessions.notes.empty')}</p>}
        <div class="flex justify-end">
          <button class="btn-ghost text-xs inline-flex items-center gap-1.5" onClick={() => setEditing(true)}>
            <PencilIcon size={12} />{t('common.edit')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="w-full space-y-3">
      <textarea
        ref={textareaRef}
        class="w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent"
        value={draft}
        placeholder={t('sessions.notes.placeholder')}
        onInput={(e) => setBoth((e.target as HTMLTextAreaElement).value)}
      />
      <div class="flex items-center justify-end gap-2">
        {/* Back to the page as it was. Only offered when there IS a page:
            an empty note has nothing to go back to — the ✕ closes it. */}
        {saved.trim() && (
          <button class="btn-ghost text-xs" onClick={() => { setBoth(saved); setEditing(false); }}>
            {t('common.cancel')}
          </button>
        )}
        <button class="btn-primary text-xs" disabled={draft === saved} onClick={() => box.save()}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

/** Opens the notes of an analysis. `onSave` receives the whole text — empty
 *  when the note was cleared — and is the caller's to persist. */
export function showAnalysisNotesModal(notes: string, onSave: (notes: string) => void): void {
  const box: NotesBox = { saved: notes, draft: notes, save: () => false };
  const { el, cleanup } = renderModalBody(<NotesBody box={box} onSave={onSave} />);
  showModal(t('sessions.notes.title'), el, [], {
    maxWidth: '36rem',
    onDismiss: cleanup,
    guardDismiss: (dismiss) => {
      if (box.draft === box.saved) return false;
      askUnsavedChanges({
        message: t('unsaved.message.notes'),
        save: async () => box.save(),
        discard: () => {},
        proceed: dismiss,
      });
      return true;
    },
  });
}
