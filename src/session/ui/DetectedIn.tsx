import { appState, navigate } from '../../store';
import { t } from '../../services/i18nService';
import { findCardDetections, sessionsOf, detectionsOnCards } from '../detections';
import { fmtLongTime, defaultSessionName, BUCKET_TEXT } from './sessionUiShared';

// ── The Sessions module's panel on a card page ────────────────────────────────
// Registered through services/cardPanels — the card view renders it without
// knowing what it is. Everything it shows is derived at render time (see
// session/detections.ts), so it follows a session being renamed, re-analysed,
// corrected or deleted with nothing to keep in step.

/** One detection = one destination. Two passes through the same tune in one
 *  evening are two chips, under one session heading — listing the session
 *  twice would read as a duplicate, while one chip for two passes would lose
 *  the second place in the recording. */
export function DetectedIn({ cardId }: { cardId: string }) {
  const user = appState.value;
  const card = user.cards[cardId];
  // The switch lives on the module's own screen (the sessions library): whoever
  // records has an opinion about this, and whoever does not never sees it.
  if (!card || !detectionsOnCards(user)) return null;

  const groups = findCardDetections(card, sessionsOf(user));
  // Hidden entirely when empty, like the backlinks section it sits beside: most
  // cards were never played into a microphone, and an empty heading is noise.
  if (groups.length === 0) return null;

  return (
    <div class="space-y-2">
      <span class="section-title">{t('card.section.detectedIn')}</span>
      <div class="space-y-1">
        {groups.map(group => (
          <div key={group.sessionId} class="flex items-center gap-2 flex-wrap">
            <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">♪</span>
            <span
              class="text-xs font-mono truncate text-muted hover:text-primary cursor-pointer transition-colors"
              title={t('sessions.openSession')}
              onClick={() => navigate({ view: 'sessions', sessionId: group.sessionId })}
            >{group.name || defaultSessionName(group.date)}</span>
            {group.detections.map(d => (
              <button
                key={d.annotationId}
                class={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border cursor-pointer transition-colors hover:border-accent ${
                  d.confirmed ? 'text-success' : BUCKET_TEXT[d.bucket]}`}
                title={t(d.confirmed ? 'sessions.alternates.confirmed' : `sessions.confidence.${d.bucket}`)}
                onClick={() => navigate({ view: 'sessions', sessionId: group.sessionId, annotationId: d.annotationId })}
              >
                {fmtLongTime(d.start)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
