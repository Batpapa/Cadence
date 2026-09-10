import type { AbcOpenMode, Attachment, Card, CardRef, FileEntry } from '../types';
import { resolveCardRef } from './cardRefService';
import { isTuneset, hasTunesetScore } from './cardTypeService';

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

/** How many passes a set plays a tune. Absent means once; the ceiling is there
 *  because the notation is written out in full for each pass, so an absurd
 *  number would produce an unusable score rather than an error. */
export const MAX_REPEAT = 8;

export function clampRepeat(repeat: number | undefined): number {
  if (typeof repeat !== 'number' || !Number.isFinite(repeat)) return 1;
  return Math.max(1, Math.min(MAX_REPEAT, Math.trunc(repeat)));
}

/** How many times a tune goes round in a set when the user has said nothing —
 *  three, by convention in Irish music. Sits here beside TUNE_TEMPOS rather
 *  than in the TheSession importer: it is how the music is played, not
 *  something that source says (TheSession records no repeats at all). */
export const DEFAULT_TUNE_REPEAT = 3;

/** The repeat count to stamp on a tune JOINING a set, for this user.
 *
 *  Every insertion path goes through this — adding a tune by hand, importing a
 *  set, and a refresh picking up a tune the set has gained — so the three
 *  cannot drift apart. It is a stamping value, never a display fallback: an
 *  entry already in a set keeps the number it was given, whatever this becomes
 *  later. */
export function defaultTuneRepeat(user: { defaultTuneRepeat?: number }): number {
  return clampRepeat(user.defaultTuneRepeat ?? DEFAULT_TUNE_REPEAT);
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
/** How a set's fused score is written out, beyond the set itself.
 *
 *  `includeRepeats` defaults to FALSE, which is not the same as saying the
 *  repeats do not exist: they stay on each tune, they still show as ×N in the
 *  card view, they are simply not spelled out in the notation. A set of three
 *  tunes played three times each is nine written-out tunes to read through,
 *  and most people want the shape of the set, not the performance of it. */
export interface TunesetAbcOptions {
  includeRepeats?: boolean;
}

export function buildTunesetAbc(set: Card, cards: Record<string, Card>, opts?: TunesetAbcOptions): string | null {
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
  for (const { label, block, repeat: stored } of members) {
    // One pass unless asked otherwise. Everything below reads `repeat`, so the
    // choice is made once here rather than at each of its three uses.
    const repeat = opts?.includeRepeats ? stored : 1;
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

// ── Incipits ─────────────────────────────────────────────────────────────────
// The first couple of bars of a tune, and nothing else: what a player needs in
// a session to remember how the next one starts, without opening anything.
// Asked for from the field (2026-09-10) — "je veux juste un rappel de comment
// les morceaux commencent" — and a standard object, not a niche one: an incipit
// is how tunes have been catalogued and recognised for as long as they have
// been written down.
//
// Two bars because that is both the convention and, here, the right length:
// the request was "the first twelve notes", which at L:1/8 is 1.5 bars of a
// reel and exactly 2 of a jig.

export const INCIPIT_BARS = 2;

/** Every bar line ABC can write, including the repeat forms.
 *
 *  LONGEST FIRST, because JavaScript alternation takes the first branch that
 *  matches, not the longest: with `\|\|` before `\|\|:`, a `||:` was eaten as
 *  `||` and left a bare `:` glued to the next note. Caught by running this
 *  over TheSession's 55 288 settings, not by reading it. */
const BAR_LINE = /(\|\|:|:\|\||\|\]|\[\||::|\|:|:\||\|\||\|)/;

/** Duration of a stretch of music, counted in units of `L:`.
 *
 *  Deliberately lenient: anything it cannot read contributes nothing, which
 *  can only make a stretch look SHORTER than it is. That bias is the safe one
 *  — the single thing this feeds is "is the opening stretch a pickup?", and
 *  the fallback for a wrong answer is showing one extra half-bar, never a
 *  broken score.
 *
 *  Measured against TheSession's whole corpus (55 285 settings): reads 91.5%
 *  of them cleanly, which is what makes the pickup rule below worth having. */
export function abcDurationUnits(music: string): number {
  const stripped = music
    .replace(/"[^"]*"/g, '')        // chord symbols and annotations
    .replace(/![^!]*!/g, '')        // decorations
    .replace(/\{[^}]*\}/g, '')      // grace notes: ornament, no duration
    .replace(/\[[A-Za-z]:[^\]]*\]/g, '')  // inline fields
    .replace(/[()\-~.]/g, '');      // slurs, ties, staccato
  let total = 0;
  const token = /(\[[^\]]+\]|[A-Ga-gxzZ][,']*)(\d*)(\/+)?(\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(stripped)) !== null) {
    const num = m[2] ? parseInt(m[2], 10) : 1;
    let den = 1;
    if (m[3]) den = m[4] ? parseInt(m[4], 10) : Math.pow(2, m[3].length);
    total += num / den;
  }
  return total;
}

/** How many `L:` units fill one bar of `meter`, or null when unreadable. */
function barUnits(meter: string, unitLength: string): number | null {
  const [mn, md] = meter.split('/').map(n => parseInt(n, 10));
  const [un, ud] = (unitLength || '1/8').split('/').map(n => parseInt(n, 10));
  if (!mn || !md || !un || !ud) return null;
  return (mn / md) / (un / ud);
}

/** The opening of a piece of music: its pickup, if it has one, plus `bars`
 *  full bars.
 *
 *  The pickup is KEPT, not counted. 37.4% of TheSession's settings start with
 *  one (59.9% of the 3/4s) — measured, not guessed — and it is the half-bar a
 *  player actually needs to come in on. Cutting "at the second bar line"
 *  would have been wrong on more than a third of the corpus, and wrong in the
 *  way that matters most.
 *
 *  Repeat marks are dropped: an incipit ends mid-tune, so a `|:` kept here
 *  would open a repeat nothing ever closes. */
export function musicIncipit(music: string, meter: string, unitLength: string, bars = INCIPIT_BARS): string {
  const full = barUnits(meter, unitLength);
  const pieces = music.split(BAR_LINE).map(s => s.trim()).filter(s => s.length > 0);
  // Odd indices are the separators the split kept; even ones are music.
  const segments: string[] = [];
  for (const piece of pieces) {
    if (BAR_LINE.test(piece) && /^[|:\][]+$/.test(piece)) continue;
    if (piece) segments.push(piece);
  }
  if (segments.length === 0) return music.trim();

  const out: string[] = [];
  let taken = 0;
  for (const segment of segments) {
    // A short OPENING stretch is a pickup: it comes along for free, and the
    // count of real bars starts after it. Anywhere else, a short stretch is
    // just a bar this parser could not read, and it counts.
    const isPickup = out.length === 0 && full !== null && abcDurationUnits(segment) < full * 0.9;
    out.push(segment);
    if (!isPickup) taken++;
    if (taken >= bars) break;
  }
  return `${out.join(' | ')} |`;
}

/** The only header fields an incipit keeps: the ones that change how the
 *  notes are READ. Everything else a score carries — its title, its rhythm,
 *  its source URL, who transcribed it, the notes and the discography — is
 *  printed by abcjs around the staff, and around two bars that is several
 *  lines of prose wrapped about three centimetres of music. The card already
 *  says which tune this is. */
const INCIPIT_HEADER_FIELDS = /^[XMLKQ]:/;

/** The same, for a complete ABC tune: header trimmed to the essentials, body
 *  cut to its opening.
 *
 *  The tempo is RESTATED rather than passed through. Most of TheSession's
 *  scores carry no `Q:` at all — their speed is implied by `R: reel`, and
 *  `tempoOf` is what turns that into a number. Since the trimming above drops
 *  `R:`, an incipit that merely kept whatever `Q:` it found would be played
 *  at abcjs's default, which is not that reel. */
export function abcIncipit(abc: string, bars = INCIPIT_BARS): string {
  const block = parseAbcBlock(abc);
  if (!block.music) return abc;
  const lines = abc.split('\n');
  const keyIndex = lines.findIndex(l => /^K:/.test(l));
  if (keyIndex === -1) return abc;
  const tempo = tempoOf(block);
  const header = lines
    .slice(0, keyIndex + 1)
    .filter(l => INCIPIT_HEADER_FIELDS.test(l) && !/^Q:/.test(l));
  // Before K:, which closes the header — a field after it is music.
  if (tempo) header.splice(Math.max(0, header.length - 1), 0, `Q: ${tempo}`);
  return `${header.join('\n')}\n${musicIncipit(block.music, block.meter, block.unitLength, bars)}\n`;
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

export function tunesetAbcEntry(set: Card, cards: Record<string, Card>, opts?: TunesetAbcOptions): FileEntry | null {
  const abc = buildTunesetAbc(set, cards, opts);
  return abc === null ? null : {
    name: TUNESET_ABC_NAME,
    mimeType: 'text/vnd.abc',
    data: encodeAbc(abc),
  };
}

// ── The stored placeholder ───────────────────────────────────────────────────
// One builder and one test, used by every path that gives a set its score: the
// TheSession importer, the "+" menu on a card's attachments, and the automatic
// addition on a manual type change. The shape is load-bearing (`generatedBy`
// is what makes the row non-editable, unique and rebuilt at display time), so
// it is written once rather than in four places that could drift.

/** The attachment a set carries to say "show my fused score". Empty by
 *  design — the notation is rebuilt by `tunesetAbcEntry` whenever it is
 *  shown, so it can never lag behind a tune being renamed or reordered. */
export function tunesetAbcPlaceholder(): Attachment {
  return {
    type: 'file', name: TUNESET_ABC_NAME, mimeType: 'text/vnd.abc',
    data: '', generatedBy: 'tuneset',
  };
}

/** Whether a card turning into a set gets its score along with it, when the
 *  user has said nothing.
 *
 *  Absence means YES, so — the `syncAudioByDefault` lesson — the setting must
 *  write BOTH values explicitly (a refusal stored as "absent" would read back
 *  as a yes), and every read must come through here rather than through a bare
 *  `!!user.addTunesetAbcOnConvert`, which is how a checkbox ends up showing
 *  the opposite of what the app does. */
export const ADD_TUNESET_ABC_BY_DEFAULT = true;

/** Which face a score opens on. The stave, unless the user says otherwise:
 *  notation is what a score IS to almost everyone who opens one, and the
 *  source is a tool for the few who edit it.
 *
 *  One reader for two very different screens — the full viewer's Sheet/ABC
 *  tabs and the two-bar incipit's little switch. Neither writes it back when
 *  its own switch is used: the setting says where a score OPENS, and a viewer
 *  that quietly rewrote it would turn one glance at the source into a new
 *  default nobody chose. */
export const ABC_OPEN_MODE_DEFAULT: AbcOpenMode = 'sheet';

export function abcOpenMode(user: { abcOpenMode?: AbcOpenMode }): AbcOpenMode {
  return user.abcOpenMode ?? ABC_OPEN_MODE_DEFAULT;
}

export function addTunesetAbcOnConvert(user: { addTunesetAbcOnConvert?: boolean }): boolean {
  return user.addTunesetAbcOnConvert ?? ADD_TUNESET_ABC_BY_DEFAULT;
}

/** Gives a card that has just BECOME a set its score, if the user wants it.
 *
 *  Called from the two manual conversions only — the card view's type selector
 *  and the library's bulk type change — and deliberately NOT from `commitState`
 *  or any normalisation: this describes what happens at the moment of the
 *  change, not an invariant to maintain. Enforcing it continuously would put
 *  the attachment back on every existing set, including the ones somebody
 *  removed it from on purpose.
 *
 *  Idempotent anyway, so a set that already shows its score never gains a
 *  second row. */
export function addTunesetAbcOnBecomingSet(card: Card, user: { addTunesetAbcOnConvert?: boolean }): void {
  if (!isTuneset(card)) return;
  if (!addTunesetAbcOnConvert(user)) return;
  if (hasTunesetScore(card.content.attachments)) return;
  card.content.attachments.push(tunesetAbcPlaceholder());
}
