import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t } from '../../services/i18nService';
import { showModal, closeModal } from '../../components/modal';
import { BoundEditor, type BoundEdit, type TwinEdit } from './BoundEditor';
import { TuneLookupField } from './ManualTunePick';
import { fmtTime } from './sessionUiShared';
import { manualDetection } from '../model';
import type { Detection, DetectionAlternate } from '../model';

// ── Adding a detection the recogniser missed ─────────────────────────────────
// A tune can be played and never recognised — noise, an unusual setting, a
// tune outside the index. What is left is a hole in the analysis, and with it
// a review that never got logged and a clip that cannot be cut. This is the
// way to fill one (2026-09-21, user request).
//
// THE DOOR IS THE HOLE ITSELF. The summary's list already draws a row for
// every silence of 15 s or more — timelineModel's withGaps — and that row
// already says, in so many words, "3:24 with no detection". It is the one
// place on the screen that names the thing being fixed and sits exactly where
// the fix goes, so it is the row that opens this, rather than a button
// elsewhere that would have to explain what it acts on.
//
// AND THE ROOM IS THE BOUND EDITOR. Not a form: the bounds are already its
// whole subject, and the recording is the only way to know what was played in
// that hole in the first place. One screen where both halves are in reach, so
// the order is the user's — listen then name, or name then listen. Its only
// difference is up top, where the settled name/dance/meter line becomes the
// search field until a tune is chosen (BoundEditor's identitySlot).
//
// The hole seeds the bounds, so the common case needs no adjustment at all:
// open, listen, name, add. Adjusting is for when the neighbours' bounds bite
// into the tune — and the editor already draws those neighbours and offers
// their bounds as snap marks, so tightening against them is a gesture each.
//
// Nothing is written until "Add", like the bound editor it is built on.

/** A detection that does not exist yet — what the editor frames while the tune
 *  is still being chosen.
 *
 *  It carries an id that matches nothing in the analysis (so every real
 *  detection is drawn as a neighbour and offered as a snap mark) and no
 *  evidence (so the strip shows no observation window of its own, which is the
 *  literal truth: nothing observed this). Its identity fields are never read —
 *  the identity slot replaces the only line that would show them — and it is
 *  built once, so moving a bound or picking a tune never resets the frame the
 *  editor opened on. */
function draftDetection(start: number, end: number): Detection {
  const nothing = { tuneId: '', settingId: '', displayName: '', dance: '', meter: '', meanScore: 0 };
  return {
    id: 'draft', ...nothing, start, end,
    confidence: 1, bucket: 'high', evidence: [], alternates: [],
    viterbiPick: nothing, manual: true, userConfirmed: true, liked: false, finalized: true,
  };
}

function AddDetectionBody({ seed, anns, duration, getAudio, onDraft, onTune }: {
  seed: { start: number; end: number };
  anns: Detection[];
  duration: number;
  getAudio: () => Promise<Blob | undefined>;
  onDraft: (edit: BoundEdit) => void;
  onTune: (tune: DetectionAlternate | null) => void;
}) {
  const [tune, setTune] = useState<DetectionAlternate | null>(null);
  const placeholder = useRef(draftDetection(seed.start, seed.end)).current;

  const pick = (next: DetectionAlternate | null) => { setTune(next); onTune(next); };

  return (
    <BoundEditor
      ann={placeholder}
      anns={anns}
      duration={duration}
      getAudio={getAudio}
      onDraft={onDraft}
      linkByDefault={false}
      identitySlot={(draft) => (
        <div class="space-y-1.5">
          {/* Not focused on opening: the first thing to do here is listen. */}
          <TuneLookupField onResolved={pick} autoFocus={false} />
          <p class="text-xs text-muted">
            {tune ? `${tune.dance} · ${tune.meter} · ` : ''}
            {t('sessions.bounds.length', { d: fmtTime(draft.end - draft.start) })}
          </p>
        </div>
      )}
    />
  );
}

/** Imperative bridge, the same shape as showBoundEditor's — see its doc for
 *  why the Preact tree inside a modal body has to be unmounted by hand.
 *
 *  `onAdd` receives a finished detection and only when the user says so; every
 *  other way out of the dialog leaves the analysis untouched. */
export function showAddDetection(opts: {
  /** The hole the detection is framed on to begin with. */
  seed: { start: number; end: number };
  /** Every detection of the analysis — drawn as neighbours, offered as snap
   *  marks. The one being added is deliberately not among them; it does not
   *  exist yet. */
  anns: Detection[];
  duration: number;
  getAudio: () => Promise<Blob | undefined>;
  onAdd: (detection: Detection, twins: TwinEdit[]) => void;
}): void {
  const body = document.createElement('div');
  const cleanup = () => render(null, body);
  let draft: BoundEdit = { ...opts.seed, twins: [] };
  let tune: DetectionAlternate | null = null;
  // A signal because the footer buttons are declared outside the body's own
  // Preact tree and have no other way to hear that a tune has been resolved
  // (see ModalAction.disabled). Naming the tune is the one thing this dialog
  // cannot do without: the bounds always have an answer, the identity does not.
  const nothingToAdd = signal(true);

  render(
    <AddDetectionBody
      seed={opts.seed}
      anns={opts.anns}
      duration={opts.duration}
      getAudio={opts.getAudio}
      onDraft={(edit) => { draft = edit; }}
      onTune={(next) => { tune = next; nothingToAdd.value = next === null; }}
    />,
    body,
  );

  showModal(t('sessions.addDetection.title'), body, [
    { label: t('common.cancel'), onClick: () => { closeModal(); cleanup(); } },
    {
      label: t('common.add'),
      primary: true,
      disabled: nothingToAdd,
      onClick: () => {
        if (!tune) return;
        closeModal();
        cleanup();
        opts.onAdd(manualDetection(tune, draft.start, draft.end), draft.twins);
      },
    },
  ], { maxWidth: '34rem', onDismiss: cleanup });
}
