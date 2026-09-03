import type { Card, CardRef, FileEntry } from '../types';
import { resolveCardRef } from './cardRefService';

// ── Primitives ────────────────────────────────────────────────────────────────
// Shared with fileViewer.ts, which used to own private copies. Splitting and
// reading ABC is domain logic, not presentation: the tuneset generator below
// needs exactly the same primitives the viewer does, and two copies of "where
// does a tune end" would eventually disagree.

/** Default tempos by tune type, used when a setting carries no `Q:` of its own
 *  — which is the normal case for TheSession's ABC. */
export const TUNE_TEMPOS: Record<string, string> = {
  jig:          '3/8=120',
  reel:         '1/4=190',
  'slip jig':   '3/8=120',
  hornpipe:     '1/4=190',
  polka:        '1/4=150',
  slide:        '3/8=135',
  waltz:        '1/4=180',
  barndance:    '1/4=190',
  strathspey:   '1/4=190',
  'three-two':  '1/4=105',
  mazurka:      '1/4=180',
  march:        '1/4=190',
};

export function isAbcFile(entry: { name: string; mimeType: string }): boolean {
  return entry.name.endsWith('.abc') || entry.mimeType === 'text/vnd.abc';
}

export function decodeAbc(entry: FileEntry): string {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new TextDecoder().decode(arr);
}

export function encodeAbc(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** One entry per `X:` header — a multi-tune file's blocks, in file order. */
export function splitAbcTunes(abc: string): string[] {
  const lines = abc.split('\n');
  const tunes: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^X:\s*\d+/.test(line) && current.length > 0) {
      tunes.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) tunes.push(current.join('\n'));
  return tunes.filter(t => t.trim());
}

/** The header fields a fused block needs to carry over, plus the music itself.
 *  Deliberately lenient: our own generated blocks have a known shape, but a
 *  user's hand-made .abc attachment does not, and a missing field is simply
 *  one less thing to restate inline. */
interface AbcBlock {
  title: string;
  rhythm: string;
  meter: string;
  unitLength: string;
  key: string;
  tempo: string;
  music: string;
}

export function parseAbcBlock(block: string): AbcBlock {
  const field = (letter: string) => {
    const m = new RegExp(`^${letter}:\\s*(.*)$`, 'm').exec(block);
    return m ? m[1]!.trim() : '';
  };
  // `K:` closes the header: everything after that line is music, whatever it
  // looks like. That is the one structural rule of the ABC tune body.
  const lines = block.split('\n');
  const keyIndex = lines.findIndex(l => /^K:/.test(l));
  return {
    title: field('T'),
    rhythm: field('R'),
    meter: field('M'),
    unitLength: field('L'),
    key: field('K'),
    tempo: field('Q'),
    music: keyIndex === -1 ? '' : lines.slice(keyIndex + 1).join('\n').trim(),
  };
}

function tempoOf(block: AbcBlock): string {
  if (block.tempo) return block.tempo;
  return TUNE_TEMPOS[block.rhythm.trim().toLowerCase()] ?? '';
}

// ── Tuneset fusion ────────────────────────────────────────────────────────────

/** The ABC block a member tune contributes: its first ABC attachment, opened at
 *  the version the card itself is set to. Exactly the rule the viewer applies
 *  when you open that card's score, so the set can never show a different
 *  version from the tune. */
function blockForTune(tune: Card): AbcBlock | null {
  const attachment = tune.content?.attachments?.find(a => a.type === 'file' && isAbcFile(a));
  if (!attachment || attachment.type !== 'file') return null;
  let blocks: string[];
  try { blocks = splitAbcTunes(decodeAbc(attachment)); } catch { return null; }
  if (blocks.length === 0) return null;
  const index = Math.max(0, Math.min(blocks.length - 1, attachment.preferredIndex ?? 0));
  return parseAbcBlock(blocks[index]!);
}

/** How many times a tune goes round in a set, by convention in Irish music.
 *  Sits here beside TUNE_TEMPOS rather than in the TheSession importer: it is
 *  how the music is played, not something that source says. */
export const SET_TUNE_REPEAT = 3;

/** How many passes a set plays a tune. Absent means once; the ceiling is there
 *  because the notation is written out in full for each pass, so an absurd
 *  number would produce an unusable score rather than an error. */
export const MAX_REPEAT = 8;

export function clampRepeat(repeat: number | undefined): number {
  if (typeof repeat !== 'number' || !Number.isFinite(repeat)) return 1;
  return Math.max(1, Math.min(MAX_REPEAT, Math.trunc(repeat)));
}

/** Escapes the two characters that would end an inline field or an annotation
 *  early. Tune names really do contain brackets ("The Kesh (jig)" is fine, but
 *  a stray `]` would truncate the part label). */
function safeLabel(text: string): string {
  return text.replace(/[[\]"]/g, '');
}

/** The whole set as ONE ABC tune: a single `X:` block whose tunes follow each
 *  other, separated by inline fields rather than by new headers.
 *
 *  Why one block rather than one per tune: abcjs applies an inline `[Q:]` to
 *  playback, not merely to the display (abc_midi_sequencer's tempoChanges are
 *  propagated to every voice, and the flattener rescales note durations from
 *  them), so a fused set plays each tune at its own tempo, continuously, under
 *  a single cursor. `[K:]` and `[M:]` are honoured the same way.
 *
 *  The one thing that cannot be carried inline is `T:` — abcjs has no `[T:]` —
 *  so each tune is labelled with a part marker `[P:]` instead, which is the
 *  standard way to name a section and is what makes the result readable.
 *
 *  Returns null when the set has nothing at all to show. */
export function buildTunesetAbc(set: Card, cards: Record<string, Card>): string | null {
  const refs: CardRef[] = set.tunes ?? [];
  if (refs.length === 0) return null;

  // Resolve everything first: the header states the FIRST playable tune's
  // signature, so the emitting pass has to know it before it starts — otherwise
  // that tune restates inline what the header just said.
  const members = refs.map(ref => {
    const tune = resolveCardRef(ref, cards);
    const block = tune ? blockForTune(tune) : null;
    return {
      label: safeLabel(tune?.name || ref.title || '?'),
      block: block && block.music ? block : null,
      repeat: clampRepeat(ref.repeat),
    };
  });

  const first = members.find(m => m.block)?.block;
  if (!first) return null;

  // What the staff is already carrying, seeded from the header below so only
  // genuine changes are restated — a redundant signature on every tune would
  // clutter the score for nothing.
  let curMeter = first.meter, curKey = first.key, curTempo = tempoOf(first);

  const parts: string[] = [];
  for (const { label, block, repeat } of members) {
    if (!block) {
      // A tune with no score keeps its PLACE: a labelled bar of silence, said
      // in words above the staff. Dropping it would silently shorten the set,
      // and a reader would have no way to know a tune was missing.
      parts.push(`[P:${label}] "^${safeLabel(NO_SCORE_LABEL)}" Z4 |`);
      continue;
    }
    // The music is WRITTEN OUT once per pass. abcjs offers no way to say "play
    // this N times": `:|` means exactly twice, and a `P:` play order is parsed
    // into metaText and only ever printed — no code under synth/ reads it. So a
    // set that repeats has to be spelled out to be heard, and the score grows
    // accordingly. That trade was made deliberately.
    for (let pass = 1; pass <= repeat; pass++) {
      // Only the first pass restates a changed signature; the rest inherit it.
      const inline: string[] = [`[P:${label}${repeat > 1 ? ` ${pass}/${repeat}` : ''}]`];
      if (pass === 1) {
        if (block.meter && block.meter !== curMeter) { inline.push(`[M:${block.meter}]`); curMeter = block.meter; }
        if (block.key && block.key !== curKey) { inline.push(`[K:${block.key}]`); curKey = block.key; }
        const tempo = tempoOf(block);
        if (tempo && tempo !== curTempo) { inline.push(`[Q:${tempo}]`); curTempo = tempo; }
      }
      parts.push(`${inline.join(' ')}\n${block.music}`);
    }
  }

  const header = [
    'X: 1',
    `T: ${set.name}`,
    first.meter ? `M: ${first.meter}` : null,
    `L: ${first.unitLength || '1/8'}`,
    tempoOf(first) ? `Q: ${tempoOf(first)}` : null,
    `K: ${first.key || 'C'}`,
  ].filter(Boolean).join('\n');

  return `${header}\n${parts.join('\n')}\n`;
}

/** Shown above the staff where a tune has no score. Not translated: it lives
 *  inside a downloadable, shareable ABC file, which has one form for everyone —
 *  the same reason the rest of the notation is not localised either. */
const NO_SCORE_LABEL = 'no score';

/** Placeholder name STORED on a set's generated attachment. Never displayed —
 *  the row derives its label from the set's current name — and never used to
 *  identify the attachment either; `generatedBy` does that, since a user could
 *  give this same name to a file of their own. */
export const TUNESET_ABC_NAME = 'ABC';

/** What the row shows and a download is called: the set's name, as a filename.
 *  A set's name contains slashes by construction ("Cooley's / The Wise Maid"),
 *  which no filesystem accepts, so the separators become dashes. */
export function tunesetAbcFileName(setName: string): string {
  const safe = setName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe || 'set'}.abc`;
}

export function tunesetAbcEntry(set: Card, cards: Record<string, Card>): FileEntry | null {
  const abc = buildTunesetAbc(set, cards);
  return abc === null ? null : {
    name: TUNESET_ABC_NAME,
    mimeType: 'text/vnd.abc',
    data: encodeAbc(abc),
  };
}
