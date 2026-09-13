import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon } from '../../components/icons';
import { playIcon, stopIcon } from '../../components/playbackIcons';
import { loadSessionAudio } from '../db';
import type { Detection } from '../model';
import { BUCKET_TEXT, ClipControls, fmtLongTime, type ClipSessionRef } from './sessionUiShared';
import { AbcPreview } from './abcPreview';

// ── One pass through a tune, wherever a list of them is shown ─────────────────
// The analyser's tunes tab and a card's "Detected in" panel list the same
// thing — every time a tune was heard, each its own place in a recording — so
// they list it the same way, with the same controls in the same order (decided
// with the user, 2026-09-13):
//
//   [play] [ABC] [time] [analysis ♥] [download clip] [add clip to card]
//
// Hearing and reading come first because both lists are for tunes being
// learnt; the time and the analysis are where the pass lives, and lead there;
// the clip controls close the line because they are what is done last.

/** Passages from several evenings, played through ONE audio element. */
export interface SlicePlayer {
  /** Render it once, anywhere in the list: it is hidden. */
  audio: VNode;
  playingId: string | null;
  /** Keyed by analysis id; absent until probed. */
  hasAudio: Record<string, boolean>;
  /** Looks up which of these analyses still have their recording on this
   *  device. Only ever for what is on screen — never a whole library. */
  probe: (sessionIds: string[]) => void;
  play: (sessionId: string, detection: Detection) => Promise<void>;
}

/** The rows of one tune come from different evenings, so there is no single
 *  recording to hold open. The one that is playing is the one that is loaded;
 *  moving to another evening re-points the element. Native <audio>, never
 *  decodeAudioData: an analysis can run for hours. */
export function useSlicePlayer(): SlicePlayer {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedRef = useRef<{ sessionId: string; url: string } | null>(null);
  const sliceEndRef = useRef<number>(Infinity);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState<Record<string, boolean>>({});

  // The object URL points at a whole recording; leaving the screen is the
  // last chance to let it go.
  useEffect(() => () => {
    if (loadedRef.current) URL.revokeObjectURL(loadedRef.current.url);
  }, []);

  const probe = (sessionIds: string[]) => {
    const unknown = [...new Set(sessionIds)].filter(id => !(id in hasAudio));
    if (unknown.length === 0) return;
    void Promise.all(unknown.map(async id => [id, !!(await loadSessionAudio(id))] as const))
      .then(pairs => setHasAudio(prev => ({ ...prev, ...Object.fromEntries(pairs) })));
  };

  const play = async (sessionId: string, detection: Detection) => {
    const a = audioRef.current;
    if (!a) return;
    const start = Math.max(0, detection.start);
    // STOP, not pause — the same call the incipit's button makes. A passage is
    // under a minute, so there is nothing to come back to in the middle of it,
    // and pressing it again plays it from its own start.
    if (playingId === detection.id) { a.pause(); a.currentTime = start; setPlayingId(null); return; }

    if (loadedRef.current?.sessionId !== sessionId) {
      const blob = await loadSessionAudio(sessionId);
      if (!blob) return;
      if (loadedRef.current) URL.revokeObjectURL(loadedRef.current.url);
      const url = URL.createObjectURL(blob);
      loadedRef.current = { sessionId, url };
      a.src = url;
    }
    sliceEndRef.current = detection.end ?? Infinity;
    a.currentTime = start;
    try { await a.play(); } catch { setPlayingId(null); return; }
    setPlayingId(detection.id);
  };

  const audio = (
    <audio
      ref={audioRef}
      class="hidden"
      onPause={() => setPlayingId(null)}
      onEnded={() => setPlayingId(null)}
      onTimeUpdate={(e) => {
        const a = e.currentTarget;
        if (a.currentTime >= sliceEndRef.current) a.pause();
      }}
    />
  );

  return { audio, playingId, hasAudio, probe, play };
}

export function PassRow({ session, detection, cardId, ctx, player, interactive, onOpen, onAttached }: {
  session: ClipSessionRef;
  detection: Detection;
  /** The card this tune already has — lets the ABC preview offer its ★. */
  cardId?: string;
  ctx: AppContext;
  player: SlicePlayer;
  /** False while something else owns the clicks (the tunes tab's selection):
   *  the links stop looking like links, and `onOpen` decides what happens. */
  interactive: boolean;
  /** The time and the analysis name both lead to the pass inside its analysis. */
  onOpen: (e: MouseEvent) => void;
  onAttached?: () => void;
}) {
  const playing = player.playingId === detection.id;
  return (
    // Never wraps. A pass is one line, and its glyphs are columns read
    // downwards — a row that folded would take its columns with it.
    <div class="flex items-center gap-2 min-w-0">
      {/* Fixed slots, filled or not: what can be done with a pass depends on
          the pass — an analysis whose audio was forgotten offers no listening
          and no clip — and without reserved room the glyphs of one row would
          sit under the wrong glyphs of the next. */}
      <div class="shrink-0 flex items-center gap-1.5">
        <span class="w-6 flex items-center justify-center shrink-0">
          {player.hasAudio[session.id] && (
            <button
              class={`w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
                playing ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
              title={t(playing ? 'sessions.stopSlice' : 'sessions.playSlice')}
              dangerouslySetInnerHTML={{ __html: playing ? stopIcon(10) : playIcon(10) }}
              onClick={() => { void player.play(session.id, detection); }}
            />
          )}
        </span>
        <AbcPreview settingId={detection.settingId} displayName={detection.displayName} cardId={cardId} ctx={ctx} />
      </div>

      <button
        class={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border ${interactive ? 'cursor-pointer hover:border-accent' : ''} ${
          detection.userConfirmed ? 'text-success' : BUCKET_TEXT[detection.bucket]}`}
        title={t('sessions.openDetection')}
        onClick={onOpen}
      >
        {fmtLongTime(detection.start)}
      </button>

      <button
        class={`text-sm text-muted min-w-0 text-left flex-1 inline-flex items-center gap-1.5 ${interactive ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
        // The full name, since the visible one is cut.
        title={session.name}
        onClick={onOpen}
      >
        <span class="truncate min-w-0">{session.name}</span>
        {/* THIS pass, not the tune: a tune hearted once must not look hearted
            on every line. */}
        {detection.liked && (
          <span class="text-danger shrink-0 flex items-center"><HeartIcon size={10} filled /></span>
        )}
      </button>

      <div class="shrink-0 flex items-center gap-1.5">
        <ClipControls
          ann={detection}
          session={session}
          audioAvailable={!!player.hasAudio[session.id]}
          getAudio={() => loadSessionAudio(session.id)}
          ctx={ctx}
          onAttached={onAttached}
          aligned
        />
      </div>
    </div>
  );
}
