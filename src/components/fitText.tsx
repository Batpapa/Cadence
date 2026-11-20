import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** A name said in full where it fits on one line, and by its short form where
 *  it does not — never wrapped (the user, 2026-11-20: "Bibliothèque de
 *  cartes" / "Cartes", "Bibliothèque de détections" / "Détections"). Past the
 *  short form too, it is cut with an ellipsis rather than wrapped.
 *
 *  Measured, not guessed: a hidden copy of the long form, in the same font,
 *  says how wide it is, against the room this box has. The box must take its
 *  width from its parent, not from its text (a block in a `min-w-0` flex item,
 *  say) — then which form shows cannot change the room, and the choice cannot
 *  feed back into itself (see feedback_measured_layout_loops in the project's
 *  notes: a measured layout must not move what it measures). */
export function FitText({ long, short, class: cls }: { long: string; short: string; class?: string }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);

  // Before paint, so the long form never flashes on a narrow screen.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const ruler = rulerRef.current;
    if (!box || !ruler) return;
    // Fractional widths, both: offsetWidth/clientWidth round to whole pixels,
    // so a long form 200.4 wide "fit" a 200 box and showed cut (seen by the
    // user, 2026-11-20, over a narrow band of widths). Both rects are in the
    // same space, so the CSS zoom on <html> cancels out; the half pixel leans
    // towards the short form where the two are a rounding apart.
    const check = () => setFits(ruler.getBoundingClientRect().width <= box.getBoundingClientRect().width - 0.5);
    check();
    const watch = new ResizeObserver(check);
    watch.observe(box);
    return () => watch.disconnect();
  }, [long]);

  return (
    <span ref={boxRef} class={`relative block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${cls ?? ''}`} title={fits ? undefined : long}>
      <span ref={rulerRef} aria-hidden="true" class="absolute left-0 top-0 invisible whitespace-nowrap pointer-events-none">{long}</span>
      {fits ? long : short}
    </span>
  );
}
