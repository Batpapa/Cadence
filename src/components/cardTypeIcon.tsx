import { CARD_TYPE_TUNE, CARD_TYPE_TUNESET } from '../services/cardTypeService';
import { TuneIcon, TuneSetIcon } from './icons';

/** The glyph for a card type.
 *
 *  Its own module rather than `cardTypeService`, which must stay free of any
 *  dependency on components, and rather than `icons.tsx`, which is a leaf every
 *  view imports and has no business knowing what a tuneset is. Here the two
 *  meet, and nothing but views depend on it.
 *
 *  Unknown and absent types get nothing at all, matching the label they share:
 *  "no type" is the absence of a mark, not a mark of its own. */
export function cardTypeIcon(type: string | undefined, size = 12) {
  if (type === CARD_TYPE_TUNE)    return <TuneIcon size={size} />;
  if (type === CARD_TYPE_TUNESET) return <TuneSetIcon size={size} />;
  return null;
}
