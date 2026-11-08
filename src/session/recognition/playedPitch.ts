import type { WindowCandidate } from '../model';

// ── The pitch a tune was played at, comparable from window to window ─────────
// (2026-11-08) Feeds the pitch split (pitchSplit.ts): the same tune played again
// straight away in another key (Am, then Bm) used to make ONE detection, since the
// segmenter's states are tunes, not keys.
//
// A window only says "this setting, `transpose` semitones above its written key,
// in a session `tuning` semitones off A = 440" — and the setting that wins changes
// from one window to the next (players mix settings: 8 819 windows of 14 683 on
// the 18 annotated files named another setting than their detection's, 769 of
// them written in another key). So every window is brought back to ONE reference
// per tune, its main setting:
//
//   pitch = offset(setting -> main setting) + transpose + tuning     (mod 12)
//
// `transpose + tuning` does not jump when the tuning estimate wraps at +/- half a
// semitone: the transposition takes the step over.
//
// The offset between two settings of a tune is read off the melodies — the
// index's `mode` cannot give it: it drops sharps ("Fdorian" is F#dorian) and the
// same tune is written Ador in one setting and Amin in another (642 windows went
// wrong that way, against 3 with the melodies). A histogram of pitch classes
// mistook fourths for fifths (10 windows). Measured on the 18 files: within a
// detection, the pitch stays within 5.8 cents (p99). Research record outside the
// repo (recognition-research/JOURNAL.md, sections 17-17.2).

/** Raw any-key query record fields this needs (FolkFriend fork): the
 *  transposition is 0-11 above the setting as written, `other_keys` the tune's
 *  other aligned (setting, transposition, score) pairs, best first. */
export interface RawKeyedRecord {
  setting_id: string;
  setting: { tune_id: string };
  score: number;
  transpose?: number;
  other_keys?: [string, number, number][];
}

/** Wrapped to (-6, 6] semitones. */
export function wrapSemitones(x: number): number {
  const y = ((x % 12) + 12) % 12;
  return y > 6 ? y - 12 : y;
}

/** Note 3-grams (pitch classes, repeated notes merged) of a contour, as codes. */
function grams(contour: string): number[] {
  const notes: number[] = [];
  for (let i = 0; i < contour.length; i++) {
    const k = CONTOUR_CHARS.indexOf(contour[i]!);
    if (k >= 0 && notes[notes.length - 1] !== k % 12) notes.push(k % 12);
  }
  const out: number[] = [];
  for (let i = 0; i + 2 < notes.length; i++) out.push(notes[i]! * 144 + notes[i + 1]! * 12 + notes[i + 2]!);
  return out;
}
// FolkFriend's contour alphabet (ff_config::CONTOUR_TO_QUERY_CHAR): one letter per
// semitone from MIDI 48, a C; the index folded to pitch classes uses 'a'..'l'.
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

/** How many semitones setting `a` is written above setting `b` (-5..6): the shift
 *  that makes most of a's note 3-grams appear among b's. Ties keep the smaller
 *  shift upwards (0 first). */
export function settingOffset(a: string, b: string): number {
  const ga = grams(a), gb = new Set(grams(b));
  let best = 0, bestHits = -1;
  for (let d = 0; d < 12; d++) {
    let hits = 0;
    for (const x of ga) {
      const p0 = (Math.floor(x / 144) - d + 12) % 12, p1 = (Math.floor(x / 12) % 12 - d + 12) % 12, p2 = (x % 12 - d + 12) % 12;
      if (gb.has(p0 * 144 + p1 * 12 + p2)) hits++;
    }
    if (hits > bestHits) { best = d; bestHits = hits; }
  }
  return best > 6 ? best - 12 : best;
}

/** A tune's settings as [settingId, contour] — from the engine (FolkFriendWASM
 *  .settings_from_tune_id) in the worker. */
export type SettingsOf = (tuneId: string) => Array<[string, string]>;

/** Per-session cache of the tunes' main settings and of setting offsets. */
export class PlayedPitch {
  private readonly tunes = new Map<string, { main: string; contours: Map<string, string> } | null>();
  private readonly offsets = new Map<string, number | null>();
  constructor(private readonly settingsOf: SettingsOf) {}

  private tune(tuneId: string) {
    let t = this.tunes.get(tuneId);
    if (t !== undefined) return t;
    const list = this.settingsOf(tuneId);
    t = null;
    if (list.length) {
      // the setting whose id is the tune's (TheSession's first), else the oldest
      let main = list[0]![0];
      for (const [id] of list) {
        if (main === tuneId) break;
        if (id === tuneId || Number(id) < Number(main)) main = id;
      }
      t = { main, contours: new Map(list) };
    }
    this.tunes.set(tuneId, t);
    return t;
  }

  /** Semitones `settingId` is written above its tune's main setting, null when
   *  the engine does not know the tune or the setting. */
  offset(tuneId: string, settingId: string): number | null {
    const key = `${tuneId}|${settingId}`;
    const known = this.offsets.get(key);
    if (known !== undefined) return known;
    const t = this.tune(tuneId);
    const c = t?.contours.get(settingId);
    const m = t ? t.contours.get(t.main) : undefined;
    const v = c === undefined || m === undefined ? null : settingId === t!.main ? 0 : settingOffset(c, m);
    this.offsets.set(key, v);
    return v;
  }

  /** Writes `pitch` and `otherPitches` on a candidate made from `raw`, the
   *  window's tuning being `tuning` semitones off A = 440. Leaves it untouched
   *  when either is unknown. */
  annotate(c: WindowCandidate, raw: RawKeyedRecord, tuning: number | undefined): void {
    if (tuning === undefined || !Number.isFinite(tuning)) return;
    const tuneId = raw.setting.tune_id;
    const own = this.offset(tuneId, raw.setting_id);
    if (own === null) return;
    const ownKey = ((own + (raw.transpose ?? 0)) % 12 + 12) % 12;
    c.pitch = round(wrapSemitones(ownKey + tuning), 3);
    // the tune's best score at every other whole pitch it was aligned at
    const best = new Map<number, number>();
    for (const [sid, r, score] of raw.other_keys ?? []) {
      const d = this.offset(tuneId, sid);
      if (d === null) continue;
      const k = ((d + r) % 12 + 12) % 12;
      if (k !== ownKey && score > (best.get(k) ?? 0)) best.set(k, score);
    }
    if (best.size) c.otherPitches = [...best].map(([k, s]) => [round(wrapSemitones(k + tuning), 3), round(s, 4)]);
  }
}

const round = (x: number, digits: number) => { const f = 10 ** digits; return Math.round(x * f) / f; };
