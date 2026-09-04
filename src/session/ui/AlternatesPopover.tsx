import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal } from '../../components/modal';
import { AbcPreview } from './abcPreview';
import { BUCKET_TEXT } from './sessionUiShared';
import { bucketOf } from '../recognition/viterbiSegmenter';
import { DETECTION_TEMPORAL_CONFIG } from '../recognition/detectionTemporalConfig';
import { viterbiPickOf } from '../model';
import type { AnnotationAlternate, SessionAnnotation } from '../model';

// ── "Explore alternatives" picker ─────────────────────────────────────────────
// Single-select over the up to 5 tunes actually seen as window candidates for
// this detection: Viterbi's own current pick (always first, marked specially —
// it's favored even when an alternate's raw mean score is higher, since
// Viterbi also weighs transition costs/hysteresis the mean score alone
// doesn't see) plus up to 4 alternates ranked by mean score
// (SessionAnnotation.alternates, already sorted).
//
// It opens with NOTHING ticked on an unconfirmed detection (2026-09-04, user
// request), and the selection toggles: clicking what is already ticked hands
// the annotation back to the decoder. So the three states the card shows —
// proposal, confirmed-as-proposed, confirmed-as-something-else — are all
// reachable and all reversible from this one list, with no separate control.
//
// Each option carries its own <AbcPreview> (2026-08-25, user request): the
// most reliable way to tell whether an alternative is actually right is to
// listen to its sheet/synth rendering against the extracted audio, not just
// read a name and a score.
//
// Browsable but not choosable until finalized (2026-08-25, user request): a
// live/import annotation can still be revised — or vanish outright — while
// this is open, so the picker polls `getLatest` (when given) and reacts:
// updates the list on a revision, shows a "no longer valid" message on
// retraction, and only enables actually picking once finalized. `getLatest`
// reads straight off the ENGINE (LiveSession/ImportSession.getAnnotations()),
// not the container's own React state — that only updates on its next
// re-render, this popover is a separate render() tree that wouldn't see it.
//
// Polling, not a callback subscription: ImportSession/LiveSession.setCallbacks()
// is a single-registration API (each call REPLACES the previous callbacks) —
// the container screen is already the one and only registrant, so this
// popover has no way to also subscribe to the live event stream without
// clobbering it. A cheap poll (0.5s, a plain array .find()) sidesteps that
// constraint entirely instead of fighting it.

const POLL_MS = 500;

function optionsFor(ann: SessionAnnotation, viterbiPick: AnnotationAlternate): AnnotationAlternate[] {
  const options = [viterbiPick, ...(ann.alternates ?? [])];
  // Defensive: the currently-displayed pick could in principle have fallen out
  // of the top-N alternates since it was chosen (the window range's candidate
  // set can shift slightly before a segment finalizes) — never let the picker
  // silently drop what's actually selected right now.
  if (!options.some(o => o.tuneId === ann.tuneId)) {
    options.push({
      tuneId: ann.tuneId, settingId: ann.settingId, displayName: ann.displayName,
      dance: ann.dance, meter: ann.meter, meanScore: ann.meanScore,
    });
  }
  return options;
}

function AlternatesPopover({ initial, getLatest, onSelect }: {
  initial: SessionAnnotation;
  getLatest?: () => SessionAnnotation | undefined;
  onSelect: (pick: AnnotationAlternate | null) => void;
}) {
  // undefined = retracted (only reachable once getLatest is polled and comes
  // back empty — `initial` is always a real annotation the card just showed).
  const [ann, setAnn] = useState<SessionAnnotation | undefined>(initial);

  useEffect(() => {
    if (!getLatest) return; // finished-session summary: nothing to poll, static forever
    const id = window.setInterval(() => setAnn(getLatest()), POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, []);

  if (!ann) {
    return <p class="text-sm text-dim text-center py-6 px-5">{t('sessions.alternates.retracted')}</p>;
  }

  const canChoose = ann.finalized;
  const viterbiPick = viterbiPickOf(ann);

  return (
    <div class="-mx-5 -my-4">
      {!canChoose && (
        <p class="text-xs text-dim text-center py-2 px-5 border-b border-border/50">{t('sessions.alternates.notFinalizedYet')}</p>
      )}
      <div class="divide-y divide-border/50">
        {optionsFor(ann, viterbiPick).map(opt => {
          const isViterbi = opt.tuneId === viterbiPick.tuneId;
          // Selection is the user's verdict, not the algorithm's: until they
          // have confirmed something, NOTHING is ticked here — the card is
          // showing a proposal, and a tick beside it would read as an answer
          // already given.
          const isSelected = ann.userConfirmed && opt.tuneId === ann.tuneId;

          // A plain div, not a <button> — AbcPreview below is its own real
          // button, and nesting <button> inside <button> is invalid HTML
          // (unpredictable click/focus behavior across browsers). AbcPreview's
          // own onClick already stops propagation, so it stays independently
          // clickable regardless of canChoose without any extra wiring here.
          return (
            <div
              key={opt.tuneId}
              role={canChoose ? 'button' : undefined}
              tabIndex={canChoose ? 0 : undefined}
              class={`w-full flex items-center gap-3 px-5 py-2.5 transition-colors ${
                isSelected ? 'bg-accent/10' : canChoose ? 'hover:bg-bg cursor-pointer' : ''} ${!canChoose ? 'opacity-70' : ''}`}
              onClick={canChoose ? () => onSelect(isSelected ? null : opt) : undefined}
              onKeyDown={canChoose ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSelected ? null : opt); } } : undefined}
            >
              <span class="w-4 shrink-0 text-accent text-sm leading-none">{isSelected ? '✓' : ''}</span>
              <AbcPreview settingId={opt.settingId} displayName={opt.displayName} size={11} />

              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm text-primary truncate capitalize">{opt.displayName}</span>
                  {isViterbi && (
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-accent/15 text-accent" title={t('sessions.alternates.viterbiHint')}>
                      {t('sessions.alternates.viterbiBadge')}
                    </span>
                  )}
                </div>
                <div class="text-xs text-dim truncate">{opt.dance} · {opt.meter}</div>
              </div>

              <span class={`text-xs font-mono tabular-nums shrink-0 ${BUCKET_TEXT[bucketOf(opt.meanScore, DETECTION_TEMPORAL_CONFIG)]}`}>
                {Math.round(opt.meanScore * 100)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Imperative bridge — showModal (the shared modal shell) still needs a plain
 *  HTMLElement body; everything inside it is this component's own JSX now.
 *  showModal already handles the title bar, close button, Escape, and
 *  click-outside — no need to reimplement any of that here. Safe to render()
 *  here: called from a plain click handler (AnnotationCard's confidence
 *  badge), never mid-Preact-render — see AnnotationCard.tsx's own doc for
 *  why that distinction matters. `getLatest` is omitted for a finished
 *  session's summary (AnnotationCard.tsx only passes it when its own
 *  `getLatestAnnotation` option is set) — see the component's own doc. */
export function showAlternatesPopover(
  ann: SessionAnnotation,
  getLatest: (() => SessionAnnotation | undefined) | undefined,
  onSelect: (pick: AnnotationAlternate | null) => void,
): void {
  const body = document.createElement('div');
  // showModal's closeModal() only removes the overlay from the DOM — it has
  // no idea a Preact tree is render()-ed into `body` and never tears it
  // down on its own. Harmless for a component with no ongoing effects (see
  // ShareSessionModal.tsx's identical bridge), but THIS component has a
  // live setInterval (the poll above) that would otherwise keep running
  // forever, invisibly, after every close — render(null, body) properly
  // unmounts it, running the interval's cleanup. Wired into BOTH exit paths:
  // showModal's own onDismiss (X/Escape/outside-click) and this wrapped
  // onSelect (an explicit choice, which closeModal()s itself — same "action
  // button" pattern showModal's own doc describes, deliberately bypassing
  // onDismiss for that path).
  const cleanup = () => render(null, body);
  const handleSelect = (pick: AnnotationAlternate | null) => {
    onSelect(pick);
    closeModal();
    cleanup();
  };
  render(<AlternatesPopover initial={ann} getLatest={getLatest} onSelect={handleSelect} />, body);
  showModal(t('sessions.alternates.title'), body, [], true, '420px', cleanup);
}
