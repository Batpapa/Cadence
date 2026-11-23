import { appState } from '../../store';
import { tuneAnalyserOffered } from '../../services/extensions';
import { isTuneset } from '../../services/cardTypeService';
import type { CardPassage } from '../../components/cardAudioSync';
import { findCardDetections, sessionsOf, detectionsOnCards, setDetectionOn } from '../detections';
import { findSetHearings, chainSpan } from '../tunesets';
import { loadSessionAudio } from '../db';
import type { Analysis } from '../model';
import type { FollowAudio } from '../scoreFollowClient';
import { followAudioFromDrive, syncedAudioEntry } from './PassRow';

// ── A card's score, following its "Detected in" ──────────────────────────────
// The passes a card page lists (DetectedIn.tsx) are recordings its score can
// follow too (N3c-b, 2026-11-22, the user: the synchro of a card's ABC with
// the passes of its "Detected in"). The same passes, by the same rules: none
// when the panel is hidden, a set's times played as a set. Each read as its
// own audio sync reads it (PassRow.tsx detectionAudioSync): the recording on
// this device, else the stretch from Drive.

/** Where an analysis's recording is — asked once for the score's viewer,
 *  however many of its passes are listed. */
function whereOf(sessionId: string, asked: Map<string, Promise<'here' | 'drive' | null>>): Promise<'here' | 'drive' | null> {
  let w = asked.get(sessionId);
  if (!w) {
    w = loadSessionAudio(sessionId)
      .then(blob => (blob ? 'here' as const : syncedAudioEntry(sessionId) ? 'drive' as const : null))
      .catch(() => (syncedAudioEntry(sessionId) ? 'drive' as const : null));
    asked.set(sessionId, w);
  }
  return w;
}

function passage(session: Analysis, start: number, end: number, asked: Map<string, Promise<'here' | 'drive' | null>>): CardPassage {
  // From Drive, fetched once: the chooser's compare and the follow then
  // picked read the same stretch.
  let fromDrive: Promise<FollowAudio | undefined> | null = null;
  return {
    name: session.name,
    start,
    end,
    where: () => whereOf(session.id, asked),
    audio: async () => {
      const blob = await loadSessionAudio(session.id);
      if (blob) return { blob, start: 0 };
      fromDrive ??= followAudioFromDrive(session.id, start, end).then((a) => { if (!a) fromDrive = null; return a; });
      return fromDrive;
    },
  };
}

/** The passes of the card `cardId` — registered at the module's load
 *  (sessionModule.tsx), as its panel is. */
export function cardPassages(cardId: string): CardPassage[] {
  const user = appState.value;
  const card = user.cards[cardId];
  if (!card || !tuneAnalyserOffered() || !detectionsOnCards(user)) return [];
  const sessions = sessionsOf(user);
  const asked = new Map<string, Promise<'here' | 'drive' | null>>();
  if (isTuneset(card)) {
    if (!setDetectionOn(user)) return [];
    return findSetHearings(card, user.cards, sessions).map(({ session, chain }) => {
      const span = chainSpan(chain, session.duration);
      return passage(session, span.start, span.end, asked);
    });
  }
  return findCardDetections(card, sessions).flatMap(({ session, detections }) =>
    detections.map(d => passage(session, d.start, d.end ?? d.start + 60, asked)));
}
