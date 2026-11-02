import { t } from '../../services/i18nService';
import type { Beat } from '../liveFollow';
import type { Detection } from '../model';
import { inBeats } from '../tempoSummary';

/** The unit of a tempo, a minute. Spelt out, so the key check
 *  (i18nKeys.test.ts) sees every one. */
const UNIT_TEXT: Record<Beat['unit'], 'sessions.tempo.unit.quaver' | 'sessions.tempo.unit.crotchet' | 'sessions.tempo.unit.dottedCrotchet' | 'sessions.tempo.unit.minim' | 'sessions.tempo.unit.dottedMinim'> = {
  quaver: 'sessions.tempo.unit.quaver',
  crotchet: 'sessions.tempo.unit.crotchet',
  dottedCrotchet: 'sessions.tempo.unit.dottedCrotchet',
  minim: 'sessions.tempo.unit.minim',
  dottedMinim: 'sessions.tempo.unit.dottedMinim',
};

export const tempoUnitText = (unit: Beat['unit']): string => t(UNIT_TEXT[unit]);

/** "106 BPM", as a card says it (2026-11-02, the user): a quaver rate in the
 *  beat of `detection`'s dance — the unit's name is in its curve. "~106 BPM"
 *  when read over less than the full window (a tune shorter than it). */
export function tempoText(rate: number, detection: Detection | null, approx = false): string {
  return `${approx ? '~' : ''}${t('sessions.tempo.bpm', { n: Math.round(inBeats(rate, detection).value) })}`;
}
