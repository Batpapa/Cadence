import type { SessionRating } from '../types';
import { t } from '../services/i18nService';
import { RatingIcon } from './icons';

/** A rating's word. Each key written out rather than built (`rating.${r}`):
 *  i18nKeys.test.ts can then check all four in both locales. */
export function ratingWord(rating: SessionRating): string {
  switch (rating) {
    case 'again': return t('rating.again');
    case 'hard':  return t('rating.hard');
    case 'good':  return t('rating.good');
    case 'easy':  return t('rating.easy');
  }
}

/** A rating as a button says it: its drawing, then its word (2026-11-18). The
 *  word no longer carries a ✗ △ ○ ✓ of its own — the drawing is RatingIcon,
 *  the same four SVGs everywhere a rating is drawn. An inline-flex box, so the
 *  pair centres in its button by text-align like a word did, and the drawing
 *  sits on the word's middle rather than on its baseline. `bare`: the drawing
 *  alone, the Focus view's buttons once their words no longer fit. */
export function RatingLabel({ rating, bare = false, size = 16 }: { rating: SessionRating; bare?: boolean; size?: number }) {
  return (
    <span class="inline-flex items-center justify-center gap-1.5 align-middle">
      <RatingIcon rating={rating} size={size} />
      {!bare && <span>{ratingWord(rating)}</span>}
    </span>
  );
}
