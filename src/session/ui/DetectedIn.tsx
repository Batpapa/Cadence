import { useEffect } from 'preact/hooks';
import { appState, navigate, getContext } from '../../store';
import { t } from '../../services/i18nService';
import { findCardDetections, sessionsOf, detectionsOnCards } from '../detections';
import { PassRow, useSlicePlayer } from './PassRow';


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
