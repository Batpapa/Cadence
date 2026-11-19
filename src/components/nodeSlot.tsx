import { useLayoutEffect, useRef } from 'preact/hooks';

/** A place in a Preact view for an element built outside it — the score
 *  viewer's source tabs (fileViewer.ts), which go from the viewer's own
 *  bottom row into the audio sync's or the Play-along's view and back, the
 *  same element throughout, its handlers and state with it. Put in on mount;
 *  taken out with this box when the view goes, for its owner to put back. */
export function NodeSlot({ node }: { node: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.appendChild(node);
  }, [node]);
  return <div ref={ref} />;
}
