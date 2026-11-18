import { IconButton } from './ui';
import { PencilIcon, TrashIcon } from './icons';
import { t } from '../services/i18nService';
import { fmtDate, fmtDateTime } from '../services/dateFormat';
import { ratingWord } from './ratingLabel';
import type { SessionEntry } from '../types';

// ── A card's review history, two ways (2026-11-18) ───────────────────────────
// The squares, as they always were — small on purpose, a card can carry
// hundreds of reviews — and a list, one row per review in the attachments'
// format, its date and rating spelled out and its pencil and bin at hand. The
// card page switches between them in place: a tap on a square, or the pencil on
// the section's title line, as its tags do (the user's design). Each square
// used to open its review's edit dialog by itself: a 10 px target, 9 px under
// a phone's zoom, its date on a hover a finger never gets.

/** The ratings' colours, unchanged (the user's call): the study buttons'. */
const RATING_COLORS: Record<string, string> = { again: 'var(--color-danger)', hard: 'var(--color-warn)', good: 'var(--color-accent)', easy: 'var(--color-success)' };

function square(rating: string, size: number) {
  return { width: `${size}px`, height: `${size}px`, borderRadius: '2px', background: RATING_COLORS[rating] ?? 'var(--color-dim)', opacity: 0.75, flexShrink: 0 };
}

/** Oldest to newest, as they always were. A tap on any of them is `onOpen`. */
export function ReviewSquares({ entries, onOpen }: { entries: readonly SessionEntry[]; onOpen: () => void }) {
  return (
    <div class="flex flex-wrap gap-[3px]">
      {entries.map((entry, i) => (
        <div
          key={i}
          style={{ ...square(entry.rating, 10), cursor: 'pointer' }}
          title={`${fmtDate(entry.ts)} — ${ratingWord(entry.rating)}`}
          onClick={onOpen}
        />
      ))}
    </div>
  );
}

/** One row per review, newest first — the review one comes to fix is usually
 *  a recent one. */
export function ReviewList({ entries, onEdit, onDelete }: {
  entries: readonly SessionEntry[];
  onEdit: (entry: SessionEntry) => void;
  onDelete: (entry: SessionEntry) => void;
}) {
  const rows = [...entries].sort((a, b) => b.ts - a.ts);
  return (
    <div class="space-y-1">
      {rows.map((e, i) => (
        // The attachments' row.
        <div key={`${e.ts}-${i}`} class="flex items-center gap-2 px-3 py-0.5 rounded border border-border">
          <div style={square(e.rating, 10)} />
          <span class="text-sm text-primary tabular-nums">{fmtDateTime(e.ts)}</span>
          <span class="text-sm text-muted flex-1 min-w-0 truncate">{ratingWord(e.rating)}</span>
          <IconButton label={t('card.logReview.editTitle')} onClick={() => onEdit(e)}>
            <PencilIcon size={14} />
          </IconButton>
          <IconButton class="hover:text-danger" label={t('study.deleteReview')} onClick={() => onDelete(e)}>
            <TrashIcon size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
