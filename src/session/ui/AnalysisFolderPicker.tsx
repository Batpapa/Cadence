import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { CustomSelect } from '../../components/customSelect';
import { ChevronDownIcon } from '../../components/icons';
import { editSessionTree, folderPathOf, parentFolderOf, placeSession, sessionTreeOf } from '../sessionTree';

// ── Where one analysis lives ─────────────────────────────────────────────────
// All that is left on screen of the folders, and deliberately so (2026-09-12):
// the library grew a whole folder TREE — rows, drag and drop, rename, delete —
// and the user turned the presentation down flat ("c'est trop sobre", "on va
// repartir de zéro"). The MODEL was explicitly kept ("le modèle de données
// c'est bon"), so sessionTree.ts and its tests stand untouched and this one
// control still reads and writes them.
//
// ⚠️ Nothing creates a folder any more. This chooser only offers the ones that
// exist, and it renders nothing at all when there are none — so on a fresh
// install it is invisible until the new folder design brings a way to make one
// back. That is the known, accepted state of this feature, not an oversight.

/** The deck view's "Emplacement :" row, for an analysis: the same control, in
 *  the same place under the title, because it answers the same question.
 *
 *  Renders NOTHING while the user has no folders at all — a chooser whose only
 *  entry is "no folder" is a control that cannot do anything, and someone who
 *  does not use folders should not have to notice they exist. */
export function AnalysisFolderPicker({ ctx, sessionId }: { ctx: AppContext; sessionId: string }) {
  const tree = sessionTreeOf(ctx.user);
  const folders = Object.values(tree.folders);
  if (folders.length === 0) return null;

  const parentId = parentFolderOf(tree, { type: 'session', id: sessionId });
  const options = [
    { value: '', label: t('sessions.folder.root') },
    ...folders
      .map(f => ({ value: f.id, label: folderPathOf(tree, f.id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <div class="flex items-center gap-1 mt-1">
      <span class="text-2xs font-medium uppercase tracking-wider text-dim">{t('sessions.folder.label')}</span>
      <CustomSelect
        value={parentId ?? ''}
        options={options}
        onChange={(v) => { void ctx.mutate(s => editSessionTree(s, tr => placeSession(tr, sessionId, v || null))); }}
        renderTrigger={(label, open, toggle) => (
          <button
            type="button"
            class="min-h-8 text-2xs font-medium text-dim cursor-pointer hover:text-accent transition-colors flex items-center gap-0.5 shrink-0 whitespace-nowrap"
            onClick={toggle}
          >
            {label}
            <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
          </button>
        )}
      />
    </div>
  );
}
