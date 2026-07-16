import { getSettingAbcMeta } from '../recognition/indexStore';
import { theSessionKeyToAbc } from '../../services/theSessionService';
import { showPreviewModal } from '../../components/fileViewer';
import { iconElement, MusicNoteIcon } from '../../components/icons';
import { t } from '../../services/i18nService';

// ── ABC preview of a matched FolkFriend setting ───────────────────────────────
// Builds a complete ABC tune (headers + body from the cached recognition index)
// and opens the existing file viewer, which renders the sheet AND plays it via
// the abcjs synth — ideal to compare a candidate against the session audio.

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function showAbcPreview(displayName: string, meta: { abc: string; meter: string; mode: string; dance: string }): void {
  const abcText = [
    'X: 1',
    `T: ${displayName}`,
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

/**
 * Small music-note button opening the sheet+synth preview of a setting.
 * Starts inert; becomes clickable once the ABC is confirmed available, stays
 * greyed out (non-clickable) when the setting has no sheet.
 */
export function makeAbcNoteButton(settingId: string, displayName: string, size = 12): HTMLButtonElement {
  // Same geometry as the slice play button: w-6 h-6 circle, icon flex-centered.
  const base = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 transition-colors';
  const btn = document.createElement('button');
  btn.className = `${base} bg-elevated text-border cursor-default`;
  btn.title = t('sessions.listenAbc');
  btn.disabled = true;
  const icon = iconElement(MusicNoteIcon, size);
  // The glyph's visual mass sits right of its geometric centre — nudge left.
  (icon as HTMLElement).style.transform = 'translateX(-1px)';
  btn.appendChild(icon);

  void getSettingAbcMeta(settingId).then(meta => {
    if (!meta?.abc) {
      btn.title = t('sessions.abcUnavailable');
      return;
    }
    btn.disabled = false;
    btn.className = `${base} bg-accent/10 text-accent hover:bg-accent/20 cursor-pointer`;
    btn.onclick = (e) => { e.stopPropagation(); showAbcPreview(displayName, meta); };
  });

  return btn;
}
