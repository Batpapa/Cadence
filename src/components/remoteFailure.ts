import type { EmbedEntry } from '../types';
import { safeExternalUrl } from '../services/embedService';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';

/** Why a file link did not open, with the way out that always exists: the
 *  file itself in a tab. A button rather than opening the tab by itself — the
 *  failure comes back after an await, past the click that would have let a
 *  popup through, and a tab appearing on its own seconds later explains
 *  nothing. Rare by construction: the link dialog refuses a file its server
 *  will not let Cadence read, so this is a server that changed its mind, or
 *  is not there right now. Shared by the link's row (attachmentList.tsx) and
 *  a card's audio sync (cardRecordingSync.tsx). */
export function showRemoteFailure(entry: EmbedEntry, message: string): void {
  const href = safeExternalUrl(entry.url);
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = message;
  showModal(t('embed.file.failedTitle'), body, [
    { label: t('common.close'), onClick: closeModal },
    ...(href ? [{
      label: t('embed.open'), primary: true,
      onClick: () => { window.open(href, '_blank', 'noopener,noreferrer'); closeModal(); },
    }] : []),
  ]);
}
