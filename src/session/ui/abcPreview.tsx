import { useEffect, useState } from 'preact/hooks';
import { getSettingAbcMeta, getSettingAbcMetaSync, type SettingAbcMeta } from '../recognition/indexStore';
import { theSessionKeyToAbc, findSettingInScore } from '../../services/theSessionService';
import { showPreviewModal } from '../../components/fileViewer';
import { getContext } from '../../store';
import type { AppContext } from '../../types';
import { MusicNoteIcon } from '../../components/icons';
import { t } from '../../services/i18nService';

// ── ABC preview of a matched FolkFriend setting ───────────────────────────────
// Builds a complete ABC tune (headers + body from the cached recognition index)
// and opens the existing file viewer, which renders the sheet AND plays it via
// the abcjs synth — ideal to compare a candidate against the session audio.
// showPreviewModal (components/fileViewer.ts) is shared, imperative, and out
// of scope for this migration — called as-is, same as modal.ts's helpers.

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function showAbcPreview(displayName: string, settingId: string, meta: SettingAbcMeta): void {
  const abcText = [
    'X: 1',
    `T: ${displayName}`,
    // Same URL shape as theSessionService.ts's settingToAbcBlock — verified
    // FolkFriend's settingId/tune_id are TheSession's own ids, not remapped.
    `S: https://thesession.org/tunes/${meta.tune_id}#setting${settingId}`,
    `R: ${meta.dance}`,
    `M: ${meta.meter}`,
    'L: 1/8',
    `K: ${theSessionKeyToAbc(meta.mode)}`,
    meta.abc.replace(/!/g, '\n'),
  ].join('\n');

  showPreviewModal({
    name: `${displayName}.abc`,
    mimeType: 'text/vnd.abc',
    data: toBase64(abcText),
  });
}


/** The card's OWN score, opened on the version that was just played.
 *
 *  Preferred over the index-built stand-in whenever it exists, because it is
 *  the score the user will actually practise from — and because the viewer's
 *  ordinary ★ then works with no special case at all: the file is the card's,
 *  so "make this the default version" acts on exactly what is on screen. The
 *  version nav comes along too, so a detection lands you on what was played
 *  with the other settings one arrow away.
 *
 *  Null whenever there is nothing better to show than the stand-in: the tune
 *  is not in the library, or its card holds no ABC carrying this setting.
 *  Asking the FILE, never the `generatedBy: 'thesession'` marker, which is
 *  younger than the data — real libraries hold TheSession scores predating it,
 *  and their owners should not be sent to a lesser preview over a label. */
function cardScorePreview(settingId: string, cardId: string | undefined, ctx: AppContext | undefined) {
  if (!cardId || !ctx) return null;
  const card = getContext().user.cards[cardId];
  const id = parseInt(settingId, 10);
  const target = card && Number.isFinite(id) ? findSettingInScore(card, id) : null;
  if (!card || !target) return null;
  const entry = card.content.attachments[target.attachmentIndex];
  if (!entry || entry.type !== 'file') return null;
  return () => showPreviewModal(entry, undefined, {
    initialIndex: target.blockIndex,
    // The star stays where the card put it, NOT on the version we opened at.
    favoriteIndex: target.preferredIndex,
    onSetPreferredIndex: (index) => {
      void ctx.mutate(s => {
        const att = s.cards[cardId]?.content.attachments[target.attachmentIndex];
        if (att && att.type === 'file') {
          if (index === undefined) delete att.preferredIndex; else att.preferredIndex = index;
        }
      });
    },
  });
}

/**
 * Small music-note button opening the sheet+synth preview of a setting.
 * Starts inert; becomes clickable once the ABC is confirmed available, stays
 * greyed out (non-clickable) when the setting has no sheet. Same geometry as
 * the slice play button: w-6 h-6 circle, icon flex-centered.
 */
export function AbcPreview({ settingId, displayName, size = 12, cardId, ctx }: {
  settingId: string;
  displayName: string;
  size?: number;
  /** The library card this setting belongs to, when it is already there. Given
   *  both this and `ctx`, the preview carries the ★ that makes this version the
   *  one the card opens on — the same gesture the file viewer already uses for a
   *  multi-version score, in the one place where the version is on screen. */
  cardId?: string;
  ctx?: AppContext;
}) {
  // Feeds re-render on every recognition event: draw the final state
  // synchronously once the map is loaded, so the button never flashes —
  // same reasoning the old imperative version had for checking the sync
  // getter first and only falling back to the async one.
  const [meta, setMeta] = useState<SettingAbcMeta | null | undefined>(() => getSettingAbcMetaSync(settingId));

  useEffect(() => {
    if (meta !== undefined) return; // already resolved synchronously above
    let cancelled = false;
    void getSettingAbcMeta(settingId).then(m => { if (!cancelled) setMeta(m); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [settingId]);

  const base = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 transition-colors';
  // The glyph's visual mass sits right of its geometric centre — nudge left.
  const icon = <span style={{ transform: 'translateX(-1px)' }}><MusicNoteIcon size={size} /></span>;

  // Same condition as the original's `!meta?.abc`: covers still-loading
  // (meta===undefined), resolved-but-not-found (null), AND a resolved entry
  // with an empty abc string — all three render disabled.
  if (!meta?.abc) {
    return (
      <button disabled class={`${base} bg-elevated text-border cursor-default`} title={meta === undefined ? t('sessions.listenAbc') : t('sessions.abcUnavailable')}>
        {icon}
      </button>
    );
  }

  return (
    <button
      class={`${base} bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer`}
      title={t('sessions.listenAbc')}
      onClick={(e) => {
        e.stopPropagation();
        const fromCard = cardScorePreview(settingId, cardId, ctx);
        if (fromCard) fromCard(); else showAbcPreview(displayName, settingId, meta);
      }}
    >
      {icon}
    </button>
  );
}
