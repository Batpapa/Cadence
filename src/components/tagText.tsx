import { tagSegments } from '../services/tagGroups';

/** A tag where it stands on its own (a card's page, a study card): its groups
 *  faded before its value, "key › A › minor", since the value alone would not
 *  say which group it belongs to (tagGroups.ts). A plain tag shows as it is. */
export function TagText({ tag }: { tag: string }) {
  const parts = tagSegments(tag);
  if (parts.length === 1) return <>{tag}</>;
  return (
    <>
      {parts.slice(0, -1).map((p, i) => <span key={i} class="opacity-60">{p} › </span>)}
      {parts[parts.length - 1]}
    </>
  );
}
