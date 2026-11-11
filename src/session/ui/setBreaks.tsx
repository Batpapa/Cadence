import type { ComponentChild } from 'preact';
import { t } from '../../services/i18nService';
import { LinkIcon, UnlinkIcon } from '../../components/icons';
import { fmtLongTime } from './sessionUiShared';
import type { ListAnn, ListChain, ListGap } from './timelineModel';

// ── Unjoining and joining sets by hand (2026-10-20) ──────────────────────────
// The controls for model.ts's opensSet, shared by the summary and the two
// feeds. The user's rules for them:
//  • where tunes ran into each other, the screen gains NO space: the button
//    sits ON the join, over the edges of the cards (OnSeam); a silence row
//    stays what it was, the button added to it;
//  • every button at the far RIGHT, out of the way of the reading;
//  • one small size for all, icon only — no time, no label: a broken chain
//    unjoins, a chain joins;
//  • no ✕: lit means the user decided, and pressing it again hands the place
//    back to the rule.

/** What a set mark is set through: `true` a cut before that detection, `false`
 *  a link, `undefined` the rule again. */
export type SetOpens = (detectionId: string, opens: boolean | undefined) => void;

/** A set's inside, as every screen shows it: its tunes, the unjoin button on
 *  each join between two of them, and the silences it was joined across. No
 *  `onSetOpens`, no buttons: an analysis outside its editor view.
 *  `ownRow`: the joins drawn as a row of their own above the tune after
 *  them, which carries the button itself (the summary's short holes,
 *  developer mode) — none astride them then. */
export function setRows(
  rows: ListChain['rows'],
  renderAnn: (row: ListAnn) => ComponentChild,
  renderGap: (gap: ListGap) => ComponentChild,
  onSetOpens: SetOpens | undefined,
  ownRow: (detectionId: string) => boolean = () => false,
): ComponentChild[] {
  return rows.map((r, k) => {
    if (r.kind === 'gap') return renderGap(r);
    const prev = rows[k - 1];
    if (!prev || prev.kind !== 'ann' || !onSetOpens || ownRow(r.ann.id)) return renderAnn(r);
    return (
      <OnSeam key={r.ann.id} inSet mark={<SetMarkButton kind="unlink" active={false} onClick={() => onSetOpens(r.ann.id, true)} />}>
        {renderAnn(r)}
      </OnSeam>
    );
  });
}

/** A tune or a set as the list shows it, with the lit unjoin button on the
 *  join above it when the user unjoined there — unless that join has a row of
 *  its own (`ownRow`, as setRows'). */
export function withCutMark(
  item: ListAnn | ListChain, node: ComponentChild, onSetOpens: SetOpens,
  ownRow: (detectionId: string) => boolean = () => false,
): ComponentChild {
  if (!item.cut) return node;
  const id = item.kind === 'ann' ? item.ann.id : item.members[0]!.ann.id;
  if (ownRow(id)) return node;
  return (
    <OnSeam key={`cut-${id}`} mark={<SetMarkButton kind="unlink" active onClick={() => onSetOpens(id, undefined)} />}>
      {node}
    </OnSeam>
  );
}

/** Puts `mark` astride the join above `children`, at the right: on the space
 *  the list already leaves between two cards, taking none of its own. `inSet`:
 *  between two tunes of a set, whose list is tighter. */
function OnSeam({ mark, inSet, children }: { mark: ComponentChild; inSet?: boolean; children: ComponentChild }) {
  return (
    <div class="relative">
      <span class={`absolute right-2 ${inSet ? '-top-[3px]' : '-top-1'} -translate-y-1/2 z-[3]`}>{mark}</span>
      {children}
    </div>
  );
}

/** The one button: a broken chain (`unlink`) where a set could be unjoined, a
 *  chain (`link`) on a silence it could be joined across. `active`: the user
 *  did — lit, and pressing it undoes it. */
export function SetMarkButton({ kind, active, onClick }: { kind: 'link' | 'unlink'; active: boolean; onClick: () => void }) {
  const title = t(kind === 'link'
    ? (active ? 'sessions.set.linked' : 'sessions.set.linkHint')
    : (active ? 'sessions.set.cutMark' : 'sessions.set.cutHere'));
  // The small pill is the drawing, astride the seam; the button around it is a
  // 32 px target (it was 18 × 26). The pill is a toggle chip, on a solid
  // ground so the cards' edges do not show through its tint.
  return (
    <button
      class="group shrink-0 inline-flex items-center justify-center min-w-8 min-h-8 cursor-pointer"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span class="inline-flex rounded-full bg-bg">
        <span class={`chip px-1.5 ${active ? 'chip-toggle-on group-hover:border-accent' : 'group-hover:text-accent group-hover:border-accent/50'}`}>
          {kind === 'link' ? <LinkIcon size={12} /> : <UnlinkIcon size={12} />}
        </span>
      </span>
    </button>
  );
}

/** A silence on a live or import feed — which shows none otherwise: only where
 *  a set could be joined across it, small, and with no ⊕ (nothing can be
 *  added to a feed). `linked`: the silence inside a set. */
export function FeedSilence({ len, linked, onSetOpens }: {
  len: number;
  linked: boolean;
  /** The mark on the detection after it. Absent outside the editor view: the
   *  silence is only read. */
  onSetOpens?: (opens: boolean | undefined) => void;
}) {
  return (
    <div class="flex items-center gap-2 py-0.5 text-2xs text-dim">
      <span class="h-px flex-1 bg-border" />
      <span class="shrink-0 tabular-nums">{fmtLongTime(len)}</span>
      <span class="h-px flex-1 bg-border" />
      {onSetOpens && (
        // Its 32 px target overhangs the thin line rather than thickening it.
        <span class="mr-2 -my-2 flex">
          <SetMarkButton kind="link" active={linked} onClick={() => onSetOpens(linked ? undefined : false)} />
        </span>
      )}
    </div>
  );
}
