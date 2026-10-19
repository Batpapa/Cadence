import { useEffect } from 'preact/hooks';
import { appState, navigate, getContext } from '../../store';
import { t } from '../../services/i18nService';
import { findCardDetections, sessionsOf, detectionsOnCards, experimentalSets } from '../detections';
import { PassRow, PlayPassButton, useSlicePlayer, type SlicePlayer } from './PassRow';
import { HeartIcon } from '../../components/icons';
import { isTuneset } from '../../services/cardTypeService';
import { hasRecognisedSetting, type Analysis, type Detection } from '../model';
import type { Card } from '../../types';
import { findSetHearings, chainSpan, recordOf } from '../tunesets';
import { loadSessionAudio } from '../db';
import { HeardSetAbc } from './abcPreview';
import { fmtLongTime, tuneName } from './sessionUiShared';
import { SetClipControls } from './tunesetShared';
import { chainPlayId } from './TunesetDetectionCard';


// ── The Sessions module's panel on a card page ────────────────────────────────
// Registered through services/cardPanels — the card view renders it without
// knowing what it is. Everything it shows is derived at render time (see
// session/detections.ts), so it follows a session being renamed, re-analysed,
// corrected or deleted with nothing to keep in step.

/** One line per detection, each with the controls it has in the analyser's
 *  tunes tab — play, ABC, download, add the clip — through the same PassRow,
 *  so the two lists cannot drift apart (2026-09-13). It used to be one line per
 *  session with the passes as time chips, which left nowhere to put a control:
 *  hearing every version of a tune from its card is the point of the panel for
 *  someone choosing which recording to learn from. */
export function DetectedIn({ cardId }: { cardId: string }) {
  const card = appState.value.cards[cardId];
  // A set is heard as a set: its own list, of the analyses where these tunes
  // were played one after the other in this order (2026-10-19) — never its
  // tunes' detections, which are each tune's own business.
  if (card && isTuneset(card)) return experimentalSets(appState.value) ? <SetDetectedIn cardId={cardId} /> : null;
  return <TuneDetectedIn cardId={cardId} />;
}

function TuneDetectedIn({ cardId }: { cardId: string }) {
  const user = appState.value;
  const card = user.cards[cardId];
  const player = useSlicePlayer();
  // The switch lives on the module's own screen (the sessions library): whoever
  // records has an opinion about this, and whoever does not never sees it.
  const groups = card && detectionsOnCards(user) ? findCardDetections(card, sessionsOf(user)) : [];

  // Which of these recordings are still on this device — asked once per set of
  // analyses, not per render. A key string, because a fresh array every render
  // would make the effect run every render.
  const sessionKey = groups.map(g => g.session.id).join(',');
  useEffect(() => {
    if (sessionKey) player.probe(sessionKey.split(','));
  }, [sessionKey]);

  // Hidden entirely when empty, like the backlinks section it sits beside: most
  // cards were never played into a microphone, and an empty heading is noise.
  if (groups.length === 0) return null;

  const ctx = getContext();
  return (
    <div class="space-y-2">
      {player.audio}
      <span class="section-title">{t('card.section.detectedIn')}</span>
      <div class="space-y-1.5">
        {groups.flatMap(({ session, detections }) => detections.map(detection => (
          <PassRow
            key={detection.id}
            session={session}
            detection={detection}
            cardId={cardId}
            ctx={ctx}
            player={player}
            interactive
            onOpen={() => navigate({ view: 'sessions', sessionId: session.id, annotationId: detection.id })}
          />
        )))}
      </div>
    </div>
  );
}

/** The set card's "Detected in": one line per time these tunes were played
 *  one after the other, in this order — newest analysis first. Read-only like
 *  the tune's (its heart is the set's own, set in the analysis), with the same
 *  controls: play the whole set, its score as played, open that moment, cut it. */
function SetDetectedIn({ cardId }: { cardId: string }) {
  const user = appState.value;
  const card = user.cards[cardId];
  const player = useSlicePlayer();
  const hearings = card && detectionsOnCards(user) ? findSetHearings(card, user.cards, sessionsOf(user)) : [];

  const sessionKey = [...new Set(hearings.map(h => h.session.id))].join(',');
  useEffect(() => {
    if (sessionKey) player.probe(sessionKey.split(','));
  }, [sessionKey]);

  if (!card || hearings.length === 0) return null;

  return (
    <div class="space-y-2">
      {player.audio}
      <span class="section-title">{t('card.section.detectedIn')}</span>
      <div class="space-y-1.5">
        {hearings.map(({ session, chain }) => (
          <SetHearingRow
            key={`${session.id}:${chain[0]!.id}`}
            session={session}
            chain={chain}
            setCard={card}
            title={card.name}
            player={player}
            interactive
            onOpen={() => navigate({ view: 'sessions', sessionId: session.id, annotationId: chain[0]!.id })}
          />
        ))}
      </div>
    </div>
  );
}

/** One time a set was played — the set's twin of PassRow, shared by the set
 *  card's "Detected in" and the analyses' detections tab. */
export function SetHearingRow({ session, chain, setCard, title, player, interactive, onOpen, onAttached }: {
  session: Analysis;
  chain: Detection[];
  setCard: Card | undefined;
  /** The set's name, for its score. */
  title: string;
  player: SlicePlayer;
  /** False while a selection owns the clicks (see PassRow). */
  interactive: boolean;
  onOpen: (e: MouseEvent) => void;
  onAttached?: () => void;
}) {
  const span = chainSpan(chain, session.duration);
  const asAnn = { ...chain[0]!, id: chainPlayId(chain), ...span };
  const liked = !!recordOf(session.tunesets, chain)?.liked;
  return (
    <div class="flex items-center gap-2 min-w-0">
      <div class="shrink-0 flex items-center gap-1.5">
        <span class="w-6 flex items-center justify-center shrink-0">
          <PlayPassButton sessionId={session.id} detection={asAnn} player={player} />
        </span>
        <HeardSetAbc
          title={title}
          tunes={chain.map(d => ({ label: tuneName(d).text, settingId: hasRecognisedSetting(d) ? d.settingId : null }))}
        />
      </div>
      <button
        class={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border text-muted ${interactive ? 'cursor-pointer hover:border-accent' : ''}`}
        title={t('sessions.openDetection')}
        onClick={onOpen}
      >
        {fmtLongTime(span.start)}
      </button>
      <button
        class={`text-sm text-muted min-w-0 text-left flex-1 inline-flex items-center gap-1.5 ${interactive ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
        title={session.name}
        onClick={onOpen}
      >
        <span class="truncate min-w-0">{session.name}</span>
        {liked && <span class="text-danger shrink-0 flex items-center"><HeartIcon size={10} filled /></span>}
      </button>
      <div class="shrink-0 flex items-center gap-1.5">
        <SetClipControls
          session={session}
          setCard={setCard}
          span={span}
          audioAvailable={player.isHere(session.id)}
          getAudio={() => loadSessionAudio(session.id)}
          ctx={getContext()}
          onAttached={onAttached}
        />
      </div>
    </div>
  );
}
