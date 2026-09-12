import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, renderModalBody } from '../../components/modal';

// ── Running a bulk action over a selection, and saying what happened ─────────
// Same shape as the card library's batch refresh (components/batchEdit.tsx's
// RefreshProgress) — one bar, one tally, and the items that did not go through
// named rather than counted. Written here rather than reused from there because
// that one is bound to "refresh these cards from their upstream": it takes a
// fetch spec and a field list, neither of which means anything to a clip.
//
// Steps run ONE AT A TIME, deliberately. Both callers do real work per step —
// a TheSession round trip, or decoding and re-encoding an MP3 — and firing ten
// of those at once would rate-limit the first and freeze the tab on the second.

export type StepOutcome =
  | { status: 'done' }
  /** Nothing to do, and that is fine — say why in one short phrase. */
  | { status: 'skipped'; reason: string };

export interface BatchStep {
  /** What this step is about, as the user would name it — a tune. */
  label: string;
  /** `onProgress` is for a step long enough to have an inside (an MP3 being
   *  cut); a step without one simply never calls it. Throwing counts as a
   *  failure and the message is shown, so there is no need to catch here. */
  run: (onProgress?: (ratio: number) => void) => Promise<StepOutcome>;
}

interface Issue { label: string; reason: string; failed: boolean }

function BatchProgress({ steps, cancelled, onFinished }: {
  steps: BatchStep[];
  cancelled: { now: boolean };
  onFinished: () => void;
}) {
  const [done, setDone] = useState(0);
  const [within, setWithin] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [finished, setFinished] = useState(false);
  const total = steps.length;

  useEffect(() => {
    void (async () => {
      const found: Issue[] = [];
      for (let i = 0; i < steps.length; i++) {
        // Closing the dialog unmounts this and flips the flag — stop working
        // for a report nobody is reading any more.
        if (cancelled.now) return;
        const step = steps[i]!;
        setCurrent(step.label);
        setWithin(0);
        let outcome: StepOutcome;
        try {
          outcome = await step.run(r => setWithin(r));
        } catch (err) {
          outcome = { status: 'skipped', reason: String(err) };
          found.push({ label: step.label, reason: String(err), failed: true });
          setIssues([...found]);
          setDone(i + 1);
          continue;
        }
        if (outcome.status === 'skipped') {
          found.push({ label: step.label, reason: outcome.reason, failed: false });
          setIssues([...found]);
        }
        setDone(i + 1);
      }
      setCurrent(null);
      setFinished(true);
      onFinished();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The bar counts the step being worked on too, or a run of three slow steps
  // would sit still for a third of its life at a time.
  const pct = total > 0 ? Math.min(100, Math.round(((done + within) / total) * 100)) : 100;
  const ok = done - issues.length;

  return (
    <div class="space-y-3">
      <div class="knowledge-bar"><div class="knowledge-fill bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
      <p class="text-xs text-muted">
        {finished
          ? t(ok === 1 ? 'sessions.batch.done' : 'sessions.batch.donePlural', { n: ok })
          : t('sessions.batch.progress', { done, total })}
      </p>
      {/* Which one it is on. Not a decoration: the slow step is an MP3 being
          cut out of an hour of audio, and knowing which tune it is on is the
          difference between waiting and wondering. */}
      {current && <p class="text-xs text-dim truncate">{current}</p>}
      {finished && issues.length > 0 && (
        <div class="space-y-1">
          <p class="text-xs text-warn">
            {t(issues.length === 1 ? 'sessions.batch.issues' : 'sessions.batch.issuesPlural', { n: issues.length })}
          </p>
          <ul class="text-xs text-muted list-disc pl-4 max-h-32 overflow-y-auto">
            {issues.map((issue, i) => (
              <li key={`${issue.label}:${i}`} class={issue.failed ? 'text-danger' : undefined}>
                {issue.label} — {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Runs `steps` behind a progress dialog. `onFinished` fires when the run ends
 *  AND when the dialog is dismissed part-way: either way the screen behind it
 *  is now out of date with what was written. */
export function showBatchProgress(title: string, steps: BatchStep[], onFinished?: () => void): void {
  const cancelled = { now: false };
  const { el, cleanup } = renderModalBody(
    <BatchProgress steps={steps} cancelled={cancelled} onFinished={() => onFinished?.()} />,
  );
  // No footer: a bar that reaches its end and a tally under it need no button
  // to agree with, and the ✕, Escape and the backdrop already close it — which
  // is also the safe half, since those three run onDismiss and a footer button
  // would not, leaving the loop working for a torn-down dialog.
  showModal(title, el, [], {
    maxWidth: '28rem',
    onDismiss: () => { cancelled.now = true; cleanup(); onFinished?.(); },
  });
}
