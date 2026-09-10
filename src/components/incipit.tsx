import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppState, Card, IncipitDisplay } from '../types';
// Type-only: erased at compile time, so it costs nothing at runtime and the
// module itself stays lazily imported below.
import type { TuneObject, MidiBuffer } from 'abcjs';
import { isTuneset } from '../services/cardTypeService';
import { INCIPIT_BARS, abcIncipit, isAbcFile, decodeAbc, splitAbcTunes } from '../services/abcService';
import { resolveCardRef } from '../services/cardRefService';
import { appState } from '../store';
import { playIcon, stopIcon } from './playbackIcons';
import { t } from '../services/i18nService';

// ── The opening bars, in place ───────────────────────────────────────────────
// Asked for from the field (2026-09-10): in a session, looking at a set, a
// player wants a reminder of how each tune STARTS — "sans cliquer trop sur les
// écrans en dessous". Not a score to read: two bars, at a glance.
//
// Two bars and one ▸, and nothing else. The play button was added the day
// after, for the same reason the feature exists at all: plenty of players
// learn by ear and read notation slowly or not at all, so a reminder they
// cannot hear is only half a reminder. Everything else — the transport bar,
// the cursor, the tempo and instrument controls — stays in the viewer, which
// this deliberately does not touch.

/** Fixed, so a two-bar stave is the size of a line of music and not of the
 *  screen it happens to be on. */
const INCIPIT_STAFF_WIDTH = 420;

/** Whether the opening bars belong on this screen, for this user. */
export function showsIncipit(user: Pick<AppState, 'incipitDisplay'>, where: 'card' | 'study'): boolean {
  const setting: IncipitDisplay = user.incipitDisplay ?? 'card';
  if (setting === 'none') return false;
  if (where === 'card') return true;      // both 'card' and 'study' cover it
  return setting === 'study';
}

/** One tune's opening, from its own starred score. Null when it has none. */
function tuneIncipit(card: Card | null | undefined): string | null {
  const attachment = card?.content?.attachments?.find(a => a.type === 'file' && isAbcFile(a));
  if (!attachment || attachment.type !== 'file') return null;
  let blocks: string[];
  try { blocks = splitAbcTunes(decodeAbc(attachment)); } catch { return null; }
  const index = Math.max(0, Math.min(blocks.length - 1, attachment.preferredIndex ?? 0));
  const block = blocks[index];
  return block ? abcIncipit(block, INCIPIT_BARS) : null;
}

/** What to draw for a card: one opening per tune.
 *
 *  A set gives one entry PER MEMBER, stacked in playing order, rather than
 *  the fused single line this first shipped as. Two reasons, both the user's
 *  (2026-09-11): each opening then gets its own ▸ — a set is three tunes and
 *  you want to hear the one you have forgotten, not all three — and the tune
 *  list sitting directly above already names them in the same order, so the
 *  labels on the staves were saying it twice.
 *
 *  A member with no score is skipped rather than drawn as a bar of silence:
 *  in a fused score that silence held the tune's PLACE in a line that had to
 *  stay continuous; separate staves keep their order without it, and an empty
 *  stave would be a row that says nothing. */
export function incipitScores(card: Card, cards: Record<string, Card>): Array<{ key: string; abc: string }> {
  if (!isTuneset(card)) {
    const abc = tuneIncipit(card);
    return abc ? [{ key: card.id, abc }] : [];
  }
  const out: Array<{ key: string; abc: string }> = [];
  for (const [i, ref] of (card.tunes ?? []).entries()) {
    const abc = tuneIncipit(resolveCardRef(ref, cards));
    if (abc) out.push({ key: `${ref.id}-${i}`, abc });
  }
  return out;
}

/** The whole thing, decided and drawn: the one call a screen makes.
 *
 *  Renders nothing at all — no heading, no frame — when the setting says no,
 *  when the card has no score, or while abcjs is still on its way. A screen
 *  therefore never has to guard the call, and never shows an empty slot. */
export function IncipitRow({ card, where, class: className = '' }: {
  card: Card;
  where: 'card' | 'study';
  class?: string;
}) {
  const user = appState.value;
  if (!showsIncipit(user, where)) return null;
  const scores = incipitScores(card, user.cards);
  if (scores.length === 0) return null;
  return (
    <div class={`space-y-1 ${className}`}>
      <span class="section-title">{t('card.section.incipit')}</span>
      {scores.map(s => <Incipit key={s.key} abc={s.abc} />)}
    </div>
  );
}

/** Trims the empty band abcjs leaves above the staff.
 *
 *  It lays a score out with room for the things a score usually has — the
 *  title, the tempo mark — and those are hidden here, not absent: the tempo
 *  is still in the ABC so the ▸ plays at the right speed, and it is taken out
 *  with CSS. abcjs had already reserved its height by then, so the staff sits
 *  low in a box that is 12 px too tall, and beside a centred ▸ that reads as
 *  misaligned. Measured, not guessed: content at y=12 in a 108 px box.
 *
 *  Cropping the viewBox to the ink fixes it whatever the cause — a title, a
 *  tempo, a future field — instead of subtracting a magic number. */
function cropToInk(host: HTMLElement): void {
  const svg = host.querySelector('svg');
  if (!svg) return;
  let top = Infinity, bottom = -Infinity;
  for (const el of Array.from(svg.querySelectorAll('path, text, rect'))) {
    let box: DOMRect;
    try { box = (el as SVGGraphicsElement).getBBox(); } catch { continue; }
    if (!box.width && !box.height) continue;
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
  const width = parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width;
  const height = bottom - top;
  svg.setAttribute('viewBox', `0 ${top} ${width} ${height}`);
  svg.setAttribute('height', String(height));
}

/** Draws one ABC string as a small stave, with a ▸ beside it.
 *
 *  abcjs is imported lazily — 512 KB that only ever loaded when someone opened
 *  a score, and this must not turn that into a cost every card page pays up
 *  front. It arrives, the stave appears; until then the row simply is not
 *  there. Nothing waits on it and nothing reports its failure: this improves a
 *  page, it is not a feature anyone is blocked on. */
export function Incipit({ abc, class: className = '' }: { abc: string; class?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Everything the play button needs, filled in by the render below. A ref,
  // not state: nothing on screen depends on it until the button is pressed.
  const audio = useRef<{ visualObj: TuneObject | null; synth: MidiBuffer | null }>({ visualObj: null, synth: null });
  const [playing, setPlaying] = useState(false);
  const [audible, setAudible] = useState(false);

  useEffect(() => {
    let alive = true;
    const host = hostRef.current;
    if (!host) return;
    void import('abcjs').then(abcjs => {
      if (!alive || !hostRef.current) return;
      try {
        const visual = abcjs.renderAbc(hostRef.current, abc, {
          // NOT `responsive: 'resize'`. That makes the SVG fill its container,
          // and a two-bar stave stretched across a 1600 px desktop is drawn at
          // four times the size of the text around it — which is exactly how
          // it first shipped. A fixed staff width keeps an incipit the size of
          // a line of music; the wrapper scrolls it on a narrow screen.
          add_classes: true,
          paddingtop: 0, paddingbottom: 0, paddingleft: 0, paddingright: 0,
          staffwidth: INCIPIT_STAFF_WIDTH,
          scale: 0.8,
          // Belt and braces on top of the header trimming in abcIncipit: even
          // if a field slips through, none of it gets a visible size here.
          // The tempo mark is the exception — abcjs ignores a zero-sized
          // `tempofont`, so it is hidden in CSS instead (`.abcjs-tempo`),
          // which keeps `Q:` in the ABC for the play button.
          format: { titlefont: 'Verdana 0', composerfont: 'Verdana 0', annotationfont: 'Verdana 9' },
        });
        cropToInk(hostRef.current);
        audio.current.visualObj = visual?.[0] ?? null;
        // Only offer the button where sound can actually come out.
        if (alive && abcjs.synth.supportsAudio()) setAudible(true);
      } catch {
        if (alive) setFailed(true);
      }
    }).catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      // Leaving the page stops the sound. Anything else would keep playing
      // over whatever comes next.
      try { audio.current.synth?.stop(); } catch { /* never started */ }
      audio.current = { visualObj: null, synth: null };
    };
  }, [abc]);

  /** Plays, pauses, resumes — the whole point being that not everyone reads
   *  music.
   *
   *  Built on the first press, never before: priming a synth allocates an
   *  audio buffer, and a card page with a stave on it should cost nothing
   *  until someone asks to hear it. The click is also the user gesture
   *  browsers require before any audio may start at all.
   *
   *  `start()` returns void — it is NOT a promise, whatever it looks like.
   *  Awaiting it (the first version did) resolves on the spot and flips the
   *  button back to ▸ while the sound is still playing. The end is announced
   *  by `onEnded`, which is why it is wired at init — and it goes INSIDE
   *  `options`, see below. */
  const toggle = async () => {
    const abcjs = await import('abcjs');
    const { visualObj } = audio.current;
    if (!visualObj) return;

    const synth = audio.current.synth;
    if (synth) {
      // STOP, not pause (the user's call, 2026-09-11): two bars are over in
      // three seconds, so there is nothing to come back to in the middle of
      // them. Pressing it again plays the opening from the top, which is what
      // "remind me how it starts" means.
      if (playing) { synth.stop(); setPlaying(false); }
      else { synth.start(); setPlaying(true); }
      return;
    }

    try {
      const created = new abcjs.synth.CreateSynth();
      const program = appState.value.abcInstrument;
      await created.init({
        visualObj,
        // `onEnded` belongs INSIDE `options`, and the typing lies about it:
        // `MidiBufferOptions` declares it at the top level too, so tsc accepts
        // it there — but `create-synth.js` only ever reads
        // `options.options.onEnded`. Passed at the top level it is silently
        // dropped, the end of the sound is never announced, and the button
        // stays on ⏹ forever.
        options: { ...(program !== undefined ? { program } : {}), onEnded: () => setPlaying(false) },
      });
      await created.prime();
      audio.current.synth = created;
      created.start();
      setPlaying(true);
    } catch {
      // No audio on this device, or the buffer would not build. Take the
      // button away rather than leave one that does nothing.
      setAudible(false);
      setPlaying(false);
    }
  };

  if (failed) return null;
  return (
    <div class={`flex items-center gap-2 ${className}`}>
      {audible && (
        <button
          type="button"
          class="tap-btn shrink-0 cursor-pointer"
          title={t(playing ? 'card.incipit.stop' : 'card.incipit.play')}
          onClick={() => { void toggle(); }}
        >
          {/* The same small accent disc the detection rows and the trending
              table already use for their per-row actions — a bare glyph
              beside a stave read as part of the notation. The touch target
              is the button around it, not the disc. */}
          <span
            class="w-6 h-6 rounded-full flex items-center justify-center bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            dangerouslySetInnerHTML={{ __html: playing ? stopIcon(11) : playIcon(11) }}
          />
        </button>
      )}
      <div ref={hostRef} class="incipit overflow-x-auto min-w-0" aria-hidden="true" />
    </div>
  );
}
