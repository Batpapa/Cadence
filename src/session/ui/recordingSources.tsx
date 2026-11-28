import { useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { MicIcon, FileAudioIcon, DeviceAudioIcon, ChevronDownIcon, ExternalLinkIcon } from '../../components/icons';
import { CustomSelect } from '../../components/customSelect';
import { canCaptureDeviceAudio, type LiveSourceKind } from '../audio/sources';
import { isNative } from '../../native/platform';
import { pickFiles, type PickerId } from '../../services/filePicker';

// ── Where a recording comes from ─────────────────────────────────────────────
// The analyser's two ways in, out of SessionLibrary.tsx (2026-11-27) so that
// the Transcription module offers the very same ones: record (the microphone,
// or the sound the device plays) and import (a file, or a link). Two split
// buttons: pressing one acts on the source its own icon shows, its chevron
// changes that source.

export function RecordingSources({ onStartLive, onImportFile, onImportLink, pickerId }: {
  onStartLive: (source: LiveSourceKind) => void;
  onImportFile: (file: File) => void;
  /** "Import a link": the dialog that downloads a recording (LinkImportModal). */
  onImportLink: () => void;
  /** The file picker's memory of the folder used last (filePicker.ts). */
  pickerId: PickerId;
}) {
  const [source, setSource] = useState<LiveSourceKind>('mic');
  // Where an import comes from, chosen the same way and kept the same way:
  // for now, not as a preference (see the live source's split button below).
  const [importFrom, setImportFrom] = useState<'file' | 'link'>('file');

  // Hidden entirely where getDisplayMedia does not exist (iOS, Android's
  // browsers; the Android app has its own capture, see canCaptureDeviceAudio) —
  // the button then looks exactly as it always did. Firefox and Safari desktop
  // DO have the API and silently return no audio track, which no feature test
  // can predict; that case is caught after the picker, as NoCapturedAudioError.
  const canPickSource = canCaptureDeviceAudio();
  const sourceOptions = [
    { value: 'mic', label: t('sessions.source.mic') },
    { value: 'device', label: t('sessions.source.device') },
  ];
  const importOptions = [
    { value: 'file', label: t('sessions.importFrom.file') },
    { value: 'link', label: t('sessions.importFrom.link') },
  ];

  return (
    <>
      {/* Split button: pressing it starts a session on the source shown by its
         own icon, and the chevron half changes that source. CustomSelect is
         driving it — its trigger is the WHOLE control, so its portaled panel
         lands under the full width rather than under the chevron, and it
         brings the outside-click, scroll-close and zoom handling with it.
         The choice lives in this component's state and nowhere else: which
         source to record from is a decision about right now, not a
         preference, exactly like the pinned decks. */}
      <CustomSelect
        value={source}
        options={sourceOptions}
        onChange={(v) => setSource(v as LiveSourceKind)}
        renderTrigger={(_label, open, toggle) => (
          <>
            <button
              class="btn-primary w-full justify-center flex items-center gap-2"
              // "Appareil" is short enough to fit the selector but vague on its
              // own — the tooltip says which sounds it actually covers.
              title={source === 'device' ? t(isNative() ? 'sessions.source.device.hintApp' : 'sessions.source.device.hint') : undefined}
              onClick={() => onStartLive(source)}
            >
              {source === 'device' ? <DeviceAudioIcon size={14} /> : <MicIcon size={14} />}
              <span>{t('sessions.start')}</span>
            </button>
            {/* Laid OVER the button's right edge rather than beside it: as a
               flex sibling it took width off the main half, and the label was
               then centred in what was left instead of in the button. Absolute
               keeps the button one full-width box whose label sits dead centre,
               chevron or no chevron. It is a sibling, never a child — a button
               inside a button is invalid HTML — and it covers the button's own
               right padding, so it steals no room from the label.
               Positioned against CustomSelect's own `relative` root. */}
            {canPickSource && (
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 flex items-center rounded-r
                       border-l border-white/25 text-white hover:bg-black/10 transition-colors cursor-pointer"
                title={t('sessions.source')}
                aria-label={t('sessions.source')}
                aria-expanded={open}
                onClick={toggle}
              >
                <ChevronDownIcon size={12} />
              </button>
            )}
          </>
        )}
      />

      {/* The live button's split shape, on the import (2026-10-15, the user:
         "exactly like mic vs capture"): the main half imports from the source
         its icon shows, the chevron changes it. Offered everywhere, unlike the
         live source — a download works on every device. */}
      <div class="mt-2">
        <CustomSelect
          value={importFrom}
          options={importOptions}
          onChange={(v) => setImportFrom(v as 'file' | 'link')}
          renderTrigger={(_label, open, toggle) => (
            <>
              <button
                class="btn-outline w-full justify-center flex items-center gap-2"
                title={t(importFrom === 'link' ? 'sessions.importLinkHint' : 'sessions.importHint')}
                onClick={() => {
                  if (importFrom === 'link') onImportLink();
                  // Back in the folder used last, where the browser can
                  // (filePicker.ts). No type filter: on iOS Safari one hides
                  // some m4a depending on where they came from. A fresh picker
                  // each time, so the same file can be picked again after an
                  // import that did not go well.
                  else void pickFiles({ id: pickerId, startIn: 'music' })
                    .then(([file]) => { if (file) onImportFile(file); });
                }}
              >
                {importFrom === 'link' ? <ExternalLinkIcon size={14} /> : <FileAudioIcon size={14} />}
                <span>{t(importFrom === 'link' ? 'sessions.importLink' : 'sessions.import')}</span>
              </button>
              {/* Over the right edge, for the reason the live button's says. */}
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 flex items-center rounded-r
                       border-l border-border text-dim hover:text-primary hover:bg-elevated transition-colors cursor-pointer"
                title={t('sessions.importFrom')}
                aria-label={t('sessions.importFrom')}
                aria-expanded={open}
                onClick={toggle}
              >
                <ChevronDownIcon size={12} />
              </button>
            </>
          )}
        />
      </div>
    </>
  );
}
