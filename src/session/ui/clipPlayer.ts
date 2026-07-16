import type { SessionClipAttachment } from '../../types';
import { loadSessionAudio, loadSessionMeta } from '../db';
import { showModal, closeModal } from '../../components/modal';
import { t } from '../../services/i18nService';

// ── Session clip player ───────────────────────────────────────────────────────
// Plays a {sessionId, start, end} interval of a recorded session. The audio is
// never copied: the player seeks into the session file and pauses at the end
// bound, so bounds stay adjustable after the fact.

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
}

export async function showClipModal(clip: SessionClipAttachment): Promise<void> {
  const body = document.createElement('div');
  body.className = 'space-y-3';

  const blob = await loadSessionAudio(clip.sessionId);
  if (!blob) {
    const msg = document.createElement('p');
    msg.className = 'text-sm text-muted';
    msg.textContent = t('sessions.clip.unavailable');
    body.appendChild(msg);
    showModal(clip.title, body, [{ label: t('common.close'), onClick: closeModal }]);
    return;
  }

  const meta = await loadSessionMeta(clip.sessionId);
  const url = URL.createObjectURL(blob);

  const info = document.createElement('p');
  info.className = 'text-xs text-dim';
  info.textContent = `${meta?.name || t('sessions.defaultName', { date: new Date(meta?.date ?? 0).toLocaleDateString() })} · ${fmtTime(clip.start)} – ${fmtTime(clip.end)}`;

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.className = 'w-full';
  audio.src = url;

  let seeked = false;
  audio.addEventListener('loadedmetadata', () => {
    audio.currentTime = clip.start;
    seeked = true;
  });
  audio.addEventListener('timeupdate', () => {
    if (seeked && audio.currentTime >= clip.end) audio.pause();
  });
  audio.addEventListener('play', () => {
    // Restarting after the clip finished → jump back to the clip start.
    if (audio.currentTime >= clip.end || audio.currentTime < clip.start - 1) {
      audio.currentTime = clip.start;
    }
  });

  body.append(info, audio);
  showModal(clip.title, body, [{
    label: t('common.close'),
    onClick: () => { audio.pause(); URL.revokeObjectURL(url); closeModal(); },
  }]);
  void audio.play().catch(() => { /* autoplay blocked — user presses play */ });
}
