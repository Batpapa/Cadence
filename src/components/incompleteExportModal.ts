import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';
import type { ExportGate, MissingReason, UnresolvedAttachment } from '../services/attachmentStore';

// ── "This export cannot be complete" ────────────────────────────────────────
// The one answer every export gives to a missing attachment. It exists as a
// dialog rather than as a line in a log because of what a backup is FOR: the
// .cdbf was written after someone lost every recording on their phone, and a
// backup that quietly leaves files out is the same loss with a receipt.
//
// Cancel is the plain button and going ahead is the red one, which is the
// opposite of most confirmations here — deliberately. The safe move is to
// wait until the missing files can be fetched; exporting anyway is the one
// that produces something incomplete.

/** Per-reason, as three literal keys rather than one built from the value.
 *  The dynamic-key ceiling in i18nKeys.test.ts exists to make that a decision,
 *  and here there is nothing to gain from it — a switch also makes the
 *  compiler refuse a fourth reason that nobody worded. */
function reasonLabel(reason: MissingReason): string {
  switch (reason) {
    case 'not-uploaded': return t('export.missing.reason.notUploaded');
    case 'offline':      return t('export.missing.reason.offline');
    case 'gone':         return t('export.missing.reason.gone');
  }
}

/** Past this, the list stops being something anyone reads and starts being a
 *  wall. The count in the opening line is the figure that matters anyway. */
const MAX_LISTED = 10;

export const askIncompleteExport: ExportGate = (missing: UnresolvedAttachment[]) => new Promise(resolve => {
  const body = document.createElement('div');
  body.className = 'space-y-3';

  const intro = document.createElement('p');
  intro.className = 'text-sm text-muted leading-relaxed';
  intro.textContent = missing.length === 1
    ? t('export.missing.intro')
    : t('export.missing.introPlural', { count: missing.length });

  const list = document.createElement('ul');
  list.className = 'space-y-1 max-h-48 overflow-y-auto';
  for (const m of missing.slice(0, MAX_LISTED)) {
    const li = document.createElement('li');
    li.className = 'text-xs rounded-lg border border-border bg-bg px-2.5 py-1.5';
    const name = document.createElement('div');
    name.className = 'text-primary truncate';
    // The card, because a file name on its own rarely says which tune it
    // belongs to — and finding it is the whole point of showing this.
    name.textContent = m.card ? `${m.name} — ${m.card}` : m.name;
    const why = document.createElement('div');
    why.className = 'text-dim';
    why.textContent = reasonLabel(m.reason);
    li.append(name, why);
    list.appendChild(li);
  }
  if (missing.length > MAX_LISTED) {
    const more = document.createElement('li');
    more.className = 'text-xs text-dim pl-1';
    more.textContent = t('export.missing.more', { count: missing.length - MAX_LISTED });
    list.appendChild(more);
  }

  const warning = document.createElement('p');
  warning.className = 'text-sm text-muted leading-relaxed';
  warning.textContent = t('export.missing.warning');

  body.append(intro, list, warning);

  // Every way out resolves. A promise left hanging by an Escape would leave
  // the export half-run and its busy state stuck on.
  let answered = false;
  const answer = (go: boolean) => { if (!answered) { answered = true; resolve(go); } };

  showModal(t('export.missing.title'), body, [
    { label: t('common.cancel'), onClick: () => { closeModal(); answer(false); } },
    { label: t('export.missing.confirm'), danger: true, onClick: () => { closeModal(); answer(true); } },
  ], { onDismiss: () => answer(false) });
});
