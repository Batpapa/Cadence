import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { SyncedScore, scoreContour, bareScore, meterOf, type LiveClock } from '../../components/syncedScore';
import { startPlayAlong, playAlongOffset, setPlayAlongOffset, type PlayAlong, type PlayAlongSource, type PlayAlongStatus } from '../playAlongClient';
import { capturing } from '../../services/audioSession';
import { qualityColour } from '../../components/followColour';
import type { PlayAlongView } from '../../components/fileViewer';
import { t } from '../../services/i18nService';
import { downloadBlob } from '../../utils';

// ── Play-along: the score following what is being played ─────────────────────
// The score viewer's Play-along (2026-10-31, the user; developer mode only —
// "we will see from what it gives"): what the microphone hears — or, on a
// computer, a tab's sound, to try it on a video — followed live
// (playAlongClient.ts), and the version on the viewer's screen drawn with its
// cursor on what is heard (SyncedScore's live clock). Being for the developer
// for now, a line of what the follower says above the score: its state, the
// tempo, the share of notes on the score, how far ahead of the last frame
// heard the cursor is drawn and from what; the correction of that lead; the
// take, to replay it in the bench (experiments/score-follow/live.mjs).

/** The source as it stands: opening, open, or refused. */
type Source =
  | { kind: 'opening'; source: PlayAlongSource }
  | { kind: 'open'; source: PlayAlongSource; client: PlayAlong }
  | { kind: 'failed'; source: PlayAlongSource; message: string };

/** How often the diagnostic line is read again. */
const STATUS_MS = 250;
/** One press of − or + on the lead. */
const OFFSET_STEP_MS = 10;

const ms = (s: number | null): string => (s === null ? '?' : String(Math.round(s * 1000)));

/** Each state's words — whole keys, which the i18n test can check. */
const STATE_TEXT = {
  search: 'fileViewer.abc.playAlong.state.search',
  follow: 'fileViewer.abc.playAlong.state.follow',
  lost: 'fileViewer.abc.playAlong.state.lost',
} as const;

/** Opens `source` — from the tap that asked for it: a tab's sound must be
 *  asked for before anything is awaited. Refused while a live recording
 *  holds the microphone: the Play-along does not take it from under it. */
function open(source: PlayAlongSource, into: Signal<Source>, onEnded: () => void): void {
  if (capturing()) {
    into.value = { kind: 'failed', source, message: t('fileViewer.abc.playAlong.error.busy') };
    return;
  }
  into.value = { kind: 'opening', source };
  startPlayAlong(source, onEnded).then(
    (client) => {
      // Closed, or another source chosen, while this one was opening.
      if (into.value.kind !== 'opening' || into.value.source !== source) { client.stop(); return; }
      into.value = { kind: 'open', source, client };
    },
    (err: unknown) => {
      if (into.value.kind !== 'opening' || into.value.source !== source) return;
      const message = err instanceof Error ? err.message || err.name : String(err);
      into.value = { kind: 'failed', source, message: t('fileViewer.abc.playAlong.error.source', { message }) };
    },
  );
}

function stopSource(s: Signal<Source>): void {
  if (s.value.kind === 'open') s.value.client.stop();
}

function PlayAlongPane({ version, face, expanded, source, choose }: {
  version: Signal<string>;
  face: Signal<'sheet' | 'text'>;
  expanded: Signal<boolean>;
  source: Signal<Source>;
  choose: (s: PlayAlongSource) => void;
}) {
  const shown = version.value;
  const src = source.value;
  const client = src.kind === 'open' ? src.client : null;
  const [score, setScore] = useState<{ abc: string; meter: string } | null>(null);
  const [clock, setClock] = useState<LiveClock | null>(null);
  const [noNotes, setNoNotes] = useState(false);
  const [status, setStatus] = useState<PlayAlongStatus | null>(null);
  const [offset, setOffset] = useState(playAlongOffset());

  // The version's notes, as drawn, given to the follower — again for another
  // version, or another source.
  useEffect(() => {
    let cancelled = false;
    const abc = bareScore(shown);
    const meter = meterOf(shown);
    setScore({ abc, meter });
    setClock(null);
    setNoNotes(false);
    void scoreContour(abc, meter).then((pitches) => {
      if (cancelled) return;
      if (!pitches) { setNoNotes(true); return; }
      if (!client) return;
      client.setScore(pitches);
      setClock({ pitches, position: () => client.position() });
    });
    return () => { cancelled = true; };
  }, [shown, client]);

  useEffect(() => {
    if (!client) { setStatus(null); return; }
    const id = window.setInterval(() => setStatus(client.status()), STATUS_MS);
    return () => window.clearInterval(id);
  }, [client]);

  const nudge = (by: number) => {
    const next = offset + by;
    setPlayAlongOffset(next);
    setOffset(next);
  };

  const e = status?.estimate ?? null;
  const state = e?.state ?? 'search';
  const dot = state === 'follow' && e?.match != null ? qualityColour(e.match) : 'var(--color-text-dim)';
  const canTab = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const btn = 'px-2 py-0.5 rounded border transition-colors cursor-pointer';
  const idle = `${btn} border-border text-muted hover:text-primary hover:border-accent/50`;
  const lit = `${btn} border-accent/60 text-accent bg-accent/10`;
  const maxHeight = expanded.value
    ? 'calc(100dvh / var(--zoom-factor, 1) - 16rem)'
    : 'min(60vh, calc(100dvh / var(--zoom-factor, 1) - 20rem))';

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span class="inline-flex items-center gap-1.5 font-medium text-primary">
          <span class="inline-block w-2 h-2 rounded-full" style={{ background: dot }} />
          {src.kind === 'opening' ? t('fileViewer.abc.playAlong.opening') : t(STATE_TEXT[state])}
        </span>
        {e?.state === 'follow' && e.quaver !== null && (
          <span>{t('fileViewer.abc.playAlong.stats', { bpm: e.bpm, match: e.match === null ? '?' : Math.round(e.match * 100) })}</span>
        )}
        {status && (
          <span title={t('fileViewer.abc.playAlong.latencyHint')}>
            {t('fileViewer.abc.playAlong.latency', {
              horizon: ms(status.horizon), input: ms(status.inputLatency), output: ms(status.outputLatency), offset,
            })}
          </span>
        )}
        <span class="inline-flex items-center gap-1" title={t('fileViewer.abc.playAlong.offsetHint')}>
          {t('fileViewer.abc.playAlong.offset')}
          <button type="button" class={idle} onClick={() => nudge(-OFFSET_STEP_MS)}>−</button>
          <span class="tabular-nums w-14 text-center">{offset} ms</span>
          <button type="button" class={idle} onClick={() => nudge(OFFSET_STEP_MS)}>+</button>
        </span>
        <span class="inline-flex items-center gap-1">
          <button type="button" class={src.source === 'mic' ? lit : idle} onClick={() => choose('mic')}>{t('fileViewer.abc.playAlong.source.mic')}</button>
          {canTab && (
            <button type="button" class={src.source === 'tab' ? lit : idle} onClick={() => choose('tab')}>{t('fileViewer.abc.playAlong.source.tab')}</button>
          )}
        </span>
        {client && (
          <button
            type="button"
            class={idle}
            onClick={() => void client.dump().then(b => downloadBlob(b, `play-along-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`))}
          >
            {t('fileViewer.abc.playAlong.dump')}
          </button>
        )}
      </div>
      {src.kind === 'failed' && <div class="text-xs text-danger">{src.message}</div>}
      {noNotes && <div class="text-xs text-danger">{t('fileViewer.abc.playAlong.noNotes')}</div>}
      {score && (
        <SyncedScore
          abc={score.abc} meter={score.meter} follow={null} engine={null} region={null}
          transpose={0} playing={false} maxHeight={maxHeight} face={face.value} clock={clock ?? undefined}
        />
      )}
    </div>
  );
}

/** The Play-along of `version` — a version's ABC — in `host`, on the
 *  viewer's face and at its size (fileViewer.ts). Call it from the tap that
 *  turns it on: the microphone is asked for at once. */
export function mountPlayAlong(host: HTMLElement, opts: { version: string; face: 'sheet' | 'text'; expanded: boolean }): PlayAlongView {
  const version = signal(opts.version);
  const face = signal(opts.face);
  const expanded = signal(opts.expanded);
  const source = signal<Source>({ kind: 'opening', source: 'mic' });
  const ended = () => { source.value = { kind: 'failed', source: source.value.source, message: t('fileViewer.abc.playAlong.error.ended') }; };
  const choose = (s: PlayAlongSource) => {
    stopSource(source);
    open(s, source, ended);
  };
  open('mic', source, ended);
  render(<PlayAlongPane version={version} face={face} expanded={expanded} source={source} choose={choose} />, host);
  return {
    setVersion: (v) => { version.value = v; },
    setFace: (f) => { face.value = f; },
    setExpanded: (v) => { expanded.value = v; },
    unmount: () => {
      // Opening still: it stops itself when it lands (`open`).
      const s = source.value;
      source.value = { kind: 'failed', source: s.source, message: '' };
      if (s.kind === 'open') s.client.stop();
      render(null, host);
    },
  };
}
