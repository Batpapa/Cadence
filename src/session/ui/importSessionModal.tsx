import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { focusIfDesktop, ownFormatAccept } from '../../services/device';
import { showModal, closeModal, renderModalBody, alertModal, MODAL_W } from '../../components/modal';
import { ChoiceCard as UiChoiceCard, InlineStatus } from '../../components/ui';
import { importSharedSession, importSessionFile } from '../../services/sessionShareService';
import { type Analysis } from '../model';
import { keepRecordings } from '../keepRecordings';
import { ArrowRightIcon } from '../../components/icons';

// The "import a shared session" dialog. Out of sessionModule.tsx since 2026-11-26.

// Same icon glyphs as the card import/export flow (theSessionImport.ts's
// mkChoiceCard SVGs / library.tsx's export trigger) — kept as a local copy
// rather than shared, matching how those two already don't share code with
// each other either.
const SHARE_ICON_FILE_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const SHARE_ICON_SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

// ── Share a session (annotations + optionally the audio) via a short key —
// same mechanism as card sharing (shareService.ts). ─────────────────────────

/** One way in, as every dialog of the app offers them (ChoiceCard): the
 *  description on screen, not in a tooltip a finger never sees. The icons are
 *  the HTML strings above, hence the span. */
function ShareChoiceCard({ icon, label, desc, onClick }: {
  icon: string; label: string; desc: string; onClick: () => void;
}) {
  return (
    <UiChoiceCard
      icon={<span class="flex items-center" dangerouslySetInnerHTML={{ __html: icon }} />}
      label={label}
      desc={desc}
      trailing={<ArrowRightIcon size={16} />}
      onClick={onClick}
    />
  );
}

/** Same look as theSessionImport.ts's mkInputRow, without the unused info span. */
function KeyEntryStep({ withAudio, onImported }: { withAudio: boolean; onImported: (session: Analysis) => void }) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  /** The status line is an error, shown as one. */
  const [failed, setFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { focusIfDesktop(inputRef.current!); }, []);

  const doImport = () => {
    setImporting(true);
    setFailed(false);
    setStatus(t('newCard.import.importing'));
    void importSharedSession(key.trim(), withAudio).then(session => {
      closeModal();
      onImported(session);
    }).catch(e => {
      setStatus(t('theSession.error', { message: e instanceof Error ? e.message : String(e) }));
      setFailed(true);
      setImporting(false);
    });
  };

  return (
    <>
      <div class="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          maxLength={6}
          class="input flex-1 min-w-0"
          placeholder={t('newCard.share.placeholder')}
          value={key}
          onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && key.trim().length === 6) doImport(); }}
        />
        <button class="btn-primary text-xs shrink-0" disabled={importing || key.trim().length !== 6} onClick={doImport}>
          {t('newCard.share.importBtn')}
        </button>
      </div>
      {failed
        ? <InlineStatus tone="error" class="min-h-[1.25rem]">{status}</InlineStatus>
        : <p class="text-xs text-muted min-h-[1.25rem]">{status}</p>}
    </>
  );
}

function ImportSessionBody({ ctx }: { ctx: AppContext }) {
  const [step, setStep] = useState<'choice' | 'key'>('choice');
  // Whether the audio a package may carry comes in too (2026-11-04). Not known
  // to be there until the package is read, so asked for both ways in, and
  // ticked as "Keep the recordings" is on this device (keepRecordings.ts).
  const [withAudio, setWithAudio] = useState(() => keepRecordings.peek());
  const audioBox = (
    <label class="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        class="card-checkbox"
        checked={withAudio}
        onChange={(e) => setWithAudio((e.target as HTMLInputElement).checked)}
      />
      <span class="text-xs text-muted">{t('sessions.share.importAudio')}</span>
    </label>
  );

  if (step === 'key') {
    return (
      <div class="space-y-2">
        {audioBox}
        <KeyEntryStep withAudio={withAudio} onImported={(session) => ctx.navigate({ view: 'sessions', sessionId: session.id })} />
      </div>
    );
  }

  // The box above the choices, as in the export window (ShareSessionModal).
  return (
    <div class="space-y-2">
      {audioBox}
      <ShareChoiceCard
        icon={SHARE_ICON_FILE_DOWN}
        label={t('library.export.file')}
        desc={t('sessions.share.fileImportDesc')}
        onClick={() => {
          closeModal();
          const inp = document.createElement('input');
          inp.type = 'file';
          const accept = ownFormatAccept('.cds');
          if (accept) inp.accept = accept;
          inp.onchange = () => {
            const file = inp.files?.[0];
            if (!file) return;
            void importSessionFile(file, withAudio).then(session => {
              ctx.navigate({ view: 'sessions', sessionId: session.id });
            }).catch(e => alertModal(t('sessions.share.importTitle'), e instanceof Error ? e.message : String(e)));
          };
          inp.click();
        }}
      />
      <ShareChoiceCard
        icon={SHARE_ICON_SHARE}
        label={t('newCard.share.label')}
        desc={t('newCard.share.desc')}
        onClick={() => setStep('key')}
      />
    </div>
  );
}

export function showImportSessionModal(ctx: AppContext): void {
  const { el, cleanup } = renderModalBody(<ImportSessionBody ctx={ctx} />);
  showModal(t('sessions.share.importTitle'), el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}
